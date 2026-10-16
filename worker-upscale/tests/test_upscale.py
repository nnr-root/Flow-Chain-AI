import base64

import pytest

from flowchain_upscale import contract, engine, weights

CLIP = base64.b64encode(b"mp4-bytes").decode()
GOOD = {"task": "upscale", "workflow": "upscale-seedvr2@1", "video": CLIP, "short": 1080}


def test_takes_the_request_the_client_sends():
    assert contract.validate(GOOD) == {"task": "upscale", "video": b"mp4-bytes", "short": 1080}


@pytest.mark.parametrize(
    "change, why",
    [
        ({"task": "clip"}, "task must be"),
        ({"workflow": "upscale-seedvr2@2"}, "runs workflow upscale-seedvr2@1"),
        ({"short": 2160}, "short must be"),
        ({"short": True}, "short must be"),
        ({"video": "not base64!"}, "not valid base64"),
        ({"video": ""}, "between 1 byte"),
        ({"prompt": "x"}, "unknown field"),
    ],
)
def test_refuses_what_is_not_the_contract(change, why):
    with pytest.raises(contract.ContractError, match=why):
        contract.validate({**GOOD, **change})


def test_runs_seedvr2_as_the_trial_measured_it():
    cmd = engine.command("/tmp/a.mp4", "/tmp/b.mp4", 1080, "/models/seedvr2", weights.DIT)
    assert cmd[1:3] == [engine.CLI, "/tmp/a.mp4"]
    joined = " ".join(cmd)
    for part in ["--resolution 1080", "--batch_size 33", "--temporal_overlap 4", "--dit_model seedvr2_ema_3b_fp16.safetensors", "--model_dir /models/seedvr2", "--output /tmp/b.mp4"]:
        assert part in joined


def test_says_why_when_seedvr2_fails():
    class Done:
        returncode = 1
        stderr = "CUDA out of memory"
        stdout = ""

    with pytest.raises(RuntimeError, match="CUDA out of memory"):
        engine.upscale("a", "b", 1080, "m", "d", run=lambda *a, **k: Done())


def test_knows_the_files_are_there_only_at_their_sizes(tmp_path):
    assert not weights.present(str(tmp_path))
    for name, (size, _) in weights.FILES.items():
        with open(tmp_path / name, "wb") as f:
            f.truncate(size)
    assert weights.present(str(tmp_path))
    with open(tmp_path / weights.VAE, "wb") as f:
        f.truncate(10)
    assert not weights.present(str(tmp_path))


def test_the_image_downloads_and_checks_exactly_these_files():
    with open(__file__.rsplit("/tests/", 1)[0] + "/Dockerfile") as f:
        docker = f.read()
    assert weights.REVISION in docker
    for name, (_, digest) in weights.FILES.items():
        assert f"{digest}  /models/seedvr2/{name}" in docker
