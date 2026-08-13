#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../.." && pwd)

MODE=${1:---print}
COCEAN_PLATFORMS=${COCEAN_PLATFORMS:-linux/amd64,linux/arm64}

case "$MODE" in
  --print|--push|--load) ;;
  *)
    echo "usage: $0 [--print|--push|--load]" >&2
    exit 64
    ;;
esac

if ! command -v docker >/dev/null 2>&1 || ! docker buildx version >/dev/null 2>&1; then
  echo "Docker Buildx is required." >&2
  exit 69
fi

cd "$REPO_ROOT"

if [ "$MODE" = "--print" ]; then
  exec docker buildx bake \
    --file infra/build/docker-bake.hcl \
    --set "*.platform=${COCEAN_PLATFORMS}" \
    --print
fi

if [ "$MODE" = "--load" ]; then
  case "$COCEAN_PLATFORMS" in
    *,*)
      echo "--load supports one platform only; set COCEAN_PLATFORMS=linux/amd64 or linux/arm64." >&2
      exit 64
      ;;
  esac
fi

exec docker buildx bake \
  --file infra/build/docker-bake.hcl \
  --set "*.platform=${COCEAN_PLATFORMS}" \
  "$MODE"
