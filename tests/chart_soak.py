"""Render soak-test distributions as bar charts, one mode or two side by side.

`test_long.py` writes a `.report` file per run with a histogram per metric. This
reads those back and draws them as bars, which makes a two-mode comparison
legible in a way that reading two reports in sequence is not.

Run:
    uv run python tests/chart_soak.py soak_convo_prod.report
    uv run python tests/chart_soak.py soak_convo_prod.report soak_simul_prod.report
    uv run python tests/chart_soak.py a.report b.report --labels convo simul \
        --metrics "Translation Score" "Turn Complete"
"""

import argparse
import re
from pathlib import Path

WIDTH = 22
FILL = "█"
EMPTY = "·"

# `Turn Complete (speech-end to full translation) (n=200)` — the metric name
# itself contains parens, so anchor on the trailing (n=...) and take the rest.
_HEADER = re.compile(r"^  (.+?)\s*\(n=(\d+)\)\s*$")
_STAT = re.compile(r"^\s*(min=.*)$")
_BIN = re.compile(r"^\s+(\S+?):\s+(\d+)\s+\(\s*([\d.]+)%\)")


def parse_report(path: Path) -> dict:
    """Return {metric_name: {"n": int, "stat": str, "bins": [(label, count, pct)]}}."""
    metrics: dict = {}
    current = None
    for line in path.read_text().splitlines():
        header = _HEADER.match(line)
        if header:
            current = header.group(1).strip()
            metrics[current] = {"n": int(header.group(2)), "stat": "", "bins": []}
            continue
        if current is None:
            continue
        if not metrics[current]["stat"]:
            stat = _STAT.match(line.strip())
            if stat:
                metrics[current]["stat"] = stat.group(1)
                continue
        binned = _BIN.match(line)
        if binned:
            metrics[current]["bins"].append(
                (binned.group(1), int(binned.group(2)), float(binned.group(3)))
            )
    return metrics


def bar(pct: float) -> str:
    return FILL * round(pct / 100 * WIDTH) + EMPTY * (WIDTH - round(pct / 100 * WIDTH))


def render(metric: str, reports: list[dict], labels: list[str]) -> str:
    """Draw one metric across all reports, bins taken from the first that has it."""
    present = [(lbl, r[metric]) for lbl, r in zip(labels, reports) if metric in r]
    if not present:
        return ""
    label_w = max(len(b[0]) for _, m in present for b in m["bins"])
    out = [metric]
    if len(present) > 1:
        head = " " * (label_w + 2)
        head += "".join(f"{lbl} (n={m['n']})".ljust(WIDTH + 9) for lbl, m in present)
        out.append(head.rstrip())
    else:
        out.append(f"{' ' * (label_w + 2)}n={present[0][1]['n']}")

    bin_labels = [b[0] for b in present[0][1]["bins"]]
    lookup = [{b[0]: b[2] for b in m["bins"]} for _, m in present]
    for name in bin_labels:
        row = f"{name:>{label_w}}  "
        row += "".join(f"{bar(t.get(name, 0.0))} {t.get(name, 0.0):5.1f}%   " for t in lookup)
        out.append(row.rstrip())
    for lbl, m in present:
        prefix = f"{lbl} " if len(present) > 1 else ""
        out.append(f"{' ' * (label_w + 2)}{prefix}{m['stat']}")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("reports", nargs="+", type=Path, help="one or more .report files")
    ap.add_argument("--labels", nargs="+", help="name per report (default: filename stem)")
    ap.add_argument(
        "--metrics",
        nargs="+",
        help="metric names or prefixes to draw (default: all in the first report)",
    )
    args = ap.parse_args()

    missing = [p for p in args.reports if not p.exists()]
    if missing:
        ap.error(f"no such report: {', '.join(str(p) for p in missing)}")

    parsed = [parse_report(p) for p in args.reports]
    labels = args.labels or [p.stem.replace("soak_", "") for p in args.reports]
    if len(labels) != len(parsed):
        ap.error(f"got {len(labels)} labels for {len(parsed)} reports")

    wanted = list(parsed[0])
    if args.metrics:
        wanted = [m for m in wanted if any(m.startswith(w) for w in args.metrics)]
        if not wanted:
            ap.error(f"no metric matched {args.metrics}; have: {list(parsed[0])}")

    for metric in wanted:
        chart = render(metric, parsed, labels)
        if chart:
            print(chart)
            print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
