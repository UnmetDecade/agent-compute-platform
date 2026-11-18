#!/usr/bin/env bash
# Post hook of a development role.
#
# Turns whatever the Agent left in the work tree into a change package the
# review stage can apply without access to this machine:
#
#   changes/<origin_task_id>.patch   unified diff against <project>/repo
#   changes/<origin_task_id>.tar.gz  full work tree
#   changes/<origin_task_id>.json    metadata (role, task, file list, digest)
#
# It runs regardless of whether the Agent changed anything; an empty patch is a
# valid outcome and lets the review stage decide what to do.
set -euo pipefail

project="${PLATFORM_PROJECT:?PLATFORM_PROJECT is required}"
workspace="${PLATFORM_WORKSPACE:?PLATFORM_WORKSPACE is required}"
origin="${PLATFORM_ORIGIN_TASK_ID:?PLATFORM_ORIGIN_TASK_ID is required}"
project_root="/work/${project}"
baseline="${CHANGES_BASELINE:-${project_root}/repo}"
changes_dir="${project_root}/changes"

mkdir -p "$changes_dir"

patch_file="${changes_dir}/${origin}.patch"
tar_file="${changes_dir}/${origin}.tar.gz"
meta_file="${changes_dir}/${origin}.json"

# Agent runtime state and the protocol/output directories are not project
# changes: `.claude` is CLI state, `result.json` is the adapter's result file,
# and upstream/attachments are inputs the platform unpacked into the work tree.
diff_excludes=(--exclude .git --exclude .svn --exclude node_modules
               --exclude .agent --exclude .claude --exclude .claude.json
               --exclude result.json --exclude upstream --exclude attachments)

# diff exits 1 when files differ; only >=2 is an error.
set +e
diff -ruN "${diff_excludes[@]}" "$baseline" "$workspace" > "$patch_file"
status=$?
set -e
if [[ $status -gt 1 ]]; then
  echo "collect-changes: diff failed with status ${status}" >&2
  exit "$status"
fi

# Rewrite the paths so the patch applies at the project root with -p1
# (a/... b/... instead of absolute directories).
sed -i -E "s#^--- ${baseline//\//\\/}/#--- a/#; s#^\+\+\+ ${workspace//\//\\/}/#+++ b/#" "$patch_file" || true

tar -czf "$tar_file" -C "$workspace" \
  --exclude=./.git --exclude=./.svn --exclude=./node_modules \
  --exclude=./.agent --exclude=./.claude --exclude=./.claude.json \
  --exclude=./result.json --exclude=./upstream --exclude=./attachments .
digest="$(sha256sum "$patch_file" | cut -d' ' -f1)"
files="$(grep -c '^diff -ruN' "$patch_file" || true)"

cat > "$meta_file" <<JSON
{
  "origin_task_id": "${origin}",
  "business_role": "${PLATFORM_BUSINESS_ROLE:-}",
  "project": "${project}",
  "workspace": "${workspace}",
  "baseline": "${baseline}",
  "patch": "changes/${origin}.patch",
  "archive": "changes/${origin}.tar.gz",
  "patch_sha256": "${digest}",
  "changed_files": ${files},
  "collected_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "collect-changes: ${files} changed file(s) -> ${patch_file}"
