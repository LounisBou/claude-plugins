# Incidents

The observed incidents behind the orchestrator's rules, each under the id of the rule it justifies. The rule lives where SKILL.md or its reference states it, with at most a one-line reason; the story that made it a rule is here.

## ORCH-005 — One writer per checkout

Observed cost: two spurious quality-gate failures (a database deadlock, then a schema rebuilt mid-run), and an agent resorting to `git stash push -u` to isolate itself, which risked orphaning the other's in-flight work.

## ORCH-013 — The seven duties

Seven duties. The first four were paid for in a single afternoon in which an operator said three times, in three different ways, that he was not being listened to. The next two were paid for in one round of review comments he had to reject as a whole, and the seventh in one morning of being asked about a pull request he had already merged and a deployment the project had already made.

## ORCH-019 — Executed term by term

Asked for « an orchestrator, with Remote Control, in an iTerm2 tab », a session produced an agent, in tmux, without Remote Control, and reported success.

## ORCH-022 — A method he names is a format

Observed: three comments agents were briefed on the workflow file, the orchestrator never opened it, and the operator received a cross-PR summary with no comment, no assessment and no change shown.

## ORCH-024 — A fact you did not read

Observed: a reviewer whose login is `misaert` was called, through a whole round, by a first name no command had ever printed, until the operator asked who that was.

## ORCH-028 — Re-read on the artifact in the same turn

Observed: a pull request he merged at 06:55 got a review round at 08:54 and a merge question, twice, at 09:40; the same round asked him to deploy main to production, in a project shipping through staging, which had held that change for an hour.

## ORCH-041 — A brief the session can open

Observed: an agent launched against a brief that existed nowhere it could reach, because the six previous briefs had been carried by hand and the seventh was not.

## ORCH-051 — The address is named, never discovered

An agent told « find the orchestrator with ListAgents » in a listing where three sessions share the prefix sent four reports and two requests to a sibling session that had once answered it, and waited seven hours for a reply that could not come, while the orchestrator waited for a report that had been sent.

## ORCH-062 — A brief points at a policy

Observed: an agent delivered a clean phase, was sent a one-line corrective to strip the trailers its host had appended, and STOPPED to say a peer could not authorise that — the correct answer to a brief that had overreached.

## ORCH-069 — Every command runs synchronously

This was the single most expensive failure mode observed: five occurrences in one session, costing multiple hours and forcing the orchestrator to finish the work by hand.

## ORCH-071 — No implementation through a subagent

Observed: successors told « read the plan » executed it in subagents of their own session.

## ORCH-089 — Literal domain values

Observed twice in one feature.

## ORCH-094 — Both readings

Observed: two deliveries were verified on the artifact — diff read, tests read, forbidden vocabulary grepped — and approved without the project's norms tooling ever having run on them, and the operator had to ask for it himself.

## ORCH-100 — One review round, one correction round

Observed: a « round 5 » of review described to the operator on a pull request whose round 4 was still running, then a review round planned on a four-line comment fix.

## ORCH-104 — The round ends on the record

Observed in one day: two rounds replaced the project's tool by a reading of its norms file, and two pull requests were about to leave draft on that evidence — the operator's question is what stopped it.

## ORCH-137 — Launching is yours

Observed on the first day a steward inherited this skill: it wrote two briefs and ended two reports by handing the user an invocation to paste, and left an agent at 83 % context running until the user said so.

## ORCH-139 — An agent is an iTerm2 tab

Observed, and struck out by his ruling: three agents spawned into tmux by a session whose launcher had stopped answering, invisible to every listing he had, two of them named after a whole brief path because that spawn was hand-rolled.

## ORCH-145 — Nothing waits for a human

Observed: an agent sat on « enable these MCP servers? » until the owner clicked.

## ORCH-181 — Succession is yours to trigger

Three failures observed on one succession, all critical: the orchestrator reported its context at the gate and offered the user a choice instead of spawning (the user had to say « the successor is not launched, what happens? »); the successor was spawned without the operator's decision mode, so it could stop at its first permission prompt in a tab nobody watches; and after « takeover confirmed » the predecessor's tab stayed open.

## ORCH-221 — A stand-down acknowledgment that reports anything uncommitted

An agent once reported « exactly the two staged files » in its acknowledgment, the orchestrator accepted it and closed the tab, and the fix survived in a worktree and a temporary file until a decision round found it.

## ORCH-222 — No finished tab is left around

Observed: an approved agent left open a whole day, then a second agent spawned beside it; and an agent kept « for a possible N-bis » through a merge nobody had scheduled, idle under memory pressure until the operator asked why.
