"""Panel assistant package — persona, wake-phrase gating, knowledge base, voices."""

from .agent import (
    ASSISTANT_NAME,
    ASSISTANT_NAME_JA,
    DEFAULT_VOICE,
    DISCUSSION_TOPIC,
    KNOWLEDGE_DIR,
    MODEL,
    TOPIC_SUGGESTION_PROMPT,
    VOICES,
    WakeMatcher,
    build_briefing,
    build_panel_instruction,
    knowledge_files,
    load_default_glossary,
    normalize_utterance,
    resolve_voice,
)

__all__ = [
    "ASSISTANT_NAME",
    "ASSISTANT_NAME_JA",
    "DEFAULT_VOICE",
    "DISCUSSION_TOPIC",
    "KNOWLEDGE_DIR",
    "MODEL",
    "TOPIC_SUGGESTION_PROMPT",
    "VOICES",
    "WakeMatcher",
    "build_briefing",
    "build_panel_instruction",
    "knowledge_files",
    "load_default_glossary",
    "normalize_utterance",
    "resolve_voice",
]
