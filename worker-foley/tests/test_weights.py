import os

import pytest

from flowchain_foley import weights


def lay_out(root, revision=None, model="joined"):
    files = dict((n, s) for n, (s, _) in weights.BIG.items())
    files.update({weights.MODEL: weights.MODEL_SIZE} if model == "joined" else weights.PARTS)
    for name, size in files.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.truncate(size)  # sparse: no disk is used
    with open(os.path.join(root, weights.MARKER), "w") as f:
        f.write(revision or weights.REVISION)


def test_the_pins_are_full_commits_and_every_file_has_a_size_and_hash_start():
    assert len(weights.REVISION) == 40 and len(weights.SIGLIP_REVISION) == 40 and len(weights.CLAP_REVISION) == 40
    assert len(weights.BIG) >= 4 and len(weights.MODEL_SHA) == 16 and sum(weights.PARTS.values()) == weights.MODEL_SIZE
    assert all(size < 10 * 10**9 for size in weights.PARTS.values())
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
    by_path[os.path.join(root, weights.MODEL)] = weights.MODEL_SHA
    weights.verify(root, sha256=lambda p: by_path[p] + "ff")
    assert weights.present(root)


def test_verify_refuses_a_wrong_size(tmp_path):
    root = str(tmp_path)
    lay_out(root)
    name = next(iter(weights.BIG))
    with open(os.path.join(root, name), "ab") as f:
        f.write(b"x")
    with pytest.raises(ValueError, match="wrong size"):
        weights.verify(root, sha256=lambda p: weights.MODEL_SHA if p.endswith(weights.MODEL) else "")


def test_verify_refuses_a_wrong_hash_and_writes_no_marker(tmp_path):
    root = str(tmp_path)
    lay_out(root)
    os.remove(os.path.join(root, weights.MARKER))
    with pytest.raises(ValueError, match="SHA-256"):
        weights.verify(root, sha256=lambda p: "0" * 64)
    assert not os.path.exists(os.path.join(root, weights.MARKER))


def test_is_present_with_the_two_parts_instead_of_the_joined_file(tmp_path):
    lay_out(str(tmp_path), model="parts")
    assert weights.present(str(tmp_path))


def test_is_not_present_with_one_part_missing_or_the_wrong_size(tmp_path):
    root = str(tmp_path)
    lay_out(root, model="parts")
    part = os.path.join(root, f"{weights.MODEL}.part01")
    with open(part, "ab") as f:
        f.write(b"x")
    assert not weights.present(root)
    os.remove(part)
    assert not weights.present(root)


@pytest.fixture
def small(monkeypatch):
    monkeypatch.setattr(weights, "MODEL_SIZE", 9)
    monkeypatch.setattr(weights, "PARTS", {f"{weights.MODEL}.part00": 4, f"{weights.MODEL}.part01": 5})


def test_assemble_joins_the_parts_byte_for_byte_and_can_be_repeated(tmp_path, small):
    root = str(tmp_path)
    (tmp_path / f"{weights.MODEL}.part00").write_bytes(b"abcd")
    (tmp_path / f"{weights.MODEL}.part01").write_bytes(b"efghi")
    weights.assemble(root)
    joined = tmp_path / weights.MODEL
    assert joined.read_bytes() == b"abcdefghi"
    stamp = os.stat(joined).st_mtime_ns
    weights.assemble(root)
    assert joined.read_bytes() == b"abcdefghi" and os.stat(joined).st_mtime_ns == stamp
    assert not (tmp_path / f"{weights.MODEL}.tmp").exists()


def test_assemble_names_a_part_of_the_wrong_size(tmp_path, small):
    (tmp_path / f"{weights.MODEL}.part00").write_bytes(b"abcd")
    (tmp_path / f"{weights.MODEL}.part01").write_bytes(b"ef")
    with pytest.raises(ValueError, match="part01 is missing or has the wrong size"):
        weights.assemble(str(tmp_path))
    assert not (tmp_path / weights.MODEL).exists()
