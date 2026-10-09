import base64
import importlib.util
import os
import sys
import types

import pytest

from flowchain_picture import contract, engine, storage, weights

HERE = os.path.dirname(__file__)
PNG = base64.b64encode(b"png-bytes").decode()
GOOD = {"task": "keyframe", "workflow": "keyframe-klein@1", "prompt": "a secret product launch", "width": 1088, "height": 1920, "seed": 7, "preset": "anime"}
R2_ENV = {"R2_ACCOUNT_ID": "acc", "R2_BUCKET": "bkt", "R2_ACCESS_KEY_ID": "AKIA-secret-id", "R2_SECRET_ACCESS_KEY": "s3cr3t"}


def test_takes_the_same_request_as_the_worker_before_it():
    assert contract.validate(GOOD) == {"task": "keyframe", "prompt": "a secret product launch", "width": 1088, "height": 1920, "seed": 7}
    assert contract.validate({**GOOD, "reference": PNG})["reference"] == b"png-bytes"
    assert contract.validate({"task": "fetch-models", "only": "keyframe"}) == {"task": "fetch-models"}


@pytest.mark.parametrize(
    "change, why",
    [
        ({"task": "clip"}, "task must be"),
        ({"workflow": "keyframe-sdxl@1"}, "runs workflow keyframe-klein@1"),
        ({"prompt": " "}, "prompt must be"),
        ({"prompt": "x" * 4001}, "prompt must be"),
        ({"width": 1080}, "multiples of 16"),
        ({"height": 4096}, "height must be"),
        ({"width": True}, "width must be"),
        ({"seed": -1}, "seed must be"),
        ({"preset": "noir"}, "preset must be"),
        ({"reference": "not base64!"}, "not valid base64"),
        ({"reference": ""}, "between 1 byte"),
        ({"negativePrompt": "x"}, "unknown field"),
    ],
)
def test_refuses_what_is_not_the_contract(change, why):
    with pytest.raises(contract.ContractError, match=why):
        contract.validate({**GOOD, **change})


def _weights(root, sizes=None):
    for name, (size, _) in weights.BIG.items():
        path = os.path.join(weights.folder(root), name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.truncate((sizes or {}).get(name, size))  # sparse: the size without the bytes


def _hash_ok(path):
    name = os.path.relpath(path, os.path.dirname(os.path.dirname(path))).replace(os.sep, "/")
    return weights.BIG[name][1] + "0" * 48


def test_fetches_the_model_once_checks_it_and_never_trusts_a_file_it_did_not_check(tmp_path):
    root = str(tmp_path)
    assert not weights.present(root)
    calls = []

    def download(target):
        calls.append(target)
        _weights(root)

    assert weights.fetch(root, download, _hash_ok) == {"downloaded": sorted(weights.BIG), "skipped": []}
    assert calls == [weights.folder(root)]
    assert weights.present(root)
    # a second time nothing is downloaded
    assert weights.fetch(root, lambda target: calls.append("again"), _hash_ok)["downloaded"] == []
    assert calls == [weights.folder(root)]
    # a file that changed size afterwards is not present any more
    name = next(iter(weights.BIG))
    with open(os.path.join(weights.folder(root), name), "wb") as f:
        f.truncate(10)
    assert not weights.present(root)


def test_refuses_weights_that_are_not_the_ones_that_were_tested(tmp_path):
    root = str(tmp_path)
    with pytest.raises(ValueError, match="not the file that was tested"):
        weights.fetch(root, lambda target: _weights(root), lambda path: "f" * 64)
    assert not weights.present(root)
    name = "vae/diffusion_pytorch_model.safetensors"
    with pytest.raises(ValueError, match="missing or has the wrong size"):
        weights.fetch(root, lambda target: _weights(root, {name: 5}), _hash_ok)
    # a marker from another version of the model does not count
    _weights(root)
    with open(os.path.join(weights.folder(root), weights.MARKER), "w") as f:
        f.write("0" * 40)
    assert not weights.present(root)


@pytest.fixture
def worker(tmp_path, monkeypatch):
    """handler.py with the model, the volume and R2 replaced by fakes, its scratch folder under tmp_path."""
    monkeypatch.setitem(sys.modules, "runpod", types.SimpleNamespace(serverless=types.SimpleNamespace(start=None)))
    spec = importlib.util.spec_from_file_location("picture_handler", os.path.join(HERE, "..", "handler.py"))
    h = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(h)
    (tmp_path / "tmp").mkdir()
    monkeypatch.setattr(h, "TMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setattr(h, "VOLUME_MODELS", str(tmp_path / "models"))
    for name, value in R2_ENV.items():
        monkeypatch.setenv(name, value)
    h.calls = []
    h.fail = None
    h.have = True

    def picture(model_dir, prompt, width, height, seed, reference_path, out_path):
        ref = open(reference_path, "rb").read() if reference_path else None
        h.calls.append(("picture", os.path.basename(model_dir), prompt, width, height, seed, ref))
        if h.fail:
            raise RuntimeError(h.fail)
        with open(out_path, "wb") as f:
            f.write(b"png")

    monkeypatch.setattr(engine, "picture", picture)
    monkeypatch.setattr(weights, "present", lambda root: h.have)
    monkeypatch.setattr(weights, "fetch", lambda root: {"downloaded": ["x"], "skipped": []})
    monkeypatch.setattr(storage, "upload", lambda path, key, kind: f"https://r2.example/{key}")
    h.tmp = tmp_path / "tmp"
    return h


def test_makes_a_picture_uploads_it_and_leaves_nothing_behind(worker, capsys):
    out = worker.handler({"id": "j1", "input": {**GOOD, "reference": PNG}})
    assert out["url"] == "https://r2.example/flowchain/j1.png"
    assert out["seed"] == 7 and isinstance(out["executionMs"], int)
    assert worker.calls == [("picture", "klein-4b", "a secret product launch", 1088, 1920, 7, b"png-bytes")]
    assert list(worker.tmp.iterdir()) == []
    # nothing the worker prints carries a word of the prompt
    assert "secret" not in capsys.readouterr().out


def test_picks_a_seed_when_none_is_given_and_makes_a_picture_without_a_portrait(worker):
    out = worker.handler({"id": "j2", "input": {k: v for k, v in GOOD.items() if k != "seed"}})
    assert 0 <= out["seed"] <= contract.MAX_SEED
    assert worker.calls[0][-1] is None


def test_leaves_nothing_behind_when_the_model_fails(worker):
    worker.fail = "CUDA out of memory"
    with pytest.raises(RuntimeError, match="out of memory"):
        worker.handler({"id": "j3", "input": {**GOOD, "reference": PNG}})
    assert list(worker.tmp.iterdir()) == []


def test_refuses_before_any_gpu_work_a_bad_request_a_worker_without_r2_and_a_volume_without_the_model(worker, monkeypatch):
    assert worker.handler({"id": "j4", "input": {**GOOD, "workflow": "keyframe-sdxl@1"}}) == {"error": "invalid request: this worker runs workflow keyframe-klein@1 for task keyframe"}
    worker.have = False
    assert "not on the volume yet" in worker.handler({"id": "j5", "input": GOOD})["error"]
    worker.have = True
    monkeypatch.delenv("R2_SECRET_ACCESS_KEY")
    out = worker.handler({"id": "j6", "input": GOOD})
    assert out == {"error": "R2 is not set up on this worker; missing: R2_SECRET_ACCESS_KEY"}
    assert "s3cr3t" not in str(out) and worker.calls == []
    # fetching the model needs neither
    assert worker.handler({"id": "j7", "input": {"task": "fetch-models"}}) == {"downloaded": ["x"], "skipped": []}
