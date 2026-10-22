"""Run by the Dockerfile with RIFE's own virtualenv's python, so the image is not pushed unless RIFE can start (spec §3.1).

Two things only a build can confirm: that the image's torch runs with the venv's numpy 1.23.5, and that the zip's
RIFE_HDv3.py loads flownet.pkl under a torch whose torch.load defaults to weights_only=True. It needs no GPU: torch.load
is told to map to the CPU (the weights may have been saved from a CUDA card, and a build host has none).
"""

import functools
import sys

import cv2  # noqa: F401
import numpy
import skvideo.io  # noqa: F401
import torch

assert numpy.__version__ == "1.23.5", numpy.__version__

_load = torch.load
torch.load = functools.partial(_load, map_location="cpu")  # an explicit map_location from the caller still wins

sys.path.insert(0, "/rife")
from train_log.RIFE_HDv3 import Model  # noqa: E402

model = Model()
model.load_model("/rife/train_log", -1)
print("RIFE loads: numpy", numpy.__version__, "torch", torch.__version__)
