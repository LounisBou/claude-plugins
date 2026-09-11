# Tab Guards, Successor Name, Global Excludes And Four Readings Implementation Plan

> **For the orchestrator:** this plan is executed by implementer SESSIONS the orchestrator spawns (`orchestrator:iterm-agents`), one brief per task — never by subagents of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** three releases, one per kind of change. 0.25.0: the tab tooling knows the caller's own tab, names every session in its listing, moves only what is the caller's, shapes every title, derives a successor's name and refuses an orchestrator title on a plain anchor, and forwards `--trust` through a rotation. 0.25.1: a phase's checkout also carries what the operator's global excludes file keeps out of the source. 0.25.2: the rulebook, the tab skill, the templates and the succession command say what four live rounds taught.

**Architecture:** 0.25.0 is `skills/iterm-agents/scripts/iterm_agent.py` (and its tab skill document and `commands/succeed.md`) with dry-run checks in the suite and titles reshaped in the end-to-end script. 0.25.1 is `skills/orchestrator/scripts/workspace.sh` with fixture checks. 0.25.2 is text with one literal guard per item.

**Tech Stack:** Python 3 (the launcher, standard library only), bash 3.2 (the workspace script, the suite).

**Spec:** `docs/design.md`, sections 38, 39, 40, 41. Sections 24 (a session is named at launch), 34 (the successor's place and chain), 30 and 35 (the checkout's local material) bind the readings.

## Global Constraints

Copied from `CLAUDE.md`; every task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt.
- **Commits**: Conventional Commits with a scope (`feat(iterm-agents):`, `fix(workspace):`, `docs(orchestrator):`, `test(e2e):`); no trailer, no attribution, no tool name, no session link. Subject in the imperative, body says why.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (258 on the base head `aa6802c`; each task states what it adds); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`; the tag is the orchestrator's, after the merge.
- **Every command runs synchronously**, in the tool call that waits for it; the suite is piped to `tail` in the same call.
- **The checkout you work in is already on the task's branch** (the orchestrator committed this plan and the spec on it): do not create another branch.
- **The end-to-end script (`tests/e2e.sh`) drives the terminal app**: the implementer runs it only when the brief says so; the dry run is the suite's door.

---

### Task 1: The tab tooling guards its caller (0.25.0)

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — `list_rows`, `cmd_move`, `cmd_spawn` (title shape, successor name, orchestrator title), `cmd_rotate` unchanged in behaviour, a process-table reader.
- Modify: `skills/iterm-agents/SKILL.md` — the quick reference (`list` row shape, `move` refusal, `spawn` title rules and `--title-free`, `rotate … --trust`), the caveats (the first title is the host's « Chat »).
- Modify: `commands/succeed.md` — the spawn line drops `--title`.
- Modify: `tests/run-tests.sh` — the dry-run checks below.
- Modify: `tests/e2e.sh` — titles in the shape (`Probe : e2e`, `Implementer : e2e chain 1`, `Implementer : e2e chain 2`, `Probe : e2e ghost`, `Probe : e2e 2`, `Implementer : e2e rotated`); the successor case passes no `--title` and asserts the derived name.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.25.0`.
- Already committed on this branch by the orchestrator: `docs/design.md` §38, §39 and this plan.

**Interfaces (verbatim, the contract the checks read):**

- `list` row: `w<W>/t<T> | <tty> | <tab title> | <session name>` then ` | self` when the tty is the caller's, then ` | hidden` as today. `<session name>` is the `--name` argument of the host process on that tty, or `(host default)` when it carries none.
- The process table is read through one function, `session_name_on(tty)`, which runs `ps -t <tty> -o command=` and returns the argument after `--name` of the host process, or `None`. When `ORCHESTRATOR_PS_TABLE` names a file, that file replaces `ps`: one line per process, `<tty> <command>`. The suite sets it; a live run never does.
- `move` refusal, exit 1, stderr: `move: refused: <tty> is neither this session's tab nor in its chain (pass --force to move it anyway)`. `--force` moves it and prints `move: forced: <tty> is not in this session's chain` on stderr. A chain entry or self moves as today.
- Title shape: `^[A-Z][^:]* : \S` (a capital, anything without a colon, a spaced colon, something). Refusal, exit 1: `spawn: refused: a title reads "<Role> : <what>", got '<title>' (pass --title-free for a tab named otherwise)`. With `--title-free`, any title is accepted, and no title means `agent` as before. Without `--title-free` and without `--title`, `--successor` derives (below), anything else is refused with the same sentence and `got ''`.
- Successor name: `--successor` without `--title` takes `session_name_on(<caller tty>)`; when that is `None`: `spawn: refused: --successor without --title needs the caller's session name, and this session was launched without one; pass --title "Orchestrator : <feature>"`.
- Orchestrator title on a plain anchor: a title starting with `Orchestrator :` with `--right-of` or `--left-of` (self or a tty): `spawn: refused: an orchestrator's title is a successor's; spawn it with --successor, which places it and hands it the chain`.
- Dry run: `spawn` prints `title_free=yes` when the escape is on, and `name=<the name passed>` on its own line.
- `rotate`: unchanged; the tab skill's line reads `rotate --dir <workdir> --old-tty <tty> [--trust] [--tier <tier>] …`.

- [ ] **Step 1: Write the failing dry-run checks**

In `tests/run-tests.sh`, immediately after the check `no title: the session is still named` (which becomes `no title: refused unless --title-free`, reading the refusal), add checks for: the shaped title accepted (`Implementer : x`, launch carries `--name 'Implementer : x'`); `Probe : anchor` accepted; `foo` refused with the shape sentence; `agent` refused; `--title-free --title foo` accepted with `title_free=yes`; `--successor` with `ORCHESTRATOR_PS_TABLE` holding `/dev/ttys900 /opt/x/host --name Orchestrator : f --permission-mode auto` launches with `--name 'Orchestrator : f'`; `--successor` with a table holding the caller's tty and no `--name` refused with the sentence; `--title 'Orchestrator : f' --right-of self` refused with the successor sentence; `move --tty /dev/ttys901 --left-of self` in the dry run with a chain file naming ttys901 accepted, with a chain file not naming it refused with the sentence, and with `--force` accepted with the stderr line; `session_name_on` through a python import returning the name from a table line and `None` from a line without `--name`; the row shape from a pure `row_for(w, t, tty, title, name, is_self, hidden)` function (add it, `list_rows` calls it): `w1/t2 | /dev/ttys900 | ✳ T | Implementer : x | self` and `… | (host default) | hidden`.

- [ ] **Step 2: Run the suite and watch the new checks fail for the right reason** — report the count and the first failing check's actual value verbatim.

- [ ] **Step 3: Implement, in this order** — `session_name_on` and the table override; `row_for` and `list_rows`; the title shape and `--title-free`; the successor derivation; the orchestrator-title refusal; `move`'s chain guard and `--force`. Keep the module's style: `die()` for refusals, docstrings that say why.

- [ ] **Step 4: The documents** — `skills/iterm-agents/SKILL.md` quick reference and caveats; `commands/succeed.md` spawn line without `--title`; the suite's existing literal checks on those two files (around lines 108-116, 155) are updated where a literal moved, never deleted.

- [ ] **Step 5: The end-to-end script** — titles reshaped, the successor case without a title reading the derived name from the listing's name column. Do not run it: the orchestrator runs the live round.

- [ ] **Step 6: The gate** — `./tests/run-tests.sh` (expected `258 + N passed, 0 failed`, N the checks added, stated in the report), the brand grep, the accent grep. Then `0.25.0` in the three places, and one more suite run.

- [ ] **Step 7: Commits** — `feat(iterm-agents): mark the caller's tab, name every session, move only what is the caller's`; `feat(iterm-agents): shape every title and derive a successor's name`; `test(e2e): title the probes in the house shape`; `chore(release): 0.25.0`. Each body says why.

### Task 2: The global excludes travel (0.25.1)

**Files:**
- Modify: `skills/orchestrator/scripts/workspace.sh` — `cmd_create`, a step 2b between the repository's exclude file and the manifest.
- Modify: `tests/run-tests.sh` — the workspace fixture checks.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.25.1`.
- Already committed: `docs/design.md` §40.

**Interfaces:** `create` reads `git -C <source> config --get core.excludesFile`; when unset, `$XDG_CONFIG_HOME/git/ignore` then `~/.config/git/ignore` when present. The files it lists (`git -C <source> ls-files --others --ignored --exclude-from=<that file>`, minus paths under `.claude/`) are copied with `copy_tree` and the file's patterns are appended to the checkout's `.git/info/exclude` under a comment line `# workspace.sh: the operator's global excludes`. stderr: `copied <n> files kept out by the global excludes` (`0` when the file is absent or empty). The suite's case sets `GIT_CONFIG_GLOBAL` to a file of its own naming a global excludes file of its own, never the operator's.

- [ ] **Step 1: The failing checks** — on the workspace fixture: a file ignored only by the case's global excludes is present in the checkout and `git status --porcelain` there is empty; a file ignored by nothing is absent; with no global excludes configured, the stderr line reads `0` and everything of §35 still holds (the existing checks).
- [ ] **Step 2: Run, watch them fail, report.**
- [ ] **Step 3: Implement** step 2b in `cmd_create`, in the script's style (`say`, `die`, `copy_tree`).
- [ ] **Step 4: The gate, then `0.25.1`, then the suite again.**
- [ ] **Step 5: Commits** — `feat(workspace): copy what the operator's global excludes keep out of the source`; `chore(release): 0.25.1`.

### Task 3: Four readings, in the documents (0.25.2)

**Files:**
- Modify: `skills/orchestrator/SKILL.md` — lifecycle step 4 (the stand-down refusal), the review-rounds paragraph (the gauge path sentence).
- Modify: `templates/agent-review-brief.md` — the forbidden list (`no git configuration write of any kind`), the environment line (`carry every sandbox path inside each tool call`).
- Modify: `templates/agent-phase-brief.md`, `templates/agent-review-brief.md`, `templates/agent-comments-brief.md`, `templates/agent-rotation-brief.md` — the gauge line says `{{GAUGE}}` is the plugin's installed copy, never a checkout of this repository.
- Modify: `skills/iterm-agents/SKILL.md` — the caveat on the first title (« Chat ») if Task 1 did not add it.
- Modify: `tests/run-tests.sh` — one literal guard per item.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.25.2`.
- Already committed: `docs/design.md` §41.

**Interfaces:** the literals the guards read — `a stand-down acknowledgment that reports anything uncommitted is an unfinished delivery` (rulebook); `no git configuration write of any kind` and `carry every sandbox path inside each tool call` (review template); `the plugin's installed copy` (each template's gauge line); `before the session names itself` (tab skill).

- [ ] **Step 1: The failing guards**, one `grep -c` per literal per file.
- [ ] **Step 2: Run, watch them fail, report.**
- [ ] **Step 3: The sentences**, in each document's voice, no other line touched.
- [ ] **Step 4: The gate, then `0.25.2`, then the suite again.**
- [ ] **Step 5: Commits** — `docs(orchestrator): refuse a stand-down over uncommitted work, name the installed gauge, keep readers out of git configuration`; `chore(release): 0.25.2`.
