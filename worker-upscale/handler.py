"""RunPod Serverless entry point of the upscaling worker: a clip in, the same clip in full HD out (phase 8 spec §8).

The result is uploaded for the pipeline to fetch, which removes it once it has its own copy. The files this makes on
the worker's own disk are removed before it answers, whatever happened.
"""

import os
import time

import runpod

from flowchain_upscale import contract, engine, storage, weights

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
    if not weights.present():
        return {"error": "the upscaling model is not in this image (it is built with it: see worker-upscale/Dockerfile)"}

    job_id = job["id"]
    src = os.path.join(TMP_DIR, f"{job_id}-in.mp4")
    out = os.path.join(TMP_DIR, f"{job_id}.mp4")
    try:
        with open(src, "wb") as f:
            f.write(req["video"])
        engine.upscale(src, out, req["short"], weights.FOLDER, weights.DIT)
        url = storage.upload(out, f"flowchain/{job_id}.mp4", "video/mp4")
    finally:
        _remove(src)
        _remove(out)
    return {"url": url, "executionMs": int((time.monotonic() - started) * 1000)}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
