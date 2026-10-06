"""Frames → H.264 MP4 with ffmpeg (independent of ComfyUI's video nodes, whose inputs change between versions)."""

import os
import subprocess


def frames_to_mp4(frames, fps, out):
    if not frames:
        raise ValueError("no frames to encode")
    listing = out + ".frames.txt"
    with open(listing, "w") as f:
        for path in frames:
            f.write(f"file '{os.path.abspath(path)}'\nduration {1 / fps}\n")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listing, "-r", str(fps),
             "-frames:v", str(len(frames)), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", out],
            check=True,
        )
    finally:
        os.remove(listing)
    return out
