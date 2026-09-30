import asyncio
import json

import httpx2 as httpx
import pytest
from pydantic_ai.messages import (
    ModelRequest,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.tools import ToolDefinition

from dive_trip.modules.usage.provider import CLOUDFLARE_MODEL, GEMINI_MODEL
from dive_trip.modules.usage.public import ProviderBinding
from dive_trip.platform import provider_sdk
from dive_trip.platform.errors import DomainError
from dive_trip.platform.provider_sdk import OfflineSdkGeneration, endpoint
from dive_trip.platform.provider_wire import ProviderFailure, wire_evidence


def binding(provider):
    return ProviderBinding(
        provider=provider,
        model={
            "gemini": GEMINI_MODEL,
            "openrouter": "vendor/model:free",
            "cloudflare": CLOUDFLARE_MODEL,
        }[provider],
        accountId="a" * 32 if provider == "cloudflare" else None,
    )


@pytest.mark.parametrize("provider", ["gemini", "openrouter", "cloudflare"])
async def test_sdk_close_releases_owned_inner_transport(provider, monkeypatch):
    transport = httpx.MockTransport(lambda request: httpx.Response(500))
    closed = []

    async def close():
        closed.append(True)

    monkeypatch.setattr(transport, "aclose", close)
    generation = OfflineSdkGeneration(
        binding(provider), "synthetic-not-a-real-key", transport
    )
    await generation.aclose()
    assert closed == [True]


def reply(provider):
    if provider == "gemini":
        return {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [
                            {
                                "functionCall": {
                                    "name": "calculate_budget",
                                    "args": {},
                                    "id": "call-1",
                                }
                            }
                        ],
                    },
                    "finishReason": "STOP",
                }
            ],
            "modelVersion": GEMINI_MODEL,
            "usageMetadata": {
                "promptTokenCount": 3,
                "candidatesTokenCount": 2,
                "totalTokenCount": 5,
            },
        }
    result = {
        "id": "generation-1",
        "object": "chat.completion",
        "created": 1,
        "model": binding(provider).model,
        **({"provider": "synthetic-vendor"} if provider == "openrouter" else {}),
        "choices": [
            {
                "index": 0,
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {"name": "calculate_budget", "arguments": "{}"},
                        }
                    ],
                },
            }
        ],
        "usage": {
            "prompt_tokens": 3,
            "completion_tokens": 2,
            "total_tokens": 5,
            **({"cost": 0} if provider == "openrouter" else {}),
        },
    }
    return result


async def request(generation):
    return await generation.request(
        [ModelRequest(parts=[UserPromptPart("synthetic request")])],
        None,
        ModelRequestParameters(
            function_tools=[
                ToolDefinition(
                    name="calculate_budget",
                    parameters_json_schema={
                        "type": "object",
                        "properties": {},
                        "additionalProperties": False,
                    },
                )
            ],
            allow_text_output=False,
        ),
        "activity-1",
    )


@pytest.mark.parametrize("provider", ["gemini", "openrouter", "cloudflare"])
async def test_native_sdk_uses_pinned_wire_and_raw_accounting(provider, monkeypatch):
    for name in ("OPENAI_BASE_URL", "GOOGLE_GEMINI_BASE_URL"):
        monkeypatch.setenv(name, "https://must-not-be-used.invalid")
    monkeypatch.setenv("OPENAI_API_KEY", "ignored-synthetic-key")
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    seen = []

    def transport(req):
        seen.append(req)
        return httpx.Response(200, json=reply(provider))

    generation = OfflineSdkGeneration(
        binding(provider), "synthetic-not-a-real-key", httpx.MockTransport(transport)
    )
    try:
        response, usage = await request(generation)
    finally:
        await generation.aclose()
    assert len(seen) == 1
    assert str(seen[0].url) == endpoint(binding(provider))
    assert len(response.parts) == 1 and isinstance(response.parts[0], ToolCallPart)
    assert response.parts[0].tool_name == "calculate_budget"
    assert usage.usage.promptTokens == 3
    assert usage.usage.outputTokens == 2
    body = json.loads(seen[0].content)
    if provider == "gemini":
        assert body["generationConfig"]["maxOutputTokens"] == 2048
        assert seen[0].headers["x-goog-api-key"] == "synthetic-not-a-real-key"
    else:
        assert seen[0].headers["authorization"] == "Bearer synthetic-not-a-real-key"
        assert body["stream"] is False
        if provider == "openrouter":
            assert body["provider"]["allow_fallbacks"] is False
            assert body["provider"]["max_price"] == {
                "prompt": 0,
                "completion": 0,
                "request": 0,
                "image": 0,
            }
            assert body["max_tokens"] == 2048
        else:
            assert body["model"] == CLOUDFLARE_MODEL and "provider" not in body
            assert body["max_completion_tokens"] == 2048
            assert body["chat_template_kwargs"] == {"enable_thinking": False}


@pytest.mark.parametrize("provider", ["gemini", "openrouter", "cloudflare"])
@pytest.mark.parametrize("status", [429, 503])
async def test_sdk_cannot_retry_or_leak_upstream_failure(provider, status):
    calls = []

    def transport(req):
        calls.append(req)
        return httpx.Response(status, json={"error": "PRIVATE_UPSTREAM_TEXT"})

    generation = OfflineSdkGeneration(
        binding(provider), "synthetic-not-a-real-key", httpx.MockTransport(transport)
    )
    try:
        with pytest.raises(ProviderFailure) as failure:
            await request(generation)
        assert failure.value.code == (
            "AGENT_PROVIDER_RATE_LIMIT"
            if status == 429
            else "AGENT_PROVIDER_UNAVAILABLE"
        )
        assert failure.value.usage.usage is None
        assert failure.value.__context__ is None
        assert failure.value.__cause__ is None
        assert len(calls) == 1
    finally:
        await generation.aclose()


@pytest.mark.parametrize(
    "response,expected",
    [
        (408, "AGENT_PROVIDER_TIMEOUT_HTTP"),
        (504, "AGENT_PROVIDER_TIMEOUT_HTTP"),
        ("read-timeout", "AGENT_PROVIDER_TIMEOUT_TRANSPORT"),
    ],
)
async def test_cloudflare_timeout_source_is_fixed_and_usage_stays_unknown(
    response, expected
):
    calls = []

    def transport(req):
        calls.append(req)
        if response == "read-timeout":
            raise httpx.ReadTimeout("PRIVATE_UPSTREAM_TEXT")
        return httpx.Response(response, json={"error": "PRIVATE_UPSTREAM_TEXT"})

    generation = OfflineSdkGeneration(
        binding("cloudflare"),
        "synthetic-not-a-real-key",
        httpx.MockTransport(transport),
    )
    try:
        with pytest.raises(ProviderFailure) as failure:
            await request(generation)
        assert failure.value.code == expected
        assert failure.value.usage.usage is None
        assert failure.value.__context__ is None
        assert failure.value.__cause__ is None
        assert "PRIVATE_UPSTREAM_TEXT" not in str(failure.value)
        assert len(calls) == 1
    finally:
        await generation.aclose()


async def test_cloudflare_local_deadline_has_fixed_private_classification(monkeypatch):
    calls = []

    async def transport(req):
        calls.append(req)
        await asyncio.Event().wait()

    generation = OfflineSdkGeneration(
        binding("cloudflare"),
        "synthetic-not-a-real-key",
        httpx.MockTransport(transport),
    )
    monkeypatch.setattr(provider_sdk, "_MODEL_REQUEST_DEADLINE_SECONDS", 0.01)
    try:
        with pytest.raises(ProviderFailure) as failure:
            await asyncio.wait_for(request(generation), 1)
        assert failure.value.code == "AGENT_PROVIDER_TIMEOUT_LOCAL"
        assert failure.value.usage.usage is None
        assert len(calls) == 1
    finally:
        await generation.aclose()


@pytest.mark.parametrize("provider", ["gemini", "openrouter", "cloudflare"])
async def test_sdk_never_turns_absent_usage_into_zero(provider):
    raw = reply(provider)
    body = raw
    body.pop("usageMetadata" if provider == "gemini" else "usage")
    generation = OfflineSdkGeneration(
        binding(provider),
        "synthetic-not-a-real-key",
        httpx.MockTransport(lambda _: httpx.Response(200, json=raw)),
    )
    try:
        if provider == "gemini":
            _, event = await request(generation)
        else:
            with pytest.raises(ProviderFailure) as failure:
                await request(generation)
            event = failure.value.usage
        assert event.usage is None
    finally:
        await generation.aclose()


def test_reasoning_is_not_double_counted_and_malformed_counts_remain_unknown():
    raw = reply("openrouter")
    raw["usage"]["completion_tokens_details"] = {"reasoning_tokens": 1}
    event, failure = wire_evidence(binding("openrouter"), "call", raw)
    assert failure is None and event.usage.thoughtTokens is None
    for value in (None, True, -1, 1.5, 1_000_000_001):
        raw["usage"]["prompt_tokens"] = value
        assert wire_evidence(binding("openrouter"), "call", raw)[0].usage is None


def test_offline_capability_cannot_accept_real_credentials_or_network_transport():
    with pytest.raises(DomainError, match="SYNTHETIC_CREDENTIAL_REQUIRED"):
        OfflineSdkGeneration(
            binding("gemini"),
            "not-the-synthetic-key",
            httpx.MockTransport(lambda _: None),
        )
    with pytest.raises(DomainError, match="SYNTHETIC_CREDENTIAL_REQUIRED"):
        OfflineSdkGeneration(binding("gemini"), "synthetic-not-a-real-key", object())


@pytest.mark.parametrize(
    "cost,code",
    [
        (None, "AGENT_PROVIDER_INVALID_RESPONSE"),
        (True, "AGENT_PROVIDER_INVALID_RESPONSE"),
        (-1, "AGENT_PROVIDER_INVALID_RESPONSE"),
        (0.1, "AGENT_PROVIDER_BILLING"),
    ],
)
def test_openrouter_cost_must_be_explicitly_free(cost, code):
    raw = reply("openrouter")
    raw["usage"]["cost"] = cost
    event, failure = wire_evidence(binding("openrouter"), "call", raw)
    assert failure == code
    assert event.usage is None
    assert event.providerEvidence.reportedCostMicros is None


@pytest.mark.parametrize("provider", ["gemini", "openrouter", "cloudflare"])
async def test_native_sdk_bounds_body_and_forbids_redirect(provider):
    calls = []

    def transport(req):
        calls.append(req)
        return httpx.Response(
            302, headers={"location": "https://must-not-follow.invalid"}
        )

    generation = OfflineSdkGeneration(
        binding(provider), "synthetic-not-a-real-key", httpx.MockTransport(transport)
    )
    try:
        with pytest.raises(ProviderFailure, match="AGENT_PROVIDER_ERROR"):
            await request(generation)
        assert len(calls) == 1
    finally:
        await generation.aclose()
    generation = OfflineSdkGeneration(
        binding(provider),
        "synthetic-not-a-real-key",
        httpx.MockTransport(lambda _: httpx.Response(200, content=b" " * 65537)),
    )
    try:
        with pytest.raises(ProviderFailure, match="AGENT_PROVIDER_INVALID_RESPONSE"):
            await request(generation)
    finally:
        await generation.aclose()


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        ({"content": "synthetic text"}, [TextPart, ToolCallPart]),
        ({"reasoning_content": "synthetic reasoning"}, [ThinkingPart, ToolCallPart]),
        ({"reasoning": "synthetic reasoning"}, [ThinkingPart, ToolCallPart]),
        (
            {"content": "synthetic text", "reasoning_content": "synthetic reasoning"},
            [ThinkingPart, TextPart, ToolCallPart],
        ),
        (
            {"content": "<think>synthetic reasoning</think>synthetic text"},
            [ThinkingPart, TextPart, ToolCallPart],
        ),
        ({"content": ""}, [ToolCallPart]),
    ],
)
async def test_cloudflare_sdk_preserves_mixed_wire_parts_without_retry(
    fields, expected
):
    payload = reply("cloudflare")
    payload["choices"][0]["message"].update(fields)
    seen = []

    def transport(req):
        seen.append(req)
        return httpx.Response(200, json=payload)

    generation = OfflineSdkGeneration(
        binding("cloudflare"),
        "synthetic-not-a-real-key",
        httpx.MockTransport(transport),
    )
    try:
        response, usage = await request(generation)
    finally:
        await generation.aclose()
    assert [type(part) for part in response.parts] == expected
    assert len(seen) == 1
    body = json.loads(seen[0].content)
    assert body["chat_template_kwargs"] == {"enable_thinking": False}
    assert body["tool_choice"] == "required"
    assert usage.usage is not None and usage.usage.totalTokens == 5
