# The coordinator — design

A coordinator is a session above the orchestrators of one machine. It organizes them so they
work together without stepping on each other, and it is the operator's single entry point to
all of them: scheduling (who goes when), communication (the bridge between orchestrations and
the operator), logistics (the shared machine and the shared repositories).

## 1. What the operator decided

1. **A single channel.** While a coordinator runs, an orchestrator no longer speaks to the
   operator. Its questions and reports go to the coordinator, which sorts them, puts them to
   the operator one at a time, and relays his answer.
2. **Discovery by a file and a message.** The coordinator writes its address (its session
   name and reference as the host lists them) into the plugin's machine-wide state directory,
   and announces itself by message to every running orchestrator, each of which confirms. An
   orchestrator reads that file at loading and before every time it would speak to the
   operator; a successor does the same.
3. **Authority on logistics only.** The coordinator decides the cross-orchestration
   logistics itself and tells the operator after: who goes first on a shared resource, which
   orchestrator waits for which on a shared branch, path or pull request, how heavy runs are
   spread over the machine. Scope, frame, merging, undrafting, and anything an orchestrator
   would have asked the operator stay his. Method changes stay the auditor's.
4. **Conflicts found before they happen, on the facts.** Before every dispatch an
   orchestrator declares to the coordinator what it will touch. The coordinator re-reads the
   facts (checkouts, open pull requests, branches, heavy processes) before answering « go »
   or « wait for X ».
5. **Placement.** The coordinator's tab is the leftmost tab of the window. (An auditor's tab
   is immediately left of its orchestrator's; that correction ships separately.)
6. **Lifecycle.** The operator launches the coordinator himself, in a session he opens, with
   the coordinator command; one per machine; it ends on his word with the coordinator-end
   command; at its context gate it spawns its own successor.
7. **Reporting on events only.** An orchestrator sends what it would have said to the
   operator (questions, « ready », the stops that are his, end-of-phase reports), its
   declaration before each dispatch, and its succession. Nothing periodic. A status request
   is answered by the coordinator re-reading the facts, asking an orchestrator only what the
   facts do not say.
8. **The auditor follows the channel too.** Its « audit ready » with the report path and its
   orders to rule go to the coordinator, which puts them to the operator unfiltered. The
   report stays a file; the audit-end command stays the operator's.
9. **The mechanical part is scripted, the judgment is prose.** What must be exact (finding
   the coordinator, knowing whether it lives, the claims ledger, the overlap check, the
   leftmost placement) is a script with tests; sorting questions, ruling logistics and
   presenting one question at a time is the skill's text.

## 2. The pieces

New:

```
skills/coordinator/SKILL.md                    the coordinator's role
skills/coordinator/scripts/coordinator.sh      register, clear, lookup, declare, release, conflicts
commands/coordinator.md                        start a coordinator (the operator's word)
commands/coordinator-end.md                    end it (the operator's word)
templates/coordinator-succession-brief.md      its successor's brief
```

State, in the plugin's state directory (the one `ORCHESTRATOR_STATE_DIR` names):

```
coordinator.json     the live coordinator: name, reference, tty, started at
claims.jsonl         one line per declaration: orchestrator, repository, branch, pull request,
                     checkout, heavy run, opened at, released at
```

Changed:

- **The orchestrator skill**: at loading and before speaking to the operator, run
  `coordinator.sh lookup`; an address printed means write to the coordinator instead. Before
  each dispatch, `coordinator.sh declare`, send the line to the coordinator, wait for « go ».
  At the end of a phase, `coordinator.sh release`. Its succession brief carries the
  coordinator's address.
- **The auditor's brief and the audit reference**: the same channel rule.
- **The launcher** (`iterm-agent.sh`): `move --tty <tty> --leftmost`; `spawn
  --coordinator-successor`, which opens leftmost with a `Coord :` title; the `Coord :` title
  reserved to these paths, the way `Audit :` is reserved to `--auditor`; `rotate` and `move`
  refuse the coordinator's tab as an agent's.

### The coordinator's role (the skill)

- It sorts what orchestrators and auditors send, and puts it to the operator one question at
  a time, in the decision round's format (`commands/decide.md`), each prefixed with the
  orchestrator and the project.
- It relays the operator's answer verbatim and dated to the session that asked.
- It rules the cross-orchestration logistics itself and tells the operator in one line after.
- It never touches scope, merging, undrafting or method; it writes in no repository.
- Its context gate is the orchestrator's (80 %), and it succeeds itself like one.

### The script

- `register <name [ref]> <tty>` writes `coordinator.json`; refused while a live coordinator
  is recorded; a record whose session is gone is replaced and the replacement said. A lock
  makes two concurrent registrations refuse one.
- `clear` removes the record.
- `lookup` prints the recorded address only when its session is alive in the process table;
  otherwise prints nothing and says on the error stream that the record is stale.
- `declare --orchestrator <name [ref]> --repo <path> [--branch <b>] [--pr <n>] [--checkout
  <path>] [--heavy <what>]` appends a line to `claims.jsonl` and prints its id.
- `release <id>` closes a declaration.
- `conflicts <id>` crosses that declaration with every other open one and with the facts
  re-read now (the workspace list, the open pull requests of the repository, `ps` for heavy
  runs); prints each overlap (same branch, same checkout, same pull request, two heavy runs);
  exits 1 when there is one. A declaration whose orchestrator no longer runs is ignored and
  named, so it can be closed.

## 3. The flow

**Start** — the operator types the coordinator command with a subject:

1. `register` refuses if a live coordinator exists, and replaces a record left by a dead one,
   saying so.
2. The command hands the operator the line `/rename "Coord : <subject>"`, then moves its tab
   leftmost (`move --leftmost`).
3. It announces itself to every `Orch :` and `Audit :` session the host lists, subscribes to
   each one's idle notice, waits for each acknowledgment, and names to the operator any that
   did not answer.

**An orchestrator's question:**

1. The orchestrator runs `lookup` and sends its question to the coordinator, in the decision
   round's format.
2. The coordinator re-reads the state of what the question is about. Found settled, it
   answers itself with the evidence.
3. Otherwise it queues the question, in arrival order, a question blocking a working agent
   first, and puts it to the operator one at a time.
4. The answer goes back verbatim and dated to the orchestrator, which writes it where its
   rulings live.

**A declaration before a dispatch:**

1. The orchestrator runs `declare` and sends the line to the coordinator.
2. The coordinator runs `conflicts`. Exit 0: « go ». Exit 1: it rules who goes first,
   answers « wait for X » to one and « go » to the other, and tells the operator in one line.
3. At the end of the phase the orchestrator runs `release`, and the coordinator wakes those
   that were waiting.

**Ready, end-of-phase reports, audit ready** — relayed as they are, unjudged.

**An order to all** — relayed verbatim and dated to every orchestrator it concerns; the
coordinator tells the operator who acknowledged.

**Succession**, at 80 % and at a quiet boundary:

1. `spawn --coordinator-successor` opens the successor leftmost.
2. The successor re-registers its address and announces itself to everyone.
3. It takes over the queue and the ledger, and closes the predecessor's tab on its « handed
   over ».

**End** — the operator types the coordinator-end command:

1. It lists the questions still queued first.
2. It tells every orchestrator and auditor that they speak to the operator directly again.
3. It runs `clear`, then `lookup`, which proves nothing is printed.
4. It stops; its tab closes on the operator's word.

## 4. Failures

- **The coordinator dies without handing over.** The next `lookup` finds its session gone,
  prints nothing and names the stale record; the orchestrator speaks to the operator directly
  and tells him in one line that the coordinator fell. The ledger stays for the next
  coordinator.
- **An orchestrator does not answer the announcement.** Named to the operator; it still finds
  the coordinator through `lookup` the next time it would speak.
- **An orchestrator gets no answer.** The silence rule: re-sent after fifteen minutes and a
  fresh listing; the coordinator no longer listed, it speaks to the operator directly.
- **A declaration never released.** `conflicts` ignores a declaration whose orchestrator is
  gone and names it, so the coordinator closes it.
- **Two coordinator commands at once.** `register`'s lock refuses the second.
- **A wrong logistics ruling.** The operator corrects it by an order, which the coordinator
  relays; it only ever rules logistics, never a merge or a scope.

## 5. Tests

- **Unit tests** in `tests/run-tests.sh`, each shown falling under a mutation: every
  subcommand of the script, its refusals and the stale record; `lookup` against a live and a
  dead session; `conflicts` on a shared branch, a shared checkout, a shared pull request, two
  heavy runs, and no overlap; the launcher's refusals (`Coord :` outside its paths, `rotate`
  and `move` on the coordinator's tab) and `--leftmost`.
- **Eval cases** in `evals/`: an orchestrator with a live coordinator writes to it instead of
  the operator; an orchestrator declares before dispatching and waits for « go »; a
  coordinator puts one question at a time; a coordinator rules a branch conflict and tells the
  operator after, and never merges. The 0.36.0 baseline is the reference that no other case
  falls.
- **The inventory**: every new rule gets its row; both trace modes exit 0 (the inventory is
  kept through the token-economy work).
