"""Makes the sound of one scene: the model is built once, the seed is set from the request, the answer is a mono 48 kHz wav.

The model's own program (infer.py) sets a fixed seed 1 and ignores --audio_length; this worker sets the seed it is
asked for and cuts the sound to the length it is asked for. The loader and the sampler are parameters so every test
runs with a fake and no torch (the real ones import torch only when called).
"""

import importlib
import random
import wave
from array import array

CONFIG = "/foley-src/configs/hunyuanvideo-foley-xxl.yaml"
_MODEL = None


def model(root, loader=None):
    """The loaded model, built on the first call only (loading takes the time of a cold start)."""
    global _MODEL
    if _MODEL is None:
        _MODEL = (loader or _load)(root)
    return _MODEL


def _load(root):
    import torch  # lazily: only the image has it
    from hunyuanvideo_foley.utils.model_utils import load_model

    device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
    # the XXL model, no offload: it fits a 24 GB card (the trial of 2026-10-30)
    model_dict, cfg = load_model(root, CONFIG, device, enable_offload=False, model_size="xxl")
    return {"model_dict": model_dict, "cfg": cfg}


def _sample(loaded, video_path, prompt, negative_prompt, seed, guidance_scale, steps):
    """The model program's own two calls (infer.py `infer`): features from the video and prompts, then denoising."""
    from hunyuanvideo_foley.utils.feature_utils import feature_process
    from hunyuanvideo_foley.utils.model_utils import denoise_process

    model_dict, cfg = loaded["model_dict"], loaded["cfg"]
    visual, text, length_s = feature_process(video_path, prompt, model_dict, cfg, neg_prompt=negative_prompt)
    audio, rate = denoise_process(visual, text, length_s, model_dict, cfg, guidance_scale=guidance_scale, num_inference_steps=steps)
    return audio[0].mean(dim=0).tolist(), rate  # [channels, n] -> mono samples


def _seed_all(seed):
    random.seed(seed)
    # numpy and torch are imported here when they are installed (the image has both; the tests' fakes need neither), so
    # the real sampler can never run unseeded because nothing had imported them yet
    for name, seeder in (("numpy", lambda m: m.random.seed(seed)), ("torch", lambda m: m.manual_seed(seed))):
        try:
            seeder(importlib.import_module(name))
        except ImportError:
            pass


def _mono(samples):
    if samples and isinstance(samples[0], (list, tuple)):
        n = len(samples)
        return [sum(channel[i] for channel in samples) / n for i in range(len(samples[0]))]
    return list(samples)


def _pcm(sample):
    return int(round(max(-1.0, min(1.0, sample)) * 32767))


def sound(loaded, video_path, prompt, negative_prompt, seed, guidance_scale, steps, audio_length, out_path, sampler=None):
    """Writes the sound of the video at video_path to out_path; returns {"seed", "seconds"}."""
    _seed_all(seed)
    samples, rate = (sampler or _sample)(loaded, video_path, prompt, negative_prompt, seed, guidance_scale, steps)
    mono = _mono(samples)[: int(audio_length * rate)]
    if not mono:
        raise RuntimeError("the model made no sound")
    with wave.open(out_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(array("h", (_pcm(s) for s in mono)).tobytes())
    return {"seed": seed, "seconds": round(len(mono) / rate, 3)}
