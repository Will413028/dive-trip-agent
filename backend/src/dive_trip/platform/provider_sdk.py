"""Native SDK wire core and strictly offline public test adapter.

Generation capabilities select a transport explicitly; this module never
discovers credentials or replaces an offline transport with a network one.
"""

import asyncio
import json
from contextvars import ContextVar
from dataclasses import dataclass

import httpx2 as httpx
from google.genai import Client as GoogleClient
from google.genai.types import HttpOptions, HttpRetryOptions
from openai import APITimeoutError, AsyncOpenAI
from pydantic_ai.messages import ModelMessage, ModelResponse
from pydantic_ai.models import Model, ModelRequestParameters
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.models.openrouter import (
    OpenRouterModel,
    OpenRouterModelSettings,
    OpenRouterProviderConfig,
)
from pydantic_ai.profiles.openai import OpenAIModelProfile
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.providers.openrouter import OpenRouterProvider
from pydantic_ai.settings import ModelSettings

from dive_trip.modules.usage.public import ModelUsageEvent, ProviderBinding

from .errors import DomainError
from .provider_wire import ProviderFailure, wire_evidence


@dataclass
class Capture:
    call_id: str
    calls: int = 0
    usage: ModelUsageEvent | None = None
    failure: str | None = None


_capture: ContextVar[Capture] = ContextVar("provider_wire_capture")
_MODEL_REQUEST_DEADLINE_SECONDS = 30


def _has_transport_timeout(error: BaseException) -> bool:
    # PydanticAI can wrap OpenAI's APITimeoutError in ModelAPIError. Inspect
    # only exception types; raw messages and URLs must not enter evidence.
    current: BaseException | None = error
    for _ in range(4):
        if current is None:
            break
        if isinstance(current, (APITimeoutError, httpx.TimeoutException)):
            return True
        current = current.__cause__
    return False


OPENROUTER_POLICY: OpenRouterProviderConfig = {
    "allow_fallbacks": False,
    "require_parameters": True,
    "data_collection": "deny",
    "max_price": {"prompt": 0, "completion": 0, "request": 0, "image": 0},
}


def endpoint(binding: ProviderBinding) -> str:
    if binding.provider == "gemini":
        return (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{binding.model}:generateContent"
        )
    if binding.provider == "openrouter":
        return "https://openrouter.ai/api/v1/chat/completions"
    return (
        "https://api.cloudflare.com/client/v4/accounts/"
        f"{binding.accountId}/ai/v1/chat/completions"
    )


class WireTransport(httpx.AsyncBaseTransport):
    def __init__(
        self, binding: ProviderBinding, transport: httpx.AsyncBaseTransport
    ) -> None:
        self.binding, self.transport = binding, transport

    async def aclose(self) -> None:
        await self.transport.aclose()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        try:
            return await self.send_once(request)
        except DomainError as error:
            _capture.get().failure = error.code
            raise

    async def send_once(self, request: httpx.Request) -> httpx.Response:
        capture = _capture.get()
        if capture.calls:
            raise DomainError("MODEL_DISPATCH_CONFLICT")
        capture.calls += 1
        body_bytes = await request.aread()
        if len(body_bytes) > 96000 or request.method != "POST":
            raise DomainError("AGENT_PROVIDER_BAD_REQUEST")
        body = json.loads(body_bytes)
        if not isinstance(body, dict):
            raise DomainError("AGENT_PROVIDER_BAD_REQUEST")
        target = endpoint(self.binding)
        if str(request.url) != target:
            raise DomainError("AGENT_PROVIDER_CONFIG")
        if self.binding.provider != "gemini":
            if (
                body.get("model") != self.binding.model
                or body.get("stream") is not False
            ):
                raise DomainError("AGENT_PROVIDER_CONFIG")
            if self.binding.provider == "openrouter":
                if (
                    body.get("max_tokens") != 2048
                    or body.get("provider") != OPENROUTER_POLICY
                ):
                    raise DomainError("AGENT_PROVIDER_CONFIG")
            elif body.get("max_completion_tokens") != 2048 or body.get(
                "chat_template_kwargs"
            ) != {"enable_thinking": False}:
                raise DomainError("AGENT_PROVIDER_CONFIG")
        elif body.get("generationConfig", {}).get("maxOutputTokens") != 2048:
            raise DomainError("AGENT_PROVIDER_CONFIG")
        response = await self.transport.handle_async_request(request)
        try:
            if response.status_code != 200:
                codes = {
                    400: "BAD_REQUEST",
                    401: "AUTH",
                    402: "BILLING",
                    403: "PERMISSION",
                    404: "NOT_FOUND",
                    408: "TIMEOUT_HTTP",
                    429: "RATE_LIMIT",
                    504: "TIMEOUT_HTTP",
                }
                suffix = codes.get(
                    response.status_code,
                    "UNAVAILABLE" if response.status_code >= 500 else "ERROR",
                )
                raise DomainError(f"AGENT_PROVIDER_{suffix}")
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > 65536:
                    raise DomainError("AGENT_PROVIDER_INVALID_RESPONSE")
            raw = json.loads(data)
            capture.usage, failure = wire_evidence(self.binding, capture.call_id, raw)
            if failure:
                raise DomainError(failure)
            return httpx.Response(
                200,
                content=bytes(data),
                headers={"content-type": "application/json"},
                request=request,
            )
        finally:
            await response.aclose()


class _SdkGeneration:
    def __init__(
        self,
        provider: ProviderBinding,
        credential: str,
        transport: httpx.AsyncBaseTransport,
    ) -> None:
        self.provider = provider
        self.http = httpx.AsyncClient(
            transport=WireTransport(provider, transport),
            trust_env=False,
            follow_redirects=False,
            timeout=30,
        )
        self.google: GoogleClient | None = None
        self.openai: AsyncOpenAI | None = None
        self.model: Model
        if provider.provider == "gemini":
            self.google = GoogleClient(
                api_key=credential,
                vertexai=False,
                enterprise=False,
                http_options=HttpOptions(
                    base_url="https://generativelanguage.googleapis.com",
                    api_version="v1beta",
                    timeout=30000,
                    retry_options=HttpRetryOptions(attempts=1),
                    httpx_async_client=self.http,
                ),
            )
            self.model = GoogleModel(
                provider.model, provider=GoogleProvider(client=self.google)
            )
        else:
            base = (
                "https://openrouter.ai/api/v1/"
                if provider.provider == "openrouter"
                else "https://api.cloudflare.com/client/v4/accounts/"
                f"{provider.accountId}/ai/v1/"
            )
            self.openai = AsyncOpenAI(
                api_key=credential,
                base_url=base,
                max_retries=0,
                organization="",
                project="",
                http_client=self.http,
                timeout=30,
            )
            if provider.provider == "openrouter":
                self.model = OpenRouterModel(
                    provider.model,
                    provider=OpenRouterProvider(openai_client=self.openai),
                    settings=OpenRouterModelSettings(
                        max_tokens=2048,
                        temperature=0,
                        openrouter_provider=OPENROUTER_POLICY,
                    ),
                )
            else:
                self.model = OpenAIChatModel(
                    provider.model,
                    provider=OpenAIProvider(openai_client=self.openai),
                    profile=OpenAIModelProfile(
                        openai_supports_tool_choice_required=True
                    ),
                    settings={
                        "extra_body": {
                            "chat_template_kwargs": {"enable_thinking": False}
                        }
                    },
                )

    async def aclose(self) -> None:
        if self.google is not None:
            await self.google.aio.aclose()
            self.google.close()
        if self.openai is not None:
            await self.openai.close()
        await self.http.aclose()

    async def request(
        self,
        messages: list[ModelMessage],
        settings: ModelSettings | None,
        parameters: ModelRequestParameters,
        call_id: str,
    ) -> tuple[ModelResponse, ModelUsageEvent]:
        capture = Capture(call_id)
        token = _capture.set(capture)
        failure = None
        response = None
        deadline = asyncio.timeout(_MODEL_REQUEST_DEADLINE_SECONDS)
        try:
            async with deadline:
                response = await self.model.request(
                    messages, {"max_tokens": 2048, "temperature": 0}, parameters
                )
        except DomainError as error:
            failure = error.code
        # These fixed origin codes are private activity failures. The product
        # still emits its existing fixed RUN_ERROR, with unknown usage preserved.
        except (APITimeoutError, httpx.TimeoutException):
            failure = (
                "AGENT_PROVIDER_TIMEOUT_LOCAL"
                if deadline.expired()
                else "AGENT_PROVIDER_TIMEOUT_TRANSPORT"
            )
        except TimeoutError:
            failure = (
                "AGENT_PROVIDER_TIMEOUT_LOCAL"
                if deadline.expired()
                else "AGENT_PROVIDER_TIMEOUT"
            )
        except Exception as error:
            failure = capture.failure or (
                "AGENT_PROVIDER_TIMEOUT_LOCAL"
                if deadline.expired()
                else "AGENT_PROVIDER_TIMEOUT_TRANSPORT"
                if _has_transport_timeout(error)
                else "AGENT_PROVIDER_INVALID_RESPONSE"
            )
        finally:
            _capture.reset(token)
        event = capture.usage or wire_evidence(self.provider, call_id, None)[0]
        if failure or response is None:
            # Raise outside the SDK exception handler: no raw exception context,
            # provider text, URL or credential is serialized into Temporal history.
            raise ProviderFailure(failure or "AGENT_PROVIDER_INVALID_RESPONSE", event)
        return response, event


class OfflineSdkGeneration(_SdkGeneration):
    """Mandatory MockTransport + synthetic key, even if host credentials exist.

    Exercises the actual PydanticAI/Google/OpenAI-compatible SDK wire conversion.
    This is not a live-generation capability and cannot choose a network fallback.
    """

    def __init__(
        self, provider: ProviderBinding, credential: str, transport: httpx.MockTransport
    ) -> None:
        if (
            credential != "synthetic-not-a-real-key"
            or type(transport) is not httpx.MockTransport
        ):
            raise DomainError("SYNTHETIC_CREDENTIAL_REQUIRED")
        super().__init__(provider, credential, transport)
