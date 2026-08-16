#!/bin/sh
# One command: preflight -> immutable baseline -> deploy -> inspect -> API -> verify.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd -P)
COMPOSE_FILE="$REPO_ROOT/infra/compose/fnos/compose.yaml"
ENV_FILE="$REPO_ROOT/infra/compose/fnos/.env"
DEPLOY_MODE=existing
WAIT_TIMEOUT=300
DOCKER_BIN=${COCEAN_DOCKER_BIN:-docker}
BASELINE_READY=0
BASELINE_HASH=""
BASELINE_FILE=""
FINALIZED=0
MANIFEST_HASH=sha256
BACKUP_READY=0
BACKUP_ID=""
DEPLOYMENT_STARTED=0
ACCEPTANCE_SESSION_CLEANUP=0
ACCEPTANCE_COOKIE_FILE=""

usage() {
  cat <<'EOF'
Usage: fnos_acceptance.sh [options]

Options:
  --env-file FILE       FNOS deployment environment (default compose/fnos/.env)
  --compose-file FILE   Compose entrypoint
  --deploy-mode MODE    existing, pull, or build (default existing)
  --wait-timeout SEC    Compose health wait timeout (default 300)

Successful deployments remain running. A failed deployment is stopped after
diagnostics are preserved. Once a baseline exists, Music verification runs on
every exit path, including API failure and signals. Existing databases receive
a verified online backup before migration. No host path or credential is printed.
EOF
}

fail_now() {
  code=$1
  shift
  printf 'fnos-acceptance: FAIL: %s\n' "$*" >&2
  exit "$code"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) [ "$#" -ge 2 ] || fail_now 64 "missing --env-file value"; ENV_FILE=$2; shift 2 ;;
    --compose-file) [ "$#" -ge 2 ] || fail_now 64 "missing --compose-file value"; COMPOSE_FILE=$2; shift 2 ;;
    --deploy-mode) [ "$#" -ge 2 ] || fail_now 64 "missing --deploy-mode value"; DEPLOY_MODE=$2; shift 2 ;;
    --wait-timeout) [ "$#" -ge 2 ] || fail_now 64 "missing --wait-timeout value"; WAIT_TIMEOUT=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail_now 64 "unknown option" ;;
  esac
done

case "$DEPLOY_MODE" in existing|pull|build) ;; *) fail_now 64 "deploy mode must be existing, pull, or build" ;; esac
case "$WAIT_TIMEOUT" in *[!0-9]*|'') fail_now 64 "wait timeout must be a positive integer" ;; esac
[ "$WAIT_TIMEOUT" -gt 0 ] || fail_now 64 "wait timeout must be a positive integer"

env_value() {
  awk -v wanted="$1" '
    /^[[:space:]]*#/ { next }
    index($0, "=") == 0 { next }
    {
      key = substr($0, 1, index($0, "=") - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key == wanted) { value = substr($0, index($0, "=") + 1); sub(/\r$/, "", value); print value; exit }
    }
  ' "$ENV_FILE"
}

compose() {
  "$DOCKER_BIN" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

digest_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 69
  fi
}

finalize() {
  incoming=$1
  result=$incoming
  [ "$FINALIZED" -eq 0 ] || return "$result"
  FINALIZED=1
  if [ "$ACCEPTANCE_SESSION_CLEANUP" -eq 1 ]; then
    if compose --profile maintenance run --rm --no-deps acceptance-session revoke \
      >/dev/null 2>&1; then
      ACCEPTANCE_SESSION_CLEANUP=0
    else
      printf 'fnos-acceptance: FAIL: temporary acceptance session could not be revoked\n' >&2
      [ "$result" -ne 0 ] || result=1
    fi
  fi
  if [ "$BASELINE_READY" -eq 1 ]; then
    current_hash=$(digest_file "$BASELINE_FILE" 2>/dev/null || true)
    if [ -z "$current_hash" ] || [ "$current_hash" != "$BASELINE_HASH" ]; then
      printf 'fnos-acceptance: FAIL: baseline manifest integrity changed\n' >&2
      [ "$result" -ne 0 ] || result=1
    fi
    if compose --profile acceptance run --rm --no-deps music-manifest \
      verify --root /library/music \
      --baseline /var/lib/cocean/acceptance/music-before.jsonl \
      --output /var/lib/cocean/acceptance/music-after.jsonl \
      >/dev/null 2>&1; then
      printf 'fnos-acceptance: OK: Music %s manifest is unchanged\n' "$MANIFEST_HASH"
    else
      verify_status=$?
      printf 'fnos-acceptance: FAIL: Music %s manifest verification failed\n' "$MANIFEST_HASH" >&2
      [ "$result" -ne 0 ] || result=$verify_status
    fi
    final_hash=$(digest_file "$BASELINE_FILE" 2>/dev/null || true)
    if [ -z "$final_hash" ] || [ "$final_hash" != "$BASELINE_HASH" ]; then
      printf 'fnos-acceptance: FAIL: baseline manifest integrity changed during verification\n' >&2
      [ "$result" -ne 0 ] || result=1
    fi
  fi
  if [ "$result" -ne 0 ] && [ "$DEPLOYMENT_STARTED" -eq 1 ]; then
    if compose stop web worker server >/dev/null 2>&1; then
      printf 'fnos-acceptance: OK: failed deployment was stopped to prevent further writes\n'
    else
      printf 'fnos-acceptance: WARN: failed deployment could not be stopped automatically\n' >&2
    fi
  fi
  if [ "$result" -eq 0 ]; then
    printf 'fnos-acceptance: PASS\n'
  else
    if [ "$BACKUP_READY" -eq 1 ]; then
      printf 'fnos-acceptance: FAILED (verified pre-upgrade database backup retained)\n' >&2
    else
      printf 'fnos-acceptance: FAILED\n' >&2
    fi
  fi
  return "$result"
}

on_exit() {
  incoming=$?
  trap - 0 1 2 15
  finalize "$incoming"
  final_status=$?
  exit "$final_status"
}

trap on_exit 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

printf 'fnos-acceptance: stage 1/8 preflight\n'
if ! COCEAN_DOCKER_BIN="$DOCKER_BIN" sh "$SCRIPT_DIR/fnos_preflight.sh" \
  --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE"; then
  fail_now 1 "preflight did not pass; no baseline or deployment was started"
fi

data_dir=$(env_value COCEAN_DATA_DIR)
[ -n "$data_dir" ] || fail_now 64 "COCEAN_DATA_DIR is unavailable"
configured_manifest_hash=$(env_value COCEAN_ACCEPTANCE_MANIFEST_HASH)
[ -z "$configured_manifest_hash" ] || MANIFEST_HASH=$configured_manifest_hash
case "$MANIFEST_HASH" in
  sha256|none) ;;
  *) fail_now 64 "COCEAN_ACCEPTANCE_MANIFEST_HASH must be sha256 or none" ;;
esac
BASELINE_FILE="${data_dir%/}/acceptance/music-before.jsonl"
ACCEPTANCE_COOKIE_FILE="${data_dir%/}/acceptance/admin-session-cookie"
digest_file "$ENV_FILE" >/dev/null 2>&1 || fail_now 69 "a SHA-256 utility is required"

printf 'fnos-acceptance: stage 2/8 prepare immutable application images\n'
case "$DEPLOY_MODE" in
  build)
    compose build web server worker >/dev/null 2>&1 || fail_now 1 "image build failed"
    ;;
  pull)
    compose pull web server worker >/dev/null 2>&1 || fail_now 1 "image pull failed"
    ;;
  existing) ;;
esac

printf 'fnos-acceptance: stage 3/8 capture read-only Music baseline\n'
if ! compose --profile acceptance run --rm --no-deps music-manifest \
  snapshot --root /library/music \
  --output /var/lib/cocean/acceptance/music-before.jsonl \
  --hash "$MANIFEST_HASH" \
  >/dev/null 2>&1; then
  fail_now 1 "Music baseline could not be created"
fi
[ -f "$BASELINE_FILE" ] || fail_now 1 "Music baseline output is absent"
BASELINE_HASH=$(digest_file "$BASELINE_FILE") || fail_now 69 "Music baseline cannot be hashed"
[ -n "$BASELINE_HASH" ] || fail_now 1 "Music baseline hash is empty"
BASELINE_READY=1

printf 'fnos-acceptance: stage 4/8 create verified pre-migration database backup\n'
if [ -f "${data_dir%/}/cocean.sqlite" ]; then
  BACKUP_ID="pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  if ! compose --profile maintenance run --rm --no-deps db-maintenance \
    create "$BACKUP_ID" >/dev/null 2>&1; then
    fail_now 1 "existing SQLite database could not be backed up"
  fi
  if ! compose --profile maintenance run --rm --no-deps db-maintenance \
    verify "$BACKUP_ID" >/dev/null 2>&1; then
    fail_now 1 "pre-upgrade SQLite backup did not verify"
  fi
  BACKUP_READY=1
  printf 'fnos-acceptance: OK: verified pre-upgrade database backup created\n'
else
  printf 'fnos-acceptance: OK: initial install has no database to back up\n'
fi

printf 'fnos-acceptance: stage 5/8 deploy and wait for health\n'
DEPLOYMENT_STARTED=1
compose up -d --no-build --wait --wait-timeout "$WAIT_TIMEOUT" web worker >/dev/null 2>&1 || \
  fail_now 1 "Compose deploy/health wait failed"

printf 'fnos-acceptance: stage 6/8 inspect effective runtime boundaries\n'
if ! COCEAN_DOCKER_BIN="$DOCKER_BIN" sh "$SCRIPT_DIR/fnos_runtime_inspect.sh" \
  --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE"; then
  fail_now 1 "runtime boundary inspection failed"
fi

printf 'fnos-acceptance: stage 7/8 acquire scan evidence and verify every API surface\n'
ACCEPTANCE_SESSION_CLEANUP=1
if ! compose --profile maintenance run --rm --no-deps acceptance-session revoke \
  >/dev/null 2>&1; then
  fail_now 1 "stale temporary ADMIN acceptance session could not be cleaned"
fi
if ! compose --profile maintenance run --rm --no-deps acceptance-session issue \
  >/dev/null 2>&1; then
  fail_now 1 "temporary ADMIN acceptance session could not be issued"
fi
[ -f "$ACCEPTANCE_COOKIE_FILE" ] || fail_now 1 "temporary acceptance Cookie file is absent"
if ! compose --profile acceptance run --rm --no-deps acceptance-api; then
  fail_now 1 "full-library API acceptance failed"
fi
if ! compose --profile maintenance run --rm --no-deps acceptance-session revoke \
  >/dev/null 2>&1; then
  fail_now 1 "temporary ADMIN acceptance session could not be revoked"
fi
ACCEPTANCE_SESSION_CLEANUP=0
[ ! -e "$ACCEPTANCE_COOKIE_FILE" ] || fail_now 1 "temporary acceptance Cookie file survived revocation"

printf 'fnos-acceptance: stage 8/8 verify Music manifest on exit\n'
exit 0
