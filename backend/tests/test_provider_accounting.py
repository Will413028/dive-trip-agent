import json
import subprocess
from pathlib import Path

import pytest

from dive_trip.modules.usage.provider import (
    CLOUDFLARE_MODEL,
    CLOUDFLARE_PRICE_BASIS,
    GEMINI_MODEL,
    ModelUsageEvent,
    ProviderBinding,
    Usage,
    maximum_cost,
    reference_cost,
    validate_usage,
)


def test_pinned_reference_costs_match_actual_typescript_accounting():
    cases = []
    for provider, model, evidence in [
        ("gemini", GEMINI_MODEL, None),
        (
            "openrouter",
            "vendor/model:free",
            {
                "provider": "openrouter",
                "generationId": "synthetic-id",
                "returnedModel": "vendor/model",
                "reportedCostMicros": 0,
            },
        ),
        (
            "cloudflare",
            CLOUDFLARE_MODEL,
            {
                "provider": "cloudflare",
                "returnedModel": CLOUDFLARE_MODEL,
                "priceBasis": CLOUDFLARE_PRICE_BASIS,
            },
        ),
    ]:
        binding = ProviderBinding(
            provider=provider,
            model=model,
            accountId="a" * 32 if provider == "cloudflare" else None,
        )
        for prompt, output in [
            (0, 0),
            (1, 1),
            (101, 203),
            (1048576, 2048),
            (9007199254740980, 10),
        ]:
            for remaining in (0, 1, 7):
                usage = {
                    "promptTokens": prompt,
                    "outputTokens": output,
                    "totalTokens": prompt + output,
                }
                raw = {"kind": "model-call-usage", "callId": "call", "usage": usage}
                if evidence:
                    raw["providerEvidence"] = evidence
                event = ModelUsageEvent.model_validate(raw)
                cases.append(
                    {
                        "provider": provider,
                        "usage": usage,
                        "providerEvidence": evidence,
                        "remaining": remaining,
                        "actual": {
                            "cost": reference_cost(binding, event),
                            "maximum": maximum_cost(provider, remaining),
                        },
                    }
                )
        cases.append(
            {
                "provider": provider,
                "usage": None,
                "providerEvidence": evidence,
                "remaining": 7,
                "actual": {"cost": None, "maximum": maximum_cost(provider)},
            }
        )
    result = subprocess.run(
        ["node", str(Path(__file__).with_name("legacy_costs.mjs"))],
        input=json.dumps(cases),
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    assert [case["actual"] for case in cases] == json.loads(result.stdout)


@pytest.mark.parametrize(
    "patch",
    [
        {"cachedTokens": None},
        {"thoughtTokens": None},
        {"promptTokens": True},
        {"totalTokens": 1},
        {"cachedTokens": 11},
        {"thoughtTokens": 2},
        {"extra": 0},
    ],
)
def test_usage_rejects_ambiguous_and_inconsistent_counts(patch):
    with pytest.raises(ValueError):
        Usage.model_validate(
            {"promptTokens": 10, "outputTokens": 5, "totalTokens": 15, **patch}
        )


def test_free_provider_missing_or_paid_evidence_cannot_be_settled_as_zero():
    binding = ProviderBinding(provider="openrouter", model="vendor/model:free")
    for cost in (None, 1):
        event = ModelUsageEvent.model_validate(
            {
                "kind": "model-call-usage",
                "callId": "call",
                "usage": {"promptTokens": 1, "outputTokens": 1, "totalTokens": 2},
                "providerEvidence": {
                    "provider": "openrouter",
                    "generationId": "synthetic-id",
                    "returnedModel": "vendor/model",
                    "reportedCostMicros": cost,
                },
            }
        )
        assert reference_cost(binding, event) is None
        with pytest.raises(ValueError, match="INVALID_MODEL_USAGE"):
            validate_usage(binding, event)


def test_cloudflare_rejects_foreign_account_model_and_double_counted_thoughts():
    with pytest.raises(ValueError, match="PROVIDER_CONFLICT"):
        ProviderBinding(
            provider="cloudflare", model=CLOUDFLARE_MODEL, accountId="invalid"
        )
    binding = ProviderBinding(
        provider="cloudflare", model=CLOUDFLARE_MODEL, accountId="a" * 32
    )
    event = ModelUsageEvent.model_validate(
        {
            "kind": "model-call-usage",
            "callId": "call",
            "usage": {
                "promptTokens": 1,
                "outputTokens": 1,
                "totalTokens": 3,
                "thoughtTokens": 1,
            },
            "providerEvidence": {
                "provider": "cloudflare",
                "returnedModel": CLOUDFLARE_MODEL,
                "priceBasis": CLOUDFLARE_PRICE_BASIS,
            },
        }
    )
    assert reference_cost(binding, event) is None
