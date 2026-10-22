import base64
import importlib.util
import os
import sys
import types

import pytest

from flowchain_picture import contract, engine, engine_flux3, storage, weights, weights_flux3



class FakeImage:
    """Just enough of PIL.Image for the engine: the worker's test venv has neither Pillow nor torch."""

    COLORS = {"blue": (0, 0, 255), "green": (0, 128, 0), "red": (255, 0, 0)}

    def __init__(self, color):
        self.color = color

    @classmethod
    def new(cls, mode, size, color):
        return cls(cls.COLORS[color])

    @classmethod
    def open(cls, path):
        with open(path) as f:
            return cls(tuple(int(x) for x in f.read().split(",")))

    def convert(self, mode):
        return self

    def getpixel(self, xy):
        return self.color

    def save(self, path, format=None):
        with open(path, "w") as f:
            f.write(",".join(str(x) for x in self.color))


class FakeGenerator:
    def __init__(self):
        self.seed = None

    def manual_seed(self, seed):
        self.seed = seed
        return self


@pytest.fixture(autouse=True)
def stubbed_libraries(monkeypatch):
    import sys
    import types

    monkeypatch.setitem(sys.modules, "PIL", types.SimpleNamespace(Image=FakeImage))
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(Generator=FakeGenerator, bfloat16="bf16"))


PNG = base64.b64encode(b"png-bytes").decode()
GOOD = {"task": "keyframe", "workflow": "keyframe-flux3-klein@1", "prompt": "a lighthouse at dusk", "width": 1088, "height": 1920, "seed": 7}


def test_takes_a_list_of_references_for_the_new_workflow():
    assert contract.validate(GOOD) == {"task": "keyframe", "prompt": "a lighthouse at dusk", "width": 1088, "height": 1920, "seed": 7}
    got = contract.validate({**GOOD, "references": [PNG, PNG]})
    assert got["references"] == [b"png-bytes", b"png-bytes"]


@pytest.mark.parametrize(
    "change, why",
    [
        ({"reference": PNG}, "unknown field"),
        ({"references": "not a list"}, "references must be a list"),
        ({"references": [PNG] * (contract.MAX_REFERENCES + 1)}, "at most"),
        ({"references": ["not base64!"]}, "not valid base64"),
        ({"references": [""]}, "between 1 byte"),
    ],
)
def test_refuses_what_is_not_the_new_contract(change, why):
    with pytest.raises(contract.ContractError, match=why):
        contract.validate({**GOOD, **change})


def test_the_old_workflow_still_refuses_a_list_and_each_workflow_names_its_engine():
    old = {**GOOD, "workflow": "keyframe-klein@1"}
    with pytest.raises(contract.ContractError, match="unknown field"):
        contract.validate({**old, "references": [PNG]})
    assert contract.ENGINES == {"keyframe-klein@1": "klein", "keyframe-flux3-klein@1": "flux3"}


class FakePipe:
    def __init__(self):
        self.calls = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        from PIL import Image

        # output="images" returns the list of pictures itself (spec 3.1)
        return [Image.new("RGB", (kwargs["width"], kwargs["height"]), "red")]


def test_makes_a_picture_in_sixteen_steps_with_every_reference_in_order(tmp_path, monkeypatch):
    pipe = FakePipe()
    monkeypatch.setattr(engine_flux3, "load", lambda model_dir: pipe)
    from PIL import Image

    refs = []
    for name, color in (("a.png", "blue"), ("b.png", "green")):
        path = tmp_path / name
        Image.new("RGB", (64, 64), color).save(path)
        refs.append(str(path))
    out = tmp_path / "out.png"
    engine_flux3.picture("/models/x", "a lighthouse", 256, 256, 5, refs, str(out))
    call = pipe.calls[0]
    assert call["prompt"] == "a lighthouse"
    assert call["num_inference_steps"] == 16
    assert call["output"] == "images"
    assert call["generator"].seed == 5
    assert (call["width"], call["height"]) == (256, 256)
    assert [im.getpixel((0, 0)) for im in call["image"]] == [(0, 0, 255), (0, 128, 0)]
    assert "guidance_scale" not in call and "negative_prompt" not in call
    assert os.path.getsize(out) > 0


def test_asks_for_no_reference_images_when_there_are_none(tmp_path, monkeypatch):
    pipe = FakePipe()
    monkeypatch.setattr(engine_flux3, "load", lambda model_dir: pipe)
    engine_flux3.picture("/models/x", "a lighthouse", 256, 256, 5, [], str(tmp_path / "o.png"))
    assert "image" not in pipe.calls[0]


def test_the_pipeline_is_built_without_its_prompt_upsampler_block(monkeypatch):
    import sys
    import types

    events = []

    class Blocks:
        def __init__(self):
            self.sub_blocks = {"prompt_upsampler": object(), "denoise": object()}

        def init_pipeline(self, path):
            events.append(("init", path, sorted(self.sub_blocks)))
            return Pipe()

    class Pipe:
        blocks = Blocks()

        def load_components(self, dtype=None):
            events.append(("load", dtype))

        def to(self, device):
            events.append(("to", device))
            return self

    class ModularPipeline:
        @staticmethod
        def from_pretrained(path, **kw):
            events.append(("from", path))
            p = Pipe()
            p.blocks = blocks
            return p

    blocks = Blocks()
    fake_diffusers = types.SimpleNamespace(ModularPipeline=ModularPipeline)
    fake_torch = types.SimpleNamespace(bfloat16="bf16")
    monkeypatch.setitem(sys.modules, "diffusers", fake_diffusers)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setattr(engine_flux3, "_pipe", None)
    engine_flux3.load("/models/x")
    assert ("init", "/models/x", ["denoise"]) in events
    assert ("load", "bf16") in events and ("to", "cuda") in events
    monkeypatch.setattr(engine_flux3, "_pipe", None)


def fake_sha(path):
    """The recorded prefix of the file's SHA-256: what a correct download would hash to."""
    return next(h for name, (_, h) in weights_flux3.BIG.items() if path.endswith(name))


def _sparse_files(target):
    for name, (size, _) in weights_flux3.BIG.items():
        path = os.path.join(target, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.truncate(size)  # the size without the bytes


def test_the_weights_are_present_only_when_every_file_has_its_size_and_the_marker_names_the_revision(tmp_path):
    root = str(tmp_path)
    assert not weights_flux3.present(root)
    _sparse_files(weights_flux3.folder(root))
    assert not weights_flux3.present(root)  # no marker yet: nothing has been checked
    weights_flux3.verify(root, sha256=fake_sha)
    assert weights_flux3.present(root)


def test_a_file_with_the_wrong_hash_is_refused(tmp_path):
    root = str(tmp_path)
    _sparse_files(weights_flux3.folder(root))
    with pytest.raises(ValueError, match="SHA-256 differs"):
        weights_flux3.verify(root, sha256=lambda path: "0000000000000000")


def test_fetch_downloads_when_missing_and_is_a_no_op_once_present(tmp_path):
    root = str(tmp_path)
    seen = []

    def download(target):
        seen.append(target)
        _sparse_files(target)

    first = weights_flux3.fetch(root, download=download, sha256=fake_sha)
    assert first["downloaded"] and len(seen) == 1
    again = weights_flux3.fetch(root, download=download, sha256=fake_sha)
    assert again["downloaded"] == [] and len(seen) == 1


def test_the_constants_are_the_ones_the_spec_records():
    assert weights_flux3.REVISION == "337337621b8526e120f2275d250242f4a6bedd75"
    assert len(weights_flux3.BIG) == 5
    assert all(len(h) == 16 for _, h in weights_flux3.BIG.values())


@pytest.fixture
def worker(tmp_path, monkeypatch):
    """handler.py with both engines, the volume and R2 replaced by fakes, its scratch folder under tmp_path."""
    monkeypatch.setitem(sys.modules, "runpod", types.SimpleNamespace(serverless=types.SimpleNamespace(start=None)))
    spec = importlib.util.spec_from_file_location("picture_handler_flux3", os.path.join(os.path.dirname(__file__), "..", "handler.py"))
    h = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(h)
    (tmp_path / "tmp").mkdir()
    monkeypatch.setattr(h, "TMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setattr(h, "VOLUME_MODELS", str(tmp_path / "models"))
    for name, value in {"R2_ACCOUNT_ID": "acc", "R2_BUCKET": "bkt", "R2_ACCESS_KEY_ID": "id", "R2_SECRET_ACCESS_KEY": "secret"}.items():
        monkeypatch.setenv(name, value)
    h.calls = []
    h.fail = None

    def picture(model_dir, prompt, width, height, seed, reference_paths, out_path):
        h.calls.append((list(reference_paths), [open(p, "rb").read() for p in reference_paths], [os.path.exists(p) for p in reference_paths]))
        if h.fail:
            raise RuntimeError(h.fail)
        with open(out_path, "wb") as f:
            f.write(b"png")

    monkeypatch.setattr(engine_flux3, "picture", picture)
    monkeypatch.setattr(weights_flux3, "present", lambda root: True)
    monkeypatch.setattr(storage, "upload", lambda path, key, kind: f"https://r2.example/{key}")
    h.tmp = tmp_path / "tmp"
    return h


def test_hands_the_engine_every_reference_in_order_and_leaves_none_behind(worker):
    refs = [base64.b64encode(f"ref-{k}".encode()).decode() for k in range(3)]
    out = worker.handler({"id": "j1", "input": {**GOOD, "references": refs}})
    assert out["url"] == "https://r2.example/flowchain/j1.png"
    paths, contents, existed = worker.calls[0]
    assert [os.path.basename(p) for p in paths] == ["j1-reference-0.png", "j1-reference-1.png", "j1-reference-2.png"]
    assert contents == [b"ref-0", b"ref-1", b"ref-2"] and all(existed)
    assert list(worker.tmp.iterdir()) == []


def test_leaves_no_reference_behind_when_the_engine_fails(worker):
    worker.fail = "CUDA out of memory"
    refs = [base64.b64encode(b"x").decode()] * 3
    with pytest.raises(RuntimeError, match="out of memory"):
        worker.handler({"id": "j2", "input": {**GOOD, "references": refs}})
    assert len(worker.calls[0][0]) == 3
    assert list(worker.tmp.iterdir()) == []


def test_fetch_models_for_the_new_endpoint_uses_its_weights_and_without_it_the_4b(worker, monkeypatch):
    monkeypatch.setattr(weights_flux3, "fetch", lambda root: {"fetched": "flux3"})
    monkeypatch.setattr(weights, "fetch", lambda root: {"fetched": "4b"})
    assert worker.handler({"id": "f1", "input": {"task": "fetch-models", "only": "keyframe3"}}) == {"fetched": "flux3"}
    assert worker.handler({"id": "f2", "input": {"task": "fetch-models"}}) == {"fetched": "4b"}
    assert worker.handler({"id": "f3", "input": {"task": "fetch-models", "only": "keyframe"}}) == {"fetched": "4b"}
