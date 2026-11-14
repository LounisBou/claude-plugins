# Review thresholds

Read before dispatching a review or comments round, before a verdict on a delivery, before you record a round or tell the operator a pull request is ready, and before a rebase. The evidence review is owed on every agent-produced pull request, small ones included; the norms check is on demand (`norms: required` in the check plan). The rules a verdict never crosses come first; the rest is how the round is run.

## Thresholds a verdict never crosses

They hold at every step of the loop, whatever the rest of this file adds.

**The check plan's `review` max sets the rounds (github `check-plan.ts`), each a review round then a correction round, and you close it.** Rounds repeated until nothing is left are the operator's own, by hand, never yours. The review round: ONE independent pass, in ONE review session, its readers sized by you; the `pr-review` loop it runs is `review_only` (one pass, no fix), and the norms check in it only where the plan requires one (`norms: required`). Its findings are verified on the artifact and judged against the design only: critical is what contradicts the design or the architecture, and only that is kept; the rest is set aside with its one-line reason, no follow-up row. The correction round: ONE phase carrying the kept items only, which you verify yourself on the artifact — the diff, the deciding tests, a mutation where the verdict rests on a test you have not seen fall. Then that round is done: no round past the plan's max, no over-correction; every other text of this plugin points here for the rounds and states none of its own. The gate's review record is written once, at the head you reviewed or at the correction's head once you verified it (« The record »). A rebase that leaves the diff unchanged keeps every record; one that changes it voids them: you read only its conflict resolution (`git range-diff` against the verified head, the suite on the new head) and record again, never a full re-review.

**Ready is the github ready gate's, at the current head** (`method:lifecycle`, « Done means ready »): you never declare it, and this file states none of what it holds. The gate puts `Ready` (a record, or the call `ci-watch.sh`'s green line ends with: run it), and `pr-readiness <n> ready` names what is missing. Once `Ready` is on, you tell the operator « ready »; never `pr-ready` outside auto-merge.

## Depth vs scope

- **Depth vs scope**: completing an ordered fix on its adjacent case (same rule, same class of failure) is YOUR call and belongs in the same corrective phase. New functional scope is the USER's call: relay, never decide. **Arbitrations are relayed with their context**: what the thing is on the screen or in the data, the two readings, and what each costs — never a bare identifier.
