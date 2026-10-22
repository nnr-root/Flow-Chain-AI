"""RunPod Serverless entry point of the upscaling worker: a clip in, the same clip in full HD and/or smoothed to twice its frame rate out (phase 8 spec §8, phase 11 spec §3).

The result is uploaded for the pipeline to fetch, which removes it once it has its own copy. The files this makes on
the worker's own disk are removed before it answers, whatever happened.
"""

import os
import time

import runpod

from flowchain_upscale import contract, engine, storage, weights, weights_rife

TMP_DIR = "/tmp"


def _remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def handler(job):
    started = time.monotonic()
    try:
        req = contract.validate(job.get("input"))
    except contract.ContractError as err:
        return {"error": f"invalid request: {err}"}
    missing = storage.missing_env()
    if missing:
        return {"error": f"R2 is not set up on this worker; missing: {', '.join(missing)}"}
    todo = engine.steps(req)
    if "upscale" in todo and not weights.present():
        return {"error": "the upscaling model is not in this image (it is built with it: see worker-upscale/Dockerfile)"}
    if "interpolate" in todo and not weights_rife.present():
        return {"error": "the interpolation model is not in this image (it is built with it: see worker-upscale/Dockerfile)"}

    job_id = job["id"]
    src = os.path.join(TMP_DIR, f"{job_id}-in.mp4")
    mid = os.path.join(TMP_DIR, f"{job_id}-mid.mp4")
    out = os.path.join(TMP_DIR, f"{job_id}.mp4")
    try:
        with open(src, "wb") as f:
            f.write(req["video"])
        # each step writes a file of its own and the next reads it, so the clip never leaves this disk between them
        current = src
        for k, step in enumerate(todo):
            target = out if k == len(todo) - 1 else mid
            if step == "upscale":
                engine.upscale(current, target, req["short"], weights.FOLDER, weights.DIT)
            else:
                engine.interpolate(current, target, req["interpolate"])
            current = target
        url = storage.upload(out, f"flowchain/{job_id}.mp4", "video/mp4")
    finally:
        for path in (src, mid, out):
            _remove(path)
    return {"url": url, "executionMs": int((time.monotonic() - started) * 1000)}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
