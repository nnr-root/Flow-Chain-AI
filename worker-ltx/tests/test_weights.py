"""The model files the image holds, how the worker finds and joins them, and the Dockerfile that downloads them.

There is no `verify()` case like foley's: the check that the bytes are the pinned files is made at build time by
lfs-check.sh, which is tested here instead.
"""

import hashlib
import json
import os
import re
import struct
import subprocess
import types

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


def test_no_build_step_maps_or_joins_a_model_file():
    # the hosted runner cannot map the 26 GB text encoder (CI run 41287628826: "unable to mmap … Cannot allocate memory");
    # the build reads its header only
    text = _dockerfile()
    for word in (
        "safe_open", "torch.load", "from_pretrained", "mmap", "GemmaAssets.load", "/tmp/te.safetensors",
        "from_single_file", "load_file", "assemble(",
    ):
        assert word not in text, word
    assert not re.search(r"cat [^\n|]*\.part00[^\n|]*>", text), "a step joins a split file"
    assert "python3.11 -m flowchain_ltx.weights check-text-encoder" in text


def _tensor(name, start, length):
    return name, {"dtype": "U8", "shape": [length], "data_offsets": [start, start + length]}


def write_safetensors(tmp_path, metadata, tensors, data_len, split_at=None, extra=0):
    """A small safetensors file, as its header lays it out, written whole or as two parts."""
    header = {"__metadata__": metadata, **dict(tensors)}
    raw = json.dumps(header).encode()
    blob = struct.pack("<Q", len(raw)) + raw + b"\0" * (data_len + extra)
    if split_at is None:
        path = tmp_path / "te.safetensors"
        path.write_bytes(blob)
        return [str(path)]
    a, b = tmp_path / "te.safetensors.part00", tmp_path / "te.safetensors.part01"
    a.write_bytes(blob[:split_at])
    b.write_bytes(blob[split_at:])
    return [str(a), str(b)]


GOOD_META = {"gemma_config": json.dumps({"model_type": "gemma4"})}
GOOD_TENSORS = [
    _tensor("tokenizer_json", 0, 10),
    _tensor("hf_asset__tokenizer_config.json", 10, 5),
    _tensor("hf_asset__processor_config.json", 15, 5),
    _tensor("model.weight", 20, 40),
]


def test_the_text_encoder_header_is_read_from_the_first_part_and_its_data_ends_where_the_parts_end(tmp_path):
    parts = write_safetensors(tmp_path, GOOD_META, GOOD_TENSORS, 60, split_at=40)
    config = weights.check_text_encoder_header(parts)
    assert config == {"model_type": "gemma4"}


def test_the_text_encoder_header_may_carry_the_small_sidecars_as_metadata(tmp_path):
    meta = {**GOOD_META, "tokenizer_config.json": "{}", "processor_config.json": "{}"}
    parts = write_safetensors(tmp_path, meta, [GOOD_TENSORS[0], _tensor("model.weight", 10, 50)], 60)
    assert weights.check_text_encoder_header(parts)["model_type"] == "gemma4"


@pytest.mark.parametrize(
    "meta, tensors, data_len, extra, why",
    [
        (GOOD_META, GOOD_TENSORS, 60, 1, "data ends at"),
        (GOOD_META, GOOD_TENSORS[1:], 60, 0, "tokenizer_json"),
        (GOOD_META, [GOOD_TENSORS[0], GOOD_TENSORS[2], GOOD_TENSORS[3]], 60, 0, "tokenizer_config.json"),
        ({}, GOOD_TENSORS, 60, 0, "gemma_config"),
        ({"gemma_config": json.dumps({"vocab_size": 3})}, GOOD_TENSORS, 60, 0, "model_type"),
    ],
)
def test_the_text_encoder_header_check_refuses_what_the_loader_would_refuse(tmp_path, meta, tensors, data_len, extra, why):
    parts = write_safetensors(tmp_path, meta, tensors, data_len, extra=extra)
    with pytest.raises(ValueError, match=why):
        weights.check_text_encoder_header(parts)


def test_the_text_encoder_header_check_refuses_a_file_that_is_not_safetensors(tmp_path):
    bad = tmp_path / "x"
    bad.write_bytes(struct.pack("<Q", 10**12) + b"{}")
    with pytest.raises(ValueError, match="header"):
        weights.check_text_encoder_header([str(bad)])



@pytest.mark.parametrize(
    "header, why",
    [
        ([1, 2], "not a JSON object"),
        ({"w": {"dtype": "U8", "shape": [2]}}, "w has no data_offsets"),
        ({"w": {"dtype": "U8", "shape": [2], "data_offsets": ["a", 2]}}, "w has no data_offsets"),
        ({"w": {"dtype": "U8", "shape": [2], "data_offsets": [0, 1, 2]}}, "w has no data_offsets"),
        ({"w": {"dtype": "U8", "shape": [2], "data_offsets": [3, 1]}}, "w has no data_offsets"),
        ({"w": [0, 2]}, "w has no data_offsets"),
        ({"__metadata__": [1], "w": {"dtype": "U8", "shape": [2], "data_offsets": [0, 2]}}, "metadata"),
    ],
)
def test_a_malformed_header_is_refused_with_a_plain_message(tmp_path, header, why):
    raw = json.dumps(header).encode()
    path = tmp_path / "te.safetensors"
    path.write_bytes(struct.pack("<Q", len(raw)) + raw + b"\0\0")
    with pytest.raises(ValueError, match=why):
        weights.check_text_encoder_header([str(path)])


def test_a_byte_range_is_read_across_the_parts_as_one_file(tmp_path):
    paths = []
    for i, data in enumerate((b"abc", b"defg", b"hi")):
        (tmp_path / f"p{i}").write_bytes(data)
        paths.append(str(tmp_path / f"p{i}"))
    assert weights.read_range(paths, 2, 5) == b"cdefg"
    assert weights.read_range(paths, 0, 9) == b"abcdefghi"
    assert weights.read_range(paths, 7, 2) == b"hi"
    assert weights.read_range(paths, 3, 0) == b""
    with pytest.raises(ValueError, match="beyond"):
        weights.read_range(paths, 8, 2)


DTYPE_BYTES = {"U8": 1, "I8": 1, "I32": 4}


def te_file(tmp_path, entries, metadata, cuts=()):
    """A text encoder as safetensors with real tensor data, cut into parts at the given absolute positions."""
    header, data = {"__metadata__": metadata}, b""
    for name, dtype, raw in entries:
        header[name] = {"dtype": dtype, "shape": [len(raw) // DTYPE_BYTES[dtype]], "data_offsets": [len(data), len(data) + len(raw)]}
        data += raw
    head = json.dumps(header).encode()
    blob = struct.pack("<Q", len(head)) + head + data
    paths, start = [], 0
    for i, end in enumerate([*cuts, len(blob)]):
        path = tmp_path / f"te.safetensors.part{i:02d}"
        path.write_bytes(blob[start:end])
        paths.append(str(path))
        start = end
    return paths, 8 + len(head)


TOKENIZER = json.dumps({"model": {"type": "BPE", "vocab": {f"t{i}": i for i in range(40)}}, "added_tokens": []}).encode()
TOK_CONFIG = b'{"bos_token": "<bos>"}'
PROC_CONFIG = b'{"processor_class": "Gemma4Processor"}'


def good_entries(tok_config=TOK_CONFIG):
    return [
        ("tokenizer_json", "U8", TOKENIZER),
        ("hf_asset__tokenizer_config.json", "U8", tok_config),
        # Comfy packs may store a sidecar as int8: the loader casts it to uint8, which keeps the bytes
        ("hf_asset__processor_config.json", "I8", PROC_CONFIG),
        ("model.weight", "U8", b"\x01" * 64),
    ]


def test_the_assets_are_read_by_offset_exactly_as_the_loader_reads_them_even_across_a_part_boundary(tmp_path):
    meta = {**GOOD_META, "chat_template.jinja": "{{ messages }}", "processor_config.json": "not this one"}
    probe = tmp_path / "probe"
    probe.mkdir()
    _, data_start = te_file(probe, good_entries(), meta)
    # cut inside the tokenizer tensor, so its bytes come from two parts
    paths, _ = te_file(tmp_path, good_entries(), meta, cuts=(data_start + 7,))
    assets = weights.text_encoder_assets(paths)
    assert assets["config_dict"] == {"model_type": "gemma4"}
    assert assets["tokenizer_json"] == TOKENIZER
    # a tensor wins over metadata of the same name; metadata fills in only what no tensor carries (gemma_assets.py)
    assert assets["sidecars"] == {
        "tokenizer_config.json": TOK_CONFIG,
        "processor_config.json": PROC_CONFIG,
        "chat_template.jinja": b"{{ messages }}",
    }


def test_a_wider_integer_tensor_becomes_its_values_cast_to_uint8_as_the_loader_does(tmp_path):
    values = [65, 66, 300, -1]
    raw = struct.pack("<4i", *values)
    entries = [("tokenizer_json", "I32", raw), *good_entries()[1:]]
    paths, _ = te_file(tmp_path, entries, GOOD_META)
    assert weights.text_encoder_assets(paths)["tokenizer_json"] == bytes(v % 256 for v in values)


def test_a_tensor_whose_bytes_do_not_match_its_shape_is_refused(tmp_path):
    paths, _ = te_file(tmp_path, good_entries(), GOOD_META)
    raw = open(paths[0], "rb").read()
    length = struct.unpack("<Q", raw[:8])[0]
    header = json.loads(raw[8 : 8 + length])
    header["tokenizer_json"]["shape"] = [3]
    head = json.dumps(header).encode()
    open(paths[0], "wb").write(struct.pack("<Q", len(head)) + head + raw[8 + length :])
    with pytest.raises(ValueError, match="tokenizer_json"):
        weights.text_encoder_assets(paths)


class FakeAssets:
    def __init__(self, source, config_dict, tokenizer_json, sidecars, weight_paths):
        self.config_dict, self.tokenizer_json, self.sidecars = config_dict, tokenizer_json, sidecars

    def _require_sidecars(self, *names):
        missing = [n for n in names if n not in self.sidecars]
        if missing:
            raise ValueError(f"missing required sidecar(s): {missing}")


def fake_gemma():
    """The four names the build uses from ltx_core's gemma_assets, building from the bytes as strictly as JSON allows."""
    return types.SimpleNamespace(
        GemmaAssets=FakeAssets,
        build_gemma_hf_config=lambda a: a.config_dict["model_type"],
        build_gemma_hf_tokenizer=lambda a: (json.loads(a.tokenizer_json), json.loads(a.sidecars["tokenizer_config.json"]))[1],
        build_gemma_processor=lambda a, t: json.loads(a.sidecars["processor_config.json"])["processor_class"],
    )


def test_the_config_tokenizer_and_processor_build_from_the_bytes_read_by_offset(tmp_path):
    paths, _ = te_file(tmp_path, good_entries(), GOOD_META)
    built = weights.build_text_encoder_offline(paths, gemma=fake_gemma())
    assert built == ("gemma4", {"bos_token": "<bos>"}, "Gemma4Processor")


def test_wrong_sidecar_bytes_fail_the_build_with_a_plain_message(tmp_path):
    paths, _ = te_file(tmp_path, good_entries(tok_config=b'{"bos_token": <broken'), GOOD_META)
    with pytest.raises(ValueError, match="does not build offline"):
        weights.build_text_encoder_offline(paths, gemma=fake_gemma())


def test_the_build_check_exits_non_zero_with_the_message_when_the_tokenizer_does_not_build(tmp_path, monkeypatch, capsys):
    paths, _ = te_file(tmp_path, good_entries(tok_config=b"{broken"), GOOD_META)
    monkeypatch.setattr(weights, "_image_text_encoder_parts", lambda: paths)
    monkeypatch.setattr(weights, "_gemma", fake_gemma)
    with pytest.raises(SystemExit) as stop:
        weights.main(["check-text-encoder"])
    assert stop.value.code == 1
    assert "does not build offline" in capsys.readouterr().err

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


def test_the_build_loads_the_voice_filter_with_whisper_so_a_missing_onnxruntime_fails_the_build_not_a_job():
    with open(DOCKERFILE) as f:
        step = next(line for line in f if "WhisperModel('/models/whisper'" in line)
    assert "from faster_whisper.vad import get_vad_model" in step and "get_vad_model()" in step

