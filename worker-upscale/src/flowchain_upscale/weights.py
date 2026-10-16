"""SeedVR2's files, baked into the image (phase 8 spec §8): the network volume holds the clip and picture models and
has no room left, and a worker reads these at every start, which its own disk does fastest.

The 3B model, not the 7B: in the trial of 2026-10-16 the two were close (7B a little more natural), and the 3B fits
the 24 GB cards the studio's endpoints run on with room for full HD. The Dockerfile downloads exactly these files,
at this revision, and checks their SHA-256 before the image can be pushed.
"""

import os

REPO = "numz/SeedVR2_comfyUI"
REVISION = "09ced71023636e9bc8cdf9cdecfb2625d1e691e8"
FOLDER = "/models/seedvr2"
DIT = "seedvr2_ema_3b_fp16.safetensors"
VAE = "ema_vae_fp16.safetensors"
# what each must be (size, SHA-256), read from the repository's own file records
FILES = {
    DIT: (6783018808, "2fd0e03a3dad24e07086750360727ca437de4ecd456f769856e960ae93e2b304"),
    VAE: (501324814, "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1"),
}


def present(folder=FOLDER):
    """Every file is there at its size (its hash was checked when the image was built)."""
    return all(os.path.exists(os.path.join(folder, name)) and os.path.getsize(os.path.join(folder, name)) == size for name, (size, _) in FILES.items())
