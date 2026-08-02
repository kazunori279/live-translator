"""Long-running soak test for the AI panel assistant.

A panel runs for an hour or more, and the assistant's failure modes are the ones
that only show up at that length: the wake matcher drifting as the transcript
accumulates, the gate latching open after a reconnect, the briefing getting
re-sent every nine minutes on the GoAway cycle. So this drives one persistent
WebSocket with a synthetic discussion — mostly chatter it must ignore, and every
so often a question addressed to it.

Two numbers matter and neither is an average quality score:

  false-speak rate  turns it answered that nobody addressed to it. Every one is
                    the assistant talking over a panellist in front of an
                    audience. Target: zero.
  miss rate         questions it was asked and did not answer. Costs one
                    repeated question. Annoying, not embarrassing.

The distractors are deliberately hostile: this panel discusses AI and music, so
a third of them say "Gemini" out loud as a product name.

Usage:
    uv run python tests/test_long.py [--url ws://localhost:8000] [--duration 3600]
"""

import argparse
import asyncio
import base64
import json
import math
import os
import ssl
import struct
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import certifi
import websockets
from dotenv import load_dotenv
from google import genai
from google.cloud import texttospeech

load_dotenv(Path(__file__).parent.parent / "app" / ".env")

os.environ.pop("GOOGLE_GENAI_USE_VERTEXAI", None)
os.environ.pop("GOOGLE_CLOUD_PROJECT", None)
os.environ.pop("GOOGLE_CLOUD_LOCATION", None)

CHUNK_SIZE = 512
CHUNK_INTERVAL = 0.016
SILENCE_AFTER_SPEECH = 2.0
# How long to keep reading after the turn boundary. A late first token still
# counts as speaking, and on a silence turn that late token is the whole bug.
SETTLE_AFTER_TURN = 3.0
RESPONSE_TIMEOUT = 30
GENAI_MODEL = "gemini-2.5-flash-lite"

# An answer that lands after this is too late to be part of the conversation —
# the panel has already moved on.
LATENCY_THRESHOLD = 6.0

# A gated turn should produce no model frames at all, but the upstream sometimes
# emits a lone silent frame before the gate sees the transcript. Judge by level,
# as the E2E test does: speech sits in the hundreds, digital silence near zero.
AUDIBLE_RMS = 50
SPEECH_MIN_CHUNKS = 3

# ---------------------------------------------------------------------------
# The discussion
# ---------------------------------------------------------------------------

# Ordinary panel talk. Nothing here addresses the assistant, so every one of
# these turns must be silent.
CHATTER_TOPICS = [
    "the Munich court ruling against Suno and what it means for European licensing",
    "how streaming platforms are handling the flood of AI-generated tracks",
    "whether session musicians are actually losing work to generative models",
    "the difference between training on a catalogue and cloning a specific voice",
    "what the major labels settled for and why they settled at all",
    "how Japanese rights societies are approaching AI-generated music",
    "the economics of a track that costs nothing to produce",
    "why some producers use generative tools openly and others hide it",
    "what 'authorship' means when a prompt produced the melody",
    "live performance as the thing generative models cannot do",
]

# The same panel, saying the assistant's name as a product name. These are the
# turns most likely to trip a wake matcher, so they get their own bucket in the
# report.
NAME_DROP_TOPICS = [
    "how Gemini and other multimodal models handle audio natively",
    "comparing Gemini, Suno and Udio as production tools",
    "what the Gemini API costs at the scale a label would need",
    "why Gemini is a general model and Lyria is the music one",
    "using Gemini to write lyrics versus using it to write code",
]

# Questions actually put to the assistant. The wake phrase is prefixed at
# synthesis time so it goes through TTS and transcription like any other speech.
QUESTION_TOPICS = [
    "the strongest argument on each side of the AI music copyright fight",
    "one number worth quoting about AI music on streaming services",
    "what changed in music licensing in the last year",
    "the most contested question in AI and music right now",
    "what independent artists should actually do about generative tools",
    "how Japan's approach to AI training data differs from the EU's",
    "an argument the panel has not made yet",
    "what the technical limits of current music models are",
]

WAKE_PREFIXES_EN = [
    "Hey Gemini, ",
    "Gemini, ",
    "OK Gemini, ",
    "So Gemini, ",
]

# Cloud TTS voices, alternating so consecutive turns sound like different
# panellists — closer to the real transcript the wake matcher will see.
PANEL_VOICES = [
    ("en-US", "en-US-Neural2-J"),
    ("en-US", "en-US-Neural2-F"),
    ("en-US", "en-US-Neural2-D"),
]

CHATTER = "chatter"
NAME_DROP = "name-drop"
QUESTION = "question"

# Music-domain pronunciation guide, in the shape the browser sends.
TEST_GLOSSARY: list[dict[str, str]] = [
    {"source": "Suno", "target": "スーノ", "transcription": "Suno"},
    {"source": "Udio", "target": "ユーディオ", "transcription": "Udio"},
    {"source": "Lyria", "target": "リリア", "transcription": "Lyria"},
    {"source": "Deezer", "target": "ディーザー", "transcription": "Deezer"},
    {"source": "Spotify", "target": "スポティファイ", "transcription": "Spotify"},
    {"source": "JASRAC", "target": "ジャスラック", "transcription": "JASRAC"},
    {"source": "Gemini", "target": "ジェミニ", "transcription": "Gemini"},
    {"source": "stem separation", "target": "ステムセパレーション", "transcription": "stem separation"},
    {"source": "text to music", "target": "テキストトゥミュージック", "transcription": "text-to-music"},
    {"source": "voice cloning", "target": "ボイスクローニング", "transcription": "voice cloning"},
]


# ---------------------------------------------------------------------------


@dataclass
class IterationResult:
    index: int
    kind: str  # CHATTER | NAME_DROP | QUESTION
    spoken: str
    heard: str | None = None
    answer: str | None = None
    spoke: bool = False
    audible_chunks: int = 0
    audio_chunks: int = 0
    peak_rms: float = 0.0
    gate_armed: bool = False  # server reported the gate opening on this turn
    suppressed: int = 0  # replies the gate held back on this turn
    sources: int = 0  # grounding chunks attached to the answer
    # Set only for QUESTION turns that produced an answer.
    score: float | None = None
    reason: str = ""
    correct: bool = False  # did the turn do what it was supposed to
    error: str | None = None
    elapsed: float = 0.0
    first_response_sec: float | None = None
    turn_complete_sec: float | None = None


@dataclass
class Stats:
    iterations: int = 0
    errors: int = 0
    # Turns that must be silent.
    silent_expected: int = 0
    false_speaks: list[IterationResult] = field(default_factory=list)
    # Turns that must be answered.
    questions: int = 0
    answered: int = 0
    misses: list[IterationResult] = field(default_factory=list)
    answer_scores: list[float] = field(default_factory=list)
    grounded_answers: int = 0
    results: list[IterationResult] = field(default_factory=list)


def stamp() -> str:
    return time.strftime("%H:%M:%S")


def _rms(pcm: bytes) -> float:
    """Root-mean-square level of signed 16-bit little-endian PCM."""
    count = len(pcm) // 2
    if not count:
        return 0.0
    samples = struct.unpack(f"<{count}h", pcm[: count * 2])
    return math.sqrt(sum(s * s for s in samples) / count)


def generate_line(client: genai.Client, kind: str, topic: str, index: int) -> str:
    """One line of panel speech, synthesised fresh so the run is not a fixed script."""
    if kind == QUESTION:
        prompt = (
            f"Write exactly one short spoken question (12-25 words) asking an AI "
            f"assistant about {topic}, in the context of a live panel discussion "
            f"on AI and music. Do not name the assistant — a wake phrase is added "
            f"separately. Output only the question."
        )
        text = client.models.generate_content(
            model=GENAI_MODEL, contents=prompt
        ).text.strip().strip('"')
        prefix = WAKE_PREFIXES_EN[index % len(WAKE_PREFIXES_EN)]
        # Lower-case the first letter so "Hey Gemini, what..." reads as one
        # sentence rather than two, which is how it will actually be said.
        return prefix + (text[0].lower() + text[1:] if text else text)

    prompt = (
        f"Write exactly one sentence (15-30 words) that a human panellist would "
        f"say out loud during a discussion about {topic}. It must be a statement "
        f"or an aside to the other panellists — never a question directed at an "
        f"AI assistant. Output only the sentence."
    )
    return client.models.generate_content(
        model=GENAI_MODEL, contents=prompt
    ).text.strip().strip('"')


def text_to_pcm(
    tts_client: texttospeech.TextToSpeechClient, text: str, index: int
) -> bytes:
    language_code, voice_name = PANEL_VOICES[index % len(PANEL_VOICES)]
    resp = tts_client.synthesize_speech(
        input=texttospeech.SynthesisInput(text=text),
        voice=texttospeech.VoiceSelectionParams(
            language_code=language_code, name=voice_name
        ),
        audio_config=texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.LINEAR16,
            sample_rate_hertz=16000,
        ),
    )
    # Strip the 44-byte WAV header to get raw PCM
    audio = resp.audio_content
    if audio[:4] == b"RIFF":
        audio = audio[44:]
    # Pad 1s silence before and after for VAD
    silence = b"\x00\x00" * 16000
    return silence + audio + silence


def score_answer(
    client: genai.Client, question: str, answer: str
) -> tuple[float, str]:
    """Grade an answer for whether it is worth the interruption it cost."""
    resp = client.models.generate_content(
        model=GENAI_MODEL,
        contents=(
            "An AI assistant sits on a live panel about AI and music. It stays "
            "silent unless addressed. It was asked the question below and gave "
            "the answer below. Judge the answer as a panel contribution: is it "
            "responsive, specific, and short enough to belong in a live "
            "discussion? Vagueness and padding should score low even if the "
            "answer is technically correct.\n\n"
            f"Question: {question}\n"
            f"Answer: {answer}\n\n"
            "Reply in exactly this format:\n"
            "SCORE: <0-10>\n"
            "REASON: <one sentence>"
        ),
    )
    text = (resp.text or "").strip()
    score, reason = 0.0, text
    for line in text.splitlines():
        line = line.strip()
        if line.upper().startswith("SCORE:"):
            try:
                score = float(line.split(":", 1)[1].strip().split("/")[0])
            except ValueError:
                pass
        elif line.upper().startswith("REASON:"):
            reason = line.split(":", 1)[1].strip()
    return score, reason


async def run_iteration(
    ws,
    genai_client: genai.Client,
    tts_client: texttospeech.TextToSpeechClient,
    index: int,
    kind: str,
    topic: str,
) -> IterationResult:
    t0 = time.monotonic()

    try:
        sentence = generate_line(genai_client, kind, topic, index)
    except Exception as e:
        return IterationResult(index=index, kind=kind, spoken="", error=f"generate: {e}")

    try:
        pcm_data = text_to_pcm(tts_client, sentence, index)
    except Exception as e:
        return IterationResult(
            index=index, kind=kind, spoken=sentence, error=f"tts: {e}"
        )

    heard_parts: list[str] = []
    answer_final: list[str] = []
    answer_partial: list[str] = []
    counters = {"audio": 0, "audible": 0, "suppressed": 0, "sources": 0}
    peak_rms = [0.0]
    armed = [False]
    first_response_at: list[float] = []
    speech_done_at: list[float] = []
    turn_complete_at: list[float] = []
    turn_complete = asyncio.Event()
    stale_turn_open = [False]

    async def receive_responses():
        try:
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=RESPONSE_TIMEOUT)
                msg = json.loads(raw)

                gate = msg.get("gate")
                if gate:
                    if gate.get("armed"):
                        armed[0] = True
                    continue
                if msg.get("suppressed"):
                    counters["suppressed"] += 1
                    continue

                has_content = False
                it = msg.get("inputTranscription")
                if it and it.get("text"):
                    heard_parts.append(it["text"])

                ot = msg.get("outputTranscription")
                if ot and ot.get("text"):
                    has_content = True
                    if ot.get("finished"):
                        answer_final.append(ot["text"])
                    else:
                        answer_partial.append(ot["text"])

                gm = msg.get("groundingMetadata")
                if gm:
                    counters["sources"] += len(gm.get("chunks", []))

                for part in msg.get("content", {}).get("parts", []):
                    inline = part.get("inlineData")
                    if inline and inline.get("data"):
                        has_content = True
                        counters["audio"] += 1
                        level = _rms(base64.b64decode(inline["data"]))
                        peak_rms[0] = max(peak_rms[0], level)
                        if level > AUDIBLE_RMS:
                            counters["audible"] += 1

                if has_content and not first_response_at:
                    first_response_at.append(time.monotonic())

                if msg.get("turnComplete"):
                    # A turn boundary with nothing in front of it belongs to
                    # whatever came before — including the synthetic one a
                    # session swap emits for the turn it abandoned.
                    if stale_turn_open[0]:
                        stale_turn_open[0] = False
                        continue
                    if not turn_complete_at:
                        turn_complete_at.append(time.monotonic())
                    turn_complete.set()
                    # Keep reading: a straggler token after the boundary is
                    # exactly the bug a silence turn is looking for.
        except asyncio.TimeoutError:
            pass
        except websockets.ConnectionClosed:
            pass

    # Anything still queued belongs to a turn we already gave up on. One socket
    # serves the whole run, so reading those frames here would score this line
    # against the previous one and leave every later iteration a turn behind.
    stale = 0
    while True:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=0.25)
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            break
        stale += 1
        stale_turn_open[0] = not json.loads(raw).get("turnComplete")
    if stale:
        print(f"[{stamp()}] #{index} dropped {stale} stale frame(s) from the previous turn")

    recv_task = asyncio.create_task(receive_responses())

    offset = 0
    while offset < len(pcm_data):
        try:
            await ws.send(pcm_data[offset : offset + CHUNK_SIZE])
        except websockets.ConnectionClosed:
            recv_task.cancel()
            return IterationResult(
                index=index, kind=kind, spoken=sentence, error="ws closed during send"
            )
        offset += CHUNK_SIZE
        await asyncio.sleep(CHUNK_INTERVAL)

    speech_done_at.append(time.monotonic())

    silence = b"\x00" * CHUNK_SIZE
    for _ in range(int(SILENCE_AFTER_SPEECH / CHUNK_INTERVAL)):
        try:
            await ws.send(silence)
        except websockets.ConnectionClosed:
            break
        await asyncio.sleep(CHUNK_INTERVAL)

    try:
        await asyncio.wait_for(turn_complete.wait(), timeout=RESPONSE_TIMEOUT)
    except asyncio.TimeoutError:
        pass
    # A silence turn is only proved by the quiet that follows it, so listen past
    # the boundary before deciding nothing was said.
    await asyncio.sleep(SETTLE_AFTER_TURN)

    recv_task.cancel()
    try:
        await recv_task
    except asyncio.CancelledError:
        pass

    first_resp_sec = None
    if first_response_at and speech_done_at:
        first_resp_sec = max(0.0, first_response_at[0] - speech_done_at[0])
    turn_comp_sec = None
    if turn_complete_at and speech_done_at:
        turn_comp_sec = max(0.0, turn_complete_at[0] - speech_done_at[0])

    answer = (
        answer_final[-1] if answer_final else "".join(answer_partial) or None
    )
    spoke = counters["audible"] >= SPEECH_MIN_CHUNKS or bool(answer)

    result = IterationResult(
        index=index,
        kind=kind,
        spoken=sentence,
        heard="".join(heard_parts) or None,
        answer=answer,
        spoke=spoke,
        audible_chunks=counters["audible"],
        audio_chunks=counters["audio"],
        peak_rms=round(peak_rms[0], 1),
        gate_armed=armed[0],
        suppressed=counters["suppressed"],
        sources=counters["sources"],
        elapsed=time.monotonic() - t0,
        first_response_sec=first_resp_sec,
        turn_complete_sec=turn_comp_sec,
    )

    if kind == QUESTION:
        result.correct = spoke
        if answer:
            try:
                result.score, result.reason = score_answer(
                    genai_client, sentence, answer
                )
            except Exception as e:
                result.error = f"score: {e}"
        elif spoke:
            result.reason = "spoke but no transcription to grade"
        else:
            result.reason = "did not answer"
    else:
        result.correct = not spoke
        if spoke:
            result.reason = "spoke when nobody asked it"

    return result


def _format_distribution(
    label: str,
    values: list[float],
    buckets: list[tuple[str, float, float]],
    bar_width: int = 30,
) -> list[str]:
    """Return histogram lines for a list of values.

    `buckets` is a list of (label, low_inclusive, high_exclusive).
    """
    if not values:
        return []
    vals = sorted(values)
    n = len(vals)
    avg = sum(vals) / n
    p50 = vals[n // 2]
    p90 = vals[int(n * 0.9)]
    p99 = vals[int(n * 0.99)]
    lines = [
        f"\n  {label} (n={n})",
        f"  min={vals[0]:.2f}  avg={avg:.2f}  p50={p50:.2f}  p90={p90:.2f}  p99={p99:.2f}  max={vals[-1]:.2f}",
    ]
    counts = [(bl, sum(1 for v in vals if lo <= v < hi)) for bl, lo, hi in buckets]
    max_c = max((c for _, c in counts), default=1)
    for bl, c in counts:
        bar = "#" * int(c / max_c * bar_width) if max_c > 0 else ""
        lines.append(f"  {bl:>10s}: {c:4d} ({100 * c / n:5.1f}%) {bar}")
    return lines


def _plan(index: int) -> tuple[str, str]:
    """What the panel says next.

    Three turns of discussion per question is roughly the real ratio, and it
    keeps the run weighted towards the failure that matters: speaking uninvited.
    Every third distractor drops the assistant's name as a product.
    """
    slot = index % 4
    if slot == 3:
        return QUESTION, QUESTION_TOPICS[(index // 4) % len(QUESTION_TOPICS)]
    if slot == 1:
        return NAME_DROP, NAME_DROP_TOPICS[(index // 4) % len(NAME_DROP_TOPICS)]
    return CHATTER, CHATTER_TOPICS[index % len(CHATTER_TOPICS)]


async def main():
    parser = argparse.ArgumentParser(
        description="Long-running soak test for the AI panel assistant"
    )
    parser.add_argument("--url", default="ws://localhost:8000", help="WebSocket base URL")
    parser.add_argument("--duration", type=int, default=3600, help="Test duration in seconds")
    parser.add_argument(
        "--log",
        default=None,
        help="Path to JSONL log file for per-iteration metrics (default: auto-generated)",
    )
    args = parser.parse_args()

    ws_url = f"{args.url}/ws/soak-test/soak-session-001"

    genai_client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
    tts_client = texttospeech.TextToSpeechClient()

    log_path = args.log or f"soak_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.jsonl"
    log_file = open(log_path, "a")

    stats = Stats()
    start = time.monotonic()

    print(f"[{stamp()}] Starting panel soak test: duration={args.duration}s")
    print(f"[{stamp()}] Glossary: {len(TEST_GLOSSARY)} entries")
    print(f"[{stamp()}] Logging metrics to {log_path}")
    print(f"[{stamp()}] Connecting to {ws_url}")

    ssl_ctx = None
    if ws_url.startswith("wss://"):
        ssl_ctx = ssl.create_default_context(cafile=certifi.where())

    async def connect_ws():
        ws = await websockets.connect(ws_url, ssl=ssl_ctx)
        await ws.send(json.dumps({"glossary": TEST_GLOSSARY}))
        print(f"[{stamp()}] Connected, setup sent with glossary")
        return ws

    ws = await connect_ws()

    while time.monotonic() - start < args.duration:
        stats.iterations += 1
        kind, topic = _plan(stats.iterations)

        result = await run_iteration(
            ws, genai_client, tts_client, stats.iterations, kind, topic
        )

        if result.error and "ws closed" in result.error:
            print(f"[{stamp()}] WebSocket closed, reconnecting...")
            try:
                ws = await connect_ws()
            except Exception as e:
                print(f"[{stamp()}] Reconnect failed: {e}")
                await asyncio.sleep(2)
                continue

        stats.results.append(result)

        log_file.write(json.dumps({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "iteration": result.index,
            "kind": result.kind,
            "spoken": result.spoken,
            "heard": result.heard,
            "answer": result.answer,
            "spoke": result.spoke,
            "correct": result.correct,
            "gate_armed": result.gate_armed,
            "suppressed": result.suppressed,
            "sources": result.sources,
            "score": result.score,
            "reason": result.reason or None,
            "error": result.error,
            "audio_chunks": result.audio_chunks,
            "audible_chunks": result.audible_chunks,
            "peak_rms": result.peak_rms,
            "elapsed_sec": round(result.elapsed, 2),
            "first_response_sec": round(result.first_response_sec, 2) if result.first_response_sec is not None else None,
            "turn_complete_sec": round(result.turn_complete_sec, 2) if result.turn_complete_sec is not None else None,
        }, ensure_ascii=False) + "\n")
        log_file.flush()

        if result.error and "ws closed" not in result.error:
            stats.errors += 1
        elif result.kind == QUESTION:
            stats.questions += 1
            if result.correct:
                stats.answered += 1
                if result.score is not None:
                    stats.answer_scores.append(result.score)
                if result.sources:
                    stats.grounded_answers += 1
            else:
                stats.misses.append(result)
        else:
            stats.silent_expected += 1
            if not result.correct:
                stats.false_speaks.append(result)

        latency_tag = ""
        if result.turn_complete_sec is not None:
            slow = result.turn_complete_sec > LATENCY_THRESHOLD
            latency_tag = (
                f" SLOW({result.turn_complete_sec:.1f}s)"
                if slow
                else f" {result.turn_complete_sec:.1f}s"
            )
        held = f" [held {result.suppressed}]" if result.suppressed else ""
        cited = f" [{result.sources} src]" if result.sources else ""

        if result.error:
            verdict = f"ERROR | {result.error}"
        elif result.kind == QUESTION:
            answer = (result.answer or "")[:60]
            verdict = (
                f"ANSWERED ({result.score:.0f}/10) -> \"{answer}\""
                if result.correct
                else f"MISSED — {result.reason}"
            )
        else:
            verdict = "silent" if result.correct else f"SPOKE UNASKED -> \"{(result.answer or '')[:60]}\""

        status = "ok  " if result.correct else "BAD "
        print(
            f"[{stamp()}] #{result.index} {status}{result.kind:<10}"
            f"({result.elapsed:.1f}s){latency_tag}{held}{cited} | "
            f"\"{result.spoken[:60]}\" | {verdict}"
        )

        elapsed = time.monotonic() - start
        remaining = args.duration - elapsed
        if remaining > 0:
            print(
                f"         [{elapsed:.0f}s / {args.duration}s elapsed, "
                f"{remaining:.0f}s remaining]",
                flush=True,
            )

    # ---------------------------------------------------------------- summary
    elapsed = time.monotonic() - start
    report: list[str] = []

    false_rate = (
        100 * len(stats.false_speaks) / stats.silent_expected
        if stats.silent_expected
        else 0.0
    )
    miss_rate = 100 * len(stats.misses) / stats.questions if stats.questions else 0.0
    avg_score = (
        sum(stats.answer_scores) / len(stats.answer_scores)
        if stats.answer_scores
        else 0.0
    )

    report.append(f"\n[{stamp()}] === SUMMARY ===")
    report.append(f"Duration: {elapsed:.0f}s | Turns: {stats.iterations} | Errors: {stats.errors}")
    report.append(
        f"False-speak: {len(stats.false_speaks)}/{stats.silent_expected} "
        f"({false_rate:.1f}%) — turns it answered uninvited"
    )
    report.append(
        f"Missed:      {len(stats.misses)}/{stats.questions} "
        f"({miss_rate:.1f}%) — questions it did not answer"
    )
    report.append(
        f"Answers:     {stats.answered} scored, avg {avg_score:.1f}/10, "
        f"{stats.grounded_answers} grounded in Search"
    )

    # Name-drops are the hard case, so they get broken out from plain chatter.
    for bucket in (CHATTER, NAME_DROP):
        turns = [r for r in stats.results if r.kind == bucket and not r.error]
        if not turns:
            continue
        bad = [r for r in turns if not r.correct]
        report.append(
            f"  {bucket:<10} {len(turns) - len(bad)}/{len(turns)} silent "
            f"({100 * len(bad) / len(turns):.1f}% false-speak)"
        )

    if stats.false_speaks:
        report.append("\nSpoke when nobody asked it:")
        for r in stats.false_speaks:
            report.append(f"  #{r.index} [{r.kind}] \"{r.spoken[:70]}\"")
            report.append(f"        said: \"{(r.answer or '(audio only)')[:70]}\"")

    if stats.misses:
        report.append("\nAsked and did not answer:")
        for r in stats.misses:
            report.append(f"  #{r.index} \"{r.spoken[:70]}\"")

    report.extend(_format_distribution("Answer Score", stats.answer_scores, [
        ("0-2", 0.0, 2.5),
        ("3-4", 2.5, 4.5),
        ("5-6", 4.5, 6.5),
        ("7-8", 6.5, 8.5),
        ("9-10", 8.5, 10.1),
    ]))

    answered = [r for r in stats.results if r.kind == QUESTION and r.correct]
    report.extend(_format_distribution(
        "Answer First Response (speech-end to first audio/transcript)",
        [r.first_response_sec for r in answered if r.first_response_sec is not None],
        [
            ("<0.5s", 0.0, 0.5),
            ("0.5-1s", 0.5, 1.0),
            ("1-2s", 1.0, 2.0),
            ("2-3s", 2.0, 3.0),
            ("3-5s", 3.0, 5.0),
            ("5-8s", 5.0, 8.0),
            (">8s", 8.0, 1e9),
        ],
    ))

    report.extend(_format_distribution(
        "Answer Complete (speech-end to end of answer)",
        [r.turn_complete_sec for r in answered if r.turn_complete_sec is not None],
        [
            ("<3s", 0.0, 3.0),
            ("3-5s", 3.0, 5.0),
            ("5-7s", 5.0, 7.0),
            ("7-10s", 7.0, 10.0),
            ("10-15s", 10.0, 15.0),
            (">15s", 15.0, 1e9),
        ],
    ))

    report.extend(_format_distribution(
        "Total Turn Time",
        [r.elapsed for r in stats.results if not r.error],
        [
            ("<10s", 0.0, 10.0),
            ("10-15s", 10.0, 15.0),
            ("15-20s", 15.0, 20.0),
            ("20-25s", 20.0, 25.0),
            ("25-30s", 25.0, 30.0),
            (">30s", 30.0, 1e9),
        ],
    ))

    for line in report:
        print(line)

    report_path = log_path.replace(".jsonl", ".report")
    with open(report_path, "w") as f:
        f.write("\n".join(report) + "\n")

    log_file.close()
    print(f"[{stamp()}] Metrics log: {log_path}")
    print(f"[{stamp()}] Report: {report_path}")

    # Any false speak fails the run. It is the one failure the audience sees.
    ok = stats.errors == 0 and not stats.false_speaks and stats.answered > 0
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
