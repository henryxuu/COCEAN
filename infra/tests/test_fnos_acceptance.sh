#!/bin/sh

set -eu

TEST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$TEST_DIR/../.." && pwd -P)
FIXTURES="$TEST_DIR/fixtures"
RUNNER="$REPO_ROOT/infra/scripts/fnos_acceptance.sh"
COMPOSE="$REPO_ROOT/infra/compose/fnos/compose.yaml"
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/cocean-acceptance-test.XXXXXX")
trap 'rm -rf "$TEMP_ROOT"' 0 1 2 15

mkdir -p "$TEMP_ROOT/music" "$TEMP_ROOT/data" "$TEMP_ROOT/cache" "$TEMP_ROOT/inbox" "$TEMP_ROOT/delivery" "$TEMP_ROOT/secrets"
printf '%s\n' 'owner:a-strong-test-password' >"$TEMP_ROOT/secrets/web-auth"
chmod 600 "$TEMP_ROOT/secrets/web-auth"
ENV_FILE="$TEMP_ROOT/fnos.env"
cat >"$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=cocean-test
COCEAN_REGISTRY=example.invalid
COCEAN_IMAGE_NAMESPACE=test/cocean
COCEAN_VERSION=0.1.0
PUID=1000
PGID=1000
COCEAN_MUSIC_DIR=$TEMP_ROOT/music
COCEAN_DATA_DIR=$TEMP_ROOT/data
COCEAN_CACHE_DIR=$TEMP_ROOT/cache
COCEAN_INBOX_DIR=$TEMP_ROOT/inbox
COCEAN_DELIVERY_DIR=$TEMP_ROOT/delivery
COCEAN_WEB_AUTH_FILE=$TEMP_ROOT/secrets/web-auth
COCEAN_HTTP_BIND=0.0.0.0
COCEAN_HTTP_PORT=61998
PYTHON_IMAGE=python:3.13-alpine
EOF
: >"$TEMP_ROOT/data/cocean.sqlite"

LOG_FILE="$TEMP_ROOT/docker-calls.log"
OUTPUT_FILE="$TEMP_ROOT/output.log"
if PATH="$FIXTURES:$PATH" \
   COCEAN_DOCKER_BIN="$FIXTURES/fake-docker.sh" \
   FAKE_DOCKER_LOG="$LOG_FILE" \
   FAKE_COMPOSE_UP_FAIL=1 \
   sh "$RUNNER" --env-file "$ENV_FILE" --compose-file "$COMPOSE" \
     >"$OUTPUT_FILE" 2>&1; then
  printf 'total runner did not propagate the deployment failure\n' >&2
  exit 1
fi

grep -q 'music-manifest snapshot' "$LOG_FILE"
grep -q -- '--hash sha256' "$LOG_FILE"
grep -q 'db-maintenance create pre-upgrade-' "$LOG_FILE"
grep -q 'db-maintenance verify pre-upgrade-' "$LOG_FILE"
grep -q 'music-manifest verify' "$LOG_FILE"
grep -q ' stop web worker server' "$LOG_FILE"
grep -q 'Music sha256 manifest is unchanged' "$OUTPUT_FILE"
grep -q 'verified pre-upgrade database backup retained' "$OUTPUT_FILE"
if grep -F "$TEMP_ROOT" "$OUTPUT_FILE" >/dev/null; then
  printf 'total runner leaked a host path\n' >&2
  exit 1
fi

BACKUP_FAILURE_LOG="$TEMP_ROOT/backup-failure-calls.log"
if PATH="$FIXTURES:$PATH" \
   COCEAN_DOCKER_BIN="$FIXTURES/fake-docker.sh" \
   FAKE_DOCKER_LOG="$BACKUP_FAILURE_LOG" \
   FAKE_BACKUP_CREATE_FAIL=1 \
   sh "$RUNNER" --env-file "$ENV_FILE" --compose-file "$COMPOSE" \
     >/dev/null 2>&1; then
  printf 'total runner accepted a failed pre-migration backup\n' >&2
  exit 1
fi
grep -q 'music-manifest verify' "$BACKUP_FAILURE_LOG"
if grep -q ' up ' "$BACKUP_FAILURE_LOG"; then
  printf 'total runner deployed after a failed pre-migration backup\n' >&2
  exit 1
fi

printf 'acceptance finalize mock test: PASS\n'
