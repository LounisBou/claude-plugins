---
description: Launch an audit of the method, on the operator's word
argument-hint: <subject> [--since <date>]
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief.sh:*)
disable-model-invocation: true
---

Run on the operator's word only: he types this command, in the session whose tab the
auditor should sit beside, or says « yes » to a proposed audit. Nothing of the audit stays
with this session. A measurement goes to a read-only subagent.

Usage: `/orchestrator-audit <subject> [--since <date>]`. The subject becomes the title
`Audit: <subject>`.

1. **Print the brief.** Run, the texts in his language, each a line or two:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief.sh audit --subject <subject> --repository <repository> --briefs <the project's briefs directory> --kind retrospective|measure|design --words "<his words>" --question "<the question>" [--established "<what is established>"] [--since <date>] [--reading "<the project's method files>"] [--records "<its dispatch record and bug register>"]
   ```

   It finds the previous report under `<briefs>/audits/` and starts at its date (else the first
   commit), dates the report, resolves every path, and prints the brief's path and the report's.
2. **Spawn**, beside the audited orchestrator: this session, or the one he names,
   with `--of <its tty>` (from `iterm-agent.sh list`) added to the line below:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh spawn --dir <repository> --auditor --title "Audit: <subject>" --permission-mode auto --trust --prompt "Read and execute <brief path>"
   ```

   `--auditor` places the tab immediately right of the audited orchestrator's; it joins no
   chain. The auditor never closes this tab.
   On a non-zero exit, run the `move` the line on stdout prints and never relaunch; on
   « unverified » or « API is not available », read `list` and move the tab only if misplaced.
3. **The spawn's success line is its proof**, read once.
4. **Tell the operator** in one line: the tab, and the report path. Then carry on with your
   own work: the auditor messages nobody but an orchestrator he orders it to, and ends by itself.
5. **Close its tab yourself** once the auditor has delivered its report and you have relayed
   its verdict to the operator: `iterm-agent.sh close --tty <its tty> --expect-title "Audit: <subject>"`.
   It stays open only on his word.

$ARGUMENTS
