"""The JSON contract between the Flow-Chain-AI client and this worker (2.4 spec §3.2). Anything else is refused."""

import base64
import binascii

PRESETS = ("cinematic_history", "anime", "cyberpunk", "dark_fantasy", "photorealistic_8k", "3d_render")
WORKFLOWS = {"keyframe": "keyframe-sdxl@1", "clip": "clip-wan22-480p@1"}
MAX_SEED = 2**31 - 1
MAX_IMAGE_BYTES = 9 * 1024 * 1024
CLIP_SIZES = ((480, 832), (832, 480))


class ContractError(ValueError):
    """The request does not follow the contract; nothing was generated."""


def _int(value, name, lo, hi):
    if not isinstance(value, int) or isinstance(value, bool) or not lo <= value <= hi:
        raise ContractError(f"{name} must be an integer between {lo} and {hi}")
    return value


def _text(value, name, max_len=4000):
    if not isinstance(value, str) or not value.strip() or len(value) > max_len:
        raise ContractError(f"{name} must be a non-empty string of at most {max_len} characters")
    return value


def _image(value, name):
    if not isinstance(value, str):
        raise ContractError(f"{name} must be a base64 string")
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as err:
        raise ContractError(f"{name} is not valid base64") from err
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ContractError(f"{name} must be between 1 byte and 9 MB")
    return data


def _only(inp, allowed):
    unknown = sorted(set(inp) - set(allowed))
    if unknown:
        raise ContractError(f"unknown field(s): {', '.join(unknown)}")


def validate(inp):
    """Returns a normalised request dict, or raises ContractError."""
    if not isinstance(inp, dict):
        raise ContractError("input must be an object")
    task = inp.get("task")
    if task == "fetch-models":
        _only(inp, ("task", "only"))
        only = inp.get("only")
        if only is not None and only not in WORKFLOWS:
            raise ContractError("only must be 'keyframe' or 'clip'")
        return {"task": task, "only": only}
    if task not in WORKFLOWS:
        raise ContractError("task must be 'keyframe', 'clip' or 'fetch-models'")
    if inp.get("workflow") != WORKFLOWS[task]:
        raise ContractError(f"this worker runs workflow {WORKFLOWS[task]} for task {task}")
    seed = inp.get("seed")
    req = {"task": task, "workflow": inp["workflow"], "prompt": _text(inp.get("prompt"), "prompt")}
    if seed is not None:
        req["seed"] = _int(seed, "seed", 0, MAX_SEED)
    if task == "keyframe":
        _only(inp, ("task", "workflow", "prompt", "width", "height", "seed", "preset", "reference"))
        req["width"] = _int(inp.get("width"), "width", 256, 2048)
        req["height"] = _int(inp.get("height"), "height", 256, 2048)
        if req["width"] % 8 or req["height"] % 8:
            raise ContractError("width and height must be multiples of 8")
        preset = inp.get("preset")
        if preset is not None and preset not in PRESETS:
            raise ContractError(f"preset must be one of {', '.join(PRESETS)}")
        req["preset"] = preset
        if inp.get("reference") is not None:
            req["reference"] = _image(inp["reference"], "reference")
        return req
    _only(inp, ("task", "workflow", "prompt", "image", "frames", "fps", "width", "height", "seed"))
    req["image"] = _image(inp.get("image"), "image")
    frames = _int(inp.get("frames"), "frames", 33, 81)
    if (frames - 1) % 4:
        raise ContractError("frames must be 4k+1")
    req["frames"] = frames
    if inp.get("fps") != 16:
        raise ContractError("fps must be 16")
    req["fps"] = 16
    size = (inp.get("width"), inp.get("height"))
    if size not in CLIP_SIZES:
        raise ContractError("width × height must be 480 × 832 or 832 × 480")
    req["width"], req["height"] = size
    return req
