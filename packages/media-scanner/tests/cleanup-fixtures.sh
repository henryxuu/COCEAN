#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture_dir="${1:-${script_dir}/generated-fixtures}"

case "${fixture_dir}" in
  */tests/generated-fixtures) ;;
  *)
    echo "Refusing to remove unexpected fixture path: ${fixture_dir}" >&2
    exit 2
    ;;
esac

rm -rf -- "${fixture_dir}"
echo "Removed generated media fixtures from ${fixture_dir}"
