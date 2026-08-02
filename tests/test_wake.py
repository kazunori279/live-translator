"""Offline check that the assistant wakes when addressed and stays silent otherwise.

The negatives matter more than the positives. This panel discusses AI and music,
so "Gemini" gets said out loud as a product name dozens of times an hour. A
missed wake phrase costs one repeated question; a false positive talks over a
panellist in front of a live audience. Every case below is a line somebody could
plausibly say on that stage.

Run: uv run python tests/test_wake.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.panel_agent.agent import (  # noqa: E402
    WakeMatcher,
    build_briefing,
    build_panel_instruction,
    normalize_utterance,
)

WAKE = WakeMatcher()

# --------------------------------------------------------------------------
# The panel is handing the floor to the assistant.
# --------------------------------------------------------------------------

ADDRESSED = [
    # The canonical form.
    "Hey Gemini, what do you think about that?",
    "hey gemini",
    "Hey Gemini.",
    "Hi Gemini, do you have a view?",
    "Hello Gemini, can you help us here?",
    "OK Gemini, why is that the case?",
    "Okay Gemini, what's your take?",
    "Alright Gemini, weigh in.",
    # Mid-flow hand-off on a weak cue.
    "so Gemini, what do you make of the Suno settlement?",
    "So Gemini, thoughts?",
    "and Gemini, how would you frame that?",
    "Well Gemini, do you agree?",
    # Name first, question behind, no cue at all.
    "Gemini, what do you think?",
    "Gemini, do you buy that argument?",
    "Gemini what's your view on the Munich ruling?",
    "Gemini, tell us about the Udio settlement.",
    "Gemini, any thoughts?",
    "Gemini, give us a number on that.",
    # Name last.
    "So what do you think about all this, Gemini?",
    "Is that fair, Gemini?",
    "over to you Gemini",
    "Over to you, Gemini.",
    # Third-person hand-off.
    "Let's ask Gemini.",
    "Maybe we should ask Gemini, actually.",
    # Japanese.
    "ねえジェミニ、どう思う？",
    "ねぇジェミニ、意見を聞かせて",
    "ヘイジェミニ",
    "ジェミニさん、どう思いますか",
    "ジェミニさん",
    "ジェミニくん、コメントある？",
    "ジェミニ、どう思いますか？",
    "ジェミニ、教えてください",
    "ジェミニ、何かありますか",
    "じゃあジェミニ、どうでしょうか",
    "ジェミニに聞いてみましょう",
    # Speech-recogniser noise: variant spellings, full-width Latin.
    "Hey Jemini, what do you think?",
    "hey Gemani, thoughts?",
    "ヘイ、ジェミナイ、どう思う？",
    "Ｈｅｙ　Ｇｅｍｉｎｉ、どう思いますか",
]

# --------------------------------------------------------------------------
# The panel is talking *about* Gemini, not *to* it. Silence is the only correct
# behaviour for every line here.
# --------------------------------------------------------------------------

NOT_ADDRESSED = [
    "The Gemini API is really good at this.",
    "Google's Gemini models can generate music now.",
    "We built the whole thing on Gemini.",
    "Gemini can generate stems these days.",
    "Gemini is a multimodal model, so it handles audio natively.",
    "I use Gemini every single day for this kind of thing.",
    "Suno and Gemini both do this, but differently.",
    "You could ask Gemini to write a song for you.",
    "Compare that to Gemini or GPT.",
    "Lyria is the music model, Gemini is the general one.",
    "There's Suno, there's Udio, there's Gemini.",
    "That's the thing about Gemini.",
    "Gemini 3.1 Flash shipped with a live audio mode.",
    "The interesting one is Gemini.",
    "It runs on Gemini, and the latency is about 600 milliseconds.",
    # Japanese product mentions.
    "ジェミニのモデルは音楽も生成できます",
    "ジェミニは音楽を生成できますね",
    "スノとジェミニを比較すると",
    "ジェミニのAPIはとても速いです",
    # Ordinary discussion, no name at all.
    "The Munich court ruled against Suno on the 31st of July.",
    "Deezer says ninety thousand AI tracks a day.",
    "どう思いますか、皆さん",
    "",
    "   ",
]


def check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    return ok


def main() -> int:
    failures = 0

    print("\nAddressed — must wake:")
    for text in ADDRESSED:
        if not check(repr(text), WAKE(text)):
            failures += 1

    print("\nMentioned only — must stay silent:")
    for text in NOT_ADDRESSED:
        fired = WAKE.match(text)
        detail = f"(fired on {fired})" if fired else ""
        if not check(repr(text), fired is None, detail):
            failures += 1

    print("\nNormalisation:")
    cases = [
        (
            "folds full-width and case",
            normalize_utterance("Ｈｅｙ　ＧＥＭＩＮＩ") == "hey gemini",
        ),
        (
            "collapses whitespace",
            normalize_utterance("  hey\n\n  gemini  ") == "hey gemini",
        ),
        (
            # A comma is load-bearing evidence of address, so it has to survive.
            "keeps punctuation",
            "," in normalize_utterance("Gemini, what do you think?"),
        ),
    ]
    for label, ok in cases:
        if not check(label, ok):
            failures += 1

    print("\nPattern overrides:")
    only = WakeMatcher([r"\bcomputer\b"])
    if not check(
        "custom patterns replace the defaults",
        only("computer, what do you think?") and not only("hey gemini, thoughts?"),
    ):
        failures += 1
    # A bad PANEL_WAKE_PATTERNS override must not take the app down mid-event.
    tolerant = WakeMatcher([r"[unclosed", r"\bhey gemini\b"])
    if not check("an invalid pattern is skipped, not fatal", tolerant("hey gemini")):
        failures += 1

    print("\nBriefing and instruction:")
    briefing = build_briefing(max_chars=40000)
    if not check(
        "briefing respects its budget",
        len(briefing) <= 44000,
        f"({len(briefing)} chars)",
    ):
        failures += 1

    inst = build_panel_instruction(glossary_entries=[], briefing="")
    checks = [
        ("instruction opens on the silence rule", "listener" in inst[:1500]),
        (
            # The briefing must never push the silence rule down the page.
            "silence rule precedes the answering rules",
            inst.index("stay silent") < inst.index("# When you are addressed"),
        ),
        (
            "briefing is carried through",
            "ACME FACT 42"
            in build_panel_instruction(glossary_entries=[], briefing="ACME FACT 42"),
        ),
        (
            "glossary becomes pronunciation guidance",
            "# Pronunciation"
            in build_panel_instruction(
                glossary_entries=[("Suno", "スーノ", "Suno")], briefing=""
            ),
        ),
    ]
    for label, ok in checks:
        if not check(label, ok):
            failures += 1

    total = len(ADDRESSED) + len(NOT_ADDRESSED) + len(cases) + 2 + 1 + len(checks)
    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
