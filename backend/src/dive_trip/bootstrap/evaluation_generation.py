"""Generation factory for the reviewed controller's private child only.

The inherited channel obtains the credential from the existing gated controller
after admission. No HTTP route, environment lookup or offline scenario uses this
factory. Constructing a session does not call it; receipt phases never call it.
"""

import httpx2 as httpx

from dive_trip.application.evaluation_runtime import OwnedGeneration
from dive_trip.modules.usage.public import ProviderBinding
from dive_trip.platform.errors import DomainError
from dive_trip.platform.provider_sdk import _SdkGeneration


async def reviewed_cloudflare_generation(
    provider: ProviderBinding, credential: str
) -> OwnedGeneration:
    if (
        provider.provider != "cloudflare"
        or not credential.strip()
        or len(credential) > 8192
        or credential == "synthetic-not-a-real-key"
    ):
        raise DomainError("EVALUATION_GENERATION_CONTEXT")
    transport = httpx.AsyncHTTPTransport(trust_env=False, retries=0)
    try:
        return _SdkGeneration(provider, credential, transport)
    except Exception:
        await transport.aclose()
    raise DomainError("EVALUATION_GENERATION_CONFIG") from None
