"""Drain bounded synchronous DB work before propagating task cancellation."""

import asyncio
from collections.abc import Callable

import anyio


async def run_db[**P, R](
    function: Callable[P, R], *args: P.args, **kwargs: P.kwargs
) -> R:
    # Only DB operations with pool/statement/lock timeouts belong here. Cancelling
    # to_thread does not stop its OS thread or roll back its open transaction.
    operation = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    try:
        return await asyncio.shield(operation)
    except asyncio.CancelledError:
        # ASGI uses level cancellation; Temporal can issue Task.cancel directly.
        # Retain the task and observe its result under both cancellation models.
        with anyio.CancelScope(shield=True):
            while not operation.done():
                try:
                    await asyncio.shield(operation)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            if not operation.cancelled():
                operation.exception()
        raise
