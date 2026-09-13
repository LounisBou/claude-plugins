---
description: Launch an auditor of this orchestration, on the operator's word — a session in its own tab that reads the method and the results, reports to the operator and orders methodology changes
argument-hint: <subject> [--scope <what>] [--method <path>]
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief-lint.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh:*), Bash(git:*), Bash(ls:*), Bash(mkdir:*), Bash(date:*), Read, Write, Edit, ListAgents, SendMessage
---

Run on the operator's word only: the operator launches the audit and the operator ends it,
with `/orchestrator:audit-end` typed by the operator. No session launches an audit by itself.

Launch the AUDITOR of this orchestration, described in `orchestrator:orchestrator`,
section « The audit ». Load that skill first.

Usage: `/orchestrator:audit <subject> [--scope <what>] [--method <path>]`.

An auditor is not your successor and not your agent. It is a session in its own tab, on
your model and under remote control, that reads what you delivered and how you worked,
reports to the operator, and tells YOU what to change in the method — tighter or looser.
Nothing is handed over: you keep the orchestration, your agents and your chain.

Preconditions, verify each before acting:

- this session is an orchestrator (`Orch : <subject>` in `ListAgents`), not an agent;
- no auditor of yours is running: no record under the state directory's `audits/` for
  this session, or its auditor is absent from `ListAgents` (then clear the stale record);
  an absent `audits/` directory is « no record »; one auditor at a time;
- the subject is at most 25 characters: it becomes the title `Audit : <subject>`;
- the project state file is current — the auditor verifies it, it does not rebuild it.

Then:

1. **Instantiate the brief.** Copy `${CLAUDE_PLUGIN_ROOT}/templates/agent-audit-brief.md`
   into the project's briefs directory — the directory the standing succession brief lives
   in — as `audit-<date>-<subject>-brief.md`, and fill every `{{PLACEHOLDER}}`:
   - the orchestrator: your exact `ListAgents` name and reference, as they print;
   - the repository (the checkout the auditor opens, read-only) and the state file;
   - the scope: what `--scope` says, else everything since the last audit — the newest
     `REPORT.md` under `<briefs dir>/audits/`, named with its date — else everything since
     this orchestration started, with that date; a scope reading « continue from <report
     path> » — the auditor ended at its context gate — names that report as the previous
     one, and the new audit starts at the section it reached;
   - the method-and-decisions file, by its absolute path — one per project, the one file
     the auditor writes and you land (the rulebook's section « The audit »): the file `--method` names;
     without `--method`, the record for this repository in the state directory (step 5),
     so that every audit after the first finds it without the flag; with neither, the
     project has none yet, and the brief names where the auditor creates it:
     `<briefs dir>/method-and-decisions.md`. A `--method` naming another file than the
     record replaces the record at step 5;
   - the project's other method files, as reading: the project's method files you know —
     the ones your own office names (the state file's rules, a methodology or conventions
     document) — each by its absolute path; say that the
     project has none only when you know none;
   - the report path `<briefs dir>/audits/<date>-<subject>/REPORT.md` (create its
     directory), and the previous report's path, or « none »;
   - the gauge: the absolute path of the plugin's installed
     `skills/context-gauge/scripts/context-gauge.sh`, resolved now — the auditor's shell
     carries none of your variables; the same for `skills/orchestrator/scripts/rhythm.sh`;
   - the resource envelope the machine runs under today.
2. **Lint it.** `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief-lint.sh <brief path> --expect-created <report path> [--expect-created <method file>]`;
   the report path, and the method-and-decisions file while the project has none yet, are
   the paths the lint accepts as absent — the auditor creates them. Any other finding is
   repaired before the spawn, a known false positive is named.
3. **Spawn.** `iterm-agent.sh list` — note your own tty. Then:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh spawn --dir <repository> --auditor --title "Audit : <subject>" --permission-mode auto --trust --prompt "Read and execute <brief path>"
   ```

   `--auditor` places the tab immediately right of yours, runs it on your model, brings it
   up under remote control under its title, and writes it into no chain. No tier, no
   anchor, no successor's flag: the launcher refuses each beside `--auditor`.
4. **Verify on the artifact.** `iterm-agent.sh list` shows the `Audit : <subject>` tab;
   `iterm-agent.sh verify --tty <auditor tty>` shows the process; `ListAgents` shows the
   session within a few seconds. Then wait for the handshake: answer it, subscribe to the
   auditor's idle notice (`SendMessage` with `notify_when_idle: true`). An auditor that has
   not shaken hands within minutes is inspected with `iterm-agent.sh screen --tty`, not
   waited for.
5. **Record it** so `/orchestrator:audit-end` finds it. The directory does not exist before
   the first audit: create it first,
   `mkdir -p ${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/audits`, then write
   `${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/audits/<CLAUDE_CODE_SESSION_ID>.json`
   (your own session id) with the Write tool:

   ```json
   {"auditor_name": "Audit : <subject> [a1b2c3]", "auditor_tty": "/dev/ttysNNN",
    "report": "<briefs dir>/audits/<date>-<subject>/REPORT.md",
    "brief": "<brief path>", "orchestrator_name": "<your name [ref]>", "started": "<date -u +%FT%TZ>"}
   ```

   The name and reference are the auditor's as `ListAgents` prints them; the tty is the one
   `verify` read.

   Then record the project's method-and-decisions file, so that the next audit finds it
   without `--method`. One file per project, beside the audit records, keyed by the
   repository: its absolute path (`git -C <repository> rev-parse --show-toplevel`) with
   every `/` written `-`. Create the directory first,
   `mkdir -p ${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/methods`, then write
   `${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/methods/<repository key>.json`:

   ```json
   {"repository": "<repository>", "method": "<method file>", "recorded": "<date -u +%FT%TZ>"}
   ```

   A record that already names the same file is left as it is.
6. **Tell the operator, after the fact**, in one line: the auditor is running, its tab,
   its report path, and the method-and-decisions file it maintains.

While the audit runs, you owe the auditor what the rulebook's section says: the state it
asks for, answers in order, every ruling of the operator's relayed as it comes — dated, in
the operator's words — for the method-and-decisions file, and the application of every
change it orders unless that change contradicts the operator's word — which you say, in one
line, with the ruling it contradicts. You do not ask the operator whether to apply an ordered change: the auditor
has that authority, and the operator's word outranks it.

The audit ends on the operator's word, never on yours. The auditor's « audit ready: <report
path> » message and its « audit at 60 %: <report path>, continue from <section> » message are
not that word: you tell the operator in one line and wait. The end is `/orchestrator:audit-end`,
typed by the operator in your tab or in the auditor's; at the gate, the relaunch with `--scope
"continue from <report path>"` is yours on the operator's word.

$ARGUMENTS
