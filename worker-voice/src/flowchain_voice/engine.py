"""The two models, loaded once per worker: VoxCPM2 speaks, a Whisper model says when each word was spoken.

Nothing here writes a script line, a file name or a transcript to a log (phase 5 spec §8).
"""

import glob
import inspect
import os
import subprocess

_speaker = None
_listener = None


def _nvidia_libs():
    """ctranslate2 looks for cuDNN and cuBLAS on the library path; the pip packages put them under site-packages."""
    import site

    found = []
    for root in site.getsitepackages():
        found += glob.glob(os.path.join(root, "nvidia", "*", "lib"))
    if found:
        os.environ["LD_LIBRARY_PATH"] = ":".join(found + [os.environ.get("LD_LIBRARY_PATH", "")]).strip(":")


def speaker():
    global _speaker
    if _speaker is None:
        from voxcpm import VoxCPM

        kwargs = {"load_denoiser": False}
        # Compiling the model makes speech a little faster and a cold start much slower (about a minute and a
        # half, measured): off unless the owner turns it on for an endpoint that stays warm.
        if "optimize" in inspect.signature(VoxCPM.from_pretrained).parameters:
            kwargs["optimize"] = os.environ.get("FLOWCHAIN_VOICE_COMPILE") == "1"
        _speaker = VoxCPM.from_pretrained("openbmb/VoxCPM2", **kwargs)
    return _speaker


def listener():
    global _listener
    if _listener is None:
        _nvidia_libs()
        from faster_whisper import WhisperModel

        name = os.environ.get("FLOWCHAIN_VOICE_WHISPER", "large-v3-turbo")
        try:
            _listener = WhisperModel(name, device="cuda", compute_type="float16")
        except Exception:  # no usable GPU libraries for it: slower, and still right
            _listener = WhisperModel(name, device="cpu", compute_type="int8")
    return _listener


def speak(text, reference_wav, reference_text, seed, wav_path):
    """Writes the speech to `wav_path`; returns its sample rate and length in seconds."""
    import soundfile as sf
    import torch

    model = speaker()
    if seed is not None:
        torch.manual_seed(seed)
    wav = model.generate(
        text=text, prompt_wav_path=reference_wav, prompt_text=reference_text, reference_wav_path=reference_wav,
        cfg_value=2.0, inference_timesteps=10,
    )
    rate = model.tts_model.sample_rate
    sf.write(wav_path, wav, rate)
    return rate, len(wav) / rate


def words(wav_path, language):
    """Every word heard in the clip with its start and end in seconds."""
    segments, _ = listener().transcribe(wav_path, language=language, word_timestamps=True, beam_size=5, condition_on_previous_text=False)
    return [{"text": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)} for s in segments for w in s.words if w.word.strip()]


def to_mp3(wav_path, mp3_path):
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", wav_path, "-ac", "1", "-ar", "44100", "-b:a", "128k", mp3_path],
        check=True, timeout=60,
    )
