"""The Foley model's files, baked into the image (phase 14 plan, Ruling 1): the worker runs in any data centre, with no
network volume. The Dockerfile downloads exactly these files at these revisions and checks their SHA-256 with
`sha256sum -c` before the image can be pushed, then writes the marker; at run time only sizes and the marker are checked.

The model's own program loads two text/vision encoders by name from the Hugging Face Hub (SigLIP 2 and CLAP); the image
holds them too, in a Hub cache under ROOT, and sets HF_HUB_OFFLINE so nothing is fetched while a job runs.
"""

import hashlib
import os

REPO = "tencent/HunyuanVideo-Foley"
# one exact version of each repository: a later upload under the same name is not what was tested (read 2026-10-31)
REVISION = "3abd4e833b95b8db0fc9c687afc52483a48e9a97"
SIGLIP_REPO = "google/siglip2-base-patch16-512"
SIGLIP_REVISION = "a89f5c5093f902bf39d3cd4d81d2c09867f0724b"
CLAP_REPO = "laion/larger_clap_general"
CLAP_REVISION = "ada0c23a36c4e8582805bb38fec3905903f18b41"
ROOT = "/models/foley"
# the Hub cache the encoders are read from (HF_HOME in the image is ROOT/hf)
SIGLIP_DIR = f"hf/hub/models--google--siglip2-base-patch16-512/snapshots/{SIGLIP_REVISION}"
CLAP_DIR = f"hf/hub/models--laion--larger_clap_general/snapshots/{CLAP_REVISION}"
# the large files (LFS) with what they must be (size, first 16 hex of SHA-256), from the repositories' own file records;
# the XL model (hunyuanvideo_foley_xl.pth) is not used and not downloaded
BIG = {
    "hunyuanvideo_foley.pth": (10301204679, "2900021f8ee562a8"),
    "synchformer_state_dict.pth": (950058171, "8aff082f2df5c3bc"),
    "vae_128d_48k.pth": (1486465965, "07e6139ff33bd21b"),
    f"{SIGLIP_DIR}/model.safetensors": (1503344520, "fe0e601c625e69ee"),
    f"{CLAP_DIR}/pytorch_model.bin": (776444665, "314eb00cce6ad68d"),
}
MARKER = ".verified"


def present(root=ROOT):
    """Every big file has its size, and the marker says their hashes were checked for this version."""
    try:
        with open(os.path.join(root, MARKER)) as f:
            if f.read().strip() != REVISION:
                return False
    except FileNotFoundError:
        return False
    return all(os.path.exists(os.path.join(root, name)) and os.path.getsize(os.path.join(root, name)) == size for name, (size, _) in BIG.items())


def _sha256(path, chunk=8 * 1024 * 1024):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk)
            if not block:
                return digest.hexdigest()
            digest.update(block)


def verify(root=ROOT, sha256=_sha256):
    """Checks the big files' sizes and hashes and writes the marker. Raises on the first that is wrong."""
    for name, (size, start) in BIG.items():
        path = os.path.join(root, name)
        if not os.path.exists(path) or os.path.getsize(path) != size:
            raise ValueError(f"{name} is missing or has the wrong size")
        if not sha256(path).startswith(start):
            raise ValueError(f"{name} is not the file that was tested (its SHA-256 differs)")
    with open(os.path.join(root, MARKER), "w") as f:
        f.write(REVISION)
