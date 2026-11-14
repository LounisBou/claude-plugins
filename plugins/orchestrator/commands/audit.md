---
description: Launch an audit of the method, on the operator's word
argument-hint: <subject> [--since <date>]
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief-lint.sh:*), Bash(git:*), Bash(ls:*), Bash(date:*), Read, Write
---

Run on the operator's word only: he types this command, in the session whose tab the
auditor should sit beside, or says « yes » to a proposed audit. Nothing of the audit stays
with this session. A measurement goes to a read-only subagent.

Usage: `/orchestrator-audit <subject> [--since <date>]`. The subject becomes the title
`Audit: <subject>`.

1. **Fill the brief.** Copy `${CLAUDE_PLUGIN_ROOT}/templates/agent-audit-brief.md` into the
   project's briefs directory as `audit-<subject>-brief.md`, and fill every
   `{{PLACEHOLDER}}` with what you can read, each path absolute, and write under the title
   the kind (retrospective, measure or costed design), his words, the question and what is
   established, in about ten lines; a costed design needs thirty at most:
   - the repository and the project's name;
   - the previous report: the newest under `<briefs dir>/audits/`, or « none »;
   - the start: `--since`, else the previous report's date, read from
     the previous report's file name, which a command wrote, else the repository's first
     commit;
   - the project's method files you know, or « none known »;
   - its dispatch record and bug register, or « none »;
   - `rhythm.sh`: the installed `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/rhythm.sh`,
     resolved now — the auditor's shell carries none of your variables;
   - the launcher, `${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh`, and the
     succession template, `${CLAUDE_PLUGIN_ROOT}/templates/auditor-succession-brief.md`, both
     resolved now: an auditor kept on past its report succeeds with them;
   - the report: `<briefs dir>/audits/<date>-<subject>.md`, where `<date>` is the output of `date +%F` run now, never typed.
2. **Lint it.** `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief-lint.sh <brief path> --expect-created <report path>`;
   repair any other finding before the spawn.
3. **Spawn**, beside this tab:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh spawn --dir <repository> --auditor --title "Audit: <subject>" --permission-mode auto --trust --prompt "Read and execute <brief path>"
   ```

   `--auditor` places the tab immediately left of this one; it joins no chain. The auditor
   never closes this tab.
   On a non-zero exit, run the `move` the line on stdout prints and never relaunch; on
   « unverified » or « API is not available », read `list` and move the tab only if misplaced.
4. **Verify** that `iterm-agent.sh list` shows the `Audit: <subject>` tab and
   `iterm-agent.sh verify --tty <its tty>` its process.
5. **Tell the operator** in one line: the tab, and the report path. Then carry on with your
   own work: the auditor messages nobody but an orchestrator he orders it to, ends by itself,
   and the operator closes its tab; a successor closes its predecessor's.

$ARGUMENTS
