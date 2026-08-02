"""Panel assistant: persona, wake-phrase detection, and the discussion knowledge base."""

import csv
import os
import re
import unicodedata
from pathlib import Path

ASSISTANT_NAME = os.getenv("PANEL_ASSISTANT_NAME", "Gemini")
ASSISTANT_NAME_JA = os.getenv("PANEL_ASSISTANT_NAME_JA", "ジェミニ")
DISCUSSION_TOPIC = os.getenv("PANEL_TOPIC", "AI and music")

MODEL = os.getenv("PANEL_MODEL", "gemini-3.1-flash-live-preview")

# ---------------------------------------------------------------------------
# Wake-phrase detection
# ---------------------------------------------------------------------------
#
# This is the highest-risk component in the app, and the risk is specific: the
# panel is discussing AI and music, so they will say the word "Gemini" as a
# *product name* constantly — "the Gemini API", "Gemini can generate stems". None
# of those are an invitation to speak, and answering one means talking over a
# panellist in front of an audience.
#
# So matching the bare name is not an option. A match requires the name plus
# evidence of direct address: a vocative cue in front of it ("hey", 「ねえ」), an
# honorific behind it (「さん」), a comma, or a second-person question following
# it. The patterns below are deliberately strict — a missed wake phrase costs one
# repeat of the question, a false positive costs an interruption on stage.
#
# `tests/test_wake.py` pins the positives and, more importantly, the negatives.
# The moderator's "Ask Gemini" button arms the gate directly and always works, so
# strictness here has a manual escape hatch.

# Spellings a speech recogniser plausibly returns for the assistant's name.
_NAME_VARIANTS = [
    r"gemini",
    r"gemani",
    r"jemini",
    r"gemi ?ni",
    r"ジェミニ",
    r"ジェミナイ",
    r"ジェミニー",
    r"ジェムニ",
]
_NAME = "(?:" + "|".join(_NAME_VARIANTS) + ")"

# Vocative openers, in two strengths. A strong cue in front of the name is
# already close to conclusive — nobody says "hey Gemini" about a product. Weak
# cues are how a moderator actually hands over mid-flow ("so Gemini, what do you
# make of that"), but they are also how the name turns up in ordinary discussion
# ("Suno and Gemini both do this"), so they need firmer evidence behind the name.
_CUE_STRONG = r"(?:hey|hi|hello|ok|okay|okey|alright|all right|yo)"
_CUE_WEAK = r"(?:so|and|now|well|but)"
_CUE_JA = r"(?:ねえ|ねぇ|ね|へい|ヘイ|おい|オーケー|オッケー|よし|じゃあ|では)"

# Interrogative / imperative openings that only make sense aimed at someone.
# Note "can you" and not bare "can": "Gemini can generate stems" is a statement
# about the product, "Gemini, can you explain" is a question to the panellist.
_ASK_EN = (
    r"(?:what|how|why|who|when|where|which|do you|did you|can you|could you|"
    r"would you|will you|are you|have you|is there|any thoughts|any idea|"
    r"anything|your take|your view|your thoughts|thoughts|tell us|tell me|"
    r"give us|give me|help us|walk us|weigh in|jump in|go ahead)"
)
_ASK_JA = (
    r"(?:どう思|どうです|どうでしょ|いかが|どう見|教えて|聞かせて|意見|コメント|"
    r"何か|なにか|ありますか|お願い|説明して|どう考え)"
)

# What has to follow the name for a cue to count as address rather than mention.
# The strong form also accepts a full stop and the end of the utterance; the weak
# form does not, because "Suno and Gemini." is a list, not a hand-off.
_ADDRESSED_EN = rf"(?:\s*[,、?？!！.。]|\s*$|\s+{_ASK_EN}\b)"
_ADDRESSED_WEAK_EN = rf"(?:\s*[,、?？!！]|\s+{_ASK_EN}\b)"
_ADDRESSED_JA = rf"(?:\s*[、,?？!！]|\s*$|\s*{_ASK_JA})"

_DEFAULT_WAKE_PATTERNS = [
    # "hey Gemini", "hey Gemini, what do you make of that" — cue in front,
    # address marker behind.
    rf"\b{_CUE_STRONG}\s*[,;]?\s*{_NAME}{_ADDRESSED_EN}",
    rf"\b{_CUE_WEAK}\s*[,;]?\s*{_NAME}{_ADDRESSED_WEAK_EN}",
    rf"{_CUE_JA}\s*[、,]?\s*{_NAME}{_ADDRESSED_JA}",
    # 「ジェミニさん」「ジェミニくん」 — an honorific is direct address by itself.
    rf"{_NAME}\s*(?:さん|サン|くん|君|ちゃん)",
    # "Gemini, what do you think" — name first, then a question aimed at it.
    rf"^\W*{_NAME}\b\s*[,、]?\s*{_ASK_EN}\b",
    rf"^\W*{_NAME}\s*[、,]?\s*{_ASK_JA}",
    rf"{_NAME}\s*[、,]\s*{_ASK_JA}",
    # "... so what do you think, Gemini?" — name last. The question mark is
    # required: without it, "the other one, Gemini." is a mention, not a hand-off.
    rf"[,、]\s*{_NAME}\s*[?？]",
    # "let's ask Gemini", "over to you Gemini", 「ジェミニに聞いてみましょう」.
    # "you could ask Gemini to write a song" is a mention: "to" is not an
    # address marker, so it does not fire.
    rf"\bask\s+{_NAME}{_ADDRESSED_EN}",
    rf"\bover to you\s*,?\s*{_NAME}\b",
    rf"{_NAME}\s*に\s*(?:聞|き)い?て",
]


def _load_wake_patterns() -> list[str]:
    """Wake patterns, overridable at the venue without a code change.

    PANEL_WAKE_PATTERNS is a newline-separated list of regexes replacing the
    defaults. A live event is exactly the wrong place to discover that a
    speaker's accent defeats the built-in list, so this is tunable from the
    deploy command.
    """
    raw = os.getenv("PANEL_WAKE_PATTERNS", "").strip()
    if not raw:
        return _DEFAULT_WAKE_PATTERNS
    return [line.strip() for line in raw.splitlines() if line.strip()]


def normalize_utterance(text: str) -> str:
    """Fold an utterance to the form the wake patterns are written against.

    NFKC collapses full-width Latin (Ｇｅｍｉｎｉ, which is how a Japanese STT
    may render the name) onto ASCII, and half-width katakana onto full-width.
    Case and runs of whitespace go too; punctuation stays, because a comma is
    load-bearing evidence of address.
    """
    out = unicodedata.normalize("NFKC", text or "").lower()
    return re.sub(r"\s+", " ", out).strip()


class WakeMatcher:
    """Decides whether an utterance addresses the assistant."""

    def __init__(self, patterns: list[str] | None = None):
        self._sources = patterns if patterns is not None else _load_wake_patterns()
        self._patterns = []
        for src in self._sources:
            try:
                self._patterns.append(re.compile(src, re.IGNORECASE))
            except re.error:
                # A bad override must not take the app down mid-event; the
                # remaining patterns and the Ask button still work.
                continue

    def match(self, text: str) -> str | None:
        """Return the pattern that fired, or None if this is not an address."""
        norm = normalize_utterance(text)
        if not norm:
            return None
        for pat in self._patterns:
            if pat.search(norm):
                return pat.pattern
        return None

    def __call__(self, text: str) -> bool:
        return self.match(text) is not None


# ---------------------------------------------------------------------------
# Knowledge base
# ---------------------------------------------------------------------------

_DEFAULT_KNOWLEDGE_DIR = Path(__file__).parent.parent.parent / "knowledge" / "ai-and-music"
KNOWLEDGE_DIR = Path(os.getenv("PANEL_KNOWLEDGE_DIR", str(_DEFAULT_KNOWLEDGE_DIR)))

# The briefing is re-sent as the system instruction every time a Live session is
# reopened — roughly every nine minutes, because of GoAway — so it is trimmed
# rather than shipped whole. The research files run 30-45k characters each and
# there are ten of them; sending all of it would be ~120k tokens per reopen and
# would bury the silence rule under a wall of notes.
#
# So each file gets an equal slice of the budget, filled in the priority order
# below until the slice runs out. Equal slices matter: a greedy whole-file walk
# would spend everything on file 01 and leave the panel with nothing on Japan.
# "Key facts" is last on purpose — it is by far the largest section and the
# figures worth saying out loud are duplicated into "Numbers worth quoting".
# Sources are excluded entirely; the assistant is told never to read a URL, and
# the kept sections carry source names inline. Depth beyond this comes from
# Google Search at question time.
KNOWLEDGE_MAX_CHARS = int(os.getenv("PANEL_KNOWLEDGE_MAX_CHARS", "100000"))

# Files small enough, and central enough, to include whole.
_FULL_FILES = ("00-index.md", "09-discussion-prompts.md")

# Section titles in the order they earn their place in the briefing.
_SECTION_PRIORITY = (
    "numbers worth quoting",
    "contested / two-sided",
    "contested",
    "panel-ready questions",
    "open questions",
    "try this tonight",
    "key facts",
)

_TLDR_RE = re.compile(r"^\s*\*\*TL;DR[^*]*\*\*\s*(.+)$", re.MULTILINE)


def knowledge_files() -> list[Path]:
    """Every markdown file in the knowledge base, in filename order."""
    if not KNOWLEDGE_DIR.is_dir():
        return []
    return sorted(p for p in KNOWLEDGE_DIR.glob("*.md") if p.is_file())


def _sections(markdown: str) -> list[tuple[str, str]]:
    """Split a document into (h2 title, body) pairs, dropping the preamble."""
    out: list[tuple[str, str]] = []
    title: str | None = None
    body: list[str] = []
    for line in markdown.splitlines():
        if line.startswith("## "):
            if title is not None:
                out.append((title, "\n".join(body).strip()))
            title = line[3:].strip()
            body = []
        elif title is not None:
            body.append(line)
    if title is not None:
        out.append((title, "\n".join(body).strip()))
    return out


def _digest(path: Path, budget: int) -> str:
    """The part of one knowledge file worth carrying into every session."""
    text = path.read_text(encoding="utf-8")
    if path.name in _FULL_FILES:
        # These are the files the assistant reasons over rather than quotes
        # from, so no section outranks another and they go in document order.
        # A trailing half-section would read as a fact the assistant half-knows,
        # so the cut lands on a heading.
        if len(text) <= budget:
            return text
        head = text[: text.index("\n## ")] if "\n## " in text else ""
        kept, used = [head], len(head)
        for title, body in _sections(text):
            chunk = f"\n## {title}\n{body}\n"
            if used + len(chunk) > budget:
                break
            kept.append(chunk)
            used += len(chunk)
        return "".join(kept)

    heading = next(
        (line[2:].strip() for line in text.splitlines() if line.startswith("# ")),
        path.stem,
    )
    head = f"# {heading}\n"
    tldr = _TLDR_RE.search(text)
    if tldr:
        head += f"\n**In short:** {tldr.group(1).strip()}\n"
    used = len(head)

    by_title = {t.strip().lower(): (t, b) for t, b in _sections(text) if b}
    kept: list[str] = []
    for key in _SECTION_PRIORITY:
        found = by_title.pop(key, None)
        if not found:
            continue
        title, body = found
        chunk = f"\n## {title}\n{body}\n"
        if used + len(chunk) > budget:
            continue
        kept.append(chunk)
        used += len(chunk)

    if not kept and not tldr:
        return ""
    return head + "".join(kept)


def build_briefing(max_chars: int = KNOWLEDGE_MAX_CHARS) -> str:
    """Assemble the knowledge base into a briefing for the system instruction.

    The budget is real: this text is re-sent as the system instruction on every
    upstream reopen, and the API forces one roughly every ten minutes. The index
    and the discussion prompts go in whole because they are what the assistant
    actually reasons over; whatever is left is split evenly across the topic
    files, which get digested down to their most quotable sections.
    """
    files = knowledge_files()
    if not files:
        return ""

    full = [p for p in files if p.name in _FULL_FILES]
    rest = [p for p in files if p.name not in _FULL_FILES]

    # The whole-file group is capped at half the budget so a growing index can
    # never crowd the topic files out entirely.
    full_budget = max_chars // 2 if rest else max_chars
    per_full = full_budget // len(full) if full else 0
    digests = {p: _digest(p, per_full) for p in full}
    spent = sum(len(d) for d in digests.values())
    per_file = max(2000, (max_chars - spent) // len(rest)) if rest else 0
    for p in rest:
        digests[p] = _digest(p, per_file)

    parts = [d for p in files if (d := digests[p].strip())]
    if not parts:
        return ""
    return "\n\n---\n\n".join(parts)


# ---------------------------------------------------------------------------
# Glossary
# ---------------------------------------------------------------------------
#
# Carried over from the translator, with a different job. The pair is no longer
# source-term -> translation but written-term -> how to pronounce it, which is
# what stops the assistant saying "Suno" three different ways on stage. The
# third column is still display-only and is applied to the transcript by
# main.py's _TranscriptRewriter.

DICT_PATH = Path(__file__).parent.parent / "dict.csv"

# (term, spoken_form, display_form)
GlossaryEntry = tuple[str, str, str]


def load_default_glossary() -> list[GlossaryEntry]:
    """Read the seed glossary from dict.csv (used when a client sends none)."""
    if not DICT_PATH.exists():
        return []
    entries: list[GlossaryEntry] = []
    with open(DICT_PATH, encoding="utf-8") as f:
        for row in csv.reader(f):
            if len(row) < 2:
                continue
            src, tgt = row[0].strip(), row[1].strip()
            if not src or not tgt:
                continue
            disp = row[2].strip() if len(row) >= 3 and row[2].strip() else tgt
            entries.append((src, tgt, disp))
    return entries


def _glossary_section(entries: list[GlossaryEntry]) -> str:
    if not entries:
        return ""
    lines = "\n".join(f"- {src} → say it as: {tgt}" for src, tgt, _ in entries)
    return (
        "\n\n# Pronunciation\n"
        "When you say any of these terms aloud, use the given pronunciation. "
        "Match the term case-insensitively.\n" + lines
    )


# ---------------------------------------------------------------------------
# Voices
# ---------------------------------------------------------------------------

# The 30 prebuilt voices the Live API exposes, with the tone descriptor Google
# publishes for each.
#
# This list is a whitelist, not just UI decoration: an unknown voice name makes
# live.connect() fail with `1007 No matching speaker voice found`, and the
# reconnect loop in main.py would retry that failure forever. Everything
# arriving from a client is checked against it.
VOICES: dict[str, str] = {
    "Zephyr": "Bright",
    "Puck": "Upbeat",
    "Charon": "Informative",
    "Kore": "Firm",
    "Fenrir": "Excitable",
    "Leda": "Youthful",
    "Orus": "Firm",
    "Aoede": "Breezy",
    "Callirrhoe": "Easy-going",
    "Autonoe": "Bright",
    "Enceladus": "Breathy",
    "Iapetus": "Clear",
    "Umbriel": "Easy-going",
    "Algieba": "Smooth",
    "Despina": "Smooth",
    "Erinome": "Clear",
    "Algenib": "Gravelly",
    "Rasalgethi": "Informative",
    "Laomedeia": "Upbeat",
    "Achernar": "Soft",
    "Alnilam": "Firm",
    "Schedar": "Even",
    "Gacrux": "Mature",
    "Pulcherrima": "Forward",
    "Achird": "Friendly",
    "Zubenelgenubi": "Casual",
    "Vindemiatrix": "Gentle",
    "Sadachbia": "Lively",
    "Sadaltager": "Knowledgeable",
    "Sulafat": "Warm",
}

# Informative rather than upbeat: this one is answering questions on a panel,
# not hosting. Overridable, and the UI exposes the full list.
DEFAULT_VOICE = os.getenv("PANEL_VOICE", "Charon")


def resolve_voice(name: str | None) -> str:
    """Return *name* if it is a known voice, else DEFAULT_VOICE.

    Matched case-insensitively so a differently-cased value from a client still
    resolves to the canonical spelling the API expects.
    """
    if not name:
        return DEFAULT_VOICE
    for voice in VOICES:
        if voice.lower() == name.strip().lower():
            return voice
    return DEFAULT_VOICE if DEFAULT_VOICE in VOICES else "Puck"


# ---------------------------------------------------------------------------
# System instruction
# ---------------------------------------------------------------------------

# The assistant's answers come out of the room's speakers and go straight back
# into the panel microphones. Unlike a translator it is not at risk of a runaway
# loop — it is silent by default, and the output gate in main.py drops anything
# it says unprompted — but it can still mistake its own returning voice for a
# panellist addressing it.
_ECHO_GUARD = (
    "Your own voice is played through the room's speakers and the microphones "
    "will pick it up again. If you hear your own answer coming back, ignore it "
    "completely. Never respond to yourself, and never treat your own words as a "
    "question from the panel."
)

_SILENCE_RULE = """# The one rule that matters

You are a listener. The humans on this panel are the event; you are not.

You will hear the entire discussion, continuously. Do NOT respond to it. No
speech, no acknowledgement, no "mm-hmm", no summary, no offer to help — nothing
at all — unless the panel has just addressed you directly, by name.

Being addressed sounds like:
- "Hey {name}, what do you make of that?"
- "{name}, do you have a view on this?"
- "Let's ask {name}."
- 「ねえ{name_ja}、どう思う?」
- 「{name_ja}さん、意見を聞かせてください」

Someone merely *mentioning* your name is NOT an invitation to speak. This panel
is about {topic} and they will discuss Gemini the product, Gemini the model, and
Google's Gemini models at length. "The Gemini API supports this", "Gemini can
generate stems", "we built it on Gemini" — say nothing. Keep listening.

If you are not certain you were addressed, stay silent. Silence costs the panel
one repeated question. A wrong guess talks over a speaker in front of a live
audience. Those are not the same mistake, so always err towards silence."""

_ANSWER_RULE = """# When you are addressed

- Answer in the language of the question. English question, English answer.
  日本語で聞かれたら、日本語で答えてください。Match the questioner, not the
  language of your notes.
- Keep it to 20-40 seconds of speech. Three or four sentences. This is live
  radio, not an essay, and the panel needs the floor back.
- Be concrete. Name the company, the model, the lawsuit, the number, the year.
  A vague answer wastes the panel's time and is worse than a short one.
- Have an actual view. You were invited as a panellist, not as a search engine.
  Say what you think, then give the strongest argument against it. Disagreement
  is the point of a panel.
- Never read a URL aloud. Name the source instead: "the US Copyright Office
  report from January 2025", "Deezer's own figures".
- If you do not know, say so in one sentence, and say what would settle it.
- Start with the answer. No thanks, no preamble, no restating the question, no
  "that's a great question".
- Stop cleanly when you are done. Do not trail off into offers of further help,
  and do not ask the panel a question back unless it is genuinely the point."""

_TOPIC_RULE = """# When you are asked for a discussion topic

Give exactly one topic, not a list. Frame it as a question that would split this
panel, add one sentence on why it is live right now, then hand it straight back
to the moderator and stop.

Prefer a topic where you can already hear two credible answers. Avoid anything
the panel has already covered in this session. Draw on the discussion prompts in
your briefing, but tailor the wording to what these panellists have actually
been arguing about."""

_TOOL_RULE = """# Tools

You have Google Search. Use it when the question turns on something recent, on a
figure you are not confident of, or on anything your briefing marks as
unverified or open. Do not narrate the search — just answer, and name the source
in passing. Do not use it for questions of opinion or interpretation; those are
yours to answer."""


def build_panel_instruction(
    glossary_entries: list[GlossaryEntry] | None = None,
    briefing: str | None = None,
    topic: str = DISCUSSION_TOPIC,
    name: str = ASSISTANT_NAME,
    name_ja: str = ASSISTANT_NAME_JA,
) -> str:
    """Build the system instruction for the panel assistant."""
    entries = (
        glossary_entries if glossary_entries is not None else load_default_glossary()
    )
    brief = build_briefing() if briefing is None else briefing

    head = (
        f"You are {name}, an AI panellist sitting in on a live, on-stage panel "
        f"discussion about {topic}, alongside several human panellists and in "
        f"front of an audience. You listen to all of it and you speak rarely.\n\n"
    )
    body = "\n\n".join(
        [
            _SILENCE_RULE.format(name=name, name_ja=name_ja, topic=topic),
            _ANSWER_RULE,
            _TOPIC_RULE,
            _TOOL_RULE,
            "# Echo\n" + _ECHO_GUARD,
        ]
    )
    tail = _glossary_section(entries)
    if brief:
        tail += (
            "\n\n# Your briefing\n"
            "Research prepared for this panel. Prefer it over your own recall, "
            "and quote its dates and numbers when they help. It is not "
            "exhaustive — reach for Google Search when it runs out.\n\n"
            + brief
        )
    return head + body + tail


# Injected as a text turn (send_realtime_input) when the moderator presses
# "Suggest a topic". The gate is armed alongside it, so this is one of the few
# things that reliably makes the assistant speak.
TOPIC_SUGGESTION_PROMPT = (
    "[The moderator is asking you, out of band, for one discussion topic to put "
    "to the panel now. Follow your topic rule: one question that would split "
    "this panel, one sentence of context, then stop. Base it on what the panel "
    "has been discussing so far in this session. Answer in the language the "
    "panel has mostly been speaking.]"
)
