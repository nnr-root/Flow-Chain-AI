"""RunPod Serverless entry point of the voice worker: one line of a script in, its speech and word times out.

The speech goes back inside the answer itself. Nothing is uploaded anywhere, and the two files this makes on
the worker's own disk are removed before it answers, whatever happened (phase 5 spec §8).
"""

import base64
import json
import os
import time

import runpod

from flowchain_voice import contract, engine

VOICES_DIR = os.environ.get("FLOWCHAIN_VOICES_DIR", "/flowchain/voices")
TMP_DIR = "/tmp"


def load_voices(folder):
    """The voices this worker has: `{id: {language: transcript}}`, each with its reference clip beside it."""
    with open(os.path.join(folder, "voices.json"), encoding="utf-8") as f:
        voices = json.load(f)
    for voice, by_language in voices.items():
        for language in by_language:
            if not os.path.exists(os.path.join(folder, f"{voice}.{language}.flac")):
                raise RuntimeError(f"voice {voice} has no reference clip for {language}")
        if "en" not in by_language:
            raise RuntimeError(f"voice {voice} has no English reference, which every other language falls back to")
    return voices


def _remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def handler(job):
    started = time.monotonic()
    voices = load_voices(VOICES_DIR)
    try:
        req = contract.validate(job.get("input"), voices)
    except contract.ContractError as err:
        return {"error": f"invalid request: {err}"}
    job_id = job["id"]
    wav = os.path.join(TMP_DIR, f"{job_id}.wav")
    mp3 = os.path.join(TMP_DIR, f"{job_id}.mp3")
    try:
        ref = contract.reference(voices, req["voice"], req["language"])
        rate, seconds = engine.speak(
            req["text"], os.path.join(VOICES_DIR, f"{req['voice']}.{ref}.flac"), voices[req["voice"]][ref], req.get("seed"), wav
        )
        heard = engine.words(wav, req["language"])
        engine.to_mp3(wav, mp3)
        with open(mp3, "rb") as f:
            audio = base64.b64encode(f.read()).decode()
    finally:
        _remove(wav)
        _remove(mp3)
    return {"audio": audio, "words": heard, "seconds": round(seconds, 3), "sampleRate": rate, "executionMs": int((time.monotonic() - started) * 1000)}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
