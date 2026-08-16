#!/bin/sh

set -eu

TEST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$TEST_DIR/../.." && pwd -P)
FIXTURES="$TEST_DIR/fixtures"
RUNNER="$REPO_ROOT/infra/scripts/fnos_acceptance.sh"
COMPOSE="$REPO_ROOT/infra/compose/fnos/compose.yaml"
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/cocean-acceptance-test.XXXXXX")
trap 'rm -rf "$TEMP_ROOT"' 0 1 2 15

mkdir -p "$TEMP_ROOT/music" "$TEMP_ROOT/quarantine" "$TEMP_ROOT/data" "$TEMP_ROOT/cache" "$TEMP_ROOT/inbox" "$TEMP_ROOT/delivery" "$TEMP_ROOT/secrets"
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
COCEAN_QUARANTINE_DIR=$TEMP_ROOT/quarantine
COCEAN_MUSIC_ROOT_POLICY=WATCH_ONLY
COCEAN_MUSIC_READ_ONLY=true
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

SUCCESS_LOG="$TEMP_ROOT/success-calls.log"
if ! PATH="$FIXTURES:$PATH" \
   COCEAN_DOCKER_BIN="$FIXTURES/fake-docker.sh" \
   FAKE_DOCKER_LOG="$SUCCESS_LOG" \
   sh "$RUNNER" --env-file "$ENV_FILE" --compose-file "$COMPOSE" \
     >"$OUTPUT_FILE" 2>&1; then
  printf 'total runner did not complete the success path\n' >&2
  exit 1
fi
grep -q 'acceptance-session issue' "$SUCCESS_LOG"
grep -q ' acceptance-api' "$SUCCESS_LOG"
grep -q '^acceptance-api-cookie-ready mode=600$' "$SUCCESS_LOG"
grep -q 'acceptance-session revoke' "$SUCCESS_LOG"
[ ! -e "$TEMP_ROOT/data/acceptance/admin-session-cookie" ] || {
  printf 'success path retained the temporary acceptance Cookie\n' >&2
  exit 1
}
grep -q 'fnos-acceptance: PASS' "$OUTPUT_FILE"
if grep -F 'cocean_session=' "$SUCCESS_LOG" "$OUTPUT_FILE" >/dev/null; then
  printf 'success path leaked the raw acceptance Cookie\n' >&2
  exit 1
fi

API_FAILURE_LOG="$TEMP_ROOT/api-failure-calls.log"
if PATH="$FIXTURES:$PATH" \
   COCEAN_DOCKER_BIN="$FIXTURES/fake-docker.sh" \
   FAKE_DOCKER_LOG="$API_FAILURE_LOG" \
   FAKE_API_ACCEPTANCE_FAIL=1 \
   sh "$RUNNER" --env-file "$ENV_FILE" --compose-file "$COMPOSE" \
     >/dev/null 2>&1; then
  printf 'total runner accepted an API Gate failure\n' >&2
  exit 1
fi
grep -q 'acceptance-session issue' "$API_FAILURE_LOG"
grep -q '^acceptance-api-cookie-ready mode=600$' "$API_FAILURE_LOG"
grep -q 'acceptance-session revoke' "$API_FAILURE_LOG"
[ ! -e "$TEMP_ROOT/data/acceptance/admin-session-cookie" ] || {
  printf 'API failure retained the temporary acceptance Cookie\n' >&2
  exit 1
}

ISSUE_FAILURE_LOG="$TEMP_ROOT/issue-failure-calls.log"
if PATH="$FIXTURES:$PATH" \
   COCEAN_DOCKER_BIN="$FIXTURES/fake-docker.sh" \
   FAKE_DOCKER_LOG="$ISSUE_FAILURE_LOG" \
   FAKE_SESSION_ISSUE_FAIL=1 \
   sh "$RUNNER" --env-file "$ENV_FILE" --compose-file "$COMPOSE" \
     >/dev/null 2>&1; then
  printf 'total runner accepted an acceptance Session issue failure\n' >&2
  exit 1
fi
[ "$(grep -c 'acceptance-session revoke' "$ISSUE_FAILURE_LOG")" -eq 2 ]
[ ! -e "$TEMP_ROOT/data/acceptance/admin-session-cookie" ] || {
  printf 'issue failure retained the temporary acceptance Cookie\n' >&2
  exit 1
}

ISSUE_SIGNAL_LOG="$TEMP_ROOT/issue-signal-calls.log"
if PATH="$FIXTURES:$PATH" \
   COCEAN_DOCKER_BIN="$FIXTURES/fake-docker.sh" \
   FAKE_DOCKER_LOG="$ISSUE_SIGNAL_LOG" \
   FAKE_SESSION_ISSUE_SIGNAL=1 \
   sh "$RUNNER" --env-file "$ENV_FILE" --compose-file "$COMPOSE" \
     >/dev/null 2>&1; then
  printf 'total runner accepted a signal during Session issue\n' >&2
  exit 1
fi
[ "$(grep -c 'acceptance-session revoke' "$ISSUE_SIGNAL_LOG")" -eq 2 ]
[ ! -e "$TEMP_ROOT/data/acceptance/admin-session-cookie" ] || {
  printf 'issue signal retained the temporary acceptance Cookie\n' >&2
  exit 1
}

REVOKE_RETRY_LOG="$TEMP_ROOT/revoke-retry-calls.log"
if PATH="$FIXTURES:$PATH" \
   COCEAN_DOCKER_BIN="$FIXTURES/fake-docker.sh" \
   FAKE_DOCKER_LOG="$REVOKE_RETRY_LOG" \
   FAKE_SESSION_REVOKE_FAIL_AT=2 \
   sh "$RUNNER" --env-file "$ENV_FILE" --compose-file "$COMPOSE" \
     >/dev/null 2>&1; then
  printf 'total runner ignored an initial Session cleanup failure\n' >&2
  exit 1
fi
[ "$(grep -c 'acceptance-session revoke' "$REVOKE_RETRY_LOG")" -eq 3 ]
grep -q ' acceptance-api' "$REVOKE_RETRY_LOG"
[ ! -e "$TEMP_ROOT/data/acceptance/admin-session-cookie" ] || {
  printf 'finalizer retry did not clean the temporary acceptance Cookie\n' >&2
  exit 1
}

REVOKE_FAILURE_LOG="$TEMP_ROOT/revoke-failure-calls.log"
if PATH="$FIXTURES:$PATH" \
   COCEAN_DOCKER_BIN="$FIXTURES/fake-docker.sh" \
   FAKE_DOCKER_LOG="$REVOKE_FAILURE_LOG" \
   FAKE_SESSION_REVOKE_FAIL_FROM=2 \
   sh "$RUNNER" --env-file "$ENV_FILE" --compose-file "$COMPOSE" \
     >/dev/null 2>&1; then
  printf 'total runner accepted repeated Session cleanup failures\n' >&2
  exit 1
fi
[ "$(grep -c 'acceptance-session revoke' "$REVOKE_FAILURE_LOG")" -eq 3 ]
grep -q ' acceptance-api' "$REVOKE_FAILURE_LOG"
[ -e "$TEMP_ROOT/data/acceptance/admin-session-cookie" ] || {
  printf 'repeated failing revoke was not exercised against Session state\n' >&2
  exit 1
}
rm -f "$TEMP_ROOT/data/acceptance/admin-session-cookie"

SIGNAL_LOG="$TEMP_ROOT/signal-calls.log"
if PATH="$FIXTURES:$PATH" \
   COCEAN_DOCKER_BIN="$FIXTURES/fake-docker.sh" \
   FAKE_DOCKER_LOG="$SIGNAL_LOG" \
   FAKE_API_ACCEPTANCE_SIGNAL=1 \
   sh "$RUNNER" --env-file "$ENV_FILE" --compose-file "$COMPOSE" \
     >/dev/null 2>&1; then
  printf 'total runner accepted an interrupted API Gate\n' >&2
  exit 1
fi
grep -q 'acceptance-session issue' "$SIGNAL_LOG"
grep -q '^acceptance-api-cookie-ready mode=600$' "$SIGNAL_LOG"
grep -q 'acceptance-session revoke' "$SIGNAL_LOG"
[ ! -e "$TEMP_ROOT/data/acceptance/admin-session-cookie" ] || {
  printf 'signal exit retained the temporary acceptance Cookie\n' >&2
  exit 1
}

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

if grep -F 'cocean_session=' "$TEMP_ROOT"/*-calls.log >/dev/null; then
  printf 'acceptance invocation log leaked a raw Cookie\n' >&2
  exit 1
fi

printf 'acceptance finalize mock test: PASS\n'
