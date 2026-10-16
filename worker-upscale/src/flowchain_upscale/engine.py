"""Upscales one clip with SeedVR2's own command-line program (phase 8 spec §8), the way the trial measured it."""

import subprocess

CLI = "/seedvr2/inference_cli.py"
# frames per batch (4n+1): a 480p clip of up to 81 frames goes in one or two batches, blended where they meet
BATCH = 33
OVERLAP = 4


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
        # (on a 24 GB card the decode of a full HD batch is done in tiles)
        "--vae_decode_tiled",
    ]


def upscale(src, out, short, model_dir, dit, run=subprocess.run):
    """Runs it and raises with the end of its output when it fails; nothing is retried here."""
    done = run(command(src, out, short, model_dir, dit), capture_output=True, text=True)
    if done.returncode != 0:
        tail = (done.stderr or done.stdout or "")[-1500:]
        raise RuntimeError(f"SeedVR2 failed ({done.returncode}): {tail}")
