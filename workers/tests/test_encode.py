import subprocess

from flowchain_worker import encode
from flowchain_worker.encode import frames_to_mp4


def test_encodes_frames_at_the_given_rate(tmp_path):
    frames = []
    for i in range(8):
        path = tmp_path / f"out_{i:05d}_.png"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"color=c=0x{i * 30:02x}3366:s=64x96",
                        "-frames:v", "1", str(path)], check=True)
        frames.append(str(path))
    out = frames_to_mp4(frames, 32, str(tmp_path / "clip.mp4"))
    probe = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                            "stream=nb_read_frames,r_frame_rate,codec_name", "-of", "csv=p=0", out],
                           capture_output=True, text=True, check=True).stdout.strip()
    assert probe == "h264,32/1,8"


def test_the_warm_ups_picture_is_a_png_of_the_size_asked_for():
    import struct
    import zlib

    png = encode.blank_png(256, 144)
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and struct.unpack(">II", png[16:24]) == (256, 144)
    idat = png[png.index(b"IDAT") + 4:png.index(b"IEND") - 8]
    assert len(zlib.decompress(idat)) == 144 * (1 + 3 * 256)
