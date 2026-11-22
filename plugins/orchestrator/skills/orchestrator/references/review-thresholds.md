# Review thresholds

Read before dispatching a review or comments round, before a verdict on a delivery, before you record a round or tell the operator a pull request is ready, and before a rebase. The evidence review is owed on every agent-produced pull request, small ones included; the norms check is on demand (`norms: required` in the check plan).

## Thresholds a verdict never crosses

They hold at every step of the loop, whatever the rest of this file adds.

**The check plan's `review` max sets the rounds (github `check-plan.ts`), each a review round then a correction round, and you close it.** Rounds repeated until nothing is left are the operator's own, by hand, never yours. The review round: ONE independent pass, in ONE review session, its readers sized by you; the norms check in it only where the plan requires one (`norms: required`). The review session verifies its findings on the artifact and grades them against the design: critical is what contradicts the design or the architecture; a critical or important finding is kept and corrected before the merge, unless set aside with its one-line reason (an important one as `accepted`), no follow-up row; a minor is dropped. The correction round: ONE phase carrying the kept items only, verified by the gate and a reader at its head over those items — the diff, the deciding tests, a mutation where the verdict rests on a test not seen to fall; you read its line. Then that round is done: no round past the plan's max, no over-correction; every other text of this plugin points here for the rounds and states none of its own. The gate's review record is written once, at the reviewed head or at the correction's head once its reader's line is clean (« The record »). A rebase that leaves the diff unchanged keeps every record; one that changes it voids them: a reader reads only its conflict resolution (`git range-diff` against the verified head, the suite on the new head) and you record again, never a full re-review.

**Ready is the github ready gate's, at the current head** (`method:lifecycle`, « Done means ready »): you never declare it. The gate puts `Ready` (a record, or the call `ci-watch.sh`'s green line ends with: run it), and `pr-readiness <n> ready` names what is missing. `Ready` on: in auto-merge you merge; outside it, tell the operator « ready ».

## Depth vs scope

- **Depth vs scope**: completing an ordered fix on its adjacent case (same rule, same class of failure) is YOUR call and belongs in the same corrective phase. New functional scope is the USER's call: relay, never decide. **Arbitrations are relayed with their context**: what the thing is on the screen or in the data, the two readings, and what each costs — never a bare identifier.
