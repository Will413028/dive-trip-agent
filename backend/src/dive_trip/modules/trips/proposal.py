"""Build reviewable drafts without changing the bound snapshot or catalog."""

from itertools import combinations
from typing import Any

from dive_trip.modules.catalog.public import load_catalog
from dive_trip.platform.schema import MAX_SAFE_INTEGER, WireModel, safe_integer

from .changes import Change, parse_changes
from .domain import Budget, Entry, Snapshot, budget_model, participants


class Issue(WireModel):
    code: str
    message: str
    entryId: str | None = None


class ProposalDraft(WireModel):
    next: Snapshot
    budget: Budget
    issues: list[Issue]
    changes: list[Change]
    canApply: bool


def build_proposal(
    base: Snapshot, changes: Any, catalog: Any, actor: str
) -> ProposalDraft:
    next_snapshot = base.model_copy(deep=True)
    issues: list[Issue] = []
    can_apply = True

    def issue(
        code: str, message: str, entry_id: str | None = None, warning: bool = False
    ) -> None:
        nonlocal can_apply
        issues.append(Issue(code=code, message=message, entryId=entry_id))
        if not warning:
            can_apply = False

    try:
        accepted = parse_changes(changes)
    except ValueError:
        accepted = []
        issue("INVALID_CHANGE", "修改格式無效；不接受快照、actor、額外欄位或非法數量。")
    if actor not in ("user", "agent"):
        issue("INVALID_ACTOR", "操作來源必須由服務端指定。")
    locks = [change for change in accepted if change.kind == "lock"]
    standalone_lock = actor == "user" and len(accepted) == 1 and len(locks) == 1
    if locks and not standalone_lock:
        issue("LOCKED_ENTRY", "鎖定／解鎖只允許使用者單獨操作。")
    try:
        items = {item.id: item for item in load_catalog(catalog)}
    except ValueError:
        items = {}
        issue("INVALID_CATALOG", "服務端目錄格式無效。")

    if can_apply:
        for change in accepted:
            if change.kind == "requirements":
                next_snapshot.requirements = change.value.model_copy(deep=True)
                continue
            if change.kind == "add":
                if any(entry.id == change.entry.id for entry in next_snapshot.entries):
                    issue("DUPLICATE_ENTRY", "項目 ID 已存在。", change.entry.id)
                elif change.entry.catalogId not in items:
                    issue("CATALOG_NOT_FOUND", "找不到目錄項目。", change.entry.id)
                else:
                    next_snapshot.entries.append(
                        Entry(
                            **change.entry.model_dump(),
                            locked=False,
                            item=items[change.entry.catalogId].model_copy(deep=True),
                        )
                    )
                continue
            entry = next(
                (e for e in next_snapshot.entries if e.id == change.entryId), None
            )
            if entry is None:
                issue("ENTRY_NOT_FOUND", "找不到行程項目。", change.entryId)
                continue
            match change.kind:
                case "remove":
                    next_snapshot.entries.remove(entry)
                case "move":
                    entry.day, entry.slot = change.day, change.slot
                case "rooms":
                    entry.rooms = change.rooms
                case "lock":
                    entry.locked = change.locked
                case "replace":
                    if change.catalogId not in items:
                        issue("CATALOG_NOT_FOUND", "找不到目錄項目。", entry.id)
                    else:
                        entry.catalogId = change.catalogId
                        entry.item = items[change.catalogId].model_copy(deep=True)

    req = next_snapshot.requirements
    for protected in (entry for entry in base.entries if entry.locked):
        candidate = next(
            (e for e in next_snapshot.entries if e.id == protected.id), None
        )
        if candidate is not None and standalone_lock:
            candidate = candidate.model_copy(update={"locked": protected.locked})
        if (
            candidate != protected
            or base.requirements.startDate != req.startDate
            or protected.day > req.days
            or (protected.endDay or protected.day) > req.days
            or protected.item.destinationId != req.destinationId
        ):
            issue(
                "LOCKED_ENTRY",
                "已鎖定項目的內容、日期或費用依據不能更動；請先單獨解鎖。",
                protected.id,
            )

    capacity_conflicts: set[str] = set()
    invalid: set[str] = set()
    ids: set[str] = set()
    for entry in next_snapshot.entries:
        if entry.id in ids:
            issue("DUPLICATE_ENTRY", "項目 ID 不可重複。", entry.id)
        ids.add(entry.id)
        if entry.catalogId not in items:
            issue("CATALOG_NOT_FOUND", "目錄項目不存在。", entry.id)
        if entry.item.destinationId != req.destinationId:
            issue("DESTINATION_MISMATCH", "項目不屬於本趟目的地。", entry.id)
        if entry.day > req.days or (
            entry.endDay is not None and entry.endDay > req.days
        ):
            issue("DATE_OUT_OF_RANGE", "項目日期超出行程。", entry.id)
            invalid.add(entry.id)
        if entry.item.kind == "lodging":
            if entry.rooms is None or entry.endDay is None or entry.endDay <= entry.day:
                issue(
                    "INVALID_LODGING",
                    "住宿需正整數房數與有效退房日，至少一晚。",
                    entry.id,
                )
                invalid.add(entry.id)
            else:
                capacity = entry.rooms * (entry.item.capacityPerRoom or 0)
                if capacity > MAX_SAFE_INTEGER or capacity < participants(entry, req):
                    issue(
                        "CAPACITY",
                        "住宿容量不足或容量超出安全整數範圍；請明確調整房間數。",
                        entry.id,
                    )
                    capacity_conflicts.add(entry.id)
        elif entry.rooms is not None or entry.endDay is not None:
            issue("INVALID_LODGING", "活動不可帶房數或退房日。", entry.id)
            invalid.add(entry.id)
    activities = [e for e in next_snapshot.entries if e.item.kind == "activity"]
    for left, right in combinations(activities, 2):
        common = (
            left.item.audience == "all"
            or right.item.audience == "all"
            or left.item.audience == right.item.audience
        )
        if (
            left.day == right.day
            and left.slot == right.slot
            and common
            and participants(left, req) > 0
            and participants(right, req) > 0
        ):
            issue("OVERLAP", f"與 {left.id} 的參與者及時段重疊。", right.id)

    known = 0
    unknown: list[str] = []
    incomplete = False
    for entry in next_snapshot.entries:
        try:
            if entry.id in invalid:
                raise ValueError("invalid quantity")
            if entry.id in capacity_conflicts:
                assert entry.rooms is not None and entry.endDay is not None
                count = safe_integer(entry.rooms * (entry.endDay - entry.day))
                amount = entry.item.price.unitMinor
                cost = Budget(
                    knownMinor=0 if amount is None else safe_integer(count * amount),
                    unknownEntryIds=[entry.id] if amount is None else [],
                    withinBudget=None,
                )
            else:
                cost = budget_model(
                    next_snapshot.model_copy(update={"entries": [entry]})
                )
            known = safe_integer(known + cost.knownMinor)
            unknown.extend(cost.unknownEntryIds)
        except ValueError:
            incomplete = True
            issue(
                "BUDGET_INVALID",
                "此項費用無法安全計算；knownMinor 僅為可計算項目小計。",
                entry.id,
            )
    limit = req.budgetMinor
    comparable = not (
        incomplete or capacity_conflicts or unknown or next_snapshot.exclusions
    )
    budget = Budget(
        knownMinor=known,
        unknownEntryIds=unknown,
        withinBudget=known <= limit if comparable and limit is not None else None,
    )
    if limit is not None and known > limit:
        issue("BUDGET_EXCEEDED", "已知費用已超過預算；請調整需求或行程。")
    for entry_id in unknown:
        issue("UNKNOWN_COST", "費用待確認，不能宣稱預算足夠。", entry_id, True)
    if next_snapshot.exclusions:
        issue("EXCLUDED_COST", "仍有未納入費用，不能宣稱預算足夠。", warning=True)
    return ProposalDraft(
        next=next_snapshot,
        budget=budget,
        issues=issues,
        changes=accepted,
        canApply=can_apply,
    )
