# Phases

## Prerequisites and phase rules

### Prerequisites

A spec settled with the operator and a plan in the method's shapes (`method:lifecycle`, « The formats »), each phase adding its **exact interface signatures** (what a phase produces = what the next consumes; agents share no memory) and your review focus. No dispatch without both, and a `goals.md` beside the dispatch record, every goal of the spec in a phase or ruled out by the operator (`dispatch-record.sh goals <record> init --spec <path>|none`, which `open` requires). A plan section that moves goal work after the build is a goal without a phase: put it to him.

### Phase & PR rules

- One agent = one phase = one draft PR, stacked on the previous phase's **branch head**. Merges are never awaited.
- **Dispatch every row that can run, now.** An open row whose files collide with no running agent's is dispatched this turn; dependent work is stacked (« Stacks and their light CI »), never queued « after » another pull request. « After the series » and « one after the other » are never a reason to wait. The only waits: a file collision with a running writer, the operator's consent, a release a removal requires.
- **One kind of change per phase.** A conversion (move, rename, extract) is proved by « nothing observable changed »; a behaviour change is proved by « the behaviour changed, and a test drives it ». A phase that mixes them cannot be proved either way. Split when the diff mixes natures (mechanical refactor vs feature, infra vs domain); never over-split: each PR stays coherent, independently reviewable, and green alone.
- **One writer per checkout, and a checkout per phase.** Never have two implementer agents holding the same working directory, even for disjoint files; a phase runs in a clone `workspace.sh create` makes for it, so the rule is structural and the orchestrator's own checkout is never lent out. Reviews are read-only and may overlap with anything.
- **Corrective phases** (phase 3's is « 3-bis »): after any review, fixups on that phase's branch with a narrow findings-list prompt. Never widen scope; new scope is the user's decision.
- Last phase = final verification: spec-conformity pass section by section, the proofs the check plan requires over the whole diff (github's `check-plan.ts`), and every row of `goals.md` ticked on its artifact.

### Stacks and their light CI

- **Stack the dependent pull requests**, 2 to 4 per stack, each on the previous branch head; an independent phase takes the main branch. Merge top-down with merge commits, the bottom last. Re-merge the base into a stacked branch only on a conflict or when the files overlap (CI runs on the merge ref). Ready: the bottom one on full green CI; a stacked one on its review plus its local tests recorded at its head, or its required checks green there.
- **Light CI.** Before a repository's first stacked pull request, run `mcp__github__light_ci status {repo}`. `configured` or `off`: nothing more. `missing`, and CI skips a stacked base or its median pull request run exceeds 5 min: ONE question for the repository in the Q4-A shape, choices A yes with the proposed command (recommended), B yes with another, C not for this project (never asked again), D not now (asked at the next stack). Record it in `~/.claude/light-ci/<owner>-<repo>.json`: A or B `command` and `decided` (his words), C `off`, D nothing. The stack opens as drafts meanwhile; after each push on a stacked pull request, `mcp__github__light_ci run {pr}`.
