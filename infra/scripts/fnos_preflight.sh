#!/bin/sh
# Fail-closed host checks for a COCEAN FNOS deployment.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd -P)
COMPOSE_FILE="$REPO_ROOT/infra/compose/fnos/compose.yaml"
ENV_FILE="$REPO_ROOT/infra/compose/fnos/.env"
DOCKER_BIN=${COCEAN_DOCKER_BIN:-docker}

usage() {
  cat <<'EOF'
Usage: fnos_preflight.sh [--env-file FILE] [--compose-file FILE]

Checks Docker Compose, all Compose profiles, immutable image coordinates,
FNOS paths, local SQLite storage, port availability and PUID/PGID access.
Host paths and environment values are deliberately not printed.
EOF
}

fail() {
  code=$1
  shift
  printf 'preflight: FAIL: %s\n' "$*" >&2
  exit "$code"
}

ok() {
  printf 'preflight: OK: %s\n' "$*"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      [ "$#" -ge 2 ] || fail 64 "--env-file requires a value"
      ENV_FILE=$2
      shift 2
      ;;
    --compose-file)
      [ "$#" -ge 2 ] || fail 64 "--compose-file requires a value"
      COMPOSE_FILE=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fail 64 "unknown option" ;;
  esac
done

[ -r "$ENV_FILE" ] || fail 64 "environment file is missing or unreadable"
[ -r "$COMPOSE_FILE" ] || fail 64 "Compose file is missing or unreadable"
command -v "$DOCKER_BIN" >/dev/null 2>&1 || fail 69 "Docker CLI is unavailable"

env_value() {
  key=$1
  awk -v wanted="$key" '
    /^[[:space:]]*#/ { next }
    index($0, "=") == 0 { next }
    {
      candidate = substr($0, 1, index($0, "=") - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", candidate)
      if (candidate == wanted) {
        value = substr($0, index($0, "=") + 1)
        sub(/\r$/, "", value)
        print value
        exit
      }
    }
  ' "$ENV_FILE"
}

require_value() {
  key=$1
  value=$(env_value "$key")
  [ -n "$value" ] || fail 64 "$key is missing or empty"
  case "$value" in
    *'/replace/with/'*|*'replace-with-owner'*|*'<'*|*'>'*|*'${'*|*'$('*|*'`'*)
      fail 64 "$key still contains a placeholder or shell interpolation"
      ;;
  esac
  printf '%s\n' "$value"
}

compose() {
  "$DOCKER_BIN" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

version_raw=$("$DOCKER_BIN" compose version --short 2>/dev/null) || \
  fail 69 "Docker Compose v2 is unavailable"
version=$(printf '%s' "$version_raw" | sed 's/^[^0-9]*//; s/[^0-9.].*$//')
major=$(printf '%s' "$version" | awk -F. '{print $1 + 0}')
minor=$(printf '%s' "$version" | awk -F. '{print $2 + 0}')
if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 20 ]; }; then
  fail 69 "Docker Compose 2.20 or newer is required"
fi
ok "Docker Compose version is supported"

for profile in core acceptance maintenance providers; do
  case "$profile" in
    core) profile_args="" ;;
    acceptance) profile_args="--profile acceptance" ;;
    maintenance) profile_args="--profile maintenance" ;;
    providers) profile_args="--profile providers" ;;
  esac
  # shellcheck disable=SC2086
  if ! compose $profile_args config --quiet >/dev/null 2>&1; then
    fail 64 "$profile profile cannot be rendered by Docker Compose"
  fi
done
ok "core, acceptance, maintenance and providers profiles render successfully"

version_tag=$(require_value COCEAN_VERSION)
case $(printf '%s' "$version_tag" | tr '[:upper:]' '[:lower:]') in
  edge|latest|dev|development|main|master|snapshot)
    fail 64 "COCEAN_VERSION must be an immutable release tag"
    ;;
esac
require_value COCEAN_REGISTRY >/dev/null
require_value COCEAN_IMAGE_NAMESPACE >/dev/null

musicbrainz_enabled=$(env_value COCEAN_MUSICBRAINZ_ENABLED)
[ -n "$musicbrainz_enabled" ] || musicbrainz_enabled=false
case "$musicbrainz_enabled" in
  false) ;;
  true)
    require_value COCEAN_METADATA_CONTACT >/dev/null
    ;;
  *) fail 64 "COCEAN_MUSICBRAINZ_ENABLED must be true or false" ;;
esac
manifest_hash=$(env_value COCEAN_ACCEPTANCE_MANIFEST_HASH)
[ -n "$manifest_hash" ] || manifest_hash=sha256
case "$manifest_hash" in
  sha256|none) ;;
  *) fail 64 "COCEAN_ACCEPTANCE_MANIFEST_HASH must be sha256 or none" ;;
esac
allowed_unsupported=$(env_value COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS)
[ -n "$allowed_unsupported" ] || allowed_unsupported='{}'
existing_scan_id=$(env_value COCEAN_ACCEPTANCE_EXISTING_SCAN_ID)
command -v python3 >/dev/null 2>&1 || \
  fail 69 "Python 3 is required to validate acceptance policy"
if ! python3 - "$allowed_unsupported" "$existing_scan_id" >/dev/null 2>&1 <<'PY'
import json
import re
import sys

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result

try:
    decoded = json.loads(sys.argv[1], object_pairs_hook=unique_object)
except (json.JSONDecodeError, ValueError):
    raise SystemExit(1)
if not isinstance(decoded, dict) or len(decoded) > 128:
    raise SystemExit(1)
for extension, limit in decoded.items():
    known = {
        ".aa", ".aax", ".aob", ".au", ".caf", ".dts", ".dtshd", ".iso",
        ".mlp", ".oma", ".ra", ".rm", ".sacd", ".snd", ".thd", ".vob",
    }
    if not re.fullmatch(r"\.[a-z0-9]{1,16}", extension) or extension not in known:
        raise SystemExit(1)
    if (
        isinstance(limit, bool)
        or not isinstance(limit, int)
        or limit < 0
        or limit > 2_147_483_647
    ):
        raise SystemExit(1)
scan_id = sys.argv[2]
if scan_id and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", scan_id):
    raise SystemExit(1)
PY
then
  fail 64 "acceptance reuse or unsupported-extension policy is invalid"
fi
ok "acceptance scan reuse and unsupported-extension policy are valid"
if awk -F= '
  /^[[:space:]]*#/ { next }
  {
    key = $1
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
    if (key ~ /QOBUZ|COOKIE|TOKEN|PASSWORD|SECRET/) { found = 1; exit }
  }
  END { exit(found ? 0 : 1) }
' "$ENV_FILE"; then
  fail 64 "disabled Provider credentials must not be stored in the environment file"
fi

puid=$(require_value PUID)
pgid=$(require_value PGID)
case "$puid" in *[!0-9]*|'') fail 64 "PUID must be a positive integer" ;; esac
case "$pgid" in *[!0-9]*|'') fail 64 "PGID must be a positive integer" ;; esac
[ "$puid" -gt 0 ] || fail 64 "PUID 0 is forbidden"
[ "$pgid" -gt 0 ] || fail 64 "PGID 0 is forbidden"
ok "image tag and non-root identity are explicit"

http_port=$(require_value COCEAN_HTTP_PORT)
case "$http_port" in *[!0-9]*|'') fail 64 "COCEAN_HTTP_PORT must be numeric" ;; esac
[ "$http_port" -ge 1 ] && [ "$http_port" -le 65535 ] || \
  fail 64 "COCEAN_HTTP_PORT is outside 1..65535"
http_bind=$(require_value COCEAN_HTTP_BIND)
case "$http_bind" in *[!0-9A-Fa-f.:%_-]*|'') fail 64 "COCEAN_HTTP_BIND is invalid" ;; esac

music_dir=$(require_value COCEAN_MUSIC_DIR)
quarantine_dir=$(require_value COCEAN_QUARANTINE_DIR)
data_dir=$(require_value COCEAN_DATA_DIR)
cache_dir=$(require_value COCEAN_CACHE_DIR)
inbox_dir=$(require_value COCEAN_INBOX_DIR)
delivery_dir=$(require_value COCEAN_DELIVERY_DIR)
web_auth_file=$(require_value COCEAN_WEB_AUTH_FILE)

music_root_policy=$(env_value COCEAN_MUSIC_ROOT_POLICY)
[ -n "$music_root_policy" ] || music_root_policy=WATCH_ONLY
music_read_only=$(env_value COCEAN_MUSIC_READ_ONLY)
[ -n "$music_read_only" ] || music_read_only=true
case "$music_root_policy:$music_read_only" in
  WATCH_ONLY:true|MANAGED:false) ;;
  WATCH_ONLY:false)
    fail 64 "WATCH_ONLY requires COCEAN_MUSIC_READ_ONLY=true"
    ;;
  MANAGED:true)
    fail 64 "MANAGED requires COCEAN_MUSIC_READ_ONLY=false"
    ;;
  *) fail 64 "Music root policy or read-only flag is invalid" ;;
esac
ok "Music root policy and mount mode are consistent"

canonical_directory() {
  label=$1
  directory=$2
  case "$directory" in
    /*) ;;
    *) fail 73 "$label must be an absolute existing directory" ;;
  esac
  [ "$directory" != / ] || fail 73 "$label must not be the host filesystem root"
  case "$directory" in *','*|*'
'*) fail 73 "$label contains a character unsupported by Docker bind syntax" ;; esac
  [ -d "$directory" ] || fail 73 "$label does not exist as a directory"
  (CDPATH= cd -- "$directory" 2>/dev/null && pwd -P) || \
    fail 73 "$label cannot be resolved"
}

music_real=$(canonical_directory Music "$music_dir")
quarantine_real=$(canonical_directory quarantine "$quarantine_dir")
data_real=$(canonical_directory data "$data_dir")
cache_real=$(canonical_directory cache "$cache_dir")
inbox_real=$(canonical_directory inbox "$inbox_dir")
delivery_real=$(canonical_directory delivery "$delivery_dir")

exclude_directories=$(env_value COCEAN_SCAN_EXCLUDE_DIRS)
[ -n "$exclude_directories" ] || exclude_directories='[]'
command -v python3 >/dev/null 2>&1 || \
  fail 69 "Python 3 is required to validate the scan exclusion policy"
if ! python3 - "$music_real" "$exclude_directories" >/dev/null 2>&1 <<'PY'
import json
import os
import sys

root = os.path.realpath(sys.argv[1])
try:
    decoded = json.loads(sys.argv[2])
except json.JSONDecodeError:
    raise SystemExit(1)
if not isinstance(decoded, list) or len(decoded) > 128:
    raise SystemExit(1)
normalized = []
for item in decoded:
    if not isinstance(item, str):
        raise SystemExit(1)
    directory = item.strip()
    parts = directory.split("/")
    if (
        not directory
        or len(directory) > 500
        or directory.startswith("/")
        or directory.endswith("/")
        or "\\" in directory
        or "\x00" in directory
        or any(part in {"", ".", ".."} for part in parts)
    ):
        raise SystemExit(1)
    normalized.append(directory)
if len(set(normalized)) != len(normalized):
    raise SystemExit(1)
for directory in normalized:
    if any(
        candidate != directory and directory.startswith(f"{candidate}/")
        for candidate in normalized
    ):
        raise SystemExit(1)
    lexical = os.path.join(root, *directory.split("/"))
    if os.path.islink(lexical) or not os.path.isdir(lexical):
        raise SystemExit(1)
    canonical = os.path.realpath(lexical)
    if os.path.commonpath([root, canonical]) != root or canonical == root:
        raise SystemExit(1)
PY
then
  fail 73 "scan exclusions must be unique existing directories inside Music"
fi
ok "scan exclusion policy is explicit and resolves inside Music"

case "$web_auth_file" in
  /*) ;;
  *) fail 73 "COCEAN_WEB_AUTH_FILE must be an absolute existing file" ;;
esac
[ -f "$web_auth_file" ] && [ ! -L "$web_auth_file" ] && [ -r "$web_auth_file" ] || \
  fail 73 "Web authentication secret must be a readable regular file, not a symlink"
web_auth_real=$(CDPATH= cd -- "$(dirname -- "$web_auth_file")" 2>/dev/null && \
  printf '%s/%s\n' "$(pwd -P)" "$(basename -- "$web_auth_file")") || \
  fail 73 "Web authentication secret cannot be resolved"
if ! awk '
  NR > 1 { bad = 1 }
  NR == 1 {
    separator = index($0, ":")
    username = separator ? substr($0, 1, separator - 1) : ""
    password = separator ? substr($0, separator + 1) : ""
    if (username !~ /^[A-Za-z0-9._-]+$/ || length(username) > 64 ||
        length(password) < 16 || $0 ~ /\r/) bad = 1
  }
  END { exit(NR == 1 && !bad ? 0 : 1) }
' "$web_auth_real"; then
  fail 73 "Web authentication secret must contain one owner:password line with a 16+ character password"
fi

paths_overlap() {
  left=${1%/}
  right=${2%/}
  [ "$left" = "$right" ] && return 0
  case "$left/" in "$right/"*) return 0 ;; esac
  case "$right/" in "$left/"*) return 0 ;; esac
  return 1
}

set -- \
  "Music|$music_real" \
  "quarantine|$quarantine_real" \
  "data|$data_real" \
  "cache|$cache_real" \
  "inbox|$inbox_real" \
  "delivery|$delivery_real"
while [ "$#" -gt 1 ]; do
  first=$1
  shift
  first_label=${first%%|*}
  first_path=${first#*|}
  for other in "$@"; do
    other_label=${other%%|*}
    other_path=${other#*|}
    if paths_overlap "$first_path" "$other_path"; then
      fail 73 "$first_label and $other_label directories overlap"
    fi
  done
done
ok "Music, quarantine, data, cache, inbox and delivery are distinct existing directories"

for protected_root in "$music_real" "$quarantine_real" "$data_real" "$cache_real" "$inbox_real" "$delivery_real"; do
  case "$web_auth_real" in
    "$protected_root"|"$protected_root"/*)
      fail 73 "Web authentication secret must be outside Music and application data directories"
      ;;
  esac
done
ok "initial owner bootstrap credential is an isolated readable secret"

filesystem_type=""
if command -v findmnt >/dev/null 2>&1; then
  filesystem_type=$(findmnt -n -o FSTYPE -T "$data_real" 2>/dev/null | awk 'NR == 1 {print; exit}')
fi
if [ -z "$filesystem_type" ] && [ -r /proc/mounts ]; then
  filesystem_type=$(awk -v target="$data_real" '
    function decode(value) {
      gsub(/\\040/, " ", value); gsub(/\\011/, "\t", value)
      gsub(/\\012/, "\n", value); gsub(/\\134/, "\\", value)
      return value
    }
    {
      mountpoint = decode($2)
      if (target == mountpoint || index(target "/", mountpoint "/") == 1) {
        if (length(mountpoint) > best) { best = length(mountpoint); type = $3 }
      }
    }
    END { print type }
  ' /proc/mounts)
fi
[ -n "$filesystem_type" ] || fail 69 "data filesystem type cannot be proven"
case $(printf '%s' "$filesystem_type" | tr '[:upper:]' '[:lower:]') in
  nfs|nfs4|cifs|smbfs|fuse.sshfs|sshfs|9p|davfs|fuse.davfs|fuse.glusterfs|ceph)
    fail 73 "data must use a local filesystem compatible with SQLite WAL"
    ;;
esac
ok "data filesystem is not a known network filesystem"

host_arch=$("$DOCKER_BIN" info --format '{{.Architecture}}' 2>/dev/null) || \
  fail 69 "Docker Engine is unavailable"
case "$host_arch" in
  amd64|x86_64) expected_arch=amd64 ;;
  arm64|aarch64) expected_arch=arm64 ;;
  *) fail 69 "Docker host architecture is unsupported" ;;
esac

images=$(compose config --images 2>/dev/null | sort -u) || \
  fail 64 "Compose image list cannot be resolved"
for image in $images; do
  image_arch=$("$DOCKER_BIN" image inspect --format '{{.Architecture}}' "$image" 2>/dev/null || true)
  [ -z "$image_arch" ] && continue
  case "$image_arch" in x86_64) image_arch=amd64 ;; aarch64) image_arch=arm64 ;; esac
  [ "$image_arch" = "$expected_arch" ] || fail 69 "a local image has the wrong CPU architecture"
done
ok "Docker host architecture is supported"

project_name=$(env_value COMPOSE_PROJECT_NAME)
[ -n "$project_name" ] || project_name=cocean
published=$("$DOCKER_BIN" ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null || true)
port_owner=$(printf '%s\n' "$published" | awk -F'|' -v port="$http_port" '
  $2 ~ (":" port "->") { print $1; exit }
')
if [ -n "$port_owner" ]; then
  case "$port_owner" in
    "$project_name-web-"*|"${project_name}_web_"*) ;;
    *) fail 73 "the configured Web port is already published by another container" ;;
  esac
else
  host_listener=0
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$http_port" -sTCP:LISTEN -t >/dev/null 2>&1 && host_listener=1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk -v port="$http_port" '$4 ~ (":" port "$") { found=1 } END { exit(found ? 0 : 1) }' && host_listener=1
  elif command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | awk -v port="$http_port" '$0 ~ /LISTEN/ && $4 ~ ("[.:]" port "$") { found=1 } END { exit(found ? 0 : 1) }' && host_listener=1
  elif [ -r /proc/net/tcp ]; then
    hex_port=$(printf '%04X' "$http_port")
    awk -v port="$hex_port" 'NR > 1 && $2 ~ (":" port "$") && $4 == "0A" { found=1 } END { exit(found ? 0 : 1) }' /proc/net/tcp && host_listener=1
  fi
  [ "$host_listener" -eq 0 ] || fail 73 "the configured Web port is already in use"
fi
ok "configured Web port has no conflicting listener"

python_image=$(require_value PYTHON_IMAGE)
if ! "$DOCKER_BIN" run --rm --network none --read-only \
  --user "$puid:$pgid" --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$music_real,dst=/check/music,readonly" \
  --mount "type=bind,src=$quarantine_real,dst=/check/quarantine" \
  --mount "type=bind,src=$data_real,dst=/check/data" \
  --mount "type=bind,src=$cache_real,dst=/check/cache" \
  --mount "type=bind,src=$inbox_real,dst=/check/inbox" \
  --mount "type=bind,src=$delivery_real,dst=/check/delivery" \
  "$python_image" sh -eu -c '
    test -r /check/music && test -x /check/music
    for directory in /check/quarantine /check/data /check/cache /check/inbox /check/delivery; do
      test -r "$directory" && test -x "$directory" && test -w "$directory"
      sentinel="$directory/.cocean-preflight-$$"
      : >"$sentinel"
      rm -f "$sentinel"
    done
  ' >/dev/null 2>&1; then
  fail 73 "PUID/PGID cannot read Music and write quarantine/data/cache/inbox/delivery"
fi
ok "containerized PUID/PGID permission probe passed"

if [ "$music_root_policy" = MANAGED ]; then
  if ! "$DOCKER_BIN" run --rm --network none --read-only \
    --user "$puid:$pgid" --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=bind,src=$music_real,dst=/check/music" \
    "$python_image" sh -eu -c '
      sentinel=/check/music/.cocean-managed-preflight-$$
      : >"$sentinel"
      rm -f "$sentinel"
    ' >/dev/null 2>&1; then
    fail 73 "MANAGED Music is not writable by the configured PUID/PGID"
  fi
  ok "MANAGED Music write permission is proven"
fi

printf 'preflight: PASS\n'
