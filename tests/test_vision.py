import json
from types import SimpleNamespace

import pytest

from underscope.models import VehicleRecord
from underscope.vision import (
    FALLBACK_BETA,
    MODEL,
    SCHEMA,
    ClaudeVisionDetector,
    DetectionError,
    parse_response,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def reply(payload, stop="end_turn"):
    text = payload if isinstance(payload, str) else json.dumps(payload)
    return SimpleNamespace(
        stop_reason=stop,
        content=[
            SimpleNamespace(type="thinking", thinking=""),
            SimpleNamespace(type="text", text=text),
        ],
        usage=SimpleNamespace(input_tokens=1500, output_tokens=200),
    )


class FakeClient:
    """Stands in for anthropic.Anthropic: records requests, returns canned replies."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        return self.replies.pop(0)


def vehicle(*refs):
    return VehicleRecord(vin="V", year=2021, make="X", model="Y", mileage=1, region="NY",
                         photo_refs=list(refs))  # fmt: skip


def finding(panel="door", t="dent", sev=0.4, conf=0.8):
    return {"panel": panel, "damage_type": t, "severity": sev, "confidence": conf}


def test_detects_findings_per_photo_with_photo_ref(tmp_path):
    (tmp_path / "a.png").write_bytes(PNG)
    (tmp_path / "b.jpg").write_bytes(PNG)
    client = FakeClient(
        reply({"findings": [finding()], "unmapped_damage": ["front left tire flat"]}),
        reply({"findings": [finding("hood", "scratch", 0.1, 0.6)], "unmapped_damage": []}),
    )
    det = ClaudeVisionDetector(tmp_path, client=client)
    out = det.detect(vehicle("a.png", "b.jpg"))
    assert [(f.panel.value, f.photo_ref) for f in out] == [("door", "a.png"), ("hood", "b.jpg")]
    assert det.notes["a.png"] == ["front left tire flat"]
    assert len(det.usage) == 2


def test_request_shape(tmp_path):
    (tmp_path / "a.png").write_bytes(PNG)
    client = FakeClient(reply({"findings": [], "unmapped_damage": []}))
    ClaudeVisionDetector(tmp_path, client=client, effort="high").detect_photo("a.png")
    call = client.calls[0]
    assert call["model"] == MODEL and call["betas"] == [FALLBACK_BETA]
    assert call["fallbacks"] == "default"
    assert call["output_config"] == {"effort": "high",
                                     "format": {"type": "json_schema", "schema": SCHEMA}}
    image, text = call["messages"][0]["content"]
    assert image["source"]["media_type"] == "image/png" and text["type"] == "text"
    assert "temperature" not in call and "thinking" not in call


def test_values_clamped_into_range():
    out, _, view = parse_response(reply({"findings": [finding(sev=1.4, conf=-0.2)],
                                   "unmapped_damage": []}), "p")  # fmt: skip
    assert out[0].severity == 1.0 and out[0].confidence == 0.0
    assert view == "unknown"  # missing view


@pytest.mark.parametrize("resp", [
    reply({"findings": []}, stop="refusal"),
    reply({"findings": []}, stop="max_tokens"),
    reply("not json"),
    reply({"findings": [finding(panel="wheel")], "unmapped_damage": []}),
])  # fmt: skip
def test_unusable_responses_raise(resp):
    with pytest.raises(DetectionError):
        parse_response(resp, "p")


def test_missing_unsupported_and_oversized_photos(tmp_path):
    det = ClaudeVisionDetector(tmp_path, client=FakeClient())
    with pytest.raises(DetectionError, match="not found"):
        det.detect_photo("nope.jpg")
    (tmp_path / "a.bmp").write_bytes(PNG)
    with pytest.raises(DetectionError, match="unsupported"):
        det.detect_photo("a.bmp")
    (tmp_path / "big.gif").write_bytes(b"\x00" * (5 * 1024 * 1024 + 1))
    with pytest.raises(DetectionError, match="5 MB"):
        det.detect_photo("big.gif")


def test_schema_enums_match_domain_model():
    from underscope.models import DamageType, Panel

    items = SCHEMA["properties"]["findings"]["items"]["properties"]
    assert items["panel"]["enum"] == [p.value for p in Panel]
    assert items["damage_type"]["enum"] == [t.value for t in DamageType]


def test_same_damage_in_two_photos_is_counted_once(tmp_path):
    (tmp_path / "a.png").write_bytes(PNG)
    (tmp_path / "b.png").write_bytes(PNG)
    client = FakeClient(
        reply({"findings": [{**finding("door", "dent", 0.4, 0.7), "side": "left"}],
               "unmapped_damage": []}),
        reply({"findings": [{**finding("door", "dent", 0.6, 0.9), "side": "left"},
                            {**finding("door", "dent", 0.3, 0.8), "side": "right"}],
               "unmapped_damage": []}),
    )  # fmt: skip
    out = ClaudeVisionDetector(tmp_path, client=client).detect(vehicle("a.png", "b.png"))
    by_side = {f.side: f for f in out}
    assert set(by_side) == {"left", "right"}
    left = by_side["left"]
    assert (left.severity, left.confidence, left.photo_ref) == (0.6, 0.9, "b.png")


def test_unknown_side_is_none():
    out, _, _ = parse_response(reply({"findings": [{**finding(), "side": "unknown"}],
                                   "unmapped_damage": []}), "p")  # fmt: skip
    assert out[0].side is None


class FakeBatches:
    """Stands in for client.messages.batches."""

    def __init__(self, results, status="ended"):
        self.results_list, self.status, self.created = results, status, None

    def create(self, requests):
        self.created = requests
        return SimpleNamespace(id="msgbatch_1")

    def retrieve(self, batch_id):
        return SimpleNamespace(processing_status=self.status)

    def results(self, batch_id):
        return iter(self.results_list)


def batch_client(results, status="ended"):
    return SimpleNamespace(messages=SimpleNamespace(batches=FakeBatches(results, status)))


def ok(cid, payload):
    return SimpleNamespace(custom_id=cid, result=SimpleNamespace(type="succeeded",
                                                                 message=reply(payload)))


def test_batch_submit_and_collect(tmp_path):
    for name in ("a.png", "b.png", "c.png"):
        (tmp_path / name).write_bytes(PNG)
    client = batch_client([
        ok("p0", {"findings": [{**finding(), "side": "left"}], "unmapped_damage": []}),
        ok("p1", "not json"),  # unusable
        SimpleNamespace(custom_id="p2", result=SimpleNamespace(type="expired")),
    ])  # fmt: skip
    det = ClaudeVisionDetector(tmp_path, client=client)
    state = det.submit_batch(["a.png", "b.png", "c.png"])
    assert state == {"batch_id": "msgbatch_1", "model": MODEL,
                     "photos": {"p0": "a.png", "p1": "b.png", "p2": "c.png"}}
    sent = client.messages.batches.created
    assert [r["custom_id"] for r in sent] == ["p0", "p1", "p2"]
    assert "fallbacks" not in sent[0]["params"] and "betas" not in sent[0]["params"]
    status, found, errors = det.collect_batch(state)
    assert status == "ended" and list(found) == ["a.png"]
    assert set(errors) == {"b.png", "c.png"} and "expired" in errors["c.png"]
    assert det.spent_usd(batch=True) == det.spent_usd() / 2 > 0


def test_batch_not_finished_yet(tmp_path):
    det = ClaudeVisionDetector(tmp_path, client=batch_client([], status="in_progress"))
    assert det.collect_batch({"batch_id": "x", "photos": {}}) == ("in_progress", {}, {})


def test_large_photos_are_downscaled_to_jpeg(tmp_path):
    import base64
    import io

    import numpy as np

    from underscope.vision import MAX_EDGE, image_block

    Image = pytest.importorskip("PIL.Image")  # vision extra

    Image.new("RGB", (3000, 1000), (200, 30, 30)).save(tmp_path / "wide.png")
    noise = np.random.default_rng(0).integers(0, 255, (1500, 1500, 3), dtype=np.uint8)
    Image.fromarray(noise).save(tmp_path / "heavy.png")
    assert (tmp_path / "heavy.png").stat().st_size > 5 * 1024 * 1024
    Image.new("RGB", (800, 600)).save(tmp_path / "small.png")
    for name in ("wide.png", "heavy.png"):
        block = image_block(tmp_path / name)
        assert block["source"]["media_type"] == "image/jpeg"
        img = Image.open(io.BytesIO(base64.b64decode(block["source"]["data"])))
        assert max(img.size) <= MAX_EDGE
    assert image_block(tmp_path / "small.png")["source"]["media_type"] == "image/png"


def test_photo_views_recorded(tmp_path):
    (tmp_path / "a.png").write_bytes(PNG)
    (tmp_path / "b.png").write_bytes(PNG)
    client = FakeClient(reply({"view": "front_left", "findings": [], "unmapped_damage": []}),
                        reply({"view": "sideways", "findings": [], "unmapped_damage": []}))
    det = ClaudeVisionDetector(tmp_path, client=client)
    det.detect(vehicle("a.png", "b.png"))
    assert det.views == {"a.png": "front_left", "b.png": "unknown"}
    assert SCHEMA["required"][0] == "view"
