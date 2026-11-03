#!/bin/bash
# Every spawn form the launcher has, in dry run, printed with its output as the operator's
# orchestrator reads it. The suite compares this to spawn-dry-run.golden, recorded before
# the terminal operations moved behind one seam: a conversion is proved by nothing
# observable changing, and the dry-run lines (`launch=`, `anchor=`, `chain=` and the rest)
# are the part of a spawn that can be read without a terminal.
#
# The paths of this run (the work directory, the time stamp in a state file's name) are
# replaced by a marker, and the host CLI is a stand-in of the run's own, so no path of the
# machine reaches the output.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
AGENT="$HERE/../../skills/iterm-agents/scripts/iterm-agent.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-dry-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
WORK=$(cd "$WORK" && pwd -P)

mkdir -p "$WORK/bin"
printf '#!/bin/sh\n' > "$WORK/bin/host-cli"
chmod +x "$WORK/bin/host-cli"
export ORCHESTRATOR_HOST_CLI="$WORK/bin/host-cli"
export ORCHESTRATOR_TRUST_FILE="$WORK/trust.json"
printf '{"projects":{"%s":{"hasTrustDialogAccepted":true}}}\n' "$WORK" > "$ORCHESTRATOR_TRUST_FILE"
export CLAUDE_CONFIG_DIR="$WORK/config"
# The caller's model, as the hooks module records it each turn, for the forms that inherit it.
export CLAUDE_CODE_SESSION_ID=s-dry
mkdir -p "$CLAUDE_CONFIG_DIR/claude-orchestrator/measure"
printf '{"model":"a-model"}\n' > "$CLAUDE_CONFIG_DIR/claude-orchestrator/measure/s-dry.json"
export ORCHESTRATOR_LOGIN_SHELL=/bin/sh
export ORCHESTRATOR_DRY_RUN=1
export ORCHESTRATOR_SELF_TTY=/dev/ttys900
export ORCHESTRATOR_SELF_ID=S-ME

STATE="$WORK/state"
mkdir -p "$STATE/chains"
export ORCHESTRATOR_STATE_DIR="$STATE"

PS_ORCH="$WORK/ps-orch.txt"
printf '/dev/ttys900 /opt/x/host --name Orch : f --permission-mode auto\n' > "$PS_ORCH"
PS_AUDIT="$WORK/ps-audit.txt"
printf '/dev/ttys900 /opt/x/host --name Audit : f --permission-mode auto\n/dev/ttys950 /opt/x/host --name Audit : tm\n/dev/ttys951 /opt/x/host --name Coord : c\n/dev/ttys901 /opt/x/host --name Agent : x\n' > "$PS_AUDIT"
export ORCHESTRATOR_PS_TABLE="$PS_ORCH"

printf 'a brief\n' > "$WORK/brief.md"
printf '{"servers":{"a":{"command":"a-cmd"},"b":{"command":"b-cmd"}},"default":["a"]}\n' > "$WORK/mcp.json"
printf '{"deep":"a-model/high","standard":"a-model","light":""}\n' > "$WORK/models.json"

show() { # <label> <command...>: the command's output and exit code under a heading
  local label="$1"; shift
  printf '### %s\n' "$label"
  "$@" 2>&1
  printf 'exit=%s\n' "$?"
}
spawn() { bash "$AGENT" spawn --dir "$WORK" "$@"; }
chain() { printf '%s\n' "$1" > "$STATE/chains/ttys900.jsonl"; }

main() {
show "agent, no anchor" spawn --title "Agent : a" --prompt p
show "agent, right of self, no chain" spawn --title "Agent : a" --prompt p --right-of self
chain '{"tab_id":"t-1","tty":"/dev/ttys901","owner":"S-ME"}
{"tab_id":"t-2","tty":"/dev/ttys902","owner":"S-ME"}
{"tab_id":"t-3","tty":"/dev/ttys903","owner":"S-OTHER"}'
show "agent, right of self, chain of two" spawn --title "Agent : a" --prompt p --right-of self
show "agent, left of self, chain ignored" spawn --title "Agent : a" --prompt p --left-of self
show "agent, explicit right anchor" spawn --title "Agent : a" --prompt p --right-of /dev/ttys555
show "agent, explicit left anchor" spawn --title "Agent : a" --prompt p --left-of /dev/ttys555
show "agent, two anchors refused" spawn --title "Agent : a" --prompt p --left-of /dev/ttys001 --right-of self
chain 'not json'
show "agent, corrupt chain" spawn --title "Agent : a" --prompt p --right-of self
rm -f "$STATE/chains/ttys900.jsonl"
show "agent, resident" spawn --title "Agent : a" --prompt p --resident
show "agent, no verify, trust" spawn --title "Agent : a" --prompt p --no-verify --trust
show "agent, free title" spawn --title-free --title "odd" --prompt p
show "agent, bad title refused" spawn --title "odd" --prompt p
show "agent, tier" spawn --title "Agent : a" --prompt p --tier standard --effort low
show "agent, model" spawn --title "Agent : a" --prompt p --model a-model --permission-mode acceptEdits
show "agent, inherit model" spawn --title "Agent : a" --prompt p --inherit-model
show "agent, gate tokens" spawn --title "Agent : a" --prompt p --gate-tokens 200000
show "agent, tools kept and dropped" spawn --title "Agent : a" --prompt p --keep-tool Workflow --drop-tool Foo --keep-synced-skills
show "agent, account connectors" spawn --title "Agent : a" --prompt p --account-connectors
show "agent, no remote control" spawn --title "Agent : a" --prompt p --no-remote-control
show "agent, brief" spawn --title "Agent : a" --brief "$WORK/brief.md" --orchestrator "Orch : f [a1b2c3]"
show "agent, prompt file" spawn --title "Agent : a" --prompt-file "$WORK/brief.md"
show "agent, no prompt refused" spawn --title "Agent : a"
show "successor, derived name" spawn --successor --prompt p
show "successor, typed name" spawn --successor --title "Orch : g" --prompt p
show "successor, no remote control" spawn --successor --prompt p --no-remote-control
show "successor, resident" spawn --successor --prompt p --resident
export ORCHESTRATOR_PS_TABLE="$PS_AUDIT"
show "auditor" spawn --auditor --title "Audit : tm" --prompt p
show "auditor, derived successor" spawn --successor --prompt p
show "auditor, tier refused" spawn --auditor --title "Audit : tm" --prompt p --tier deep
show "coordinator successor" spawn --coordinator-successor --title "Coord : c" --prompt p
export ORCHESTRATOR_PS_TABLE="$PS_ORCH"
show "wake" spawn --wake --title "Orch : w" --prompt p --model a-model --effort high
show "open" spawn --open --title "Orch : o" --prompt p
show "open, tier" spawn --open --title "Orch : o" --prompt p --tier deep
export ORCHESTRATOR_MODELS_MAP="$WORK/models.json"
show "open, bound deep tier" spawn --open --title "Orch : o" --prompt p
export ORCHESTRATOR_MCP_CATALOGUE="$WORK/mcp.json"
show "agent, mcp default" spawn --title "Agent : a" --prompt p
show "agent, mcp named" spawn --title "Agent : a" --prompt p --mcp b
show "agent, mcp none" spawn --title "Agent : a" --prompt p --mcp none
export ORCHESTRATOR_PS_TABLE="$PS_AUDIT"
show "close" bash "$AGENT" close --tty /dev/ttys901 --expect-title "Agent : x"
show "close, keep checkout" bash "$AGENT" close --tty /dev/ttys901 --keep-checkout
show "rotate" bash "$AGENT" rotate --old-tty /dev/ttys901 --expect-title "Agent : x" --dir "$WORK" --title "Agent : r" --prompt p
show "rotate, auditor refused" bash "$AGENT" rotate --old-tty /dev/ttys950 --dir "$WORK" --title "Agent : r" --prompt p
show "rotate, auditor forced" bash "$AGENT" rotate --old-tty /dev/ttys950 --force --dir "$WORK" --title "Agent : r" --prompt p
show "rotate, coordinator refused" bash "$AGENT" rotate --old-tty /dev/ttys951 --dir "$WORK" --title "Agent : r" --prompt p
show "rotate, successor refused" bash "$AGENT" rotate --old-tty /dev/ttys901 --successor --dir "$WORK" --title "Agent : r" --prompt p
chain '{"tab_id":"2","tty":"/dev/ttys901","owner":"S-ME"}'
show "move, own agent right of self" bash "$AGENT" move --tty /dev/ttys901 --right-of self
show "move, own agent left of a tab" bash "$AGENT" move --tty /dev/ttys901 --left-of /dev/ttys555
show "move, leftmost" bash "$AGENT" move --tty /dev/ttys901 --leftmost
show "move, a stranger refused" bash "$AGENT" move --tty /dev/ttys777 --left-of /dev/ttys555
show "move, a stranger forced" bash "$AGENT" move --tty /dev/ttys777 --left-of /dev/ttys555 --force
show "move, auditor refused" bash "$AGENT" move --tty /dev/ttys950 --left-of /dev/ttys555
show "move, coordinator refused" bash "$AGENT" move --tty /dev/ttys951 --leftmost
show "move, same session refused" bash "$AGENT" move --tty /dev/ttys901 --left-of /dev/ttys901
show "move, no place refused" bash "$AGENT" move --tty /dev/ttys901
}

main | sed -E "s#$WORK#@WORK@#g; s#-[0-9]{13}\\.#-@TIME@.#g"
