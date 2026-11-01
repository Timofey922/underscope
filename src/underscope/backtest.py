"""Backtest the decision engine against an oracle on the SYNTHETIC set."""

from __future__ import annotations

from pathlib import Path as FsPath

from underscope.data import ROOT, read_synthetic
from underscope.decision import PATHS, evaluate
from underscope.models import DamageFinding, VehicleRecord


def run_backtest(rows: list[dict]) -> dict:
    n = len(rows)
    correct = 0
    regret_cents = 0
    reviewed = 0
    flagged = {"n": 0, "regret": 0, "correct": 0}
    unflagged = {"n": 0, "regret": 0, "correct": 0}
    baselines = {p.value: 0 for p in PATHS}
    oracle_total = 0
    for r in rows:
        v = VehicleRecord(**r["vehicle"])
        rec = evaluate(v, [DamageFinding(**f) for f in r["vehicle"]["findings"]])
        net = r["truth"]["realized_net_cents"]
        best = max(net.values())
        oracle_total += best
        chosen = net[rec.winner.value]
        regret = best - chosen
        ok = rec.winner.value == r["truth"]["best_path"]
        correct += ok
        regret_cents += regret
        reviewed += rec.needs_human_review
        bucket = flagged if rec.needs_human_review else unflagged
        bucket["n"] += 1
        bucket["regret"] += regret
        bucket["correct"] += ok
        for p in PATHS:
            baselines[p.value] += best - net[p.value]
    return {
        "n": n,
        "accuracy": correct / n,
        "avg_regret_cents": regret_cents / n,
        "review_rate": reviewed / n,
        "flagged": flagged,
        "unflagged": unflagged,
        "baseline_avg_regret_cents": {k: v / n for k, v in baselines.items()},
        "avg_oracle_net_cents": oracle_total / n,
    }


def _d(cents: float) -> str:
    return f"${cents / 100:,.0f}"


def _row(name: str, b: dict) -> str:
    if not b["n"]:
        return f"| {name} | 0 | - | - |"
    return f"| {name} | {b['n']} | {b['correct'] / b['n']:.1%} | {_d(b['regret'] / b['n'])} |"


def write_report(res: dict, path: str | FsPath = ROOT / "reports" / "backtest.md") -> FsPath:
    base = res["baseline_avg_regret_cents"]
    lines = [
        "# Backtest vs oracle (SYNTHETIC data)",
        "",
        "**Read this first:** the 500 vehicles and their 'true' outcomes are synthetic and are",
        "drawn from the same PLACEHOLDER model the engine uses. The engine sees noisy findings",
        "(severity noise, 5% missed findings, imperfect confidence); the oracle sees the true",
        "findings and one realized outcome per path. These numbers show decision quality under",
        "perception noise and outcome variance, not accuracy on real auction data.",
        "",
        f"Vehicles: {res['n']}. Oracle = best realized net per vehicle "
        f"(average {_d(res['avg_oracle_net_cents'])}).",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Accuracy (picked the oracle's path) | {res['accuracy']:.1%} |",
        f"| Average regret (oracle net - chosen net) | {_d(res['avg_regret_cents'])} per vehicle |",
        f"| Human-review rate | {res['review_rate']:.1%} |",
        "",
        "## By review flag",
        "",
        "| Group | Vehicles | Accuracy | Avg regret |",
        "|---|---|---|---|",
        _row("Flagged for review", res["flagged"]),
        _row("Not flagged", res["unflagged"]),
        "",
        "## Baselines: always pick one path (average regret)",
        "",
        "| Policy | Avg regret |",
        "|---|---|",
        *(f"| always {k} | {_d(v)} |" for k, v in base.items()),
        f"| UnderScope | {_d(res['avg_regret_cents'])} |",
        "",
        "Regret is in dollars (integer cents internally). Regenerate with "
        "`.venv/bin/python -m underscope.backtest`.",
    ]
    p = FsPath(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(lines) + "\n")
    return p


if __name__ == "__main__":
    print(write_report(run_backtest(read_synthetic())))
