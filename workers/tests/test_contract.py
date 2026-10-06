import base64
import re

import pytest

from flowchain_worker.contract import ContractError, validate

PNG = base64.b64encode(b"\x89PNG fake").decode()


def keyframe(**over):
    return {"task": "keyframe", "workflow": "keyframe-sdxl@1", "prompt": "a fox", "width": 1088, "height": 1920, **over}


def clip(**over):
    return {"task": "clip", "workflow": "clip-wan22-480p@1", "prompt": "it runs", "image": PNG, "frames": 81, "fps": 16,
            "width": 480, "height": 832, **over}


def test_accepts_a_keyframe_with_preset_seed_and_reference():
    req = validate(keyframe(preset="anime", seed=7, reference=PNG))
    assert req["preset"] == "anime" and req["seed"] == 7 and req["reference"] == b"\x89PNG fake"


def test_accepts_a_clip_and_fetch_models():
    assert validate(clip())["frames"] == 81
    assert validate({"task": "fetch-models", "only": "clip"}) == {"task": "fetch-models", "only": "clip"}


@pytest.mark.parametrize(
    "bad, message",
    [
        (keyframe(workflow="keyframe-sdxl@2"), "runs workflow keyframe-sdxl@1"),
        (keyframe(width=1090), "multiples of 8"),
        (keyframe(preset="pony"), "preset must be one of"),
        (keyframe(seed=2**31), "seed must be an integer"),
        (keyframe(extra=1), "unknown field(s): extra"),
        (keyframe(reference="not base64!"), "reference is not valid base64"),
        (clip(frames=80), "frames must be 4k+1"),
        (clip(frames=85), "frames must be an integer between 33 and 81"),
        (clip(fps=24), "fps must be 16"),
        (clip(width=720, height=1280), "480 × 832 or 832 × 480"),
        ({"task": "train"}, "task must be"),
        ({"task": "fetch-models", "only": "both"}, "only must be"),
    ],
)
def test_refuses_anything_outside_the_contract(bad, message):
    with pytest.raises(ContractError, match=re.escape(message)):
        validate(bad)
