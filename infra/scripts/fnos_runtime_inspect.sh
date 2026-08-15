#!/bin/sh
# Inspect the effective runtime boundaries without dumping environment values.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd -P)
COMPOSE_FILE="$REPO_ROOT/infra/compose/fnos/compose.yaml"
ENV_FILE="$REPO_ROOT/infra/compose/fnos/.env"
DOCKER_BIN=${COCEAN_DOCKER_BIN:-docker}

usage() {
  cat <<'EOF'
Usage: fnos_runtime_inspect.sh [--env-file FILE] [--compose-file FILE]

Checks running health, non-root/read-only roots, dropped capabilities,
read-only Music mounts, memory ceilings, network segmentation and Worker ffprobe.
EOF
}

fail() {
  printf 'runtime-inspect: FAIL: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) [ "$#" -ge 2 ] || fail "missing --env-file value"; ENV_FILE=$2; shift 2 ;;
    --compose-file) [ "$#" -ge 2 ] || fail "missing --compose-file value"; COMPOSE_FILE=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option" ;;
  esac
done

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

expected_user="$(env_value PUID):$(env_value PGID)"
[ "$expected_user" != ":" ] || fail "PUID/PGID are unavailable"

container_id() {
  compose ps -q "$1" 2>/dev/null | awk 'NF {print; exit}'
}

inspect_value() {
  "$DOCKER_BIN" inspect --format "$1" "$2" 2>/dev/null
}

memory_bytes() {
  value=$1
  case "$value" in
    *[kK]) number=${value%?}; multiplier=1024 ;;
    *[mM]) number=${value%?}; multiplier=1048576 ;;
    *[gG]) number=${value%?}; multiplier=1073741824 ;;
    *) number=$value; multiplier=1 ;;
  esac
  case "$number" in
    ''|*[!0-9]*) fail "memory ceiling must be an integer with optional k/m/g suffix" ;;
  esac
  [ "$number" -gt 0 ] || fail "memory ceiling must be greater than zero"
  awk -v number="$number" -v multiplier="$multiplier" \
    'BEGIN { printf "%.0f", number * multiplier }'
}

for service in web server worker; do
  id=$(container_id "$service")
  [ -n "$id" ] || fail "$service container is absent"
  running=$(inspect_value '{{.State.Running}}' "$id") || fail "$service cannot be inspected"
  health=$(inspect_value '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$id") || fail "$service health cannot be inspected"
  rootfs=$(inspect_value '{{.HostConfig.ReadonlyRootfs}}' "$id") || fail "$service root filesystem cannot be inspected"
  user=$(inspect_value '{{.Config.User}}' "$id") || fail "$service user cannot be inspected"
  caps=$(inspect_value '{{json .HostConfig.CapDrop}}' "$id") || fail "$service capabilities cannot be inspected"
  security=$(inspect_value '{{json .HostConfig.SecurityOpt}}' "$id") || fail "$service security options cannot be inspected"
  [ "$running" = true ] || fail "$service is not running"
  [ "$health" = healthy ] || fail "$service is not healthy"
  [ "$rootfs" = true ] || fail "$service root filesystem is writable"
  [ "$user" = "$expected_user" ] || fail "$service does not use configured PUID/PGID"
  printf '%s' "$caps" | grep -q 'ALL' || fail "$service did not drop all capabilities"
  printf '%s' "$security" | grep -q 'no-new-privileges' || fail "$service lacks no-new-privileges"
done

for memory_contract in \
  "web:COCEAN_WEB_MEMORY_LIMIT:256m" \
  "server:COCEAN_SERVER_MEMORY_LIMIT:768m" \
  "worker:COCEAN_WORKER_MEMORY_LIMIT:2g"
do
  service=${memory_contract%%:*}
  remainder=${memory_contract#*:}
  variable=${remainder%%:*}
  fallback=${remainder#*:}
  configured=$(env_value "$variable")
  [ -n "$configured" ] || configured=$fallback
  expected_memory=$(memory_bytes "$configured")
  id=$(container_id "$service")
  actual_memory=$(inspect_value '{{.HostConfig.Memory}}' "$id") || \
    fail "$service memory ceiling cannot be inspected"
  [ "$actual_memory" = "$expected_memory" ] || \
    fail "$service memory ceiling does not match $variable"
done

music_root_policy=$(env_value COCEAN_MUSIC_ROOT_POLICY)
[ -n "$music_root_policy" ] || music_root_policy=WATCH_ONLY
server_id=$(container_id server)
server_music_rw=$(inspect_value '{{range .Mounts}}{{if eq .Destination "/library/music"}}{{.RW}}{{end}}{{end}}' "$server_id") || \
  fail "server Music mount cannot be inspected"
[ "$server_music_rw" = false ] || fail "server Music mount is absent or writable"
worker_id=$(container_id worker)
worker_music_rw=$(inspect_value '{{range .Mounts}}{{if eq .Destination "/library/music"}}{{.RW}}{{end}}{{end}}' "$worker_id") || \
  fail "worker Music mount cannot be inspected"
if [ "$music_root_policy" = MANAGED ]; then
  [ "$worker_music_rw" = true ] || fail "worker Music mount is absent or read-only for MANAGED policy"
else
  [ "$worker_music_rw" = false ] || fail "worker Music mount is absent or writable for WATCH_ONLY policy"
fi

server_networks=$(inspect_value '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$server_id") || \
  fail "Server networks cannot be inspected"
worker_networks=$(inspect_value '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$worker_id") || \
  fail "Worker networks cannot be inspected"
printf '%s' "$server_networks" | grep -Eq '(^|[[:space:]])[^[:space:]]*_egress([[:space:]]|$)' || \
  fail "Server is missing its metadata egress network"
if printf '%s' "$worker_networks" | grep -Eq '(^|[[:space:]])[^[:space:]]*_egress([[:space:]]|$)'; then
  fail "Worker unexpectedly has egress network access"
fi

ffprobe_path=$(env_value COCEAN_FFPROBE_PATH)
[ -n "$ffprobe_path" ] || ffprobe_path=/usr/bin/ffprobe
if ! "$DOCKER_BIN" exec "$worker_id" "$ffprobe_path" -version >/dev/null 2>&1; then
  fail "Worker ffprobe is unavailable"
fi

provider_id=$(compose --profile providers ps -aq provider-qobuz 2>/dev/null | awk 'NF {print; exit}')
[ -z "$provider_id" ] || fail "disabled Qobuz Provider has a container"

printf 'runtime-inspect: PASS (3 healthy bounded core services; Music read-only; Provider absent)\n'
