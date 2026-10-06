import hashlib
import io
import json
import os

import pytest

from flowchain_worker import models

HERE = os.path.dirname(__file__)


def entry(data, **over):
    return {"name": "w.bin", "url": "mem://w", "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
            "dir": "loras", "for": ["keyframe"], **over}


def opener_for(data):
    return lambda url: io.BytesIO(data)


def test_the_shipped_list_is_complete_and_per_endpoint():
    entries = models.load(os.path.join(HERE, "..", "models.json"))
    assert len({e["name"] for e in entries}) == len(entries)
    assert all(len(e["sha256"]) == 64 and e["url"].startswith("https://huggingface.co/") for e in entries)
    assert {k for e in entries for k in e["for"]} == {"keyframe", "clip"}


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


def test_only_fetches_the_endpoints_own_weights(tmp_path):
    k, c = entry(b"k", name="k.bin"), entry(b"c", name="c.bin", **{"for": ["clip"]})
    assert [e["name"] for e, _ in models.plan([k, c], str(tmp_path), "clip")] == ["c.bin"]


def test_refuses_an_incomplete_list(tmp_path):
    path = tmp_path / "models.json"
    path.write_text(json.dumps([{"name": "x"}]))
    with pytest.raises(ValueError, match="lacks"):
        models.load(str(path))
