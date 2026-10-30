import base64

import pytest

from flowchain_foley import contract

CLIP = base64.b64encode(b"mp4-bytes").decode()
MINIMAL = {
    "task": "sound",
    "workflow": "sound-foley@1",
    "video": CLIP,
    "prompt": "rain on a tin roof",
    "seed": 7,
    "guidance_scale": 4.5,
    "steps": 50,
    "audio_length": 4.2,
}
FULL = {**MINIMAL, "negative_prompt": "music, speech"}


def test_takes_a_full_request():
    req = contract.validate(FULL)
    assert req == {
        "video": b"mp4-bytes",
        "prompt": "rain on a tin roof",
        "negative_prompt": "music, speech",
        "seed": 7,
        "guidance_scale": 4.5,
        "steps": 50,
        "audio_length": 4.2,
    }


def test_takes_a_request_without_a_negative_prompt():
    assert contract.validate(MINIMAL)["negative_prompt"] is None


@pytest.mark.parametrize(
    "change, why",
    [
        ({"task": "upscale"}, "task must be"),
        ({"workflow": "sound-foley@2"}, "runs workflow sound-foley@1"),
        ({"extra": 1}, "unknown field"),
        ({"seed": -1}, "seed must be"),
        ({"seed": 2**31}, "seed must be"),
        ({"seed": 1.5}, "seed must be"),
        ({"seed": True}, "seed must be"),
        ({"guidance_scale": 0}, "guidance_scale must be"),
        ({"guidance_scale": 11}, "guidance_scale must be"),
        ({"guidance_scale": "4"}, "guidance_scale must be"),
        ({"steps": 5}, "steps must be"),
        ({"steps": 61}, "steps must be"),
        ({"steps": 20.5}, "steps must be"),
        ({"audio_length": 0}, "audio_length must be"),
        ({"audio_length": 11}, "audio_length must be"),
        ({"prompt": ""}, "prompt must be"),
        ({"prompt": "   "}, "prompt must be"),
        ({"prompt": "x" * 401}, "prompt must be"),
        ({"prompt": 5}, "prompt must be"),
        ({"negative_prompt": "x" * 401}, "negative_prompt must be"),
        ({"negative_prompt": 5}, "negative_prompt must be"),
        ({"video": "not base64!"}, "not valid base64"),
        ({"video": ""}, "between 1 byte"),
        ({"video": 5}, "base64 string"),
        ({"video": base64.b64encode(b"x" * (9 * 1024 * 1024 + 1)).decode()}, "between 1 byte"),
    ],
)
def test_refuses_what_is_not_the_contract(change, why):
    with pytest.raises(contract.ContractError, match=why):
        contract.validate({**FULL, **change})


def test_refuses_a_missing_field_by_name():
    for field in ("video", "prompt", "seed", "guidance_scale", "steps", "audio_length"):
        req = {k: v for k, v in FULL.items() if k != field}
        with pytest.raises(contract.ContractError, match=field):
            contract.validate(req)


def test_refuses_what_is_not_an_object():
    with pytest.raises(contract.ContractError, match="input must be an object"):
        contract.validate(None)


def test_accepts_the_edges():
    assert contract.validate({**MINIMAL, "seed": 0, "guidance_scale": 1, "steps": 10, "audio_length": 1, "prompt": "x" * 400})["seed"] == 0
    assert contract.validate({**MINIMAL, "seed": 2**31 - 1, "guidance_scale": 10, "steps": 60, "audio_length": 10})["steps"] == 60
