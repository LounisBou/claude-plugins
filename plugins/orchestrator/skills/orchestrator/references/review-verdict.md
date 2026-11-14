# Review verdict

## Review on evidence

### The checks

For each delivery, run yourself (read-only):
1. Git layout: branches, bases, commit messages; diffs disjoint between stacked PRs.
2. Diff stats: no forbidden files, no scope creep.
3. Domain artifacts field-by-field against the spec, including checking house patterns the spec may have missed (spec omissions are YOUR findings to fix in the spec).
4. Grep the diff and commit log for what the workflow artifacts policy forbids (`references/standing-rules.md`, standing rules).
5. Norms: read one core file and one test file for them only where the plan requires `norms` (github's `check-plan.ts` says what a plan requires); otherwise no norms reading.
6. Re-derive the agent's proofs: a verification procedure the agent invented may have a hole (e.g. a schema diff that also captures pre-existing drift, so demand differential baselines).
7. **Treat claimed command output as a claim — cleanup claims included.** Re-run the one command whose result decides your verdict, or check the artifact directly. Internal consistency of a report proves nothing.
8. **Verify literal domain values the plan supplied.** Field names, numeric bounds, enumerated catalogues: check them against the authoritative source, not against the plan: a shape-checking test passes the right count of wrong names.
9. **A norms file can be aspirational.** Before accepting a norms finding, check whether existing code contradicts it: a rule the codebase widely violates is a convention question for the user, not a defect in the new diff. Enforce it on new code, do not manufacture findings from it.
10. **Ask of every test and every guard: what does it NOT read, and what would it still read if the behaviour were gone?** A gate green over what it does not read is the most common shape of false proof: a guard that counts its own prose, a test that passes on the code it was written against, a hold made tautological by the repair beside it. When the verdict rests on a test you have not seen fall, mutate it on purpose: break the behaviour, watch the test fall and name the right defect, restore.
11. **A fall under load is a finding until its mechanism is named.** « Flaky, passes alone » is a conclusion nobody earned; re-running until green is the habit by which a real fall elsewhere gets dismissed as this one. Demand the mechanism (shared state, ordering, a wait shorter than the drawn duration), and if the run must be repeated, say in the same breath that the re-run removed the load the failure needed.
12. **A pull request that creates or substantially modifies a frontend surface is not read on its diff alone.** A missing or unrelated screenshot is a finding. Before the verdict, dispatch `orchestrator:screenshots` at the standard tier with `<owner/repo>#<n>`, its head sha, what the diff changes on screen and the checklist file, `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/references/screenshot-checklist.md`. You never open the batch yourself: on doubt about one capture, open that one only. Relay its lines « per the screenshots agent »: an `unreadable:` line is an image not audited. A defect on a capture is a finding, and the pull request is not ready. Record its reply with `dispatch-record.sh audit <record> <id> --head <sha> --images <n> [--defect "<text>"]...`, and at the verdict `dispatch-record.sh surface <record> <id> --ui <owner/repo>#<n>`, `--minor <reason>` or `--none`, for every open pull request of the batch: `ready` refuses the rest.
13. **A diff that changes an existing test's assertions is read first.** Most edits that game a suite land in its test files. Each such change is a finding, kept unless the brief or a ruling ordered it: a weakened expectation, a removed case, a widened tolerance, a test skipped.
14. **The E2E the pull request's check plan requires is replayed and recorded.** `e2e: required`: the review replays it, you record the run with `mcp__github__record` (`pass`, `fail`). `none: <reason>` or `screenshots: <reason>`: the plan settles it, nothing is recorded. With no plan, record `not-applicable` with its reason when no file holds runtime. A required E2E or norms check now unneeded: a new check plan, that check `none: <reason>`, no question. One that cannot run: ONE question through the round (`declare_wait` operator, `consent_kind`, `consent_repo`, `consent_pr`), worded as github `writing/pull-requests.md` « Ready pull requests » says.

### The record

**And the round ends on the record, not on memory.** `dispatch-record.sh <review|fixed|ready> <record> <id> --head <sha>`: `review` records the review round (`--norms tool|none` only when a norms check ran), `fixed` the correction you verified, `ready` checks what the github gate does not read: the surface and the screenshots' audit (`orchestrator:model-routing`, « The record »). It is your pre-check, never the ready. The gate's review record is yours: at the head the rule above names (« Thresholds a verdict never crosses »), write it from a clean checkout at that head with `mcp__orchestrator__review`, its schema naming the fields: `verdict` is `pass`, `fail` while a critical item is left, or `accepted`; `kept` lists the findings a `fail`'s correction round fixes, `set_asides` each point set aside with its one-line reason, which `accepted` requires. A failed record of another reviewer at that head is answered the same way.

### The verdict message

Verdict message back: findings list (fix items), approved decisions (say so explicitly), and answers to every question the agent flagged. Approve or dispatch a correction; never silently accept.
