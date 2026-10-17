#!/usr/bin/env bash
# Nightly reset of the deposits demo: release every sandbox hold, then rebuild the
# database and Temporal state from scratch. The Tailscale node (ts) and its state
# stay up, so the public hostname does not change. Run from this directory with
# the same DEMO_* variables as `docker compose up` (see README.md).
#
# Deploying a new revision is the same rebuild: set DEMO_NEXT_REVISION, and the holds
# are voided by the running revision (whose code matches the current schema) before
# the fresh database is migrated and served by the next one.
set -euo pipefail
: "${DEMO_SECRETS_DIR:?}" "${DEMO_REVISION:?}" "${DEMO_ORIGIN:?}"
compose=(docker compose -f compose.yaml)
app=(web api worker)

# Stop the app first so no new hold is placed during the reset.
"${compose[@]}" stop "${app[@]}"
status=0
"${compose[@]}" --profile maintenance run --rm void-holds || status=$?
"${compose[@]}" --profile maintenance rm --stop --force "${app[@]}" migrate void-holds db temporal
project=$("${compose[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
docker volume rm "${project}_db-data" "${project}_temporal-data"
export DEMO_REVISION="${DEMO_NEXT_REVISION:-$DEMO_REVISION}"
"${compose[@]}" up -d
# Later nightly runs read demo.env; keep it on the revision now serving.
sed -i "s/^DEMO_REVISION=.*/DEMO_REVISION=${DEMO_REVISION}/" ../../demo.env
# A failed void leaves a sandbox hold that expires on its own after 29 days; the
# rebuild still runs, and the non-zero exit makes the timer report the failure.
exit "$status"
