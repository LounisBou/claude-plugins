#!/bin/bash
# dispatch-record.sh - one row per dispatch, and the signal the routing rule needs.
#
#   dispatch-record.sh open    <record> --class <c> (--tier <deep|standard|light> | --model <alias> [--effort <level>]) [--label <text>] [--cascade] [--explore]
#   dispatch-record.sh round   <record> <id>
#   dispatch-record.sh review  <record> <id> --head <sha> --norms tool|none
#   dispatch-record.sh fixed   <record> <id> --head <sha>   (the one correction round, verified)
#   dispatch-record.sh surface <record> <id> (--ui <owner/repo>#<n> | --minor <reason> | --none)
#   dispatch-record.sh audit   <record> <id> --head <sha> --images <n> [--defect "<text>"]...
#   dispatch-record.sh ready   <record> <id> --head <sha> --e2e "<the E2E line>" [--e2e-waiver "<his words, dated>"]
#   dispatch-record.sh exempt  <record> --e2e "<his words, dated>"   (the operator exempts this session's pull requests from E2E)
#   dispatch-record.sh close   <record> <id> --verdict <text>
#   dispatch-record.sh defer   <record> <id> --ruling "<his words, dated>"   (the operator deferred this open row)
#   dispatch-record.sh undefer <record> <id>
#   dispatch-record.sh escaped <record> <id>      (a defect got past this row's review)
#   dispatch-record.sh cost    <record> <id> --session <session id> [--recount]   (adds that session's measured cost)
#   dispatch-record.sh summary <record> [--open [--ids | --label <id>[,<id>...]]]
#   dispatch-record.sh goals   <record> init --spec <path>|none [--aim "<text>"] [--goal "<text>"]... [--replace]
#   dispatch-record.sh goals   <record> status | plan <G> --phase "<text>" | met <G> --evidence "<token>"...
#   dispatch-record.sh goals   <record> rule-out <G> --ruling "<his words>" | defer <G> --ruling "<his words, dated>"
#   dispatch-record.sh goals   <record> reopen <G> | check [--json]
#
# `open` prints the row id. `summary --open` prints only the open rows, for a takeover that
# has no use for the statistics. `--ids` narrows it to one `<state>=<count>` line per state, then
# `ids: <id> <id> ...`, no label; `--label <ids>` prints the full line of the open rows named,
# nothing else, and says on stderr which named row is closed or absent. A successor reads the
# counts and the ids, then the labels of the rows its Live state omits: 99 open rows printed
# whole once cost a birth 25,371 characters. A row (or a goal) the operator deferred stays open and carries
# his ruling; the summary shows it as `deferred=` with that ruling, and the stop gate takes the
# ending `waiting: deferred — <n> items`, n the deferred rows and goals together, once every row
# and goal still open is one. The record is JSON lines: appendable, greppable, and read back
# with the `jq` the rest of this plugin already needs.
#
# Why it exists: the routing rule says a tier drop that costs a second corrective round is
# reverted for its class. Nothing measured that, so the rule could only be applied from
# memory - and an economy nobody measures is one that always looks free, because its cost
# lands rounds later where nobody attributes it. `summary` names the classes where the
# drop did not pay, so the reversion is a reading rather than an impression.
#
# A green `ready` (head read, or corrected and verified) also prints one line naming the
# command that puts the `Ready` label, `pr-readiness <n> ready on <owner/repo>`, the pull
# request read from a `--ui` row; the orchestrator runs it with the github tool. This script
# never calls the network.
#
# `review` and `ready` carry the second rule the record is asked to hold: a pull request is
# ready only when a review session read ITS head (either side may abbreviate the other, from
# 7 characters) and the project's own norms check ran there - or when the head is the one
# correction round that review produced, which the orchestrator verified on the artifact.
# A row with no review is refused, as the github ready gate refuses a pull request with no
# review at its head. `fixed` with no review, or a second time, records what it was given
# and warns.
#
# `surface` and `ready` carry a third: a pull request that changes what a user sees carries
# screenshots of it. The rule was in the rulebook, the phase brief and the review brief, and
# five front-office pull requests were still declared ready without one image - two
# « skipped, no data on the reference account », three never shot at all. So the row says,
# once, whether its pull request changes a frontend surface (`--ui`, naming the pull
# request), makes a change the orchestrator ruled minor (`--minor`, with the reason the
# operator will read), or changes none (`--none`); `ready` refuses a row that says nothing,
# and on a `--ui` row reads the pull request's description and refuses it when no image is
# there. The surface lives beside the review, not in it: a new review round must not erase
# it. This is a default refusal, unlike the two warnings above; a project with no frontend
# says `--none` on its rows.
#
# `audit` and `ready` carry a fourth: an image is looked at, not only counted. On one day three
# captures showing a defect - an off-centre icon in a control unlike its neighbours, a button
# pushed onto its own row past the edge of the controls above, an « after » image with stray
# text left in a search field - were each read by an orchestrator and passed, because every
# check asked only whether the images were there and showed the surface. So the orchestrator
# records the audit of the images at a head, made by the screenshots agent (a read-only agent
# that opens each image on its own, so the orchestrator's context never carries them): how many
# images it audited (`--images`) and each defect it reported (`--defect`, once per defect; none
# means every image is clean). A new audit replaces the previous one, and a review round does
# not erase it. On a `--ui` row, `ready`
# refuses when no audit is recorded at the head in front of it or at the reviewed or fixed
# head the rules above accept, when the audit covers fewer images than the description
# carries, and when it recorded any defect: the defect is fixed, the capture retaken, and the
# images audited again. `--minor` and `--none` rows are not held to it. Whether the audit was
# honest stays the orchestrator's; the record makes it a step nobody can skip by forgetting.
#
# `ready` carries a fifth: a pull request says how it was proved end to end. A frontend pull
# request was once merged and deployed and did not work there; its only proof was a browser
# pass the implementer reported, nothing a reviewer could replay, and neither the report nor
# the « ready » said there was no E2E test. So `ready` takes the implementer's E2E line
# (`--e2e`), never the pull request's description, which holds its codified sections and
# nothing about E2E. A line that does not start with `E2E:` is refused: silence is not ready.
# `E2E: <test path(s)> — <command> — passed` passes. `E2E: none — <reason>` passes only with
# the operator's validation of that pull request ready without one (`--e2e-waiver`, his words
# and their date), or with his exemption of every pull request of this session, recorded once
# beside the record by `exempt`; then the orchestrator decides alone. Whether the reason holds
# is the review's and his, not the script's. The line is recorded on the row and printed for
# the operator.
#
# A pair row names the model alias and the effort it ran on, and `cost` adds each session's
# measured cost to it - the corrective rounds of a dispatch are part of what it cost. A
# session whose model has no price marks the row `cost_incomplete`, and the summary's
# `cost_avg` leaves it out rather than rank a pair on part of its cost. `--explore` marks a
# dispatch one notch below its class's pair: one that costs a corrective round, or lets a
# defect escape, freezes the class (`frozen=`); three that close in one round promote the
# lower pair (`promote=`). Rows written before pairs existed read as tier rows, unchanged.
#
# The record belongs to the PROJECT being built, not to this plugin: the default table
# ships here, a project's corrections belong with that project's state. Inside it a record
# belongs to ONE orchestration: the first write names it in `<record>.owner` (the orchestration's
# name as the host spells it, without its reference) and a write from any other is refused, naming
# the record's path and its owner. A record with no owner file, every one written before this, is
# claimed by its first write. A read (`summary`, `goals status|check`) claims nothing, and registers
# the record only for its owner.
#
# Every write, and every read by the owner, also registers the record's absolute path under the host session that ran
# it, in `<state dir>/records/<CLAUDE_CODE_SESSION_ID>` (one path per line, no duplicate). An
# order noted « to plan after the round » in prose alone was lost once: nothing read it back.
# A row opened for it is read back by the stop gate (the module's own gate, over the Stop
# event), which refuses `waiting: done` while a registered row is open, and by `summary`,
# which lists the open rows. Registering never fails a command.
#
# `goals` keeps the spec's goals of the build in `goals.md`, beside the record (the grammar
# and the reasons are `goals.py`'s header). A build was once declared done against its plan
# while its plan had moved three of the spec's five goals « after the build », and no row was
# ever opened for them. So `open` refuses while no `goals.md` sits beside the record (a build
# with no spec says `goals <record> init --spec none`), warns on every open goal no phase
# carries, and the stop gate refuses `waiting: done` while a goal is open, lacks evidence, or
# was ruled out without the operator's words. `goals init` registers the record even before its
# first row, so the gate finds the goals from the first write.
#
# The subcommands themselves are dispatch-record.ts, beside this launcher; this header documents both.

exec node --no-warnings "$(dirname "$0")/dispatch-record.ts" "$@"
