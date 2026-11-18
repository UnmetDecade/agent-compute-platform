#!/usr/bin/env bash
# Review-stage command.
#
# Applies the change package produced by the development role to the canonical
# tree, runs the project's optional review script, and (for a git checkout)
# commits the result.
#
# Env (set by the platform):
#   PLATFORM_PROJECT           project key
#   PLATFORM_ORIGIN_TASK_ID    the development task this stage reviews
# Optional:
#   REVIEW_COMMIT=0            apply + review, but do not commit
#   PROJECT_REPO               defaults to <project>/repo
set -euo pipefail

project="${PLATFORM_PROJECT:?PLATFORM_PROJECT is required}"
origin="${PLATFORM_ORIGIN_TASK_ID:?PLATFORM_ORIGIN_TASK_ID is required}"
project_root="/work/${project}"
repo="${PROJECT_REPO:-${project_root}/repo}"
changes_dir="${project_root}/changes"
patch_file="${changes_dir}/${origin}.patch"

if [[ ! -f "$patch_file" ]]; then
  echo "apply-changes: no change package for task ${origin} at ${patch_file}" >&2
  exit 3
fi

if [[ ! -d "$repo" ]]; then
  echo "apply-changes: canonical tree not found: ${repo}" >&2
  exit 2
fi

# Dry run first: a patch that does not apply cleanly must not half-modify the tree.
if ! patch -p1 --dry-run -d "$repo" < "$patch_file" >/dev/null; then
  echo "apply-changes: patch does not apply cleanly to ${repo}" >&2
  echo "apply-changes: the baseline moved after the development task started" >&2
  exit 4
fi
patch -p1 -d "$repo" < "$patch_file"

# Project-specific review rules (lint, policy checks, mandatory tests).
if [[ -x "${project_root}/review.sh" ]]; then
  echo "apply-changes: running ${project_root}/review.sh"
  ( cd "$project_root" && bash ./review.sh "$origin" )
fi

if [[ "${REVIEW_COMMIT:-1}" != "0" && -d "${repo}/.git" ]]; then
  git -C "$repo" add -A
  if git -C "$repo" diff --cached --quiet; then
    echo "apply-changes: nothing to commit"
  else
    git -C "$repo" -c user.name="platform" -c user.email="platform@localhost" \
      commit -q -m "task ${origin}: apply reviewed change package"
    echo "apply-changes: committed $(git -C "$repo" rev-parse --short HEAD)"
  fi
fi

echo "apply-changes: ${origin} applied to ${repo}"
