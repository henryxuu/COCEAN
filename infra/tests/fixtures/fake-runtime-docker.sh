#!/bin/sh

set -eu

case "${1:-}" in
  compose)
    shift
    service=""
    previous=""
    for argument in "$@"; do
      if [ "$previous" = -q ]; then service=$argument; fi
      previous=$argument
    done
    case " $* " in
      *' ps -q web '*) printf '%s\n' web-id ;;
      *' ps -q server '*) printf '%s\n' server-id ;;
      *' ps -q worker '*) printf '%s\n' worker-id ;;
      *) exit 1 ;;
    esac
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
      *'.Destination "/library/music"'*)
        case "$id" in
          server-id) printf '%s\n' "${FAKE_SERVER_MUSIC_RW:-false}" ;;
          worker-id) printf '%s\n' "${FAKE_WORKER_MUSIC_RW:-false}" ;;
        esac
        ;;
      *'.NetworkSettings.Networks'*)
        case "$id" in
          server-id) printf '%s\n' 'cocean_core cocean_egress ' ;;
          worker-id) printf '%s\n' 'cocean_core ' ;;
        esac
        ;;
      *) exit 1 ;;
    esac
    ;;
  exec)
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
