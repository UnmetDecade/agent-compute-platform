#!/usr/bin/env bash
# Prepare hook of a development role.
#
# Copies the canonical project tree into the role's work tree before the Agent
# starts, so every task begins from the same baseline. The contract is path
# based, not VCS based: it works for a git checkout, an SVN working copy or a
# plain directory tree.
#
# Env (set by the platform):
#   PLATFORM_PROJECT      project key from the allocation plan (e.g. demo)
#   PLATFORM_WORKSPACE    the role's workdir (/work/<project>/<role>)
#   PLATFORM_TASK_ID      current task
# Optional:
#   SYNC_SOURCE           defaults to <project>/repo
#   SYNC_EXCLUDES         additional rsync excludes, space separated
set -euo pipefail

project="${PLATFORM_PROJECT:?PLATFORM_PROJECT is required}"
workspace="${PLATFORM_WORKSPACE:?PLATFORM_WORKSPACE is required}"
project_root="/work/${project}"
source_dir="${SYNC_SOURCE:-${project_root}/repo}"

if [[ ! -d "$source_dir" ]]; then
  echo "sync-worktree: source tree not found: $source_dir" >&2
  echo "sync-worktree: create ${project_root}/repo on the host before dispatching development tasks" >&2
  exit 2
fi

mkdir -p "$workspace"

# Agent CLI state (`.claude`, `.claude.json`, `.agent`) is excluded both from the
# copy and from --delete: it belongs to the machine, not to the project, and
# keeping it makes the next task start faster. The protocol file `result.json` is
# deliberately NOT excluded, so --delete removes the previous task's leftover.
excludes=(--exclude .git --exclude .svn --exclude node_modules
          --exclude .agent --exclude .claude --exclude .claude.json)
for extra in ${SYNC_EXCLUDES:-}; do
  excludes+=("--exclude" "$extra")
done

# --delete keeps a stale file from a previous task out of the next one; the
# work tree is derived state, never the source of truth.
rsync -a --delete "${excludes[@]}" "${source_dir}/" "${workspace}/"

echo "sync-worktree: ${source_dir} -> ${workspace} (task ${PLATFORM_TASK_ID:-?})"
