"""Offline check that glossary display replacement survives fragment boundaries.

The Live API streams the translated transcript in small increments and the
browser appends them, so a term split across increments used to slip past the
replacement. These cases replay recorded and synthetic fragment sequences
through the relay's rewriter and assert the text the browser ends up with.

Run: uv run python tests/test_glossary.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import _TranscriptRewriter, _build_display_map  # noqa: E402

# (source, target, display) triples, the shape `_parse_setup` hands the relay.
GLOSSARY = [
    ("Kubernetes", "クバネティス", "Kubernetes"),
    ("WebSocket", "ウェブソケット", "WebSocket"),
    ("PostgreSQL", "ポストグレスキューエル", "PostgreSQL"),
]


def replay(fragments: list[tuple[str, bool]], turn_complete: bool = True) -> str:
    """Feed fragments through the rewriter and return what the browser accumulates.

    Mirrors app.js: a partial appends, a `finished` message replaces everything.
    """
    rewriter = _TranscriptRewriter(_build_display_map(GLOSSARY))
    shown = ""
    for text, finished in fragments:
        if finished:
            shown = rewriter.supersede(text)
        else:
            shown += rewriter.feed(text)
    if turn_complete:
        shown += rewriter.flush()
    return shown


CASES: list[tuple[str, list[tuple[str, bool]], str]] = [
    (
        # Captured from a live run: the term arrives split three ways and the
        # turn carries no `finished` message at all.
        "term split across three partials, no finished message",
        [("コンテナ化されたアプリケーション", False), ("をク", False),
         ("バネティ", False), ("スに", False), ("移行しています。", False)],
        "コンテナ化されたアプリケーションをKubernetesに移行しています。",
    ),
    (
        "term whole inside one partial (the case that already worked)",
        [("アプリを", False), ("クバネティス", False), ("に移行。", False)],
        "アプリをKubernetesに移行。",
    ),
    (
        "term split one character at a time",
        [(c, False) for c in "クバネティスを使う"],
        "Kubernetesを使う",
    ),
    (
        "two different terms, both split",
        [("ウェ", False), ("ブソケットと", False), ("ポストグレス", False),
         ("キューエルを使う", False)],
        "WebSocketとPostgreSQLを使う",
    ),
    (
        "finished message replaces the accumulated partials",
        [("をク", False), ("バネティ", False),
         ("クバネティスに移行しています。", True)],
        "Kubernetesに移行しています。",
    ),
    (
        # A held tail must not be swallowed when the term never completes.
        "trailing prefix that never becomes a term is released on turnComplete",
        [("クリッ", False), ("ク", False)],
        "クリック",
    ),
    (
        "no glossary term at all passes through untouched",
        [("おはようございます。", False), ("旅はどうでしたか?", False)],
        "おはようございます。旅はどうでしたか?",
    ),
]


def main() -> int:
    failures = 0
    for name, fragments, expected in CASES:
        got = replay(fragments)
        ok = got == expected
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
        if not ok:
            failures += 1
            print(f"      expected {expected!r}")
            print(f"      got      {got!r}")

    # A turn cut short by a session swap never reports itself complete, so
    # nothing may be left stranded mid-stream waiting for a boundary.
    got = replay(CASES[0][1], turn_complete=False)
    ok = got == CASES[0][2]
    print(f"{'PASS' if ok else 'FAIL'}  same sequence with no turnComplete to flush on")
    if not ok:
        failures += 1
        print(f"      expected {CASES[0][2]!r}")
        print(f"      got      {got!r}")

    print(f"\n{len(CASES) + 1 - failures}/{len(CASES) + 1} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
