import httpx2 as httpx
import pytest

from dive_trip.bootstrap.evaluation_generation import reviewed_cloudflare_generation
from dive_trip.modules.usage.provider import CLOUDFLARE_MODEL, GEMINI_MODEL
from dive_trip.modules.usage.public import ProviderBinding
from dive_trip.platform.errors import DomainError


async def test_reviewed_factory_pins_transport_and_does_not_discover_credentials(
    monkeypatch,
):
    closed = []
    transport = httpx.MockTransport(lambda _request: pytest.fail("no dispatch"))

    async def close():
        closed.append(True)

    monkeypatch.setattr(transport, "aclose", close)

    def factory(**kwargs):
        assert kwargs == {"trust_env": False, "retries": 0}
        return transport

    monkeypatch.setattr(httpx, "AsyncHTTPTransport", factory)
    provider = ProviderBinding(
        provider="cloudflare", model=CLOUDFLARE_MODEL, accountId="a" * 32
    )
    with pytest.raises(DomainError, match="EVALUATION_GENERATION_CONTEXT"):
        await reviewed_cloudflare_generation(provider, "synthetic-not-a-real-key")
    with pytest.raises(DomainError, match="EVALUATION_GENERATION_CONTEXT"):
        await reviewed_cloudflare_generation(
            ProviderBinding(provider="gemini", model=GEMINI_MODEL), "unit-placeholder"
        )
    generation = await reviewed_cloudflare_generation(provider, "unit-placeholder")
    await generation.aclose()
    assert closed == [True]
