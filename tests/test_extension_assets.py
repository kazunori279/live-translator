"""Offline checks that the Chrome extension's bundled assets have not drifted.

Manifest V3 forbids loading remote code, so the extension cannot pull the audio
worklets off the relay the way the web app does — it ships its own copies. Two
copies of a file is two files that can diverge, and the failure mode is silent:
the extension keeps working with a stale processor until someone notices the
audio is wrong. The first check makes that divergence loud.

The rest of the file walks every relative path the extension references — from
the manifest, from HTML tags, from ES imports, and from the handful of runtime
string literals (`addModule`, `executeScript` files, the offscreen URL) — and
asserts each one resolves. Chrome reports a bad path as a blank side panel or a
worklet that never registers, neither of which points at the typo.

Run: uv run python tests/test_extension_assets.py
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
WEB_JS = ROOT / "app" / "static" / "js"

# Files the extension carries a private copy of, and the original each tracks.
MIRRORED = ["pcm-recorder-processor.js", "pcm-player-processor.js"]

# Everything the extension cannot function without, whatever else changes.
REQUIRED_PERMISSIONS = {
    "tabCapture",  # the reason this extension exists
    "offscreen",  # the only context that outlives the service worker
    "sidePanel",
    "storage",
    "activeTab",  # captions are injected under this rather than <all_urls>
    "scripting",
    "audioCapture",  # microphone without a prompt the offscreen doc cannot show
}

ASSET_SUFFIXES = (".js", ".css", ".html", ".png")

# Quoted relative paths, in HTML attributes and in JS strings alike. Absolute
# URLs and chrome-extension:// URLs are excluded by the leading-scheme guard.
PATH_RE = re.compile(r"""["'](?!\w+:|//|#)([\w./-]+\.(?:js|css|html|png))["']""")


def check(results: list[tuple[bool, str]], ok: bool, label: str, detail: str = "") -> None:
    results.append((ok, label))
    print(f"{'PASS' if ok else 'FAIL'}  {label}")
    if not ok and detail:
        print(f"      {detail}")


def check_worklets(results: list[tuple[bool, str]]) -> None:
    for name in MIRRORED:
        copy = EXT / "audio" / name
        original = WEB_JS / name
        label = f"extension/audio/{name} matches app/static/js/{name}"
        if not copy.exists():
            check(results, False, label, "the extension's copy is missing")
            continue
        same = copy.read_bytes() == original.read_bytes()
        check(
            results,
            same,
            label,
            f"copies have diverged — re-copy with: cp {original.relative_to(ROOT)} "
            f"{copy.relative_to(ROOT)}",
        )


def check_manifest(results: list[tuple[bool, str]]) -> dict:
    manifest = json.loads((EXT / "manifest.json").read_text())
    check(results, manifest.get("manifest_version") == 3, "manifest is v3")

    missing = REQUIRED_PERMISSIONS - set(manifest.get("permissions", []))
    check(
        results,
        not missing,
        "manifest declares every required permission",
        f"missing: {sorted(missing)}",
    )

    # `getMediaStreamId({targetTabId})` from a service worker is Chrome 116+;
    # without the floor the extension installs and then fails at Start.
    floor = int(manifest.get("minimum_chrome_version", "0").split(".")[0])
    check(
        results,
        floor >= 116,
        "minimum_chrome_version covers tabCapture from a service worker",
        f"declared {floor}, need 116+",
    )

    # A host permission baked into the manifest would be a permanent grant to
    # every site; the backend URL is configurable, so it is asked for at Start.
    check(
        results,
        not manifest.get("host_permissions"),
        "no install-time host permissions (the backend origin is optional)",
        f"found: {manifest.get('host_permissions')}",
    )
    check(
        results,
        bool(manifest.get("optional_host_permissions")),
        "the backend origin is declared as an optional host permission",
    )
    return manifest


def manifest_paths(manifest: dict) -> list[str]:
    """Every file path the manifest points at, flattened."""
    paths = []
    sw = manifest.get("background", {}).get("service_worker")
    if sw:
        paths.append(sw)
    panel = manifest.get("side_panel", {}).get("default_path")
    if panel:
        paths.append(panel)
    if manifest.get("options_page"):
        paths.append(manifest["options_page"])
    paths.extend(manifest.get("icons", {}).values())
    paths.extend(manifest.get("action", {}).get("default_icon", {}).values())
    for entry in manifest.get("web_accessible_resources", []):
        paths.extend(entry.get("resources", []))
    return paths


def resolve(reference: str, source: Path) -> Path | None:
    """Where a referenced path lands, or None if it lands nowhere.

    ES imports are relative to the importing file; manifest entries, worklet
    `addModule` calls and `executeScript` file lists are relative to the
    extension root. A bare path is tried both ways rather than guessed at.
    """
    candidates = (
        [source.parent / reference]
        if reference.startswith((".", ".."))
        else [EXT / reference, source.parent / reference]
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def check_references(results: list[tuple[bool, str]], manifest: dict) -> None:
    broken: list[str] = []
    checked = 0

    for reference in manifest_paths(manifest):
        checked += 1
        if not (EXT / reference).exists():
            broken.append(f"manifest.json -> {reference}")

    for source in sorted(EXT.rglob("*")):
        if source.suffix not in (".js", ".html") or not source.is_file():
            continue
        for reference in set(PATH_RE.findall(source.read_text())):
            checked += 1
            if resolve(reference, source) is None:
                broken.append(f"{source.relative_to(ROOT)} -> {reference}")

    check(
        results,
        not broken,
        f"all {checked} referenced asset paths resolve",
        "unresolved:\n      " + "\n      ".join(sorted(broken)),
    )


def main() -> int:
    results: list[tuple[bool, str]] = []
    check_worklets(results)
    manifest = check_manifest(results)
    check_references(results, manifest)

    passed = sum(1 for ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
