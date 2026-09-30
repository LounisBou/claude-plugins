---
description: Launch an audit of the method, on the operator's word — a session in its own tab that weighs what the method costs against what it yields, writes one report of proposals, and stops
argument-hint: <subject> [--since <date>]
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief-lint.sh:*), Bash(git:*), Bash(ls:*), Bash(date:*), Read, Write
---

Run on the operator's word only: he types this command, in the session whose tab the
auditor should sit beside. Nothing of the audit stays with this session once it is launched.

Usage: `/orchestrator:audit <subject> [--since <date>]`. The subject is at most 25
characters: it becomes the title `Audit : <subject>`.

1. **Fill the brief.** Copy `${CLAUDE_PLUGIN_ROOT}/templates/agent-audit-brief.md` into the
   project's briefs directory as `audit-<date>-<subject>-brief.md`, and fill every
   `{{PLACEHOLDER}}` with what you can read, each path absolute:
   - the repository and the project's name;
   - the previous report: the newest file under `<briefs dir>/audits/`, or « none »;
   - the start: `--since`, else the previous report's date, else the repository's first
     commit;
   - the project's method files you know (its rules, its state file), or « none known »;
   - its dispatch record and bug register when it keeps them, or « none »;
   - `rhythm.sh`: the installed `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/rhythm.sh`,
     resolved now — the auditor's shell carries none of your variables;
   - the report: `<briefs dir>/audits/<date>-<subject>.md`.
2. **Lint it.** `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief-lint.sh <brief path> --expect-created <report path>`;
   repair any other finding before the spawn.
3. **Spawn**, beside this tab:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh spawn --dir <repository> --auditor --title "Audit : <subject>" --permission-mode auto --trust --prompt "Read and execute <brief path>"
   ```

   `--auditor` places the tab immediately left of this one, the chain ignored, on this
   session's model, under remote control under its title. It takes no chain and joins none,
   because the auditor is neither this session's successor nor its agent: this session's
   agents stay its own, and its next `--right-of self` still lands after its last agent. The
   title is required, and `Audit :` is refused on any spawn without `--auditor`;
   `--successor`, an anchor, `--title-free`, `--tier`, `--model` and `--no-remote-control`
   are refused beside it. `rotate` and `move` refuse a tab whose session is named `Audit :`
   unless `--force`. The auditor never closes this tab.
4. **Verify** that `iterm-agent.sh list` shows the `Audit : <subject>` tab and
   `iterm-agent.sh verify --tty <its tty>` its process.
5. **Tell the operator** in one line: the tab, and the report path. Then carry on with your
   own work: the auditor messages nobody, ends by itself, and the operator closes its tab.

$ARGUMENTS
