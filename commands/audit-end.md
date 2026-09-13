---
description: End an audit — from the auditor, send the report and the ordered changes; from the orchestrator, acknowledge them and close the auditor's tab
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh:*), Bash(ps:*), Bash(ls:*), Bash(rm:*), Bash(date:*), Read, Write, Edit, ListAgents, SendMessage
---

End the AUDIT described in `orchestrator:orchestrator`, section « The audit ».
Load that skill first.

This command runs in either session, and does a different half in each. Read which one you
are before acting: an auditor's session is named `Audit : <subject>` and holds an audit
brief; an orchestrator's is named `Orch : <subject>` and holds a record under the state
directory's `audits/`.

## From the auditor

1. **Finish the report.** Write its last section — « 7. Method and limits » — and re-read
   the whole file against the fixed shape of your brief: seven sections, in order, every
   claim with its command. A section you could not reach is written as reached-so-far and
   named as such.
2. **Message the orchestrator**, at the exact `ListAgents` name and reference your brief
   names, in one message whose first line is « audit-end: <report path> », followed by:
   - the changes you ORDER, numbered, each with the measurement that justifies it;
   - the one line for the operator: tighten / loosen / nothing, and its reason;
   - when you end at the context gate rather than at the end of the audit: the section
     reached, and the sentence « continue from <report path> » — the orchestrator relaunches
     the audit with that scope, and the report is the next brief's previous report. You do
     not spawn anything: an auditor launches no session.
   - your measured context, from the gauge your brief names.
3. **End your turn.** Answer the orchestrator's acknowledgment with « ended » as your last
   message. Never close your own tab: the orchestrator closes it, and a session that kills
   itself mid-turn loses the turn.

## From the orchestrator

Run it on the auditor's « audit-end: <report path> » message, on your own decision, or on
the operator's word.

1. **Find the audit.** Read
   `${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/audits/<CLAUDE_CODE_SESSION_ID>.json`
   (your own session id; a successor that inherited the audit reads the record its
   predecessor named). It gives the auditor's name, tty and report path. `iterm-agent.sh
   list` — the tty must still show `Audit : <subject>`: a tty is recycled after a close, and
   a record is a claim about a moment.
2. **Read the report** at that path, all of it. Every ordered change is applied unless it
   contradicts the operator's word; the ones that do are named with the ruling they cross.
3. **Acknowledge in ONE message** to the auditor: each ordered change with « applied »,
   « scheduled: <when> » or « not applied: <the operator's ruling> ». If you end the audit
   before the auditor did (your decision, or the operator's word), that message asks it to
   finish its report and send « ended ».
4. **Wait for « ended ».** Five minutes without it: read the tab with
   `iterm-agent.sh screen --tty <auditor tty>`, and close only on a prompt with nothing in
   flight — never on the host's idle notice, which reaches a working session late.
5. **Close its tab**, the title guard on the audit's role:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh close --tty <auditor tty> --expect-title "Audit :"
   ```

   Then prove it: `ps -t <tty without /dev/>` shows no host CLI, and `ListAgents` no longer
   lists the auditor.
6. **Clear the record**: delete the `audits/<CLAUDE_CODE_SESSION_ID>.json` file, then `ls`
   the directory as the proof.
7. **Carry the orders.** The applied changes go where the method lives — the project's
   state file, its methodology file on the operator's word only, the briefs — in the same
   move, and the next audit reads them there. When the auditor ended at its context gate,
   relaunch `/orchestrator:audit <subject> --scope "continue from <report path>"`.
8. **Tell the operator** in one line: the audit ended, the report path, the line for the
   operator the report carries.

The report stays on disk, under the briefs directory's `audits/`, for the next audit to
read. Nothing else of the audit survives: no tab, no record, no session.

$ARGUMENTS
