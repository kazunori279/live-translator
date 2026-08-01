"""E2E tests: connect via WebSocket, send speech, verify what each mode promises.

The old version of this file only ever fed source-language audio and checked
that *something* came back, which every mode passes — including a one-way
translator pretending to be an interpreter. These cases are written so that a
mode failing to do its distinctive job actually fails:

  conversation (default)  interprets in BOTH directions within one session
  simultaneous            one-way into the target, and SILENT on input that is
                          already in the target language (echo_target_language
                          is False, which is that mode's only echo guard)
  agent                   one-way source -> target; still reachable on the
                          server, no longer offered by the UI

Direction is checked by writing system: for the en/ja pair the two languages
cannot be confused, so "did Japanese come out" is a reliable proxy for "did it
translate the English" without needing a second model to grade it.

Requires a running server (default port 8001) and a Gemini API key on it.
"""

import argparse
import asyncio
import base64
import json
import math
import re
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import websockets

DEFAULT_URL = "ws://localhost:8000"  # where `uvicorn app.main:app` serves by default
CHUNK_SIZE = 512  # bytes per frame (256 samples * 2 bytes)
CHUNK_INTERVAL = 0.016  # ~16ms per chunk at 16kHz
TURN_TIMEOUT = 15  # seconds to wait for each expected turn
SILENCE_OBSERVE = 12  # seconds to keep listening when expecting no reply

# A "quiet" model still streams frames — when the simul echo guard declines to
# speak it sends digital silence rather than nothing at all (measured RMS ~0.3,
# peak ~1.9, on a 32768 full scale). So audio has to be judged by level, not by
# frame count. Speech sits in the hundreds or thousands; 50 clears the floor by
# more than an order of magnitude without coming near real speech.
AUDIBLE_RMS = 50
# ...and one stray frame above that floor is still not speech. The quiet stream
# occasionally emits a single blip; a real utterance ran 8-16 audible frames of
# ~0.25s each. Requiring a short run separates the two with margin on both sides
# and keeps the echo-guard case from failing on a lone transient.
SPEECH_MIN_CHUNKS = 3

# macOS say voice for each spoken language
SAY_VOICES = {
    "en": "Samantha",
    "ja": "Kyoko",
    "zh": "Ting-Ting",
    "es": "Monica",
    "fr": "Thomas",
    "de": "Anna",
    "ko": "Yuna",
    "pt": "Luciana",
}


# ---------------------------------------------------------------- script checks

_KANA = re.compile(r"[぀-ゟ゠-ヿ]")
_CJK = re.compile(r"[一-鿿]")
_HANGUL = re.compile(r"[가-힯]")
_LATIN = re.compile(r"[A-Za-z]")


def _is_japanese(text: str) -> bool:
    """Kana is the giveaway — Chinese shares the CJK block but has no kana."""
    return bool(_KANA.search(text))


def _is_chinese(text: str) -> bool:
    return bool(_CJK.search(text)) and not _KANA.search(text)


def _is_korean(text: str) -> bool:
    return bool(_HANGUL.search(text))


def _is_latin(text: str) -> bool:
    """True for en/es/fr/de/pt — enough to tell them apart from ja/zh/ko."""
    return bool(_LATIN.search(text))


def _rms(pcm: bytes) -> float:
    """Root-mean-square level of signed 16-bit little-endian PCM."""
    count = len(pcm) // 2
    if not count:
        return 0.0
    samples = struct.unpack(f"<{count}h", pcm[: count * 2])
    return math.sqrt(sum(s * s for s in samples) / count)


SCRIPT_CHECKS = {
    "ja": _is_japanese,
    "zh": _is_chinese,
    "ko": _is_korean,
    "en": _is_latin,
    "es": _is_latin,
    "fr": _is_latin,
    "de": _is_latin,
    "pt": _is_latin,
}


# ---------------------------------------------------------------------- cases

ANY = "any"  # some translation came back; do not check which language
SILENCE = "silence"  # nothing should come back at all


@dataclass
class Utterance:
    lang: str  # language actually spoken (picks the say voice)
    text: str


@dataclass
class Case:
    description: str
    mode: str  # "convo" | "simul" | "agent"
    source: str
    target: str
    utterances: list[Utterance]
    # Language codes that must each appear in some final output transcription,
    # or [ANY] for "anything", or [SILENCE] for "nothing at all".
    expect: list[str] = field(default_factory=lambda: [ANY])


TEST_CASES = [
    # --- conversation mode: the default, and the only one claiming both ways ---
    Case(
        "Conversation: forward (en spoken)",
        "convo", "en", "ja",
        [Utterance("en", "Hello, this is a test of the live translation system.")],
        expect=["ja"],
    ),
    Case(
        "Conversation: reverse (ja spoken)",
        "convo", "en", "ja",
        [Utterance("ja", "はじめまして、今日はよろしくお願いします。")],
        expect=["en"],
    ),
    Case(
        "Conversation: both ways in one session",
        "convo", "en", "ja",
        [
            Utterance("en", "Good morning. How was your trip?"),
            Utterance("ja", "とても楽しかったです。ありがとうございます。"),
        ],
        expect=["ja", "en"],
    ),
    # --- simultaneous mode ---
    Case(
        "Simul: translates into the target",
        "simul", "en", "ja",
        [Utterance("en", "The weather is beautiful today.")],
        expect=["ja"],
    ),
    Case(
        # Guards echo_target_language=False. With True the model parrots input
        # already in the target language — and its own output is by construction
        # in the target language, so speakers feeding the mic gave a loop with
        # gain ~1 that never decayed. Declining to speak still streams frames,
        # they are just silent, which is why this is judged on level.
        "Simul: silent on target-language input (echo guard)",
        "simul", "en", "ja",
        [Utterance("ja", "今日はとても良い天気ですね。")],
        expect=[SILENCE],
    ),
    # --- agent mode: no longer offered by the UI, still served ---
    Case(
        "Agent: one-way source to target",
        "agent", "en", "ja",
        [Utterance("en", "Please take a seat and we will begin shortly.")],
        expect=["ja"],
    ),
    # --- language coverage, exercised through the default mode ---
    Case("Coverage: English to Spanish", "convo", "en", "es",
         [Utterance("en", "Thank you very much for your help.")], expect=["es"]),
    Case("Coverage: English to French", "convo", "en", "fr",
         [Utterance("en", "Where is the nearest train station?")], expect=["fr"]),
    Case("Coverage: English to Korean", "convo", "en", "ko",
         [Utterance("en", "Nice to meet you.")], expect=["ko"]),
    Case("Coverage: English to Chinese", "convo", "en", "zh",
         [Utterance("en", "Good morning, how are you?")], expect=["zh"]),
]


# ---------------------------------------------------------------------- audio


def generate_test_audio(text: str, voice: str = "Samantha") -> bytes:
    """Generate PCM 16kHz mono audio from text using macOS say + ffmpeg.

    Adds 1s silence before and after speech to help VAD detect boundaries.
    """
    with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as aiff_f:
        aiff_path = aiff_f.name
    with tempfile.NamedTemporaryFile(suffix=".pcm", delete=False) as pcm_f:
        pcm_path = pcm_f.name

    try:
        subprocess.run(
            ["say", "-v", voice, "-o", aiff_path, text],
            check=True,
            capture_output=True,
        )
        # Add 1s silence padding before and after speech for VAD
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                "-i", aiff_path,
                "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                "-filter_complex",
                "[0]atrim=0:1[pre];[1]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[speech];[2]atrim=0:1[post];[pre][speech][post]concat=n=3:v=0:a=1[out]",
                "-map", "[out]",
                "-f", "s16le", "-acodec", "pcm_s16le",
                "-ar", "16000", "-ac", "1",
                pcm_path,
            ],
            check=True,
            capture_output=True,
        )
        return Path(pcm_path).read_bytes()
    finally:
        Path(aiff_path).unlink(missing_ok=True)
        Path(pcm_path).unlink(missing_ok=True)


# ----------------------------------------------------------------------- runner


def build_url(base: str, case: Case, session_id: str) -> str:
    url = f"{base}/ws/test-user/{session_id}?source={case.source}&target={case.target}"
    if case.mode == "convo":
        url += "&convo=true"
    elif case.mode == "simul":
        url += "&simul=true"
    return url


def evaluate(case: Case, outputs: list[str], audible_chunks: int) -> tuple[bool, str]:
    """Decide pass/fail and explain why, so a failure names what was missing."""
    spoke = audible_chunks >= SPEECH_MIN_CHUNKS

    if case.expect == [SILENCE]:
        if spoke or outputs:
            return False, (
                f"expected silence, got {audible_chunks} audible chunks "
                f"and {outputs}"
            )
        return True, "stayed silent, as expected"

    if not outputs:
        return False, "no output transcription"
    if not spoke:
        return False, f"output transcription but only {audible_chunks} audible chunks"

    if case.expect == [ANY]:
        return True, "translation received"

    missing = [
        code for code in case.expect
        if not any(SCRIPT_CHECKS[code](text) for text in outputs)
    ]
    if missing:
        return False, f"no {'/'.join(missing)} output among: {outputs}"
    return True, f"got {'+'.join(case.expect)} output"


async def run_case(case: Case, base_url: str, session_id: str) -> dict:
    """Run one case: stream its utterances into one session, judge the replies."""
    print(f"\n{'─' * 60}")
    print(f"TEST: {case.description}")
    print(f"Mode: {case.mode} | Pair: {case.source}/{case.target}")
    for u in case.utterances:
        print(f"  speaks [{u.lang}] {u.text}")
    print(f"Expect: {', '.join(case.expect)}")
    print(f"{'─' * 60}")

    clips = [
        generate_test_audio(u.text, SAY_VOICES.get(u.lang, "Samantha"))
        for u in case.utterances
    ]
    total_s = sum(len(c) for c in clips) / 32000
    print(f"Audio: {len(clips)} clip(s), {total_s:.1f}s")

    url = build_url(base_url, case, session_id)

    input_transcriptions: list[str] = []
    # Output transcription arrives as fragments: partials append, and the
    # message flagged `finished` carries the full replacement text. Reassemble
    # exactly as the client does, or a script check lands on a fragment that
    # happens to be punctuation and reports the wrong language.
    outputs: list[str] = []
    pending_output = ""
    audio_chunks_received = 0
    audible_chunks_received = 0
    peak_rms = [0.0]
    events_received = 0
    turns_seen = 0
    turn_event = asyncio.Event()

    # Simul streams continuously and never signals a turn boundary, so waiting
    # for turnComplete there would always time out. Listen for a fixed window
    # instead. Silence cases also have no turn to wait for, by definition.
    waits_for_turns = case.mode != "simul" and case.expect != [SILENCE]

    async with websockets.connect(url) as ws:
        await asyncio.sleep(5)  # let the upstream Live session come up
        print("Sending audio...")

        async def send_clip(pcm: bytes):
            offset = 0
            while offset < len(pcm):
                await ws.send(pcm[offset : offset + CHUNK_SIZE])
                offset += CHUNK_SIZE
                await asyncio.sleep(CHUNK_INTERVAL)

        async def send_silence(seconds: float):
            silence = b"\x00" * CHUNK_SIZE
            for _ in range(int(seconds / CHUNK_INTERVAL)):
                await ws.send(silence)
                await asyncio.sleep(CHUNK_INTERVAL)

        async def send_audio():
            for i, pcm in enumerate(clips):
                await send_clip(pcm)
                print(f"  sent clip {i + 1}/{len(clips)}")
                # Between utterances, hold the line open long enough for the
                # model to answer the first one before the next arrives.
                await send_silence(5.0 if i < len(clips) - 1 else 3.0)

        async def receive_events():
            nonlocal audio_chunks_received, audible_chunks_received
            nonlocal events_received, turns_seen, pending_output
            try:
                async for message in ws:
                    event = json.loads(message)
                    events_received += 1

                    if event.get("inputTranscription"):
                        t = event["inputTranscription"].get("text", "")
                        if t:
                            input_transcriptions.append(t)
                            print(f"  [INPUT] {t}")

                    if event.get("outputTranscription"):
                        t = event["outputTranscription"].get("text", "")
                        finished = event["outputTranscription"].get("finished", False)
                        if t:
                            if finished:
                                outputs.append(t)
                                pending_output = ""
                                print(f"  [OUTPUT FINAL] {t}")
                            else:
                                pending_output += t
                                print(f"  [OUTPUT partial] {t}")

                    for part in event.get("content", {}).get("parts", []) or []:
                        if part.get("inlineData"):
                            audio_chunks_received += 1
                            pcm = base64.b64decode(part["inlineData"]["data"])
                            level = _rms(pcm)
                            peak_rms[0] = max(peak_rms[0], level)
                            if level > AUDIBLE_RMS:
                                audible_chunks_received += 1

                    if event.get("turnComplete"):
                        turns_seen += 1
                        print(f"  [TURN COMPLETE {turns_seen}]")
                        turn_event.set()

            except websockets.exceptions.ConnectionClosed:
                pass

        recv_task = asyncio.create_task(receive_events())
        await send_audio()

        if waits_for_turns:
            while turns_seen < len(case.utterances):
                turn_event.clear()
                try:
                    await asyncio.wait_for(turn_event.wait(), timeout=TURN_TIMEOUT)
                except asyncio.TimeoutError:
                    print(f"Timeout waiting for turn {turns_seen + 1}")
                    break
        else:
            # No turn signal to wait on: keep the socket open and see what,
            # if anything, arrives. For the echo-guard case this window is the
            # whole assertion, so it has to be generous.
            await send_silence(2.0)
            await asyncio.sleep(
                SILENCE_OBSERVE if case.expect == [SILENCE] else TURN_TIMEOUT
            )

        recv_task.cancel()
        try:
            await recv_task
        except asyncio.CancelledError:
            pass

    # Simul finalizes on an idle timer rather than a turn boundary, so the
    # `finished` flag may never arrive; whatever is still buffered counts.
    judged = outputs + ([pending_output] if pending_output else [])
    passed, reason = evaluate(case, judged, audible_chunks_received)

    print(f"\n  Result: {'PASS' if passed else 'FAIL'} — {reason}")
    if input_transcriptions:
        print(f"  Heard:      {' | '.join(input_transcriptions)}")
    if judged:
        print(f"  Translated: {' | '.join(judged)}")
    print(
        f"  Audio:      {audible_chunks_received} audible "
        f"of {audio_chunks_received} chunks, peak RMS {peak_rms[0]:.0f}"
    )

    return {
        "description": case.description,
        "mode": case.mode,
        "pair": f"{case.source}/{case.target}",
        "spoken": [u.lang for u in case.utterances],
        "expect": case.expect,
        "heard": input_transcriptions,
        "translated": judged,
        "events": events_received,
        "audio_chunks": audio_chunks_received,
        "audible_chunks": audible_chunks_received,
        "peak_rms": round(peak_rms[0], 1),
        "passed": passed,
        "reason": reason,
    }


async def run_all(cases: list[Case], base_url: str) -> bool:
    results = []
    for i, case in enumerate(cases):
        session_id = f"test-e2e-{i}-{case.mode}"
        results.append(await run_case(case, base_url, session_id))

    print("\n" + "=" * 78)
    print("SUMMARY")
    print("=" * 78)
    print(f"{'Test':<44} {'Mode':<7} {'Status':<6} {'Why'}")
    print("-" * 78)
    for r in results:
        status = "PASS" if r["passed"] else "FAIL"
        reason = r["reason"]
        if len(reason) > 60:
            reason = reason[:57] + "..."
        print(f"{r['description']:<44} {r['mode']:<7} {status:<6} {reason}")

    passed = sum(1 for r in results if r["passed"])
    print(f"\n{passed}/{len(results)} tests passed")
    return passed == len(results)


def main():
    parser = argparse.ArgumentParser(
        description="E2E behaviour tests for the live translator",
        epilog="With no filters, runs every case.",
    )
    parser.add_argument("--url", default=DEFAULT_URL, help="WebSocket base URL")
    parser.add_argument(
        "--mode",
        choices=("convo", "simul", "agent"),
        help="Only run cases for this mode",
    )
    parser.add_argument(
        "--match",
        help="Only run cases whose description contains this text (case-insensitive)",
    )
    parser.add_argument(
        "--say",
        nargs=3,
        metavar=("SOURCE", "TARGET", "TEXT"),
        help="Skip the suite and run one ad-hoc utterance instead",
    )
    args = parser.parse_args()

    if args.say:
        source, target, text = args.say
        case = Case(
            f"Ad-hoc {source} to {target}",
            args.mode or "convo", source, target,
            [Utterance(source, text)],
            expect=[target] if target in SCRIPT_CHECKS else [ANY],
        )
        result = asyncio.run(run_case(case, args.url, f"test-e2e-adhoc-{source}-{target}"))
        return 0 if result["passed"] else 1

    cases = TEST_CASES
    if args.mode:
        cases = [c for c in cases if c.mode == args.mode]
    if args.match:
        needle = args.match.lower()
        cases = [c for c in cases if needle in c.description.lower()]
    if not cases:
        print("No cases matched the filters.")
        return 1

    return 0 if asyncio.run(run_all(cases, args.url)) else 1


if __name__ == "__main__":
    sys.exit(main())
