#!/bin/bash
# Print the commit a branch diverged from: the merge-base of HEAD and the base branch.
#
# The base branch is the first of:
#   1. the explicit argument ($1), if given: the hooks module passes the pull request's base,
#      read through the github plugin's mcp__github__gh pr-get
#   2. the remote's default branch (refs/remotes/origin/HEAD)
#   3. main
#
# The script reads no pull request: without an argument the default branch stands in for the
# pull request's base, and a line on stderr says so and how to pass another. A detached HEAD has
# no branch and no pull request of its own to ask about: without an argument it is refused.
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
  git symbolic-ref --quiet HEAD >/dev/null || {
    echo "error: detached HEAD and no base named: pass the pull request's base, /norms:check base=<branch>" >&2
    exit 1
  }
  base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  base=${base#origin/}
  [ -n "$base" ] || base=main
  ref=$(resolve_ref "$base") || { echo "error: base branch '$base' does not resolve to a commit" >&2; exit 1; }
  echo "note: no base named: the default branch '$base' stands in for the pull request's base; to compare with another, /norms:check base=<branch>" >&2
fi

git merge-base HEAD "$ref"
