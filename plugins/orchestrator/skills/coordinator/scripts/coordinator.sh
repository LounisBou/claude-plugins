#!/bin/bash
# coordinator.sh - the coordinator's own record, and what the machine shows now.
#
#   coordinator.sh register --name "<name [ref]>" --tty /dev/ttysNNN   prints "registered <name>"
#   coordinator.sh clear                                              removes the record; none is no error
#   coordinator.sh lookup                                             the name while its session runs, else nothing
#   coordinator.sh facts     the sessions, checkouts and heavy runs of every repository a session
#                            works in, then the collisions among them
#   coordinator.sh owners    each open pull request of those repositories, traced to its orchestrator
#   coordinator.sh check [--every <seconds>]   what is new since the last check, one line each:
#                            « newcomer <Orch: title> », a module-lost line, a collision line, an
#                            unread line; nothing but the module-lost lines on the first
#                            check (<state>/coordinator-check.json keeps the last). --every reads again at that pace until a line is new: run in
#                            the background, it wakes its session only on a finding
#   coordinator.sh roots     the roots, one line each by core's rule: protected=<what runs>, data=<what
#                            any session writes>, module=<the hooks module's own files, measure/ among them>
#   coordinator.sh sleep --name "Orch: <subject>" --brief <path> --dir <path> --model <id>
#                        --effort <level> [--session <id>] [--mode build|investigate] [--config <dir>] [--pr "<repository>#<n> <branch>"]... [--checkout <path>]...
#                            records a paused orchestrator as sleeping, once its tab is closed;
#                            prints "sleeping <name>"
#   coordinator.sh sleeping  one line per sleeping orchestrator; nothing when none sleeps
#   coordinator.sh wake-done --name "Orch: <subject>"   removes the record of one woken, its
#                            spawn verified; prints "woken <name>"
#   coordinator.sh drop --name "Orch: <subject>"        abandons one for good: removes its record
#                            and moves its brief into an abandoned/ directory beside it
#   coordinator.sh round [--all] [--by-urgency]   the round's entries still to be ruled: the open
#                            ones, the urgent first, each level grouped by sender, after one line
#                            counting the answered and the withdrawn ones it leaves out;
#                            --all prints those too, the answered then the withdrawn
#                            (--by-urgency prints the same order, every question's text)
#   coordinator.sh round --decide --as "<name>"   where the operator's decide runs, then its
#                            entries: one line, ending on what the session does next, « decide: coordinator — … »
#                            (the live coordinator's own session, named by --as: round --by-urgency follows),
#                            « decide: machine | <n> open — … » (no coordinator live, an Orch: session: the open
#                            operator entries of every session of the machine follow, in the round's order, every
#                            question's text, none recorded as listed), « decide: elsewhere | <name> | <tty> — … »
#                            (a coordinator is live and this is not it: nothing follows) or « decide: empty | no
#                            open question — … »; exit 0 in each; a record naming no pid counts as a coordinator
#                            live (as the hooks module reads it); no coordinator live, a question open and a session not an
#                            orchestrator, or a liveness check that cannot run, is a refusal, exit 1
#   coordinator.sh round-archive   moves every entry settled over a day ago into round/archive/; prints
#                            "archived <n>"
#
# facts prints, one per line:
#   session <pid> | <tty> | <title> | <orchestrator> | <repository> | <branch> | <directory> | <plan>
#     (the repository reads « not a git tree » for a directory in none; the plan is read in the
#     session's own environment (`ps eww`): plan1 for the default directory or no CLAUDE_CONFIG_DIR,
#     plan2 for the second account's, any other directory by its path, « - » when it was not read)
#   checkout <path> | <repository> | <branch>
#   heavy <pid> | <directory> | <command>
#   waiting <orchestrator> | operator since <UTC time> | blocks: <what it blocks>
#   waiting <orchestrator> | done since <UTC time>
#     (an orchestrator whose last turn ended on its machine line, read from the wait file the
#     hooks module keeps for its live session; the module also enters that wait in the round once)
#   unattended <orchestrator> | Attend ton geste : <repository>#<n> (Ready | en pause | attend <what> depuis <UTC minute>), ...
#   unattended <orchestrator> | En anomalie : <repository>#<n> (sans agent depuis <UTC minute> | en conflit), ...
#     (the open pull requests no agent holds, those resting on the operator and those in anomaly
#     each on a line of its own, as the hooks module of a live orchestrator read them
#     against the forge at its last turn end and wrote them on its row; « unattended » is core's
#     pr-ledger.ts, docs/contracts.md; a repository the forge did not list is said unknown)
#   quota <plan> | 5h <n>% | 7d <n>% | read <UTC time>[ (stale)]
#     (each account's quota as the status lines keep it in <state>/quota/, core's quota.ts,
#     docs/contracts.md; <plan> is plan1 or plan2 as core's planOfConfig names the account's
#     configuration directory, else that directory; « - » a window the payload did not carry; « (stale) » when no
#     session of the account has refreshed it within core's QUOTA_STALE_AFTER_MS; a file that is no reading is skipped)
#   remote <orchestrator> | on <machine> | updated <UTC time> | context <tokens> (<percent>%) | repository <owner/name or none> | prs <owner/name#n>, ... or none | <wait>
#     (an orchestrator on another machine, its row as the hooks module received it; <wait> is
#     « operator since <UTC time or ?> | blocks: <what it blocks> », « done since <UTC time or ?> »
#     or « working »; a row is kept while updated within 24 hours and no local session names it)
#   collision checkouts | <repository> | <branch> | <path>, <path>...
#   collision sessions | <repository> | <branch> | <pid> <title>, <pid> <title>...
#   collision heavy | <pid>, <pid>...
#   collision pr | <repository>#<n> | <branch> | <orchestrator>, <orchestrator>...
#     (a remote row listing the pull request counts as one more orchestrator on it)
#   module-lost <name> | session <id> | pid <pid> | <tty> | <what to do>
#     (a live Coord, Orch or Audit session whose transcript says its orchestrator module is not
#     loaded; facts and check print it)
#   unread <source>: <why>     a source not read: the process table, the host's name, lsof,
#                              a pid's directory, a tree git failed on, a brief, the checkouts,
#                              the forge, a remote row that is no JSON row
# sleeping prints, one per sleeping orchestrator, in the order they went to sleep:
#   sleeping <name> | since <UTC time> | <directory> | prs <repository>#<n> <branch>, ... or none
#     | checkouts <path>, ... or none | brief <path> | model <id> | effort <level>, or none for a
#     record a pause wrote before an effort was required (its wake passes neither)
#     [ | session <id>]: the session the close of its home session read, which the wake resumes
# round prints, for each entry whose status is open (and with --all, then for each answered one,
# chosen in the coordinator's pane and sent to the asking orchestrator, then for each withdrawn one),
# a line
#   round <id> | <operator or done> | from <sender> | since <UTC time> | blocks: <what it blocks, or -> | <status>[ | due][ | remote on <machine> | sender gone]
# followed, for an entry the coordinator presents (a due one, a closing proposal) and for every one
# with --all or --by-urgency, by the question's lines, each indented by four spaces. Without --all, the first line is
#   settled: <n> answered, <n> withdrawn (round --all prints them)
# when the round holds any of them, and none of theirs is printed: they are done, and a round that
# keeps them whole grows with every question ever asked. « remote on <machine> » marks a
# sender on another machine whose remote row is in the store, « sender gone » one with neither a row
# nor a session. « due » marks an open question
# the coordinator presents in its tab: its sender marked it urgent, or no pane of the
# coordinator is open (<state>/pane.json, written by the hooks module while it is; round.ts paneOpen
# says when its record counts); any other open question is the pane's alone, however long
# it waits. The entries are read from
# <state>/round/<id>.json, one JSON entry per file, written whole by the hooks module at the end
# of a turn of an orchestrator on this machine (hooks/round.ts); a file that does not parse is
# skipped. Each set is in the round's order: the urgent entries first, then the others; within
# each level grouped by sender, the groups by their earliest wait in it, each in the order its
# waits began. round --by-urgency prints the same order. An answered entry's lines end on
#     answered from the pane at <UTC time>: <letter> : <choice text>
# and those of an entry its sender withdrew on
#     withdrawn by the sender at <UTC time>: <why>
# the reason the module wrote (superseded by <id>, the sender's session ended, handed over to its
# successor), or, when it wrote none (a later turn the operator typed in ended on another machine
# line), « a later turn the operator typed in waits on something else »; one the operator's prompt
# in the sender's own tab withdrew ends on
#     withdrawn in the sender's tab at <UTC time>: <why>
# followed by « — he typed: <his words> » when the prompt's words were kept (answer.typed)
# and any other withdrawal on « withdrawn by <who> at <UTC time>: <why> »: every reason recorded
# is printed, so the entry is closed with it.
# round records the ids of the open entries it printed in <state>/round-listed.json (record_listed).
# An entry is closed with the hooks module's `settle` tool (hooks/question.ts), which writes the
# answer and sends a question asked with `ask` its answer in the same call; the
# close of a closing proposal sends nothing.
# round-archive moves each entry file of <state>/round/ settled over a day ago — closed, answered
# or withdrawn, at its answer's time (else its start), its delivery absent or delivered — into
# <state>/round/archive/, a withdrawn one into <state>/round/archive/withdrawn/ (created when
# absent), each in one rename under its lock; an open entry, a delivery pending, sent or failed,
# and a file that does not parse stay. succession.sh takeover runs the same move. round sees only the
# files directly under round/. It also removes the *.json.tmp-* files a write died on, once a day
# old; a fresher one is a write in flight and stays.
# drop prints "dropped <name>", then "brief moved to <path>" (or "brief <path> was already
# gone"), then "left untouched: <each pull request and checkout, or none>" — the pull requests,
# their branches and the checkouts are the operator's to close, never this script's.
#
# owners prints one line per open pull request and session found on its branch:
#   pr <repository>#<n> | <branch> | <orchestrator> | session <pid> in <directory>
#   pr <repository>#<n> | <branch> | unknown | session <pid> in <directory> names no orchestrator
#   pr <repository>#<n> | <branch> | unknown | session <pid> in <directory>: brief <path> cannot be read
# or one « unknown » line per pull request where the chain breaks or allows two answers:
#   pr <repository>#<n> | <branch> | unknown | no checkout on <branch>
#   pr <repository>#<n> | <branch> | unknown | no session in <checkout>, <checkout>...
#   pr <repository>#<n> | <branch> | unknown | no session in <checkout>..., beside a session in <checkout>...
#   pr <repository>#<n> | <branch> | unknown | sessions <pid>, <pid> in <directory> name different orchestrators: <o>, <o>
#   pr <repository>#<n> | <branch> | unknown | head branch in a fork, owned by <owner>
# except that an « unknown » pull request a remote row lists is that row's orchestrator, and
# one a sleeping orchestrator's record lists is its:
#   pr <repository>#<n> | <branch> | <orchestrator> | remote on <machine>, updated <UTC time>
#   pr <repository>#<n> | <branch> | <name> | sleeping since <UTC time>
# A remote row's pull request in a repository this machine did not read keeps the branch « - »,
# and says so; one absent from its repository's open list is not printed (it is no longer open):
#   pr <owner/name>#<n> | - | <orchestrator> | remote on <machine>, updated <UTC time>, not read on the forge here
#
# The chain an owner is read along: the pull request's head branch, the checkouts on it, the
# host sessions working there, and the orchestrator each one names — itself when its title
# is `Orch: …`, else the address its brief gives (« orchestrator is the session **`…`** »,
# a relative brief read from the session's directory), else the one its startup prompt
# gives; « unknown » where the chain breaks or allows two answers. A repository is its
# origin's address without scheme, user or `.git`, so a checkout and its source are one
# repository; a detached checkout is on no branch. A session is a host CLI process with a
# terminal; the host's name is ORCHESTRATOR_HOST_CLI, else the launcher's own default.
#
# Sources, each replaceable for the suite: the process table (`ps`, or the file
# COORDINATOR_PS_TABLE, lines `<pid> <ppid> <tty> <command>`), the working directories
# (`lsof`, or COORDINATOR_CWDS, lines `<pid> <path>`), the checkouts (`workspace.sh list`),
# the open pull requests (the machine's pull request file `<state>/prs.json`, which the hooks
# module refreshes in one forge call a minute for the whole machine; a GitHub repository it holds
# no current reading of is unread), and the
# remote rows (`store/remote` under the module's directory, MODULE below: one JSON row per file,
# written by the hooks module as it receives them from orchestrators on other machines; read
# here, never written).
#
# State: <state>/coordinator.json {"name","tty","started","pid"}; <state> is ORCHESTRATOR_STATE_DIR,
# else the plugin's directory under CLAUDE_CONFIG_DIR, else under ~/.claude, the launcher's
# own resolution. A registration goes through the lock directory <state>/coordinator.lock,
# waited for five seconds at most, then refused with the lock's path and its holder's pid; a
# lock is never broken automatically.
#
# The sleeping orchestrators: <state>/sleeping.json, an array of {"name","brief","dir","model",
# "effort","slept","prs","checkouts"[,"session"][,"mode"][,"config"]}, "config" the configuration
# directory the orchestrator ran on (absent: plan 1) that a wake and a move run it on again,
# written in one rename under the same lock as a
# registration — sleep, wake-done and drop each take it — and kept apart from the
# coordinator's own record, so it outlives a coordinator's succession and its end alike. A
# sleeping orchestrator is the operator's to wake or drop: nothing here acts on its own.
#
# Liveness: a session is alive when `iterm-agent.sh verify --tty <tty> --pid <pid>` finds that
# process as the host CLI on its tty, so another host CLI on a reused tty reads as dead. The
# record's pid is the host CLI's on the tty at registration, read from the « (pid N) » of
# `verify --tty <tty>`; a record with no pid, written before it was kept, is read by its tty
# alone. COORDINATOR_VERIFY names another command to run in its place, called as
# `<command> --tty <tty>` (printing « ... (pid N) » when it runs) or `<command> --tty <tty>
# --pid <pid>` (exit 0 only when that pid runs there), read the same way: exit 0 alive; exit 1
# with nothing on stderr is its « not running », and any other answer is an error, never « dead ».
#
# Exit codes: 0; 1 on a refusal or a usage error, and from `facts` when it prints a
# collision; 2 from `facts` and `owners` when a source could not be read, so an answer that
# cannot be known is never read as « no collision ».
#
# Why it exists: two orchestrations step on each other through what is checked out, what
# runs and which pull request a branch carries, and all of it can be read now. Nobody
# declares anything to the coordinator, so nothing it answers rests on what an orchestrator
# remembered to say, and no orchestrator carries a duty toward it; a reading made in prose
# would be made from memory, and that is where two sessions end up pushing to one branch.
#
# The subcommands themselves are coordinator.ts and its modules beside this launcher (facts.ts,
# round.ts, record.ts, sleeping.ts); this header documents them.

. "$(dirname "$0")/../../orchestrator/scripts/node-ts.sh" || exit 1
node_ts_exec coordinator "$(dirname "$0")/coordinator.ts" "$@"
