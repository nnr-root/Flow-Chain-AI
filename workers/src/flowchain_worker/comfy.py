"""The local ComfyUI HTTP API (started by the base image's start.sh on 127.0.0.1:8188)."""

import json
import os
import time
import urllib.error
import urllib.request

COMFY = "http://127.0.0.1:8188"


def _get(path):
    with urllib.request.urlopen(f"{COMFY}{path}", timeout=30) as res:
        return json.loads(res.read() or b"null")


def wait_ready(timeout_s=600):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(f"{COMFY}/", timeout=5).close()
            return
        except (urllib.error.URLError, OSError):
            time.sleep(1)
    raise RuntimeError(f"ComfyUI did not start within {timeout_s} s")


def queue(graph):
    body = json.dumps({"prompt": graph}).encode()
    req = urllib.request.Request(f"{COMFY}/prompt", data=body, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read())["prompt_id"]
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"ComfyUI refused the graph: {err.read().decode(errors='replace')[:2000]}") from err


def interrupt():
    """Stops the prompt ComfyUI is running, so an abandoned job does not keep the GPU busy."""
    req = urllib.request.Request(f"{COMFY}/interrupt", data=b"", method="POST")
    with urllib.request.urlopen(req, timeout=10) as res:
        res.read()


def _post(path, body):
    req = urllib.request.Request(f"{COMFY}{path}", data=json.dumps(body).encode(), headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as res:
        res.read()


def forget():
    """Makes ComfyUI drop its list of the prompts it ran, with their texts (phase 5 spec §8, §9.6).

    Its nodes' cached results are left alone on purpose. They are not reachable by the next job (this handler is
    ComfyUI's only client, and answers a job with that job's own files only) and the next prompt replaces them.
    Asking ComfyUI to free them also threw away the loaded model weights: every job then loaded them again,
    which the first live run showed as a tenfold longer keyframe and three times the cost of a video.
    """
    _post("/history", {"clear": True})


def wait(prompt_id, timeout_s, poll_s=1.0):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        history = _get(f"/history/{prompt_id}") or {}
        entry = history.get(prompt_id)
        if entry is not None:
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI failed: {json.dumps(status.get('messages'))[:2000]}")
            if status.get("completed"):
                return entry
        time.sleep(poll_s)
    raise RuntimeError(f"ComfyUI did not finish prompt {prompt_id} within {timeout_s} s")


def output_files(entry, output_dir):
    """Absolute paths of every image the graph saved, in node then file order."""
    files = []
    for node_id in sorted(entry.get("outputs", {}), key=lambda k: int(k) if k.isdigit() else k):
        for image in entry["outputs"][node_id].get("images", []):
            if image.get("type") == "output":
                files.append(os.path.join(output_dir, image.get("subfolder") or "", image["filename"]))
    return files
