#!/usr/bin/env bash
# Project test entry point used by scripts/platform/run-tests.sh.
# Replace with the real board test (flash, boot, serial assertions, ...).
set -euo pipefail

origin="${1:-unknown}"
repo="/work/demo/repo"

echo "demo test: origin=${origin}"
if [[ ! -d "$repo" ]]; then
  echo "demo test: canonical tree missing at ${repo}" >&2
  exit 1
fi

# Smoke check: every shell script in the tree must at least parse.
find "$repo" -name '*.sh' -print0 | xargs -0 -r -n1 bash -n

echo "demo test: ok"
