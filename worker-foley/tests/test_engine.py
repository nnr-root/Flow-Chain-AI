import hashlib
import struct
import wave

import pytest

from flowchain_foley import engine

RATE = 48000


class FakeSampler:
    """Stands in for the model: its noise comes from the seed alone, and it records what it was asked."""

    def __init__(self):
        self.calls = []

    def __call__(self, model, video_path, prompt, negative_prompt, seed, guidance_scale, steps):
        self.calls.append(dict(model=model, video_path=video_path, prompt=prompt, negative_prompt=negative_prompt, seed=seed, guidance_scale=guidance_scale, steps=steps))
        digest = hashlib.sha256(f"{seed}".encode()).digest()
        # six seconds of "sound": a value per sample taken from the seed's digest
        samples = [(digest[i % len(digest)] - 128) / 256 for i in range(6 * RATE)]
        return samples, RATE


def run(tmp_path, name, seed, sampler, **over):
    args = dict(prompt="p", negative_prompt=None, seed=seed, guidance_scale=4.5, steps=50, audio_length=3)
    args.update(over)
    out = str(tmp_path / name)
    result = engine.sound("MODEL", "/tmp/v.mp4", out_path=out, sampler=sampler, **args)
    with wave.open(out) as w:
        frames = w.readframes(w.getnframes())
        info = (w.getnchannels(), w.getframerate(), w.getsampwidth(), w.getnframes())
    return result, frames, info


def test_different_seeds_make_different_sound(tmp_path):
    s = FakeSampler()
    _, a, _ = run(tmp_path, "a.wav", 5, s)
    _, b, _ = run(tmp_path, "b.wav", 6, s)
    assert a != b
    assert [c["seed"] for c in s.calls] == [5, 6]


def test_the_same_seed_makes_the_same_sound(tmp_path):
    s = FakeSampler()
    _, a, _ = run(tmp_path, "a.wav", 9, s)
    _, b, _ = run(tmp_path, "b.wav", 9, s)
    assert a == b


def test_never_uses_the_model_programs_own_fixed_seed_unless_asked(tmp_path):
    s = FakeSampler()
    run(tmp_path, "a.wav", 123, s)
    assert s.calls[0]["seed"] == 123
    run(tmp_path, "b.wav", 1, s)
    assert s.calls[1]["seed"] == 1


def test_sets_the_random_generators_before_sampling(tmp_path):
    import random

    seen = []

    def sampler(model, *a):
        seen.append(random.random())
        return [0.0] * RATE, RATE

    run(tmp_path, "a.wav", 77, sampler)
    run(tmp_path, "b.wav", 77, sampler)
    run(tmp_path, "c.wav", 78, sampler)
    assert seen[0] == seen[1] != seen[2]


def test_writes_a_mono_48k_wav_cut_to_the_length_asked(tmp_path):
    result, _, info = run(tmp_path, "a.wav", 1, FakeSampler(), audio_length=2.5)
    assert info == (1, 48000, 2, int(2.5 * RATE))
    assert result["seconds"] == 2.5
    assert result["seed"] == 1


def test_a_sound_shorter_than_asked_is_kept_whole(tmp_path):
    result, _, info = run(tmp_path, "a.wav", 1, FakeSampler(), audio_length=10)
    assert info[3] == 6 * RATE
    assert result["seconds"] == 6.0


def test_passes_the_prompts_the_guidance_and_the_steps_through(tmp_path):
    s = FakeSampler()
    run(tmp_path, "a.wav", 2, s, prompt="rain", negative_prompt="music", guidance_scale=6.5, steps=30)
    call = s.calls[0]
    assert (call["prompt"], call["negative_prompt"], call["guidance_scale"], call["steps"]) == ("rain", "music", 6.5, 30)
    assert call["model"] == "MODEL" and call["video_path"] == "/tmp/v.mp4"


def test_a_stereo_sound_is_mixed_down_and_loud_samples_are_clipped(tmp_path):
    def sampler(*a):
        return [[2.0, -3.0, 0.5], [0.0, 0.0, 0.5]], 48000

    out = str(tmp_path / "s.wav")
    engine.sound("M", "v", "p", None, 1, 4.5, 50, 1, out, sampler=sampler)
    with wave.open(out) as w:
        assert w.getnchannels() == 1
        values = struct.unpack("<3h", w.readframes(3))
    assert values == (32767, -32767, 16384)


def test_a_sound_of_nothing_is_an_error(tmp_path):
    with pytest.raises(RuntimeError, match="no sound"):
        engine.sound("M", "v", "p", None, 1, 4.5, 50, 1, str(tmp_path / "x.wav"), sampler=lambda *a: ([], 48000))


def test_loads_the_model_once_through_the_loader_it_is_given():
    calls = []
    engine._MODEL = None
    loader = lambda root: calls.append(root) or "M"
    assert engine.model("/models/foley", loader=loader) == "M"
    assert engine.model("/models/foley", loader=loader) == "M"
    assert calls == ["/models/foley"]
    engine._MODEL = None
