"""Owned, signed recovery state outside the PostgreSQL/Temporal backup pair."""

import fcntl
import hashlib
import hmac
import json
import os
import re
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal, Self
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_FILE_BYTES = 32 * 1024 * 1024
STATE_FILE = "recovery.json"


def canonical_id(value: str) -> str:
    if str(UUID(value)) != value:
        raise ValueError("RECOVERY_UUID_INVALID")
    return value


def canonical_time(value: str) -> str:
    parsed = datetime.fromisoformat(value)
    if parsed.utcoffset() != timedelta(0) or parsed.isoformat() != value:
        raise ValueError("RECOVERY_TIMESTAMP_INVALID")
    return value


class RecoveryRecord(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)
    sequence: int = Field(ge=1, le=100000)
    kind: Literal["delete-trip", "revoke-share"]
    trip_id: str
    share_id: str | None
    created_at: str

    @field_validator("trip_id", "share_id")
    @classmethod
    def ids(cls, value: str | None) -> str | None:
        return canonical_id(value) if value is not None else None

    @field_validator("created_at")
    @classmethod
    def timestamp(cls, value: str) -> str:
        return canonical_time(value)

    @model_validator(mode="after")
    def shape(self) -> Self:
        if (self.kind == "delete-trip") != (self.share_id is None):
            raise ValueError("RECOVERY_RECORD_INVALID")
        return self


class RecoveryState(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)
    version: Literal[1] = 1
    phase: Literal["serving", "prepared", "reconciled"]
    instance_id: str
    db_epoch: str
    checkpoint_id: str | None
    last_sequence: int = Field(ge=0, le=100000)
    records: list[RecoveryRecord] = Field(max_length=100000)

    @field_validator("version", mode="before")
    @classmethod
    def schema_version(cls, value: Any) -> int:
        if type(value) is not int or value != 1:
            raise ValueError("RECOVERY_SCHEMA_UNSUPPORTED")
        return value

    @field_validator("instance_id", "checkpoint_id")
    @classmethod
    def ids(cls, value: str | None) -> str | None:
        return canonical_id(value) if value is not None else None

    @field_validator("db_epoch")
    @classmethod
    def timestamp(cls, value: str) -> str:
        return canonical_time(value)

    @model_validator(mode="after")
    def complete(self) -> Self:
        if self.last_sequence != len(self.records) or any(
            row.sequence != position
            for position, row in enumerate(self.records, start=1)
        ):
            raise ValueError("RECOVERY_SEQUENCE_INCOMPLETE")
        if self.phase != "serving" and self.checkpoint_id is None:
            raise ValueError("RECOVERY_CHECKPOINT_REQUIRED")
        return self


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode()


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("RECOVERY_DUPLICATE_KEY")
        result[key] = value
    return result


def check_regular(fd: int) -> None:
    info = os.fstat(fd)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size > MAX_FILE_BYTES
    ):
        raise ValueError("RECOVERY_FILE_INVALID")


class RecoveryFiles:
    def __init__(self, directory_fd: int, key: bytes) -> None:
        self.directory_fd, self.key = directory_fd, key

    def read(self) -> RecoveryState | None:
        try:
            fd = os.open(
                STATE_FILE,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                dir_fd=self.directory_fd,
            )
        except FileNotFoundError:
            return None
        try:
            check_regular(fd)
            chunks = bytearray()
            while len(chunks) <= MAX_FILE_BYTES:
                chunk = os.read(fd, min(131072, MAX_FILE_BYTES + 1 - len(chunks)))
                if not chunk:
                    break
                chunks.extend(chunk)
            if len(chunks) > MAX_FILE_BYTES:
                raise ValueError("RECOVERY_FILE_TOO_LARGE")
            document = json.loads(chunks, object_pairs_hook=unique_object)
            if type(document) is not dict or set(document) != {"payload", "mac"}:
                raise ValueError("RECOVERY_ENVELOPE_INVALID")
            mac = document["mac"]
            if not isinstance(mac, str) or not re.fullmatch(r"[a-f0-9]{64}", mac):
                raise ValueError("RECOVERY_MAC_INVALID")
            expected = hmac.new(
                self.key,
                b"dive-recovery-v1\n" + canonical_json(document["payload"]),
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(mac, expected):
                raise ValueError("RECOVERY_MAC_INVALID")
            if (
                type(document["payload"]) is not dict
                or "version" not in document["payload"]
            ):
                raise ValueError("RECOVERY_SCHEMA_UNSUPPORTED")
            return RecoveryState.model_validate(document["payload"])
        finally:
            os.close(fd)

    def write(self, state: RecoveryState) -> None:
        state = RecoveryState.model_validate(state.model_dump())
        payload = state.model_dump(mode="json")
        mac = hmac.new(
            self.key, b"dive-recovery-v1\n" + canonical_json(payload), hashlib.sha256
        ).hexdigest()
        encoded = canonical_json({"payload": payload, "mac": mac})
        if len(encoded) > MAX_FILE_BYTES:
            raise ValueError("RECOVERY_FILE_TOO_LARGE")
        temporary = f".recovery-{uuid4().hex}"
        fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=self.directory_fd,
        )
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(
                temporary,
                STATE_FILE,
                src_dir_fd=self.directory_fd,
                dst_dir_fd=self.directory_fd,
            )
            os.fsync(self.directory_fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=self.directory_fd)
            except FileNotFoundError:
                pass


class RecoveryStore:
    def __init__(self, directory: Path, key: str) -> None:
        if not re.fullmatch(r"[a-f0-9]{64}", key):
            raise ValueError("RECOVERY_KEY_INVALID")
        self.directory, self.key = directory, bytes.fromhex(key)

    @contextmanager
    def session(self) -> Iterator[RecoveryFiles]:
        directory_fd = os.open(
            self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        )
        lock_fd: int | None = None
        try:
            info = os.fstat(directory_fd)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise ValueError("RECOVERY_DIRECTORY_INVALID")
            lock_fd = os.open(
                ".recovery-lock",
                os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                0o600,
                dir_fd=directory_fd,
            )
            check_regular(lock_fd)
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield RecoveryFiles(directory_fd, self.key)
        finally:
            if lock_fd is not None:
                os.close(lock_fd)
            os.close(directory_fd)
