"""Explicit configuration for the isolated public fixture deployment."""

import os
import re
import stat
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from psycopg.conninfo import make_conninfo


def require_fixture_environment(environment: Mapping[str, str]) -> None:
    """Reject generation configuration before reading any deployment secret."""
    for name in environment:
        if name.startswith(
            (
                "GEMINI_",
                "GOOGLE_",
                "OPENROUTER_",
                "OPENAI_",
                "CLOUDFLARE_",
                "DIVE_LOCAL_",
                "DIVE_TRIP_CLOUDFLARE_",
                "PG",
            )
        ) or name in {"DATABASE_URL", "COMPOSE_PROJECT_NAME"}:
            raise ValueError("HOSTED_GENERATION_OR_AMBIENT_CONFIG_DISABLED")


def read_secret(path: Path) -> str:
    """Read an owned, bounded regular file without following a symlink."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) not in (0o400, 0o600)
            or info.st_size != 64
        ):
            raise ValueError("HOSTED_SECRET_FILE_INVALID")
        raw = os.read(fd, 65)
        if not re.fullmatch(rb"[a-f0-9]{64}", raw):
            raise ValueError("HOSTED_SECRET_FILE_INVALID")
        return raw.decode("ascii")
    finally:
        os.close(fd)


@dataclass(frozen=True)
class HostedFixtureConfig:
    origin: str
    database_password: str = field(repr=False)
    ingress_key: str = field(repr=False)

    def __post_init__(self) -> None:
        parsed = urlsplit(self.origin)
        if (
            parsed.scheme != "https"
            or parsed.hostname is None
            or re.fullmatch(r"[0-9.]+", parsed.hostname)
            or not re.fullmatch(
                r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+",
                parsed.hostname,
            )
            or self.origin != f"https://{parsed.hostname}"
        ):
            raise ValueError("HOSTED_HTTPS_ORIGIN_REQUIRED")
        if (
            not all(
                re.fullmatch(r"[a-f0-9]{64}", value)
                for value in (self.database_password, self.ingress_key)
            )
            or self.database_password == self.ingress_key
        ):
            raise ValueError("HOSTED_DISTINCT_SECRETS_REQUIRED")

    @classmethod
    def load(
        cls,
        origin: str,
        password_file: Path,
        ingress_file: Path,
        environment: Mapping[str, str],
    ) -> "HostedFixtureConfig":
        require_fixture_environment(environment)
        # Validate origin before touching secrets, including malformed URL ports.
        cls(origin, "a" * 64, "b" * 64)
        return cls(origin, read_secret(password_file), read_secret(ingress_file))

    def database_conninfo(self) -> str:
        return make_conninfo(
            host="db",
            port=5432,
            dbname="dive_trip_demo",
            user="dive_trip_app",
            password=self.database_password,
            passfile="/dev/null",
            sslmode="disable",
            gssencmode="disable",
            application_name="dive-trip-hosted-fixture",
            connect_timeout=5,
            client_encoding="UTF8",
        )
