#!/usr/bin/env bash
# Test-bench command.
#
# Runs the project's test entry point and keeps the log with the artifacts, so a
# failed board test is diagnosable from the scheduler alone.
#
# Env (set by the platform):
#   PLATFORM_PROJECT           project key
#   PLATFORM_ORIGIN_TASK_ID    the development task under test
#   PLATFORM_TASK_ID           this test task
# Optional:
#   TEST_CMD                   overrides <project>/test.sh
set -euo pipefail

project="${PLATFORM_PROJECT:?PLATFORM_PROJECT is required}"
origin="${PLATFORM_ORIGIN_TASK_ID:-unknown}"
project_root="/work/${project}"
artifacts="${project_root}/artifacts/${origin}"
mkdir -p "$artifacts"

log="${artifacts}/test-${PLATFORM_TASK_ID:-run}.log"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

run() {
  if [[ -n "${TEST_CMD:-}" ]]; then
    echo "run-tests: TEST_CMD=${TEST_CMD}"
    bash -lc "$TEST_CMD"
  elif [[ -x "${project_root}/test.sh" ]]; then
    echo "run-tests: ${project_root}/test.sh"
    ( cd "$project_root" && bash ./test.sh "$origin" )
  else
    echo "run-tests: neither TEST_CMD nor ${project_root}/test.sh is available" >&2
    return 2
  fi
}

set +e
{ echo "# test log"; echo "origin: ${origin}"; echo "started_at: ${started_at}"; run; } 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e

{
  echo "finished_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "exit_code: ${status}"
} >> "$log"

echo "run-tests: exit ${status}, log ${log}"
exit "$status"
