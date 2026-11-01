"""Data sources: fixtures (real code path), ACV/Copart stubs (no network), synthetic generator.

Everything produced by `generate_synthetic` is SYNTHETIC and carries synthetic=True.
"""

from __future__ import annotations

import json
from pathlib import Path as FsPath
from typing import Protocol

import numpy as np

from underscope.config import Assumptions, default_assumptions
from underscope.decision import PATHS, simulate
from underscope.models import DamageFinding, Panel, VehicleRecord
from underscope.valuation import value_vehicle

ROOT = FsPath(__file__).resolve().parents[2]
FIXTURE_DIR = ROOT / "data" / "fixtures"
SYNTHETIC_DIR = ROOT / "data" / "synthetic"


class VehicleSource(Protocol):
    def get_vehicle(self, vin: str) -> VehicleRecord: ...


class FixtureSource:
    """Loads vehicle JSON files from a directory (default data/fixtures/)."""

    def __init__(self, directory: str | FsPath = FIXTURE_DIR):
        self.directory = FsPath(directory)

    def list_vins(self) -> list[str]:
        return sorted(
            self._load(p).vin for p in self.directory.glob("*.json") if p.stem != "labels"
        )

    @staticmethod
    def _load(path: FsPath) -> VehicleRecord:
        return VehicleRecord(**json.loads(path.read_text()))

    def get_vehicle(self, vin: str) -> VehicleRecord:
        for p in self.directory.glob("*.json"):
            if p.stem != "labels" and (v := self._load(p)).vin == vin:
                return v
        raise KeyError(vin)


class ACVSource:
    """STUB. Fields we need from ACV once a data partnership exists. No network access."""

    REQUIRED_FIELDS = (
        "vin", "year", "make", "model", "trim", "odometer", "region", "title_status",
        "condition_report (panel-level damage, photos, undercarriage, engine audio)",
        "sale_price", "sale_date", "days_to_sell", "seller_fees", "arbitration_outcome",
        "wholesale_market_value_by_vin_trim_mileage_region",
    )  # fmt: skip

    def get_vehicle(self, vin: str) -> VehicleRecord:
        raise NotImplementedError("ACV adapter is a stub; no data partnership yet.")


class CopartSource:
    """STUB. Fields we need from Copart once a data partnership exists. No network access."""

    REQUIRED_FIELDS = (
        "vin", "year", "make", "model", "odometer", "region", "title_brand",
        "primary_damage", "secondary_damage", "photos", "keys_present", "runs_and_drives",
        "final_bid_price", "sale_date", "days_to_sell", "seller_fees", "tow_cost_by_lane",
    )  # fmt: skip

    def get_vehicle(self, vin: str) -> VehicleRecord:
        raise NotImplementedError("Copart adapter is a stub; no data partnership yet.")


# ---------------------------------------------------------------- synthetic generator

_MAKES = {"SynthA": ["Alpha", "Beta"], "SynthB": ["Gamma", "Delta"], "SynthC": ["Eps", "Zeta"]}
_PANEL_WEIGHTS = {
    Panel.FRONT_BUMPER: 5, Panel.REAR_BUMPER: 4, Panel.HOOD: 3, Panel.FENDER: 4, Panel.DOOR: 5,
    Panel.QUARTER_PANEL: 2, Panel.ROOF: 1, Panel.WINDSHIELD: 2, Panel.FRAME: 1,
}  # fmt: skip
_TYPES = ["scratch", "dent", "crack", "crush", "broken"]
_TYPE_P = [0.25, 0.35, 0.1, 0.2, 0.1]


def generate_synthetic(n: int = 500, seed: int = 7, a: Assumptions | None = None) -> list[dict]:
    """Seeded SYNTHETIC vehicles with hidden ground truth.

    Each row has the vehicle as the engine sees it (noisy perceived findings) and a truth
    block: the real findings and one realized outcome per path drawn from the same placeholder
    model (an independent seed per vehicle). Because truth shares the model, backtest scores
    measure decision quality under noise, not real-world accuracy.
    """
    a = a or default_assumptions()
    rng = np.random.default_rng(seed)
    regions = list(a["total_loss"]["threshold_pct_by_region"])
    panels = list(_PANEL_WEIGHTS)
    pw = np.array(list(_PANEL_WEIGHTS.values()), dtype=float)
    pw /= pw.sum()
    rows = []
    for i in range(n):
        make = str(rng.choice(list(_MAKES)))
        k = int(rng.integers(1, 5))
        true_findings = [
            DamageFinding(
                panel=panels[int(rng.choice(len(panels), p=pw))],
                damage_type=str(rng.choice(_TYPES, p=_TYPE_P)),
                severity=round(float(rng.beta(1.6, 2.4)), 3),
                confidence=1.0,
            )
            for _ in range(k)
        ]
        title = str(rng.choice(["clean", "salvage", "rebuilt"], p=[0.85, 0.1, 0.05]))
        vehicle = VehicleRecord(
            vin=f"SYN{i:014d}",
            year=int(rng.integers(2012, 2026)),
            make=make,
            model=str(rng.choice(_MAKES[make])),
            trim="Base",
            mileage=int(rng.integers(5_000, 160_000)),
            region=str(rng.choice(regions)),
            title_status=title,
            photo_refs=[f"synthetic/{i:04d}_{j}.jpg" for j in range(k)],
            undercarriage_damage=[None, False, True][int(rng.choice(3, p=[0.3, 0.55, 0.15]))],
            engine_audio_abnormal=[None, False, True][int(rng.choice(3, p=[0.4, 0.5, 0.1]))],
        )
        # What the detector reports: noisy severity, 5% missed, imperfect confidence.
        perceived = []
        for f in true_findings:
            if rng.random() < 0.05:
                continue
            conf = float(np.clip(rng.normal(0.85, 0.12), 0.3, 0.99))
            sev = float(np.clip(f.severity + rng.normal(0, 0.12), 0, 1))
            perceived.append(
                f.model_copy(update={"severity": round(sev, 3), "confidence": round(conf, 3)})
            )
        vehicle = vehicle.model_copy(update={"findings": perceived})

        truth_val = value_vehicle(vehicle, true_findings, a)
        realized = simulate(vehicle, truth_val, a, draws=1, seed=int(rng.integers(2**31)))
        net = {p.value: int(realized.nets[p][0]) for p in PATHS}
        best = max(PATHS, key=lambda p: (net[p.value], -PATHS.index(p)))
        rows.append(
            {
                "synthetic": True,
                "vehicle": vehicle.model_dump(mode="json"),
                "truth": {
                    "findings": [f.model_dump(mode="json") for f in true_findings],
                    "realized_net_cents": net,
                    "best_path": best.value,
                },
            }
        )
    return rows


def write_synthetic(directory: str | FsPath = SYNTHETIC_DIR, n: int = 500, seed: int = 7) -> FsPath:
    d = FsPath(directory)
    d.mkdir(parents=True, exist_ok=True)
    out = d / "vehicles.jsonl"
    out.write_text("".join(json.dumps(r) + "\n" for r in generate_synthetic(n, seed)))
    (d / "README.md").write_text(
        "# SYNTHETIC data\n\nGenerated by `underscope.data.generate_synthetic` "
        f"(n={n}, seed={seed}). Fake VINs and makes; outcomes come from the placeholder model "
        "in config/assumptions.yaml. Not real market data.\n"
    )
    return out


def read_synthetic(path: str | FsPath = SYNTHETIC_DIR / "vehicles.jsonl") -> list[dict]:
    return [json.loads(line) for line in FsPath(path).read_text().splitlines() if line]


if __name__ == "__main__":
    print(write_synthetic())
