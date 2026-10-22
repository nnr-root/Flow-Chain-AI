"""The JSON contract between the Flow-Chain-AI client and the upscaling worker (phase 8 spec §8). Anything else is refused."""

import base64
import binascii

WORKFLOW = "upscale-seedvr2@1"
# phase 11: the same worker, either step or both in one job (one upload). The old workflow above is left as it was.
WORKFLOW_RESTORE = "restore-video@1"
# the multipliers a clip may be interpolated by: twice the frames is the one the studio sells (32 fps in, 64 out)
MULTIPLIERS = (2,)
MAX_VIDEO_BYTES = 9 * 1024 * 1024
# the short sides a clip may be made at: full HD is the one the studio sells
SHORT_SIDES = (720, 1080)


class ContractError(ValueError):
    """The request does not follow the contract; nothing was done."""


def _video(inp):
    video = inp.get("video")
    if not isinstance(video, str):
        raise ContractError("video must be a base64 string")
    try:
        data = base64.b64decode(video, validate=True)
    except (binascii.Error, ValueError) as err:
        raise ContractError("video is not valid base64") from err
    if not data or len(data) > MAX_VIDEO_BYTES:
        raise ContractError("video must be between 1 byte and 9 MB")
    return data


def _short(short):
    if short not in SHORT_SIDES or isinstance(short, bool):
        raise ContractError(f"short must be one of {', '.join(map(str, SHORT_SIDES))}")
    return short


def validate(inp):
    """Returns a normalised request dict, or raises ContractError."""
    if not isinstance(inp, dict):
        raise ContractError("input must be an object")
    task = inp.get("task")
    if task != "upscale":
        raise ContractError("task must be 'upscale'")
    workflow = inp.get("workflow")
    if workflow == WORKFLOW_RESTORE:
        return _validate_restore(inp, task)
    if workflow != WORKFLOW:
        raise ContractError(f"this worker runs workflow {WORKFLOW} for task upscale (or {WORKFLOW_RESTORE})")
    unknown = sorted(set(inp) - {"task", "workflow", "video", "short"})
    if unknown:
        raise ContractError(f"unknown field(s): {', '.join(unknown)}")
    short = _short(inp.get("short"))
    return {"task": task, "video": _video(inp), "short": short}


def _validate_restore(inp, task):
    unknown = sorted(set(inp) - {"task", "workflow", "video", "short", "interpolate"})
    if unknown:
        raise ContractError(f"unknown field(s): {', '.join(unknown)}")
    short = inp.get("short")
    if short is not None:
        _short(short)
    interpolate = inp.get("interpolate")
    if interpolate is not None and (isinstance(interpolate, bool) or not isinstance(interpolate, int) or interpolate not in MULTIPLIERS):
        raise ContractError(f"interpolate must be one of {', '.join(map(str, MULTIPLIERS))}")
    if short is None and interpolate is None:
        raise ContractError("at least one of short and interpolate is required")
    return {"task": task, "video": _video(inp), "short": short, "interpolate": interpolate}
