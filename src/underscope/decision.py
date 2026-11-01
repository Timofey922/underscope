"""Decision engine: seeded Monte Carlo of net proceeds per disposition path.

All money is integer cents. Random draws are rounded to cents immediately and the rest of
the arithmetic is integer, so component sums are exact per draw.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from underscope.config import Assumptions, default_assumptions
from underscope.models import (
    DamageFinding,
    DispositionOption,
    Path,
    Recommendation,
    TitleStatus,
    VehicleRecord,
)
from underscope.valuation import Range, Valuation, value_vehicle

PATHS = (Path.REPAIR_THEN_ACV, Path.ACV_AS_IS, Path.COPART_SALVAGE, Path.PART_OUT)


@dataclass
class SimResult:
    nets: dict[Path, np.ndarray]  # int64 cents, one entry per draw
    components: dict[Path, dict[str, np.ndarray]] = field(default_factory=dict)
    branded_share: float = 0.0  # share of draws where repair triggered a title brand


def _tri(rng: np.random.Generator, r: Range | list[int] | tuple, n: int) -> np.ndarray:
    """Triangular draw over (low, mode, high); float array."""
    lo, mode, hi = (float(x) for x in r)
    if hi <= lo:
        return np.full(n, lo)
    return rng.triangular(lo, mode, hi, n)


def _cents(x: np.ndarray) -> np.ndarray:
    return np.rint(x).astype(np.int64)


def _pct(price: np.ndarray, pct: float) -> np.ndarray:
    return _cents(price * pct / 100.0)


def simulate(
    vehicle: VehicleRecord,
    val: Valuation,
    a: Assumptions,
    draws: int | None = None,
    seed: int | None = None,
    force_title_factor: float | None = None,
) -> SimResult:
    """Draw net proceeds for every path.

    force_title_factor overrides the title multiplier on the repair path (used to test
    whether the total-loss threshold decides the outcome).
    """
    sim = a["simulation"]
    n = draws or sim["draws"]
    rng = np.random.default_rng(sim["seed"] if seed is None else seed)
    fees, tr, tm = a["fees"], a["transport"], a["timing"]

    # All random variables are drawn up front, in a fixed order, so every path sees the same
    # market shock (common random numbers) and results are reproducible.
    market = rng.lognormal(0.0, sim["value_noise_sigma"], n)
    rep = _cents(_tri(rng, val.repair_cost, n))
    salv = _tri(rng, val.salvage_value, n)
    parts_gross = _tri(rng, val.parts_gross_value, n)
    sell_through = _tri(rng, a["parts"]["sell_through"], n)
    teardown = _cents(_tri(rng, a["parts"]["teardown_labor_cents"], n))
    t_acv = _cents(_tri(rng, tr["acv_cents"], n))
    t_cop = _cents(_tri(rng, tr["copart_cents"], n))
    t_parts = _cents(_tri(rng, tr["parts_cents"], n))
    repair_days = np.rint(_tri(rng, tm["repair_days"], n)).astype(np.int64)
    days = {p: np.rint(_tri(rng, tm["days_to_sell"][p.value], n)).astype(np.int64) for p in PATHS}

    hold = tm["holding_cost_per_day_cents"]
    nets: dict[Path, np.ndarray] = {}
    comps: dict[Path, dict[str, np.ndarray]] = {}

    # 1. Repair, then sell on ACV.
    clean_shocked = val.clean_value * market
    if force_title_factor is not None:
        title_factor = np.full(n, force_title_factor)
        branded = np.zeros(n, dtype=bool)
    elif vehicle.title_status != TitleStatus.CLEAN or not vehicle.insurance_claim:
        title_factor = np.full(n, val.title_factor_after_repair)
        branded = np.zeros(n, dtype=bool)
    else:
        # Insurance claim on a clean title: the insurer totals the car when repair cost crosses
        # the threshold, evaluated per draw against the (shocked) clean value.
        branded = rep >= val.total_loss_threshold * clean_shocked
        factors = a["title"]["factor"]
        brand = factors[a["title"]["brand_after_total_loss_repair"]]
        title_factor = np.where(branded, brand, factors["clean"])
    sale = _cents(val.repaired_value * market * title_factor)
    fee = _cents(fees["acv"]["flat_cents"] + _pct(sale, fees["acv"]["pct_of_price"]))
    holding = (repair_days + days[Path.REPAIR_THEN_ACV]) * hold
    h = a["hidden_damage"]
    reserve = _pct(rep.astype(float), h["reserve_pct_of_repair"])
    for flag, extra in (
        (vehicle.undercarriage_damage, h["undercarriage_extra_cents"]),
        (vehicle.engine_audio_abnormal, h["engine_audio_extra_cents"]),
    ):
        reserve = reserve + (h["unknown_flag_extra_cents"] if flag is None else extra * int(flag))
    nets[Path.REPAIR_THEN_ACV] = sale - rep - fee - t_acv - holding - reserve
    comps[Path.REPAIR_THEN_ACV] = {
        "sale_price": sale, "repair_cost": -rep, "acv_fees": -fee, "transport": -t_acv,
        "holding": -holding, "hidden_damage_reserve": -reserve,
    }  # fmt: skip

    # 2. Sell as-is on ACV.
    sale = _cents(val.as_is_value * market)
    fee = _cents(fees["acv"]["flat_cents"] + _pct(sale, fees["acv"]["pct_of_price"]))
    holding = days[Path.ACV_AS_IS] * hold
    nets[Path.ACV_AS_IS] = sale - fee - t_acv - holding
    comps[Path.ACV_AS_IS] = {
        "sale_price": sale, "acv_fees": -fee, "transport": -t_acv, "holding": -holding,
    }  # fmt: skip

    # 3. Sell as salvage on Copart.
    sale = _cents(salv * market)
    fee = _cents(fees["copart"]["flat_cents"] + _pct(sale, fees["copart"]["pct_of_price"]))
    holding = days[Path.COPART_SALVAGE] * hold
    nets[Path.COPART_SALVAGE] = sale - fee - t_cop - holding
    comps[Path.COPART_SALVAGE] = {
        "sale_price": sale, "copart_fees": -fee, "transport": -t_cop, "holding": -holding,
    }  # fmt: skip

    # 4. Part out.
    revenue = _cents(parts_gross * market * sell_through)
    storage = days[Path.PART_OUT] * a["parts"]["storage_cents_per_day"]
    nets[Path.PART_OUT] = revenue - teardown - storage - t_parts
    comps[Path.PART_OUT] = {
        "parts_revenue": revenue, "teardown_labor": -teardown, "storage": -storage,
        "transport": -t_parts,
    }  # fmt: skip
    return SimResult(nets, comps, float(branded.mean()))


def _winner(nets: dict[Path, np.ndarray]) -> Path:
    return max(PATHS, key=lambda p: (int(round(nets[p].mean())), -PATHS.index(p)))


def _dollars(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    return f"{sign}${abs(cents) / 100:,.0f}"


LABEL = {
    Path.REPAIR_THEN_ACV: "repair then sell on ACV",
    Path.ACV_AS_IS: "sell as-is on ACV",
    Path.COPART_SALVAGE: "sell as salvage on Copart",
    Path.PART_OUT: "part out",
}


def _options(sim: SimResult) -> list[DispositionOption]:
    opts = []
    for p in PATHS:
        x = sim.nets[p]
        p10, p50, p90 = (int(round(v)) for v in np.percentile(x, [10, 50, 90]))
        opts.append(
            DispositionOption(
                path=p,
                expected_cents=int(round(x.mean())),
                p10_cents=p10,
                p50_cents=p50,
                p90_cents=p90,
                components={k: int(round(v.mean())) for k, v in sim.components[p].items()},
            )
        )
    # Rank by expected margin; ties keep the canonical path order.
    return sorted(opts, key=lambda o: (-o.expected_cents, PATHS.index(o.path)))


def _flip_conditions(
    ranked: list[DispositionOption], a: Assumptions, vehicle: VehicleRecord
) -> list[str]:
    win, run = ranked[0], ranked[1]
    gap = win.expected_cents - run.expected_cents
    out = []
    reserve = 1 + a["hidden_damage"]["reserve_pct_of_repair"] / 100
    fee_pct = {
        Path.ACV_AS_IS: a["fees"]["acv"]["pct_of_price"],
        Path.COPART_SALVAGE: a["fees"]["copart"]["pct_of_price"],
    }

    def lever(opt: DispositionOption, direction: str) -> str | None:
        # direction "worse": what would have to get worse for this option to lose the gap.
        # direction "better": what would have to improve for it to catch up.
        if opt.path == Path.REPAIR_THEN_ACV:
            shift = round(gap / reserve)
            verb = "rise" if direction == "worse" else "fall"
            return f"expected repair cost would have to {verb} by about {_dollars(shift)}"
        if opt.path in fee_pct:
            net_share = 1 - fee_pct[opt.path] / 100
            shift = round(gap / net_share)
            verb = "fall" if direction == "worse" else "rise"
            return f"the sale price would have to {verb} by about {_dollars(shift)}"
        if opt.path == Path.PART_OUT:
            verb = "fall" if direction == "worse" else "rise"
            return f"net parts revenue would have to {verb} by about {_dollars(gap)}"
        return None

    for opt, direction in ((win, "worse"), (run, "better")):
        text = lever(opt, direction)
        if text:
            out.append(f"For {LABEL[opt.path]}: {text} to flip the ranking.")
    if vehicle.undercarriage_damage is None or vehicle.engine_audio_abnormal is None:
        out.append(
            "Missing undercarriage/engine-audio inspection flags add a hidden-damage "
            "allowance to repair; confirming them could change the ranking."
        )
    return out


def evaluate(
    vehicle: VehicleRecord,
    findings: list[DamageFinding],
    a: Assumptions | None = None,
) -> Recommendation:
    a = a or default_assumptions()
    sim_cfg = a["simulation"]
    val = value_vehicle(vehicle, findings, a)
    sim = simulate(vehicle, val, a)
    ranked = _options(sim)
    win, run = ranked[0], ranked[1]

    reasons: list[str] = []
    # Paired draws share market shocks, so this is the chance the runner-up truly beats the winner.
    overlap = float(np.mean(sim.nets[run.path] > sim.nets[win.path]))
    if overlap >= sim_cfg["review_overlap_threshold"]:
        reasons.append(
            f"Top two paths overlap heavily: the runner-up beat the winner in {overlap:.0%} of "
            "simulated outcomes."
        )
    if val.mean_confidence < sim_cfg["low_confidence_threshold"]:
        reasons.append(f"Damage findings have low average confidence ({val.mean_confidence:.2f}).")

    # (winner if the repaired title stays clean, winner if it is branded), when they differ.
    tl_flip: tuple[Path, Path] | None = None
    # Only relevant on insurance claims where a material share of draws crosses the threshold.
    if sim.branded_share >= sim_cfg["total_loss_min_branded_share"]:
        factors = a["title"]["factor"]
        brand = factors[a["title"]["brand_after_total_loss_repair"]]
        w_clean = _winner(simulate(vehicle, val, a, force_title_factor=factors["clean"]).nets)
        w_brand = _winner(simulate(vehicle, val, a, force_title_factor=brand).nets)
        if w_clean != w_brand:
            tl_flip = (w_clean, w_brand)
            reasons.append(
                f"The total-loss threshold decides the outcome: the repair crosses it in "
                f"{sim.branded_share:.1%} of draws, and the best path differs depending on "
                "whether the title is branded."
            )
    total_loss_decides = tl_flip is not None

    explanation = _explain(vehicle, val, ranked, overlap, tl_flip, sim)
    return Recommendation(
        vin=vehicle.vin,
        winner=win.path,
        options=ranked,
        needs_human_review=bool(reasons),
        review_reasons=reasons,
        total_loss_decides=total_loss_decides,
        explanation=explanation,
        flip_conditions=_flip_conditions(ranked, a, vehicle),
    )


def _explain(
    vehicle: VehicleRecord,
    val: Valuation,
    ranked: list[DispositionOption],
    overlap: float,
    tl_flip: tuple[Path, Path] | None,
    sim: SimResult,
) -> str:
    win, run = ranked[0], ranked[1]
    gap = win.expected_cents - run.expected_cents
    text = (
        f"Best path: {LABEL[win.path]}, expected net {_dollars(win.expected_cents)} "
        f"(P10 {_dollars(win.p10_cents)}, P90 {_dollars(win.p90_cents)}). "
        f"Next best is {LABEL[run.path]} at {_dollars(run.expected_cents)}, "
        f"{_dollars(gap)} behind; it wins in {overlap:.0%} of simulated outcomes. "
        f"Expected repair cost is {_dollars(val.repair_cost.expected)} "
        f"({val.repair_ratio:.0%} of a {_dollars(val.clean_value)} clean value; "
        f"total-loss threshold {val.total_loss_threshold:.0%} in {vehicle.region})."
    )
    if win.path == Path.REPAIR_THEN_ACV and sim.branded_share > 0:
        text += (
            f" In {sim.branded_share:.1%} of draws the repair crosses the threshold "
            "and the title is branded."
        )
    if (
        vehicle.insurance_claim
        and win.path != Path.REPAIR_THEN_ACV
        and val.repair_ratio >= val.total_loss_threshold
    ):
        text += " Repair is past the total-loss threshold, so a repaired car would carry a brand."
    if tl_flip:
        w_clean, w_brand = tl_flip
        text += (
            f" The total-loss threshold decides this outcome: if the repaired title stays "
            f"clean, {LABEL[w_clean]} wins. If the repair brands the title, "
            f"{LABEL[w_brand]} wins instead."
        )
    return text
