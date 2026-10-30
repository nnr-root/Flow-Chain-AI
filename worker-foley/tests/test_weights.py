import os

import pytest

from flowchain_foley import weights


def lay_out(root, revision=None):
    for name, (size, _) in weights.BIG.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.truncate(size)  # sparse: no disk is used
    with open(os.path.join(root, weights.MARKER), "w") as f:
        f.write(revision or weights.REVISION)


def test_the_pins_are_full_commits_and_every_file_has_a_size_and_hash_start():
    assert len(weights.REVISION) == 40 and len(weights.SIGLIP_REVISION) == 40 and len(weights.CLAP_REVISION) == 40
    assert len(weights.BIG) >= 5
    assert all(size > 0 and len(start) == 16 for size, start in weights.BIG.values())


def test_is_present_only_when_every_file_has_its_size_and_the_marker_names_this_revision(tmp_path):
    root = str(tmp_path)
    assert not weights.present(root)
    lay_out(root)
    assert weights.present(root)
    name = next(iter(weights.BIG))
    with open(os.path.join(root, name), "ab") as f:
        f.write(b"x")
    assert not weights.present(root)


def test_is_not_present_without_the_marker_or_with_another_revision(tmp_path):
    root = str(tmp_path)
    lay_out(root, revision="0" * 40)
    assert not weights.present(root)
    os.remove(os.path.join(root, weights.MARKER))
    assert not weights.present(root)


def test_verify_writes_the_marker_when_every_hash_starts_right(tmp_path):
    root = str(tmp_path)
    lay_out(root)
    os.remove(os.path.join(root, weights.MARKER))
    by_path = {os.path.join(root, n): s for n, (_, s) in weights.BIG.items()}
    weights.verify(root, sha256=lambda p: by_path[p] + "ff")
    assert weights.present(root)


def test_verify_refuses_a_wrong_size(tmp_path):
    root = str(tmp_path)
    lay_out(root)
    name = next(iter(weights.BIG))
    with open(os.path.join(root, name), "ab") as f:
        f.write(b"x")
    with pytest.raises(ValueError, match="wrong size"):
        weights.verify(root, sha256=lambda p: "")


def test_verify_refuses_a_wrong_hash_and_writes_no_marker(tmp_path):
    root = str(tmp_path)
    lay_out(root)
    os.remove(os.path.join(root, weights.MARKER))
    with pytest.raises(ValueError, match="SHA-256"):
        weights.verify(root, sha256=lambda p: "0" * 64)
    assert not os.path.exists(os.path.join(root, weights.MARKER))
