# Successor Chain Implementation Plan

> **For the orchestrator:** this plan is executed by implementer SESSIONS the orchestrator spawns (`orchestrator:iterm-agents`), one brief per task — never by subagents of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One release, 0.23.4: `spawn --successor` places a successor immediately right of the calling session, chain ignored, writes it into no chain, and hands the caller's chain over to it — its agents' entries move under the successor's tty and session id — so the successor's next `--right-of self` lands after the last agent, as the layout convention promises. The three texts that said otherwise say the one form.

**Architecture:** in `iterm_agent.py`, one flag on `cmd_spawn`, one exclusion, one branch in the anchor resolution, one line in the dry-run block, one pure function `chain_transfer` beside the other chain functions, and one branch in `go()` after the tty is read. Ten checks in the suite (seven on the launcher — three through the dry run, four on the module — and three guards on the texts). Three live checks in `tests/e2e.sh`, run by the orchestrator at review. Three texts rewritten.

**Tech Stack:** Python 3 (the launcher), bash 3.2 (the suites).

**Spec:** `docs/design.md`, section 34. Sections 21 (the chain) and 26 (its owner) bind it.

## Global Constraints

Copied from `CLAUDE.md`; the task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt.
- **Commits**: Conventional Commits; no trailer, no attribution, no tool name, no session link.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (229 on the base head; this task adds 10, expected `239 passed, 0 failed`); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`: `0.23.4`.
- **Never run anything against the live app from the suite.** The dry run, the fixture chain files and the module import are the suite's doors. `tests/e2e.sh` is EDITED by this task (Step 8) and NEVER RUN by it: the orchestrator runs the live round at review.
- **Every command runs synchronously**, in the tool call that waits for it; the suite is piped to `tail` in the same call.
- **The checkout you work in is already on the phase branch** (the orchestrator committed this plan and the spec on it): do not create another branch.

---

### Task 1: Successor chain (0.23.4)

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — `cmd_spawn` (parser, exclusion, anchor resolution, dry-run line, `go()`), a new `chain_transfer` immediately after `chain_append`, the file's header comment.
- Modify: `tests/run-tests.sh` — seven checks appended at the end of the agent-chain section (immediately after the check `an entry with no owner is skipped once an owner is known`, before `echo "== dispatch record =="`), three guards appended immediately after the check `the succession names no tier`.
- Modify: `tests/e2e.sh` — three checks inside the chain block, and one existing check re-pointed.
- Modify: `skills/iterm-agents/SKILL.md` — the quick-reference spawn line and the successor line of the layout convention.
- Modify: `skills/orchestrator/SKILL.md` — step 2 of the succession list.
- Modify: `commands/succeed.md` — step 2.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.23.4`.
- Already committed on this branch by the orchestrator: `docs/design.md` §34 and this plan.

**Interfaces:**
- Consumes: `chain_read`, `chain_write`, `chain_owned`, `chain_append`, `find_tab`, `self_tty`, `SELF_ID`, `DRY_RUN`, `die`; the dry-run convention (`ORCHESTRATOR_SELF_TTY`, `ORCHESTRATOR_SELF_ID`, `ORCHESTRATOR_STATE_DIR`).
- Produces: `spawn --successor` (a flag; exclusive with `--left-of` and `--right-of`; anchor = the caller's own tab, right side, chain ignored; the successor appended to no chain; live, the caller's own entries moved under the new tty and session id); the dry-run line `successor=yes|no` printed right after `trust=`; `chain_transfer(old_tty, old_owner, new_tty, new_owner) -> int` (the number of entries moved), importable from the module.

- [ ] **Step 1: Write the failing checks — launcher**

In `tests/run-tests.sh`, immediately after the check `an entry with no owner is skipped once an owner is known` (its two lines), insert:

```bash

# A successor is not an agent: it takes the predecessor's place, immediately right of it,
# chain ignored, and takes the chain with it (§34). Dry: the anchor, and the file untouched.
printf '{"tab_id":"7","tty":"/dev/ttys907","owner":"S-OTHER"}\n{"tab_id":"8","tty":"/dev/ttys908","owner":"S-ME"}\n' > "$CHAINS/ttys900.jsonl"
before=$(cat "$CHAINS/ttys900.jsonl")
out=$(ORCHESTRATOR_SELF_ID=S-ME chain_spawn --successor)
check "a successor anchors on self, whatever the chain says" "1|1" \
  "$(printf '%s' "$out" | grep -c '^anchor=self$')|$(printf '%s' "$out" | grep -c '^successor=yes$')"
check "a dry successor spawn leaves the chain as it was" "$before" "$(cat "$CHAINS/ttys900.jsonl")"
check "a successor names its own anchor" "1|1" \
  "$(chain_spawn --successor --right-of self >/dev/null 2>&1; echo $?)|$(chain_spawn --successor --left-of /dev/ttys555 >/dev/null 2>&1; echo $?)"
# The hand-over itself, on the module: the predecessor's own entries move under the
# successor's tty and owner, its foreign entries stay, and a stale file on the successor's
# recycled tty is replaced, not appended to. Nothing to hand over hands over an empty chain.
transfer() { ORCHESTRATOR_STATE_DIR="$WORK/istate" "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print(m.chain_transfer('/dev/ttys900', 'S-ME', '/dev/ttys950', 'S-NEW'))" 2>&1; }
printf '{"tab_id":"7","tty":"/dev/ttys907","owner":"S-OTHER"}\n{"tab_id":"8","tty":"/dev/ttys908","owner":"S-ME"}\n{"tab_id":"9","tty":"/dev/ttys909","owner":"S-ME"}\n' > "$CHAINS/ttys900.jsonl"
printf '{"tab_id":"1","tty":"/dev/ttys901","owner":"S-DEAD"}\n' > "$CHAINS/ttys950.jsonl"
check "the hand-over moves the predecessor's own entries" "2" "$(transfer)"
check "under the successor's tty and owner, the stale file replaced" \
  '{"tab_id": "8", "tty": "/dev/ttys908", "owner": "S-NEW"}|{"tab_id": "9", "tty": "/dev/ttys909", "owner": "S-NEW"}' \
  "$(paste -sd'|' "$CHAINS/ttys950.jsonl")"
check "and leaves the predecessor only what was never its own" '{"tab_id": "7", "tty": "/dev/ttys907", "owner": "S-OTHER"}' \
  "$(cat "$CHAINS/ttys900.jsonl")"
check "a predecessor with no agents hands over an empty chain" "0|0" "$(transfer)|$(wc -l < "$CHAINS/ttys950.jsonl" | tr -d ' ')"
```

- [ ] **Step 2: Write the failing checks — texts**

In `tests/run-tests.sh`, immediately after the check `the succession names no tier`, insert:

```bash
# The successor is spawned with --successor, everywhere the succession is described (§34);
# the two sentences that promised a placement the launcher did not make are gone.
check "the succession spawns with --successor" "yes|0" \
  "$(grep -q -- '--successor' "$ROOT/commands/succeed.md" && echo yes || echo no)|$(grep -c -- '--left-of <implementer tty>' "$ROOT/commands/succeed.md")"
check "the tab skill spawns the successor the same way" "1|0" \
  "$(grep -c 'spawning your successor: `--successor`' "$ROOT/skills/iterm-agents/SKILL.md")|$(grep -c 'sits between you and your agent' "$ROOT/skills/iterm-agents/SKILL.md")"
check "and so does the rulebook" "1|0" \
  "$(grep -c 'passing `--successor`' "$ROOT/skills/orchestrator/SKILL.md")|$(grep -c 'lands between you and your agent' "$ROOT/skills/orchestrator/SKILL.md")"
```

- [ ] **Step 3: Run the suite and watch the new checks fail for the right reason**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `230 passed, 9 failed`. The one that passes already is « a successor names its own anchor »: today's parser refuses `--successor` as an unknown option, exit 1 on both calls, for the wrong reason. The dry-run checks fail because the option is unknown; the module checks fail because `chain_transfer` does not exist (a traceback in place of a number); the text guards fail because the texts still carry the old sentences. Report the count and the first failing check's actual value verbatim before editing anything else.

- [ ] **Step 4: The launcher**

In `skills/iterm-agents/scripts/iterm_agent.py`:

(a) Immediately after `chain_append` (the two-line function), insert:

```python


def chain_transfer(old_tty, old_owner, new_tty, new_owner):
    """The predecessor's agents become the successor's (§34).

    A successor spawned after the last agent, and appended to the predecessor's chain as
    if it were one, inherited nothing: its own file was empty or a dead session's, so its
    first `--right-of self` landed left of the agents it had just taken over. The entries
    the predecessor wrote move under the successor's tty and session id; what the
    predecessor's file held from other occupants of its tty stays there; whatever a
    recycled tty's file held on the successor's side is replaced, never appended to."""
    entries = chain_read(old_tty)
    moved = chain_owned(entries, old_owner)
    kept = [e for e in entries if e not in moved]
    chain_write(new_tty, [{"tab_id": e["tab_id"], "tty": e["tty"], "owner": new_owner}
                          for e in moved])
    chain_write(old_tty, kept)
    return len(moved)
```

(b) In `cmd_spawn`'s parser, immediately after the line `p.add_argument("--trust", action="store_true", default=False)`, add:

```python
    p.add_argument("--successor", action="store_true", default=False)
```

(c) Immediately after the block

```python
    if args.left_of and args.right_of:
        die("spawn: --left-of and --right-of are mutually exclusive")
```

add:

```python
    if args.successor and (args.left_of or args.right_of):
        die("spawn: --successor names its own anchor, immediately right of this session; "
            "drop --left-of and --right-of")
```

(d) In the anchor resolution, replace

```python
    side = "right" if args.right_of else "left"
    anchor = args.right_of or args.left_of
    own = self_tty() or ""
    if anchor == "self":
        if not own and not DRY_RUN:
            die("spawn: --right-of self: cannot resolve this session's own tty")
        anchor = own or "self"
        if side == "right" and own:
```

with

```python
    side = "right" if args.right_of else "left"
    anchor = args.right_of or args.left_of
    own = self_tty() or ""
    if args.successor:
        # A successor is not an agent: immediately right of this session, the chain
        # ignored, and it takes the chain with it once its session can be read (§34).
        side, anchor = "right", "self"
    if anchor == "self":
        if not own and not DRY_RUN:
            die("spawn: --right-of self: cannot resolve this session's own tty")
        anchor = own or "self"
        if side == "right" and own and not args.successor:
```

(e) In the dry-run block, immediately after `print("trust=%s" % trust_state)`, add:

```python
        print("successor=%s" % ("yes" if args.successor else "no"))
```

(f) In `go()`, replace

```python
        if own and new:
            chain_append(own, tab.tab_id, new, own_sess_id)
        return new
```

with

```python
        if own and new and args.successor:
            new_sess = None
            for _ in range(10):
                fresh = await iterm2.async_get_app(connection)
                _, _, new_sess = await find_tab(fresh, new)
                if new_sess is not None:
                    break
                await asyncio.sleep(0.3)
            if new_sess is None:
                # A gate that cannot measure lets the launch through and says so.
                print("spawn: the successor's session on %s could not be read, so the chain "
                      "stays with %s; place its next agent with --right-of <last agent tty>."
                      % (new, own), file=sys.stderr)
            else:
                n = chain_transfer(own, own_sess_id, new, new_sess.session_id)
                print("spawn: chain of %d agent(s) handed to the successor on %s" % (n, new),
                      file=sys.stderr)
        elif own and new:
            chain_append(own, tab.tab_id, new, own_sess_id)
        return new
```

(g) In the file's header comment, where the usage lines are listed, add beside the spawn line: `--successor` — « the new session takes this one's place: immediately right of it, chain ignored, and the chain handed over ».

- [ ] **Step 5: Run the suite**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `236 passed, 3 failed` — the three text guards. Do not weaken a check to pass; report the actual value and stop if the launcher and a check disagree on the contract.

- [ ] **Step 6: The texts**

`skills/iterm-agents/SKILL.md`:
- In the quick reference, the spawn block's last line ends with `[--right-of self]`; make it `[--right-of self | --successor]`. Immediately after the `# --tier resolves through …` comment lines of that block, add the comment line: `    # --successor: the new session takes yours — immediately right of you, chain ignored, your chain handed to it (§34).`
- Replace the whole line beginning `- spawning your successor: ` with:

```
- spawning your successor: `--successor` — immediately right of your own tab, the chain ignored, so it lands between you and your first agent; the launcher hands it your chain (your agents' entries move under its tty and session) and writes it into no chain, because a successor is not an agent. It closes your tab once the takeover is confirmed and ends up immediately left of your first agent, and its `--right-of self` resolves to your last agent from then on.
```

`skills/orchestrator/SKILL.md`: replace the whole line beginning `  2. Spawn the successor via ` with:

```
  2. Spawn the successor via `orchestrator:iterm-agents` with `--inherit-model` and the brief as startup prompt, passing `--successor` so it lands immediately right of you — between you and your first agent, chain ignored — and takes your chain with it; it closes your tab once the takeover is confirmed, leaving it immediately left of the agent (house layout; `move` repairs it after the fact).
```

`commands/succeed.md`: in step 2, replace `--left-of <implementer tty> --prompt "Read and execute <brief path>"\`` with `--successor --prompt "Read and execute <brief path>"\`` (the backtick closes the command as before), and append to that step's text, after « (spec §27). »: « `--successor` places it immediately right of this tab, between it and the first agent, and hands it the chain (spec §34). » In step 1, replace « note your own tty and the implementer's tty » with « note your own tty ».

Before each edit, `grep -n` the literal you replace in `tests/run-tests.sh` and re-pin any guard that pinned it; say in your report what you found (the orchestrator read none on these lines; confirm).

- [ ] **Step 7: Run the suite**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `239 passed, 0 failed`.

- [ ] **Step 8: The live round's checks (edit only, never run)**

In `tests/e2e.sh`, inside the `if [ -n "$me" ]; then` block of the chain section, immediately after the check `the chain names its owner`, insert:

```bash
  # A successor takes the predecessor's place and its chain (§34): immediately right of the
  # caller, left of the agents, and the agents' entries move under its tty.
  succ_out=$(bash "$AGENT" spawn --dir "$SANDBOX/repo" --tier "$tier" --title e2e-successor --trust \
        --prompt "Do nothing." --successor 2>&1)
  SUCC=$(printf '%s' "$succ_out" | grep -oE '^/dev/ttys[0-9]+$' | tail -1)
  pos_me=$(bash "$AGENT" list | grep -n "$me" | cut -d: -f1)
  pos_succ=$(bash "$AGENT" list | grep -n "$SUCC" | cut -d: -f1)
  check "the successor lands immediately right of the caller, left of the agents" "$((pos_me + 1))" "$pos_succ"
  succ_chain="${ORCHESTRATOR_STATE_DIR:-$HOME/.claude/claude-orchestrator}/chains/$(basename "$SUCC").jsonl"
  check "the successor's chain names both agents" "2" "$(grep -c "\"tty\": \"$ONE\"\|\"tty\": \"$TWO\"" "$succ_chain")"
  check "and the caller's chain no longer does" "0" "$(grep -c "\"tty\": \"$ONE\"\|\"tty\": \"$TWO\"" "$chain")"
  bash "$AGENT" close --tty "$SUCC" >/dev/null 2>&1
```

Then, in the existing check `a closed agent leaves the chain` just below, replace `"$chain"` with `"$succ_chain"`: the entries now live there. Run `bash -n tests/e2e.sh` (a syntax read, nothing else) and report its exit code. Do NOT run `tests/e2e.sh`.

- [ ] **Step 9: Version**

`.claude-plugin/plugin.json` `version` and both `version` fields of `.claude-plugin/marketplace.json`: `0.23.4`. Then `./tests/run-tests.sh 2>&1 | tail -1`: `239 passed, 0 failed`.

- [ ] **Step 10: Commit and deliver**

One commit, with this exact subject: `feat(iterm-agents): hand the chain to the successor and place it between the orchestrator and its agents` — the launcher, both suites, the three texts, the two version files. Body: why (a successor spawned `--right-of self` landed after the last agent and joined the predecessor's chain as an agent, inheriting none of it, so its next spawn landed left of the agents; `--successor` names its own anchor and hands the chain over in the launcher, where a forgotten step cannot lose it). It stacks on the orchestrator's docs commit already on this branch. Push with `git push -u origin successor-chain`, open the draft PR as the brief says.
