"""Domain model. Money fields are integer cents."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class TitleStatus(StrEnum):
    CLEAN = "clean"
    SALVAGE = "salvage"
    REBUILT = "rebuilt"


class Panel(StrEnum):
    FRONT_BUMPER = "front_bumper"
    REAR_BUMPER = "rear_bumper"
    HOOD = "hood"
    FENDER = "fender"
    DOOR = "door"
    QUARTER_PANEL = "quarter_panel"
    ROOF = "roof"
    WINDSHIELD = "windshield"
    FRAME = "frame"


class DamageType(StrEnum):
    DENT = "dent"
    SCRATCH = "scratch"
    CRACK = "crack"
    CRUSH = "crush"
    BROKEN = "broken"


class Path(StrEnum):
    REPAIR_THEN_ACV = "repair_then_acv"
    ACV_AS_IS = "acv_as_is"
    COPART_SALVAGE = "copart_salvage"
    PART_OUT = "part_out"


class VehicleRecord(BaseModel):
    vin: str
    year: int
    make: str
    model: str
    trim: str = ""
    mileage: int = Field(ge=0)
    region: str
    title_status: TitleStatus = TitleStatus.CLEAN
    photo_refs: list[str] = Field(default_factory=list)
    undercarriage_damage: bool | None = None
    engine_audio_abnormal: bool | None = None
    # Optional market anchor supplied by caller (cents); real source: ACV/Copart data.
    clean_value_cents: int | None = Field(default=None, ge=0)
    # Optional findings supplied inline (used when no detector labels exist).
    findings: list[DamageFinding] = Field(default_factory=list)


class DamageFinding(BaseModel):
    panel: Panel
    damage_type: DamageType
    severity: float = Field(ge=0, le=1)
    confidence: float = Field(ge=0, le=1)


class DispositionOption(BaseModel):
    path: Path
    expected_cents: int
    p10_cents: int
    p50_cents: int
    p90_cents: int
    components: dict[str, int] = Field(default_factory=dict)
    notes: list[str] = Field(default_factory=list)


class Recommendation(BaseModel):
    vin: str
    winner: Path
    options: list[DispositionOption]  # ranked best first by expected_cents
    needs_human_review: bool
    review_reasons: list[str] = Field(default_factory=list)
    total_loss_decides: bool = False
    explanation: str = ""
    flip_conditions: list[str] = Field(default_factory=list)


VehicleRecord.model_rebuild()
