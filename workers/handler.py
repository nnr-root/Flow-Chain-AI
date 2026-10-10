"""RunPod Serverless entry point (started by the base image's /start.sh as /handler.py)."""

import os
import random
import shutil
import time

import runpod

from flowchain_worker import comfy, contract, encode, models, storage
from flowchain_worker.workflows import RIFE_MULTIPLIER, clip_graph

COMFY_INPUT = "/comfyui/input"
COMFY_OUTPUT = "/comfyui/output"
COMFY_TEMP = "/comfyui/temp"
TMP_DIR = "/tmp"
VOLUME_MODELS = "/runpod-volume/models"
MODELS_JSON = "/flowchain/models.json"
# what the image itself holds of the clip model (the Dockerfile puts them there)
IMAGE_MODELS = ("/comfyui/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", "/comfyui/models/vae/wan_2.1_vae.safetensors")
TIMEOUT_S = 580


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


def _forget(job_id):
    """After every job, however it ended: nothing of it stays in ComfyUI or on this worker's disk."""
    try:
        comfy.forget()
    except Exception as err:  # the job's own result or error is what is answered; this is said, without any of its content
        print(f"flowchain: ComfyUI could not be made to forget job {job_id}: {type(err).__name__}", flush=True)
    shutil.rmtree(os.path.join(COMFY_OUTPUT, "flowchain", job_id), ignore_errors=True)
    # previews and other scratch files ComfyUI's nodes write are not named by job: the folder is emptied
    for name in os.listdir(COMFY_TEMP) if os.path.isdir(COMFY_TEMP) else []:
        path = os.path.join(COMFY_TEMP, name)
        shutil.rmtree(path, ignore_errors=True) if os.path.isdir(path) else _remove(path)


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
        entries = models.load(MODELS_JSON)
        done = models.fetch(entries, VOLUME_MODELS, req["only"])
        # only once everything listed is there and checked: a failed download removes nothing
        return {**done, "removed": models.purge(entries, VOLUME_MODELS)}

    if req["task"] == "warm":
        # Asked for while a run's pictures are made: the worker is up and its files are read by the time the first
        # clip comes (phase 5 spec §9.15). Nothing of anyone's is in this job, and it leaves nothing behind.
        comfy.wait_ready()
        files = [*IMAGE_MODELS, *(models.target(VOLUME_MODELS, e) for e in models.load(MODELS_JSON))]
        return {"warmedBytes": models.read_through(files), "executionMs": int((time.monotonic() - started) * 1000)}

    missing = storage.missing_env()
    if missing:
        return {"error": f"R2 is not set up on this worker; missing: {', '.join(missing)}"}

    job_id = job["id"]
    seed = req.get("seed", random.randrange(contract.MAX_SEED + 1))
    prefix = f"flowchain/{job_id}/out"
    comfy.wait_ready()
    mp4 = os.path.join(TMP_DIR, f"{job_id}.mp4")
    try:
        graph = clip_graph(req, seed=seed, prefix=prefix, image_file=_write_input(job_id, "image", req["image"]))
        prompt_id = comfy.queue(graph)
        try:
            entry = comfy.wait(prompt_id, TIMEOUT_S)
        except Exception:
            _interrupt_quietly()  # a timed-out prompt would otherwise keep the GPU busy for the next job
            raise
        files = comfy.output_files(entry, COMFY_OUTPUT)
        result = encode.frames_to_mp4(files, req["fps"] * RIFE_MULTIPLIER, mp4)
        url = storage.upload(result, f"flowchain/{job_id}.mp4", "video/mp4")
    finally:
        _forget(job_id)
        _remove(os.path.join(COMFY_INPUT, f"flowchain/{job_id}-image.png"))
        _remove(mp4)
    return {"url": url, "seed": seed, "executionMs": int((time.monotonic() - started) * 1000)}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
