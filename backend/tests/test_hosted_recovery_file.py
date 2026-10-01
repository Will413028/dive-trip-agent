import hashlib
import hmac
import json
import os
from uuid import uuid4

import pytest

from dive_trip.bootstrap.hosted_recovery_file import (
    RecoveryState,
    RecoveryStore,
    canonical_json,
)

KEY = "cd" * 32


def state():
    return RecoveryState(
        phase="serving",
        instance_id=str(uuid4()),
        db_epoch="2026-10-01T00:00:00+00:00",
        checkpoint_id=None,
        last_sequence=0,
        records=[],
    )


def test_atomic_signed_round_trip(tmp_path):
    tmp_path.chmod(0o700)
    store = RecoveryStore(tmp_path, KEY)
    expected = state()
    with store.session() as files:
        assert files.read() is None
        files.write(expected)
        assert files.read() == expected
    assert (tmp_path / "recovery.json").stat().st_mode & 0o777 == 0o600
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        ".recovery-lock",
        "recovery.json",
    ]


def test_tampered_file_and_wrong_key_are_rejected(tmp_path):
    tmp_path.chmod(0o700)
    store = RecoveryStore(tmp_path, KEY)
    with store.session() as files:
        files.write(state())
    with RecoveryStore(tmp_path, "ab" * 32).session() as files:
        with pytest.raises(ValueError, match="RECOVERY_MAC_INVALID"):
            files.read()
    path = tmp_path / "recovery.json"
    document = json.loads(path.read_text())
    document["payload"]["last_sequence"] = 1
    path.write_text(json.dumps(document))
    with store.session() as files:
        with pytest.raises(ValueError, match="RECOVERY_MAC_INVALID"):
            files.read()


def test_signed_payload_without_schema_version_is_rejected(tmp_path):
    tmp_path.chmod(0o700)
    payload = state().model_dump()
    del payload["version"]
    mac = hmac.new(
        bytes.fromhex(KEY),
        b"dive-recovery-v1\n" + canonical_json(payload),
        hashlib.sha256,
    ).hexdigest()
    path = tmp_path / "recovery.json"
    path.write_bytes(canonical_json({"payload": payload, "mac": mac}))
    path.chmod(0o600)
    with RecoveryStore(tmp_path, KEY).session() as files:
        with pytest.raises(ValueError, match="RECOVERY_SCHEMA_UNSUPPORTED"):
            files.read()


@pytest.mark.parametrize("mode", [0o644, 0o666, 0o777])
def test_unsafe_directory_is_rejected(tmp_path, mode):
    tmp_path.chmod(mode)
    with pytest.raises(ValueError, match="RECOVERY_DIRECTORY_INVALID"):
        with RecoveryStore(tmp_path, KEY).session():
            pass


def test_symlink_and_hardlink_files_are_rejected(tmp_path):
    tmp_path.chmod(0o700)
    target = tmp_path / "target"
    target.write_text("private unrelated data")
    target.chmod(0o600)
    link = tmp_path / "recovery.json"
    link.symlink_to(target)
    store = RecoveryStore(tmp_path, KEY)
    with store.session() as files:
        with pytest.raises(OSError):
            files.read()
    link.unlink()
    os.link(target, link)
    with store.session() as files:
        with pytest.raises(ValueError, match="RECOVERY_FILE_INVALID"):
            files.read()
    assert target.read_text() == "private unrelated data"


def test_failed_fsync_preserves_previous_file(tmp_path, monkeypatch):
    tmp_path.chmod(0o700)
    store = RecoveryStore(tmp_path, KEY)
    expected = state()
    with store.session() as files:
        files.write(expected)

        def fail(_):
            raise OSError("injected write failure")

        with monkeypatch.context() as patch:
            patch.setattr(os, "fsync", fail)
            with pytest.raises(OSError, match="injected"):
                files.write(state())
        assert files.read() == expected


@pytest.mark.parametrize(
    "changes",
    [
        {"last_sequence": 1},
        {"version": True},
        {"version": 1.0},
        {"version": 2},
        {"phase": "prepared"},
        {"db_epoch": "2026-10-01"},
        {"instance_id": "not-a-uuid"},
        {"extra": "unsupported"},
    ],
)
def test_strict_recovery_shape(changes):
    payload = state().model_dump()
    payload.update(changes)
    with pytest.raises(ValueError):
        RecoveryState.model_validate(payload)


def test_concurrent_store_lock_is_bounded(tmp_path):
    tmp_path.chmod(0o700)
    store = RecoveryStore(tmp_path, KEY)
    with store.session():
        with pytest.raises(BlockingIOError):
            with store.session():
                pass
