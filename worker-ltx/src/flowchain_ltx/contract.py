"""The JSON contract between the Flow-Chain-AI client and the LTX worker (phase 15 spec §2). Anything else is refused."""

import base64
import binascii
import math
from dataclasses import dataclass

FPS = 24
# 2 s .. 15 s at 24 fps; the model only takes 8k+1 frames
MIN_FRAMES, MAX_FRAMES = 49, 361
# the model's latent grid is 32 pixels wide and the two-stage pipeline halves the size first
SIZE_MULTIPLE = 64
MIN_SIDE, MAX_SIDE = 256, 1920
MAX_PROMPT = 4000
MAX_SEED = 2**63 - 1
SPEECH_LANGUAGES = ("en", "tr")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
FIELDS = {"task", "image", "prompt", "frames", "fps", "width", "height", "seed", "speech_language", "detect_voice"}
REQUIRED = ("image", "prompt", "frames", "fps", "width", "height", "seed")


class ContractError(ValueError):
    """The request does not follow the contract; nothing was done."""


@dataclass(frozen=True)
class ClipRequest:
    image_png: bytes
    prompt: str
    frames: int
    fps: int
    width: int
    height: int
    seed: int
    # present = run Whisper over the clip's audio and return the words with their times
    speech_language: str | None = None
    # true = listen to an ordinary clip's audio and say only whether anyone speaks in it (phase 15 spec §13.10): the
    # narrator is the only voice such a video may have. Ignored when speech_language is set: the words already tell
    detect_voice: bool = False


def frames_for_seconds(seconds: float) -> int:
    """The nearest 8k+1 that covers the seconds, kept inside the model's bounds."""
    frames = 8 * math.ceil((seconds * FPS - 1) / 8) + 1
    return max(MIN_FRAMES, min(MAX_FRAMES, frames))


def _int(inp, name, low, high):
    value = inp[name]
    # a bool is an int in Python and must not pass as a number
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ContractError(f"{name} must be an integer from {low} to {high}")
    return value


def _side(inp, name):
    value = inp[name]
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not MIN_SIDE <= value <= MAX_SIDE
        or value % SIZE_MULTIPLE
    ):
        raise ContractError(f"{name} must be a multiple of {SIZE_MULTIPLE} from {MIN_SIDE} to {MAX_SIDE}")
    return value


def _image(image):
    if not isinstance(image, str):
        raise ContractError("image must be a base64 string of a PNG")
    try:
        data = base64.b64decode(image, validate=True)
    except (binascii.Error, ValueError) as err:
        raise ContractError("image must be a base64 string of a PNG") from err
    if not data.startswith(PNG_MAGIC):
        raise ContractError("image must be a base64 string of a PNG")
    return data


def parse(payload: dict) -> ClipRequest:
    """Returns the checked request, or raises ContractError."""
    if not isinstance(payload, dict):
        raise ContractError("input must be an object")
    if payload.get("task") != "clip":
        raise ContractError("task must be 'clip'")
    for name in sorted(set(payload) - FIELDS):
        raise ContractError(f"unknown field {name}")
    for name in REQUIRED:
        if name not in payload:
            raise ContractError(f"{name} is required")
    prompt = payload["prompt"]
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT:
        raise ContractError(f"prompt must be a text of 1 to {MAX_PROMPT} characters")
    frames = _int(payload, "frames", MIN_FRAMES, MAX_FRAMES)
    if (frames - 1) % 8:
        raise ContractError(f"frames must be 8k+1 from {MIN_FRAMES} to {MAX_FRAMES}")
    if payload["fps"] != FPS or isinstance(payload["fps"], bool):
        raise ContractError(f"fps must be {FPS}")
    language = payload.get("speech_language")
    if language is not None and language not in SPEECH_LANGUAGES:
        raise ContractError(f"speech_language must be one of {', '.join(SPEECH_LANGUAGES)}")
    detect_voice = payload.get("detect_voice", False)
    if not isinstance(detect_voice, bool):
        raise ContractError("detect_voice must be true or false")
    return ClipRequest(
        image_png=_image(payload["image"]),
        prompt=prompt,
        frames=frames,
        fps=FPS,
        width=_side(payload, "width"),
        height=_side(payload, "height"),
        seed=_int(payload, "seed", 0, MAX_SEED),
        speech_language=language,
        detect_voice=detect_voice,
    )
