#!/bin/bash
# tests/e2e-data-root.sh [<scratch dir that does not exist yet>]
# The orchestrator's two roots end to end, over the real scripts and no terminal: a throwaway agent's
# dispatch, its brief and its spawn (a dry run: the app is not asked, so no launch script is run), a
# question entered in the round, the launcher's log and the directory its launch-script writer picks,
# with the protected root and the data root two scratch directories. Nothing of the machine's state
# is read or written: HOME, CLAUDE_CONFIG_DIR and ORCHESTRATOR_STATE_DIR are scratch. What a session could plant in the data root, under the names of
# what runs, is planted there; the run holds that none of it ran or was read, that what any session
# writes (the record, the brief, the registry, the round entry, the log) is under the data root and
# what runs (the venv, the launch script, the server catalogue, the models file) under the protected root.
# Exits 0 only when every check at the end holds. It runs in the default suite (a dry run, a couple
# of seconds, no terminal) and by hand to read what it prints.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
E=${1:-$(mktemp -d "${TMPDIR:-/tmp}/e2e-data-root.XXXXXX")}
if [ -n "${1:-}" ]; then
  [ -e "$E" ] && { echo "refused: $E exists"; exit 2; }
  mkdir -p "$E"
fi
E=$(cd "$E" && pwd -P)
P="$E/protected"; D="$E/data"; C="$E/config"; W="$E/work"
mkdir -p "$P/venv/bin" "$D" "$C/claude-orchestrator" "$C/sessions" "$E/bin" "$E/projects" "$W"
printf '{"version": 1, "dir": "%s"}\n' "$D" > "$P/data-root.json"
printf '{"version": 1, "dir": "%s"}\n' "$D" > "$C/claude-orchestrator/data-root.json"
# The protected venv: says it ran and with what, then runs the machine's interpreter.
printf '#!/bin/sh\necho "venv run: %s/venv/bin/python $*" >> "%s/ran.log"\nexec python3 "$@"\n' "$P" "$E" > "$P/venv/bin/python"
chmod +x "$P/venv/bin/python"
printf '{"servers":{"a":{"command":"a-cmd"}},"default":["a"]}\n' > "$P/mcp.json"
printf '{"deep":"","standard":"","light":"a-model/low"}\n' > "$P/models.json"
# Planted in the data root, under the names of what runs: an interpreter, a catalogue, a models file.
mkdir -p "$D/venv/bin" "$P/round"
printf '#!/bin/sh\necho "PLANTED venv run" >> "%s/ran.log"\nexit 1\n' "$E" > "$D/venv/bin/python"
chmod +x "$D/venv/bin/python"
printf '{"servers":{"evil":{"command":"evil-cmd"}},"default":["evil"]}\n' > "$D/mcp.json"
printf '{"deep":"","standard":"","light":"evil-model/max"}\n' > "$D/models.json"
printf '#!/bin/sh\n' > "$E/bin/host-cli"; chmod +x "$E/bin/host-cli"
printf '{"projects":{"%s":{"hasTrustDialogAccepted":true}}}\n' "$W" > "$E/trust.json"
printf '{"sessionId":"s-e2e","name":"Orch: e2e","updatedAt":1}\n' > "$C/sessions/$$.json"
git -C "$W" init -q -b main && git -C "$W" -c user.name=e2e -c user.email=e2e@example.invalid commit -q --allow-empty -m init

export HOME="$E" CLAUDE_CONFIG_DIR="$C" ORCHESTRATOR_STATE_DIR="$P" CLAUDE_CODE_SESSION_ID=s-e2e
export ORCHESTRATOR_HOST_CLI="$E/bin/host-cli" ORCHESTRATOR_TRUST_FILE="$E/trust.json" ORCHESTRATOR_PROJECTS_DIR="$E/projects"
export ORCHESTRATOR_LOGIN_SHELL=/bin/sh ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_SELF_ID=S-ME
unset TMUX TMUX_PANE ORCHESTRATOR_PYTHON ORCHESTRATOR_MCP_CATALOGUE ORCHESTRATOR_MODELS_MAP ORCHESTRATOR_MODULE_DIR

S="$ROOT/skills"
REC="$D/briefs/e2e/dispatch-record.jsonl"
mkdir -p "$(dirname "$REC")"
printf '# Phase 1 — e2e\n\nA throwaway phase.\n' > "$D/briefs/e2e/phase-1.md"
echo "### dispatch"
bash "$S/orchestrator/scripts/dispatch-record.sh" goals "$REC" init --spec none; echo "exit=$?"
bash "$S/orchestrator/scripts/dispatch-record.sh" open "$REC" --class c --tier light --label "E2E: data root"; echo "exit=$?"
echo "### brief"
bash "$S/orchestrator/scripts/brief.sh" phase --record "$REC" --row 1 --plan "$D/briefs/e2e/phase-1.md" --worktree "$W" --branch main --orchestrator "Orch: e2e [a1b2c3]" --out "$D/briefs/e2e/1-brief.md"; echo "exit=$?"
mkdir -p "$D/chains"; printf '{"tab_id":"t-1","tty":"/dev/ttys901","owner":"S-ME"}\n' > "$D/chains/ttys900.jsonl"
echo "### spawn (dry run: the app is not asked)"
bash "$S/iterm-agents/scripts/iterm-agent.sh" spawn --dir "$W" --tier light --title "Agent: e2e" --brief "$D/briefs/e2e/1-brief.md" --orchestrator "Orch: e2e [a1b2c3]" --right-of self > "$E/spawn.out" 2>&1
spawn_exit=$?
grep -E '^(spawn:|prompt_file|mcp|mcp_file|anchor|launch|effort|pair_source|ERROR)' "$E/spawn.out"; echo "exit=$spawn_exit"

echo "### the launch script's directory, as the launcher's own writer picks it"
# The dry run writes no launch script: the writer a real spawn calls says where it puts one.
PYTHONPATH="$S/iterm-agents/scripts" "$P/venv/bin/python" -c '
import iterm_agent as m
print(m.write_launch_script("true", "Agent: e2e"))
' > "$E/launch.path" 2> "$E/launch.err"
launch=$(tail -1 "$E/launch.path")
echo "launch=$launch"

echo "### a question entered in the round through core's store at the data root, read by the coordinator"
node --input-type=module -e '
import { pathToFileURL } from "node:url"
const root = process.argv[1]
const { orchestratorRoots } = await import(pathToFileURL(root + "/core/roots.ts"))
const { roundEntryPath } = await import(pathToFileURL(root + "/core/orchestration.ts"))
const { update } = await import(pathToFileURL(root + "/core/store.ts"))
const entry = { id: "e2e-q1", from: "Orch: e2e", session: "s-e2e", kind: "operator", since: "2026-10-18T10:01:00.000Z",
  blocks: "phase 1", question: "Ship it?", choices: [], recommendation: null, status: "open", at: "2026-10-18T10:01:00.000Z", answer: null }
update(roundEntryPath(orchestratorRoots(process.env).dataRoot, entry.id), () => JSON.stringify(entry) + "\n")
' "$ROOT" 2> "$E/round.err"
echo "exit=$?"
bash "$S/coordinator/scripts/coordinator.sh" round --all > "$E/round.out" 2>&1; echo "round exit=$?"
cat "$E/round.out"
bash "$S/coordinator/scripts/coordinator.sh" roots > "$E/roots.out" 2>&1

echo "### the launcher's log"
PYTHONPATH="$S/iterm-agents/scripts" "$P/venv/bin/python" -c 'import iterm_agent as m; m.close_log("e2e", "a line of the throwaway agent", echo=False)'; echo "exit=$?"
echo "### ran.log"; cat "$E/ran.log"
echo "### roots"; cat "$E/roots.out"
echo "### files under the protected root"; (cd "$P" && find . -type f | sort)
echo "### files under the data root"; (cd "$D" && find . -type f | sort)

echo "### checks"
fail=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }
said() { sed -n "s/^$1=//p" "$E/spawn.out" | head -1; }
check "the spawn exits 0" '[ "$spawn_exit" = 0 ]'
check "the roots command names both, as the data-root file places them" '[ "$(sed -n "s/^protected=//p" "$E/roots.out")" = "$P" ] && [ "$(sed -n "s/^data=//p" "$E/roots.out")" = "$D" ]'
check "the record and the brief are in the data root" '[ -s "$REC" ] && [ -s "$D/briefs/e2e/1-brief.md" ]'
check "the registry is in the data root" '[ -n "$(find "$D/records" -type f 2>/dev/null)" ]'
check "the round entry is in the data root, none on the protected root" '[ -s "$D/round/e2e-q1.json" ] && [ -z "$(find "$P/round" -type f 2>/dev/null)" ]'
check "the coordinator reads that entry in the data root" 'grep -q "Ship it" "$E/round.out"'
check "close.log is in the data root, none on the protected root" '[ -s "$D/close.log" ] && [ ! -e "$P/close.log" ]'
check "the prompt file is under the protected root" 'case "$(said prompt_file)" in "$P/prompts/"*) true ;; *) false ;; esac'
check "the server file is under the protected root" 'case "$(said mcp_file)" in "$P/prompts/"*) true ;; *) false ;; esac'
check "the launch script is under the protected root" 'case "$launch" in "$P/prompts/launch-"*) [ -s "$launch" ] ;; *) false ;; esac'
check "the servers are the protected catalogue" '[ "$(said mcp)" = a ]'
check "the model is the protected models file's" 'grep -q -- "--model a-model --effort low " "$E/spawn.out"'
check "the anchor is the data root chain" '[ "$(said anchor)" = /dev/ttys901 ]'
check "the spawn ran the launcher on the protected venv, never the one planted in the data root" 'grep -q "^venv run: $P/venv/bin/python [^ ]*/iterm_agent.py --request .*\"command\":\"spawn\"" "$E/ran.log" && ! grep -q "PLANTED venv" "$E/ran.log"'
check "nothing planted was read" '! grep -q evil "$E/spawn.out"'
check "no data item on the protected root" '[ -z "$(cd "$P" && find . -type f ! -path "./venv/*" ! -path "./prompts/*" ! -name mcp.json ! -name models.json ! -name data-root.json)" ]'
exit $fail
