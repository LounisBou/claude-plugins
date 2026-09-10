# Hidden Pane, Chain Owner and Inherited Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three releases, one per task, stacked. 0.21.1: a session behind a maximized sibling pane is listed, found and closed, and `close` closes the session rather than the tab. 0.21.2: a chain entry names the session that wrote it, so a recycled tty no longer inherits a stranger's chain. 0.22.0: the succession hands the successor the orchestrator's current model instead of a tier.

**Architecture:** Task 1 swaps `sessions` for `all_sessions` in every reader of `iterm_agent.py`, marks hidden rows in the listing, and makes `close` call the session's close. Task 2 adds an `owner` field to chain entries and filters on it at read time. Task 3 makes the context tap record `model_id`, adds `--inherit-model` to `spawn`, and rewrites the succession command's spawn line. The dry run and a stub of the app are the suite's doors; the live round reads the rest.

**Tech Stack:** Python 3, bash 3.2 for the suite, `jq` for the tap.

**Spec:** `docs/design.md`, sections 25, 26 and 27. Sections 8, 14 and 21 bind them.

## Global Constraints

Copied from `CLAUDE.md`; every task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt.
- **Commits**: Conventional Commits; no trailer, no attribution, no tool name, no session link.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (182 on the base head; Task 1 adds 3, Task 2 adds 3, Task 3 adds 6); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`, one bump per task: `0.21.1`, `0.21.2`, `0.22.0`.
- **Never run anything against the live app from the suite.** Dry runs and stubs only. The live round (`tests/e2e.sh`) is the orchestrator's to run, and it gains checks in Tasks 1 and 2 that the implementer writes but does not run.
- **Every command runs synchronously**, in the tool call that waits for it; the suite is piped to `tail` in the same call.
- **Branches**: created with `git switch -c <name> <base> --no-track`, never `git checkout -b X origin/Y` (the tracking write fails in the sandbox and leaves HEAD behind).

---

### Task 1: A hidden pane is still a session (0.21.1)

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — `chain_anchor` (the `live` dict is unchanged, it keys tabs), `find_tab`, `cmd_list`, `cmd_close`, `cmd_screen`; a new async helper `list_rows(app)` that `cmd_list` prints and the suite calls on a stub; a new async helper `close_session(app, tty, expect)` that `cmd_close` runs and the suite calls on a stub.
- Modify: `tests/run-tests.sh` — three checks in a new section « the app, stubbed » placed immediately before `echo "== tap =="`.
- Modify: `tests/e2e.sh` — a new block « a hidden pane » between « an anchor that is not there » and « rotation ».
- Modify: `skills/iterm-agents/SKILL.md` — the `list` line of the quick reference; a new caveat; the « Common mistakes » list.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.21.1`.
- Commit (already in the worktree, written by the orchestrator): `docs/design.md` sections 25, 26, 27, and this plan file.

**Interfaces:**
- Consumes: `iterm2.Tab.all_sessions` (visible + minimized sessions), `iterm2.Session.async_close(force=True)`, both present in the installed library.
- Produces: `async def list_rows(app) -> list[str]` — one line per session, `w%d/t%d | %s | %s` as today, with ` | hidden` appended for a session that is in `all_sessions` and not in `sessions`. `async def find_tab(app, tty) -> (window, tab, session)` — unchanged signature, searches `all_sessions`. `async def close_session(app, tty, expect) -> str` — finds the session by tty, applies the title guard, calls `session.async_close(force=True)`, calls `chain_drop_tab(tab.tab_id)`, returns the session's title; never calls `tab.async_close`.

- [ ] **Step 1: Write the failing checks**

In `tests/run-tests.sh`, immediately before the line `echo "== tap =="`, insert:

```bash
echo "== the app, stubbed =="
# A pane behind a maximized sibling is in the tab's all_sessions and not in its sessions.
# The stub is the smallest app that tells the two apart; the live round reads the real one.
STUB='
import asyncio, sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
class S:
    def __init__(s, sid, tty, name): s.session_id=sid; s.tty=tty; s.name=name; s.closed=False
    async def async_get_variable(s, k): return {"tty": s.tty, "autoName": s.name}.get(k)
    async def async_close(s, force=False): s.closed=True
class T:
    def __init__(s, tid, visible, hidden): s.tab_id=tid; s.sessions=visible; s.all_sessions=visible+hidden
    async def async_close(s, force=False): raise AssertionError("tab closed")
class W:
    def __init__(s, tabs): s.window_id="w"; s.tabs=tabs
class App:
    def __init__(s, wins): s.windows=wins
a=S("A","/dev/ttys801","visible one"); b=S("B","/dev/ttys802","hidden one")
app=App([W([T("1",[a],[b])])])
'
py=$(command -v python3 || echo python3)
check "a hidden pane is found by its tty" "B" \
  "$("$py" -c "$STUB
_,_,s=asyncio.run(ia.find_tab(app,'/dev/ttys802')); print(s.session_id)" "$ROOT/skills/iterm-agents/scripts")"
check "the listing marks a hidden pane" "w1/t1 | /dev/ttys802 | hidden one | hidden" \
  "$("$py" -c "$STUB
print([r for r in asyncio.run(ia.list_rows(app)) if 'ttys802' in r][0])" "$ROOT/skills/iterm-agents/scripts")"
check "close closes the session and leaves the tab" "hidden one|True" \
  "$("$py" -c "$STUB
t=asyncio.run(ia.close_session(app,'/dev/ttys802','hidden')); print('%s|%s' % (t, b.closed))" "$ROOT/skills/iterm-agents/scripts")"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./tests/run-tests.sh 2>&1 | grep -E 'hidden|passed'`
Expected: three FAIL lines; `182 passed, 3 failed`.

- [ ] **Step 3: Every reader enumerates all sessions**

In `iterm_agent.py`:

In `find_tab`, replace `for s in t.sessions:` with `for s in t.all_sessions:` and add above the function this docstring line: `"""A session behind a maximized sibling is in all_sessions and not in sessions (§25)."""`.

In `chain_anchor`, nothing changes: `live` keys tabs, and `tty_of(tab)` reads the tab's current session, which a chain entry's tab always has.

Replace `cmd_list` with:

```python
async def list_rows(app):
    """One row per session, hidden panes included and marked. A pane behind a maximized
    sibling is what the host extension's review views make of an agent's tab; a listing
    that dropped it made a live agent unfindable and unclosable (§25)."""
    lines = []
    for wi, w in enumerate(app.windows, 1):
        for ti, t in enumerate(w.tabs, 1):
            visible = {s.session_id for s in t.sessions}
            for s in t.all_sessions:
                tty = await s.async_get_variable("tty")
                name = await s.async_get_variable("autoName") or ""
                row = "w%d/t%d | %s | %s" % (wi, ti, tty, name)
                if s.session_id not in visible:
                    row += " | hidden"
                lines.append(row)
    return lines


def cmd_list(_argv):
    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        return await list_rows(app)

    for line in run(go) or []:
        print(line)
```

In `cmd_close`, replace the body of `go` and add the helper above the command:

```python
async def close_session(app, tty, expect):
    """Close the SESSION on that tty, never its tab: with the host extension in use the
    tab also holds the review pane the operator is reading, and a session closed alone
    leaves its siblings; when it was the last one the app removes the tab itself (§25)."""
    _, tab, sess = await find_tab(app, tty)
    if tab is None:
        die("close: no session found on %s" % tty)
    name = await sess.async_get_variable("autoName") or ""
    if expect and stable_title(expect) not in stable_title(name):
        die("close: refused: session on %s is titled '%s', which does not contain '%s'"
            % (tty, name, expect))
    await sess.async_close(force=True)
    chain_drop_tab(tab.tab_id)
    return name
```

and in `cmd_close`:

```python
    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        return await close_session(app, args.tty, args.expect)
```

`cmd_screen` needs no change beyond `find_tab`: a hidden session answers `async_get_screen_contents` like any other.

- [ ] **Step 4: Run the suite**

Run: `./tests/run-tests.sh 2>&1 | tail -1`
Expected: `185 passed, 0 failed`.

- [ ] **Step 5: The live checks (written, not run)**

In `tests/e2e.sh`, between the « an anchor that is not there » block and `echo "== rotation =="`, insert:

```bash
echo "== a hidden pane =="
# The host extension's review views are sibling panes of the agent's tab, one maximized at
# a time. The probe's tab is split and the new pane maximized through the app, exactly as
# the extension does; the agent behind it must stay listed, findable and closable alone.
py="${ORCHESTRATOR_PYTHON:-${ORCHESTRATOR_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator}/venv/bin/python}"
SIB=$("$py" - "$TTY" <<'EOF'
import iterm2, asyncio, sys
tty = sys.argv[1]
async def main(connection):
    app = await iterm2.async_get_app(connection)
    for w in app.windows:
        for t in w.tabs:
            for s in t.all_sessions:
                if await s.async_get_variable("tty") == tty:
                    sib = await s.async_split_pane(vertical=True)
                    await asyncio.sleep(1)
                    await t.async_select()
                    await sib.async_activate()
                    ident = iterm2.MainMenu.View.MAXIMIZE_ACTIVE_PANE.value.identifier
                    await iterm2.MainMenu.async_select_menu_item(connection, ident)
                    await asyncio.sleep(1)
                    print(await sib.async_get_variable("tty"))
                    return
iterm2.run_until_complete(main)
EOF
)
check "the agent behind a maximized pane is listed, and marked" "1" "$(bash "$AGENT" list | grep "$TTY" | grep -c '| hidden$')"
bash "$AGENT" close --tty "$TTY" --expect-title "e2e" >/dev/null 2>&1
check "the hidden agent closes by its tty" "0" "$?"
check "its sibling pane survives the close" "1" "$(bash "$AGENT" list | grep -c "$SIB")"
bash "$AGENT" close --tty "$SIB" >/dev/null 2>&1
check "the sibling closes with the tab" "0" "$(bash "$AGENT" list | grep -c "$SIB")"
TTY=""
```

The rotation and stand-down blocks then need a live probe: the block ends by spawning a fresh one (title e2e-probe-2, same anchor) and waiting for its process, one more check — the round reads 35 passed. The `cleanup` function's list of ttys gains `"${SIB:-}"`.

- [ ] **Step 6: Documentation**

In `skills/iterm-agents/SKILL.md`, in the quick reference, change the `list` comment to two lines:

```
    # w1/t3 | /dev/ttys000 | ✳ agent-brief prompt (node)
    # w1/t1 | /dev/ttys004 | ◐ Implementer : phase 2 | hidden   ← behind a maximized sibling pane
```

Add to « Caveats »:

```markdown
- **A pane behind a maximized sibling is still a session, and it is listed as `hidden`.** The
  host extension's « Chat / Diff / Code Review » bar opens each view as a sibling pane of the
  agent's tab and maximizes the one shown, so an agent with a review open is hidden and its
  tab shows the review. The tool reads hidden panes like visible ones; `close --tty` closes
  that SESSION alone and leaves the review pane and the tab. Before this, a hidden agent was
  unfindable and unclosable while `ListAgents` showed it alive.
```

Add to « Common mistakes »: `- Reading « alive in ListAgents, absent from list » as a dead session: it was the hidden-pane defect, fixed in 0.21.1; if it recurs, it is a new defect to measure, not a rule.`

Add to « Tab hygiene »: `**One agent = one tab, never a pane.** A pane shares a tab's title and its fate; the tooling closes sessions, but a layout the operator reads is not a place to put an agent.`

- [ ] **Step 7: Version and commits**

Set `0.21.1` in `.claude-plugin/plugin.json` and both fields of `.claude-plugin/marketplace.json`. Re-run the suite → `185 passed, 0 failed`.

```bash
git add docs/design.md docs/superpowers/plans/2026-09-10-hidden-pane-chain-owner-inherited-model.md
git commit -m "docs(design): a hidden pane is still a session; a chain belongs to a session; the successor inherits the model" -m "A successor could not close a predecessor hidden behind a maximized review pane, a recycled tty handed a stranger's chain to a new session, and a succession re-routed the operator's model through the tier map. Sections 25 to 27 name each mechanism and its rule."

git add skills/iterm-agents/scripts/iterm_agent.py tests/run-tests.sh tests/e2e.sh skills/iterm-agents/SKILL.md .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "fix(iterm-agents): list, find and close a session hidden behind a maximized pane" -m "Every reader enumerated a tab's visible sessions only, so an agent behind a maximized sibling pane was unfindable and unclosable while it answered messages. Readers now take all sessions, the listing marks hidden rows, and close closes the session rather than the tab so a sibling pane the operator is reading survives."
```

- [ ] **Step 8: Open the draft PR**

Branch `hidden-pane`, created with `git switch -c hidden-pane main --no-track`, base `main`, title `List, find and close a session hidden behind a maximized pane`. Report to the orchestrator with the link or the compare link.

---

### Task 2: A chain belongs to a session, not to a tty (0.21.2)

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — `chain_write`, `chain_append`, `chain_anchor`, the `self` branch of `cmd_spawn` (both the dry-run and the live path), a new pure function `chain_owned(entries, owner)`, a new constant `SELF_ID`.
- Modify: `tests/run-tests.sh` — three checks appended to the chain section (after « a corrupt chain reads as empty »).
- Modify: `tests/e2e.sh` — one check in the chain block, after « the chain names both ».
- Modify: `skills/iterm-agents/SKILL.md` — the « Tab layout convention » paragraph on the chain.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.21.2`.

**Interfaces:**
- Consumes: `chain_read(tty) -> list[dict]` (unchanged: entries with `tab_id` and `tty`, an `owner` key kept when present).
- Produces: `def chain_owned(entries, owner) -> list[dict]` — with `owner` empty, `entries` unchanged; otherwise the entries whose `owner` equals it, entries without an owner dropped. `chain_append(tty, tab_id, new_tty, owner)` writes `{"tab_id", "tty", "owner"}`. `chain_anchor(app, own_tty)` reads the session id of the session on `own_tty` (`find_tab` → `sess.session_id`) and keeps `chain_owned(entries, that id)` ∩ live tabs, rewriting the file when anything was dropped. The dry-run anchor is `chain_owned(chain_read(own), SELF_ID)` with `SELF_ID = os.environ.get("ORCHESTRATOR_SELF_ID", "")`.

- [ ] **Step 1: Write the failing checks**

In `tests/run-tests.sh`, after the check « a corrupt chain reads as empty », insert:

```bash
# A tty is recycled; the chain file named after it survives its occupant. An entry names
# the session that wrote it, and a reader keeps only its own (§26).
printf '{"tab_id":"7","tty":"/dev/ttys907","owner":"S-OTHER"}\n{"tab_id":"8","tty":"/dev/ttys908","owner":"S-ME"}\n' > "$CHAINS/ttys900.jsonl"
out=$(ORCHESTRATOR_SELF_ID=S-ME chain_spawn --right-of self)
check "an entry of another session is skipped, an own one anchors" "1" "$(printf '%s' "$out" | grep -c '^anchor=/dev/ttys908$')"
out=$(ORCHESTRATOR_SELF_ID=S-NEW chain_spawn --right-of self)
check "a chain written by strangers anchors on self" "1" "$(printf '%s' "$out" | grep -c '^anchor=self$')"
printf '{"tab_id":"9","tty":"/dev/ttys909"}\n' > "$CHAINS/ttys900.jsonl"
out=$(ORCHESTRATOR_SELF_ID=S-ME chain_spawn --right-of self)
check "an entry with no owner is skipped once an owner is known" "1" "$(printf '%s' "$out" | grep -c '^anchor=self$')"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./tests/run-tests.sh 2>&1 | grep -E 'owner|strangers|passed'`
Expected: the first and third FAIL (the second passes by accident today, which is fine: a check may pass before its code exists when the behaviour it pins is the fallback); `186 passed, 2 failed`.

- [ ] **Step 3: The owner**

In `iterm_agent.py`, after `SELF_TTY = ...`, add:

```python
# The app's session id of the caller, for a dry run that has no app to ask (§26).
SELF_ID = os.environ.get("ORCHESTRATOR_SELF_ID", "")
```

Replace `chain_write`, `chain_append` and add `chain_owned`:

```python
def chain_write(tty, entries):
    os.makedirs(CHAINS_DIR, exist_ok=True)
    path = chain_path(tty)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        for e in entries:
            fh.write(json.dumps({"tab_id": e["tab_id"], "tty": e["tty"],
                                 "owner": e.get("owner", "")}) + "\n")
    os.replace(tmp, path)


def chain_append(tty, tab_id, new_tty, owner):
    chain_write(tty, chain_read(tty) + [{"tab_id": tab_id, "tty": new_tty, "owner": owner}])


def chain_owned(entries, owner):
    """The entries this session wrote. A tty is recycled minutes after a close and the
    chain file named after it outlives its occupant: a successor on the same tty once
    inherited an entry naming its predecessor's tab, still open, and anchored on it. With
    no owner known (a dry run without ORCHESTRATOR_SELF_ID) nothing is filtered."""
    if not owner:
        return entries
    return [e for e in entries if e.get("owner") == owner]
```

In `chain_anchor`, replace

```python
    win, _, _ = await find_tab(app, own_tty)
    if win is None:
        return None
    live = {t.tab_id: t for t in win.tabs}
    entries = chain_read(own_tty)
    kept = [e for e in entries if e["tab_id"] in live]
```

with

```python
    win, _, own_sess = await find_tab(app, own_tty)
    if win is None:
        return None
    live = {t.tab_id: t for t in win.tabs}
    entries = chain_read(own_tty)
    kept = [e for e in chain_owned(entries, own_sess.session_id) if e["tab_id"] in live]
```

In `cmd_spawn`, in the dry-run branch, replace `chain = chain_read(own)` with `chain = chain_owned(chain_read(own), SELF_ID)`. Where the live spawn appends to the chain (the `chain_append(own, tab.tab_id, new)` call after the tab is created), pass the caller's session id: read it once before creating the tab, `own_sess_id = (await find_tab(app, own))[2].session_id if own else ""`, and call `chain_append(own, tab.tab_id, new, own_sess_id)`.

- [ ] **Step 4: Run the suite**

Run: `./tests/run-tests.sh 2>&1 | tail -1`
Expected: `188 passed, 0 failed`.

- [ ] **Step 5: The live check (written, not run)**

In `tests/e2e.sh`, after the check « the chain names both », insert:

```bash
  check "the chain names its owner" "2" "$(grep -c '"owner": "[^"]' "$chain")"
```

- [ ] **Step 6: Documentation**

In `skills/iterm-agents/SKILL.md`, « Tab layout convention », the `--right-of self` bullet: after `the chain is checked on the app's tab id`, append `, and on the session that wrote the entry — a tty is recycled and its chain file outlives its occupant, so a new session on an old tty reads only its own entries`.

- [ ] **Step 7: Version and commit**

Set `0.21.2` in `.claude-plugin/plugin.json` and both fields of `.claude-plugin/marketplace.json`. Re-run the suite → `188 passed, 0 failed`.

```bash
git add skills/iterm-agents/scripts/iterm_agent.py tests/run-tests.sh tests/e2e.sh skills/iterm-agents/SKILL.md .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "fix(iterm-agents): keep only the chain entries the calling session wrote" -m "A chain file is named after a tty, and a tty is recycled: a successor on its predecessor's old tty inherited an entry naming a tab that was never its agent and anchored a spawn on it. Each entry now names the session that wrote it, and a reader drops the rest."
```

- [ ] **Step 8: Open the draft PR**

Branch `chain-owner`, created with `git switch -c chain-owner hidden-pane --no-track`, base `hidden-pane`, title `Keep only the chain entries the calling session wrote`. Body carries `Related PR:` with the bare link of Task 1's PR.

---

### Task 3: The successor inherits the orchestrator's model (0.22.0)

**Files:**
- Modify: `skills/context-gauge/scripts/statusline-tap.sh` — the `jq` field list and the `printf` record gain `model_id`.
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — `cmd_spawn` (`--inherit-model` option, exclusivity, resolution), a new function `inherited_model()`, the dry-run output line `model=`.
- Modify: `skills/iterm-agents/scripts/iterm-agent.sh` — the header's `spawn` usage line.
- Modify: `commands/succeed.md` — step 2's spawn line and its sentence on the tier.
- Modify: `templates/orchestrator-succession-brief.md` — if it names `--tier deep` for the successor's spawn, replace with `--inherit-model` (grep first; leave untouched if it does not).
- Modify: `tests/run-tests.sh` — one check in « tap », three in the spawn dry-run section (after the `--tier and --model are mutually exclusive` check, or after the last `--model` check if that one does not exist), one guard on `commands/succeed.md` next to the other command guards.
- Modify: `skills/iterm-agents/SKILL.md` — the quick reference `spawn` line; `skills/orchestrator/SKILL.md` — the succession list item 2 (« Spawn the successor via … ») gains `with --inherit-model`.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.22.0`.

**Interfaces:**
- Consumes: the host's status payload field `.model.id` (a string, absent on some renders); the tap file `<state>/ctx/<session_id>.json`; `CLAUDE_CODE_SESSION_ID` in the calling session's environment.
- Produces: the tap record gains `"model_id":<json string or null>` after `"transcript_path"`. `def inherited_model() -> str` reads `CLAUDE_CODE_SESSION_ID`, opens the tap file under `STATE_DIR/ctx/`, returns `model_id`; dies with `spawn: --inherit-model: no model recorded for this session (<path>) — the context tap must be installed and rendering: /orchestrator:install, then restart` when the variable, the file or the field is missing. `spawn --inherit-model` types that id as `--model`; it is refused together with `--tier` or `--model` (`spawn: --inherit-model is exclusive with --tier and --model`). The dry run's `launch=` line carries `--model <id>`, as it does for a bound tier.

- [ ] **Step 1: Write the failing checks**

In `tests/run-tests.sh`, in the « tap » section, after the check that compares the recorded file for `s-1` (`del(.updated_epoch)`), insert:

```bash
# The model in use travels with the context figures: a succession hands it to the
# successor, and the launch line is not it — the operator may have switched since (§27).
printf '{"session_id":"s-m","model":{"id":"a-model","display_name":"A"},"context_window":{"used_percentage":10}}' | ORCHESTRATOR_STATE_DIR="$STATE" bash "$TAP" >/dev/null
check "the tap records the model in use" "a-model" "$(jq -r '.model_id' "$STATE/ctx/s-m.json")"
```

In the spawn dry-run section, after the exclusivity check on `--tier` and `--model`, insert:

```bash
mkdir -p "$ISTATE/ctx"
printf '{"session_id":"s-inh","model_id":"a-model","updated_epoch":%s}\n' "$(date +%s)" > "$ISTATE/ctx/s-inh.json"
check "inherit-model types the calling session's model" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-inh ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --inherit-model 2>&1 | sed -n 's/^launch=//p' | grep -c -- '--model a-model')"
check "inherit-model with no tap file refuses and names the installer" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-none ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --inherit-model 2>&1 | grep -c 'orchestrator:install')"
check "inherit-model is exclusive with a tier" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-inh ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --inherit-model --tier deep 2>&1 | grep -c 'exclusive')"
```

Next to the other command guards (after « the decide command records before it moves on »), insert:

```bash
check "the succession inherits the orchestrator's model" "1" "$(grep -c -- '--inherit-model' "$ROOT/commands/succeed.md")"
check "the succession names no tier" "0" "$(grep -c -- '--tier deep' "$ROOT/commands/succeed.md")"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./tests/run-tests.sh 2>&1 | grep -E 'inherit|model in use|names no tier|passed'`
Expected: five FAIL lines (« names no tier » fails because `succeed.md` carries `--tier deep` today); `188 passed, 6 failed`.

- [ ] **Step 3: The tap**

In `statusline-tap.sh`, in the `jq` array, append after `(.transcript_path // "")`: `, (.model.id // "")`; extend the `read` line with a ninth name `mid`; after the `tpj` line add `if [ -n "$mid" ]; then midj="\"$mid\""; else midj=null; fi`; in the `printf` format append `,"model_id":%s` before the closing brace and `"$midj"` after `"$tpj"` in the arguments. Declare `mid midj` in the `local` line.

- [ ] **Step 4: The launcher**

In `iterm_agent.py`, add after `resolve_tier`:

```python
def inherited_model():
    """The model the CALLING session runs on now, from the context tap's record — not the
    launch line, which the operator may have moved away from. A succession must not guess
    a model and the operator forbids a default (§27)."""
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    path = os.path.join(STATE_DIR, "ctx", sid + ".json") if sid else "<CLAUDE_CODE_SESSION_ID unset>"
    model = ""
    try:
        with open(path) as fh:
            model = json.load(fh).get("model_id") or ""
    except Exception:
        pass
    if not model:
        die("spawn: --inherit-model: no model recorded for this session (%s) — the context "
            "tap must be installed and rendering: /orchestrator:install, then restart" % path)
    return model
```

In `cmd_spawn`: add `p.add_argument("--inherit-model", dest="inherit", action="store_true")`; after the existing `--tier`/`--model` exclusivity check add

```python
    if args.inherit and (args.tier or args.model):
        die("spawn: --inherit-model is exclusive with --tier and --model")
    if args.inherit:
        model = inherited_model()
```

placed so that `model` is set before `build_command` is called (the dry-run `launch=` line is printed from its result).

- [ ] **Step 5: The succession command and the docs**

In `commands/succeed.md`, step 2: replace `--tier deep` with `--inherit-model`, and replace the two sentences `The successor runs at the \`deep\` tier: its output — the sequencing, the verdicts, the arbitrations it relays — is re-read by nobody. See \`orchestrator:model-routing\`.` with `The successor runs on the model this session runs on NOW — the operator's choice, carried across every succession; the map binds agents, never the orchestrator (spec §27).`

In `templates/orchestrator-succession-brief.md`: `grep -n -- '--tier deep'`; replace each hit that concerns the successor's spawn with `--inherit-model`; leave the file untouched if there is none.

In `skills/iterm-agents/SKILL.md`, quick reference `spawn` line: change `[--tier deep|standard|light]` to `[--tier deep|standard|light | --inherit-model]` and add a comment line `# --inherit-model types the calling session's current model (from the context tap); for a successor.`

In `skills/orchestrator/SKILL.md`, « Your own context » step 2, replace `Spawn the successor via \`orchestrator:iterm-agents\` with the brief as startup prompt` with `Spawn the successor via \`orchestrator:iterm-agents\` with \`--inherit-model\` and the brief as startup prompt`. Grep `tests/run-tests.sh` for the literal being changed before editing; re-pin any guard that pinned it.

In `iterm-agent.sh`, the header usage line for `spawn`: `[--tier deep|standard|light | --model <id> | --inherit-model]`.

- [ ] **Step 6: Run the suite**

Run: `./tests/run-tests.sh 2>&1 | tail -1`
Expected: `194 passed, 0 failed`.

- [ ] **Step 7: Version and commits**

Set `0.22.0` in `.claude-plugin/plugin.json` and both fields of `.claude-plugin/marketplace.json`. Re-run the suite → `194 passed, 0 failed`.

```bash
git add skills/context-gauge/scripts/statusline-tap.sh tests/run-tests.sh
git commit -m "feat(context-gauge): record the model in use in the tap file" -m "A succession needs the model the orchestrator runs on now, which the launch line no longer says once the operator has switched. The status payload carries it on every render; the tap keeps it beside the context figures."

git add skills/iterm-agents/scripts/iterm_agent.py skills/iterm-agents/scripts/iterm-agent.sh commands/succeed.md templates/orchestrator-succession-brief.md skills/iterm-agents/SKILL.md skills/orchestrator/SKILL.md tests/run-tests.sh .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "feat(iterm-agents): let a spawn inherit the calling session's model" -m "The succession spawned the successor at the deep tier, so a model the operator had set by hand was re-routed through the map at every hand-over. The operator's ruling is that the successor inherits the orchestrator's current model and that no default exists; --inherit-model reads it from the tap and refuses when nothing is recorded."
```

- [ ] **Step 8: Open the draft PR**

Branch `inherited-model`, created with `git switch -c inherited-model chain-owner --no-track`, base `chain-owner`, title `Let a spawn inherit the calling session's model`. Body carries `Related PR:` with the bare link of Task 2's PR.
