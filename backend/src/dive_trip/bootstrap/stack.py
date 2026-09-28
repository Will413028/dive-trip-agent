"""Owned API/worker/Web processes with bounded readiness and ordered shutdown."""

import asyncio
import os
import shutil
import sys
from pathlib import Path

import httpx2 as httpx

ROOT = Path(__file__).resolve().parents[4]


async def pinned_node() -> tuple[str, str]:
    if any((ROOT / name).exists() for name in (".env", ".env.test", ".env.test.local")):
        raise ValueError("OFFLINE_NEXT_REQUIRES_NO_TEST_ENV_FILES")
    path = os.environ.get("PATH", "/usr/bin:/bin")
    node = shutil.which("node", path=path)
    if node is None:
        raise ValueError("NODE_REQUIRED")
    version = await asyncio.create_subprocess_exec(
        node, "--version", stdout=asyncio.subprocess.PIPE, env={"PATH": path}
    )
    output, _ = await asyncio.wait_for(version.communicate(), 5)
    if version.returncode or output.strip() != b"v26.8.1":
        raise ValueError("PINNED_NODE_REQUIRED")
    return node, path


async def stop(child: asyncio.subprocess.Process) -> None:
    if child.returncode is not None:
        return
    child.terminate()
    try:
        await asyncio.wait_for(child.wait(), 20)
    except TimeoutError:
        child.kill()
        await child.wait()


async def serve_stack(
    *,
    schema: str,
    database_port: int,
    temporal_port: int,
    api_port: int,
    web_port: int,
    production: bool,
    stopped: asyncio.Event,
    node: str,
    path: str,
) -> None:
    children: list[asyncio.subprocess.Process] = []
    origin = f"http://127.0.0.1:{web_port}"
    common = [
        sys.executable,
        "-m",
        "dive_trip.bootstrap.runtime",
        "--schema",
        schema,
        "--database-port",
        str(database_port),
        "--temporal-port",
        str(temporal_port),
        "--task-queue",
        schema,
        "--port",
        str(api_port),
        "--origin",
        origin,
    ]
    try:
        for role in ("api", "worker"):
            children.append(
                await asyncio.create_subprocess_exec(
                    *common,
                    "--role",
                    role,
                    cwd=ROOT,
                    env={"PATH": path},
                )
            )
        async with httpx.AsyncClient(timeout=1, trust_env=False) as client:
            async with asyncio.timeout(30):
                while True:
                    if stopped.is_set() or any(
                        child.returncode is not None for child in children
                    ):
                        raise RuntimeError("FIXTURE_RUNTIME_STOPPED")
                    try:
                        response = await client.get(
                            f"http://127.0.0.1:{api_port}/api/agent-mode"
                        )
                        if response.status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    await asyncio.sleep(0.1)
        next_args = [
            "start" if production else "dev",
            "-H",
            "127.0.0.1",
            "-p",
            str(web_port),
        ]
        if not production:
            next_args.append("--webpack")
        children.append(
            await asyncio.create_subprocess_exec(
                node,
                str(ROOT / "node_modules/next/dist/bin/next"),
                *next_args,
                cwd=ROOT,
                env={
                    "PATH": path,
                    "NODE_ENV": "test",
                    "NEXT_TELEMETRY_DISABLED": "1",
                    "PLAYWRIGHT_SKIP_BROWSER_GC": "1",
                    "GEMINI_ENABLED": "false",
                    "APP_ORIGIN": origin,
                    "DIVE_BACKEND_ORIGIN": f"http://127.0.0.1:{api_port}",
                },
            )
        )
        waits = [asyncio.create_task(child.wait()) for child in children]
        waits.append(asyncio.create_task(stopped.wait()))
        try:
            await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
            if not stopped.is_set():
                raise RuntimeError("FIXTURE_RUNTIME_STOPPED")
        finally:
            for wait in waits:
                wait.cancel()
            await asyncio.gather(*waits, return_exceptions=True)
    finally:
        # Drain Web then API, worker last; caller retains Temporal until this ends.
        for child in children[2:] + children[:2]:
            await stop(child)
