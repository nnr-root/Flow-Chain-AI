"""The JSON contract between the Flow-Chain-AI client and the Foley worker (phase 14 spec §4). Anything else is refused."""

import base64
import binascii

WORKFLOW = "sound-foley@1"
MAX_VIDEO_BYTES = 9 * 1024 * 1024
MAX_PROMPT = 400
MAX_SEED = 2**31 - 1
FIELDS = {"task", "workflow", "video", "prompt", "negative_prompt", "seed", "guidance_scale", "steps", "audio_length"}
REQUIRED = ("video", "prompt", "seed", "guidance_scale", "steps", "audio_length")


class ContractError(ValueError):
    """The request does not follow the contract; nothing was done."""


def _video(video):
    if not isinstance(video, str):
        raise ContractError("video must be a base64 string")
    try:
        data = base64.b64decode(video, validate=True)
    except (binascii.Error, ValueError) as err:
        raise ContractError("video is not valid base64") from err
    if not data or len(data) > MAX_VIDEO_BYTES:
        raise ContractError("video must be between 1 byte and 9 MB")
    return data


def _int(inp, name, low, high):
    value = inp[name]
    # a bool is an int in Python and must not pass as a number
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ContractError(f"{name} must be an integer from {low} to {high}")
    return value


def _number(inp, name, low, high):
    value = inp[name]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise ContractError(f"{name} must be a number from {low} to {high}")
    return value


def validate(inp):
    """Returns a normalised request dict, or raises ContractError."""
    if not isinstance(inp, dict):
        raise ContractError("input must be an object")
    if inp.get("task") != "sound":
        raise ContractError("task must be 'sound'")
    if inp.get("workflow") != WORKFLOW:
        raise ContractError(f"this worker runs workflow {WORKFLOW}")
    unknown = sorted(set(inp) - FIELDS)
    if unknown:
        raise ContractError(f"unknown field(s): {', '.join(unknown)}")
    for name in REQUIRED:
        if name not in inp:
            raise ContractError(f"{name} is required")
    prompt = inp["prompt"]
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT:
        raise ContractError(f"prompt must be a text of 1 to {MAX_PROMPT} characters")
    negative = inp.get("negative_prompt")
    if negative is not None and (not isinstance(negative, str) or len(negative) > MAX_PROMPT):
        raise ContractError(f"negative_prompt must be a text of at most {MAX_PROMPT} characters")
    return {
        "video": _video(inp["video"]),
        "prompt": prompt,
        "negative_prompt": negative,
        "seed": _int(inp, "seed", 0, MAX_SEED),
        "guidance_scale": _number(inp, "guidance_scale", 1, 10),
        "steps": _int(inp, "steps", 10, 60),
        "audio_length": _number(inp, "audio_length", 1, 10),
    }
