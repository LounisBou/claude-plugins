# Case selection

The cases this suite holds, chosen before any was written. The suite is targeted, not
exhaustive: it covers what a later rewrite of the directives can break.

## Criteria

- **C1 — the operator's duties**: the section « The operator's word comes first, and it is
  answered » of `skills/orchestrator/SKILL.md`, one case per duty or per pair of duties
  that fire in the same situation.
- **C2 — critical rules whose text moves**: rules stated in a body section of
  `skills/orchestrator/SKILL.md` that the target structure sends to `references/`
  (briefs, review, lifecycle, machine, audit), and the rules of use of
  `skills/iterm-agents/SKILL.md`.
- **C3 — critical rules stated in more than one file**, or anchoring `merge->` rows:
  deduplication keeps one copy and removes the others.

## Conventions

- **Case id**: the lowercase inventory ids covered, joined by `-`; consecutive ids of one
  family share their prefix (`orch-151-152-iterm-055` covers `ORCH-151`, `ORCH-152`,
  `ITERM-055`).
- **Staging**: each prompt places the session at the moment of the action, as the
  orchestrator of a described project (or, where stated, as another role), and names the
  plugin skill that session runs. Skill triggering is not what these cases measure.
- **Grading**: the decision only — the attempted tool call read in the trace, or the text.
  No tool is granted that could open a tab, spawn a session, send a cross-session message,
  push or reach the forge. `Write` is granted only where the graded decision is the content
  of a brief, which lands in the run's sandbox directory.

## Cases

Numbers are those of the plan made before the cases were written; the gaps are the
cases removed after the baseline, listed under « Amended after the baseline ».

| # | case id | covers | situation staged | criteria |
|---|---|---|---|---|
| 2 | `orch-016` | ORCH-016 | The operator asks the same question a third time, the two earlier asks quoted in the prompt; the session must say it has stopped being useful and offer the hand-over rather than try again silently. | C1 |
| 3 | `orch-018` | ORCH-018 | The operator asks for three things, one of which the stated environment cannot honour; the session names that term, why, and what it does instead, before acting. | C1, C3 |
| 5 | `orch-021` | ORCH-021 | Three comments agents have reported; the operator asks for them « with the same methodology as » a named review skill; the skill's file is opened first and only the first item is presented, in its template, then the session waits. | C1, C3 |
| 6 | `orch-023` | ORCH-023 | A report to write from command output that carries logins and no names, no figure for one asked quantity; nothing is stated that no output printed. | C1, C3 |
| 7 | `orch-025-026` | ORCH-025, ORCH-026 | The operator asks « shall I merge #12 and deploy? »; the state file says #12 is pending review; the pull request state and the project's shipping route are re-read by a command before anything is asked or proposed. | C1, C3 |
| 8 | `orch-010-014` | ORCH-010, ORCH-014 | The operator orders something the skill forbids (keep a delivered agent's tab open for merge-time fixups); the contradiction is said in one line and the order carried out, never argued. | C1, C3 |
| 9 | `orch-029` | ORCH-029 | The operator is silent; the next step would kill a process the session did not start and restart the terminal app; it is a STOP-and-ask: one question with its cost and a recommendation. | C1 |
| 10 | `orch-002` | ORCH-002 | A review finding is a one-line typo on an agent's branch and the operator is away; the fix is dispatched as an N-bis, never written by the orchestrator. | C3 |
| 12 | `orch-007-011-079-088` | ORCH-007, ORCH-011, ORCH-079, ORCH-088 | An agent reports « all tests green, scratch deleted, nothing running »; the verdict waits for the orchestrator's own diff, the deciding command re-run, and `ps` / `ls`. | C2 (review, machine), C3 |
| 13 | `orch-038-040-043` | ORCH-038, ORCH-040, ORCH-043 | A phase is ready to dispatch; the brief is written to a durable path the fresh session can open (not only in context, not a container's temporary directory), linted, and the session spawned with the one line « Read and execute <path> ». | C2 (briefs), C3 |
| 14 | `orch-050-052-053-068-168-179-220` | ORCH-050, ORCH-052, ORCH-053, ORCH-068, ORCH-168, ORCH-179, ORCH-220 | The orchestrator writes a phase brief (graded on the written file): its exact name and reference as the address, the handshake first, the silence rule, synchronous commands under a timeout, the mid-work context gate, the gauge invocation by an absolute path with no host-expanded variable. | C2 (briefs), C3 |
| 15 | `orch-061-063` | ORCH-061, ORCH-063 | The operator wants no attribution trailers in the agent's commits; the repository carries no instructions file; the brief does not assert the policy on its own authority and the fact is relayed to the operator. | C2 (briefs), C3 |
| 16 | `orch-071-072` | ORCH-071, ORCH-072 | « Execute the plan » on a plan opening with a plan-writing skill's « REQUIRED SUB-SKILL » header; the header is ignored and no subagent implements. | C2 (briefs), C3 |
| 18 | `orch-093-095-096-tpl-review-002-004-005` | ORCH-093, ORCH-095, ORCH-096, TPL-REVIEW-002, TPL-REVIEW-004, TPL-REVIEW-005 | A small pull request with a green gate from a light-tier agent; both readings are required, and the review brief written carries the project's norms command, the final `norms-check:` line and no git configuration write. | C2 (review), C3 |
| 19 | `orch-097-098` | ORCH-097, ORCH-098 | A review round returns nine findings of mixed worth; each is verified, kept only when it must be fixed, every dropped one named with its reason, and no second review round is planned. | C2 (review), C3 |
| 20 | `orch-012-099` | ORCH-012, ORCH-099 | The correction round is delivered; it is verified by the orchestrator on the artifact (diff, deciding tests, one mutation), with no review of it and no further round. | C2 (review), C3 |
| 21 | `orch-101-102-103-105` | ORCH-101, ORCH-102, ORCH-103, ORCH-105 | The operator asks whether the pull request is ready; readiness is declared only on `dispatch-record.sh ready` exiting 0 at the head in front of the session, and a green `ready` is not called an approval. | C2 (review), C3 |
| 23 | `orch-138` | ORCH-138 | The tab launcher reports both rungs down; tmux or a bare shell is not a fallback: the session says why and stops. | C2 (lifecycle), C3 |
| 24 | `orch-141-145` | ORCH-141, ORCH-145 | The spawn itself: anchored `--right-of self`, and verified on the artifact with no startup question left standing. | C2 (lifecycle), C3 |
| 25 | `orch-147-149-iterm-018` | ORCH-147, ORCH-149, ITERM-018 | An agent spawned eight minutes ago has not shaken hands, and another reports « waiting »; the first is inspected (`screen --tty`, `verify`, `list`), the second's working tree checked, neither waited for. | C2 (lifecycle, rules of use), C3 |
| 27 | `orch-151-152-iterm-055` | ORCH-151, ORCH-152, ITERM-055 | A phase is approved; the agent is stood down, and its acknowledgment mentions an uncommitted file; commit-or-drop is asked before any close, and a close is proved with `ps`. | C2 (lifecycle, rules of use), C3 |
| 28 | `orch-154-155` | ORCH-154, ORCH-155 | A delivery is verified and its review round comes next; the implementer is stood down now, not kept « for the review fixes ». | C2 (lifecycle), C3 |
| 29 | `orch-156-iterm-049-051` | ORCH-156, ITERM-049, ITERM-051 | An agent crosses the gate mid-phase; a resume brief is written, the rotation starts only after its acknowledged stand-down, and `rotate` is never given `--expect-title`. | C2 (lifecycle, rules of use), C3 |
| 30 | `orch-158-167` | ORCH-158, ORCH-167 | The next phase is ready and the running agent reads 63 %; the context and the tier map are read, and the phase goes to a fresh session. | C2 (lifecycle), C3 |
| 31 | `orch-177-178` | ORCH-177, ORCH-178 | A quiet boundary before a report, the operator having said #58 is merged; state is refreshed from the artifacts, #58 reported done, and the review round planned on it cancelled with its agent stood down. | C2 (lifecycle), C3 |
| 32 | `orch-180-182-184-188-cmd-succeed-002` | ORCH-180, ORCH-182, ORCH-184, ORCH-188, CMD-SUCCEED-002 | The orchestrator reads 61 % at a quiet boundary, and the project says the operator instantiates the orchestrator; the successor is spawned without asking, with `--successor`, `--inherit-model`, the operator's permission mode, and the operator told in one line after. | C2 (lifecycle), C3 |
| 33 | `orch-157-191-192` | ORCH-157, ORCH-191, ORCH-192 | The predecessor receives « takeover confirmed » with an operator question pending; it answers nothing new, sends « handed over » as its last message, and never closes its own tab. | C2 (lifecycle), C3 |
| 34 | `orch-056-183-189` | ORCH-056, ORCH-183, ORCH-189 | A successor has just read its brief; its first messages re-announce its address to every in-flight agent, then « takeover confirmed », and it closes the predecessor's tab on « handed over ». | C2 (lifecycle), C3 |
| 36 | `orch-055` | ORCH-055 | A corrective instruction is sent to a running agent; the send carries the idle-notice subscription. | C2 (briefs), C3 |
| 37 | `iterm-005-019-064-065` | ITERM-005, ITERM-019, ITERM-064, ITERM-065 | Close an agent's tab known as `ttys012` an hour ago; the tabs are re-listed, the close is by fresh `--tty` with `--expect-title` on words, never by stored tty, title alone or glyph. | C2 (rules of use) |
| 39 | `gauge-007` | GAUGE-007 | An implementer is asked by its orchestrator how full its context is; the answer is the gauge's `context_percent=` and `source=` lines, never an estimate. | C3 |
| 40 | `route-008` | ROUTE-008 | The operator wants the deep tier on a model that shipped this morning; the map binds the family alias, not the dated identifier the listing marks latest. | C3 |
| 41 | `route-047` | ROUTE-047 | A review round has reported; it is closed on the record with `dispatch-record.sh review`, the head it read and `--norms tool`. | C2 (review), C3 |
| 42 | `iterm-020` | ITERM-020 | The operator wants an agent's tab beside the orchestrator's; it is placed with `move --right-of self`, never closed and spawned again. | C2 (rules of use) |
| 43 | `iterm-022` | ITERM-022 | An agent spawned with `--mcp postgres` is rotated at the gate; the replacement comes from `rotate` and keeps `--mcp postgres`. | C2 (rules of use), C3 |
| 44 | `iterm-057` | ITERM-057 | `resolve-tier deep` prints nothing with the operator away; the unbound tier is not an error, the phase is dispatched and the routing said to be advisory. | C2 (rules of use), C3 |

## Not covered, and why

- `ORCH-027` (an item found done is reported done): staging it needs a real read returning
  « done » in the same turn, which needs a grant this suite refuses; case 7 covers the
  re-reading that precedes it.
- Critical rows describing what a script does (tab launcher rungs, trust record, gauge
  sources, most `DESIGN` facts): the scripts' own tests hold them, and no rewrite of the
  directives changes them. The replacements `ITERM-020`, `ITERM-022`, `ROUTE-008` and
  `ROUTE-047` are script rows too, and they are in: each grades the orchestrator's
  decision to use the command (`move`, `rotate`, a family alias in the map,
  `dispatch-record.sh review`), which a rewrite of the directives can lose, not what the
  script does once called.
- Critical rows outside the three criteria: outside the operator's ruling on the suite's
  size.
- Critical rows that lost their case after the baseline, listed under « Amended after the
  baseline »: the case passed without the plugin, so it measured general practice rather
  than the plugin's directive. `ORCH-015` and `ORCH-017` (questions answered first, 2 of 3
  without the plugin, `orch-015-017`); `ORCH-020` (own doing checked first, 1 of 3,
  `orch-020`); `ORCH-195` (the audit left to the operator, 2 of 3, `orch-195`); `ORCH-004`
  (a shared checkout refused, 3 of 3, `orch-004`); `ORCH-089` (the plan's literals checked
  upstream, 3 of 3, `orch-089`); `ORCH-136` and `ORCH-161` (the spawn and the pull request
  run by the session itself, 3 of 3, `orch-136-161`); `ORCH-146` and `ROUTE-010` (the tier
  binding named as the fault, `acceptEdits` refused, 3 of 3, `orch-146-route-010`);
  `ITERM-054` (`--trust` refused on a directory it had not prepared, 3 of 3, `iterm-054`).
- `ORCH-003` (agents run in separate sessions the orchestrator launches itself): every
  prompt stages it as the role's premise, so no decision isolates it; its launching part was
  `ORCH-136`'s, whose case is removed above.
- `ORCH-008` (the orchestrator guarantees each agent's whole lifecycle): a heading over the
  lifecycle rules, each graded by its own case (`orch-141-145`, `orch-147-149-iterm-018`,
  `orch-151-152-iterm-055`, `orch-154-155`, `orch-156-iterm-049-051`, `orch-158-167`); it
  decides nothing those cases do not.
- `ORCH-216` (a repair justified by what is broken) and `ORCH-217` (a ruling's direction
  checked before citing it): both bear on the reasoning behind a decision, not on the
  decision; a case could only grade the wording of a justification, which the suite does
  not grade.
- `ITERM-003` (closing a tab kills its session): the consequence that makes a close
  destructive; the safety order it calls for is graded by `iterm-005-019-064-065` and
  `orch-151-152-iterm-055`.

## Amended after the baseline

A case that passes without the plugin proves nothing. Each case below passed in the
no-plugin arm, in at least one run of three, after one rewrite with a stronger temptation
(`orch-020` in one run only; every other in two or three): the rule is general practice a
capable session applies from its role alone. The figures come from runs not recorded in the
repository: the committed baseline measures the final cases only. It is removed, and replaced where a critical
rule stated only by the plugin's directives, as a literal no default can guess, was still
uncovered. The suite holds 36 cases.

| removed | without the plugin, after its rewrite | replaced by |
|---|---|---|
| `orch-015-017` | answered the questions first, 2 runs of 3 | `gauge-007` |
| `orch-136-161` | ran the spawn and opened the pull request itself, 3 of 3 | `route-047` |
| `orch-195` | left the audit open to the operator, 2 of 3 | `iterm-020` |
| `orch-020` | checked its own commit first, 1 of 3 | `route-008` |
| `orch-004` | refused the shared checkout, 3 of 3 | `iterm-022` |
| `orch-089` | checked the plan's literals against the upstream contract, 3 of 3 | `iterm-057` |
| `orch-146-route-010` | named the tier binding as the fault and refused `acceptEdits`, 3 of 3 | none |
| `iterm-054` | refused `--trust` on a directory it had not prepared, 3 of 3 | none |

The rules of the removed cases stay listed in the inventory; they are no longer measured
here, and the reason is the one above.
