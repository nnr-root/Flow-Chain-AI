import base64
import os
import sys

import pytest

sys.modules.setdefault("runpod", type(sys)("runpod"))  # the RunPod library is only in the image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import handler as h  # noqa: E402

from flowchain_ltx import engine, storage, weights  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"pixels"
GOOD = {
    "task": "clip",
    "image": base64.b64encode(PNG).decode(),
    "prompt": "a fox runs through snow",
    "frames": 121,
    "fps": 24,
    "width": 640,
    "height": 1152,
    "seed": 7,
}


@pytest.fixture
def world(monkeypatch, tmp_path):
    seen = {"files": [], "uploads": [], "calls": [], "order": []}
    monkeypatch.setattr(h, "TMP_DIR", str(tmp_path))
    for name in storage.REQUIRED_ENV:
        monkeypatch.setenv(name, "secret-value")
    monkeypatch.setattr(weights, "present", lambda *a: True)
    monkeypatch.setattr(weights, "assemble", lambda *a: seen["order"].append("assemble"))

    def fake_make_clip(req, workdir, generate=None, transcribe=None):
        seen["order"].append("make")
        seen["calls"].append(req)
        out = os.path.join(workdir, "clip.mp4")
        open(out, "wb").write(b"mp4")
        seen["files"].append(out)
        if seen.get("boom"):
            raise RuntimeError("the model failed")
        words = [{"text": "hi", "start": 0.1, "end": 0.4}] if req.speech_language else None
        return engine.ClipResult(mp4_path=out, seconds=5.04, has_audio=True, words=words)

    monkeypatch.setattr(engine, "make_clip", fake_make_clip)

    def fake_upload(path, key, content_type):
        assert os.path.exists(path)
        seen["uploads"].append((key, content_type))
        return f"https://r2.example/{key}"

    monkeypatch.setattr(storage, "upload", fake_upload)
    return seen


def test_a_valid_job_returns_the_url_the_seconds_the_sound_and_the_words(world):
    out = h.handler({"id": "job1", "input": GOOD})
    assert out == {"url": "https://r2.example/flowchain/job1.mp4", "seconds": 5.04, "has_audio": True, "words": None}
    assert world["calls"][0].frames == 121 and world["calls"][0].seed == 7


def test_a_speaking_job_returns_its_words(world):
    out = h.handler({"id": "job1", "input": {**GOOD, "speech_language": "en"}})
    assert out["words"] == [{"text": "hi", "start": 0.1, "end": 0.4}]


def test_the_clip_is_uploaded_under_flowchain_as_an_mp4(world):
    h.handler({"id": "job9", "input": GOOD})
    assert world["uploads"] == [("flowchain/job9.mp4", "video/mp4")]
    assert all(key.startswith("flowchain/") for key, _ in world["uploads"])


def test_an_unknown_field_comes_back_as_an_error_object_not_a_crash(world):
    out = h.handler({"id": "job1", "input": {**GOOD, "extra": 1}})
    assert out == {"error": "invalid request: unknown field extra"}
    assert world["calls"] == []


def test_an_input_that_is_not_an_object_is_an_error_object(world):
    assert h.handler({"id": "job1"}) == {"error": "invalid request: input must be an object"}


def test_missing_r2_settings_are_named_but_never_shown(world, monkeypatch):
    monkeypatch.delenv("R2_BUCKET")
    out = h.handler({"id": "job1", "input": GOOD})
    assert "R2_BUCKET" in out["error"] and "secret-value" not in out["error"]
    assert world["calls"] == []


def test_says_when_the_model_is_not_in_the_image(world, monkeypatch):
    monkeypatch.setattr(weights, "present", lambda *a: False)
    assert "not in this image" in h.handler({"id": "job1", "input": GOOD})["error"]
    assert world["calls"] == []


def test_joins_the_split_files_before_the_model_runs(world):
    h.handler({"id": "job1", "input": GOOD})
    assert world["order"] == ["assemble", "make"]


def test_removes_what_it_wrote_when_it_is_done(world, tmp_path):
    h.handler({"id": "job1", "input": GOOD})
    assert world["files"] and not any(os.path.exists(p) for p in world["files"])
    assert list(tmp_path.iterdir()) == []


def test_removes_what_it_wrote_when_the_model_fails(world, tmp_path):
    world["boom"] = True
    with pytest.raises(RuntimeError):
        h.handler({"id": "job1", "input": GOOD})
    assert world["files"] and not any(os.path.exists(p) for p in world["files"])
    assert list(tmp_path.iterdir()) == []
