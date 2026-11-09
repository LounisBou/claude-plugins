# The orchestration arm, run as an orchestration

Status: accepted.

## The defect

The outcome evals' orchestration arm runs the host headless (`claude -p`) with the prompt
`/orchestrator:orchestrator <brief>`. Two pilots on the operator's machine show it never
orchestrates:

- The skill's argument is its mode, `build` or `investigate`. The arm passes the brief there,
  the skill reads no mode, cannot ask for one headless, and the session writes the change
  itself.
- An orchestrator ends its turn to wait: after naming itself, after each spawn, on each
  report it waits for. A headless run ends at the first turn's end, so even with its mode it
  would stop before any agent delivered.

The second pilot (claude-plugins#90 merged) loaded the orchestrator and graded a single
session's work as an orchestration. Every figure of that arm so far measures the single arm
twice.

## The design

The orchestration arm becomes an interactive orchestrator session, opened and driven by the
harness the way the operator opens one, on the same machine and plugin release:

1. **Open.** The launcher of the checkout's `plugins/orchestrator` spawns
   `Orch: eval <case id>` in the bench, detached from the operator's windows (the home
   session's tmux, its own socket), Remote Control off, with the checkout's orchestrator and
   its dependencies as `--plugin-dir`, the eval's settings file, and the startup prompt
   `/orchestrator:orchestrator build` followed by the brief. The orchestrator spawns its
   agents as it always does; they land in the same detached home.
2. **No operator.** The brief tells the orchestrator that no operator answers in this run: each
   question it would ask is decided by its own recommendation, recorded in its state file, and
   the run goes on; the report lists the decisions so taken. It spawns every agent with `--dir`
   set to the graded checkout, never through `workspace.sh create`, one agent writing at a
   time. A turn that still declares a wait on the operator ends the arm, reported `stopped:
   asked the operator` with the question, and graded on what it left.
3. **Done.** The harness polls the orchestrator session's transcript. The arm ends on the
   first turn whose declared wait is `done`, on a turn that waits on the operator, on its
   share of the cap (the deck meter, counting only the sessions on its home's panes), or at
   the arm's deadline. Only a declared wait decides, never a last line's wording. An
   orchestrator that has neither declared a wait nor opened an agent after 10 minutes, or whose
   meter still reads nothing 10 minutes after its first agent, ends the arm as not graded.
4. **Close.** Every session the arm opened, the orchestrator first, is closed through the
   launcher's own `close`, and the harness proves none is left by reading the home's server
   gone, closing it once more if not. A failed opening closes the home servers it left.
5. **Graded the same.** The bench is graded as the single arm's is: suite, reference tests,
   intent, review, files, cost, duration. The report adds the number of agent sessions the
   orchestration opened; an orchestration that opened none is reported `not graded: no
   agent opened`, never as an orchestration.

## What it costs and what it proves

- A pilot replays one case with a real orchestration: more sessions, so more spend than the
  two pilots' 1.83 and 1.53 USD; the run stays under `caps.json` (20 USD a pilot, 10 USD an
  arm), and an arm stopped at its cap is still graded.
- The dry run keeps its oracle; the new driver is tested against a fake host and a fake
  launcher, as the headless one is.

## Decided

- Questions the orchestrator would put to the operator are decided by its own recommendation,
  and the run goes on (the operator's choice, 2026-11-09).
