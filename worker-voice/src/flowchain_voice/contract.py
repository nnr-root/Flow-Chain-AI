"""The JSON contract between the Flow-Chain-AI client and the voice worker (phase 5 spec §6.1). Anything else is refused.

Two tasks (phase 7 spec §15). `speak`: one line of a script in a voice, which is one this worker has a clip of,
or one whose clip comes with the request. `design`: a new voice from a description of it, saying a line; what
it answers with is that voice's reference clip from then on. A script's line can only ever reach `speak`.
"""

import base64
import binascii
import re

WORKFLOW = "voice-voxcpm2@1"
MAX_CHARS = 1200
MAX_SEED = 2**31 - 1
LANGUAGE = re.compile(r"^[a-z]{2}$")
VOICE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
# a reference clip is a few seconds of speech: ten of them as FLAC are well under this
MAX_REFERENCE_BYTES = 2 * 1024 * 1024
MAX_REFERENCE_TEXT = 600
MAX_DESCRIPTION = 400


class ContractError(ValueError):
    """The request does not follow the contract; nothing was generated."""


def validate(inp, voices):
    """Returns a normalised request dict, or raises ContractError. `voices`: the ids this worker has."""
    if not isinstance(inp, dict):
        raise ContractError("input must be an object")
    task = inp.get("task")
    if task not in ("speak", "design"):
        raise ContractError("task must be 'speak' or 'design'")
    if inp.get("workflow") != WORKFLOW:
        raise ContractError(f"this worker runs workflow {WORKFLOW}")
    allowed = {"task", "workflow", "text", "voice", "language", "seed", "reference"} if task == "speak" else {"task", "workflow", "text", "description", "language", "seed"}
    unknown = sorted(set(inp) - allowed)
    if unknown:
        raise ContractError(f"unknown field(s): {', '.join(unknown)}")
    text = inp.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_CHARS:
        raise ContractError(f"text must be a non-empty string of at most {MAX_CHARS} characters")
    # A leading "(...)" is how this model is told to invent a voice: a script line must never be able to do that.
    if text.lstrip().startswith("("):
        raise ContractError("text must not begin with a parenthesis")
    if task == "design":
        return _design(inp, text.strip())
    voice = inp.get("voice")
    given = _reference(inp.get("reference"))
    # A voice is one of this worker's own, or any name whose clip came with the request. The name of a voice
    # that brings its clip is used for nothing but to say which voice it was.
    if not isinstance(voice, str) or not VOICE.match(voice) or (given is None and voice not in voices):
        raise ContractError(f"voice must be one of {', '.join(sorted(voices))}, or come with its reference clip")
    # absent: the listener works out the language from the speech itself, and the voice speaks from its English clip
    language = inp.get("language")
    if language is not None and (not isinstance(language, str) or not LANGUAGE.match(language)):
        raise ContractError("language must be a two-letter code")
    req = {"task": "speak", "text": text.strip(), "voice": voice, "language": language}
    if given is not None:
        req["reference"] = given
    return _seeded(inp, req)


def _seeded(inp, req):
    seed = inp.get("seed")
    if seed is not None:
        if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= MAX_SEED:
            raise ContractError(f"seed must be an integer between 0 and {MAX_SEED}")
        req["seed"] = seed
    return req


def _reference(ref):
    """A reference clip that comes with a request: its sound (FLAC, base64) and the words said in it."""
    if ref is None:
        return None
    if not isinstance(ref, dict) or set(ref) != {"audio", "text"}:
        raise ContractError("reference must be an object with audio and text")
    text = ref["text"]
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_REFERENCE_TEXT or text.lstrip().startswith("("):
        raise ContractError(f"reference.text must be the words said in the clip, at most {MAX_REFERENCE_TEXT} characters")
    if not isinstance(ref["audio"], str):
        raise ContractError("reference.audio must be a base64 string")
    try:
        audio = base64.b64decode(ref["audio"], validate=True)
    except (binascii.Error, ValueError) as err:
        raise ContractError("reference.audio is not valid base64") from err
    # (a FLAC file begins with these four bytes: nothing else is written to the worker's disk as a clip)
    if not audio.startswith(b"fLaC") or len(audio) > MAX_REFERENCE_BYTES:
        raise ContractError("reference.audio must be a FLAC clip of at most 2 MB")
    return {"audio": audio, "text": text.strip()}


def _design(inp, text):
    """A voice to invent: who speaks and how, in plain words. The description is the only place a voice is described."""
    description = inp.get("description")
    if not isinstance(description, str) or not description.strip() or len(description) > MAX_DESCRIPTION:
        raise ContractError(f"description must be a non-empty string of at most {MAX_DESCRIPTION} characters")
    # the model reads the description between one pair of parentheses: one inside it would end it early
    if "(" in description or ")" in description:
        raise ContractError("description must not contain parentheses")
    # the language the line is in: the voice is made speaking it, and what it said is listened for in it
    language = inp.get("language")
    if language is not None and (not isinstance(language, str) or not LANGUAGE.match(language)):
        raise ContractError("language must be a two-letter code")
    return _seeded(inp, {"task": "design", "text": text, "description": description.strip(), "language": language or "en"})


def reference(voices, voice, language):
    """The reference clip of a voice for a language: its own where the voice has one, else its English one."""
    return language if language in voices[voice] else "en"
