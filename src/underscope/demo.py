"""A sample review folder to open in a browser, no API key or dataset needed.

Builds review sheets for the three fixture cars from drawn stand-in photos (SVG, labeled as
drawings), with detector-style sightings, boxes and photo views, plus the queue index. The
damage is the fixtures' own; positions and views are made up to show the sheet, not measured.
"""

from __future__ import annotations

import json
from pathlib import Path as FsPath

from underscope import review
from underscope.data import FIXTURE_DIR
from underscope.models import DamageFinding, VehicleRecord
from underscope.perception import merge_findings

Box = tuple[float, float, float, float]
# photo name, view, [(panel, side, damage type, severity, confidence, box)]
Photo = tuple[str, str, list[tuple[str, str | None, str, float, float, Box]]]

CARS: dict[str, list[Photo]] = {
    "dent_600.json": [
        ("dent_left.svg", "left", [("door", "left", "dent", 0.5, 0.92, (0.40, 0.42, 0.55, 0.60))]),
        ("dent_door_close.svg", "close_up",
         [("door", "left", "dent", 0.5, 0.95, (0.30, 0.30, 0.68, 0.70))]),
        ("dent_front.svg", "front", []),
        ("dent_rear.svg", "rear", []),
    ],  # no right-side or roof photo: the sheet asks the checker to verify those
    "borderline_writeoff.json": [
        ("border_front_left.svg", "front_left",
         [("door", "left", "dent", 0.6, 0.9, (0.44, 0.40, 0.62, 0.62)),
          ("frame", None, "crush", 0.4, 0.62, (0.10, 0.70, 0.36, 0.86))]),
        ("border_right.svg", "right", []),
        ("border_rear.svg", "rear", []),
    ],
    "total_loss.json": [
        ("total_front.svg", "front",
         [("hood", "center", "crush", 0.9, 0.9, (0.22, 0.30, 0.78, 0.52)),
          ("front_bumper", "center", "broken", 0.9, 0.95, (0.15, 0.62, 0.85, 0.80)),
          ("frame", None, "crush", 1.0, 0.85, (0.30, 0.80, 0.70, 0.92))]),
        ("total_front_left.svg", "front_left",
         [("hood", "center", "crush", 0.9, 0.88, (0.08, 0.30, 0.36, 0.50))]),
        ("total_left.svg", "left", []),
        ("total_right.svg", "right", []),
        ("total_rear.svg", "rear", []),
    ],
}

_W, _H = 800, 600


def _side_car() -> str:
    return (
        '<path d="M70 420 L90 330 Q110 300 170 296 L270 292 L340 210 Q360 192 400 192 '
        'L560 192 Q600 192 625 220 L680 290 Q740 300 750 340 L760 420 Z" fill="#8a96a3"/>'
        '<path d="M290 292 L350 222 Q362 210 390 210 L470 210 L470 292 Z" fill="#c7d6e3"/>'
        '<path d="M490 292 L490 210 L560 210 Q590 210 610 232 L655 292 Z" fill="#c7d6e3"/>'
        '<line x1="480" y1="200" x2="480" y2="420" stroke="#6d7884" stroke-width="3"/>'
        '<circle cx="200" cy="425" r="62" fill="#2b2f33"/><circle cx="200" cy="425" r="28" '
        'fill="#9aa3ab"/><circle cx="630" cy="425" r="62" fill="#2b2f33"/>'
        '<circle cx="630" cy="425" r="28" fill="#9aa3ab"/>'
    )


def _front_car() -> str:
    return (
        '<path d="M150 470 L160 300 Q170 250 230 240 L570 240 Q630 250 640 300 L650 470 Z" '
        'fill="#8a96a3"/>'
        '<path d="M240 240 L285 150 L515 150 L560 240 Z" fill="#c7d6e3"/>'
        '<rect x="185" y="300" width="110" height="45" rx="12" fill="#f2f0e6"/>'
        '<rect x="505" y="300" width="110" height="45" rx="12" fill="#f2f0e6"/>'
        '<rect x="320" y="380" width="160" height="50" rx="8" fill="#3c434a"/>'
        '<rect x="170" y="465" width="80" height="50" rx="10" fill="#2b2f33"/>'
        '<rect x="550" y="465" width="80" height="50" rx="10" fill="#2b2f33"/>'
    )


def _close_up() -> str:
    return ('<rect x="0" y="0" width="800" height="600" fill="#8a96a3"/>'
            '<path d="M0 380 Q400 340 800 380" stroke="#a7b2bd" stroke-width="18" '
            'fill="none"/>')  # fmt: skip


def _damage(box: Box, severity: float) -> str:
    x0, y0, x1, y1 = box[0] * _W, box[1] * _H, box[2] * _W, box[3] * _H
    cx, cy, rx, ry = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
    dark = 0.35 + 0.5 * severity
    return (
        f'<ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{rx * 0.85:.0f}" ry="{ry * 0.75:.0f}" '
        f'fill="#2a2420" opacity="{dark:.2f}"/>'
        f'<path d="M{x0 + rx * 0.3:.0f} {cy:.0f} Q{cx:.0f} {cy - ry * 0.6:.0f} '
        f'{x1 - rx * 0.3:.0f} {cy + ry * 0.2:.0f}" stroke="#f4f1ea" stroke-width="3" '
        f'fill="none" opacity="0.7"/>'
    )


def photo_svg(view: str, damage: list[tuple[Box, float]]) -> str:
    """A drawn stand-in photo of the car from this view, with the damage drawn in."""
    if view == "close_up":
        car = _close_up()
    elif view in ("front", "rear"):
        car = _front_car()
    else:
        car = _side_car()
    flip = ' transform="translate(800 0) scale(-1 1)"' if view in ("right", "rear_right") else ""
    spots = "".join(_damage(box, sev) for box, sev in damage)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {_W} {_H}" width="{_W}" '
        f'height="{_H}"><rect width="{_W}" height="{_H}" fill="#dfe3e6"/>'
        f'<rect y="470" width="{_W}" height="130" fill="#b9bfc4"/>'
        f"<g{flip}>{car}</g>{spots}"
        f'<text x="16" y="34" font-family="sans-serif" font-size="22" fill="#3c434a">'
        f"DEMO DRAWING, {view.replace('_', ' ')} view</text></svg>"
    )


def build(out: str | FsPath = "demo") -> FsPath:
    """Write photos/ and reviews/ under out; returns the queue index page."""
    out = FsPath(out)
    photos, reviews = out / "photos", out / "reviews"
    photos.mkdir(parents=True, exist_ok=True)
    for fixture, shots in CARS.items():
        car = json.loads((FIXTURE_DIR / fixture).read_text())
        sightings, views = [], {}
        for name, view, damage in shots:
            views[name] = view
            for panel, side, kind, sev, conf, box in damage:
                sightings.append(DamageFinding(
                    panel=panel, side=side, damage_type=kind, severity=sev, confidence=conf,
                    photo_ref=name, box=box,
                ))  # fmt: skip
            # Damage is drawn where it's boxed, so the marks land on it.
            (photos / name).write_text(photo_svg(view, [(d[5], d[3]) for d in damage]))
        vehicle = VehicleRecord(**{**car, "findings": [], "photo_refs": list(views)})
        req = review.build_request(vehicle, merge_findings(sightings), views=views,
                                   photo_root=photos, sightings=sightings)  # fmt: skip
        review.save(req, reviews)
    return review.write_queue_index(reviews)
