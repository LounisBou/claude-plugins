#!/bin/bash
# Print the commit a branch diverged from: the merge-base of HEAD and the base branch.
#
# The base branch is the first of:
#   1. the explicit argument ($1), if given
#   2. the base of the open pull request for the current branch (gh pr view)
#   3. the remote's default branch (refs/remotes/origin/HEAD)
#   4. main
#
# A name is resolved to origin/<name> when that remote ref exists, else to the local
# branch. Exit 1 with a message on stderr when nothing resolves.
set -u

resolve_ref() {
  local name="$1"
  if git rev-parse --verify --quiet "refs/remotes/origin/$name^{commit}" >/dev/null; then
    echo "origin/$name"
  elif git rev-parse --verify --quiet "$name^{commit}" >/dev/null; then
    echo "$name"
  else
    return 1
  fi
}

base=""
if [ -n "${1:-}" ]; then
  base="$1"
  ref=$(resolve_ref "$base") || { echo "error: base '$base' does not resolve to a commit" >&2; exit 1; }
else
  if command -v gh >/dev/null 2>&1; then
    base=$(gh pr view --json baseRefName --jq .baseRefName 2>/dev/null || true)
  fi
  if [ -z "$base" ]; then
    base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
    base=${base#origin/}
  fi
  [ -n "$base" ] || base=main
  ref=$(resolve_ref "$base") || { echo "error: base branch '$base' does not resolve to a commit" >&2; exit 1; }
fi

git merge-base HEAD "$ref"
