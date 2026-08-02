"""Offline check that the output gate lets through only what the panel asked for.

The gate is the thing standing between a chatty model and an interrupted panel.
The prompt asks the assistant to stay quiet; this decides whether the room
actually hears it. Every scenario below is replayed as the exact envelope
sequence `_relay_session` would hand it, with a fake clock so the manual-arm
timeout is testable without sleeping.

Run: uv run python tests/test_gate.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import GATE_BUFFER_MAX_BYTES, MANUAL_ARM_TTL_SEC, OutputGate  # noqa: E402
from app.panel_agent.agent import WakeMatcher  # noqa: E402


class Clock:
    """A hand-cranked monotonic clock, in the shape `loop.time` has."""

    def __init__(self):
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, secs: float) -> None:
        self.t += secs


def heard(text: str) -> dict:
    return {"inputTranscription": {"text": text, "finished": False}}


def said(nbytes: int = 4000) -> dict:
    """One chunk of model audio, as base64 of roughly *nbytes*."""
    return {
        "content": {
            "role": "model",
            "parts": [{"inlineData": {"mimeType": "audio/pcm", "data": "A" * nbytes}}],
        },
        "partial": True,
    }


def caption(text: str) -> dict:
    return {"outputTranscription": {"text": text, "finished": False}}


DONE = {"turnComplete": True}


class Room:
    """Runs a turn through a gate and records what the room actually hears."""

    def __init__(self, clock: Clock | None = None):
        self.clock = clock or Clock()
        self.gate = OutputGate(WakeMatcher(), self.clock)
        self.out: list[dict] = []
        self.suppressed = 0

    def play(self, *envelopes: dict) -> "Room":
        for env in envelopes:
            it = env.get("inputTranscription")
            if it and it.get("text"):
                self.gate.hear(it["text"])
            # Read the boundary before filtering: the gate splits it out of an
            # envelope whose reply it is holding, exactly as the relay does.
            ended = bool(env.get("turnComplete"))
            self.out.extend(self.gate.filter(env))
            if ended and self.gate.end_turn():
                self.suppressed += 1
        return self

    @property
    def spoke(self) -> bool:
        """Whether any model audio reached the room."""
        return any(e.get("content") for e in self.out)

    @property
    def audio_chunks(self) -> int:
        return sum(1 for e in self.out if e.get("content"))

    @property
    def turns_closed(self) -> int:
        return sum(1 for e in self.out if e.get("turnComplete"))

    @property
    def transcript(self) -> str:
        return "".join(
            (e.get("inputTranscription") or {}).get("text", "") for e in self.out
        )


def check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    return ok


def main() -> int:
    failures = 0
    results: list[tuple[str, bool, str]] = []

    def case(label, ok, detail=""):
        results.append((label, bool(ok), detail))

    # -- the default: the panel talks, the assistant does not ----------------

    r = Room().play(
        heard("So the Munich court ruled against Suno last month."),
        said(),
        said(),
        caption("That's right, the ruling was..."),
        DONE,
    )
    case("unaddressed speech is never heard", not r.spoke)
    case("...and is counted as suppressed", r.suppressed == 1)
    case(
        "...but the discussion transcript still reaches the captions",
        "Munich" in r.transcript,
    )

    r = Room().play(
        heard("The Gemini API can do this natively now."),
        said(),
        DONE,
    )
    case("a product mention does not open the gate", not r.spoke)

    # Gemini batches the last fragment of a reply together with the end of the
    # turn. Dropping the reply must not drop the boundary with it, or the
    # browser waits out a turn that already finished.
    r = Room().play(
        heard("Anyway, that was the Deezer number, not the Spotify one."),
        said(),
        {**caption("Actually the figure is..."), "turnComplete": True},
    )
    case("a held reply does not swallow the turn boundary", r.turns_closed == 1)
    case("...and the reply itself is still held", not r.spoke)
    case("...and the turn is still counted as suppressed", r.suppressed == 1)

    # -- being addressed -----------------------------------------------------

    r = Room().play(
        heard("Hey Gemini, what do you make of that?"),
        said(),
        said(),
        caption("The Munich ruling is the first European decision..."),
        DONE,
    )
    case("a wake phrase lets the answer through", r.audio_chunks == 2)
    case("...and nothing is reported as suppressed", r.suppressed == 0)

    r = Room().play(
        heard("ねえジェミニ、"),
        heard("どう思いますか？"),
        said(),
        DONE,
    )
    case("a Japanese wake phrase split across fragments still fires", r.spoke)

    r = Room().play(heard("Hey "), heard("Gemini, "), heard("thoughts?"), said(), DONE)
    case("a wake phrase split across fragments still fires", r.spoke)

    # -- the race the buffer exists for --------------------------------------
    #
    # Output can start before the transcription that arms the turn has finished
    # arriving. Held output has to be released, not dropped, or a real question
    # loses the first second of its answer.

    r = Room().play(
        said(),
        said(),
        heard("Hey Gemini, what do you think?"),
        said(),
        DONE,
    )
    case(
        "output that arrived before the arm is released, not lost",
        r.audio_chunks == 3,
        f"({r.audio_chunks} of 3 chunks)",
    )

    # -- runaway output ------------------------------------------------------

    big = GATE_BUFFER_MAX_BYTES // 2 + 1
    r = Room().play(
        heard("Anyway, moving on."), said(big), said(big), said(big), DONE
    )
    case(
        "an over-long unrequested reply is dropped, not held",
        not r.spoke and r.suppressed == 1,
    )
    r.play(heard("Hey Gemini, thoughts?"), said(), DONE)
    case(
        "...and the gate still works on the next turn",
        r.audio_chunks == 1,
    )

    # -- the moderator's button ----------------------------------------------

    clock = Clock()
    r = Room(clock)
    r.gate.arm_manual("button")
    r.play(heard("So, on the economics of this."), said(), DONE)
    case("a manual arm opens the gate with no wake phrase", r.spoke)

    clock = Clock()
    r = Room(clock)
    r.gate.arm_manual("button")
    # The moderator presses, then a beat passes with nobody addressing it, then
    # the question lands in a later turn. The arm has to survive that gap.
    r.play(heard("Um."), DONE)
    r.play(heard("Right, so what's your read on the Suno settlement?"), said(), DONE)
    case("a manual arm survives the turn boundary before the question", r.spoke)

    clock = Clock()
    r = Room(clock)
    r.gate.arm_manual("button")
    clock.advance(MANUAL_ARM_TTL_SEC + 1)
    r.play(heard("Anyway, as I was saying."), said(), DONE)
    case("a manual arm expires rather than staying open all night", not r.spoke)

    clock = Clock()
    r = Room(clock)
    r.gate.arm_manual("button")
    r.play(heard("Gemini, go ahead."), said(), DONE)
    case("the gate closes again once the question is answered", not r.gate.armed)
    r.play(heard("Right, back to the panel."), said(), DONE)
    case("...so the next unaddressed turn is silent again", r.audio_chunks == 1)

    # -- one question, one answer --------------------------------------------

    r = Room().play(heard("Hey Gemini, thoughts?"), said(), DONE)
    r.play(heard("Interesting. Anyway, on to licensing."), said(), DONE)
    case(
        "a wake phrase arms exactly one turn",
        r.audio_chunks == 1,
        f"({r.audio_chunks} answers to 1 question)",
    )
    case("the second turn is counted as suppressed", r.suppressed == 1)

    # -- session teardown ----------------------------------------------------

    r = Room()
    r.play(said(), said())
    r.gate.drop_pending()
    r.play(heard("Hey Gemini, what do you think?"), said(), DONE)
    case(
        "output held by a session that died is not replayed by its replacement",
        r.audio_chunks == 1,
    )

    # -- counters ------------------------------------------------------------

    r = Room()
    r.play(heard("Hey Gemini, thoughts?"), said(), DONE)
    r.play(heard("Nobody asked you."), said(), DONE)
    r.play(heard("Gemini, why is that?"), said(), DONE)
    case(
        "counters track answered and suppressed turns",
        (r.gate.answered_turns, r.gate.suppressed_turns) == (2, 1),
        f"({r.gate.answered_turns} answered, {r.gate.suppressed_turns} suppressed)",
    )

    print("\nOutput gate:")
    for label, ok, detail in results:
        if not check(label, ok, detail):
            failures += 1

    print(f"\n{len(results) - failures}/{len(results)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
