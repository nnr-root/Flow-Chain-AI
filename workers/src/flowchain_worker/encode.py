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


def blank_png(width, height):
    """A black PNG of that size, made here: the warm-up needs a picture to start from and has no one's to use."""
    import struct
    import zlib

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = (b"\x00" + b"\x00" * (3 * width)) * height
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
