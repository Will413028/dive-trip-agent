#!/usr/bin/env bash
# Nightly reset of the deposits demo: release every sandbox hold, then rebuild the
# database and Temporal state from scratch. Run from this directory with the same
# DEMO_* variables as `docker compose up` (see README.md).
set -euo pipefail
: "${DEMO_SECRETS_DIR:?}" "${DEMO_REVISION:?}" "${DEMO_ORIGIN:?}"
compose=(docker compose -f compose.yaml)

# Close the public entry first so no new hold is placed during the reset.
"${compose[@]}" stop tunnel web api worker
status=0
"${compose[@]}" --profile maintenance run --rm void-holds || status=$?
"${compose[@]}" --profile maintenance down --volumes --remove-orphans
"${compose[@]}" up -d
# A failed void leaves a sandbox hold that expires on its own after 29 days; the
# rebuild still runs, and the non-zero exit makes the timer report the failure.
exit "$status"
