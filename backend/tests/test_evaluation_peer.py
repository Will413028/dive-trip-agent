import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest

from dive_trip.platform.errors import DomainError
from dive_trip.platform.evaluation_peer import EvaluationLoopbackPeer


def test_daily_and_midnight_loopback_quota_identity_matches_retired_contract():
    dates = ["2026-09-28T15:59:59Z", "2026-09-28T16:00:01Z", "2026-09-28T16:01:00Z"]
    probe = subprocess.run(
        ["node", str(Path(__file__).with_name("evaluation-ip-parity.mjs"))],
        input=json.dumps(dates),
        capture_output=True,
        text=True,
        check=True,
        timeout=15,
    )
    old = json.loads(probe.stdout)
    peer = EvaluationLoopbackPeer(b"a" * 32)
    for date, expected in zip(dates, old, strict=True):
        current, previous = peer.keys(datetime.fromisoformat(date))
        assert current == expected["ipKey"]
        assert previous == expected.get("previousIpKey")
    assert old[0]["ipKey"] == old[1]["previousIpKey"]
    assert old[0]["ipKey"] != old[1]["ipKey"]
    assert "previousIpKey" not in old[2]


def test_private_peer_requires_strong_key_and_aware_time():
    with pytest.raises(DomainError, match="UNTRUSTED_CLIENT_IP"):
        EvaluationLoopbackPeer(b"short")
    peer = EvaluationLoopbackPeer(b"a" * 32)
    with pytest.raises(DomainError, match="UNTRUSTED_CLIENT_IP"):
        peer.keys(datetime(2026, 9, 28))
    assert len(peer.keys(datetime(2026, 9, 28, tzinfo=UTC))[0]) == 64
