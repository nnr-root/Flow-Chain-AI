import base64

import pytest

from flowchain_ltx import contract

PNG = b"\x89PNG\r\n\x1a\n" + b"pixels"
MINIMAL = {
    "task": "clip",
    "image": base64.b64encode(PNG).decode(),
    "prompt": "a fox runs through snow",
    "frames": 121,
    "fps": 24,
    "width": 704,
    "height": 1216,
    "seed": 7,
}


def test_takes_a_request_without_speech():
    req = contract.parse(MINIMAL)
    assert req == contract.ClipRequest(
        image_png=PNG, prompt="a fox runs through snow", frames=121, fps=24, width=704, height=1216, seed=7, speech_language=None
    )


@pytest.mark.parametrize("language", ["en", "tr"])
def test_takes_a_speech_language(language):
    assert contract.parse({**MINIMAL, "speech_language": language}).speech_language == language


def test_a_request_that_does_not_ask_to_detect_a_voice_does_not():
    assert contract.parse(MINIMAL).detect_voice is False


@pytest.mark.parametrize("value", [True, False])
def test_takes_detect_voice_as_a_bool(value):
    assert contract.parse({**MINIMAL, "detect_voice": value}).detect_voice is value


def test_takes_detect_voice_together_with_a_speech_language():
    req = contract.parse({**MINIMAL, "detect_voice": True, "speech_language": "en"})
    assert (req.detect_voice, req.speech_language) == (True, "en")


@pytest.mark.parametrize(
    "change, why",
    [
        ({"task": "sound"}, "task must be 'clip'"),
        ({"extra": 1}, "unknown field extra"),
        ({"frames": 48}, "frames must be"),
        ({"frames": 50}, "frames must be"),
        ({"frames": 362}, "frames must be"),
        ({"frames": 0}, "frames must be"),
        ({"frames": 97.0}, "frames must be"),
        ({"frames": True}, "frames must be"),
        ({"fps": 30}, "fps must be 24"),
        ({"width": 700}, "width must be"),
        ({"width": 192}, "width must be"),
        ({"width": 1984}, "width must be"),
        ({"height": 1000}, "height must be"),
        ({"height": 0}, "height must be"),
        ({"height": 1984}, "height must be"),
        ({"prompt": ""}, "prompt must be"),
        ({"prompt": "x" * 4001}, "prompt must be"),
        ({"prompt": 5}, "prompt must be"),
        ({"image": ""}, "image must be"),
        ({"image": "not base64!"}, "image must be"),
        ({"image": 5}, "image must be"),
        ({"image": base64.b64encode(b"GIF89a-not-a-png").decode()}, "image must be"),
        ({"seed": -1}, "seed must be"),
        ({"seed": 1.5}, "seed must be"),
        ({"seed": True}, "seed must be"),
        ({"speech_language": "de"}, "speech_language must be"),
        ({"speech_language": ""}, "speech_language must be"),
        ({"detect_voice": 1}, "detect_voice must be"),
        ({"detect_voice": "yes"}, "detect_voice must be"),
        ({"detect_voice": None}, "detect_voice must be"),
    ],
)
def test_refuses_what_is_not_the_contract(change, why):
    with pytest.raises(contract.ContractError, match=why):
        contract.parse({**MINIMAL, **change})


def test_refuses_a_missing_field_by_name():
    for field in ("image", "prompt", "frames", "fps", "width", "height", "seed"):
        req = {k: v for k, v in MINIMAL.items() if k != field}
        with pytest.raises(contract.ContractError, match=f"{field} is required"):
            contract.parse(req)


def test_refuses_what_is_not_an_object():
    with pytest.raises(contract.ContractError, match="input must be an object"):
        contract.parse(None)


def test_accepts_the_edges():
    for frames in (49, 97, 361):
        assert contract.parse({**MINIMAL, "frames": frames}).frames == frames
    assert contract.parse({**MINIMAL, "width": 256, "height": 1920, "seed": 0, "prompt": "x" * 4000}).height == 1920


@pytest.mark.parametrize("seconds, frames", [(2.0, 49), (5.04, 121), (15.0, 361), (0.5, 49), (20.0, 361)])
def test_turns_seconds_into_frames(seconds, frames):
    assert contract.frames_for_seconds(seconds) == frames


def test_every_length_is_eight_k_plus_one_and_covers_its_seconds():
    for tenth in range(1, 250):
        seconds = tenth / 10
        n = contract.frames_for_seconds(seconds)
        assert (n - 1) % 8 == 0
        assert contract.MIN_FRAMES <= n <= contract.MAX_FRAMES
        if 2.0 <= seconds <= 15.0:
            assert n >= seconds * contract.FPS
