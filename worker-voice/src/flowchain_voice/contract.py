"""The JSON contract between the Flow-Chain-AI client and the voice worker (phase 5 spec §6.1). Anything else is refused."""

import re

WORKFLOW = "voice-voxcpm2@1"
MAX_CHARS = 1200
MAX_SEED = 2**31 - 1
LANGUAGE = re.compile(r"^[a-z]{2}$")
VOICE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")


class ContractError(ValueError):
    """The request does not follow the contract; nothing was generated."""


def validate(inp, voices):
    """Returns a normalised request dict, or raises ContractError. `voices`: the ids this worker has."""
    if not isinstance(inp, dict):
        raise ContractError("input must be an object")
    if inp.get("task") != "speak":
        raise ContractError("task must be 'speak'")
    if inp.get("workflow") != WORKFLOW:
        raise ContractError(f"this worker runs workflow {WORKFLOW}")
    unknown = sorted(set(inp) - {"task", "workflow", "text", "voice", "language", "seed"})
    if unknown:
        raise ContractError(f"unknown field(s): {', '.join(unknown)}")
    text = inp.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_CHARS:
        raise ContractError(f"text must be a non-empty string of at most {MAX_CHARS} characters")
    # A leading "(...)" is how this model is told to invent a voice: a script line must never be able to do that.
    if text.lstrip().startswith("("):
        raise ContractError("text must not begin with a parenthesis")
    voice = inp.get("voice")
    if not isinstance(voice, str) or not VOICE.match(voice) or voice not in voices:
        raise ContractError(f"voice must be one of {', '.join(sorted(voices))}")
    # absent: the listener works out the language from the speech itself, and the voice speaks from its English clip
    language = inp.get("language")
    if language is not None and (not isinstance(language, str) or not LANGUAGE.match(language)):
        raise ContractError("language must be a two-letter code")
    req = {"text": text.strip(), "voice": voice, "language": language}
    seed = inp.get("seed")
    if seed is not None:
        if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= MAX_SEED:
            raise ContractError(f"seed must be an integer between 0 and {MAX_SEED}")
        req["seed"] = seed
    return req


def reference(voices, voice, language):
    """The reference clip of a voice for a language: its own where the voice has one, else its English one."""
    return language if language in voices[voice] else "en"
