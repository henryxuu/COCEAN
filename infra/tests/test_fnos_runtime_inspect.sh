#!/bin/sh

set -eu

TEST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$TEST_DIR/../.." && pwd -P)
RUNTIME_INSPECT="$REPO_ROOT/infra/scripts/fnos_runtime_inspect.sh"
FAKE_DOCKER="$TEST_DIR/fixtures/fake-runtime-docker.sh"
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/cocean-runtime-inspect-test.XXXXXX")
trap 'rm -rf "$TEMP_ROOT"' 0 1 2 15

runtime_env() {
  policy=$1
  cat >"$TEMP_ROOT/runtime.env" <<EOF
PUID=1000
PGID=1000
COCEAN_MUSIC_ROOT_POLICY=$policy
COCEAN_WEB_MEMORY_LIMIT=256m
COCEAN_SERVER_MEMORY_LIMIT=768m
COCEAN_WORKER_MEMORY_LIMIT=2g
COCEAN_FFPROBE_PATH=/usr/bin/ffprobe
EOF
}

run_inspect() {
  COCEAN_DOCKER_BIN="$FAKE_DOCKER" \
    sh "$RUNTIME_INSPECT" --env-file "$TEMP_ROOT/runtime.env" \
      --compose-file "$REPO_ROOT/infra/compose/fnos/compose.yaml"
}

runtime_env WATCH_ONLY
FAKE_WORKER_MUSIC_RW=false run_inspect >/dev/null
if FAKE_WORKER_MUSIC_RW=true run_inspect >/dev/null 2>&1; then
  printf 'runtime inspect accepted writable WATCH_ONLY Worker Music\n' >&2
  exit 1
fi

runtime_env MANAGED
FAKE_WORKER_MUSIC_RW=true run_inspect >/dev/null
if FAKE_WORKER_MUSIC_RW=false run_inspect >/dev/null 2>&1; then
  printf 'runtime inspect accepted read-only MANAGED Worker Music\n' >&2
  exit 1
fi
if FAKE_SERVER_MUSIC_RW=true FAKE_WORKER_MUSIC_RW=true run_inspect >/dev/null 2>&1; then
  printf 'runtime inspect accepted writable Server Music\n' >&2
  exit 1
fi

printf 'FNOS runtime inspect policy mock: PASS\n'
