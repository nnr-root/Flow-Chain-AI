"""The FLUX 3 klein model's files on the network volume: fetched once by the `fetch-models` task, checked before every start."""

import hashlib
import os

REPO = "black-forest-labs/flux-3-image-klein"
# one exact version of the model: a later upload under the same name is not what was tested
REVISION = "337337621b8526e120f2275d250242f4a6bedd75"
FOLDER = "flux3-klein"
# the diffusers layout of spec §3.1; the model repository is gated, so the download carries the owner's token
PATTERNS = ["modular_model_index.json", "transformer/*", "vae/*", "text_encoder/*"]
# the five large files (LFS) with what they must be (size, first 16 hex of SHA-256), from spec §3.1; the small files are
# not hashed, as in the 4B module
BIG = {
    "transformer/diffusion_pytorch_model-00001-of-00002.safetensors": (9907529352, "4f01de4147009058"),
    "transformer/diffusion_pytorch_model-00002-of-00002.safetensors": (1189878064, "6f6217ab2c7ce5ef"),
    "text_encoder/model-00001-of-00002.safetensors": (4967229296, "30a01a0556622645"),
    "text_encoder/model-00002-of-00002.safetensors": (3908490048, "046296a2a387efb4"),
    "vae/diffusion_pytorch_model.safetensors": (336213556, "d64f3a68e1cc4f9f"),
}
MARKER = ".verified"


def folder(root):
    return os.path.join(root, FOLDER)


def present(root):
    """Every big file has its size, and the marker says their hashes were checked for this version."""
    base = folder(root)
    try:
        with open(os.path.join(base, MARKER)) as f:
            if f.read().strip() != REVISION:
                return False
    except FileNotFoundError:
        return False
    return all(os.path.exists(os.path.join(base, name)) and os.path.getsize(os.path.join(base, name)) == size for name, (size, _) in BIG.items())


def _sha256(path, chunk=8 * 1024 * 1024):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk)
            if not block:
                return digest.hexdigest()
            digest.update(block)


def verify(root, sha256=_sha256):
    """Checks the big files' sizes and hashes and writes the marker. Raises on the first that is wrong."""
    base = folder(root)
    for name, (size, start) in BIG.items():
        path = os.path.join(base, name)
        if not os.path.exists(path) or os.path.getsize(path) != size:
            raise ValueError(f"{name} is missing or has the wrong size")
        if not sha256(path).startswith(start):
            raise ValueError(f"{name} is not the file that was tested (its SHA-256 differs)")
    with open(os.path.join(base, MARKER), "w") as f:
        f.write(REVISION)


def fetch(root, download=None, sha256=_sha256):
    """Downloads what is missing and checks it. Safe to repeat: finished files are kept."""
    if present(root):
        return {"downloaded": [], "skipped": sorted(BIG)}
    if download is None:
        from huggingface_hub import snapshot_download  # imported lazily: the pure parts stay testable without it

        def download(target):
            snapshot_download(REPO, revision=REVISION, allow_patterns=PATTERNS, local_dir=target, token=os.environ.get("HF_TOKEN"))

    os.makedirs(folder(root), exist_ok=True)
    download(folder(root))
    verify(root, sha256)
    return {"downloaded": sorted(BIG), "skipped": []}
