# Short Names, No Project Server Unless Asked, Rename On Declare Implementation Plan

> **For the orchestrator:** this plan is executed by implementer SESSIONS the orchestrator spawns (`orchestrator:iterm-agents`), one brief per task — never by subagents of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one release, 0.26.0: every session name reads `Orch : <subject>` or `Agent : <subject>` with the subject at most twenty-five characters, a spawn loads the servers the orchestrator chose for it from the operator's catalogue (Task 2, which supersedes Task 1's all-or-nothing `--mcp`), and the rulebook tells a hand-launched orchestrator how it gets its name.

**Architecture:** `skills/iterm-agents/scripts/iterm_agent.py` (the shape, the derived name, the launch's server flags, `--mcp` on spawn and rotate), every document that spells a role (`skills/orchestrator/SKILL.md`, `skills/iterm-agents/SKILL.md`, `commands/succeed.md`, the five templates, `README.md` where it names one), `tests/e2e.sh` titles, the suite.

**Tech Stack:** Python 3 (standard library), bash 3.2.

**Spec:** `docs/design.md` section 42; sections 24, 38, 39 bind the readings.

## Global Constraints

Copied from `CLAUDE.md`; the task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt.
- **Commits**: Conventional Commits with a scope; no trailer, no attribution, no tool name, no session link. Subject in the imperative, body says why.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (315 on the base head `0c50934`); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`: `0.26.0`.
- **Every command runs synchronously**, in the tool call that waits for it; the suite is piped to `tail` in the same call. The first suite run in a fresh copy takes minutes.
- **The checkout you work in is already on the task's branch**: do not create another branch.
- **`tests/e2e.sh` is edited, never run**: the orchestrator runs the live round.

---

### Task 1: Short names, no project server unless asked, rename on declare (0.26.0)

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — `TITLE_SHAPE`, the refusal sentences, the derived-name guard, `build_command`, `cmd_spawn` (`--mcp`), `cmd_rotate` (forwards `--mcp`).
- Modify: `skills/iterm-agents/SKILL.md`, `commands/succeed.md`, `skills/orchestrator/SKILL.md`, `templates/agent-phase-brief.md`, `templates/agent-review-brief.md`, `templates/agent-comments-brief.md`, `templates/agent-rotation-brief.md`, `templates/orchestrator-succession-brief.md`, `README.md` — every spelling of the older roles.
- Modify: `tests/e2e.sh` — titles; `tests/run-tests.sh` — the checks below and every existing literal that spelled a role.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.26.0`.
- Already committed on this branch by the orchestrator: `docs/design.md` §42 and this plan.

**Interfaces (verbatim, the contract the checks read):**

- `TITLE_SHAPE = ^(Orch|Agent) : .{1,25}$`. Refusal, exit 1: `spawn: refused: a title reads "Orch : <subject>" or "Agent : <subject>", the subject at most 25 characters, got '<title>' (pass --title-free for a tab named otherwise)`.
- Derived successor name: held to `TITLE_SHAPE`; `DERIVED_NAME_MAX` and its sentence are removed. Refusal: `spawn: refused: the caller's session name '<the first 40 characters>' does not read "Orch : <subject>"; pass --title "Orch : <subject>"`.
- The `Orchestrator :` prefix test of §39 (an orchestrator's title on a plain anchor) reads `Orch :`.
- Launch without `--mcp`: `--strict-mcp-config` present, no `--settings` with `enableAllProjectMcpServers`. With `--mcp`: the settings `{"enableAllProjectMcpServers":true}` present, no `--strict-mcp-config`. `rotate` forwards `--mcp` (it is not in its refused list). Dry run prints `mcp=yes|no`.
- Roles in every document: `Orch : <subject>` where `Orchestrator : <feature>` stood, `Agent : <subject>` where `Implementer : <phase>` or `Reviewer : <round>` stood; the sentence that lists the roles says the subject is at most 25 characters. The rulebook's Overview (or its first section) carries the literal `/rename "Orch : <subject>"` in a sentence that says the host gives the model no rename and the operator types it once, or relaunches with `--name`.
- `tests/e2e.sh` titles: `Agent : e2e probe`, `Agent : e2e self`, `Agent : e2e chain 1`, `Agent : e2e chain 2`, `Agent : e2e ghost`, `Agent : e2e 2`, `Agent : e2e rotated`; the successor case unchanged (no title).

- [ ] **Step 1: The failing checks** — shape: `Agent : x` and `Orch : x` accepted and named; `Implementer : x` refused with the shape in the sentence; a subject of 25 characters accepted, of 26 refused; the derived name from a table naming the caller `Orch : f` launches under `--name 'Orch : f'` and `--remote-control 'Orch : f'`, from `Orchestrator : f` refused with the new sentence; `Orch : x --right-of self` refused; the launch without `--mcp` carries `--strict-mcp-config` and no enabling setting, with `--mcp` the reverse; `rotate --mcp` yields `mcp=yes`; one literal guard per document for the roles (`Orch : <subject>` and `Agent : <subject>` present, `Orchestrator : <feature>` / `Implementer : <phase>` / `Reviewer : <round>` absent, outside `docs/`); the rename literal in the rulebook. Every existing check that spelled a role (`--title "Implementer : <phase>"`, `Implementer : x`, `Probe : …`, `Orchestrator : heir`, the derived-name checks, the 100-character check) moves to the new spelling, never deleted — a check retired with the length guard is replaced by the shape check on the derived name.
- [ ] **Step 2: Run, watch them fail, report** the count and the first failing value.
- [ ] **Step 3: The code**, in the module's style. Then the documents, then `tests/e2e.sh`.
- [ ] **Step 4: Mutations on the committed tree**: the shape widened to anything → the shape checks fall; the derived-name shape check dropped → the `Orchestrator : f` check falls; `--strict-mcp-config` dropped from the default launch → its check falls.
- [ ] **Step 5: The gate**, then `0.26.0`, then the suite again.
- [ ] **Step 6: Commits** — `feat(iterm-agents): short names, and no project server unless asked`; `docs(orchestrator): spell the short roles everywhere and name a hand-launched orchestrator`; `chore(release): 0.26.0`.

---

### Task 2: An agent's servers are chosen from the operator's catalogue (0.26.0, redone)

Opened after the operator's ruling of 2026-09-11 (evening) on the measurement recorded in §42: the strict flag drops every server of every scope, and the orchestrator must choose per agent, with a default set. Task 1's `--mcp` flag (all-or-nothing, the enabling setting) is superseded by this task; its documents and checks move with it, never deleted.

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — the catalogue (`MCP_CATALOGUE`, `read_catalogue`), the selection (`select_servers`), the file (`write_mcp_file`), `build_command`, `cmd_spawn` (`--mcp <name>`), `cmd_rotate` (forwards `--mcp`, unchanged).
- Modify: `install.sh` — the empty catalogue beside the tier map; `commands/install.md`, `commands/uninstall.md`, `README.md` — the catalogue named where the tier map is.
- Modify: `skills/iterm-agents/SKILL.md` (the `spawn` and `rotate` references, safety item 4), `skills/orchestrator/SKILL.md` (lifecycle steps 1 and 2), `templates/agent-phase-brief.md` (the servers placeholder on the tier line).
- Modify: `tests/run-tests.sh` — the checks below; the Task 1 checks on `--mcp` move to the new contract.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.26.0` (the release commit is dropped and redone last).
- Untouched: `tests/e2e.sh` (the sandbox has no catalogue: every e2e spawn launches strict with no file, which the round tolerates).

**Interfaces (verbatim, the contract the checks read):**

- Catalogue path: `MCP_CATALOGUE = os.environ.get("ORCHESTRATOR_MCP_CATALOGUE") or os.path.join(STATE_DIR, "mcp.json")`. Shape: `{"servers": {"<name>": <definition as the host's own configuration writes it>}, "default": ["<name>", ...]}`. A file that is not an object with a `servers` object and a `default` list refuses: `spawn: refused: <path> does not read as a server catalogue (a "servers" object and a "default" list)`.
- `install.sh`: creates `<state dir>/mcp.json` holding `{"servers": {}, "default": []}` when absent, says `server catalogue created: <path>`; says `server catalogue already present: <path>` and writes nothing when present; the dry run says `[dry-run] server catalogue created: <path>`.
- `spawn --mcp <name>`: repeatable; a value may hold several names separated by commas; the selected set is the catalogue's `default` plus every named server, in catalogue order, each once; `--mcp none` (alone or among others) selects nothing. Refusals, exit 1, before any file is written and before any tab exists: `spawn: refused: --mcp '<name>' is not in the catalogue <path> (names: <comma-separated names, or none>)`; `spawn: refused: --mcp needs a server catalogue at <path>; the installer creates one`. No catalogue and no `--mcp`: the launch proceeds strict with no file, and stderr carries `spawn: no server catalogue at <path>: the session loads no server`.
- The file: `<state dir>/prompts/mcp-<title slug>-<ms>.json` (the slug and stamp as the prompt file's), content `{"mcpServers": {<the selected definitions>}}`; not written when the set is empty; written after the trust check and before the prompt file (the refusal order of Task 1 D8 holds: a refusal leaves no file).
- The launch: `--strict-mcp-config` always; `--mcp-config <file>` immediately after it when the set is not empty; `--permission-mode` immediately after the pair; `enableAllProjectMcpServers` nowhere. The dry run prints `mcp=<names, comma-separated, in selection order, or none>` and `mcp_file=<path or none>`.
- `rotate` forwards `--mcp` as before. `--successor` follows the same rule as any spawn.
- Documents: the tab skill's `spawn` reference reads `[--mcp <name>]` and says where the catalogue lives and what `none` does; the rulebook's step 1 says the session loads the catalogue's default set, that `--mcp <name>` adds one for the agent that needs it, and that the brief names the servers where it names the tier; step 2 says the launch is strict with the session's own file; `templates/agent-phase-brief.md`'s tier line carries `Your session was spawned with these servers and no other: {{MCP_SERVERS}}`; `commands/install.md` step 2 names the catalogue beside the tier map; `commands/uninstall.md` lists it with the tier map; `README.md` names it where it names the tier map.
- Task 1's sentence « --mcp loads the project's own servers » and the `enableAllProjectMcpServers` literal leave every document outside `docs/`.

- [ ] **Step 1: The failing checks** — with `ORCHESTRATOR_MCP_CATALOGUE` pointed at a file the check writes under `mktemp -d` (servers `a`, `b`, default `[a]`): the launch carries `--strict-mcp-config` and `--mcp-config <file>` and the file holds `a` alone; `--mcp b` → `a` and `b`; `--mcp a,b` and `--mcp a --mcp b` → the same, once each; `--mcp none` → no `--mcp-config`, `mcp=none`, `mcp_file=none`; `--mcp c` refused naming `a, b`; the catalogue absent and `--mcp b` refused naming the installer; absent and no `--mcp` → strict, no file, the stderr line; a catalogue that is a list refused; `--mcp-config <file>` followed by `--permission-mode` in the launch line; `enableAllProjectMcpServers` absent from the launch in every case; `rotate --mcp b` → `mcp=a,b`; `install.sh` in a temporary state directory creates the catalogue with the exact content, leaves a pre-filled one byte-identical, dry run says the line; one literal guard per document (the placeholder in the template, the catalogue in install, uninstall and README, the rulebook's two sentences, the tab skill's reference), and the absence of the Task 1 wording outside `docs/`. Task 1's checks `a launch loads no project server`, `--mcp puts the project's servers back`, `rotate forwards --mcp`, `no prompt: nothing appended after the server flag`, `the phase brief names the server flag beside the tier`, `both documents say the launch loads no project server` move to the new contract, never deleted.
- [ ] **Step 2: Run, watch them fail, report** the count and the first failing value.
- [ ] **Step 3: The code**, in the module's style, then `install.sh`, then the documents.
- [ ] **Step 4: Mutations on the committed tree**: the catalogue lookup skipped (an unknown name accepted) → its check falls; the file not written (the launch names a path that does not exist) → the content checks fall; `--strict-mcp-config` dropped → its check falls; the default list ignored → the `a` alone check falls.
- [ ] **Step 5: The gate**, then `0.26.0`, then the suite again.
- [ ] **Step 6: Commits** — `git reset --hard 300f5e5` first (drops the release); then `feat(iterm-agents): choose an agent's servers from the operator's catalogue`; `docs(orchestrator): the server catalogue, and what a brief says about an agent's servers`; `chore(release): 0.26.0`.

---

### Task 3: The mode a session came up in is read, and the screen is read from the bottom (0.26.0, redone)

Opened on the operator's ruling of 2026-09-11 (evening) after two agents stood on a permission prompt: design §43 carries the measurements. The release commit is dropped and redone last again.

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — `PROJECTS_DIR`, `MODE_TIMEOUT`, `find_transcript(dir_, since)`, `mode_of_transcript(path)`, `mode_refusal(asked, got, model)`, the wait in `cmd_spawn` after the CLI check, `last_lines(lines, n)` used by `cmd_screen`.
- Modify: `skills/model-routing/SKILL.md`, `skills/orchestrator/SKILL.md` (lifecycle step 2), `skills/iterm-agents/SKILL.md` (the `spawn` reference: the mode check; the `screen` line: the last lines; the `rotate` synopsis nit `[--mcp <name>]`).
- Modify: `tests/run-tests.sh` — the checks below.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.26.0` (release redone last).
- Untouched: `tests/e2e.sh`, `docs/`, the catalogue, the installer.

**Interfaces (verbatim, the contract the checks read):**

- `PROJECTS_DIR = os.environ.get("ORCHESTRATOR_PROJECTS_DIR") or os.path.expanduser("~/.claude/projects")`; `MODE_TIMEOUT = int(os.environ.get("ORCHESTRATOR_MODE_TIMEOUT", "20"))`.
- `find_transcript(dir_, since)`: among `<PROJECTS_DIR>/*/*.jsonl` with mtime >= `since`, the newest file whose first entry carrying `cwd` has `cwd == os.path.realpath(dir_)`; `None` when there is none. No directory slug is computed.
- `mode_of_transcript(path)`: the value of the first entry carrying `permissionMode`, else `""`.
- `mode_refusal(asked, got, model)`: `spawn: refused: the session came up in mode '<got>' and not '<asked>' (model <model or 'the host default'>): the host ignores the mode asked for this model; bind the tier to another model, or pass --permission-mode acceptEdits for an agent that only edits`.
- `cmd_spawn`, after the CLI check and only with `--verify` (the default): poll every second up to `MODE_TIMEOUT` for `find_transcript(args.dir, launch_epoch)` with a non-empty mode; a mode equal to `args.mode` prints `spawn: mode <mode> read on the transcript` on stderr; a different one closes the session it made (the tab, by its session id) and dies with `mode_refusal(...)`, exit 1; no mode by the timeout prints `spawn: no transcript for <dir> after <n>s: the session's mode is unread` on stderr and the launch goes through. The dry run reads nothing and prints `mode_check=skipped`.
- `last_lines(lines, n)`: the list with trailing empty strings dropped, then its last `n` items. `cmd_screen` prints `last_lines(<every line of the screen>, args.lines)`.
- Documents: `skills/model-routing/SKILL.md` carries « a session nobody watches runs in the operator's decision mode » and « `--permission-mode acceptEdits` for a few edits and allow-listed commands only »; the rulebook's step 2 carries « reads the session's mode on its transcript »; the tab skill's `spawn` reference says the mode is read and what the refusal offers, its `screen` line says « the last N lines », its `rotate` synopsis reads `[--mcp <name>]`.

- [ ] **Step 1: The failing checks** — with `ORCHESTRATOR_PROJECTS_DIR` pointed at a `mktemp -d` holding fixture transcripts written by the check (one-line JSON entries with `cwd` and `permissionMode`): `mode_of_transcript` reads the first mode; `find_transcript` ignores a fixture with another `cwd`, picks the newest of two with the right one, returns none when the directory is empty (all through `python3 -c` importing the module with `sys.path`); `mode_refusal` renders the sentence for (`auto`, `default`, a model id) and for an empty model; `last_lines` on `["a","b","","c","",""]` with `n=2` gives `["b","c"]`... (write the fixture so the expected value is unambiguous); the dry run prints `mode_check=skipped`; one literal guard per document. Every existing check stays.
- [ ] **Step 2: Run, watch them fail, report** the count and the first failing value.
- [ ] **Step 3: The code**, in the module's style, then the documents.
- [ ] **Step 4: Mutations on the committed tree**: `find_transcript` matching any `cwd` → its check falls; `mode_of_transcript` returning the last mode instead of the first → its check falls (the fixture carries two); `last_lines` reading the first lines → its check falls.
- [ ] **Step 5: The gate**, then `0.26.0`, then the suite again.
- [ ] **Step 6: Commits** — `git reset --hard aa91804` first (drops the release); then `feat(iterm-agents): read the mode a session came up in, and refuse another`; `fix(iterm-agents): the screen is read from the bottom`; `docs(orchestrator): a tier's model runs in the operator's decision mode, or its agent is not unattended`; `chore(release): 0.26.0`.
