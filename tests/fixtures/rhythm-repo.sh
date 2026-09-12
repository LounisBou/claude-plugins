#!/bin/bash
# rhythm-repo.sh <dir> — builds the repository `rhythm.sh` is tested on.
#
# A repository cannot be committed inside another one, so the fixture is the script that
# makes it: fixed dates, fixed line counts, a merged branch whose merge commit carries its
# pull request's title in the body the way a hosted merge does. Every figure the suite
# expects is derived from what this script writes:
#
#   week 2026-W32  chore: set up                       (before --since 2026-08-10)
#   week 2026-W33  feat(ui): card                      design/src/a.ts  +10
#                  fix(ui): card border                design/src/a.ts  +2 -1
#                  merge of « docs: office », whose branch holds
#                    docs: office                      docs/office.md   +5
#                    feat(api): endpoint               scripts/check.py +20
#   week 2026-W34  ci: pipeline                        .github/ci.yml   +3
#                  test(rules): guard                  tests/rules/r.py +7
#                  feat: plain                         design/src/b.ts  +4
#                  a subject with no type              README.md        +1
#
# and a register whose Status column holds two `open` rows, one `reopened`, and a Title cell
# reading `open` that is not a status.

set -euo pipefail

dir="${1:?usage: rhythm-repo.sh <dir>}"
rm -rf "$dir"
mkdir -p "$dir"
cd "$dir"

git init -q
git checkout -q -b main
git config user.email t@local
git config user.name t

at() { export GIT_AUTHOR_DATE="$1T12:00:00+0000" GIT_COMMITTER_DATE="$1T12:00:00+0000"; }
grow() {  # grow <file> <lines>
    mkdir -p "$(dirname "$1")"
    local i=0
    while [ "$i" -lt "$2" ]; do echo "$1 line $i" >> "$1"; i=$((i + 1)); done
}
commit() { git add -A && git commit -q -m "$1"; }

at 2026-08-03
grow README.md 1
cat > register.md <<'EOF'
# Register

| Id | Title | Status |
|---|---|---|
| B-1 | one | open |
| B-2 | open | fixed |
| B-3 | three | open |
| B-4 | four | reopened |
EOF
commit "chore: set up"

at 2026-08-11
grow design/src/a.ts 10
commit "feat(ui): card"
sed -i.bak '1d' design/src/a.ts && rm -f design/src/a.ts.bak
grow design/src/a.ts 2
commit "fix(ui): card border"

at 2026-08-12
git checkout -q -b docs
grow docs/office.md 5
commit "docs: office"
grow scripts/check.py 20
commit "feat(api): endpoint"
git checkout -q main
git merge -q --no-ff docs -m "Merge pull request #1 from someone/docs" -m "docs: office"

at 2026-08-18
grow .github/ci.yml 3
commit "ci: pipeline"
grow tests/rules/r.py 7
commit "test(rules): guard"
grow design/src/b.ts 4
commit "feat: plain"
grow README.md 1
commit "a subject with no type"
