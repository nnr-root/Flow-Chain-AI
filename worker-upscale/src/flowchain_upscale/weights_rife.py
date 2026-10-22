"""RIFE's program and weights, baked into the image (phase 11 spec §3.1): the program is a clone pinned by commit, the
model (its code and its weights, one zip from the author's own Hugging Face account) is pinned by revision and checked
by SHA-256 when the image is built, before it can be pushed.
"""

import os

COMMIT = "bbfd2ea90910789a860ea3e2b32a240cd577b75e"
# RIFE keeps to its own virtualenv: its video reader fails under the numpy that SeedVR2's packages bring (spec §3.1)
PYTHON = "/rife/.venv/bin/python"
CLI = "/rife/inference_video.py"
# inference_video.py imports `train_log.RIFE_HDv3`, so the zip's files must land in a folder of exactly this name
FOLDER = "/rife/train_log"
ZIP_NAME = "RIFEv4.26_0921.zip"
ZIP_URL = "https://huggingface.co/hzwer/RIFE/resolve/01fdc7e97404120c243c3ea7b427046e5dc7643e/RIFEv4.26_0921.zip"
ZIP_SIZE = 22869906
ZIP_SHA256 = "1fa9b9cda3d9b8c3e301359e2595960902f97bf926c08598b0e9957a3f3f760e"
# what the four wanted files of the zip must be once extracted (name: size); the zip also holds __MACOSX, .DS_Store
# and .pyc entries that are left out
FILES = {
    "flownet.pkl": 24636301,
    "IFNet_HDv3.py": 6433,
    "RIFE_HDv3.py": 3101,
    "refine.py": 3510,
}


def present(folder=FOLDER):
    """Every file is there at its size (the zip's hash was checked when the image was built)."""
    return all(os.path.exists(os.path.join(folder, name)) and os.path.getsize(os.path.join(folder, name)) == size for name, size in FILES.items())
