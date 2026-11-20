# Pausing, waking and opening orchestrators

**Pause, wake and drop are the operator's word only** — one orchestrator, several or all, asked
of you in plain words. Never your own initiative, never a peer's request, never to make room.

**Pause.** To each target, from a fresh `ListAgents`, ONE `SendMessage`, this text verbatim:

> The operator asks you to pause, relayed by `<your exact name>` at <date -u +%FT%TZ>. Prepare
> your succession for a pause: reach a quiet boundary, stand your agents down and close their
> tabs, stop your CI watches, bring your dispatch record current (every open item a row with
> its blocker, a judgment its note), then reply `paused-ready <dispatch record path>
> mode=<your mode> model=<model> effort=<effort>`, the last two the values `iterm-agent.sh pair` prints for you. Spawn no successor and do not close yourself: I close your tab.
> If you cannot, or `iterm-agent.sh pair` exits 1, reply `pause-refused <reason>`.

Then, on its `paused-ready`:

1. **Read its place**: `iterm-agent.sh list` — its tty and title — and its directory,
   pull requests and checkouts from `coordinator.sh owners` and `facts`.
2. **You close it**, as a successor closes its predecessor: `iterm-agent.sh close --tty <its
   tty> --expect-title "<the title list printed>"`; where the host refuses the close, message
   it « call mcp__orchestrator__end_session » and prove its end on the tty, `verify --tty`
   failing. The close's `closed 1 session` line is otherwise the proof. A tab that shows a home session takes its whole server with it,
   agents included, and the close's `home:` line names the session window 0 ran.
3. **Record it sleeping**, its name without its reference:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh sleep --name "Orch: <subject>" --brief <its dispatch record> --dir <its directory> --model <model> --effort <effort> --mode <its mode> [--session <that session>] [--config <its plan's directory>] [--pr "<repository>#<n> <branch>"]... [--checkout <path>]...
   ```

   `--config`: its `CLAUDE_CONFIG_DIR` (`~/.claude-bis` in full for `plan2`), none for `plan1`.

4. Tell the operator in one line: asleep, since when, dispatch record, pull requests left open.

A `pause-refused`, a silence, a close that fails or a `sleep` the
script refuses goes to the operator through your round, verbatim; an orchestrator not proved
paused-ready is never closed, and one closed but not recorded is told with every field above.
Its open pull requests stay as they are.

**Wake.** For each sleeping orchestrator he names (`coordinator.sh sleeping` gives every
field):

```
${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh spawn --wake --title "Orch: <subject>" [--model <model> --effort <effort>] [--resume <its session>] [--plan 1|2|auto] --dir <its directory> --permission-mode auto --prompt 'Load the skill orchestrator:orchestrator with the argument "<its mode>", then, from its working directory (no cd), run <the base directory that skill load printed>/scripts/succession.sh takeover <its dispatch record> --mode <its mode> and execute what it prints. You wake from a pause: your predecessor is gone; skip the takeover handshake.'
```

The record's model and effort go together, or neither: a record a pause wrote before an
effort was required (`effort none`) passes neither. The wake runs on the pair the resumed
session's transcript holds, else on the record's, else on the host's default — never one
you ask the operator for.

`--wake` makes a home session of its own, the orchestrator in its window 0; with the
record's session the same conversation resumes.
`--plan` wakes it on that plan, a fresh conversation when it is not the one it slept on (`auto`: more room, else the sleeper's).
Offer him that move, a pause then this wake, when `facts` shows its plan nearly full.
The spawn's success line is its proof:
then `coordinator.sh wake-done --name "Orch: <subject>"`, and announce yourself to it as to
any newcomer. A spawn that fails keeps the record, and the operator is told.

**Drop** is his `/orchestrator-sleeping drop <name>`: the record removed, its dispatch record
moved to `abandoned/` beside it, the pull requests, branches and checkouts left to him.

## Opening an orchestrator

**On his order only**, a new orchestration on a subject he names, you open it: you never
answer that he should do it himself. Its brief comes first, a file the new orchestrator reads
on the machine it runs on.

On this machine, open it yourself, right of your tab, in no chain, under remote control:

```
${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh spawn --open --title "Orch: <subject>" --dir <its directory> --permission-mode auto --prompt "Read and execute <brief path>"
```

Run it alone, never chained to another command and with nothing before it: that bare form,
by the installed path, is the one every `install.sh` run allows in `settings.json`. `--plan 1|2|auto` routes it (`auto`: more room by the `quota` lines of `facts`, else yours); its agents follow its plan. Add `--model <id> --effort <level>` when he named them
(a model alone is refused), the host's default for the session applying otherwise — his to
change, never yours — and `--trust` for a checkout prepared for it. The orchestrator
opens without the tools no session has called; `--keep-tool <name>` and `--drop-tool <name>`
change that set for this one (`iterm-agent.sh tools` lists what exists and what each costs). On the spawn's success line, announce yourself to it
as to any newcomer.

On another machine, send that machine's orchestrator (the one he named, else one that
announced itself from there) ONE `SendMessage`: his order verbatim and dated, the brief's
path and that same command. It opens the orchestrator there and replies with its name. A
refusal from a permission goes to him in one line, with the one fix that ends it: the plugin
there is updated and its `install.sh` run once on that machine, which writes the rule. Never ask a session to change
its own permissions.
