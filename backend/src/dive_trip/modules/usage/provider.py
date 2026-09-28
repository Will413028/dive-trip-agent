"""Pinned provider identity and reference-risk accounting, never billing claims."""

import re
from typing import Annotated, Any, Literal, Self

from pydantic import Field, model_validator

from dive_trip.platform.schema import NonnegativeInt, WireModel

GEMINI_MODEL = "gemini-3.1-flash-lite"
CLOUDFLARE_MODEL = "@cf/google/gemma-4-26b-a4b-it"
CLOUDFLARE_PRICE_BASIS = "cloudflare-gemma4-26b-2026-09-26"
MAX_SAFE = 9007199254740991
Provider = Literal["gemini", "openrouter", "cloudflare"]


class ProviderBinding(WireModel):
    provider: Provider
    model: str
    accountId: str | None = None

    @model_validator(mode="after")
    def valid(self) -> Self:
        if self.provider == "gemini" and self.model != GEMINI_MODEL:
            raise ValueError("PROVIDER_CONFLICT")
        if self.provider == "openrouter" and (
            len(self.model) > 160
            or re.fullmatch(r"[a-z0-9-]+/[a-z0-9._-]+:free", self.model) is None
        ):
            raise ValueError("PROVIDER_CONFLICT")
        if self.provider == "cloudflare":
            if (
                self.model != CLOUDFLARE_MODEL
                or re.fullmatch(r"[a-f0-9]{32}", self.accountId or "") is None
            ):
                raise ValueError("PROVIDER_CONFLICT")
        elif self.accountId is not None:
            raise ValueError("PROVIDER_CONFLICT")
        return self


class Usage(WireModel):
    promptTokens: NonnegativeInt
    outputTokens: NonnegativeInt
    totalTokens: NonnegativeInt
    cachedTokens: NonnegativeInt | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    thoughtTokens: NonnegativeInt | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @model_validator(mode="before")
    @classmethod
    def optional_is_not_null(cls, value: Any) -> Any:
        if isinstance(value, dict) and any(
            key in value and value[key] is None
            for key in ("cachedTokens", "thoughtTokens")
        ):
            raise ValueError("INVALID_MODEL_USAGE")
        return value

    @model_validator(mode="after")
    def consistent(self) -> Self:
        if (
            self.promptTokens + self.outputTokens + (self.thoughtTokens or 0)
            > self.totalTokens
            or (self.cachedTokens or 0) > self.promptTokens
        ):
            raise ValueError("INVALID_MODEL_USAGE")
        return self


class OpenRouterEvidence(WireModel):
    provider: Literal["openrouter"]
    generationId: Annotated[str, Field(max_length=128)] | None
    returnedModel: Annotated[str, Field(max_length=160)] | None
    reportedCostMicros: Annotated[NonnegativeInt, Field(le=1000000000)] | None


class CloudflareEvidence(WireModel):
    provider: Literal["cloudflare"]
    returnedModel: Annotated[str, Field(max_length=160)] | None
    priceBasis: Literal["cloudflare-gemma4-26b-2026-09-26"]


AccountingEvidence = Annotated[
    OpenRouterEvidence | CloudflareEvidence, Field(discriminator="provider")
]


class ModelUsageEvent(WireModel):
    kind: Literal["model-call-usage"]
    callId: Annotated[str, Field(min_length=1, max_length=128)]
    usage: Usage | None
    providerEvidence: AccountingEvidence | None = None

    @model_validator(mode="after")
    def identifier(self) -> Self:
        if not self.callId.strip() or "\0" in self.callId:
            raise ValueError("INVALID_MODEL_USAGE")
        return self


def validate_usage(binding: ProviderBinding, event: ModelUsageEvent) -> None:
    evidence, usage = event.providerEvidence, event.usage
    if binding.provider == "gemini":
        if evidence is not None:
            raise ValueError("INVALID_MODEL_USAGE")
    elif binding.provider == "openrouter":
        if evidence is not None and (
            not isinstance(evidence, OpenRouterEvidence)
            or not evidence.generationId
            or evidence.returnedModel not in (binding.model, binding.model[:-5])
            or evidence.reportedCostMicros not in (None, 0)
        ):
            raise ValueError("INVALID_MODEL_USAGE")
        if usage is not None and (
            not isinstance(evidence, OpenRouterEvidence)
            or evidence.reportedCostMicros != 0
        ):
            raise ValueError("INVALID_MODEL_USAGE")
    else:
        if evidence is not None and not isinstance(evidence, CloudflareEvidence):
            raise ValueError("INVALID_MODEL_USAGE")
        if usage is not None and (
            not isinstance(evidence, CloudflareEvidence)
            or evidence.returnedModel
            not in (CLOUDFLARE_MODEL, f"{CLOUDFLARE_MODEL}-external")
            or usage.totalTokens != usage.promptTokens + usage.outputTokens
            or usage.thoughtTokens is not None
        ):
            raise ValueError("INVALID_MODEL_USAGE")


def reference_cost(binding: ProviderBinding, event: ModelUsageEvent) -> int | None:
    try:
        validate_usage(binding, event)
    except ValueError:
        return None
    usage = event.usage
    if usage is None:
        return None
    if binding.provider == "gemini":
        value = (
            usage.promptTokens + 6 * (usage.totalTokens - usage.promptTokens) + 3
        ) // 4
    elif binding.provider == "cloudflare":
        value = (usage.promptTokens + 3 * usage.outputTokens + 9) // 10
    else:
        value = 0
    return value if value <= MAX_SAFE else None


def maximum_cost(provider: Provider, remaining_calls: int = 7) -> int:
    if type(remaining_calls) is not int or not 0 <= remaining_calls <= 7:
        raise ValueError("INVALID_MODEL_CALL_BUDGET")
    per_call = (
        (1048576 + 6 * 2048 + 3) // 4
        if provider == "gemini"
        else ((256000 + 3 * 2048 + 9) // 10 if provider == "cloudflare" else 1)
    )
    return per_call * remaining_calls
