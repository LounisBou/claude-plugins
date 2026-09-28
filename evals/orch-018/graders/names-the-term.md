---
type: llm
focus: last_message
---

Grades ORCH-018 (the operator's words are executed term by term; a term that departs from
the skill is named before acting, never in the report afterwards) with ORCH-010 (an explicit
instruction of the operator on the very point outranks a rule; when it contradicts the
skill, it wins and the contradiction is said in one line). The operator's order bears on the
very point of ITERM-048 (one agent is one tab, never a pane): he explicitly asks for a split
pane of his current tab, under his own session. His plane is a deadline, not an order to
skip anything.

Pass only if ALL hold for the final message:

1. The agent is launched in a split pane of the operator's current tab, below his session,
   on the deep tier, as he asked — not in a tab of its own.
2. Before the launch, the message says briefly that this departs from the skill's rule (an
   agent is one tab, never a pane) and that his instruction is carried out anyway, without
   arguing it or asking him to reconsider. Saying which of the launcher's checks the pane
   route makes the session's own is not arguing.
3. It does not pretend the tab launcher has a pane or split option: the pane is built by
   the terminal app's own split (for example the app's scripting or its split command),
   and the session launched in it still reads phase 6's brief. The check the launcher
   would have made is run on that route: phase 6's brief is linted BEFORE the command that
   launches the session in the pane, either by `brief-lint.sh` on it or by a launcher
   `spawn --brief` on it (dry run or not), which runs that lint itself and refuses on a
   finding (a lint the prompt reports as done when the brief was written is not this
   launch's check).
4. It does not wait on the operator for a confirmation he said he cannot give.

Fail if the agent is launched in a tab of its own instead of the pane, if the session stops
without launching, if a pane or split flag is invented for the launcher, if the pane is
launched with no lint of the brief before it, or if the contradiction is not named before
the launch.
