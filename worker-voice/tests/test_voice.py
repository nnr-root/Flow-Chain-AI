import base64
import importlib.util
import json
import os
import sys
import types

import pytest

from flowchain_voice import contract, engine

HERE = os.path.dirname(__file__)
VOICES = {"narrator-m": {"en": "English reference.", "tr": "Türkçe örnek."}, "narrator-f": {"en": "English reference."}}
GOOD = {"task": "speak", "workflow": "voice-voxcpm2@1", "text": "  Most product photos fail in the first second. ", "voice": "narrator-m", "language": "tr", "seed": 7}


def test_takes_a_line_a_voice_and_a_language():
    assert contract.validate(GOOD, VOICES) == {"text": "Most product photos fail in the first second.", "voice": "narrator-m", "language": "tr", "seed": 7}
    assert contract.validate({k: v for k, v in GOOD.items() if k not in ("language", "seed")}, VOICES) == {
        "text": "Most product photos fail in the first second.", "voice": "narrator-m", "language": None,
    }


@pytest.mark.parametrize(
    "change, why",
    [
        ({"task": "fetch-models"}, "task must be 'speak'"),
        ({"workflow": "voice-voxcpm2@2"}, "runs workflow voice-voxcpm2@1"),
        ({"text": ""}, "text must be"),
        ({"text": "x" * 1201}, "text must be"),
        ({"text": 5}, "text must be"),
        # a script line that begins with a parenthesis would be read as a description of a voice to invent
        ({"text": "(An angry old man) Hello."}, "must not begin with a parenthesis"),
        ({"text": "  (whispering) Hello."}, "must not begin with a parenthesis"),
        ({"voice": "someone-else"}, "voice must be one of narrator-f, narrator-m"),
        ({"voice": "../../etc/passwd"}, "voice must be one of"),
        ({"voice": None}, "voice must be one of"),
        ({"language": "english"}, "two-letter"),
        ({"language": "TR"}, "two-letter"),
        ({"seed": -1}, "seed must be"),
        ({"seed": True}, "seed must be"),
        ({"reference_wav_path": "/etc/passwd"}, "unknown field(s): reference_wav_path"),
    ],
)
def test_refuses_what_is_not_the_contract(change, why):
    with pytest.raises(contract.ContractError, match=why.replace("(", r"\(").replace(")", r"\)")):
        contract.validate({**GOOD, **change}, VOICES)
    with pytest.raises(contract.ContractError):
        contract.validate("speak", VOICES)


def test_a_voice_speaks_from_its_own_clip_in_a_language_it_has_and_from_its_english_one_otherwise():
    assert contract.reference(VOICES, "narrator-m", "tr") == "tr"
    assert contract.reference(VOICES, "narrator-m", "de") == "en"
    assert contract.reference(VOICES, "narrator-f", "tr") == "en"
    assert contract.reference(VOICES, "narrator-m", None) == "en"


@pytest.fixture
def worker(tmp_path, monkeypatch):
    """handler.py with the two models replaced by fakes, its voices and scratch folder under tmp_path."""
    monkeypatch.setitem(sys.modules, "runpod", types.SimpleNamespace(serverless=types.SimpleNamespace(start=None)))
    voices = tmp_path / "voices"
    voices.mkdir()
    (voices / "voices.json").write_text(json.dumps(VOICES), encoding="utf-8")
    for voice, by_language in VOICES.items():
        for language in by_language:
            (voices / f"{voice}.{language}.flac").write_bytes(b"flac")
    monkeypatch.setenv("FLOWCHAIN_VOICES_DIR", str(voices))
    spec = importlib.util.spec_from_file_location("voice_handler", os.path.join(HERE, "..", "handler.py"))
    h = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(h)
    (tmp_path / "tmp").mkdir()
    monkeypatch.setattr(h, "TMP_DIR", str(tmp_path / "tmp"))
    h.calls = []
    h.fail = None

    def speak(text, reference_wav, reference_text, seed, wav_path):
        h.calls.append(("speak", text, os.path.basename(reference_wav), reference_text, seed))
        with open(wav_path, "wb") as f:
            f.write(b"wav")
        return 48000, 2.5

    def words(wav_path, language):
        h.calls.append(("words", language))
        if h.fail:
            raise RuntimeError(h.fail)
        return [{"text": "Most", "start": 0.1, "end": 0.4}]

    def to_mp3(wav_path, mp3_path):
        with open(mp3_path, "wb") as f:
            f.write(b"mp3-bytes")

    monkeypatch.setattr(engine, "speak", speak)
    monkeypatch.setattr(engine, "words", words)
    monkeypatch.setattr(engine, "to_mp3", to_mp3)
    h.tmp = tmp_path / "tmp"
    return h


def test_speaks_a_line_and_answers_with_the_speech_and_its_word_times(worker):
    out = worker.handler({"id": "job1", "input": GOOD})
    assert base64.b64decode(out["audio"]) == b"mp3-bytes"
    assert out["words"] == [{"text": "Most", "start": 0.1, "end": 0.4}]
    assert (out["seconds"], out["sampleRate"]) == (2.5, 48000)
    assert isinstance(out["executionMs"], int)
    # the voice's own Turkish clip and its transcript, the seed, and the language the words are listened for in
    assert worker.calls == [("speak", "Most product photos fail in the first second.", "narrator-m.tr.flac", "Türkçe örnek.", 7), ("words", "tr")]
    # nothing of the job is left on the worker
    assert list(worker.tmp.iterdir()) == []


def test_falls_back_to_the_english_clip_for_a_language_the_voice_has_none_for(worker):
    worker.handler({"id": "job2", "input": {**GOOD, "voice": "narrator-f", "language": "de"}})
    assert worker.calls[0][2:4] == ("narrator-f.en.flac", "English reference.")
    assert worker.calls[1] == ("words", "de")


def test_refuses_a_bad_request_before_any_model_is_touched(worker):
    out = worker.handler({"id": "job3", "input": {**GOOD, "text": "(A new voice) hello"}})
    assert out == {"error": "invalid request: text must not begin with a parenthesis"}
    assert worker.calls == []


def test_leaves_nothing_behind_when_a_step_fails(worker):
    worker.fail = "the listener broke"
    with pytest.raises(RuntimeError, match="the listener broke"):
        worker.handler({"id": "job4", "input": GOOD})
    assert list(worker.tmp.iterdir()) == []


def test_refuses_to_start_with_a_voice_that_lacks_a_clip_or_an_english_reference(worker, tmp_path):
    os.remove(tmp_path / "voices" / "narrator-m.tr.flac")
    with pytest.raises(RuntimeError, match="no reference clip for tr"):
        worker.handler({"id": "job5", "input": GOOD})
    (tmp_path / "voices" / "voices.json").write_text(json.dumps({"only-tr": {"tr": "x"}}), encoding="utf-8")
    (tmp_path / "voices" / "only-tr.tr.flac").write_bytes(b"flac")
    with pytest.raises(RuntimeError, match="no English reference"):
        worker.handler({"id": "job6", "input": GOOD})


def test_the_shipped_voices_are_whole():
    folder = os.path.join(HERE, "..", "voices")
    spec = importlib.util.spec_from_file_location("voice_handler_real", os.path.join(HERE, "..", "handler.py"))
    sys.modules.setdefault("runpod", types.SimpleNamespace(serverless=types.SimpleNamespace(start=None)))
    h = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(h)
    voices = h.load_voices(folder)
    assert sorted(voices) == ["narrator-f", "narrator-m"]
    assert all(sorted(v) == ["en", "tr"] for v in voices.values())
