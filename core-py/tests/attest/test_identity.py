from __future__ import annotations

from pathlib import Path

from openglass_core.attest import load_or_create_identity, persist_identity, read_identity


def test_generates_and_persists_a_fresh_identity_on_first_use(tmp_path: Path) -> None:
    path = tmp_path / "identity.json"
    identity = load_or_create_identity(path)
    assert identity.kid == "new"
    assert len(identity.private_key) == 32
    assert len(identity.public_key) == 32
    assert path.exists()


def test_loads_the_same_identity_on_a_second_call(tmp_path: Path) -> None:
    path = tmp_path / "identity.json"
    first = load_or_create_identity(path)
    second = load_or_create_identity(path)
    assert second.private_key == first.private_key
    assert second.public_key == first.public_key


def test_round_trips_agent_id_and_kid_persisted_after_registration(tmp_path: Path) -> None:
    path = tmp_path / "identity.json"
    identity = load_or_create_identity(path)
    identity.agent_id = "agt_test123"
    identity.kid = "key_test123"
    persist_identity(path, identity)
    reloaded = read_identity(path)
    assert reloaded.agent_id == "agt_test123"
    assert reloaded.kid == "key_test123"
    assert reloaded.private_key == identity.private_key


def test_creates_missing_parent_directories(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "dir" / "identity.json"
    identity = load_or_create_identity(path)
    assert read_identity(path).public_key == identity.public_key
