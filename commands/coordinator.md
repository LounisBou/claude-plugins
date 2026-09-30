---
description: Start the machine's coordinator, on the operator's word, in a session he opened — named, registered, placed leftmost, and announced to every orchestrator and auditor
argument-hint: <subject>
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh:*), Bash(mkdir:*), Bash(date:*), Read, Write, Edit, ListAgents, SendMessage
---

Run on the operator's word only, in a session HE opened for it: the operator starts the
coordinator and the operator ends it, with `/orchestrator:coordinator-end`. No orchestrator,
auditor or agent starts a coordinator, and no session runs this command by itself.

Start the COORDINATOR described in `orchestrator:coordination`. Load that skill first.

Usage: `/orchestrator:coordinator <subject>`.

Preconditions, verify each before acting:

- this session is none of the plugin's roles: `ListAgents` does not name it `Orch :`,
  `Agent :` or `Audit :` — an orchestrator that coordinates is two jobs in one context;
- no live coordinator: `${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh lookup`
  prints nothing. A name printed is a coordinator that runs: tell the operator which, and
  stop. A stale record named on the error stream is not a refusal: `register` replaces it
  and says so;
- the subject is at most 25 characters and neither begins nor ends with a space: it becomes
  the title `Coord : <subject>`, and the launcher refuses any other shape of that title, so a
  subject it would refuse passes here and fails your successor's spawn at the 80 % gate.

Then:

1. **The name first.** The host gives the model no rename, and the address you register
   is the name `ListAgents` prints for this session, so the operator renames it before
   anything is written. Hand him this one line, and end the turn:

   ```
   /rename "Coord : <subject>"
   ```

   When he says it is done, read the name back from `ListAgents` (« This session is … »): it
   must start with `Coord : <subject>`, followed by its reference. Anything else, and the line
   is handed to him again; nothing is registered under another name.
2. **Your tty.** `${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh list` —
   the row marked `self`.
3. **Register.** The name exactly as `ListAgents` prints it, reference included:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh register --name "Coord : <subject> [<ref>]" --tty <your tty>
   ```

   It prints « registered <name> ». Refused — another registration running, a live
   coordinator recorded — tell the operator the refusal verbatim and stop. « replaced a stale
   record: <name> » is said to him in one line. Then `coordinator.sh lookup` prints your name:
   the proof. Create the queue's directory, `mkdir -p <state dir>/coordinator`. Then the
   queue: never overwrite an existing `queue.md` — a coordinator that ended without its end
   command, or a succession cut short, left open items in it. Read it, put its open items
   before the operator first — each question under its prefix in queue order, each wait in
   one line; a list he reads, not questions he answers now: they come to him one at a time
   afterwards, as the skill says — keep the file as your queue, then continue with step 4.
   Only when there is none, write an empty `queue.md` there (the skill's « Overview »).
4. **Leftmost.** Your tab goes to the first place of its window:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh move --tty <your tty> --leftmost
   ```

   `iterm-agent.sh list` shows your `self` row first in its window.
5. **Announce.** A fresh `ListAgents`; to every `Orch :` and `Audit :` session it lists, one
   `SendMessage` with `notify_when_idle: true`, this text verbatim, the brackets filled:

   > Coordinator: `<your exact name and reference>` coordinates this machine from
   > <date -u +%FT%TZ>. While it runs you no longer speak to the operator: your questions,
   > « ready », the stops that are his, your end-of-phase reports and « audit ready » come to
   > this address, and his answers and orders come back from it, verbatim and dated. Before
   > each dispatch, run `coordinator.sh declare` and send me the id it prints, then wait for
   > « go »; at the end of the phase, `coordinator.sh release <id>` and tell me. When
   > `coordinator.sh lookup` prints nothing, the coordinator is gone: speak to the operator
   > directly again. Acknowledge with one line: « acknowledged ».

6. **The acknowledgments.** Each one is noted in `queue.md`. A session silent after fifteen
   minutes gets the announcement again after a fresh `ListAgents`, marked as a re-send; still
   silent, it is named to the operator. It finds you through `lookup` the next time it would
   speak.
7. **Tell the operator**, in one short message: registered under `<name>`, tab leftmost, who
   acknowledged, who is silent, and that his questions now come to him through you, one at a
   time.

From here, the skill is the rulebook: the queue, the declarations, the relays, its limits and
its succession at 80 %.

$ARGUMENTS
