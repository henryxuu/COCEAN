#!/bin/sh

set -u

if [ -n "${FAKE_DOCKER_LOG:-}" ]; then
  printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
fi

case "${1:-}" in
  compose)
    shift
    if [ "${1:-}" = version ] && [ "${2:-}" = --short ]; then
      printf '%s\n' "${FAKE_COMPOSE_VERSION:-2.24.7}"
      exit 0
    fi
    saw_config=0
    saw_images=0
    for argument in "$@"; do
      [ "$argument" = config ] && saw_config=1
      [ "$argument" = --images ] && saw_images=1
    done
    if [ "$saw_config" -eq 1 ]; then
      [ "${FAKE_COMPOSE_CONFIG_FAIL:-0}" -eq 0 ] || exit 1
      if [ "$saw_images" -eq 1 ]; then
        printf '%s\n' example.invalid/cocean/web:1 example.invalid/cocean/server:1 example.invalid/cocean/worker:1
      fi
      exit 0
    fi
    command_name=""
    env_file=""
    previous=""
    for argument in "$@"; do
      if [ "$previous" = --env-file ]; then env_file=$argument; fi
      previous=$argument
      case "$argument" in
        run|up|pull|ps) [ -n "$command_name" ] || command_name=$argument ;;
      esac
    done
    if [ "$command_name" = run ]; then
      case " $* " in
        *' music-manifest snapshot '*)
          data_dir=$(awk -F= '$1 == "COCEAN_DATA_DIR" {print substr($0, index($0, "=") + 1); exit}' "$env_file")
          mkdir -p "$data_dir/acceptance"
          printf '%s\n' '{"schema":"cocean.music-manifest/v2","hash":"sha256","excludedDirectories":[]}' >"$data_dir/acceptance/music-before.jsonl"
          ;;
        *' music-manifest verify '*) [ "${FAKE_MANIFEST_VERIFY_FAIL:-0}" -eq 0 ] ;;
        *' acceptance-session issue '*)
          data_dir=$(awk -F= '$1 == "COCEAN_DATA_DIR" {print substr($0, index($0, "=") + 1); exit}' "$env_file")
          mkdir -p "$data_dir/acceptance"
          umask 077
          printf '%s\n' 'cocean_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' >"$data_dir/acceptance/admin-session-cookie"
          chmod 600 "$data_dir/acceptance/admin-session-cookie"
          if [ "${FAKE_SESSION_ISSUE_SIGNAL:-0}" -eq 1 ]; then
            kill -TERM "$PPID"
            sleep 1
            exit 143
          fi
          [ "${FAKE_SESSION_ISSUE_FAIL:-0}" -eq 0 ] || exit 94
          ;;
        *' acceptance-session revoke '*)
          data_dir=$(awk -F= '$1 == "COCEAN_DATA_DIR" {print substr($0, index($0, "=") + 1); exit}' "$env_file")
          revoke_count_file="${FAKE_DOCKER_LOG:-$data_dir/acceptance/fake-docker}.revoke-count"
          revoke_count=0
          [ ! -f "$revoke_count_file" ] || revoke_count=$(cat "$revoke_count_file")
          revoke_count=$((revoke_count + 1))
          printf '%s\n' "$revoke_count" >"$revoke_count_file"
          [ "$revoke_count" -gt "${FAKE_SESSION_REVOKE_FAILS:-0}" ] || exit 93
          [ "$revoke_count" -ne "${FAKE_SESSION_REVOKE_FAIL_AT:--1}" ] || exit 93
          if [ "${FAKE_SESSION_REVOKE_FAIL_FROM:-0}" -gt 0 ] && \
             [ "$revoke_count" -ge "${FAKE_SESSION_REVOKE_FAIL_FROM}" ]; then
            exit 93
          fi
          rm -f "$data_dir/acceptance/admin-session-cookie"
          ;;
        *' acceptance-api '*)
          data_dir=$(awk -F= '$1 == "COCEAN_DATA_DIR" {print substr($0, index($0, "=") + 1); exit}' "$env_file")
          cookie_path="$data_dir/acceptance/admin-session-cookie"
          [ -f "$cookie_path" ] || exit 91
          cookie_mode=$(stat -f '%Lp' "$cookie_path" 2>/dev/null || stat -c '%a' "$cookie_path")
          [ "$cookie_mode" = 600 ] || exit 92
          if [ -n "${FAKE_DOCKER_LOG:-}" ]; then
            printf '%s\n' 'acceptance-api-cookie-ready mode=600' >>"$FAKE_DOCKER_LOG"
          fi
          if [ "${FAKE_API_ACCEPTANCE_SIGNAL:-0}" -eq 1 ]; then
            kill -TERM "$PPID"
            sleep 1
            exit 143
          fi
          [ -z "${FAKE_API_ACCEPTANCE_SLEEP:-}" ] || sleep "$FAKE_API_ACCEPTANCE_SLEEP"
          [ "${FAKE_API_ACCEPTANCE_FAIL:-0}" -eq 0 ]
          ;;
        *' db-maintenance create '*) [ "${FAKE_BACKUP_CREATE_FAIL:-0}" -eq 0 ] ;;
        *' db-maintenance verify '*) [ "${FAKE_BACKUP_VERIFY_FAIL:-0}" -eq 0 ] ;;
      esac
      exit $?
    fi
    if [ "$command_name" = up ]; then
      [ "${FAKE_COMPOSE_UP_FAIL:-0}" -eq 0 ]
      exit $?
    fi
    if [ "$command_name" = ps ]; then
      case " $* " in
        *' ps -q web '*) printf '%s\n' web-id ;;
        *' ps -q server '*) printf '%s\n' server-id ;;
        *' ps -q worker '*) printf '%s\n' worker-id ;;
      esac
      exit 0
    fi
    exit 0
    ;;
  info)
    printf '%s\n' "${FAKE_DOCKER_ARCH:-arm64}"
    ;;
  image)
    exit 1
    ;;
  ps)
    exit 0
    ;;
  inspect)
    format=$3
    id=$4
    case "$format" in
      *'.State.Running'*) printf '%s\n' true ;;
      *'.State.Health'*) printf '%s\n' healthy ;;
      *'.HostConfig.ReadonlyRootfs'*) printf '%s\n' true ;;
      *'.Config.User'*) printf '%s\n' 1000:1000 ;;
      *'.HostConfig.CapDrop'*) printf '%s\n' '["ALL"]' ;;
      *'.HostConfig.SecurityOpt'*) printf '%s\n' '["no-new-privileges:true"]' ;;
      *'.HostConfig.Memory'*)
        case "$id" in
          web-id) printf '%s\n' 268435456 ;;
          server-id) printf '%s\n' 805306368 ;;
          worker-id) printf '%s\n' 2147483648 ;;
        esac
        ;;
      *'.Destination "/library/music"'*) printf '%s\n' false ;;
      *'.NetworkSettings.Networks'*)
        case "$id" in
          server-id) printf '%s\n' 'cocean_backend cocean_egress ' ;;
          worker-id) printf '%s\n' 'cocean_backend ' ;;
        esac
        ;;
      *) exit 1 ;;
    esac
    ;;
  exec)
    exit 0
    ;;
  run)
    case "$*" in
      *'.cocean-managed-preflight-'*)
        [ "${FAKE_MANAGED_PROBE_FAIL:-0}" -eq 0 ] || exit 1
        ;;
    esac
    [ "${FAKE_DOCKER_RUN_FAIL:-0}" -eq 0 ]
    ;;
  *)
    exit 1
    ;;
esac
