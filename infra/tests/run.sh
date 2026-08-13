#!/bin/sh

set -eu

TEST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$TEST_DIR/../.." && pwd -P)

ruby "$REPO_ROOT/infra/scripts/validate-fnos-compose.rb"
for script in "$REPO_ROOT"/infra/scripts/*.sh "$REPO_ROOT"/infra/tests/*.sh; do
  sh -n "$script"
done
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$TEST_DIR" -p 'test_*.py' -v
sh "$TEST_DIR/test_fnos_preflight.sh"
sh "$TEST_DIR/test_fnos_acceptance.sh"
PYTHONDONTWRITEBYTECODE=1 python3 "$REPO_ROOT/infra/scripts/fnos_api_acceptance.py" --help >/dev/null
sh "$REPO_ROOT/infra/scripts/fnos_preflight.sh" --help >/dev/null
sh "$REPO_ROOT/infra/scripts/fnos_runtime_inspect.sh" --help >/dev/null
sh "$REPO_ROOT/infra/scripts/fnos_acceptance.sh" --help >/dev/null
printf 'FNOS static and mock gates: PASS\n'
