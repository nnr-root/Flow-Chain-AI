import sys
import types

import pytest

from flowchain_worker import storage

ENV = {"R2_ACCOUNT_ID": "acc", "R2_BUCKET": "bkt", "R2_ACCESS_KEY_ID": "id", "R2_SECRET_ACCESS_KEY": "secret"}


@pytest.fixture
def fake_boto(monkeypatch):
    """boto3 and botocore.config.Config replaced by recorders (boto3 is only installed in the image)."""
    seen = {}

    class Config:
        def __init__(self, **kwargs):
            seen["config"] = kwargs

    def client(service, **kwargs):
        seen["client"] = {"service": service, **kwargs}
        return types.SimpleNamespace()

    config_module = types.ModuleType("botocore.config")
    config_module.Config = Config
    botocore = types.ModuleType("botocore")
    botocore.config = config_module
    monkeypatch.setitem(sys.modules, "boto3", types.SimpleNamespace(client=client))
    monkeypatch.setitem(sys.modules, "botocore", botocore)
    monkeypatch.setitem(sys.modules, "botocore.config", config_module)
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)
    return seen


def test_the_client_only_adds_checksums_when_r2_needs_them(fake_boto):
    storage._client()
    assert fake_boto["config"] == {"request_checksum_calculation": "when_required",
                                   "response_checksum_validation": "when_required"}
    assert fake_boto["client"]["config"] is not None
    assert fake_boto["client"]["region_name"] == "auto"
    assert fake_boto["client"]["endpoint_url"] == "https://acc.r2.cloudflarestorage.com"


def test_missing_env_names_every_unset_variable_and_never_a_value(monkeypatch):
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)
    assert storage.missing_env() == []
    monkeypatch.delenv("R2_ACCOUNT_ID")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "")
    assert storage.missing_env() == ["R2_ACCOUNT_ID", "R2_SECRET_ACCESS_KEY"]


def test_boto3_is_new_enough_for_the_checksum_options():
    import os

    path = os.path.join(os.path.dirname(__file__), "..", "requirements.txt")
    assert "boto3>=1.36,<2" in open(path).read().split()


def test_a_model_download_gives_up_instead_of_hanging(monkeypatch):
    from flowchain_worker import models

    seen = {}

    class Res:
        def read(self, n):
            return b""

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_urlopen(url, timeout=None):
        seen["timeout"] = timeout
        return Res()

    monkeypatch.setattr(models.urllib.request, "urlopen", fake_urlopen)
    models.open_url("https://huggingface.co/x")
    assert seen["timeout"] == 60
