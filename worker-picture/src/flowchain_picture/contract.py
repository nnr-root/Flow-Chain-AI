"""The JSON contract between the Flow-Chain-AI client and the picture worker (phase 5 spec §6.2). Anything else is refused."""

import base64
import binascii

WORKFLOW = "keyframe-klein@1"
WORKFLOW_FLUX3 = "keyframe-flux3-klein@1"
# which engine answers which workflow: one image, two engines, each endpoint is sent only one workflow (phase 10 spec §3)
ENGINES = {WORKFLOW: "klein", WORKFLOW_FLUX3: "flux3"}
# the client sends at most three (portrait, look anchor, previous picture); one more is room, not a promise
MAX_REFERENCES = 4
MAX_SEED = 2**31 - 1
MAX_IMAGE_BYTES = 9 * 1024 * 1024
# the client's style presets: accepted so that its request is one shape for every picture worker, and not used
# here (one model makes every look from the words of the prompt)
PRESETS = (
    "cinematic_history", "anime", "cyberpunk", "dark_fantasy", "photorealistic_8k", "3d_render",
    "cartoon", "comic_book", "watercolor", "pixel_art", "film_noir", "flat_illustration", "epic_fantasy", "claymation",
)


class ContractError(ValueError):
    """The request does not follow the contract; nothing was generated."""


def _int(value, name, lo, hi):
    if not isinstance(value, int) or isinstance(value, bool) or not lo <= value <= hi:
        raise ContractError(f"{name} must be an integer between {lo} and {hi}")
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
    workflow = inp.get("workflow")
    if workflow not in ENGINES:
        # the message is the one the first workflow always had: a client and a test match it
        raise ContractError(f"this worker runs workflow {WORKFLOW} for task keyframe")
    flux3 = ENGINES[workflow] == "flux3"
    allowed = {"task", "workflow", "prompt", "width", "height", "seed", "preset", "references" if flux3 else "reference"}
    unknown = sorted(set(inp) - allowed)
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
    if flux3 and inp.get("references") is not None:
        refs = inp["references"]
        if not isinstance(refs, list):
            raise ContractError("references must be a list of base64 strings")
        if len(refs) > MAX_REFERENCES:
            raise ContractError(f"references must be at most {MAX_REFERENCES} images")
        req["references"] = [_image(r, "references") for r in refs]
    if not flux3 and inp.get("reference") is not None:
        req["reference"] = _image(inp["reference"], "reference")
    return req
