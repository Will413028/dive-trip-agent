"""Restore a private demo backup into an owned disposable DB, then migrate it."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from contextlib import contextmanager
from pathlib import Path

import psycopg
from conftest import postgres
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

from dive_trip.application.run_queries import RunQueries
from dive_trip.application.trips import TripService
from dive_trip.platform.database import Database, fixture_conninfo
from dive_trip.platform.migrations import MIGRATIONS, migrate, require_current


def fingerprint(connection, schema, table, columns, *, old_ledger=False):
    rows = connection.execute(
        sql.SQL(
            "SELECT row_to_json(r)::text FROM (SELECT {} FROM {}.{} {}) r ORDER BY 1"
        ).format(
            sql.SQL(",").join(map(sql.Identifier, columns)),
            sql.Identifier(schema),
            sql.Identifier(table),
            sql.SQL("WHERE id < '014'") if old_ledger else sql.SQL(""),
        )
    ).fetchall()
    return hashlib.sha256(json.dumps(rows).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backup", type=Path, required=True)
    args = parser.parse_args()
    restore = shutil.which("pg_restore")
    if restore is None:
        raise RuntimeError("EXISTING_PG_RESTORE_REQUIRED")
    with contextmanager(postgres.__wrapped__)() as admin:
        port = int(conninfo_to_dict(admin)["port"])
        with psycopg.connect(admin, autocommit=True) as connection:
            connection.execute("CREATE DATABASE dive_trip_test")
        conninfo = fixture_conninfo(port)
        subprocess.run(
            [restore, "--dbname", conninfo, "--exit-on-error", str(args.backup)],
            env={"PATH": os.environ["PATH"]},
            check=True,
            capture_output=True,
            timeout=45,
        )
        with psycopg.connect(conninfo) as connection:
            tables = connection.execute(
                "SELECT table_schema,table_name,array_agg(column_name::text "
                "ORDER BY ordinal_position) FROM information_schema.columns "
                "WHERE table_schema IN ('workbench_demo','workbench_demo_adk') "
                "GROUP BY table_schema,table_name ORDER BY 1,2"
            ).fetchall()
            before = {
                (schema, table): fingerprint(connection, schema, table, columns)
                for schema, table, columns in tables
            }
            trips = connection.execute(
                "SELECT owner_id,id FROM workbench_demo.trips ORDER BY id"
            ).fetchall()
        database = Database(conninfo, "workbench_demo")
        database.open()
        try:
            migrate(database)
            require_current(database)
            with psycopg.connect(conninfo) as connection:
                for schema, table, columns in tables:
                    assert (
                        fingerprint(
                            connection,
                            schema,
                            table,
                            columns,
                            old_ledger=table == "schema_migrations",
                        )
                        == before[schema, table]
                    ), (schema, table)
            count = 0
            for owner, trip in trips:
                TripService(database).get(str(owner), str(trip))
                count += len(RunQueries(database).list(str(owner), str(trip)))
            print(
                json.dumps(
                    {
                        "result": "CUTOVER_RESTORE_PROBE_PASSED",
                        "preservedTables": len(tables),
                        "readableTrips": len(trips),
                        "readableRuns": count,
                        "migrations": len(MIGRATIONS),
                    }
                )
            )
        finally:
            database.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("CUTOVER_RESTORE_PROBE_FAILED") from None
