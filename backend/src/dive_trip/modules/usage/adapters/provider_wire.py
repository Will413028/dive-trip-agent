"""Provider wire evidence, checked before SDK usage defaults can erase unknowns."""

import math
import re
from typing import Any

from pydantic import ValidationError

from dive_trip.modules.usage.provider import (
    CLOUDFLARE_MODEL,
    CLOUDFLARE_PRICE_BASIS,
    ModelUsageEvent,
    ProviderBinding,
    Usage,
)
from dive_trip.platform.errors import DomainError


class ProviderFailure(DomainError):
    def __init__(self, code: str, usage: ModelUsageEvent) -> None:
        super().__init__(code)
        self.usage = usage


def count(value: Any) -> int:
    if type(value) is not int or not 0 <= value <= 1_000_000_000:
        raise ValueError("INVALID_MODEL_USAGE")
    return value


def usage_of(raw: Any, *, gemini: bool) -> Usage | None:
    if not isinstance(raw, dict):
        return None
    try:
        if gemini:
            prompt = count(raw.get("promptTokenCount"))
            output = count(raw.get("candidatesTokenCount"))
            total = count(raw.get("totalTokenCount"))
            cache = raw.get("cachedContentTokenCount", 0)
            thought = raw.get("thoughtsTokenCount", 0)
            tool = count(raw.get("toolUsePromptTokenCount", 0))
        else:
            prompt = count(raw.get("prompt_tokens"))
            output = count(raw.get("completion_tokens"))
            total = count(raw.get("total_tokens"))
            cache = raw.get("prompt_tokens_details", {}).get("cached_tokens", 0)
            thought = raw.get("completion_tokens_details", {}).get(
                "reasoning_tokens", 0
            )
            tool = 0
            if total != prompt + output or count(thought) > output:
                return None
        if count(cache) > prompt:
            return None
        # Chat completion reasoning tokens are already included in output.
        # Gemini reports thoughts separately. Preserve the existing ledger units.
        if total < prompt + output + (count(thought) + tool if gemini else 0):
            return None
        fields: dict[str, Any] = {
            "promptTokens": prompt,
            "outputTokens": output,
            "totalTokens": total,
        }
        cache_present = (
            "cachedContentTokenCount" in raw
            if gemini
            else "cached_tokens" in raw.get("prompt_tokens_details", {})
        )
        if cache_present:
            fields["cachedTokens"] = cache
        if gemini and "thoughtsTokenCount" in raw:
            fields["thoughtTokens"] = thought
        return Usage.model_validate(fields)
    except (ValueError, TypeError, AttributeError):
        return None


def wire_evidence(
    binding: ProviderBinding, call_id: str, raw: Any
) -> tuple[ModelUsageEvent, str | None]:
    """Return immutable accounting event and a fixed rejection code."""
    body = raw if isinstance(raw, dict) else {}
    gemini = binding.provider == "gemini"
    usage = usage_of(body.get("usageMetadata" if gemini else "usage"), gemini=gemini)
    evidence: dict[str, Any] | None = None
    failure = None
    if binding.provider == "openrouter":
        returned, generation = body.get("model"), body.get("id")
        valid_id = (
            isinstance(generation, str)
            and re.fullmatch(r"[a-zA-Z0-9_.:-]{1,128}", generation) is not None
        )
        valid_model = returned in (binding.model, binding.model[:-5])
        raw_usage = body.get("usage")
        cost = raw_usage.get("cost") if isinstance(raw_usage, dict) else None
        valid_cost = (
            isinstance(cost, (int, float))
            and not isinstance(cost, bool)
            and math.isfinite(cost)
            and cost >= 0
        )
        free = valid_cost and cost == 0
        byok = isinstance(raw_usage, dict) and raw_usage.get("is_byok", False)
        if (
            not valid_id
            or not valid_model
            or usage is None
            or byok is not False
            or not valid_cost
        ):
            failure = "AGENT_PROVIDER_INVALID_RESPONSE"
        elif not free:
            failure = "AGENT_PROVIDER_BILLING"
        if valid_id and valid_model:
            evidence = {
                "provider": "openrouter",
                "generationId": generation,
                "returnedModel": returned,
                "reportedCostMicros": 0 if free else None,
            }
        if failure:
            usage = None
    elif binding.provider == "cloudflare":
        returned = body.get("model")
        valid_model = returned in (CLOUDFLARE_MODEL, f"{CLOUDFLARE_MODEL}-external")
        evidence = {
            "provider": "cloudflare",
            "returnedModel": returned if valid_model else None,
            "priceBasis": CLOUDFLARE_PRICE_BASIS,
        }
        if not valid_model or usage is None:
            usage, failure = None, "AGENT_PROVIDER_INVALID_RESPONSE"
    try:
        event = ModelUsageEvent.model_validate(
            {
                "kind": "model-call-usage",
                "callId": call_id,
                "usage": usage.model_dump(exclude_none=True) if usage else None,
                "providerEvidence": evidence,
            }
        )
    except ValidationError:
        raise ValueError("INVALID_MODEL_USAGE") from None
    return event, failure
