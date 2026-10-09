import base64
import re

import pytest

from flowchain_worker.contract import ContractError, validate

PNG = base64.b64encode(b"\x89PNG fake").decode()


def clip(**over):
    return {"task": "clip", "workflow": "clip-wan22-480p@1", "prompt": "it runs", "image": PNG, "frames": 81, "fps": 16,
            "width": 480, "height": 832, **over}


def test_accepts_a_clip_and_fetch_models():
    assert validate(clip())["frames"] == 81
    assert validate(clip(seed=7))["seed"] == 7
    assert validate({"task": "fetch-models", "only": "clip"}) == {"task": "fetch-models", "only": "clip"}


@pytest.mark.parametrize(
    "bad, message",
    [
        (clip(workflow="clip-wan22-480p@2"), "runs workflow clip-wan22-480p@1"),
        (clip(seed=2**31), "seed must be an integer"),
        (clip(extra=1), "unknown field(s): extra"),
        (clip(image="not base64!"), "image is not valid base64"),
        # pictures are another worker's: the task this one had is refused like any unknown one
        ({"task": "keyframe", "workflow": "keyframe-sdxl@1", "prompt": "a fox", "width": 1088, "height": 1920}, "task must be 'clip' or 'fetch-models'"),
        ({"task": "fetch-models", "only": "keyframe"}, "only must be"),
        (clip(frames=80), "frames must be 4k+1"),
        (clip(frames=85), "frames must be an integer between 33 and 81"),
        (clip(fps=24), "fps must be 16"),
        (clip(width=1080, height=1920), "480 × 832 or 720 × 1280"),
        (clip(width=720, height=832), "480 × 832 or 720 × 1280"),
        ({"task": "train"}, "task must be"),
        ({"task": "fetch-models", "only": "both"}, "only must be"),
    ],
)
def test_refuses_anything_outside_the_contract(bad, message):
    with pytest.raises(ContractError, match=re.escape(message)):
        validate(bad)


def test_takes_a_clip_at_480p_or_720p_upright_or_on_its_side():
    for size in ((480, 832), (832, 480), (720, 1280), (1280, 720)):
        req = validate(clip(width=size[0], height=size[1]))
        assert (req["width"], req["height"]) == size

