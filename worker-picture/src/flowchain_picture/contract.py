"""The JSON contract between the Flow-Chain-AI client and the picture worker (phase 5 spec §6.2). Anything else is refused."""

import base64
import binascii

WORKFLOW = "keyframe-klein@1"
MAX_SEED = 2**31 - 1
MAX_IMAGE_BYTES = 9 * 1024 * 1024
# the client's style presets: accepted so that its request is one shape for every picture worker, and not used
# here (one model makes every look from the words of the prompt)
PRESETS = ("cinematic_history", "anime", "cyberpunk", "dark_fantasy", "photorealistic_8k", "3d_render")


class ContractError(ValueError):
    """The request does not follow the contract; nothing was generated."""


def _int(value, name, lo, hi):
    if not isinstance(value, int) or isinstance(value, bool) or not lo <= value <= hi:
        raise ContractError(f"{name} must be an integer between {lo} and {hi}")
    return value


def validate(inp):
    """Returns a normalised request dict, or raises ContractError."""
    if not isinstance(inp, dict):
        raise ContractError("input must be an object")
    task = inp.get("task")
    if task == "fetch-models":
        unknown = sorted(set(inp) - {"task", "only"})
        if unknown:
            raise ContractError(f"unknown field(s): {', '.join(unknown)}")
        return {"task": task}
    if task != "keyframe":
        raise ContractError("task must be 'keyframe' or 'fetch-models'")
    if inp.get("workflow") != WORKFLOW:
        raise ContractError(f"this worker runs workflow {WORKFLOW} for task keyframe")
    unknown = sorted(set(inp) - {"task", "workflow", "prompt", "width", "height", "seed", "preset", "reference"})
    if unknown:
        raise ContractError(f"unknown field(s): {', '.join(unknown)}")
    prompt = inp.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 4000:
        raise ContractError("prompt must be a non-empty string of at most 4000 characters")
    req = {"task": task, "prompt": prompt, "width": _int(inp.get("width"), "width", 256, 2048), "height": _int(inp.get("height"), "height", 256, 2048)}
    if req["width"] % 16 or req["height"] % 16:
        raise ContractError("width and height must be multiples of 16")
    if inp.get("seed") is not None:
        req["seed"] = _int(inp["seed"], "seed", 0, MAX_SEED)
    if inp.get("preset") is not None and inp["preset"] not in PRESETS:
        raise ContractError(f"preset must be one of {', '.join(PRESETS)}")
    if inp.get("reference") is not None:
        ref = inp["reference"]
        if not isinstance(ref, str):
            raise ContractError("reference must be a base64 string")
        try:
            data = base64.b64decode(ref, validate=True)
        except (binascii.Error, ValueError) as err:
            raise ContractError("reference is not valid base64") from err
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise ContractError("reference must be between 1 byte and 9 MB")
        req["reference"] = data
    return req
