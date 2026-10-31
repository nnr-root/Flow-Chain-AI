"""The model files the image holds, how the worker finds and joins them, and the Dockerfile that downloads them.

There is no `verify()` case like foley's: the check that the bytes are the pinned files is made at build time by
lfs-check.sh, which is tested here instead.
"""

import hashlib
import os
import re
import subprocess

import pytest

import flowchain_ltx
from flowchain_ltx import weights

HERE = os.path.dirname(__file__)
DOCKERFILE = os.path.join(HERE, "..", "Dockerfile")
LFS_CHECK = os.path.join(HERE, "..", "lfs-check.sh")


def lay_out(root, whisper_root, revision=None, split=True):
    files = {}
    for name, (size, _) in weights.FILES.items():
        if split and name in weights.PARTS:
            files.update(weights.PARTS[name])
        else:
            files[name] = size
    for name, size in files.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.truncate(size)  # sparse: no disk is used
    for name, (size, _) in weights.WHISPER_FILES.items():
        path = os.path.join(whisper_root, name)
        os.makedirs(whisper_root, exist_ok=True)
        with open(path, "wb") as f:
            f.truncate(size)
    with open(os.path.join(root, weights.MARKER), "w") as f:
        f.write(revision or weights.REVISION)


@pytest.fixture
def roots(tmp_path):
    return str(tmp_path / "ltx"), str(tmp_path / "whisper")


def test_the_pins_are_full_commits_and_every_file_has_a_size_and_a_pointer_id():
    assert len(weights.REVISION) == 40 and len(weights.WHISPER_REVISION) == 40
    assert len(weights.FILES) == 5
    assert all(size > 0 and re.fullmatch(r"[0-9a-f]{40}", oid) for size, oid in weights.FILES.values())
    assert all(size > 0 and re.fullmatch(r"[0-9a-f]{64}", sha) for size, sha in weights.WHISPER_FILES.values())


def test_every_file_over_the_layer_limit_is_split_into_parts_under_it_that_add_up_to_it():
    big = {name for name, (size, _) in weights.FILES.items() if size > weights.LAYER_BYTES}
    assert big == set(weights.PARTS) and big  # the transformer and the text encoder
    for name, parts in weights.PARTS.items():
        assert sum(parts.values()) == weights.FILES[name][0]
        assert all(0 < size <= weights.LAYER_BYTES for size in parts.values())
    assert len(weights.PARTS[weights.TRANSFORMER]) == 5


def test_byte_ranges_cover_a_file_exactly_once_in_order():
    assert weights.byte_ranges(10, 4) == [(0, 3), (4, 7), (8, 9)]
    assert weights.byte_ranges(8, 4) == [(0, 3), (4, 7)]


def test_a_pointer_id_is_the_git_blob_of_the_lfs_pointer_naming_the_sha256_and_size():
    # a public, ungated file whose SHA-256 and pointer id are both known (HunyuanVideo-Foley's synchformer)
    sha = "8aff082f2df5c3bc52759db0c865c7ee772ae6400b860d1b7e90413f2defb67c"
    assert weights.pointer_oid(sha, 950058171) == "e00a6d0b10856fb3f575e2aa861a81c3418cf881"


def test_is_present_only_when_every_file_has_its_size_and_the_marker_names_this_revision(roots):
    root, whisper = roots
    assert not weights.present(root, whisper)
    lay_out(root, whisper)
    assert weights.present(root, whisper)
    name = weights.VIDEO_VAE
    with open(os.path.join(root, name), "ab") as f:
        f.write(b"x")
    assert not weights.present(root, whisper)


def test_is_not_present_without_the_whisper_model(roots):
    root, whisper = roots
    lay_out(root, whisper)
    os.remove(os.path.join(whisper, "model.bin"))
    assert not weights.present(root, whisper)


def test_is_not_present_without_the_marker_or_with_another_revision(roots):
    root, whisper = roots
    lay_out(root, whisper, revision="0" * 40)
    assert not weights.present(root, whisper)
    os.remove(os.path.join(root, weights.MARKER))
    assert not weights.present(root, whisper)


def test_is_present_with_the_files_joined_instead_of_in_parts(roots):
    root, whisper = roots
    lay_out(root, whisper, split=False)
    assert weights.present(root, whisper)


def test_is_not_present_with_one_part_missing_or_the_wrong_size(roots):
    root, whisper = roots
    lay_out(root, whisper)
    part = sorted(weights.PARTS[weights.TRANSFORMER])[-1]
    with open(os.path.join(root, part), "ab") as f:
        f.write(b"x")
    assert not weights.present(root, whisper)
    os.remove(os.path.join(root, part))
    assert not weights.present(root, whisper)


@pytest.fixture
def small(monkeypatch):
    files = {"a/big.safetensors": (9, "0" * 40), "b/other.safetensors": (7, "1" * 40), "c/small.safetensors": (3, "2" * 40)}
    monkeypatch.setattr(weights, "FILES", files)
    monkeypatch.setattr(
        weights,
        "PARTS",
        {
            "a/big.safetensors": {"a/big.safetensors.part00": 4, "a/big.safetensors.part01": 5},
            "b/other.safetensors": {"b/other.safetensors.part00": 4, "b/other.safetensors.part01": 3},
        },
    )


def _write(root, name, data):
    path = os.path.join(root, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return path


def test_assemble_joins_every_split_file_byte_for_byte_and_can_be_repeated(tmp_path, small):
    root = str(tmp_path)
    _write(root, "a/big.safetensors.part00", b"abcd")
    _write(root, "a/big.safetensors.part01", b"efghi")
    _write(root, "b/other.safetensors.part00", b"1234")
    _write(root, "b/other.safetensors.part01", b"567")
    weights.assemble(root)
    joined = tmp_path / "a" / "big.safetensors"
    assert joined.read_bytes() == b"abcdefghi"
    assert (tmp_path / "b" / "other.safetensors").read_bytes() == b"1234567"
    stamp = os.stat(joined).st_mtime_ns
    weights.assemble(root)
    assert joined.read_bytes() == b"abcdefghi" and os.stat(joined).st_mtime_ns == stamp
    assert not list(tmp_path.rglob("*.tmp"))


def test_assemble_names_a_part_of_the_wrong_size(tmp_path, small):
    root = str(tmp_path)
    _write(root, "a/big.safetensors.part00", b"abcd")
    _write(root, "a/big.safetensors.part01", b"ef")
    with pytest.raises(ValueError, match="big.safetensors.part01 is missing or has the wrong size"):
        weights.assemble(root)
    assert not (tmp_path / "a" / "big.safetensors").exists()


def _dockerfile():
    with open(DOCKERFILE) as f:
        return f.read()


def test_the_dockerfile_downloads_each_part_as_exactly_the_byte_range_the_worker_joins():
    text = _dockerfile()
    for name, parts in weights.PARTS.items():
        ranges = weights.byte_ranges(weights.FILES[name][0], weights.PART_BYTES)
        assert len(ranges) == len(parts)
        for part, (start, end) in zip(sorted(parts), ranges):
            assert parts[part] == end - start + 1
            assert re.search(rf"-r {start}-{end} -o /models/ltx/{re.escape(part)} ", text), f"{part} is not downloaded as {start}-{end}"


def test_the_dockerfile_checks_every_file_against_the_size_and_pointer_id_the_worker_knows():
    text = _dockerfile()
    assert f"LTX_REVISION={weights.REVISION}" in text and f"WHISPER_REVISION={weights.WHISPER_REVISION}" in text
    for size, oid in weights.FILES.values():
        assert re.search(rf"lfs-check {oid} {size} ", text), f"no check of {oid}"
    for name, (_, sha) in weights.WHISPER_FILES.items():
        assert f"{sha}  /models/whisper/{name}" in text
    # the token is a build secret: never an ARG or an ENV, which would stay in the image's history
    assert not re.search(r"^(ARG|ENV)\b.*(HF_TOKEN|hf_token)", text, re.M | re.I)
    assert "--mount=type=secret,id=hf_token" in text


# the stack `uv sync --extra natten` resolved at LTX-2 e98f6d9, which the spike ran on 2026-10-31
SPIKE_STACK = {
    "torch": "2.13.0+cu132",
    "torchvision": "0.28.0+cu132",
    "torchaudio": "2.11.1+cu132",
    "natten": "0.21.7+torch2130cu132",
}


def test_the_image_pins_the_torch_stack_the_spike_ran_and_overrides_cudnn_as_the_program_does():
    text = _dockerfile()
    constraints = re.search(r"printf '([^']*)' > /constraints\.txt", text).group(1).split("\\n")
    for name, version in SPIKE_STACK.items():
        assert f"{name}=={version}" in constraints, f"{name} is not pinned to {version}"
    overrides = re.search(r"printf '([^']*)' > /overrides\.txt", text).group(1).split("\\n")
    assert "nvidia-cudnn-cu13==9.24.0.43" in overrides
    assert "https://download.pytorch.org/whl/cu132" in text and "https://whl.natten.org" in text
    # every install goes through the constraints and the override, so nothing below can move the stack
    for line in re.findall(r"uv pip install[^\n]*", text):
        assert "-c /constraints.txt" in line and "--override /overrides.txt" in line, line
    assert "pip install" not in text.replace("uv pip install", "").replace("pip install --no-cache-dir uv==", "")
    assert "2.8.0" not in text and "cu128" not in text


def test_the_host_needs_a_driver_for_the_cuda_the_wheels_were_built_for():
    assert flowchain_ltx.MIN_HOST_CUDA == "13.2"
    assert f"CUDA {flowchain_ltx.MIN_HOST_CUDA}" in _dockerfile().split("FROM", 1)[0]


def _lfs_check(tmp_path, oid, size, *parts):
    return subprocess.run(["bash", LFS_CHECK, oid, str(size), *parts], capture_output=True, text=True)


def test_the_build_check_accepts_parts_whose_join_is_the_pinned_file(tmp_path):
    a, b = tmp_path / "f.part00", tmp_path / "f.part01"
    a.write_bytes(b"hello ")
    b.write_bytes(b"world")
    oid = weights.pointer_oid(hashlib.sha256(b"hello world").hexdigest(), 11)
    done = _lfs_check(tmp_path, oid, 11, str(a), str(b))
    assert done.returncode == 0, done.stderr


def test_the_build_check_refuses_other_bytes_or_another_size(tmp_path):
    a = tmp_path / "f"
    a.write_bytes(b"hello world")
    oid = weights.pointer_oid(hashlib.sha256(b"hello there").hexdigest(), 11)
    assert _lfs_check(tmp_path, oid, 11, str(a)).returncode != 0
    good = weights.pointer_oid(hashlib.sha256(b"hello world").hexdigest(), 11)
    assert _lfs_check(tmp_path, good, 12, str(a)).returncode != 0
