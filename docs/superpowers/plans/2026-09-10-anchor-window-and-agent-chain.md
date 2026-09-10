# Anchor Window and Agent Chain Implementation Plan

> **For the orchestrator:** this plan is executed by implementer SESSIONS the orchestrator spawns (`orchestrator:iterm-agents`), one brief per task — never by subagents of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A spawned tab is born in the window that holds its anchor, an absent anchor is refused before any side effect, and each new agent lands after the orchestrator's last one rather than immediately beside the orchestrator.

**Architecture:** Two releases, one per kind of change. 0.17.1 is a repair inside `cmd_spawn`: the anchor is resolved with `find_tab` across every window before the prompt file and the trust record are written, and the tab is created in that window at that index. 0.18.0 is a behaviour: the launcher keeps a chain file per orchestrator tty under the state directory (`chains/<tty>.jsonl`, one line per spawn with the tab's `tab_id` and tty), resolves `self` to the last entry whose tab still exists in the orchestrator's window, prunes the rest, and `close` drops the entry it closed. `ORCHESTRATOR_SELF_TTY` makes the resolution testable without a terminal.

**Tech Stack:** Python 3 over the app's API module (`iterm2`), bash 3.2 for the suites, `jq` where the suite already uses it. No new dependency.

**Spec:** `docs/design.md`, section 21 — « The tab is born in the anchor's window, after the last agent ». Sections 2 (layout), 8 (release) and 14 (the API tooling) bind every task.

## Global Constraints

Copied from `CLAUDE.md`; every task's requirements include them.

- **English only, everywhere**: code, comments, identifiers, output strings, documentation, commit messages, branch names, PR text.
- **No vendor or product name in prose.** The runtime is "the host"; its sessions are "sessions" or "agents". Model names in examples are placeholders (`a-model`).
- **Load-bearing identifiers are exempt**: `~/.claude/`, `.claude-plugin/`, `CLAUDE_CONFIG_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_CODE_SESSION_ID`, `claude-orchestrator`, `ListAgents`, `SendMessage`. Anything new gets a neutral name (`ORCHESTRATOR_*`).
- **Commits**: Conventional Commits (`fix(iterm-agents): …`, `feat(iterm-agents): …`, `docs: …`, `chore: …`); no co-author trailer, no generated-with attribution, no tool name, no session link — nothing after the body. Subject in the imperative, body explaining *why*.
- **`CLAUDE.md` and `.claude/` are never committed.** They are local.
- **Before pushing**: `./tests/run-tests.sh` passes (168 checks today; the count grows with this plan); `grep -rniI 'claude' . --exclude-dir=.git` returns only exempt occurrences; no accented character or French word outside `docs/`.
- **Release** (spec §8): the version lives in `.claude-plugin/plugin.json` and in BOTH fields of `.claude-plugin/marketplace.json`; the suite checks they agree. A branch that changes behaviour bumps the version in its first commit.
- The unit suite runs with no terminal automation and no network. Anything that needs the app goes to `tests/e2e.sh`, which is run by the operator at the host's `!` prompt — **never by an implementer session** (the session's sandbox forbids the process-table read and the trust write to a nested call).
- Never run `spawn`, `close`, `move` or `rotate` against the live app from an implementer session. Dry runs only (`ORCHESTRATOR_DRY_RUN=1`).

---

### Task 1: The tab is born in the anchor's window (release 0.17.1)

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — `cmd_spawn` (lines 309-405): anchor resolution moved up and made a refusal; the `go` coroutine (lines 372-386) creates the tab in the anchor's window. One new coroutine `anchor_position` beside `find_tab` (after line 186).
- Modify: `skills/iterm-agents/SKILL.md` — the « Caveats » list gains one entry.
- Modify: `tests/e2e.sh` — a new block `== an anchor that is not there ==` inserted after the `== spawn ==` block's last check (after line 135, before the rotation block).
- Modify: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` — version `0.17.1`.
- Commit (already written, uncommitted in the worktree): `docs/design.md` section 21.

**Interfaces:**
- Consumes: `find_tab(app, tty) -> (window, tab, session) | (None, None, None)` and `tab_index_of(app, window, tab_id) -> (index | None, window)`, both existing.
- Produces: `async def anchor_position(app, anchor, side) -> (window, index) | (None, None)` where `side` is `"right"` or `"left"`; `index` is the position a new tab takes to sit on that side of the anchor. Task 2 calls it with the tty the chain resolves to.

- [ ] **Step 1: Write the live check that fails today**

Insert into `tests/e2e.sh` immediately after the line `check "the session is past the startup questions" …` and its closing `)"` (the last check of the `== spawn ==` block):

```bash
echo "== an anchor that is not there =="
# A tab that lands somewhere is worse than no tab: the script has said where it is and
# the orchestrator believes it. Before this check, an anchor in another window — or no
# window at all — was silently replaced by « the end of whatever window is in front ».
tabs_before=$(bash "$AGENT" list | wc -l | tr -d ' ')
ghost_out=$(bash "$AGENT" spawn --dir "$SANDBOX/repo" --tier "$tier" --title e2e-ghost --trust \
      --prompt "Do nothing." --right-of /dev/ttys999 2>&1)
ghost_code=$?
check "an absent anchor is refused" "1" "$ghost_code"
check "the refusal names the anchor" "1" "$(printf '%s' "$ghost_out" | grep -c 'no session found on /dev/ttys999')"
check "no tab was made for it" "$tabs_before" "$(bash "$AGENT" list | wc -l | tr -d ' ')"
```

- [ ] **Step 2: Do not run it**

`tests/e2e.sh` is the operator's. Report in your handshake that the block is written; the orchestrator has it run and sends you the result. Today's head fails it: the spawn appends a tab at the end of the front window and exits 0.

- [ ] **Step 3: Add `anchor_position`**

In `skills/iterm-agents/scripts/iterm_agent.py`, immediately after `find_tab` (after line 186, before the `# --- subcommands` banner):

```python
async def anchor_position(app, anchor, side):
    """The window that holds `anchor` and the index a new tab takes to sit on `side` of it.

    Every window is searched, not the one in front: the window in front is whatever the
    operator is looking at, and a launch happens precisely when they are looking elsewhere.
    The first implementation took `app.current_window` and searched only its tabs, so an
    anchor in another window was not found and the tab was appended to the wrong one, with
    the script reporting success. (None, None) when the anchor is not there."""
    win, tab, _ = await find_tab(app, anchor)
    if tab is None:
        return None, None
    idx, win = await tab_index_of(app, win, tab.tab_id)
    if idx is None:
        return None, None
    return win, idx + (1 if side == "right" else 0)
```

- [ ] **Step 4: Resolve the anchor before any side effect**

In `cmd_spawn`, delete these three lines where they stand (just before `async def go`):

```python
    anchor = args.right_of or args.left_of
    if anchor == "self":
        anchor = self_tty() or ""
```

and insert this block immediately after the `--tier`/`--model` resolution (after the `die("spawn: cannot resolve tier: …")` line and before `prompt_file = args.prompt_file`):

```python
    # The anchor first, before a prompt file is written or a trust record changed: an
    # anchor that is not there is a refusal, and a refusal must leave nothing behind.
    side = "right" if args.right_of else "left"
    anchor = args.right_of or args.left_of
    if anchor == "self":
        anchor = self_tty() or ""
        if not anchor:
            if DRY_RUN:
                anchor = "self"  # no terminal behind a dry run; the print still reads
            else:
                die("spawn: --right-of self: cannot resolve this session's own tty")
    if anchor and anchor != "self" and not DRY_RUN:
        async def probe(iterm2, connection):
            app = await iterm2.async_get_app(connection)
            win, _ = await anchor_position(app, anchor, side)
            return win is not None
        if not run(probe):
            die("spawn: no session found on %s" % anchor)
```

- [ ] **Step 5: Create the tab in the anchor's window**

Replace the body of `go` in `cmd_spawn` — from `app = await iterm2.async_get_app(connection)` through `return await tty_of(tab, connection)` — with:

```python
        app = await iterm2.async_get_app(connection)
        index = None
        if anchor:
            # Resolved again on a fresh app: the probe above ran on another connection,
            # and a window object is a cached copy (§14).
            win, index = await anchor_position(app, anchor, side)
            if win is None:
                die("spawn: no session found on %s" % anchor)
        else:
            win = app.current_window
            if win is None:
                die("spawn: iTerm2 has no current window")
        # select=False: the operator is working in another tab, and a spawn that pulls the
        # window to the new one interrupts them every time an agent is launched.
        tab = await win.async_create_tab(command=command, index=index, select=False)
        return await tty_of(tab, connection)
```

- [ ] **Step 6: Run the unit suite**

Run: `./tests/run-tests.sh 2>&1 | tail -3`
Expected: `168 passed, 0 failed` — this task adds no dry-run check (the refusal lives behind the API), and nothing existing may break. The check « two anchors are refused at spawn » must still pass: the mutual-exclusion `die` runs before the block you inserted.

- [ ] **Step 7: Document the caveat**

In `skills/iterm-agents/SKILL.md`, add to the « Caveats (all observed) » list, after the « Dynamic titles override manual ones » entry:

```markdown
- **The tab is born in the anchor's window, whichever window is in front.** With two windows open, a spawn anchored on a tab of the second once landed at the end of the first — the window in front — and reported success. The anchor is now searched across every window, and an anchor that is not there is refused before a tab exists (`spawn: no session found on <tty>`). A spawn with no anchor still appends to the window in front: that is one more reason to always name one.
```

- [ ] **Step 8: Bump the version**

Set `"version": "0.17.1"` in `.claude-plugin/plugin.json` and in both `metadata.version` and `plugins[0].version` of `.claude-plugin/marketplace.json`.

Run: `./tests/run-tests.sh 2>&1 | grep -A4 '== version =='`
Expected: every check in that section `ok`.

- [ ] **Step 9: Commit**

Two commits, in this order:

```bash
git add docs/design.md
git commit -m "docs(design): the tab is born in the anchor's window, after the last agent" -m "Two windows open, the orchestrator in the second, its agent at the end of the first: the window was chosen by focus. Section 21 names the two rules that replace it, one per release."

git add skills/iterm-agents/scripts/iterm_agent.py skills/iterm-agents/SKILL.md tests/e2e.sh .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "fix(iterm-agents): create the tab in the anchor's window, refuse an absent anchor" -m "The anchor was searched only in the window in front, so an anchor elsewhere was silently replaced by the end of the wrong window while the script reported success. Resolve it across every window before any side effect, and refuse when it is not there."
```

- [ ] **Step 10: Open the draft PR**

Branch `fix-anchor-window`, base `main`, title `Create the tab in the anchor's window, and refuse an anchor that is not there`. Report to the orchestrator with the PR link; do not start Task 2 until the orchestrator answers with the live result of the e2e block and its verdict.

---

### Task 2: Each new agent goes after the orchestrator's last one (release 0.18.0)

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — globals (after `PROMPTS_DIR`, line 33), `self_tty` (line 108), a new `# --- the chain` block of four functions and one coroutine before the `# --- the API` banner, `cmd_spawn` (the `self` branch, the dry-run print, the record after creation), `cmd_close` (the drop).
- Modify: `tests/run-tests.sh` — a new section `== agent chain (dry run) ==` inserted immediately before `echo "== dispatch record =="`.
- Modify: `tests/e2e.sh` — a second probe in the `== spawn ==` block and the chain assertions.
- Modify: `skills/iterm-agents/SKILL.md` — the « Tab layout convention » section; `README.md` — the `iterm-agents` row.
- Modify: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` — version `0.18.0`.

**Interfaces:**
- Consumes: `anchor_position(app, anchor, side)` from Task 1; `find_tab`; `STATE_DIR`.
- Produces:
  - `CHAINS_DIR = os.path.join(STATE_DIR, "chains")`
  - `def chain_path(tty) -> str` — `CHAINS_DIR/<basename of tty>.jsonl`
  - `def chain_read(tty) -> list[dict]` — each `{"tab_id": str, "tty": str}`; `[]` when absent or unreadable
  - `def chain_write(tty, entries) -> None` — whole file, temporary name then rename
  - `def chain_append(tty, tab_id, new_tty) -> None`
  - `def chain_drop_tab(tab_id) -> None` — every chain file, every entry with that `tab_id`
  - `async def chain_anchor(app, own_tty) -> str | None` — the tty of the last chain entry whose tab still exists in `own_tty`'s window, pruning the others; `None` when the chain is empty or exhausted
  - `self_tty()` honours `ORCHESTRATOR_SELF_TTY` when set
  - dry-run `spawn` prints `self=<tty or empty>` before `anchor=`, and `anchor=` shows the chain's resolution

- [ ] **Step 1: Write the failing dry-run tests**

Insert into `tests/run-tests.sh` immediately before the line `echo "== dispatch record =="`:

```bash
echo "== agent chain (dry run) =="
# The operator's rule: orchestrator, agent 1, agent 2, … in launch order. `--right-of self`
# used to mean « immediately right of my tab », which put every new agent BETWEEN the
# orchestrator and the previous one. The chain file names the last agent; `self` resolves
# to it. A dry run reads the chain and never writes it: there is no tab to record.
# Defined again here: this section runs before the spawn section that sets it, under set -u.
AGENT="$ROOT/skills/iterm-agents/scripts/iterm-agent.sh"
CHAINS="$WORK/istate/chains"; mkdir -p "$CHAINS"
chain_spawn() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$WORK/istate" ORCHESTRATOR_SELF_TTY=/dev/ttys900 bash "$AGENT" spawn --dir "$WORK" --prompt p "$@" 2>&1; }
out=$(chain_spawn --right-of self)
check "the dry run names the caller's tty" "1" "$(printf '%s' "$out" | grep -c '^self=/dev/ttys900$')"
check "no chain: self is the anchor" "1" "$(printf '%s' "$out" | grep -c '^anchor=self$')"
printf '{"tab_id":"t-1","tty":"/dev/ttys901"}\n{"tab_id":"t-2","tty":"/dev/ttys902"}\n' > "$CHAINS/ttys900.jsonl"
out=$(chain_spawn --right-of self)
check "a chain of two: the last is the anchor" "1" "$(printf '%s' "$out" | grep -c '^anchor=/dev/ttys902$')"
check "a dry run writes no chain" "2" "$(wc -l < "$CHAINS/ttys900.jsonl" | tr -d ' ')"
out=$(chain_spawn --right-of /dev/ttys555)
check "an explicit anchor ignores the chain" "1" "$(printf '%s' "$out" | grep -c '^anchor=/dev/ttys555$')"
out=$(chain_spawn --left-of self)
check "left of self ignores the chain" "1" "$(printf '%s' "$out" | grep -c '^anchor=self$')"
printf 'not json\n' > "$CHAINS/ttys900.jsonl"
out=$(chain_spawn --right-of self)
check "a corrupt chain reads as empty" "1" "$(printf '%s' "$out" | grep -c '^anchor=self$')"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./tests/run-tests.sh 2>&1 | grep -B1 -A2 'agent chain'`
Expected: FAIL on « the dry run names the caller's tty » (no `self=` line yet) and on « a chain of two » (the dry run prints `anchor=self` literally today). The others may pass by accident; that is fine.

- [ ] **Step 3: The seam and the chain functions**

In `iterm_agent.py`, after the `PROMPTS_DIR = …` line (line 33):

```python
CHAINS_DIR = os.path.join(STATE_DIR, "chains")
SELF_TTY = os.environ.get("ORCHESTRATOR_SELF_TTY", "")
```

In `self_tty()`, as its first statement (before `pid = os.getpid()`):

```python
    if SELF_TTY:
        return SELF_TTY
```

and extend its docstring with one line: `ORCHESTRATOR_SELF_TTY overrides the walk, so the chain can be tested where there is no terminal.`

Immediately before the `# --- the API` banner, add:

```python
# --- the chain: an orchestrator's agents, in launch order -------------------------

def chain_path(tty):
    return os.path.join(CHAINS_DIR, os.path.basename(tty) + ".jsonl")


def chain_read(tty):
    """The chain as a list of {"tab_id", "tty"}; empty when absent or unreadable. A chain
    that cannot be read anchors on the orchestrator itself, which is where the first agent
    went before the chain existed."""
    try:
        with open(chain_path(tty)) as fh:
            lines = [l for l in fh.read().splitlines() if l.strip()]
        entries = [json.loads(l) for l in lines]
        return [e for e in entries if isinstance(e, dict) and e.get("tab_id") and e.get("tty")]
    except Exception:
        return []


def chain_write(tty, entries):
    os.makedirs(CHAINS_DIR, exist_ok=True)
    path = chain_path(tty)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        for e in entries:
            fh.write(json.dumps({"tab_id": e["tab_id"], "tty": e["tty"]}) + "\n")
    os.replace(tmp, path)


def chain_append(tty, tab_id, new_tty):
    chain_write(tty, chain_read(tty) + [{"tab_id": tab_id, "tty": new_tty}])


def chain_drop_tab(tab_id):
    """Every chain, every entry naming this tab. `close` does not know which orchestrator
    the tab belonged to, and a tab id names exactly one tab."""
    if not os.path.isdir(CHAINS_DIR):
        return
    for name in os.listdir(CHAINS_DIR):
        if not name.endswith(".jsonl"):
            continue
        tty = "/dev/" + name[:-len(".jsonl")]
        entries = chain_read(tty)
        kept = [e for e in entries if e["tab_id"] != tab_id]
        if len(kept) != len(entries):
            chain_write(tty, kept)


async def chain_anchor(app, own_tty):
    """The tty of the last agent still open in the orchestrator's window, or None.

    Checked on tab id, never on tty: a tty is recycled minutes after a close, and an entry
    whose tty now belongs to a stranger's tab must not anchor a launch on it. Entries whose
    tab is gone are dropped on this read."""
    win, _, _ = await find_tab(app, own_tty)
    if win is None:
        return None
    live = {t.tab_id: t for t in win.tabs}
    entries = chain_read(own_tty)
    kept = [e for e in entries if e["tab_id"] in live]
    if len(kept) != len(entries):
        chain_write(own_tty, kept)
    for e in reversed(kept):
        tty = await tty_of(live[e["tab_id"]])
        if tty:
            return tty
    return None
```

Confirm `import json` is present at the top of the file (it is used by `resolve_tier`); add it if not.

- [ ] **Step 4: Resolve `self` through the chain in `cmd_spawn`**

Replace the block Task 1 inserted (from `side = "right" if …` through `die("spawn: no session found on %s" % anchor)`) with:

```python
    # The anchor first, before a prompt file is written or a trust record changed: an
    # anchor that is not there is a refusal, and a refusal must leave nothing behind.
    side = "right" if args.right_of else "left"
    anchor = args.right_of or args.left_of
    own = self_tty() or ""
    if anchor == "self":
        if not own and not DRY_RUN:
            die("spawn: --right-of self: cannot resolve this session's own tty")
        anchor = own or "self"
        if side == "right" and own:
            # After the orchestrator's LAST agent, not immediately after the orchestrator:
            # orchestrator, agent 1, agent 2, … in launch order.
            if DRY_RUN:
                chain = chain_read(own)
                anchor = chain[-1]["tty"] if chain else "self"
            else:
                async def last(iterm2, connection):
                    app = await iterm2.async_get_app(connection)
                    return await chain_anchor(app, own)
                anchor = run(last) or own
    if anchor and anchor != "self" and not DRY_RUN:
        async def probe(iterm2, connection):
            app = await iterm2.async_get_app(connection)
            win, _ = await anchor_position(app, anchor, side)
            return win is not None
        if not run(probe):
            die("spawn: no session found on %s" % anchor)
```

In the dry-run print block, replace `print("anchor=%s" % (args.right_of or args.left_of or ""))` with:

```python
        print("self=%s" % own)
        print("anchor=%s" % ("self" if anchor == own else anchor))
```

The print shows `self` whenever the resolved anchor is the caller's own tab, so « left of self » and « no chain » both read `anchor=self`, and a chain resolution reads as the tty it chose.

- [ ] **Step 5: Record the spawn and drop on close**

In `cmd_spawn`'s `go`, after `tab = await win.async_create_tab(…)` and before `return await tty_of(tab, connection)`:

```python
        new = await tty_of(tab, connection)
        if own and new:
            chain_append(own, tab.tab_id, new)
        return new
```

(and delete the now-duplicated `return await tty_of(tab, connection)`).

In `cmd_close`'s `go`, immediately after `await tab.async_close(force=True)`:

```python
        chain_drop_tab(tab.tab_id)
```

- [ ] **Step 6: Run the unit suite**

Run: `./tests/run-tests.sh 2>&1 | tail -3`
Expected: `175 passed, 0 failed` (168 + 7 new).

- [ ] **Step 7: The live proof**

In `tests/e2e.sh`, after the check « the tab landed immediately right of its anchor » (line 123) and before the « past the startup questions » loop, insert:

```bash
# The second agent goes after the FIRST, not between the orchestrator and it. `self` here
# is the tab running this script; both probes anchor on it and the chain orders them.
me=$(ORCHESTRATOR_DRY_RUN=1 bash "$AGENT" spawn --dir "$SANDBOX/repo" --right-of self 2>/dev/null | sed -n 's/^self=//p')
if [ -n "$me" ]; then
  one_out=$(bash "$AGENT" spawn --dir "$SANDBOX/repo" --tier "$tier" --title e2e-chain-1 --trust \
        --prompt "Do nothing." --right-of self 2>&1)
  ONE=$(printf '%s' "$one_out" | grep -oE '^/dev/ttys[0-9]+$' | tail -1)
  two_out=$(bash "$AGENT" spawn --dir "$SANDBOX/repo" --tier "$tier" --title e2e-chain-2 --trust \
        --prompt "Do nothing." --right-of self 2>&1)
  TWO=$(printf '%s' "$two_out" | grep -oE '^/dev/ttys[0-9]+$' | tail -1)
  pos_one=$(bash "$AGENT" list | grep -n "$ONE" | cut -d: -f1)
  pos_two=$(bash "$AGENT" list | grep -n "$TWO" | cut -d: -f1)
  check "the second agent lands right of the first, not of the orchestrator" "$((pos_one + 1))" "$pos_two"
  chain="${ORCHESTRATOR_STATE_DIR:-$HOME/.claude/claude-orchestrator}/chains/$(basename "$me").jsonl"
  check "the chain names both" "2" "$(grep -c "\"tty\": \"$ONE\"\|\"tty\": \"$TWO\"" "$chain")"
  bash "$AGENT" close --tty "$TWO" >/dev/null 2>&1
  bash "$AGENT" close --tty "$ONE" >/dev/null 2>&1
  check "a closed agent leaves the chain" "0" "$(grep -c "\"tty\": \"$ONE\"\|\"tty\": \"$TWO\"" "$chain")"
else
  echo "  skip the chain: this shell has no tty of its own"
fi
```

Also add `ONE` and `TWO` to the `cleanup` loop at the top of the file: `for t in "$TTY" "${OLD_TTY:-}" "${ONE:-}" "${TWO:-}"; do`.

Do not run it. Report that it is written; the orchestrator has the operator run it.

- [ ] **Step 8: Documentation**

In `skills/iterm-agents/SKILL.md`, « Tab layout convention »: replace the bullet `- spawning an implementer: \`--right-of self\` — your own tab, …` with:

```markdown
- spawning an implementer: `--right-of self` — after your LAST still-open agent, or your own tab when you have none. The launcher keeps the chain (`chains/<your tty>.jsonl` under the state directory) and the order reads left to right as launch order: you, agent 1, agent 2, … A closed agent leaves the chain; a tty is never trusted across a close, the chain is checked on the app's tab id.
```

In `README.md`, in the `iterm-agents` row, replace `Placement anchors on a tty or on \`self\`, the caller's own tab.` with `Placement anchors on a tty or on \`self\` — after the caller's last open agent, so a window reads as launch order.`

- [ ] **Step 9: Bump the version and commit**

Set `0.18.0` in `.claude-plugin/plugin.json` and both fields of `.claude-plugin/marketplace.json`. Run `./tests/run-tests.sh 2>&1 | tail -1` → `175 passed, 0 failed`.

```bash
git add skills/iterm-agents/scripts/iterm_agent.py tests/run-tests.sh tests/e2e.sh skills/iterm-agents/SKILL.md README.md .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "feat(iterm-agents): place each new agent after the orchestrator's last one" -m "Right of self meant immediately right, so every new agent slid in between the orchestrator and the previous one and a window read the launch order backwards. A chain file per orchestrator tty names the last agent; self resolves to it, checked on the app's tab id because a tty is recycled across a close."
```

- [ ] **Step 10: Open the draft PR**

Branch `agent-chain`, created from the head of `fix-anchor-window`, base `fix-anchor-window`, title `Place each new agent after the orchestrator's last one`. `Related PR:` section with the bare link of the 0.17.1 PR. Report to the orchestrator with the link.
