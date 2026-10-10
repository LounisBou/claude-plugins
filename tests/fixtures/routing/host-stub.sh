#!/bin/bash
# A headless-host stub. Agent runs edit hello.sh by effort; judge runs answer from STUB_JUDGE.
model=""; effort=""; mode=""; budget=""; sources="none"
while [ $# -gt 0 ]; do
  case "$1" in
    --model) model="$2"; shift 2 ;;
    --effort) effort="$2"; shift 2 ;;
    --permission-mode) mode="$2"; shift 2 ;;
    --max-budget-usd) budget="$2"; shift 2 ;;
    --setting-sources) sources="$2"; shift 2 ;;
    *) shift ;;
  esac
done
prompt=$(cat)
# One line per run, agent or judge, with the settings sources it was given.
role=agent; printf '%s' "$prompt" | grep -q 'JUDGE-RUBRIC' && role=judge
[ -n "${STUB_ARGS_LOG:-}" ] && printf '%s sources=%s\n' "$role" "$sources" >> "$STUB_ARGS_LOG"
[ -n "${STUB_SILENT:-}" ] && exit 0
usage() { printf '{"type":"result","subtype":"%s","is_error":%s,"result":%s,"modelUsage":{"%s-1":{"costUSD":%s}}}\n' "$1" "$2" "$3" "$model" "$4"; }
if printf '%s' "$prompt" | grep -q 'JUDGE-RUBRIC'; then
  # A judge that is handed no work to read fails the trial, so a lost agent diff shows.
  printf '%s' "$prompt" | sed -n '/^## Agent diff/,/^## Reference diff/p' | grep -q '^+echo hello' \
    || { usage success false '"{\"verdict\":\"fail\",\"scores\":{\"scope\":0},\"reasons\":[\"empty agent diff\"]}"' 0.02; exit 0; }
  case "${STUB_JUDGE:-pass}" in
    pass) usage success false '"{\"verdict\":\"pass\",\"scores\":{\"scope\":5},\"reasons\":[]}"' 0.02 ;;
    fail) usage success false '"{\"verdict\":\"fail\",\"scores\":{\"scope\":1},\"reasons\":[\"off scope\"]}"' 0.02 ;;
    fenced) usage success false '"```json\n{\"verdict\":\"pass\",\"scores\":{\"scope\":4},\"reasons\":[]}\n```"' 0.02 ;;
    lead) usage success false '"Here is my verdict:\n{\"verdict\":\"pass\",\"scores\":{\"scope\":3},\"reasons\":[]}"' 0.02 ;;
    prose) usage success false '"The change looks fine to me, no object here."' 0.02 ;;
    *) usage success false '"not json at all"' 0.02 ;;
  esac
  exit 0
fi
git log --all --oneline 2>/dev/null | wc -l | tr -d ' ' > .reachable-commits
[ -n "${STUB_MERGED:-}" ] && { git cat-file -e "$STUB_MERGED" 2>/dev/null && echo yes || echo no; } > .merged-reachable
printf '%s\n' "$mode" > .permission-mode
printf '%s\n' "$budget" > .budget-ceiling
cp hello.sh .start-hello
# An agent that plants a link where the tests live, and one that starts a process that outlives it.
[ -n "${STUB_SYMLINK_OUT:-}" ] && { rm -rf tests; ln -s "$STUB_SYMLINK_OUT" tests; }
[ -n "${STUB_GRANDCHILD:-}" ] && { sleep 31337 >/dev/null 2>&1 & sleep 30; }
case "$effort" in
  max) usage error_max_budget_usd true '""' 0.40; exit 0 ;;
  low) printf '#!/bin/bash\necho hello\n' > hello.sh ;;
  *) printf '#!/bin/bash\necho hello world\n' > hello.sh ;;
esac
[ -n "${STUB_COMMIT:-}" ] && { git add -A; git -c user.name=agent -c user.email=a@a commit -qm "agent work"; }
usage success false '"done"' 0.10
