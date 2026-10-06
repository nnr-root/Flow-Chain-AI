import base64
import importlib.util
import os
import sys
import types

import pytest

from flowchain_worker import comfy, encode, storage

HERE = os.path.dirname(__file__)
PNG = base64.b64encode(b"png-bytes").decode()
R2_ENV = {"R2_ACCOUNT_ID": "acc", "R2_BUCKET": "bkt", "R2_ACCESS_KEY_ID": "AKIA-secret-id", "R2_SECRET_ACCESS_KEY": "s3cr3t"}


@pytest.fixture
def worker(tmp_path, monkeypatch):
    """handler.py with ComfyUI, ffmpeg and R2 replaced by fakes, and its folders moved into tmp_path."""
    monkeypatch.setitem(sys.modules, "runpod", types.SimpleNamespace(serverless=types.SimpleNamespace(start=None)))
    spec = importlib.util.spec_from_file_location("worker_handler", os.path.join(HERE, "..", "handler.py"))
    h = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(h)
    for name, folder in (("COMFY_INPUT", "in"), ("COMFY_OUTPUT", "out"), ("TMP_DIR", "tmp")):
        (tmp_path / folder).mkdir()
        monkeypatch.setattr(h, name, str(tmp_path / folder))
    for name, value in R2_ENV.items():
        monkeypatch.setenv(name, value)
    h.calls = []
    h.fail_wait = None

    def wait(prompt_id, timeout_s):
        h.calls.append("wait")
        if h.fail_wait:
            raise h.fail_wait
        return {}

    def output_files(entry, output_dir):
        folder = tmp_path / "out" / "flowchain" / "j1"
        folder.mkdir(parents=True, exist_ok=True)
        files = []
        for i in range(33):
            f = folder / f"out_{i:05d}_.png"
            f.write_bytes(b"frame")
            files.append(str(f))
        return files

    def frames_to_mp4(frames, fps, out):
        open(out, "wb").write(b"mp4")
        return out

    monkeypatch.setattr(comfy, "wait_ready", lambda: h.calls.append("ready"))
    monkeypatch.setattr(comfy, "queue", lambda graph: "p1")
    monkeypatch.setattr(comfy, "wait", wait)
    monkeypatch.setattr(comfy, "interrupt", lambda: h.calls.append("interrupt"), raising=False)
    monkeypatch.setattr(comfy, "output_files", output_files)
    monkeypatch.setattr(encode, "frames_to_mp4", frames_to_mp4)
    monkeypatch.setattr(storage, "upload", lambda path, key, kind: f"https://r2.example/{key}")
    h.root = tmp_path
    return h


def keyframe_job(**over):
    return {"id": "j1", "input": {"task": "keyframe", "workflow": "keyframe-sdxl@1", "prompt": "a fox",
                                  "width": 1024, "height": 1024, "reference": PNG, **over}}


def clip_job():
    return {"id": "j1", "input": {"task": "clip", "workflow": "clip-wan22-480p@1", "prompt": "m", "image": PNG,
                                  "frames": 33, "fps": 16, "width": 480, "height": 832}}


def leftovers(h):
    return sorted(str(p.relative_to(h.root)) for folder in ("in", "out", "tmp") for p in (h.root / folder).rglob("*")
                  if p.is_file())


@pytest.mark.parametrize("job", [keyframe_job(), clip_job()])
def test_a_job_without_r2_settings_fails_before_any_gpu_work_naming_only_the_variables(worker, monkeypatch, job):
    monkeypatch.delenv("R2_BUCKET")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "")
    result = worker.handler(job)
    assert "R2_BUCKET" in result["error"] and "R2_ACCESS_KEY_ID" in result["error"]
    assert "R2_ACCOUNT_ID" not in result["error"] and "AKIA" not in result["error"] and "s3cr3t" not in result["error"]
    assert worker.calls == [] and leftovers(worker) == []


def test_fetch_models_does_not_need_r2(worker, monkeypatch):
    for name in R2_ENV:
        monkeypatch.delenv(name)
    monkeypatch.setattr(worker.models, "load", lambda path: [])
    assert worker.handler({"id": "j", "input": {"task": "fetch-models"}}) == {"downloaded": [], "skipped": []}


def test_a_finished_keyframe_leaves_no_input_or_output_behind(worker):
    result = worker.handler(keyframe_job())
    assert result["url"] == "https://r2.example/flowchain/j1.png"
    assert leftovers(worker) == []


def test_a_finished_clip_removes_its_mp4_too(worker):
    result = worker.handler(clip_job())
    assert result["url"] == "https://r2.example/flowchain/j1.mp4"
    assert leftovers(worker) == []


def test_a_failed_upload_still_cleans_up(worker, monkeypatch):
    def boom(path, key, kind):
        raise RuntimeError("R2 refused")

    monkeypatch.setattr(storage, "upload", boom)
    with pytest.raises(RuntimeError, match="R2 refused"):
        worker.handler(clip_job())
    assert leftovers(worker) == []


def test_a_graph_that_cannot_be_queued_still_removes_the_written_inputs(worker, monkeypatch):
    def refuse(graph):
        raise RuntimeError("ComfyUI refused the graph")

    monkeypatch.setattr(comfy, "queue", refuse)
    with pytest.raises(RuntimeError, match="refused the graph"):
        worker.handler(keyframe_job())
    assert leftovers(worker) == []


def test_a_timeout_interrupts_the_prompt_so_it_does_not_keep_the_gpu(worker):
    worker.fail_wait = RuntimeError("ComfyUI did not finish prompt p1 within 110 s")
    with pytest.raises(RuntimeError, match="did not finish"):
        worker.handler(keyframe_job())
    assert worker.calls == ["ready", "wait", "interrupt"]
    assert leftovers(worker) == []


def test_a_failed_interrupt_does_not_hide_the_real_error(worker, monkeypatch):
    worker.fail_wait = RuntimeError("ComfyUI failed: oom")

    def down():
        raise OSError("connection refused")

    monkeypatch.setattr(comfy, "interrupt", down)
    with pytest.raises(RuntimeError, match="ComfyUI failed: oom"):
        worker.handler(keyframe_job())
