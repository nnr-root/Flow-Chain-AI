"""Makes one clip: LTX-2.5's distilled pipeline from a start frame and a prompt, with its sound; and, for a speaking scene,
the words heard in it with their times (spec §13.1: the studio's captions need them and the clip's speech has no other
source).

Both models are loaded once per worker (module globals), as the voice worker does: loading takes the time of a cold start.
The pipeline is called through its Python class, `DistilledPipeline` (ltx_pipelines/distilled.py at the pinned commit),
with exactly what its own CLI `python -m ltx_pipelines.distilled` passes it: the CLI would load the 60 GiB of weights again
for every clip. The model, Whisper and the transcription are parameters of make_clip, so every test runs with fakes and
no torch (the real ones import torch and ltx only when called).
"""

import json
import os
import subprocess
from dataclasses import dataclass

from flowchain_ltx import MIN_HOST_CUDA, weights

TRANSFORMER = f"{weights.ROOT}/{weights.TRANSFORMER}"
TEXT_ENCODER = f"{weights.ROOT}/{weights.TEXT_ENCODER}"
VIDEO_VAE = f"{weights.ROOT}/{weights.VIDEO_VAE}"
AUDIO_VAE = f"{weights.ROOT}/{weights.AUDIO_VAE}"
SPATIAL_UPSAMPLER = f"{weights.ROOT}/{weights.SPATIAL_UPSAMPLER}"
# the transformer cast to FP8 as it loads: the spike of 2026-10-31 ran this way on a 48 GB A40, the smallest card offered
QUANTIZATION = "fp8-cast"
WHISPER_DIR = weights.WHISPER_ROOT
WHISPER_COMPUTE = "float16"

# A clip longer than this is made in overlapping windows: the spike made 289 and 361 frames this way, and one window over
# the whole of a long clip is what runs out of memory on the smaller cards
WINDOW_ABOVE_FRAMES = 121
CHUNK_PIXEL_FRAMES = 97
CHUNK_CARRY_FRAMES = 25
# a word Whisper gives no length still needs one for a caption to be shown
MIN_WORD_SECONDS = 0.01

_PIPELINE = None
_WHISPER = None


@dataclass(frozen=True)
class ClipResult:
    mp4_path: str
    seconds: float
    has_audio: bool
    # None unless the request asked for speech; then every word heard, in order
    words: list | None
    # None unless an ordinary clip asked for a voice check; then whether Whisper heard any word in its sound
    voice_heard: bool | None = None


def _require_gpu():
    import torch  # lazily: only the image has it

    # never the CPU: there a job runs until the endpoint's limit and is charged for it. A host whose driver is older than
    # the CUDA this PyTorch was built for shows no GPU, and the job must fail at once instead
    if not torch.cuda.is_available():
        raise RuntimeError(f"LTX needs a GPU: no GPU with a driver for CUDA {MIN_HOST_CUDA} is available on this worker")
    return torch


def pipeline(loader=None):
    """The loaded pipeline, built on the first call only."""
    global _PIPELINE
    if _PIPELINE is None:
        _PIPELINE = (loader or _load)()
    return _PIPELINE


def listener(loader=None):
    """The loaded Whisper model, built on the first call only (a clip without speech never loads it)."""
    global _WHISPER
    if _WHISPER is None:
        _WHISPER = (loader or _load_whisper)()
    return _WHISPER


def _load():
    torch = _require_gpu()
    from ltx_pipelines.distilled import DistilledPipeline
    from ltx_pipelines.utils.model_paths import ModelPaths
    from ltx_pipelines.utils.quantization_factory import QuantizationKind

    # the split layout, as the CLI builds it from --transformer-path, --text-encoder-path, --video-vae-path and
    # --audio-vae-path (model_paths_from_namespace); no duration head: every request names its frames
    paths = ModelPaths.from_split(
        transformer_path=TRANSFORMER, text_encoder_path=TEXT_ENCODER, video_vae_path=VIDEO_VAE, audio_vae_path=AUDIO_VAE
    )
    return DistilledPipeline(
        model_paths=paths,
        spatial_upsampler_path=SPATIAL_UPSAMPLER,
        loras=(),
        device=torch.device("cuda"),
        quantization=QuantizationKind(QUANTIZATION).to_policy(checkpoint_path=TRANSFORMER),
    )


def _load_whisper():
    _require_gpu()
    from faster_whisper import WhisperModel

    # a folder, not a name: the image holds the model there and the worker never reaches the Hub
    model = WhisperModel(WHISPER_DIR, device="cuda", compute_type=WHISPER_COMPUTE)
    # the voice filter a voice check runs (silero through onnxruntime, cached by faster-whisper) is loaded here too, before
    # any clip is generated: a missing onnxruntime or asset then fails a job that bought nothing, not one with a paid clip
    from faster_whisper.vad import get_vad_model

    get_vad_model()
    return model


def pipeline_args(req, image_path, out_path):
    """What the CLI would be given for this request, by its flags' names (pure: the tests read it)."""
    args = {
        "prompt": req.prompt,
        "seed": req.seed,
        "width": req.width,
        "height": req.height,
        "num_frames": req.frames,
        "frame_rate": req.fps,
        # --image PNG 0 1.0: the start frame replaces frame 0 at full strength
        "image_path": image_path,
        "image_frame": 0,
        "image_strength": 1.0,
        "output_path": out_path,
    }
    if req.frames > WINDOW_ABOVE_FRAMES:
        args["chunk_pixel_frames"] = CHUNK_PIXEL_FRAMES
        args["chunk_carry_frames"] = CHUNK_CARRY_FRAMES
    return args


def _generate(args, loaded=None):
    """The body of ltx_pipelines.distilled.main() at the pinned commit, with the loaded pipeline and these arguments.

    The CLI's other flags keep their defaults: no LoRA, no prompt enhancer, no HDR, no generated keyframes, no
    watermark pack (--marker-root-path was not given in the spike), automatic tiling.
    """
    loaded = loaded or pipeline()  # first: a worker without a GPU is refused before anything else is imported or run
    import torch
    from ltx_core.model.video_vae import AUTO_TILING, get_video_chunks_number
    from ltx_pipelines.chunks import ChunkConfig, pipeline_output_from_chunks, split_decoded_chunks
    from ltx_pipelines.utils.media_io import encode_video
    from ltx_pipelines.utils.types import ImageConditioningInput

    chunk_config = None
    if "chunk_pixel_frames" in args:
        chunk_config = ChunkConfig(chunk_pixel_frames=args["chunk_pixel_frames"], next_video_carry_frames=args["chunk_carry_frames"])
    frame_rate = float(args["frame_rate"])  # the CLI's --frame-rate is a float
    with torch.inference_mode():
        chunks, num_frames, tiling_config = loaded.stream_chunks(
            prompt=args["prompt"],
            seed=args["seed"],
            height=args["height"],
            width=args["width"],
            num_frames=args["num_frames"],
            frame_rate=frame_rate,
            images=[ImageConditioningInput.at(args["image_path"], args["image_frame"], args["image_strength"])],
            vae_dtype=torch.bfloat16,
            color_space=None,
            enhance_prompt=False,
            enhance_static_cache=False,
            tiling_config=AUTO_TILING,
            generated_keyframes=0,
            decode_with_keyframes=False,
            chunk_config=chunk_config,
        )
        if chunk_config is not None:
            video, audio, audio_sampling_rate = split_decoded_chunks(chunks)
            video_chunks_number = 1
        else:
            result = pipeline_output_from_chunks(chunks, num_frames=num_frames, tiling_config=tiling_config)
            video, audio, audio_sampling_rate = result.video, result.audio, None
            video_chunks_number = get_video_chunks_number(result.num_frames, result.tiling_config)
        encode_video(
            video=video,
            fps=frame_rate,
            audio=audio,
            output_path=args["output_path"],
            video_chunks_number=video_chunks_number,
            color_space=None,
            audio_sampling_rate=audio_sampling_rate,
            video_marker=None,
            audio_marker=None,
        )


def _transcribe(path, language, model=None):
    """Every word Whisper hears in the clip's sound, as it gives them (the same settings as the voice worker)."""
    segments, _ = (model or listener()).transcribe(path, language=language, word_timestamps=True, beam_size=5, condition_on_previous_text=False)
    return [{"text": w.word, "start": w.start, "end": w.end} for s in segments for w in (s.words or [])]


def _hears_a_voice(path, model):
    """Whether Whisper hears any word in the clip's sound. The language is left to Whisper (a stranger's voice can be in
    any) and its voice filter skips what is not speech, so ambience is less often taken for a word."""
    segments, _ = model.transcribe(path, word_timestamps=True, beam_size=5, condition_on_previous_text=False, vad_filter=True)
    return len(clean_words({"text": w.word, "start": w.start, "end": w.end} for s in segments for w in (s.words or []))) > 0


def clean_words(raw):
    """Words with text, in order of their start, each ending after it starts, times in seconds to the millisecond."""
    words = []
    for w in raw:
        text = str(w["text"]).strip()
        if not text:
            continue
        start = round(max(0.0, float(w["start"])), 3)
        end = round(max(float(w["end"]), start + MIN_WORD_SECONDS), 3)
        words.append({"text": text, "start": start, "end": end})
    return sorted(words, key=lambda w: (w["start"], w["end"]))


def probe(path):
    """The clip's length in seconds and whether it has a sound stream, as ffprobe reads them."""
    done = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path],
        capture_output=True, text=True, check=True, timeout=60,
    )
    info = json.loads(done.stdout)
    kinds = {s.get("codec_type") for s in info.get("streams", [])}
    if "video" not in kinds:
        raise RuntimeError("the model made no clip: the file has no video stream")
    return round(float(info["format"]["duration"]), 3), "audio" in kinds


def make_clip(req, workdir="/tmp", generate=None, transcribe=None, load_listener=None):
    """Makes the clip the request asks for in workdir; returns a ClipResult."""
    heard_by = None
    # a voice check is only for a clip that does not ask for speech: a speaking clip's words already say who speaks
    check_voice = req.detect_voice and req.speech_language is None
    if req.speech_language is not None or check_voice:
        # Whisper is loaded before the clip is made: a worker whose CUDA 12 or cuDNN libraries are wrong then fails a
        # job that bought nothing, instead of generating a paid clip and failing to hear it afterwards.
        heard_by = (load_listener or listener)()
    image_path = os.path.join(workdir, "start.png")
    out_path = os.path.join(workdir, "clip.mp4")
    with open(image_path, "wb") as f:
        f.write(req.image_png)
    (generate or _generate)(pipeline_args(req, image_path, out_path))
    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        raise RuntimeError("the model made no clip")
    seconds, has_audio = probe(out_path)
    words = None
    if req.speech_language is not None:
        # a clip without sound has no words; Whisper is not run on silence it was never given
        if not has_audio:
            words = []
        elif transcribe:
            words = clean_words(transcribe(out_path, req.speech_language))
        else:
            words = clean_words(_transcribe(out_path, req.speech_language, heard_by))
    voice_heard = None
    if check_voice:
        # silence has no voice in it; Whisper is not run on a sound it was never given. Only the answer leaves the worker,
        # never the words: nothing downstream may show or use what a stranger's voice said
        try:
            voice_heard = has_audio and _hears_a_voice(out_path, heard_by)
        except Exception as err:  # noqa: BLE001 - listening must never lose a clip that was paid for
            # an unchecked sound is not trusted: the scene loses only its ambience. The error's kind alone is logged,
            # never what was heard
            print(f"voice check failed ({type(err).__name__}); the clip's sound is treated as carrying a voice", flush=True)
            voice_heard = True
    return ClipResult(mp4_path=out_path, seconds=seconds, has_audio=has_audio, words=words, voice_heard=voice_heard)
