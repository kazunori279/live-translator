"""E2E tests: speak to a running server and check what the room actually hears.

The assistant's job is mostly *not* answering. So the cases that matter most
here are the negative ones: a panel talking about Gemini, or about anything at
all, has to produce a transcript and no audio. A build that answers everything
passes any test that only checks "did a reply come back", which is why every
case below states an expectation in both directions.

`say` gives us real speech rather than synthetic tones, so wake phrases get
tested through the same transcription path the venue will use — including the
mishearings, which is the whole reason the wake matcher has variant spellings.

Requires a running server (`uv run uvicorn app.main:app --port 8000`) with a
Gemini API key, plus macOS `say` and `ffmpeg`.
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
ANSWER_TIMEOUT = 25  # seconds to wait for an answer once the question is in
SILENCE_OBSERVE = 15  # seconds to keep listening when expecting no reply

# A "quiet" model still streams frames — a gated turn sends digital silence
# rather than nothing at all (measured RMS ~0.3, peak ~1.9, on a 32768 full
# scale). So audio has to be judged by level, not by frame count. Speech sits in
# the hundreds or thousands; 50 clears the floor by more than an order of
# magnitude without coming near real speech.
AUDIBLE_RMS = 50
# ...and one stray frame above that floor is still not speech. The quiet stream
# occasionally emits a single blip; a real utterance ran 8-16 audible frames of
# ~0.25s each. Requiring a short run separates the two with margin on both sides.
SPEECH_MIN_CHUNKS = 3

# macOS say voice for each spoken language
SAY_VOICES = {"en": "Samantha", "ja": "Kyoko"}


# ---------------------------------------------------------------- script checks

_KANA = re.compile(r"[぀-ゟ゠-ヿ]")
_LATIN = re.compile(r"[A-Za-z]")


def _is_japanese(text: str) -> bool:
    """Kana is the giveaway — Chinese shares the CJK block but has no kana."""
    return bool(_KANA.search(text))


def _is_english(text: str) -> bool:
    """Latin letters and no kana: enough to tell an EN answer from a JA one."""
    return bool(_LATIN.search(text)) and not _KANA.search(text)


SCRIPT_CHECKS = {"ja": _is_japanese, "en": _is_english}


def _rms(pcm: bytes) -> float:
    """Root-mean-square level of signed 16-bit little-endian PCM."""
    count = len(pcm) // 2
    if not count:
        return 0.0
    samples = struct.unpack(f"<{count}h", pcm[: count * 2])
    return math.sqrt(sum(s * s for s in samples) / count)


# ---------------------------------------------------------------------- cases

ANY = "any"  # it answered; do not check which language
SILENCE = "silence"  # it must not answer at all
GROUNDED = "grounded"  # it answered and cited sources


@dataclass
class Utterance:
    lang: str  # language actually spoken (picks the say voice)
    text: str


@dataclass
class Case:
    description: str
    utterances: list[Utterance]
    # Language codes that must each appear in some output transcription, or
    # [ANY] / [SILENCE] / [GROUNDED].
    expect: list[str] = field(default_factory=lambda: [ANY])
    # A control frame sent before the audio, as the console's buttons do.
    control: dict | None = None


TEST_CASES = [
    # --- the default state: the panel talks, the assistant does not -----------
    Case(
        "Silent: ordinary panel discussion",
        [
            Utterance(
                "en",
                "The Munich court ruled against Suno at the end of July, and I "
                "think that changes the licensing picture in Europe completely.",
            )
        ],
        expect=[SILENCE],
    ),
    Case(
        # The single most likely false positive: this panel says the assistant's
        # name out loud as a product name all evening.
        "Silent: its own name used as a product name",
        [
            Utterance(
                "en",
                "The Gemini API can generate audio natively now, which is a "
                "different thing from what Suno does.",
            )
        ],
        expect=[SILENCE],
    ),
    Case(
        "Silent: Japanese discussion mentioning the name",
        [Utterance("ja", "ジェミニのモデルは音楽も生成できますが、品質はどうでしょう。")],
        expect=[SILENCE],
    ),
    Case(
        # A question asked of the human panel, not of the assistant. Nothing
        # arms here, so an answer would be the assistant talking over a
        # panellist who was addressed by name.
        "Silent: a question aimed at a human panellist",
        [Utterance("en", "Hiroshi, what do you make of the Deezer numbers?")],
        expect=[SILENCE],
    ),
    # --- being addressed ------------------------------------------------------
    Case(
        "Answers: English wake phrase",
        [
            Utterance(
                "en",
                "Hey Gemini, what do you think about AI generated music on "
                "streaming platforms?",
            )
        ],
        expect=["en"],
    ),
    Case(
        # Bilingual: asked in Japanese, so the answer has to come back in
        # Japanese rather than defaulting to the instruction's language.
        "Answers: Japanese wake phrase, answers in Japanese",
        [Utterance("ja", "ねえジェミニ、AIと音楽についてどう思いますか。")],
        expect=["ja"],
    ),
    Case(
        "Answers: name first, no cue word",
        [Utterance("en", "Gemini, what's the strongest argument on the other side?")],
        expect=["en"],
    ),
    Case(
        # The briefing exists so the assistant does not have to search for
        # things it was already told. This asks about the core material.
        "Answers: from the briefing",
        [
            Utterance(
                "en",
                "Hey Gemini, give us one number worth quoting about AI music "
                "on streaming services.",
            )
        ],
        expect=["en"],
    ),
    Case(
        # Deliberately about something after the briefing was written, so the
        # only way to answer it is google_search — and then the sources have to
        # come with it, which Google's terms require us to display.
        "Answers: grounded in Search, with sources",
        [
            Utterance(
                "en",
                "Hey Gemini, what is the most recent news this month about AI "
                "music and copyright? Please search for it.",
            )
        ],
        expect=[GROUNDED],
    ),
    # --- the moderator's controls ---------------------------------------------
    Case(
        "Answers: armed by the Ask button, no wake phrase",
        [Utterance("en", "So where does that leave independent artists?")],
        expect=[ANY],
        control={"type": "arm"},
    ),
    Case(
        "Answers: suggests a discussion topic on request",
        [],
        expect=[ANY],
        control={"type": "topic"},
    ),
    Case(
        "Answers: a typed question",
        [],
        expect=[ANY],
        control={
            "type": "ask",
            "text": "In one sentence, what is the most contested question about AI and music right now?",
        },
    ),
    # --- one question, one answer ---------------------------------------------
    Case(
        # The gate closes at the end of the answered turn. If it did not, the
        # assistant would keep answering for the rest of the session — the
        # failure mode that is worst on stage and least visible in testing.
        "Silent: the turn after an answered question",
        [
            Utterance("en", "Hey Gemini, briefly, what is Suno?"),
            Utterance(
                "en",
                "Right. Anyway, the point I was making about licensing is that "
                "the labels settled rather than litigate.",
            ),
        ],
        expect=["turn2-silent"],
    ),
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


@dataclass
class Turn:
    """What the room heard during one model turn."""

    outputs: list[str] = field(default_factory=list)
    audible_chunks: int = 0
    sources: list[str] = field(default_factory=list)

    @property
    def spoke(self) -> bool:
        return self.audible_chunks >= SPEECH_MIN_CHUNKS or bool(self.outputs)


def evaluate(case: Case, turns: list[Turn]) -> tuple[bool, str]:
    """Decide pass/fail and explain why, so a failure names what was missing."""
    spoken_turns = [t for t in turns if t.spoke]
    outputs = [text for t in turns for text in t.outputs]
    audible = sum(t.audible_chunks for t in turns)
    sources = [s for t in turns for s in t.sources]

    if case.expect == [SILENCE]:
        if spoken_turns:
            return False, (
                f"expected silence, got {audible} audible chunks and {outputs}"
            )
        return True, "stayed silent, as expected"

    if case.expect == ["turn2-silent"]:
        if not spoken_turns:
            return False, "never answered the question it was asked"
        if len(spoken_turns) > 1:
            return False, (
                f"kept talking: answered {len(spoken_turns)} turns, {outputs}"
            )
        return True, "answered once, then went quiet"

    if not spoken_turns:
        return False, f"no answer ({audible} audible chunks, no transcription)"
    if audible < SPEECH_MIN_CHUNKS:
        return False, f"transcription but only {audible} audible chunks"

    if case.expect == [GROUNDED]:
        if not sources:
            return False, f"answered without citing sources: {outputs}"
        return True, f"answered with {len(sources)} source(s)"

    if case.expect == [ANY]:
        return True, "answered"

    missing = [
        code
        for code in case.expect
        if not any(SCRIPT_CHECKS[code](text) for text in outputs)
    ]
    if missing:
        return False, f"no {'/'.join(missing)} answer among: {outputs}"
    return True, f"answered in {'+'.join(case.expect)}"


async def run_case(case: Case, base_url: str, session_id: str) -> dict:
    """Run one case in its own session and judge what came back."""
    print(f"\n{'─' * 60}")
    print(f"TEST: {case.description}")
    if case.control:
        print(f"  control: {json.dumps(case.control, ensure_ascii=False)}")
    for u in case.utterances:
        print(f"  speaks [{u.lang}] {u.text}")
    print(f"Expect: {', '.join(case.expect)}")
    print(f"{'─' * 60}")

    clips = [
        generate_test_audio(u.text, SAY_VOICES.get(u.lang, "Samantha"))
        for u in case.utterances
    ]
    if clips:
        print(f"Audio: {len(clips)} clip(s), {sum(len(c) for c in clips) / 32000:.1f}s")

    url = f"{base_url}/ws/test-user/{session_id}"

    heard: list[str] = []
    gate_events: list[dict] = []
    suppressed = 0
    turns: list[Turn] = [Turn()]
    total_chunks = 0
    peak_rms = [0.0]
    pending_output = ""
    turn_event = asyncio.Event()

    async with websockets.connect(url) as ws:
        # Setup frame, exactly as the browser sends it.
        await ws.send(json.dumps({"glossary": [], "voice": ""}))
        await asyncio.sleep(5)  # let the upstream Live session come up

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

        async def receive_events():
            nonlocal total_chunks, suppressed, pending_output
            try:
                async for message in ws:
                    event = json.loads(message)

                    if event.get("gate"):
                        gate_events.append(event["gate"])
                        state = "ARMED" if event["gate"].get("armed") else "listening"
                        print(f"  [GATE] {state} {event['gate'].get('reason', '')}")
                        continue

                    if event.get("suppressed"):
                        suppressed += 1
                        print("  [GATE] held back an unrequested reply")
                        continue

                    if event.get("inputTranscription"):
                        t = event["inputTranscription"].get("text", "")
                        if t:
                            heard.append(t)
                            print(f"  [HEARD] {t}")

                    if event.get("outputTranscription"):
                        t = event["outputTranscription"].get("text", "")
                        finished = event["outputTranscription"].get("finished", False)
                        if t:
                            if finished:
                                turns[-1].outputs.append(t)
                                pending_output = ""
                                print(f"  [SAID] {t}")
                            else:
                                pending_output += t

                    gm = event.get("groundingMetadata")
                    if gm:
                        for chunk in gm.get("chunks", []):
                            uri = chunk.get("domain") or chunk.get("uri", "")
                            if uri:
                                turns[-1].sources.append(uri)
                        if gm.get("queries"):
                            print(f"  [SEARCH] {gm['queries']}")

                    for part in event.get("content", {}).get("parts", []) or []:
                        if part.get("inlineData"):
                            total_chunks += 1
                            level = _rms(base64.b64decode(part["inlineData"]["data"]))
                            peak_rms[0] = max(peak_rms[0], level)
                            if level > AUDIBLE_RMS:
                                turns[-1].audible_chunks += 1

                    if event.get("turnComplete"):
                        if pending_output:
                            turns[-1].outputs.append(pending_output)
                            pending_output = ""
                        marker = "spoke" if turns[-1].spoke else "silent"
                        print(f"  [TURN {len(turns)} complete — {marker}]")
                        turns.append(Turn())
                        turn_event.set()

            except websockets.exceptions.ConnectionClosed:
                pass

        recv_task = asyncio.create_task(receive_events())

        if case.control:
            await ws.send(json.dumps(case.control))

        for i, pcm in enumerate(clips):
            await send_clip(pcm)
            print(f"  sent clip {i + 1}/{len(clips)}")
            # Hold the line open long enough for a reply to land (or not) before
            # the next utterance arrives.
            await send_silence(3.0)
            turn_event.clear()
            try:
                await asyncio.wait_for(turn_event.wait(), timeout=ANSWER_TIMEOUT)
            except asyncio.TimeoutError:
                pass

        # For a silence case the observation window IS the assertion, so it
        # cannot end at the first turn boundary. Control-only cases have no
        # audio at all and need the same open-ended wait for the reply the
        # control triggered.
        if case.expect == [SILENCE] or not clips:
            await send_silence(SILENCE_OBSERVE)

        recv_task.cancel()
        try:
            await recv_task
        except asyncio.CancelledError:
            pass

    if pending_output:
        turns[-1].outputs.append(pending_output)

    passed, reason = evaluate(case, turns)
    audible = sum(t.audible_chunks for t in turns)
    outputs = [text for t in turns for text in t.outputs]

    print(f"\n  Result: {'PASS' if passed else 'FAIL'} — {reason}")
    if heard:
        print(f"  Heard:    {' | '.join(heard)}")
    if outputs:
        print(f"  Said:     {' | '.join(outputs)}")
    print(
        f"  Audio:    {audible} audible of {total_chunks} chunks, "
        f"peak RMS {peak_rms[0]:.0f}; {suppressed} reply(ies) held back"
    )

    return {
        "description": case.description,
        "expect": case.expect,
        "heard": heard,
        "said": outputs,
        "audible_chunks": audible,
        "audio_chunks": total_chunks,
        "peak_rms": round(peak_rms[0], 1),
        "suppressed": suppressed,
        "gate_events": gate_events,
        "sources": [s for t in turns for s in t.sources],
        "passed": passed,
        "reason": reason,
    }


async def run_all(cases: list[Case], base_url: str) -> bool:
    results = []
    for i, case in enumerate(cases):
        results.append(await run_case(case, base_url, f"test-e2e-{i}"))

    print("\n" + "=" * 84)
    print("SUMMARY")
    print("=" * 84)
    print(f"{'Test':<52} {'Status':<6} {'Why'}")
    print("-" * 84)
    for r in results:
        status = "PASS" if r["passed"] else "FAIL"
        reason = r["reason"]
        if len(reason) > 60:
            reason = reason[:57] + "..."
        print(f"{r['description']:<52} {status:<6} {reason}")

    # False speech is the failure the audience notices, so it is called out
    # separately from the tally.
    false_speak = [
        r for r in results if r["expect"] == [SILENCE] and not r["passed"]
    ]
    if false_speak:
        print(f"\nSpoke when it should not have, {len(false_speak)} time(s):")
        for r in false_speak:
            print(f"  - {r['description']}")

    passed = sum(1 for r in results if r["passed"])
    print(f"\n{passed}/{len(results)} tests passed")
    return passed == len(results)


def main():
    parser = argparse.ArgumentParser(
        description="E2E behaviour tests for the AI panel assistant",
        epilog="With no filters, runs every case.",
    )
    parser.add_argument("--url", default=DEFAULT_URL, help="WebSocket base URL")
    parser.add_argument(
        "--match",
        help="Only run cases whose description contains this text (case-insensitive)",
    )
    parser.add_argument(
        "--say",
        nargs=2,
        metavar=("LANG", "TEXT"),
        help="Skip the suite and speak one ad-hoc line instead",
    )
    parser.add_argument(
        "--expect",
        default=ANY,
        help=f"Expectation for --say: a language code, {ANY}, {SILENCE} or {GROUNDED}",
    )
    args = parser.parse_args()

    if args.say:
        lang, text = args.say
        case = Case(f"Ad-hoc [{lang}]", [Utterance(lang, text)], expect=[args.expect])
        result = asyncio.run(run_case(case, args.url, "test-e2e-adhoc"))
        return 0 if result["passed"] else 1

    cases = TEST_CASES
    if args.match:
        needle = args.match.lower()
        cases = [c for c in cases if needle in c.description.lower()]
    if not cases:
        print("No cases matched the filters.")
        return 1

    return 0 if asyncio.run(run_all(cases, args.url)) else 1


if __name__ == "__main__":
    sys.exit(main())
