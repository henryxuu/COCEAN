#!/bin/sh

set -eu

TEST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$TEST_DIR/../.." && pwd -P)
FIXTURES="$TEST_DIR/fixtures"
PREFLIGHT="$REPO_ROOT/infra/scripts/fnos_preflight.sh"
COMPOSE="$REPO_ROOT/infra/compose/fnos/compose.yaml"
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/cocean-preflight-test.XXXXXX")
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
COCEAN_HTTP_PORT=61999
COCEAN_SCAN_EXCLUDE_DIRS=[]
COCEAN_ACCEPTANCE_EXISTING_SCAN_ID=
COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS={}
PYTHON_IMAGE=python:3.13-alpine
EOF

run_preflight() {
  PATH="$FIXTURES:$PATH" \
  COCEAN_DOCKER_BIN="$FIXTURES/fake-docker.sh" \
  sh "$PREFLIGHT" --env-file "$1" --compose-file "$COMPOSE"
}

output=$(run_preflight "$ENV_FILE" 2>&1)
printf '%s' "$output" | grep -q 'preflight: PASS'
if printf '%s' "$output" | grep -F "$TEMP_ROOT" >/dev/null; then
  printf 'preflight test leaked a host path\n' >&2
  exit 1
fi

BAD_UID="$TEMP_ROOT/bad-uid.env"
sed 's/^PUID=1000$/PUID=0/' "$ENV_FILE" >"$BAD_UID"
if run_preflight "$BAD_UID" >/dev/null 2>&1; then
  printf 'preflight accepted root PUID\n' >&2
  exit 1
fi

BAD_MANAGED="$TEMP_ROOT/bad-managed.env"
sed 's/^COCEAN_MUSIC_ROOT_POLICY=WATCH_ONLY$/COCEAN_MUSIC_ROOT_POLICY=MANAGED/' "$ENV_FILE" >"$BAD_MANAGED"
if run_preflight "$BAD_MANAGED" >/dev/null 2>&1; then
  printf 'preflight accepted MANAGED with a read-only Music mount\n' >&2
  exit 1
fi

VALID_MANAGED="$TEMP_ROOT/valid-managed.env"
sed -e 's/^COCEAN_MUSIC_ROOT_POLICY=WATCH_ONLY$/COCEAN_MUSIC_ROOT_POLICY=MANAGED/' \
  -e 's/^COCEAN_MUSIC_READ_ONLY=true$/COCEAN_MUSIC_READ_ONLY=false/' \
  "$ENV_FILE" >"$VALID_MANAGED"
PROBE_LOG="$TEMP_ROOT/docker-run.log"
FAKE_DOCKER_LOG="$PROBE_LOG" run_preflight "$VALID_MANAGED" >/dev/null
grep -F '.cocean-managed-preflight-' "$PROBE_LOG" >/dev/null || {
  printf 'preflight skipped the MANAGED Music write probe\n' >&2
  exit 1
}
if FAKE_MANAGED_PROBE_FAIL=1 run_preflight "$VALID_MANAGED" >/dev/null 2>&1; then
  printf 'preflight accepted a failed MANAGED Music write probe\n' >&2
  exit 1
fi

PLACEHOLDER="$TEMP_ROOT/placeholder.env"
sed 's#^COCEAN_IMAGE_NAMESPACE=.*#COCEAN_IMAGE_NAMESPACE=replace-with-owner/cocean#' "$ENV_FILE" >"$PLACEHOLDER"
if run_preflight "$PLACEHOLDER" >/dev/null 2>&1; then
  printf 'preflight accepted a placeholder\n' >&2
  exit 1
fi

EDGE="$TEMP_ROOT/edge.env"
sed 's/^COCEAN_VERSION=0.1.0$/COCEAN_VERSION=edge/' "$ENV_FILE" >"$EDGE"
if run_preflight "$EDGE" >/dev/null 2>&1; then
  printf 'preflight accepted the edge image tag\n' >&2
  exit 1
fi

MISSING_AUTH="$TEMP_ROOT/missing-auth.env"
sed "s#^COCEAN_WEB_AUTH_FILE=.*#COCEAN_WEB_AUTH_FILE=$TEMP_ROOT/secrets/missing#" "$ENV_FILE" >"$MISSING_AUTH"
if run_preflight "$MISSING_AUTH" >/dev/null 2>&1; then
  printf 'preflight accepted a missing Web authentication secret\n' >&2
  exit 1
fi

printf '%s\n' 'owner:short' >"$TEMP_ROOT/secrets/weak-auth"
WEAK_AUTH="$TEMP_ROOT/weak-auth.env"
sed "s#^COCEAN_WEB_AUTH_FILE=.*#COCEAN_WEB_AUTH_FILE=$TEMP_ROOT/secrets/weak-auth#" "$ENV_FILE" >"$WEAK_AUTH"
if run_preflight "$WEAK_AUTH" >/dev/null 2>&1; then
  printf 'preflight accepted a weak Web authentication secret\n' >&2
  exit 1
fi

printf '%s\n' 'owner:another-strong-password' >"$TEMP_ROOT/data/web-auth"
NESTED_AUTH="$TEMP_ROOT/nested-auth.env"
sed "s#^COCEAN_WEB_AUTH_FILE=.*#COCEAN_WEB_AUTH_FILE=$TEMP_ROOT/data/web-auth#" "$ENV_FILE" >"$NESTED_AUTH"
if run_preflight "$NESTED_AUTH" >/dev/null 2>&1; then
  printf 'preflight accepted a Web authentication secret inside application data\n' >&2
  exit 1
fi

if FAKE_FSTYPE=nfs run_preflight "$ENV_FILE" >/dev/null 2>&1; then
  printf 'preflight accepted network data storage\n' >&2
  exit 1
fi
unset FAKE_FSTYPE

if FAKE_COMPOSE_VERSION=2.19.9 run_preflight "$ENV_FILE" >/dev/null 2>&1; then
  printf 'preflight accepted old Compose\n' >&2
  exit 1
fi
unset FAKE_COMPOSE_VERSION

mkdir -p "$TEMP_ROOT/music/RoonBackups"
VALID_EXCLUDE="$TEMP_ROOT/valid-exclude.env"
sed 's#^COCEAN_SCAN_EXCLUDE_DIRS=.*#COCEAN_SCAN_EXCLUDE_DIRS=["RoonBackups"]#' "$ENV_FILE" >"$VALID_EXCLUDE"
run_preflight "$VALID_EXCLUDE" >/dev/null

BAD_EXCLUDE="$TEMP_ROOT/bad-exclude.env"
sed 's#^COCEAN_SCAN_EXCLUDE_DIRS=.*#COCEAN_SCAN_EXCLUDE_DIRS=["../escape"]#' "$ENV_FILE" >"$BAD_EXCLUDE"
if run_preflight "$BAD_EXCLUDE" >/dev/null 2>&1; then
  printf 'preflight accepted an unsafe scan exclusion\n' >&2
  exit 1
fi

VALID_UNSUPPORTED="$TEMP_ROOT/valid-unsupported.env"
sed 's#^COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS=.*#COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS={".iso":220}#' "$ENV_FILE" >"$VALID_UNSUPPORTED"
run_preflight "$VALID_UNSUPPORTED" >/dev/null

VALID_DISC_VIDEO="$TEMP_ROOT/valid-disc-video.env"
sed 's#^COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS=.*#COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS={".aob":2,".vob":7}#' "$ENV_FILE" >"$VALID_DISC_VIDEO"
run_preflight "$VALID_DISC_VIDEO" >/dev/null

BAD_UNSUPPORTED="$TEMP_ROOT/bad-unsupported.env"
sed 's#^COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS=.*#COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS={"iso":220}#' "$ENV_FILE" >"$BAD_UNSUPPORTED"
if run_preflight "$BAD_UNSUPPORTED" >/dev/null 2>&1; then
  printf 'preflight accepted an unsafe unsupported-extension policy\n' >&2
  exit 1
fi

BAD_UNSUPPORTED_LIMIT="$TEMP_ROOT/bad-unsupported-limit.env"
sed 's#^COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS=.*#COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS={".iso":true}#' "$ENV_FILE" >"$BAD_UNSUPPORTED_LIMIT"
if run_preflight "$BAD_UNSUPPORTED_LIMIT" >/dev/null 2>&1; then
  printf 'preflight accepted a non-integer unsupported-extension limit\n' >&2
  exit 1
fi

VALID_SCAN_ID="$TEMP_ROOT/valid-scan-id.env"
sed 's/^COCEAN_ACCEPTANCE_EXISTING_SCAN_ID=$/COCEAN_ACCEPTANCE_EXISTING_SCAN_ID=018f761e-1472-7b32-a4f2-acde48001122/' "$ENV_FILE" >"$VALID_SCAN_ID"
run_preflight "$VALID_SCAN_ID" >/dev/null

BAD_SCAN_ID="$TEMP_ROOT/bad-scan-id.env"
sed 's#^COCEAN_ACCEPTANCE_EXISTING_SCAN_ID=$#COCEAN_ACCEPTANCE_EXISTING_SCAN_ID=../private#' "$ENV_FILE" >"$BAD_SCAN_ID"
if run_preflight "$BAD_SCAN_ID" >/dev/null 2>&1; then
  printf 'preflight accepted an unsafe existing scan identifier\n' >&2
  exit 1
fi

printf 'preflight mock tests: PASS\n'
