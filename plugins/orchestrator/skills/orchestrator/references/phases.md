# Phases

## Prerequisites and phase rules

### Prerequisites

A spec settled with the operator and a plan in the method's shapes (`method:lifecycle`, « The formats »), each phase adding its **exact interface signatures** (what a phase produces = what the next consumes; agents share no memory) and your review focus. No dispatch without both, and a `goals.md` beside the dispatch record, every goal of the spec in a phase or ruled out by the operator (`dispatch-record.sh goals <record> init --spec <path>|none`, which `open` requires). A plan section that moves goal work after the build is a goal without a phase: put it to him.

### Phase & PR rules

- One agent = one phase = one draft PR, stacked on the previous phase's **branch head**. Merges are never awaited.
- **One kind of change per phase.** A conversion (move, rename, extract) is proved by « nothing observable changed »; a behaviour change is proved by « the behaviour changed, and a test drives it ». A phase that mixes them cannot be proved either way, and it is the shape behind most review rounds that would not converge. Split when the diff mixes natures (mechanical refactor vs feature, infra vs domain): a reviewer should never need two mindsets for one diff. Never over-split: each PR stays coherent, independently reviewable, and green alone.
- **One writer per checkout, and a checkout per phase.** Never have two implementer agents holding the same working directory, even for disjoint files; a phase runs in a clone `workspace.sh create` makes for it, so the rule is structural and the orchestrator's own checkout is never lent out. Reviews are read-only and may overlap with anything; writes may not. If a repository is busy, queue the next dispatch.
- **Corrective phases** (phase 3's is « 3-bis »): after any review, fixups on that phase's branch with a narrow findings-list prompt. Never widen scope; new scope is the user's decision.
- Last phase = final verification: spec-conformity pass section by section, the proofs the check plan requires over the whole diff (github's `check-plan.ts`), and every row of `goals.md` ticked on its artifact.
