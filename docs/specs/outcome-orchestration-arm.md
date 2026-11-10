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

## Review notes (2026-11-11)

The design above makes the arm measure an orchestration; these notes concern what its figures
may then be read to say. They propose; the design stays accepted as it is.

1. **One run per arm is one draw.** The orchestrator's behaviour baselines give different
   results on the same version for about one case in five (8 of 36 at 0.34.0, 4 of 19 at
   0.36.0; `learning-design.md`, review note 7). The measure runs each of six cases once per
   arm, so a single-against-orchestration difference below a collapse is not measured: the
   report gives each case's pair of results side by side and states that no difference of
   that size is detectable, rather than a gap between the arms' totals.
2. **Code-computed grades decide, the judge's report.** Suite and reference tests decide
   which arm did better on a case; intent and review, judged by a model, are reported beside
   them, as `learning-design.md` sets for every regression (its question 5).
3. **Outcome and cost together.** An orchestration opens more sessions and spends more. A
   better outcome at a higher cost is a trade-off, not a win: the report gives each arm's
   result with its cost on the same line, and names an arm better only when it is no worse on
   both.
4. **« Not graded » is part of the result.** The orchestration arm has ways to end not graded
   that the single arm lacks (no agent opened, the 10-minute bounds). Dropping those cases
   compares the orchestrations that worked with every single session. The report counts not
   graded per arm, and gives the comparison a second time with each not-graded arm counted
   as failed.
5. **What « no operator » measures.** The arm measures an orchestration that decides its own
   questions, not one the operator steers. The count of questions it decided alone, already
   in its report, says how far the figure is from the operator's use; a case where it decided
   many is read with that count.
6. **Cases newer than the model.** A case merged before the evaluated model's training
   cutoff may have been seen. The nine current cases were all merged on 2026-11-08, the day after
   this repository was created. Each case, and every one added later (`learning-design.md`,
   review note 6), is checked against the training cutoff of the model the run names.
