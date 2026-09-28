"""Strict JSON primitives shared with the TypeScript wire contract."""

import math
import re
from datetime import date
from typing import Annotated, Any

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

MAX_SAFE_INTEGER = 9007199254740991


def safe_integer(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("expected a JSON integer")
    if isinstance(value, float) and (not math.isfinite(value) or value != int(value)):
        raise ValueError("expected a finite integer")
    if abs(value) > MAX_SAFE_INTEGER:
        raise ValueError("integer exceeds the shared JSON safe range")
    return int(value)


def calendar_date(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("expected an ISO calendar date")
    date.fromisoformat(value)
    return value


def nonempty(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("text must not be blank")
    return value


SafeInt = Annotated[int, BeforeValidator(safe_integer)]
PositiveInt = Annotated[SafeInt, Field(ge=1)]
NonnegativeInt = Annotated[SafeInt, Field(ge=0)]
Nonempty = Annotated[str, BeforeValidator(nonempty)]
CalendarDate = Annotated[str, BeforeValidator(calendar_date)]


class WireModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
