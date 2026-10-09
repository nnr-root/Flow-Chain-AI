import hashlib
import io
import json
import os

import pytest

from flowchain_worker import models

HERE = os.path.dirname(__file__)


def entry(data, **over):
    return {"name": "w.bin", "url": "mem://w", "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
            "dir": "loras", "for": ["clip"], **over}


def opener_for(data):
    return lambda url: io.BytesIO(data)


def test_the_shipped_list_is_complete_and_per_endpoint():
    entries = models.load(os.path.join(HERE, "..", "models.json"))
    assert len({e["name"] for e in entries}) == len(entries)
    assert all(len(e["sha256"]) == 64 and e["url"].startswith("https://huggingface.co/") for e in entries)
    assert {k for e in entries for k in e["for"]} == {"clip"}
    # the retired picture weights are gone from the list, so `fetch-models` takes them off the volume
    assert not [e["name"] for e in entries if "xl" in e["name"].lower() or e["dir"] in ("checkpoints", "ipadapter", "clip_vision")]


def test_downloads_verifies_and_then_skips(tmp_path):
    data = b"weights" * 1000
    e = entry(data)
    assert models.fetch([e], str(tmp_path), opener=opener_for(data)) == {"downloaded": ["w.bin"], "skipped": []}
    assert (tmp_path / "loras" / "w.bin").read_bytes() == data
    assert models.fetch([e], str(tmp_path), opener=opener_for(b"")) == {"downloaded": [], "skipped": ["w.bin"]}


def test_a_corrupt_download_leaves_nothing(tmp_path):
    e = entry(b"right bytes")
    with pytest.raises(ValueError, match="do not match models.json"):
        models.fetch([e], str(tmp_path), opener=opener_for(b"wrong bytes"))
    assert not os.listdir(tmp_path / "loras")


def test_removes_from_its_own_folders_what_the_list_no_longer_names_and_nothing_else(tmp_path):
    data = b"weights"
    kept = entry(data, name="kept.safetensors", dir="diffusion_models")
    models.fetch([kept], str(tmp_path), opener=opener_for(data))
    for folder, name in (("checkpoints", "old-sdxl.safetensors"), ("text_encoders", "moved-to-image.safetensors"),
                         ("diffusion_models", "older.safetensors"), ("klein-4b", "transformer.safetensors")):
        (tmp_path / folder).mkdir(exist_ok=True)
        (tmp_path / folder / name).write_bytes(b"x")
    (tmp_path / "checkpoints" / "old-sdxl.safetensors.sha256").write_text("abc")
    (tmp_path / "loras" / "sub").mkdir(parents=True)
    (tmp_path / "loras" / "sub" / "someone-elses.bin").write_bytes(b"x")

    assert models.purge([kept], str(tmp_path)) == ["old-sdxl.safetensors", "older.safetensors", "moved-to-image.safetensors"]
    left = sorted(str(p.relative_to(tmp_path)) for p in tmp_path.rglob("*") if p.is_file())
    assert left == ["diffusion_models/kept.safetensors", "diffusion_models/kept.safetensors.sha256",
                    "klein-4b/transformer.safetensors", "loras/sub/someone-elses.bin"]
    # what is listed is still seen as present afterwards: the next start downloads nothing
    assert models.plan([kept], str(tmp_path))[0][1] == "skip"
    assert models.purge([kept], str(tmp_path)) == []


def test_refuses_an_incomplete_list(tmp_path):
    path = tmp_path / "models.json"
    path.write_text(json.dumps([{"name": "x"}]))
    with pytest.raises(ValueError, match="lacks"):
        models.load(str(path))


def test_every_weight_the_graph_loads_is_on_the_volume_list_or_in_the_image():
    import re

    entries = models.load(os.path.join(HERE, "..", "models.json"))
    listed = {e["name"] for e in entries}
    text = open(os.path.join(HERE, "..", "src", "flowchain_worker", "workflows.py")).read()
    used = set(re.findall(r'"([^"/]+\.(?:safetensors|pth|ckpt|bin|gguf))"', text))
    dockerfile = open(os.path.join(HERE, "..", "Dockerfile")).read()
    in_image = {name for name in used if f"/{name}" in dockerfile}
    assert len(used) == 7
    # the text encoder, the VAE and RIFE are downloaded and checked by the Dockerfile; nothing is in both places
    assert in_image == {"umt5_xxl_fp8_e4m3fn_scaled.safetensors", "wan_2.1_vae.safetensors", "rife49.pth"}
    assert used - in_image == listed
