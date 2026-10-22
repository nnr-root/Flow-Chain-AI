import base64
import os
import sys
import types

import pytest

from flowchain_upscale import contract, engine, storage, weights, weights_rife

CLIP = base64.b64encode(b"mp4-bytes").decode()
OLD = {"task": "upscale", "workflow": "upscale-seedvr2@1", "video": CLIP, "short": 1080}
NEW = {"task": "upscale", "workflow": "restore-video@1", "video": CLIP, "short": 1080, "interpolate": 2}


def test_the_old_workflow_is_exactly_what_it_was():
    assert contract.validate(OLD) == {"task": "upscale", "video": b"mp4-bytes", "short": 1080}
    with pytest.raises(contract.ContractError, match="unknown field"):
        contract.validate({**OLD, "interpolate": 2})
    with pytest.raises(contract.ContractError, match="short must be"):
        contract.validate({k: v for k, v in OLD.items() if k != "short"})
    with pytest.raises(contract.ContractError, match="runs workflow upscale-seedvr2@1 for task upscale"):
        contract.validate({**OLD, "workflow": "upscale-seedvr2@2"})


def test_the_new_workflow_takes_either_step_or_both():
    assert contract.validate(NEW) == {"task": "upscale", "video": b"mp4-bytes", "short": 1080, "interpolate": 2}
    only_up = {k: v for k, v in NEW.items() if k != "interpolate"}
    assert contract.validate(only_up) == {"task": "upscale", "video": b"mp4-bytes", "short": 1080, "interpolate": None}
    only_rife = {k: v for k, v in NEW.items() if k != "short"}
    assert contract.validate(only_rife) == {"task": "upscale", "video": b"mp4-bytes", "short": None, "interpolate": 2}


@pytest.mark.parametrize(
    "change, why",
    [
        ({"short": None, "interpolate": None}, "at least one"),
        ({"interpolate": 3}, "interpolate must be"),
        ({"interpolate": True}, "interpolate must be"),
        ({"interpolate": "2"}, "interpolate must be"),
        ({"short": 2160}, "short must be"),
        ({"short": True}, "short must be"),
        ({"video": ""}, "between 1 byte"),
        ({"video": "not base64!"}, "not valid base64"),
        ({"prompt": "x"}, "unknown field"),
        ({"workflow": "restore-video@2"}, "runs workflow"),
    ],
)
def test_refuses_what_is_not_the_new_contract(change, why):
    inp = {**NEW, **change}
    inp = {k: v for k, v in inp.items() if v is not None}
    with pytest.raises(contract.ContractError, match=why):
        contract.validate(inp)


def test_runs_the_steps_in_the_order_that_keeps_one_file_on_the_disk():
    assert engine.steps({"short": 1080, "interpolate": 2}) == ["upscale", "interpolate"]
    assert engine.steps({"short": 1080, "interpolate": None}) == ["upscale"]
    assert engine.steps({"short": None, "interpolate": 2}) == ["interpolate"]
    # a request of the old workflow has no interpolate key at all
    assert engine.steps({"short": 1080}) == ["upscale"]


def test_builds_the_interpolation_command_the_pages_show():
    cmd = engine.rife_command("/tmp/a.mp4", "/tmp/b.mp4", 2, 64)
    # spec 3.1: the program's own virtualenv, the model folder given absolutely, --fps always (it skips the audio step)
    assert cmd == [
        "/rife/.venv/bin/python", "/rife/inference_video.py",
        "--multi=2", "--video=/tmp/a.mp4", "--output=/tmp/b.mp4", "--model=/rife/train_log", "--fps=64",
    ]
    assert cmd[0] == weights_rife.PYTHON
    assert not any(part.startswith(("--fp16", "--scale")) for part in cmd)


def test_re_encodes_rifes_mpeg4_to_h264():
    cmd = engine.reencode_command("/tmp/a.mp4", "/tmp/b.mp4", 64)
    joined = " ".join(cmd)
    assert cmd[0] == "ffmpeg" and "-y" in cmd
    for part in ["-i /tmp/a.mp4", "-c:v libx264", "-preset medium", "-crf 16", "-pix_fmt yuv420p", "-r 64", "-an"]:
        assert part in joined
    assert cmd[-1] == "/tmp/b.mp4"


class Done:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


class Runner:
    """Records every command, answers ffprobe with a rate, and makes the file a command is told to write."""

    def __init__(self, rate="32/1", fail_on=None, tail="CUDA out of memory"):
        self.commands, self.rate, self.fail_on, self.tail = [], rate, fail_on, tail

    def __call__(self, cmd, **kwargs):
        self.commands.append(cmd)
        if cmd[0] == "ffprobe":
            return Done(stdout=self.rate + "\n")
        which = "rife" if cmd[0] == weights_rife.PYTHON else "ffmpeg"
        out = cmd[-1] if which == "ffmpeg" else next(p for p in cmd if p.startswith("--output=")).split("=", 1)[1]
        with open(out, "wb") as f:
            f.write(which.encode())
        if which == self.fail_on:
            return Done(returncode=1, stderr=self.tail)
        return Done()


def test_interpolates_with_rife_then_re_encodes_at_twice_the_input_rate(tmp_path):
    out = str(tmp_path / "b.mp4")
    run = Runner(rate="32/1")
    engine.interpolate(str(tmp_path / "a.mp4"), out, 2, run=run)
    assert [c[0] for c in run.commands] == ["ffprobe", weights_rife.PYTHON, "ffmpeg"]
    assert "--fps=64" in run.commands[1]
    assert f"--output={out}.rife.mp4" in run.commands[1]
    assert run.commands[2][-1] == out and f"{out}.rife.mp4" in run.commands[2] and "64" in run.commands[2]
    assert os.listdir(tmp_path) == ["b.mp4"]  # the intermediate is gone, the output stays


def test_rounds_a_broadcast_rate_to_the_nearest_whole_frame_rate(tmp_path):
    run = Runner(rate="30000/1001")
    engine.interpolate("a", str(tmp_path / "b.mp4"), 2, run=run)
    assert "--fps=60" in run.commands[1]


def test_refuses_a_clip_whose_rate_cannot_be_read(tmp_path):
    for rate in ("0/0", "nonsense", ""):
        with pytest.raises(RuntimeError, match="frame rate"):
            engine.interpolate("a", str(tmp_path / "b.mp4"), 2, run=Runner(rate=rate))
    assert os.listdir(tmp_path) == []


def test_says_which_process_failed_and_removes_the_intermediate(tmp_path):
    out = str(tmp_path / "b.mp4")
    with pytest.raises(RuntimeError, match=r"RIFE failed \(1\): .*CUDA out of memory"):
        engine.interpolate("a", out, 2, run=Runner(fail_on="rife"))
    assert os.listdir(tmp_path) == []
    with pytest.raises(RuntimeError, match=r"re-encode failed \(1\): .*bad pixel format"):
        engine.interpolate("a", out, 2, run=Runner(fail_on="ffmpeg", tail="bad pixel format"))
    assert not os.path.exists(out + ".rife.mp4")


def test_the_rife_files_are_present_only_at_their_sizes(tmp_path):
    assert not weights_rife.present(str(tmp_path))
    for name, size in weights_rife.FILES.items():
        with open(tmp_path / name, "wb") as f:
            f.truncate(size)
    assert weights_rife.present(str(tmp_path))
    with open(tmp_path / "flownet.pkl", "wb") as f:
        f.truncate(10)
    assert not weights_rife.present(str(tmp_path))


def test_the_image_downloads_and_checks_exactly_the_pinned_rife_zip():
    with open(__file__.rsplit("/tests/", 1)[0] + "/Dockerfile") as f:
        docker = f.read()
    assert weights_rife.COMMIT in docker
    assert weights_rife.ZIP_URL in docker
    assert f"{weights_rife.ZIP_SHA256}  " in docker
    assert weights_rife.ZIP_URL.endswith(weights_rife.ZIP_NAME)
    for name in weights_rife.FILES:
        assert name in docker
    assert "check_rife.py" in docker


R2_ENV = {"R2_ACCOUNT_ID": "acc", "R2_BUCKET": "bkt", "R2_ACCESS_KEY_ID": "id", "R2_SECRET_ACCESS_KEY": "secret"}


@pytest.fixture
def worker(tmp_path, monkeypatch):
    """handler.py with both engines, both sets of weights and R2 replaced by fakes, its scratch folder under tmp_path."""
    monkeypatch.setitem(sys.modules, "runpod", types.SimpleNamespace(serverless=types.SimpleNamespace(start=None)))
    import importlib.util

    spec = importlib.util.spec_from_file_location("upscale_handler_restore", os.path.join(os.path.dirname(__file__), "..", "handler.py"))
    h = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(h)
    (tmp_path / "tmp").mkdir()
    monkeypatch.setattr(h, "TMP_DIR", str(tmp_path / "tmp"))
    for name, value in R2_ENV.items():
        monkeypatch.setenv(name, value)
    h.calls = []
    h.uploads = []
    h.fail = None

    def upscale(src, out, short, model_dir, dit):
        h.calls.append(("upscale", os.path.basename(src), os.path.basename(out), short))
        with open(out, "wb") as f:
            f.write(b"hd")

    def interpolate(src, out, multiplier):
        h.calls.append(("interpolate", os.path.basename(src), os.path.basename(out), multiplier))
        if h.fail:
            raise RuntimeError(h.fail)
        with open(out, "wb") as f:
            f.write(b"smooth")

    def upload(path, key, kind):
        h.uploads.append(open(path, "rb").read())
        return f"https://r2.example/{key}"

    monkeypatch.setattr(engine, "upscale", upscale)
    monkeypatch.setattr(engine, "interpolate", interpolate)
    monkeypatch.setattr(weights, "present", lambda *a: True)
    monkeypatch.setattr(weights_rife, "present", lambda *a: True)
    monkeypatch.setattr(storage, "upload", upload)
    h.tmp = tmp_path / "tmp"
    return h


def test_does_both_steps_on_the_workers_own_disk_and_uploads_one_file(worker):
    out = worker.handler({"id": "j1", "input": NEW})
    assert worker.calls == [("upscale", "j1-in.mp4", "j1-mid.mp4", 1080), ("interpolate", "j1-mid.mp4", "j1.mp4", 2)]
    assert worker.uploads == [b"smooth"]
    assert out["url"] == "https://r2.example/flowchain/j1.mp4"
    assert list(worker.tmp.iterdir()) == []


def test_does_only_the_step_asked_for(worker):
    only_rife = {k: v for k, v in NEW.items() if k != "short"}
    worker.handler({"id": "j2", "input": only_rife})
    assert worker.calls == [("interpolate", "j2-in.mp4", "j2.mp4", 2)]
    worker.calls.clear()
    only_up = {k: v for k, v in NEW.items() if k != "interpolate"}
    worker.handler({"id": "j3", "input": only_up})
    assert worker.calls == [("upscale", "j3-in.mp4", "j3.mp4", 1080)]


def test_an_old_workflow_request_only_ever_upscales(worker):
    worker.handler({"id": "j4", "input": OLD})
    assert worker.calls == [("upscale", "j4-in.mp4", "j4.mp4", 1080)]
    assert worker.uploads == [b"hd"]


def test_leaves_no_file_behind_when_the_interpolation_fails(worker):
    worker.fail = "boom"
    with pytest.raises(RuntimeError, match="boom"):
        worker.handler({"id": "j5", "input": NEW})
    assert list(worker.tmp.iterdir()) == []
    assert worker.uploads == []


def test_asks_for_rifes_files_only_when_it_will_use_them(worker, monkeypatch):
    monkeypatch.setattr(weights_rife, "present", lambda *a: False)
    assert "error" in worker.handler({"id": "j6", "input": NEW})
    only_up = {k: v for k, v in NEW.items() if k != "interpolate"}
    assert "url" in worker.handler({"id": "j7", "input": only_up})


def test_asks_for_seedvr2s_files_only_when_it_will_use_them(worker, monkeypatch):
    monkeypatch.setattr(weights, "present", lambda *a: False)
    only_rife = {k: v for k, v in NEW.items() if k != "short"}
    assert "url" in worker.handler({"id": "j8", "input": only_rife})
    assert "error" in worker.handler({"id": "j9", "input": NEW})
