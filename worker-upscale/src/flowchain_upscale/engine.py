"""Upscales one clip with SeedVR2's own command-line program (phase 8 spec §8), the way the trial measured it."""

import os
import subprocess

from flowchain_upscale import weights_rife

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


def steps(req):
    """The steps a request asks for, in the order that keeps one file on the worker's disk: upscale, then interpolate."""
    out = []
    if req.get("short") is not None:
        out.append("upscale")
    if req.get("interpolate") is not None:
        out.append("interpolate")
    return out


def probe_command(src):
    return ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-of", "default=noprint_wrappers=1:nokey=1", src]


def frame_rate(src, run=subprocess.run):
    """The clip's frame rate, as ffprobe reports it (a fraction such as 32/1 or 30000/1001)."""
    done = run(probe_command(src), capture_output=True, text=True)
    text = (done.stdout or "").strip()
    try:
        num, _, den = text.partition("/")
        rate = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        rate = 0.0
    if done.returncode != 0 or rate <= 0:
        raise RuntimeError(f"could not read the clip's frame rate ({done.returncode}): {(done.stderr or text)[-300:]}")
    return rate


def rife_command(src, out, multiplier, fps, python=weights_rife.PYTHON):
    """RIFE's command line for one clip (pure, so it is tested without a GPU); spec §3.1 has the flags.

    --fps only sets the container's rate, but it must always be given: without it the script runs an audio step that
    fails (clips carry no audio). The frames out are multiplier x (N - 1) + 1 whatever it says. No --fp16, scale 1.0.
    """
    return [python, weights_rife.CLI, f"--multi={multiplier}", f"--video={src}", f"--output={out}", f"--model={weights_rife.FOLDER}", f"--fps={fps}"]


def reencode_command(src, out, fps):
    """RIFE writes MPEG-4 Part 2; the pipeline wants H.264. CRF 16 so that this second lossy generation is invisible."""
    return ["ffmpeg", "-y", "-i", src, "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-r", str(fps), "-an", out]


def _tail(done):
    return (done.stderr or done.stdout or "")[-1500:]


def interpolate(src, out, multiplier, run=subprocess.run):
    """RIFE, then a re-encode to H.264, into out. Raises with the end of the failing process's output; nothing is retried.

    A clip of N frames comes out as 2N-1 frames (one frame short of twice the length); nothing here pads it, because
    the pipeline's `fit` already pads and trims every clip to the frame count it needs.
    """
    fps = round(frame_rate(src, run) * multiplier)
    middle = out + ".rife.mp4"
    try:
        done = run(rife_command(src, middle, multiplier, fps), capture_output=True, text=True)
        if done.returncode != 0:
            raise RuntimeError(f"RIFE failed ({done.returncode}): {_tail(done)}")
        done = run(reencode_command(middle, out, fps), capture_output=True, text=True)
        if done.returncode != 0:
            raise RuntimeError(f"re-encode failed ({done.returncode}): {_tail(done)}")
    finally:
        try:
            os.remove(middle)
        except FileNotFoundError:
            pass
