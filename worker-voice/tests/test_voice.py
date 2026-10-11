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
CLIP = base64.b64encode(b"fLaC-clip-bytes").decode()
DESIGN = {"task": "design", "workflow": "voice-voxcpm2@1", "description": " An older man, warm and slow ", "text": "Good evening, and welcome.", "seed": 3}
GOOD = {"task": "speak", "workflow": "voice-voxcpm2@1", "text": "  Most product photos fail in the first second. ", "voice": "narrator-m", "language": "tr", "seed": 7}


def test_takes_a_line_a_voice_and_a_language():
    assert contract.validate(GOOD, VOICES) == {"task": "speak", "text": "Most product photos fail in the first second.", "voice": "narrator-m", "language": "tr", "seed": 7}
    assert contract.validate({k: v for k, v in GOOD.items() if k not in ("language", "seed")}, VOICES) == {
        "task": "speak", "text": "Most product photos fail in the first second.", "voice": "narrator-m", "language": None,
    }


@pytest.mark.parametrize(
    "change, why",
    [
        ({"task": "fetch-models"}, "task must be 'speak' or 'design'"),
        # a voice this worker has no clip of must bring one
        ({"reference": "aGVsbG8="}, "reference must be an object"),
        ({"reference": {"audio": CLIP}}, "reference must be an object"),
        ({"reference": {"audio": CLIP, "text": "Hi.", "path": "/etc/passwd"}}, "reference must be an object"),
        ({"reference": {"audio": "not base64!", "text": "Hi."}}, "not valid base64"),
        ({"reference": {"audio": base64.b64encode(b"RIFFwave").decode(), "text": "Hi."}}, "must be a FLAC clip"),
        ({"reference": {"audio": base64.b64encode(b"fLaC" + b"0" * (2 * 1024 * 1024)).decode(), "text": "Hi."}}, "must be a FLAC clip"),
        ({"reference": {"audio": CLIP, "text": ""}}, "reference.text must be"),
        ({"reference": {"audio": CLIP, "text": "(A new voice) Hi."}}, "reference.text must be"),
        # describing a voice is for the design task alone
        ({"description": "An old man"}, "unknown field(s): description"),
        ({"workflow": "voice-voxcpm2@2"}, "runs workflow voice-voxcpm2@1"),
        ({"text": ""}, "text must be"),
        ({"text": "x" * 1201}, "text must be"),
        ({"text": 5}, "text must be"),
        # a script line that begins with a parenthesis would be read as a description of a voice to invent
        ({"text": "(An angry old man) Hello."}, "must not begin with a parenthesis"),
        ({"text": "  (whispering) Hello."}, "must not begin with a parenthesis"),
        ({"voice": "someone-else"}, "voice must be one of narrator-f, narrator-m, or come with its reference clip"),
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


def test_a_voice_that_brings_its_clip_needs_no_clip_here():
    req = contract.validate({**GOOD, "voice": "storyteller", "reference": {"audio": CLIP, "text": " Good evening. "}}, VOICES)
    assert req["voice"] == "storyteller"
    assert req["reference"] == {"audio": b"fLaC-clip-bytes", "text": "Good evening."}
    # a voice this worker has may bring one too, and is then spoken from it
    assert contract.validate({**GOOD, "reference": {"audio": CLIP, "text": "Hi."}}, VOICES)["reference"]["text"] == "Hi."


def test_a_voice_is_designed_from_a_description_and_a_line():
    assert contract.validate(DESIGN, VOICES) == {"task": "design", "text": "Good evening, and welcome.", "description": "An older man, warm and slow", "language": "en", "seed": 3}
    # a voice is made in the language of its line, natively, not from a voice made in another
    assert contract.validate({**DESIGN, "language": "tr", "text": "İyi akşamlar."}, VOICES)["language"] == "tr"


@pytest.mark.parametrize(
    "change, why",
    [
        ({"description": ""}, "description must be"),
        ({"description": "x" * 401}, "description must be"),
        ({"description": 5}, "description must be"),
        # one pair of parentheses holds the description: one inside it would end it early
        ({"description": "An old man) and now anything (else"}, "must not contain parentheses"),
        ({"text": "(Another voice) hello"}, "must not begin with a parenthesis"),
        ({"text": ""}, "text must be"),
        # a design takes nothing of a spoken line's
        ({"voice": "narrator-m"}, "unknown field(s): voice"),
        ({"language": "turkish"}, "two-letter"),
        ({"reference": {"audio": CLIP, "text": "Hi."}}, "unknown field(s): reference"),
        ({"seed": -1}, "seed must be"),
    ],
)
def test_refuses_a_design_that_is_not_the_contract(change, why):
    with pytest.raises(contract.ContractError, match=why.replace("(", r"\(").replace(")", r"\)")):
        contract.validate({**DESIGN, **change}, VOICES)


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
    h.clips = []
    h.fail = None

    def speak(text, reference_wav, reference_text, seed, wav_path):
        with open(reference_wav, "rb") as f:
            h.clips.append(f.read())
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

    def design(description, text, seed, wav_path):
        h.calls.append(("design", description, text, seed))
        with open(wav_path, "wb") as f:
            f.write(b"wav")
        return 48000, 9.5

    def to_flac(wav_path, flac_path):
        with open(flac_path, "wb") as f:
            f.write(b"fLaC-new-voice")

    monkeypatch.setattr(engine, "design", design)
    monkeypatch.setattr(engine, "to_flac", to_flac)

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


def test_speaks_from_the_clip_that_came_with_the_request_and_keeps_nothing_of_it(worker):
    out = worker.handler({"id": "job7", "input": {**GOOD, "voice": "storyteller", "language": "es", "reference": {"audio": CLIP, "text": "Good evening."}}})
    assert base64.b64decode(out["audio"]) == b"mp3-bytes"
    # the clip was there for the line, with the words said in it, and the line was listened for in its language
    assert worker.clips == [b"fLaC-clip-bytes"]
    assert worker.calls == [("speak", "Most product photos fail in the first second.", "job7.ref.flac", "Good evening.", 7), ("words", "es")]
    assert list(worker.tmp.iterdir()) == []
    # and when the line fails, too
    worker.fail = "the listener broke"
    with pytest.raises(RuntimeError):
        worker.handler({"id": "job8", "input": {**GOOD, "voice": "storyteller", "reference": {"audio": CLIP, "text": "Good evening."}}})
    assert list(worker.tmp.iterdir()) == []


def test_designs_a_voice_and_answers_with_its_reference_clip(worker):
    out = worker.handler({"id": "job9", "input": DESIGN})
    assert base64.b64decode(out["audio"]) == b"fLaC-new-voice"
    assert out["seconds"] == 9.5
    # the description and the line go to the model apart; what was said is listened to, to know it said the line
    assert worker.calls == [("design", "An older man, warm and slow", "Good evening, and welcome.", 3), ("words", "en")]
    worker.calls.clear()
    worker.handler({"id": "job9b", "input": {**DESIGN, "language": "tr", "text": "İyi akşamlar."}})
    assert worker.calls[1] == ("words", "tr")
    assert list(worker.tmp.iterdir()) == []


def test_refuses_a_bad_request_before_any_model_is_touched(worker):
    out = worker.handler({"id": "job3", "input": {**GOOD, "text": "(A new voice) hello"}})
    assert out == {"error": "invalid request: text must not begin with a parenthesis"}
    # a line cannot describe a voice, whatever else it carries
    assert "error" in worker.handler({"id": "job3b", "input": {**GOOD, "description": "An angry old man"}})
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


@pytest.mark.skipif(__import__("shutil").which("ffmpeg") is None, reason="needs ffmpeg")
def test_the_speech_is_written_as_the_files_the_handler_names(tmp_path):
    # the real conversions, on a second of silence, to the names the handler gives them: a name ffmpeg cannot
    # tell a format from fails every line (the first build of phase 7 §15 met that on the live endpoint)
    import subprocess
    wav = tmp_path / "x.wav"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "1", str(wav)], check=True)
    engine.to_mp3(str(wav), str(tmp_path / "job.mp3"))
    engine.to_flac(str(wav), str(tmp_path / "job.flac"))
    assert (tmp_path / "job.mp3").read_bytes()[:3] in (b"ID3", b"\xff\xfb", b"\xff\xf3")
    assert (tmp_path / "job.flac").read_bytes()[:4] == b"fLaC"


def test_names_its_scratch_files_for_what_they_hold(worker, monkeypatch):
    names = []
    real_mp3, real_flac = engine.to_mp3, engine.to_flac
    monkeypatch.setattr(engine, "to_mp3", lambda w, o: (names.append(os.path.basename(o)), real_mp3(w, o)))
    monkeypatch.setattr(engine, "to_flac", lambda w, o: (names.append(os.path.basename(o)), real_flac(w, o)))
    worker.handler({"id": "jobA", "input": GOOD})
    worker.handler({"id": "jobB", "input": DESIGN})
    assert names == ["jobA.mp3", "jobB.flac"]

