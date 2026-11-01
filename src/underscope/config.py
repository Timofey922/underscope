"""Loads config/assumptions.yaml. Values are PLACEHOLDERs, money is integer cents."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

DEFAULT_PATH = Path(__file__).resolve().parents[2] / "config" / "assumptions.yaml"
REQUIRED_SECTIONS = (
    "base_value", "repair_cost", "market", "fees", "transport", "timing", "title",
    "total_loss", "parts", "hidden_damage", "simulation",
)  # fmt: skip


class Assumptions:
    """Thin validated wrapper over the YAML dict."""

    def __init__(self, data: dict[str, Any]):
        for s in REQUIRED_SECTIONS:
            if s not in data:
                raise ValueError(f"assumptions missing section: {s}")
            if data[s].get("status") != "PLACEHOLDER":
                raise ValueError(f"section {s} must be labeled status: PLACEHOLDER")
            if "replace_with" not in data[s]:
                raise ValueError(f"section {s} needs a replace_with note")
        self.data = data

    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    def total_loss_threshold_pct(self, region: str) -> float:
        tl = self.data["total_loss"]
        return float(tl["threshold_pct_by_region"].get(region, tl["default_threshold_pct"]))


def load_assumptions(path: str | Path | None = None) -> Assumptions:
    return Assumptions(yaml.safe_load(Path(path or DEFAULT_PATH).read_text()))


@lru_cache(maxsize=1)
def default_assumptions() -> Assumptions:
    return load_assumptions()
