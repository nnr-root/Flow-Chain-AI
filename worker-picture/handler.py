"""RunPod Serverless entry point of the picture worker: a prompt (and, for a character, a portrait) in, one picture out.

The picture is uploaded for the pipeline to fetch, which removes it once it has its own copy. The files this
makes on the worker's own disk are removed before it answers, whatever happened (phase 5 spec §8).
"""

import os
import random
import time

import runpod

from flowchain_picture import contract, engine, storage, weights

VOLUME_MODELS = "/runpod-volume/models"
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
    if req["task"] == "fetch-models":
        return weights.fetch(VOLUME_MODELS)

    missing = storage.missing_env()
    if missing:
        return {"error": f"R2 is not set up on this worker; missing: {', '.join(missing)}"}
    if not weights.present(VOLUME_MODELS):
        return {"error": "the picture model is not on the volume yet (run the fetch-models task: npm run runpod:deploy)"}

    job_id = job["id"]
    seed = req.get("seed", random.randrange(contract.MAX_SEED + 1))
    out = os.path.join(TMP_DIR, f"{job_id}.png")
    ref = os.path.join(TMP_DIR, f"{job_id}-reference.png") if "reference" in req else None
    try:
        if ref:
            with open(ref, "wb") as f:
                f.write(req["reference"])
        engine.picture(weights.folder(VOLUME_MODELS), req["prompt"], req["width"], req["height"], seed, ref, out)
        url = storage.upload(out, f"flowchain/{job_id}.png", "image/png")
    finally:
        _remove(out)
        if ref:
            _remove(ref)
    return {"url": url, "seed": seed, "executionMs": int((time.monotonic() - started) * 1000)}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
