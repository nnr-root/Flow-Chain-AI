"""RunPod Serverless entry point of the LTX worker: a start frame and a prompt in, a clip with its sound (and the words
spoken in it, when asked) out (phase 15 spec §2, §13.1).

The clip is uploaded for the pipeline to fetch, which removes it once it has its own copy. The files this makes on the
worker's own disk are removed before it answers, whatever happened.
"""

import os
import shutil

import runpod

from flowchain_ltx import contract, engine, storage, weights

TMP_DIR = "/tmp"


def handler(job):
    try:
        req = contract.parse(job.get("input"))
    except contract.ContractError as err:
        return {"error": f"invalid request: {err}"}
    missing = storage.missing_env()
    if missing:
        return {"error": f"R2 is not set up on this worker; missing: {', '.join(missing)}"}
    if not weights.present(weights.ROOT, weights.WHISPER_ROOT):
        return {"error": "the clip model is not in this image (it is built with it: see worker-ltx/Dockerfile)"}

    job_id = job["id"]
    workdir = os.path.join(TMP_DIR, f"ltx-{job_id}")
    os.makedirs(workdir, exist_ok=True)
    try:
        # the image holds the transformer and the text encoder in parts (GHCR's layer limit); joining them is a one-time
        # copy at a cold start, and the model is loaded once per worker
        weights.assemble(weights.ROOT)
        made = engine.make_clip(req, workdir=workdir)
        url = storage.upload(made.mp4_path, f"flowchain/{job_id}.mp4", "video/mp4")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    out = {"url": url, "seconds": made.seconds, "has_audio": made.has_audio, "words": made.words}
    # only when a voice check was asked and made: a client that never asked keeps the answer it always had
    if made.voice_heard is not None:
        out["voice_heard"] = made.voice_heard
    return out


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
