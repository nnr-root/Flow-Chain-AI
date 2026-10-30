import base64
import os
import sys

import pytest

sys.modules.setdefault("runpod", type(sys)("runpod"))  # the RunPod library is only in the image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import handler as h  # noqa: E402

from flowchain_foley import engine, storage, weights  # noqa: E402

GOOD = {
    "task": "sound",
    "workflow": "sound-foley@1",
    "video": base64.b64encode(b"mp4-bytes").decode(),
    "prompt": "rain",
    "seed": 3,
    "guidance_scale": 4.5,
    "steps": 30,
    "audio_length": 2,
}


@pytest.fixture
def world(monkeypatch, tmp_path):
    seen = {"files": [], "uploads": [], "calls": [], "order": []}
    monkeypatch.setattr(h, "TMP_DIR", str(tmp_path))
    for name in storage.REQUIRED_ENV:
        monkeypatch.setenv(name, "secret-value")
    monkeypatch.setattr(weights, "present", lambda root=weights.ROOT: True)
    monkeypatch.setattr(weights, "assemble", lambda root=weights.ROOT: seen["order"].append("assemble"))

    def fake_model(root, loader=None):
        seen["order"].append("load")
        return "MODEL"

    monkeypatch.setattr(engine, "model", fake_model)

    def fake_sound(model, video_path, prompt, negative_prompt, seed, guidance_scale, steps, audio_length, out_path, sampler=None):
        seen["calls"].append((model, prompt, negative_prompt, seed, guidance_scale, steps, audio_length))
        seen["files"] += [video_path, out_path]
        assert os.path.exists(video_path)
        open(out_path, "wb").write(b"RIFF")
        if seen.get("boom"):
            raise RuntimeError("the model failed")
        return {"seed": seed, "seconds": 2.0}

    monkeypatch.setattr(engine, "sound", fake_sound)

    def fake_upload(path, key, content_type):
        seen["uploads"].append((key, content_type))
        return f"https://r2.example/{key}"

    monkeypatch.setattr(storage, "upload", fake_upload)
    return seen


def test_a_good_request_returns_the_url_the_seed_the_seconds_and_the_time(world):
    out = h.handler({"id": "job1", "input": GOOD})
    assert out["url"] == "https://r2.example/flowchain/job1.wav"
    assert (out["seed"], out["seconds"]) == (3, 2.0)
    assert isinstance(out["executionMs"], int)
    assert world["uploads"] == [("flowchain/job1.wav", "audio/wav")]
    assert world["calls"] == [("MODEL", "rain", None, 3, 4.5, 30, 2)]


def test_an_invalid_request_answers_with_why(world):
    out = h.handler({"id": "job1", "input": {**GOOD, "steps": 3}})
    assert out == {"error": "invalid request: steps must be an integer from 10 to 60"}
    assert world["calls"] == []


def test_missing_r2_settings_are_named_but_never_shown(world, monkeypatch):
    monkeypatch.delenv("R2_BUCKET")
    out = h.handler({"id": "job1", "input": GOOD})
    assert "R2_BUCKET" in out["error"] and "secret-value" not in out["error"]


def test_says_when_the_model_is_not_in_the_image(world, monkeypatch):
    monkeypatch.setattr(weights, "present", lambda root=weights.ROOT: False)
    assert "not in this image" in h.handler({"id": "job1", "input": GOOD})["error"]


def test_removes_what_it_wrote_when_it_is_done(world):
    h.handler({"id": "job1", "input": GOOD})
    assert world["files"] and not any(os.path.exists(p) for p in world["files"])


def test_removes_what_it_wrote_when_the_model_fails(world):
    world["boom"] = True
    with pytest.raises(RuntimeError):
        h.handler({"id": "job1", "input": GOOD})
    assert world["files"] and not any(os.path.exists(p) for p in world["files"])


def test_joins_the_model_before_it_is_loaded(world):
    h.handler({"id": "job1", "input": GOOD})
    assert world["order"] == ["assemble", "load"]
