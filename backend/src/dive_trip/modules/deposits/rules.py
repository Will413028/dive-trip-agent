"""Deterministic threshold rules over structured evidence.

They only read structured data (forecast values, simulated storms). Free text such as
an operator's notice is the agent's job; here it is ignored. The result is either the
"No AI" fallback proposal or a sanity guard compared against the agent's facts.
"""

from typing import Any

from .domain import SettlementFacts

WAVE_LIMIT_M = 2.5


def cancelled_days(evidence_row: dict[str, Any], trip_days: int) -> set[int]:
    data = evidence_row.get("data") or {}
    days: set[int] = set()
    if evidence_row["kind"] == "simulated":
        days.update(int(day) for day in data.get("cancelledDays", []))
    elif evidence_row["kind"] == "forecast":
        for item in data.get("daily", []):
            height = item.get("waveHeightMaxM")
            if isinstance(height, (int, float)) and height > WAVE_LIMIT_M:
                days.add(int(item["day"]))
    return {day for day in days if 1 <= day <= trip_days}


def rule_facts(
    evidence_rows: list[dict[str, Any]], trip_days: int
) -> SettlementFacts | None:
    days: set[int] = set()
    cited: list[str] = []
    for row in evidence_rows:
        found = cancelled_days(row, trip_days)
        if found:
            days |= found
            cited.append(str(row["id"]))
    if not days:
        return None
    return SettlementFacts(
        cause="weather", cancelledDays=sorted(days), evidenceIds=cited
    )


def agrees(agent: SettlementFacts, rules: SettlementFacts | None) -> bool:
    if rules is None:
        return False
    return agent.cause == rules.cause and set(agent.cancelledDays) == set(
        rules.cancelledDays
    )
