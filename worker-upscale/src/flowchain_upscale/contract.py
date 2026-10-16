"""The JSON contract between the Flow-Chain-AI client and the upscaling worker (phase 8 spec §8). Anything else is refused."""

import base64
import binascii

WORKFLOW = "upscale-seedvr2@1"
MAX_VIDEO_BYTES = 9 * 1024 * 1024
# the short sides a clip may be made at: full HD is the one the studio sells
SHORT_SIDES = (720, 1080)


class ContractError(ValueError):
    """The request does not follow the contract; nothing was done."""


def validate(inp):
    """Returns a normalised request dict, or raises ContractError."""
    if not isinstance(inp, dict):
        raise ContractError("input must be an object")
    task = inp.get("task")
    if task != "upscale":
        raise ContractError("task must be 'upscale'")
    if inp.get("workflow") != WORKFLOW:
        raise ContractError(f"this worker runs workflow {WORKFLOW} for task upscale")
    unknown = sorted(set(inp) - {"task", "workflow", "video", "short"})
    if unknown:
        raise ContractError(f"unknown field(s): {', '.join(unknown)}")
    short = inp.get("short")
    if short not in SHORT_SIDES or isinstance(short, bool):
        raise ContractError(f"short must be one of {', '.join(map(str, SHORT_SIDES))}")
    video = inp.get("video")
    if not isinstance(video, str):
        raise ContractError("video must be a base64 string")
    try:
        data = base64.b64decode(video, validate=True)
    except (binascii.Error, ValueError) as err:
        raise ContractError("video is not valid base64") from err
    if not data or len(data) > MAX_VIDEO_BYTES:
        raise ContractError("video must be between 1 byte and 9 MB")
    return {"task": task, "video": data, "short": short}
