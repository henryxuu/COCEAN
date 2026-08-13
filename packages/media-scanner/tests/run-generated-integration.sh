#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
  bash "${script_dir}/cleanup-fixtures.sh"
}

trap cleanup EXIT INT TERM
cleanup
bash "${script_dir}/generate-fixtures.sh"

if command -v vitest >/dev/null 2>&1; then
  vitest_bin="$(command -v vitest)"
else
  vitest_bin="${script_dir}/../../../node_modules/.bin/vitest"
fi

COCEAN_TEST_FIXTURES=1 "${vitest_bin}" run "${script_dir}/scanner.integration.test.ts"
