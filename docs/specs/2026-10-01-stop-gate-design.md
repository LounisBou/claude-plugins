# Stop gate — an orchestrator stops only when nothing can advance

Status: design, approved in conversation by the operator on 2026-10-01; this file is the
written spec for his review.

## 1. Problem

Two failures, observed repeatedly in real orchestrations:

1. **Announced work, nothing launched.** The orchestrator writes « I am launching X » or
   « preparing the brief », then ends its turn with no agent running. An orchestrator is
   woken only by an agent's message, an idle notice it subscribed to, or the operator; with
   none of them pending, the build sits idle until the operator notices. A rule against it
   exists (in the orchestrator's memory) and has not held.
2. **Inaccurate CI reports.** Twice the orchestrator stated « the only red is known » or
   « the reds are fixed » about a pull request's GitHub checks before they had finished,
   and it was false: its own push had turned the checks red, or nothing was fixed. The rule
   « a fact you did not read is a fact you do not state » exists and has not held.

Both happen at the same moment: the orchestrator ends its turn on a message. The repair is
a mechanism at that moment, not another sentence.

## 2. Goal and principle

The orchestrator's first objective, in the operator's words: **advance the work without
losing time, and stop only when there is not enough to advance.** A question to the
operator does not justify a stop unless it blocks what remains; a non-blocking question is
asked, and everything that can advance does, in the same turn.

Two axes bound every choice below: conformity to that objective, and token use. A refused
stop replays the whole cached context (about 150k tokens for an orchestrator mid-build), so
a false refusal is the most expensive thing this mechanism can do: precision over recall.

## 3. Architecture

One hook, `hooks/stop-gate.sh`, registered on the host's `Stop` event in `hooks/hooks.json`
beside `context-gate.sh` and `push-guard.sh`.

**Host contract used.** The hook reads on stdin `session_id`, `cwd`,
`last_assistant_message` (the full text of the turn's final message) and `stop_hook_active`.
It refuses a stop by printing `{"decision": "block", "reason": "<text>"}` and exiting 0;
the model resumes with the reason. The host forces the stop after 8 consecutive refusals.

**Scope.** The hook acts only in an orchestrator's session: one whose session name, read
the way the plugin's other scripts read it (the session's tty in the launcher's listing),
starts with `Orch :`. Everywhere else — agents, auditors, the coordinator, sessions started
by hand without that name — it exits 0 at once.

**Loop guard.** When `stop_hook_active` is true the stop passes: at most one refusal per
turn.

**Its own failures never block.** A missing tool, an unreadable listing or a network error
lets the stop pass and appends one line to the hook's log (§6); the hook never holds a
session on its own fault.

**Silence on a legitimate stop.** A stop that passes writes nothing into the context.

## 4. Check 1 — what will wake you

The stop passes in exactly three cases, checked in this order:

1. **An agent of this orchestrator is busy.** Its idle notice will wake the orchestrator.
   « Of this orchestrator » is read from the chain the launcher already keeps per
   orchestrator tty (`chain_append` in `skills/iterm-agents/scripts/iterm_agent.py`, one
   entry per agent spawned with `--right-of self`, handed to a successor by
   `chain_transfer`). « Busy » is the tab's activity glyph in the launcher's listing — the
   same glyph `list` prints (`✳` idle, a spinner glyph busy). Inferred, nothing declared.
2. **A blocking question is pending.** The message carries the question and the machine
   line `waiting: operator — blocks: <what it blocks>`. Without that line a question does
   not justify the stop.
3. **Nothing is left to advance.** The machine line `waiting: done`, checked against the
   facts: no checkout of the project in `workspace.sh list` and no agent of this
   orchestrator running. A checkout or a running agent means work is in flight.

The machine line is the message's last non-empty line, matched as
`^waiting: (operator — blocks: .+|done)$`.

Otherwise the stop is refused, with the reason that fits:

| Case | Reason sent back |
|---|---|
| no busy agent, no valid line | « Nothing will wake you: no agent of yours is running. Launch what you announced, or end with `waiting: operator — blocks: …` if a question truly blocks, or `waiting: done`. » |
| only idle agents | « <agent> is idle: its notice was spent. Read its report or relaunch it. » |
| a question without `blocks:` | « Your question blocks nothing declared: advance everything that can advance; its answer will come in a later turn. » |
| `done` against a checkout or a running agent | « Not done: <checkout or agent> is still there. Finish it, or say what blocks it. » |

**What the hook cannot verify**, left to one sentence of the orchestrator's skill: that a
question declared blocking truly blocks everything, and that an orchestrator waiting on an
agent had no other work to dispatch in parallel. The sentence: « Before ending a turn,
launch everything that can advance; stop only when nothing can advance without the
operator's answer. » The log of `blocks:` reasons (§6) is what shows a blocking claim made
wrongly.

## 5. Check 2 — the real CI state reaches the orchestrator before its report

Ruled by the operator (2026-10-01): the check triggers on FACTS, never on the words of the
message. A list of claim words fails open on any rewording (« all repaired », « the PR is
sound ») and in any language; a fact does not.

Runs only when Check 1 let the stop pass.

**Trigger.** The open pull requests of the session's repository (`gh pr list --state open`
in `cwd`) whose head differs from the head this hook last reported for this session. The
hook keeps, per session, the head it last reported for each pull request
(`<state dir>/stop-gate/<session_id>.heads`). A pull request whose head has not moved
costs no further call.

**Facts.** For each such pull request, `gh pr checks <NNN>` on its current head.

**Refusal, once per head.** When any check on that head is pending or failing, the stop is
refused with the real state, and the head is recorded as reported, so the same head never
refuses twice:

« #NNN at <short sha>: <n> checks pending (<names>), <m> failing (<names>). Report this
state as it is, or wait for the end in one call: `timeout 590 gh pr checks NNN --watch`. »

All checks finished and passing: the head is recorded, the stop passes, nothing is
written. The hook judges no cause and reads no claim: it puts the real state in front of
the orchestrator before the message it ends on, whatever that message says.

**Limit, stated.** The hook does not stop the orchestrator from writing a false sentence
AFTER the real state reached it; it stops it from writing one without that state in front
of it, which is the shape of both observed cases.

## 6. Measurement — every change is a trial

The hook appends one line per refusal and per `blocks:` stop to
`<state dir>/stop-gate.log`: timestamp, session name, check, case, and for `blocks:` the
reason. Expected gain: zero stops the operator has to restart by hand for announced work,
and zero CI states stated against the checks. Figures to re-read after a few real phases:
refusals per session, refusals judged wrong on reading the log, `blocks:` reasons judged
wrong, against the operator's own restarts.

## 7. What the mechanism replaces

The rule now lives in memory files (`never-end-a-turn-on-announced-work`), not in the
skill. Once the hook ships: that memory shrinks to a pointer to the hook; the orchestrator's
skill gains the one sentence of §4; the « Carried at every step » section of
`skills/orchestrator/SKILL.md` names the machine line in one clause.

## 8. Edge cases

- A question followed by a fenced block or blank lines: the machine line is the last
  non-empty line; the question itself may sit anywhere above it.
- Several agents, some idle and some busy: one busy agent of this orchestrator suffices.
- An agent of another orchestrator: not in this orchestrator's chain, never counted.
- A successor: inherits its predecessor's chain through `chain_transfer`, so its agents
  count from its first turn.
- `gh` absent or offline: Check 2 passes, logged.
- A pull request whose head has not moved since the last report: no `gh pr checks` call.
- A head moved by someone else (an agent, the operator): reported like the orchestrator's
  own; the push's author does not matter, the state on the head does.

## 9. Tests

- `tests/run-tests.sh`: the hook fed simulated stdin, a fake listing, a fake chain file, a
  fake `workspace.sh list` and a fake `gh` on `PATH`. One check per row of Check 1's
  refusal table, per Check 2 case (pending, failing, all green, head unchanged, refused
  once then passing for the same head) and per pass case, each seen to fall when its branch is removed; the loop
  guard; a non-orchestrator session untouched; a tool failure passing.
- Two eval cases, graded by what the session does after a refusal:
  1. announced work, no agent running: refused once, then the agent is launched in the
     same turn;
  2. a non-blocking question and a ready phase: the question is asked AND the phase
     dispatched in the same turn, ending without a stop the hook refuses.
- `tests/e2e.sh` is not touched: the hook runs no tab.

## 10. Out of scope

- A question asked needlessly (« shall I continue? ») with a `blocks:` line: allowed by
  the hook, visible in the log.
- Claims about local suites: the operator's two cases were GitHub checks.
- The wording of the orchestrator's report: no check reads it (ruling of 2026-10-01).
- Agents' own stops: an agent is held by its brief and the orchestrator's verification.

