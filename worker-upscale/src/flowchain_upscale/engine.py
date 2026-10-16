"""Upscales one clip with SeedVR2's own command-line program (phase 8 spec §8), the way the trial measured it."""

import subprocess

CLI = "/seedvr2/inference_cli.py"
# frames per batch (4n+1), blended where batches meet. 33 ran on an A100's 80 GB in the trial; on the endpoint's 24 GB
# card it ran out of memory in the VAE on the first live clip (2026-10-16), so batches are smaller there, and the
# VAE encodes and decodes a full HD frame in tiles
BATCH = 21
OVERLAP = 4
TILE = 768


def command(src, out, short, model_dir, dit, python="python"):
    """The command line for one clip (pure, so it is tested without a GPU)."""
    return [
        python, CLI, src,
        "--output", out,
        "--model_dir", model_dir,
        "--dit_model", dit,
        "--resolution", str(short),
        "--batch_size", str(BATCH),
        "--temporal_overlap", str(OVERLAP),
        "--vae_encode_tiled", "--vae_encode_tile_size", str(TILE),
        "--vae_decode_tiled", "--vae_decode_tile_size", str(TILE),
    ]


def upscale(src, out, short, model_dir, dit, run=subprocess.run):
    """Runs it and raises with the end of its output when it fails; nothing is retried here."""
    done = run(command(src, out, short, model_dir, dit), capture_output=True, text=True)
    if done.returncode != 0:
        tail = (done.stderr or done.stdout or "")[-1500:]
        raise RuntimeError(f"SeedVR2 failed ({done.returncode}): {tail}")
