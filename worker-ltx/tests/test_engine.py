import json
import os
import shutil
import subprocess
import sys
import types

import pytest

from flowchain_ltx import contract, engine

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="needs ffmpeg")

PNG = b"\x89PNG\r\n\x1a\n" + b"pixels"


def request(**over):
    fields = dict(image_png=PNG, prompt="a fox runs", frames=49, fps=24, width=256, height=448, seed=7, speech_language=None)
    fields.update(over)
    return contract.ClipRequest(**fields)


class FakePipeline:
    """Stands in for the model: records what it was asked and writes a short mp4 (with or without sound) where it was told."""

    def __init__(self, audio=True):
        self.calls = []
        self.audio = audio

    def __call__(self, args):
        self.calls.append(dict(args))
        assert open(args["image_path"], "rb").read() == PNG  # the picture is on disk before the model runs
        seconds = args["num_frames"] / args["frame_rate"]
        cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=gray:s=64x64:r={args['frame_rate']}:d={seconds}"]
        if self.audio:
            cmd += ["-f", "lavfi", "-i", f"sine=f=440:d={seconds}", "-c:a", "aac"]
        cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", args["output_path"]]
        subprocess.run(cmd, check=True)


class FakeListener:
    def __init__(self, words):
        self.words = words
        self.calls = []

    def __call__(self, path, language):
        self.calls.append((path, language))
        return self.words


def make(tmp_path, req=None, pipeline=None, listener=None):
    return engine.make_clip(req or request(), workdir=str(tmp_path), generate=pipeline or FakePipeline(), transcribe=listener or FakeListener([]))


@needs_ffmpeg
def test_makes_a_clip_with_an_audio_stream_and_reads_its_length(tmp_path):
    result = make(tmp_path)
    assert result.has_audio is True
    assert result.seconds == pytest.approx(49 / 24, abs=0.06)
    assert os.path.exists(result.mp4_path) and os.path.dirname(result.mp4_path) == str(tmp_path)
    streams = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", result.mp4_path], capture_output=True, text=True, check=True
    )
    assert {s["codec_type"] for s in json.loads(streams.stdout)["streams"]} == {"video", "audio"}


@needs_ffmpeg
def test_says_when_the_clip_has_no_sound(tmp_path):
    assert make(tmp_path, pipeline=FakePipeline(audio=False)).has_audio is False


@needs_ffmpeg
def test_passes_the_request_to_the_pipeline_as_the_cli_takes_it(tmp_path):
    p = FakePipeline()
    make(tmp_path, req=request(prompt="rain", seed=99, width=640, height=1152, frames=121), pipeline=p)
    call = p.calls[0]
    assert (call["prompt"], call["seed"], call["width"], call["height"], call["num_frames"], call["frame_rate"]) == ("rain", 99, 640, 1152, 121, 24)
    # the start frame binds at frame 0 with full strength (--image PNG 0 1.0)
    assert (call["image_frame"], call["image_strength"]) == (0, 1.0)


@needs_ffmpeg
@pytest.mark.parametrize("frames", [49, 97, 121])
def test_a_clip_of_up_to_121_frames_is_made_in_one_window(tmp_path, frames):
    p = FakePipeline()
    make(tmp_path, req=request(frames=frames), pipeline=p)
    assert "chunk_pixel_frames" not in p.calls[0] and "chunk_carry_frames" not in p.calls[0]


@needs_ffmpeg
@pytest.mark.parametrize("frames", [129, 289, 361])
def test_a_clip_longer_than_121_frames_is_made_in_windows_of_97_carrying_25(tmp_path, frames):
    p = FakePipeline()
    make(tmp_path, req=request(frames=frames), pipeline=p)
    assert (p.calls[0]["chunk_pixel_frames"], p.calls[0]["chunk_carry_frames"]) == (97, 25)


@needs_ffmpeg
def test_words_are_none_and_whisper_never_runs_without_a_speech_language(tmp_path):
    listener = FakeListener([{"text": "hi", "start": 0.1, "end": 0.4}])
    assert make(tmp_path, listener=listener).words is None
    assert listener.calls == []


@needs_ffmpeg
def test_words_of_a_speaking_clip_are_sorted_trimmed_and_each_ends_after_it_starts(tmp_path):
    listener = FakeListener(
        [
            {"text": " world", "start": 0.62, "end": 0.9},
            {"text": " Hello", "start": 0.1, "end": 0.5},
            {"text": " !", "start": 0.95, "end": 0.95},
            {"text": "   ", "start": 1.0, "end": 1.2},
        ]
    )
    words = make(tmp_path, req=request(speech_language="tr"), listener=listener).words
    assert [w["text"] for w in words] == ["Hello", "world", "!"]
    assert all(set(w) == {"text", "start", "end"} and w["start"] < w["end"] for w in words)
    assert [w["start"] for w in words] == sorted(w["start"] for w in words)
    path, language = listener.calls[0]
    assert language == "tr" and path.endswith(".mp4")


@needs_ffmpeg
def test_a_speaking_clip_without_sound_has_no_words_and_whisper_is_not_run(tmp_path):
    listener = FakeListener([{"text": "hi", "start": 0.1, "end": 0.4}])
    result = make(tmp_path, req=request(speech_language="en"), pipeline=FakePipeline(audio=False), listener=listener)
    assert result.words == [] and listener.calls == []


def test_a_pipeline_that_writes_nothing_is_an_error(tmp_path):
    with pytest.raises(RuntimeError, match="no clip"):
        engine.make_clip(request(), workdir=str(tmp_path), generate=lambda args: None, transcribe=FakeListener([]))


def _no_gpu(monkeypatch):
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)
    torch.device = lambda name: pytest.fail(f"a device was chosen: {name}")
    monkeypatch.setitem(sys.modules, "torch", torch)


def test_the_real_loader_refuses_a_worker_without_a_gpu_instead_of_running_on_the_cpu(monkeypatch):
    _no_gpu(monkeypatch)
    with pytest.raises(RuntimeError, match="LTX needs a GPU"):
        engine._load()
    with pytest.raises(RuntimeError, match="LTX needs a GPU"):
        engine._load_whisper()


def test_making_a_clip_with_the_real_model_on_a_cpu_is_refused_before_anything_runs(monkeypatch, tmp_path):
    _no_gpu(monkeypatch)
    monkeypatch.setattr(engine, "_PIPELINE", None)
    with pytest.raises(RuntimeError, match="LTX needs a GPU"):
        engine.make_clip(request(), workdir=str(tmp_path))


def test_loads_the_pipeline_and_whisper_once_through_the_loaders_they_are_given(monkeypatch):
    monkeypatch.setattr(engine, "_PIPELINE", None)
    monkeypatch.setattr(engine, "_WHISPER", None)
    calls = []
    assert engine.pipeline(loader=lambda: calls.append("p") or "P") == "P"
    assert engine.pipeline(loader=lambda: calls.append("p") or "P") == "P"
    assert engine.listener(loader=lambda: calls.append("w") or "W") == "W"
    assert engine.listener(loader=lambda: calls.append("w") or "W") == "W"
    assert calls == ["p", "w"]


def test_the_model_files_are_read_from_the_image_in_fp8_cast():
    assert engine.QUANTIZATION == "fp8-cast"
    for path in (engine.TRANSFORMER, engine.TEXT_ENCODER, engine.VIDEO_VAE, engine.AUDIO_VAE, engine.SPATIAL_UPSAMPLER):
        assert path.startswith("/models/ltx/") and path.endswith(".safetensors")
    assert engine.WHISPER_DIR == "/models/whisper" and engine.WHISPER_COMPUTE == "float16"
