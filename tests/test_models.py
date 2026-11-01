import pytest
from pydantic import ValidationError

from underscope.models import DamageFinding, VehicleRecord
from underscope.perception import DamageDetector, MockDetector

LABELS = {"a.jpg": [{"panel": "door", "damage_type": "dent", "severity": 0.2, "confidence": 0.9}]}


def vehicle(**kw):
    base = dict(vin="V1", year=2019, make="Honda", model="Civic", mileage=50000, region="NY")
    return VehicleRecord(**{**base, **kw})


def test_severity_bounds():
    with pytest.raises(ValidationError):
        DamageFinding(panel="door", damage_type="dent", severity=1.5, confidence=0.5)


def test_mock_detector_reads_labels_and_inline():
    inline = {"panel": "hood", "damage_type": "crush", "severity": 0.5, "confidence": 0.8}
    v = vehicle(photo_refs=["a.jpg", "missing.jpg"], findings=[inline])
    det: DamageDetector = MockDetector(LABELS)
    out = det.detect(v)
    assert [f.panel for f in out] == ["hood", "door"]
