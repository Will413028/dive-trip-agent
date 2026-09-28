"""Opt-in full-stack restart probe. Requires pnpm build; owns all data/processes."""

import argparse
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import httpx
import psycopg
from conftest import postgres
from psycopg.conninfo import conninfo_to_dict
from test_chat_http import start_body

from dive_trip.bootstrap.dev import unused_port
from dive_trip.platform.database import fixture_conninfo

ROOT = Path(__file__).resolve().parents[2]


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(5)
            raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--temporal-binary", type=Path, required=True)
    args = parser.parse_args()
    if not (ROOT / ".next/BUILD_ID").exists():
        raise RuntimeError("PRODUCTION_BUILD_REQUIRED")
    with (
        contextmanager(postgres.__wrapped__)() as admin,
        TemporaryDirectory(prefix="dive-local-probe-") as directory,
    ):
        database_port = int(conninfo_to_dict(admin)["port"])
        with psycopg.connect(admin, autocommit=True) as connection:
            connection.execute("CREATE DATABASE dive_trip_test")
        conninfo = fixture_conninfo(database_port)
        env = {"PATH": os.environ["PATH"]}
        base = [sys.executable, "-m", "dive_trip.bootstrap.local"]
        subprocess.run(
            [*base, "migrate", "--database-port", str(database_port)],
            cwd=ROOT,
            env=env,
            check=True,
            timeout=30,
        )
        port = unused_port()
        origin = f"http://127.0.0.1:{port}"
        command = [
            *base,
            "serve",
            "--database-port",
            str(database_port),
            "--temporal-storage",
            str(Path(directory) / "temporal.sqlite"),
            "--temporal-binary",
            str(args.temporal_binary.resolve(strict=True)),
            "--port",
            str(port),
            "--production",
        ]
        with (Path(directory) / "runtime.log").open("w+") as log:
            process = None
            try:
                with httpx.Client(
                    base_url=origin,
                    headers={"Origin": origin},
                    timeout=55,
                    trust_env=False,
                ) as client:
                    for cycle in (1, 2):
                        process = subprocess.Popen(
                            command,
                            cwd=ROOT,
                            env=env,
                            stdin=subprocess.DEVNULL,
                            stdout=log,
                            stderr=log,
                        )
                        deadline = time.monotonic() + 90
                        while True:
                            if process.poll() is not None:
                                raise RuntimeError("LOCAL_RUNTIME_STOPPED")
                            try:
                                if (
                                    client.get("/api/agent-mode", timeout=1).status_code
                                    == 200
                                ):
                                    break
                            except httpx.TransportError:
                                pass
                            if time.monotonic() >= deadline:
                                raise TimeoutError("LOCAL_RUNTIME_NOT_READY")
                            time.sleep(0.1)
                        if cycle == 1:
                            demo = client.post("/api/demo", json={"scenario": "normal"})
                            demo.raise_for_status()
                            trip_id = demo.json()["id"]
                            url = f"/api/trips/{trip_id}"
                            body = start_body(trip_id)
                            client.post(f"{url}/agent", json=body).raise_for_status()
                            run = client.get(f"{url}/runs").json()["runs"][0]
                            assert run["status"] == "awaiting_confirmation"
                        else:
                            replay = client.get(f"{url}/runs").json()["runs"][0]
                            assert replay == run
                            confirm = {
                                **body,
                                "runId": str(uuid4()),
                                "messages": [],
                                "forwardedProps": {"runId": run["id"]},
                                "resume": [
                                    {
                                        "interruptId": run["interruptId"],
                                        "status": "resolved",
                                        "payload": {"confirmed": True},
                                    }
                                ],
                            }
                            client.post(f"{url}/agent", json=confirm).raise_for_status()
                            assert client.get(url).json()["version"] == 2
                        stop(process)
                        process = None
                with psycopg.connect(conninfo) as connection:
                    assert connection.execute(
                        "SELECT count(*) FROM workbench_demo.planning_model_steps"
                    ).fetchone() == (2,)
                    assert connection.execute(
                        "SELECT status FROM workbench_demo.agent_runs"
                    ).fetchone() == ("succeeded",)
                print("LOCAL_RESTART_PROBE_PASSED: version=2 model_steps=2")
            except BaseException:
                log.flush()
                log.seek(0)
                print(log.read(), file=sys.stderr)
                raise
            finally:
                if process is not None:
                    stop(process)


if __name__ == "__main__":
    main()
