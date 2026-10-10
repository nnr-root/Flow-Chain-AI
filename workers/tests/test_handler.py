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
    for name, folder in (("COMFY_INPUT", "in"), ("COMFY_OUTPUT", "out"), ("COMFY_TEMP", "comfy-temp"), ("TMP_DIR", "tmp")):
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
    h.fail_forget = None

    def forget():
        h.calls.append("forget")
        if h.fail_forget:
            raise h.fail_forget

    monkeypatch.setattr(comfy, "forget", forget)
    monkeypatch.setattr(encode, "frames_to_mp4", frames_to_mp4)
    monkeypatch.setattr(storage, "upload", lambda path, key, kind: f"https://r2.example/{key}")
    h.root = tmp_path
    return h


def clip_job():
    return {"id": "j1", "input": {"task": "clip", "workflow": "clip-wan22-480p@1", "prompt": "m", "image": PNG,
                                  "frames": 33, "fps": 16, "width": 480, "height": 832}}


def secret_job():
    return {"id": "j1", "input": {**clip_job()["input"], "prompt": "a secret product launch"}}


def by_class(graph, class_type):
    return [n for n in graph.values() if n["class_type"] == class_type]


def leftovers(h):
    return sorted(str(p.relative_to(h.root)) for folder in ("in", "out", "tmp") for p in (h.root / folder).rglob("*")
                  if p.is_file())


def test_a_job_without_r2_settings_fails_before_any_gpu_work_naming_only_the_variables(worker, monkeypatch):
    job = clip_job()
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
    assert worker.handler({"id": "j", "input": {"task": "fetch-models"}}) == {"downloaded": [], "skipped": [], "removed": []}


def test_fetch_models_takes_retired_weights_off_the_volume_once_the_listed_ones_are_there(worker, monkeypatch, tmp_path):
    volume = tmp_path / "volume"
    (volume / "checkpoints").mkdir(parents=True)
    (volume / "checkpoints" / "old-sdxl.safetensors").write_bytes(b"x")
    monkeypatch.setattr(worker, "VOLUME_MODELS", str(volume))
    monkeypatch.setattr(worker.models, "load", lambda path: [])

    def failed(entries, root, only):
        raise ValueError("w.bin: size 1 / sha256 abc do not match models.json")

    # a download that fails removes nothing: the worker may still need what is there
    monkeypatch.setattr(worker.models, "fetch", failed)
    with pytest.raises(ValueError):
        worker.handler({"id": "j", "input": {"task": "fetch-models", "only": "clip"}})
    assert (volume / "checkpoints" / "old-sdxl.safetensors").exists()

    monkeypatch.setattr(worker.models, "fetch", lambda entries, root, only: {"downloaded": [], "skipped": []})
    out = worker.handler({"id": "j", "input": {"task": "fetch-models", "only": "clip"}})
    assert out["removed"] == ["old-sdxl.safetensors"] and not (volume / "checkpoints" / "old-sdxl.safetensors").exists()


def test_a_warm_up_makes_the_smallest_clip_uploads_nothing_and_leaves_nothing(worker, monkeypatch):
    for name in R2_ENV:
        monkeypatch.delenv(name)
    graphs = []
    monkeypatch.setattr(comfy, "queue", lambda graph: graphs.append(graph) or "p1")
    monkeypatch.setattr(storage, "upload", lambda *a: pytest.fail("a warm-up uploads nothing"))
    out = worker.handler({"id": "j1", "input": {"task": "warm"}})
    assert out["warmed"] is True and "url" not in out
    # the real clip graph, so every model a clip needs is loaded; at the smallest size, from a picture made here
    size = by_class(graphs[0], "WanImageToVideo")[0]["inputs"]
    assert (size["width"], size["height"], size["length"]) == (256, 256, 5)
    assert len(by_class(graphs[0], "UNETLoader")) == 2 and by_class(graphs[0], "RIFE VFI")
    assert worker.calls == ["ready", "wait", "forget"] and leftovers(worker) == []


def test_a_warm_up_that_fails_still_cleans_up_and_frees_the_gpu(worker):
    worker.fail_wait = RuntimeError("ComfyUI failed: oom")
    with pytest.raises(RuntimeError, match="oom"):
        worker.handler({"id": "j1", "input": {"task": "warm"}})
    assert worker.calls == ["ready", "wait", "interrupt", "forget"] and leftovers(worker) == []


def test_a_picture_task_is_refused_before_any_gpu_work(worker):
    out = worker.handler({"id": "j1", "input": {"task": "keyframe", "workflow": "keyframe-sdxl@1", "prompt": "a fox", "width": 1024, "height": 1024}})
    assert "task must be 'clip', 'warm' or 'fetch-models'" in out["error"] and worker.calls == []


def test_a_finished_clip_leaves_no_input_output_or_mp4_behind(worker):
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
        worker.handler(clip_job())
    assert leftovers(worker) == []


def test_a_timeout_interrupts_the_prompt_so_it_does_not_keep_the_gpu(worker):
    worker.fail_wait = RuntimeError("ComfyUI did not finish prompt p1 within 580 s")
    with pytest.raises(RuntimeError, match="did not finish"):
        worker.handler(clip_job())
    # stopped first, then forgotten: what a prompt that is still running holds cannot be cleared
    assert worker.calls == ["ready", "wait", "interrupt", "forget"]
    assert leftovers(worker) == []


def test_a_failed_interrupt_does_not_hide_the_real_error(worker, monkeypatch):
    worker.fail_wait = RuntimeError("ComfyUI failed: oom")

    def down():
        raise OSError("connection refused")

    monkeypatch.setattr(comfy, "interrupt", down)
    with pytest.raises(RuntimeError, match="ComfyUI failed: oom"):
        worker.handler(clip_job())


def test_every_job_ends_with_comfyui_forgetting_it_whether_it_worked_or_not(worker, capsys):
    (worker.root / "comfy-temp" / "preview_00001_.png").write_bytes(b"someone's frame")
    (worker.root / "comfy-temp" / "sub").mkdir()
    (worker.root / "comfy-temp" / "sub" / "latent.bin").write_bytes(b"x")
    out = worker.handler(secret_job())
    assert "url" in out
    assert worker.calls[-1] == "forget"
    assert list((worker.root / "comfy-temp").iterdir()) == []

    worker.calls.clear()
    worker.fail_wait = RuntimeError("ComfyUI failed")
    with pytest.raises(RuntimeError, match="ComfyUI failed"):
        worker.handler(secret_job())
    assert worker.calls[-1] == "forget"
    # nothing the worker itself prints carries a word of the prompt (endpoint logs are kept for 90 days)
    assert "secret" not in capsys.readouterr().out


def test_a_comfyui_that_cannot_forget_does_not_lose_the_job_and_says_so_without_its_content(worker, capsys):
    worker.fail_forget = RuntimeError("connection refused while clearing 'a secret product launch'")
    out = worker.handler(secret_job())
    assert "url" in out
    printed = capsys.readouterr().out
    assert "could not be made to forget job j1: RuntimeError" in printed
    assert "secret" not in printed

