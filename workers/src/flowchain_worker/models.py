"""The pinned model weights (workers/models.json) and the idempotent `fetch-models` task (2.4 spec §4.1)."""

import hashlib
import json
import os
import urllib.request

KINDS = ("clip",)
# The folders on the volume that are this worker's: what the list no longer names is removed from them, and from
# nowhere else (the picture worker keeps its model in a folder of its own on the same volume).
OWNED = ("checkpoints", "loras", "vae", "clip_vision", "ipadapter", "diffusion_models", "text_encoders")


def load(path):
    with open(path) as f:
        entries = json.load(f)
    for e in entries:
        missing = {"name", "url", "sha256", "size", "dir", "for"} - set(e)
        if missing:
            raise ValueError(f"models.json entry {e.get('name')} lacks {sorted(missing)}")
        if not set(e["for"]) <= set(KINDS):
            raise ValueError(f"models.json entry {e['name']} has an unknown endpoint kind")
    return entries


def target(root, entry):
    return os.path.join(root, entry["dir"], entry["name"])


def _marker(path):
    return path + ".sha256"


def is_present(root, entry):
    """Present = right size and a marker recording the verified hash (so a restart never re-hashes 14 GB)."""
    path = target(root, entry)
    if not os.path.exists(path) or os.path.getsize(path) != entry["size"]:
        return False
    try:
        with open(_marker(path)) as f:
            return f.read().strip() == entry["sha256"]
    except FileNotFoundError:
        return False


def plan(entries, root, only=None):
    """(entry, action) for the endpoint kind (or every kind): 'skip' when present, else 'download'."""
    chosen = [e for e in entries if only is None or only in e["for"]]
    return [(e, "skip" if is_present(root, e) else "download") for e in chosen]


def open_url(url):
    """The default opener: a stalled connection gives up after a minute instead of hanging until the job limit."""
    return urllib.request.urlopen(url, timeout=60)


def download(entry, root, opener=open_url, chunk=8 * 1024 * 1024):
    """Streams to a temporary file, verifies size and SHA-256, then renames; a bad download leaves nothing."""
    path = target(root, entry)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    digest = hashlib.sha256()
    size = 0
    with opener(entry["url"]) as res, open(tmp, "wb") as out:
        while True:
            block = res.read(chunk)
            if not block:
                break
            digest.update(block)
            size += len(block)
            out.write(block)
    if size != entry["size"] or digest.hexdigest() != entry["sha256"]:
        os.remove(tmp)
        raise ValueError(f"{entry['name']}: size {size} / sha256 {digest.hexdigest()} do not match models.json")
    os.replace(tmp, path)
    with open(_marker(path), "w") as f:
        f.write(entry["sha256"])


def fetch(entries, root, only=None, opener=open_url):
    done = {"downloaded": [], "skipped": []}
    for entry, action in plan(entries, root, only):
        if action == "download":
            download(entry, root, opener)
            done["downloaded"].append(entry["name"])
        else:
            done["skipped"].append(entry["name"])
    return done


def purge(entries, root):
    """Removes every file in this worker's folders that the list does not name; returns the weights removed.

    A weight that was retired, or moved into the image, would otherwise stay on the volume and be paid for by the
    gigabyte every month. Sub-folders are left alone.
    """
    keep = set()
    for e in entries:
        keep |= {target(root, e), _marker(target(root, e))}
    removed = []
    for name in OWNED:
        folder = os.path.join(root, name)
        for file in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
            path = os.path.join(folder, file)
            if path in keep or not os.path.isfile(path):
                continue
            os.remove(path)
            if not file.endswith((".sha256", ".part")):
                removed.append(file)
    return removed

