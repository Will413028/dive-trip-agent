"""Daily quota identity for the private, in-process loopback evaluator only.

No address comes from HTTP headers, URLs or model inputs. This is not a public
ingress adapter; deployed traffic requires its own verified transport boundary.
"""

import hashlib
import hmac
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .errors import DomainError


class EvaluationLoopbackPeer:
    def __init__(self, hashing_key: bytes) -> None:
        if type(hashing_key) is not bytes or len(hashing_key) < 32:
            raise DomainError("UNTRUSTED_CLIENT_IP")
        self._hashing_key = hashing_key

    def keys(self, now: datetime) -> tuple[str, str | None]:
        if now.tzinfo is None or now.utcoffset() is None:
            raise DomainError("UNTRUSTED_CLIENT_IP")
        zone = ZoneInfo("Asia/Taipei")
        today = now.astimezone(zone).date().isoformat()
        prior = (now - timedelta(seconds=60)).astimezone(zone).date().isoformat()

        def digest(day: str) -> str:
            salt = hmac.digest(
                self._hashing_key, f"dive-trip-ip:{day}".encode(), hashlib.sha256
            )
            return hmac.digest(salt, b"127.0.0.1", hashlib.sha256).hex()

        return digest(today), digest(prior) if prior != today else None
