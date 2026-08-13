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
        *' acceptance-api '*) [ "${FAKE_API_ACCEPTANCE_FAIL:-0}" -eq 0 ] ;;
        *' db-maintenance create '*) [ "${FAKE_BACKUP_CREATE_FAIL:-0}" -eq 0 ] ;;
        *' db-maintenance verify '*) [ "${FAKE_BACKUP_VERIFY_FAIL:-0}" -eq 0 ] ;;
      esac
      exit $?
    fi
    if [ "$command_name" = up ]; then
      [ "${FAKE_COMPOSE_UP_FAIL:-0}" -eq 0 ]
      exit $?
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
  run)
    [ "${FAKE_DOCKER_RUN_FAIL:-0}" -eq 0 ]
    ;;
  *)
    exit 1
    ;;
esac
