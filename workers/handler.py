"""RunPod Serverless entry point (started by the base image's /start.sh as /handler.py)."""

import os
import random
import shutil
import time

import runpod

from flowchain_worker import comfy, contract, encode, models, storage
from flowchain_worker.workflows import RIFE_MULTIPLIER, clip_graph, keyframe_graph

COMFY_INPUT = "/comfyui/input"
COMFY_OUTPUT = "/comfyui/output"
TMP_DIR = "/tmp"
VOLUME_MODELS = "/runpod-volume/models"
MODELS_JSON = "/flowchain/models.json"
TIMEOUT_S = {"keyframe": 110, "clip": 580}


def _write_input(job_id, name, data):
    rel = f"flowchain/{job_id}-{name}.png"
    path = os.path.join(COMFY_INPUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return rel


def _remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def _interrupt_quietly():
    try:
        comfy.interrupt()
    except Exception:  # best effort: the job's own error is the one worth reporting
        pass


def handler(job):
    started = time.monotonic()
    try:
        req = contract.validate(job.get("input"))
    except contract.ContractError as err:
        return {"error": f"invalid request: {err}"}
    if req["task"] == "fetch-models":
        return models.fetch(models.load(MODELS_JSON), VOLUME_MODELS, req["only"])

    missing = storage.missing_env()
    if missing:
        return {"error": f"R2 is not set up on this worker; missing: {', '.join(missing)}"}

    job_id = job["id"]
    seed = req.get("seed", random.randrange(contract.MAX_SEED + 1))
    prefix = f"flowchain/{job_id}/out"
    comfy.wait_ready()
    mp4 = os.path.join(TMP_DIR, f"{job_id}.mp4")
    try:
        if req["task"] == "keyframe":
            ref = _write_input(job_id, "reference", req["reference"]) if "reference" in req else None
            graph = keyframe_graph(req, seed=seed, prefix=prefix, reference_file=ref)
        else:
            graph = clip_graph(req, seed=seed, prefix=prefix, image_file=_write_input(job_id, "image", req["image"]))
        prompt_id = comfy.queue(graph)
        try:
            entry = comfy.wait(prompt_id, TIMEOUT_S[req["task"]])
        except Exception:
            _interrupt_quietly()  # a timed-out prompt would otherwise keep the GPU busy for the next job
            raise
        files = comfy.output_files(entry, COMFY_OUTPUT)
        if req["task"] == "keyframe":
            result, ext, kind = files[-1], "png", "image/png"
        else:
            result = encode.frames_to_mp4(files, req["fps"] * RIFE_MULTIPLIER, mp4)
            ext, kind = "mp4", "video/mp4"
        url = storage.upload(result, f"flowchain/{job_id}.{ext}", kind)
    finally:
        shutil.rmtree(os.path.join(COMFY_OUTPUT, "flowchain", job_id), ignore_errors=True)
        for name in ("reference", "image"):
            _remove(os.path.join(COMFY_INPUT, f"flowchain/{job_id}-{name}.png"))
        _remove(mp4)
    return {"url": url, "seed": seed, "executionMs": int((time.monotonic() - started) * 1000)}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
