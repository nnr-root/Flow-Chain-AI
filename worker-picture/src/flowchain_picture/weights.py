"""The model's files on the network volume: fetched once by the `fetch-models` task, checked before every start."""

import hashlib
import os

REPO = "black-forest-labs/FLUX.2-klein-4B"
# one exact version of the model: a later upload under the same name is not what was tested
REVISION = "e7b7dc27f91deacad38e78976d1f2b499d76a294"
FOLDER = "klein-4b"
PATTERNS = ["model_index.json", "scheduler/*", "text_encoder/*", "tokenizer/*", "transformer/*", "vae/*"]
# the four files that are the model, with what they must be (size, SHA-256)
BIG = {
    "transformer/diffusion_pytorch_model.safetensors": (7751109744, "9f29f9edcfdae452"),
    "text_encoder/model-00001-of-00002.safetensors": (4967215360, "8c0506e7f4936fa7"),
    "text_encoder/model-00002-of-00002.safetensors": (3077766632, "82f2bd839378541b"),
    "vae/diffusion_pytorch_model.safetensors": (168120878, "ca70d2202afe6415"),
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
            snapshot_download(REPO, revision=REVISION, allow_patterns=PATTERNS, local_dir=target)

    os.makedirs(folder(root), exist_ok=True)
    download(folder(root))
    verify(root, sha256)
    return {"downloaded": sorted(BIG), "skipped": []}
