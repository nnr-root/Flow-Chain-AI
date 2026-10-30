"""RunPod Serverless entry point of the Foley worker: a small video of a scene and a prompt in, the scene's sound out (phase 14 spec §4).

The sound is uploaded for the pipeline to fetch, which removes it once it has its own copy. The files this makes on
the worker's own disk are removed before it answers, whatever happened.
"""

import os
import time

import runpod

from flowchain_foley import contract, engine, storage, weights

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
    if not weights.present(weights.ROOT):
        return {"error": "the sound model is not in this image (it is built with it: see worker-foley/Dockerfile)"}

    job_id = job["id"]
    src = os.path.join(TMP_DIR, f"{job_id}.mp4")
    out = os.path.join(TMP_DIR, f"{job_id}.wav")
    try:
        with open(src, "wb") as f:
            f.write(req["video"])
        loaded = engine.model(weights.ROOT)
        made = engine.sound(
            loaded, src, req["prompt"], req["negative_prompt"], req["seed"], req["guidance_scale"], req["steps"], req["audio_length"], out
        )
        url = storage.upload(out, f"flowchain/{job_id}.wav", "audio/wav")
    finally:
        for path in (src, out):
            _remove(path)
    return {"url": url, "seed": made["seed"], "seconds": made["seconds"], "executionMs": int((time.monotonic() - started) * 1000)}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
