"""The LTX model's files and the Whisper model, baked into the image (phase 15 spec §2): the worker runs in any data centre,
with no network volume. The Dockerfile downloads exactly these files at these revisions and checks each one before the
image can be pushed (lfs-check.sh), then writes the marker; at run time only sizes and the marker are checked.

The LTX repository is gated, and the Hub does not show a gated file's SHA-256 without a token. It does show the git id of
each file's LFS pointer, which is the SHA-1 of a three-line text naming the file's SHA-256 and size (pointer_oid): a file
whose hash and size give that id is the file the pinned revision names, so the pin is checked from public data alone.
"""

import hashlib
import json
import os
import shutil
import struct
import sys

REPO = "Lightricks/LTX-2.5"
# one exact version of the repository: a later upload under the same name is not what was tested (head on 2026-10-31,
# last changed 2026-10-11, so it is what the spike of 2026-10-31 downloaded)
REVISION = "49b093a39c19169a8a81721dcc541e07e945232f"
ROOT = "/models/ltx"

TRANSFORMER = "diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors"
TEXT_ENCODER = "text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors"
VIDEO_VAE = "vae/ltx-2.5-video-vae-bf16.safetensors"
AUDIO_VAE = "vae/ltx-2.5-audio-vae-bf16.safetensors"
SPATIAL_UPSAMPLER = "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"
# (size, git id of the LFS pointer) from the repository's own file list at REVISION (read 2026-10-31). DFR, A2Vid, the
# full model and the detailing LoRA are not used and not downloaded (spec §2).
FILES = {
    TRANSFORMER: (42018190584, "3ba48d13c75fd5df2e868aa8c07b0c5119a6116f"),
    TEXT_ENCODER: (26263858182, "daa17e623c212be771de61b2db03216ca4deabd9"),
    VIDEO_VAE: (1472223346, "4f679fe8f92b8758468fb51aae91d9fe996a4fec"),
    AUDIO_VAE: (364866540, "08403b5a5cf13570829b59c13ad3cafbff6b04e9"),
    SPATIAL_UPSAMPLER: (995778752, "cec7bee6186295d8120b8006785564c95027e526"),
}

# faster-whisper's own name "large-v3-turbo" is this repository (faster_whisper/utils.py); Systran publishes no turbo.
# It is public, so its SHA-256 is known and checked with sha256sum.
WHISPER_REPO = "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
WHISPER_REVISION = "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"
WHISPER_ROOT = "/models/whisper"
WHISPER_FILES = {"model.bin": (1617884929, "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da")}

# GHCR documents a 10 GB limit per layer (a build can succeed and the push fail). A file larger than LAYER_BYTES is held as
# byte ranges of PART_BYTES, one layer each, and joined on the worker's own disk at a cold start (assemble). The
# transformer is five parts, the text encoder three.
LAYER_BYTES = 9_000_000_000
PART_BYTES = 8_800_000_000
MARKER = ".verified"


def byte_ranges(size, part_bytes=PART_BYTES):
    """The inclusive (start, end) ranges a file of `size` bytes is downloaded as, in order (curl -r start-end)."""
    return [(start, min(start + part_bytes, size) - 1) for start in range(0, size, part_bytes)]


def _parts(name, size):
    return {f"{name}.part{i:02d}": end - start + 1 for i, (start, end) in enumerate(byte_ranges(size))}


PARTS = {name: _parts(name, size) for name, (size, _) in FILES.items() if size > LAYER_BYTES}


def pointer_oid(sha256_hex, size):
    """The git id of the LFS pointer of a file with this SHA-256 and size (what the Hub lists as a file's `oid`)."""
    pointer = f"version https://git-lfs.github.com/spec/v1\noid sha256:{sha256_hex}\nsize {size}\n".encode()
    return hashlib.sha1(b"blob %d\x00" % len(pointer) + pointer).hexdigest()


def _size(root, name):
    path = os.path.join(root, name)
    return os.path.getsize(path) if os.path.exists(path) else None


def _here(root, name, size):
    """The file is there whole, or all of its parts are, each at its size."""
    if _size(root, name) == size:
        return True
    parts = PARTS.get(name)
    return bool(parts) and all(_size(root, part) == part_size for part, part_size in parts.items())


def present(root=ROOT, whisper_root=WHISPER_ROOT):
    """Every file has its size, and the marker says the build checked them for this revision."""
    try:
        with open(os.path.join(root, MARKER)) as f:
            if f.read().strip() != REVISION:
                return False
    except FileNotFoundError:
        return False
    return all(_here(root, name, size) for name, (size, _) in FILES.items()) and all(
        _size(whisper_root, name) == size for name, (size, _) in WHISPER_FILES.items()
    )


def assemble(root=ROOT):
    """Joins every split file from its parts, streaming (never a whole file in memory); safe to repeat.

    It assumes one job at a time on a worker: two jobs joining at once would both write the same `.tmp` file. RunPod
    gives a serverless worker one job at a time unless a concurrency is set, and this worker sets none.
    """
    for name, parts in PARTS.items():
        if _size(root, name) == FILES[name][0]:
            continue
        for part, size in parts.items():
            if _size(root, part) != size:
                raise ValueError(f"{part} is missing or has the wrong size")
        joined = os.path.join(root, name)
        tmp = joined + ".tmp"
        with open(tmp, "wb") as out:
            for part in sorted(parts):
                with open(os.path.join(root, part), "rb") as f:
                    shutil.copyfileobj(f, out, 64 * 1024 * 1024)
        os.replace(tmp, joined)  # a half-written file never has the model's name


# What GemmaAssets.from_single_file (ltx_core/text_encoders/gemma/gemma_assets.py at LTX-2 e98f6d9) needs from the text
# encoder: the model's configuration as JSON in the header's metadata, the tokenizer as a tensor, and two small JSON files
# each as a tensor `hf_asset__<name>` or, in older packs, as metadata
GEMMA_CONFIG_KEY = "gemma_config"
TOKENIZER_TENSOR = "tokenizer_json"
SIDECAR_PREFIX = "hf_asset__"
REQUIRED_SIDECARS = ("tokenizer_config.json", "processor_config.json")
# safetensors refuses a header larger than this; a larger length means the bytes are not a safetensors file
MAX_HEADER_BYTES = 100_000_000


def _read_start(paths, n):
    """The first n bytes of the parts read as one file (the header is in the first part, but nothing depends on it)."""
    out = b""
    for path in paths:
        with open(path, "rb") as f:
            out += f.read(n - len(out))
        if len(out) == n:
            break
    return out


def check_text_encoder_header(paths):
    """Checks the text encoder from its header alone and returns its model configuration (a dict).

    `paths` is the file, or its parts in order. Only the first bytes of the first part are read: a build cannot map the
    26 GB file (CI run 41287628826 failed with "unable to mmap … Cannot allocate memory"). The tokenizer and the processor
    are built from tensor data, so they are checked at the first real job, where the worker loads the file anyway.
    """
    total = sum(os.path.getsize(p) for p in paths)
    head = _read_start(paths, 8)
    length = struct.unpack("<Q", head)[0] if len(head) == 8 else None
    if length is None or not 2 <= length <= min(MAX_HEADER_BYTES, total - 8):
        raise ValueError(f"{paths[0]} does not start with a safetensors header")
    try:
        header = json.loads(_read_start(paths, 8 + length)[8:])
    except ValueError as err:
        raise ValueError(f"the safetensors header of {paths[0]} is not JSON") from err
    metadata = header.pop("__metadata__", None) or {}
    ends = [entry["data_offsets"][1] for entry in header.values()]
    if not ends or max(ends) != total - 8 - length:
        raise ValueError(f"the tensors' data ends at {max(ends, default=0)}, but the parts hold {total - 8 - length} bytes of data")
    if TOKENIZER_TENSOR not in header:
        raise ValueError(f"the text encoder has no {TOKENIZER_TENSOR} tensor")
    for name in REQUIRED_SIDECARS:
        if SIDECAR_PREFIX + name not in header and name not in metadata:
            raise ValueError(f"the text encoder carries no {name}, as a tensor or as metadata")
    if GEMMA_CONFIG_KEY not in metadata:
        raise ValueError(f"the text encoder's metadata has no {GEMMA_CONFIG_KEY}")
    config = json.loads(metadata[GEMMA_CONFIG_KEY])
    if not isinstance(config, dict) or not config.get("model_type"):
        raise ValueError(f"the text encoder's {GEMMA_CONFIG_KEY} has no model_type")
    return config


def _check_text_encoder_in_image():
    """The build's check: the header of the parts in the image, then the configuration built by the program's own builder,
    offline (HF_HUB_OFFLINE in the image), from the metadata alone: no tensor is opened."""
    paths = [os.path.join(ROOT, part) for part in sorted(PARTS[TEXT_ENCODER])]
    config = check_text_encoder_header(paths)
    from ltx_core.text_encoders.gemma.gemma_assets import GemmaAssets, build_gemma_hf_config

    assets = GemmaAssets(source=paths[0], config_dict=config, tokenizer_json=b"", sidecars={}, weight_paths=())
    built = build_gemma_hf_config(assets)
    print(f"text encoder header checked: {type(built).__name__}, model_type {config['model_type']}")


if __name__ == "__main__":
    if sys.argv[1:] != ["check-text-encoder"]:
        sys.exit("usage: python -m flowchain_ltx.weights check-text-encoder")
    _check_text_encoder_in_image()
