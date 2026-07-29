"""Translator system instruction + glossary helpers."""

import csv
import os
from pathlib import Path

POPULAR_LANGUAGES = ["en", "ja", "zh", "es", "fr", "de", "pt", "ko", "hi", "ar"]

LANGUAGES = {
    "af": "Afrikaans",
    "ak": "Akan",
    "sq": "Albanian (Shqip)",
    "am": "Amharic (አማርኛ)",
    "ar": "Arabic (العربية)",
    "hy": "Armenian (Հայերեն)",
    "as": "Assamese (অসমীয়া)",
    "az": "Azerbaijani (Azərbaycan)",
    "eu": "Basque (Euskara)",
    "be": "Belarusian (Беларуская)",
    "bn": "Bengali (বাংলা)",
    "bs": "Bosnian (Bosanski)",
    "bg": "Bulgarian (Български)",
    "my": "Burmese (မြန်မာ)",
    "ca": "Catalan (Català)",
    "ceb": "Cebuano",
    "zh": "Chinese (中文)",
    "hr": "Croatian (Hrvatski)",
    "cs": "Czech (Čeština)",
    "da": "Danish (Dansk)",
    "nl": "Dutch (Nederlands)",
    "en": "English",
    "et": "Estonian (Eesti)",
    "fo": "Faroese (Føroyskt)",
    "fil": "Filipino",
    "fi": "Finnish (Suomi)",
    "fr": "French (Français)",
    "gl": "Galician (Galego)",
    "ka": "Georgian (ქართული)",
    "de": "German (Deutsch)",
    "el": "Greek (Ελληνικά)",
    "gu": "Gujarati (ગુજરાતી)",
    "ha": "Hausa",
    "iw": "Hebrew (עברית)",
    "hi": "Hindi (हिन्दी)",
    "hu": "Hungarian (Magyar)",
    "is": "Icelandic (Íslenska)",
    "id": "Indonesian (Bahasa Indonesia)",
    "ga": "Irish (Gaeilge)",
    "it": "Italian (Italiano)",
    "ja": "Japanese (日本語)",
    "kn": "Kannada (ಕನ್ನಡ)",
    "kk": "Kazakh (Қазақ)",
    "km": "Khmer (ខ្មែរ)",
    "rw": "Kinyarwanda",
    "ko": "Korean (한국어)",
    "ku": "Kurdish (Kurdî)",
    "ky": "Kyrgyz (Кыргызча)",
    "lo": "Lao (ລາວ)",
    "lv": "Latvian (Latviešu)",
    "lt": "Lithuanian (Lietuvių)",
    "mk": "Macedonian (Македонски)",
    "ms": "Malay (Bahasa Melayu)",
    "ml": "Malayalam (മലയാളം)",
    "mt": "Maltese (Malti)",
    "mi": "Maori (Māori)",
    "mr": "Marathi (मराठी)",
    "mn": "Mongolian (Монгол)",
    "ne": "Nepali (नेपाली)",
    "no": "Norwegian (Norsk)",
    "or": "Odia (ଓଡ଼ିଆ)",
    "om": "Oromo",
    "ps": "Pashto (پښتو)",
    "fa": "Persian (فارسی)",
    "pl": "Polish (Polski)",
    "pt": "Portuguese (Português)",
    "pa": "Punjabi (ਪੰਜਾਬੀ)",
    "qu": "Quechua",
    "ro": "Romanian (Română)",
    "rm": "Romansh (Rumantsch)",
    "ru": "Russian (Русский)",
    "sr": "Serbian (Српски)",
    "sd": "Sindhi (سنڌي)",
    "si": "Sinhala (සිංහල)",
    "sk": "Slovak (Slovenčina)",
    "sl": "Slovenian (Slovenščina)",
    "so": "Somali",
    "st": "Southern Sotho (Sesotho)",
    "es": "Spanish (Español)",
    "sw": "Swahili (Kiswahili)",
    "sv": "Swedish (Svenska)",
    "tg": "Tajik (Тоҷикӣ)",
    "ta": "Tamil (தமிழ்)",
    "te": "Telugu (తెలుగు)",
    "th": "Thai (ไทย)",
    "tn": "Tswana (Setswana)",
    "tr": "Turkish (Türkçe)",
    "tk": "Turkmen (Türkmen)",
    "uk": "Ukrainian (Українська)",
    "ur": "Urdu (اردو)",
    "uz": "Uzbek (Oʻzbek)",
    "vi": "Vietnamese (Tiếng Việt)",
    "cy": "Welsh (Cymraeg)",
    "fy": "Western Frisian (Frysk)",
    "wo": "Wolof",
    "yo": "Yoruba (Yorùbá)",
    "zu": "Zulu (isiZulu)",
}

DICT_PATH = Path(__file__).parent.parent / "dict.csv"

# Glossary entry: (source, target_spoken, transcription_display).
# - source: the term in the source language the model should listen for
# - target_spoken: how the model should pronounce it (drives the audio + the
#   model's own output transcription)
# - transcription_display: how the frontend should render it in the on-screen
#   transcript. Defaults to target_spoken when absent. Server-side this column
#   is purely round-tripped — only source + target_spoken affect the model.
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
    lines = "\n".join(f"- {src} → {tgt}" for src, tgt, _ in entries)
    return (
        "\n\nUse the following glossary for specific terms. Match the source "
        "term case-insensitively (e.g. \"kubernetes\", \"Kubernetes\", and "
        "\"KUBERNETES\" all match a \"Kubernetes\" entry). When you hear any "
        "of these terms, always use the paired translation:\n"
        + lines
    )


MODEL = os.getenv("DEMO_AGENT_MODEL", "gemini-3.1-flash-live-preview")
SIMUL_MODEL = "gemini-3.5-live-translate-preview"

# The 30 prebuilt voices the Live API exposes, with the tone descriptor Google
# publishes for each. Both MODEL and SIMUL_MODEL accept any of them.
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

# The Live API's own default when no speech_config is supplied.
DEFAULT_VOICE = "Puck"


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
    return DEFAULT_VOICE

SIMUL_LANGUAGES = {
    "af": "Afrikaans",
    "ak": "Akan",
    "sq": "Albanian (Shqip)",
    "am": "Amharic (አማርኛ)",
    "ar": "Arabic (العربية)",
    "hy": "Armenian (Հայերեն)",
    "az": "Azerbaijani (Azərbaycan)",
    "eu": "Basque (Euskara)",
    "be": "Belarusian (Беларуская)",
    "bn": "Bengali (বাংলা)",
    "bg": "Bulgarian (Български)",
    "my": "Burmese (မြန်မာ)",
    "ca": "Catalan (Català)",
    "zh-Hans": "Chinese Simplified (简体中文)",
    "zh-Hant": "Chinese Traditional (繁體中文)",
    "hr": "Croatian (Hrvatski)",
    "cs": "Czech (Čeština)",
    "da": "Danish (Dansk)",
    "nl": "Dutch (Nederlands)",
    "en": "English",
    "et": "Estonian (Eesti)",
    "fil": "Filipino",
    "fi": "Finnish (Suomi)",
    "fr": "French (Français)",
    "gl": "Galician (Galego)",
    "ka": "Georgian (ქართული)",
    "de": "German (Deutsch)",
    "el": "Greek (Ελληνικά)",
    "gu": "Gujarati (ગુજરાતી)",
    "ha": "Hausa",
    "he": "Hebrew (עברית)",
    "hi": "Hindi (हिन्दी)",
    "hu": "Hungarian (Magyar)",
    "is": "Icelandic (Íslenska)",
    "id": "Indonesian (Bahasa Indonesia)",
    "it": "Italian (Italiano)",
    "ja": "Japanese (日本語)",
    "jv": "Javanese (Basa Jawa)",
    "kn": "Kannada (ಕನ್ನಡ)",
    "kk": "Kazakh (Қазақ)",
    "km": "Khmer (ខ្មែរ)",
    "rw": "Kinyarwanda",
    "ko": "Korean (한국어)",
    "lo": "Lao (ລາວ)",
    "lv": "Latvian (Latviešu)",
    "lt": "Lithuanian (Lietuvių)",
    "mk": "Macedonian (Македонски)",
    "ms": "Malay (Bahasa Melayu)",
    "ml": "Malayalam (മലയാളം)",
    "mr": "Marathi (मराठी)",
    "mn": "Mongolian (Монгол)",
    "ne": "Nepali (नेपाली)",
    "no": "Norwegian (Norsk)",
    "fa": "Persian (فارسی)",
    "pl": "Polish (Polski)",
    "pt-BR": "Portuguese - Brazil (Português)",
    "pt-PT": "Portuguese - Portugal (Português)",
    "pa": "Punjabi (ਪੰਜਾਬੀ)",
    "ro": "Romanian (Română)",
    "ru": "Russian (Русский)",
    "sr": "Serbian (Српски)",
    "sd": "Sindhi (سنڌي)",
    "si": "Sinhala (සිංහල)",
    "sk": "Slovak (Slovenčina)",
    "sl": "Slovenian (Slovenščina)",
    "es": "Spanish (Español)",
    "su": "Sundanese (Basa Sunda)",
    "sw": "Swahili (Kiswahili)",
    "sv": "Swedish (Svenska)",
    "ta": "Tamil (தமிழ்)",
    "te": "Telugu (తెలుగు)",
    "th": "Thai (ไทย)",
    "tr": "Turkish (Türkçe)",
    "uk": "Ukrainian (Українська)",
    "ur": "Urdu (اردو)",
    "uz": "Uzbek (Oʻzbek)",
    "vi": "Vietnamese (Tiếng Việt)",
    "zu": "Zulu (isiZulu)",
}

SIMUL_POPULAR_LANGUAGES = [
    "en", "ja", "zh-Hans", "es", "fr", "de", "pt-BR", "ko", "hi", "ar",
]

_SIMUL_CODE_MAP = {
    "iw": "he",
    "zh": "zh-Hans",
    "pt": "pt-BR",
}


def simul_language_code(code: str) -> str:
    """Map internal language codes to BCP-47 codes for the Live Translate API."""
    return _SIMUL_CODE_MAP.get(code, code)


def build_system_instruction(
    source_lang: str = "en",
    target_lang: str = "ja",
    glossary_entries: list[GlossaryEntry] | None = None,
) -> str:
    """Build the translator system instruction for the given language pair and glossary."""
    source_name = LANGUAGES.get(source_lang, source_lang)
    target_name = LANGUAGES.get(target_lang, target_lang)
    entries = (
        glossary_entries if glossary_entries is not None else load_default_glossary()
    )
    return (
        f"You are a real-time translator from {source_name} to {target_name}. "
        f"Listen to the incoming audio and immediately output the translated "
        f"version in {target_name}, maintaining the speaker's original tone "
        f"and urgency. "
        f"Translate only the current utterance. Do not repeat, reference, or "
        f"prepend translations from previous turns. Each spoken segment should "
        f"produce exactly one translation of that segment and nothing else."
        + _glossary_section(entries)
    )


def _glossary_section_bidi(entries: list[GlossaryEntry]) -> str:
    if not entries:
        return ""
    lines = "\n".join(f"- {src} ↔ {tgt}" for src, tgt, _ in entries)
    return (
        "\n\nUse the following glossary for specific terms, in either direction. "
        "Match each term case-insensitively; whenever you hear one side of a pair, "
        "always render it as the other side in your translation:\n" + lines
    )


def build_conversation_instruction(
    lang_a: str = "en",
    lang_b: str = "ja",
    glossary_entries: list[GlossaryEntry] | None = None,
) -> str:
    """Build a bidirectional interpreter instruction for a two-person conversation.

    Unlike the one-way translator, the model auto-detects which of the two
    languages each utterance is in and speaks the translation in the *other*
    language, so both speakers hear each other through the interpreter.
    """
    a = LANGUAGES.get(lang_a, lang_a)
    b = LANGUAGES.get(lang_b, lang_b)
    entries = (
        glossary_entries if glossary_entries is not None else load_default_glossary()
    )
    return (
        f"You are a real-time interpreter for a live, two-way conversation between "
        f"a {a} speaker and a {b} speaker. For every utterance, first detect which "
        f"of the two languages it is spoken in, then speak the translation in the "
        f"OTHER language:\n"
        f"- If the utterance is in {a}, translate it into {b}.\n"
        f"- If the utterance is in {b}, translate it into {a}.\n"
        f"Speak naturally as their interpreter, preserving the speaker's original "
        f"tone and urgency. "
        f"Translate only the current utterance. Do not repeat, reference, or prepend "
        f"translations from previous turns. Each spoken segment should produce exactly "
        f"one translation of that segment and nothing else. Never translate into the "
        f"same language the utterance was spoken in, and never echo the original."
        + _glossary_section_bidi(entries)
    )
