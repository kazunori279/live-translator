"""Translator package — system instruction + glossary helpers."""

from .agent import (
    DEFAULT_VOICE,
    LANGUAGES,
    MODEL,
    POPULAR_LANGUAGES,
    SIMUL_LANGUAGES,
    SIMUL_MODEL,
    SIMUL_POPULAR_LANGUAGES,
    VOICES,
    build_conversation_instruction,
    build_system_instruction,
    load_default_glossary,
    resolve_voice,
    simul_language_code,
)

__all__ = [
    "DEFAULT_VOICE",
    "LANGUAGES",
    "MODEL",
    "POPULAR_LANGUAGES",
    "SIMUL_LANGUAGES",
    "SIMUL_MODEL",
    "SIMUL_POPULAR_LANGUAGES",
    "VOICES",
    "build_conversation_instruction",
    "build_system_instruction",
    "load_default_glossary",
    "resolve_voice",
    "simul_language_code",
]
