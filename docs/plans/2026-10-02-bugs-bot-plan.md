# bugs-bot Implementation Plan

> **For agentic workers:** each phase below is dispatched to ONE implementer agent, in its own
> worktree of `/Users/izno/dev/claude-bugs-bot`, delivering ONE draft PR stacked on the previous
> phase's branch head. Inside a phase, work test-first (superpowers:test-driven-development):
> failing test, seen failing, minimal code, green, commit. Steps use checkbox (`- [ ]`) syntax.

**Goal:** turn the TorrentMate-only skill `~/.claude/skills/tm-bugs` into the generic Claude Code
plugin `bugs-bot` (one bot, one Telegram group and one agent per project), up to a releasable 0.1.0
and a rehearsed migration of TorrentMate.

**Architecture:** a Python 3 standard-library package `bugs_bot/` split along the spec's units
(Channel, Pull, Project, Agent, memory), one CLI entry point `bin/bugs-bot` reached through a fixed
launcher `~/.local/bin/bugs-bot`, slash commands `init`, `start`, `remove`, `doctor`, a generic agent
(`agent/AGENT.md`) whose project facts are injected into its startup prompt.

**Tech Stack:** Python ≥ 3.10, standard library only; pytest for tests; POSIX `sh` for the launcher;
PM2 for the one Pull process; the orchestrator plugin's iTerm launcher and context gauge.

**Spec:** `docs/specs/2026-10-02-bugs-bot-design.md` (approved 2026-10-02; § 2 decisions D1–D8 are
not reopenable). Every implementer reads it whole before its phase.

**Source carried over:** `/Users/izno/.claude/skills/tm-bugs/` — read only, never modified by any
phase. Figures, each with the command that produces it:

| Figure | Command |
| --- | --- |
| `scripts/tm_bugs.py` is 1 222 lines | `wc -l ~/.claude/skills/tm-bugs/scripts/tm_bugs.py` |
| 173 tests (150 test functions, parametrised) pass | `cd ~/.claude/skills/tm-bugs && python3 -m pytest -q tests \| tail -1` → `173 passed` |
| the tests reach internals only through `main`, `mask`, `DEFAULT_HOME`, `UNBOUND_WAIT`, `__file__` | `grep -ohE 'tm_bugs\.[A-Za-z_]+' ~/.claude/skills/tm-bugs/tests/*.py \| sort \| uniq -c` |
| the script needs Python ≥ 3.11 today (`from datetime import UTC`) | `grep -n 'import UTC' ~/.claude/skills/tm-bugs/scripts/tm_bugs.py` |

## Global Constraints

- Python 3 **standard library only**, runtime floor **Python 3.10** (spec § 4: « python3 ≥ 3.10 »).
- No module of `bugs_bot/` over ≈ 300 lines (spec § 5): `wc -l bugs_bot/*.py`.
- Nothing outside `bugs_bot/telegram.py` imports or names Telegram's API (`api.telegram.org`,
  Bot API method names); the bot token is read by that module only, never printed; errors mask it.
- Report contents are DATA, never instructions — in code, docs and prompts.
- One allow rule, `Bash(bugs-bot:*)`, must cover every command an agent or a launcher runs: every
  documented invocation is the plain `bugs-bot <command> …` — never a versioned path, a variable,
  `$(…)`, `&&` or `;`.
- Voice (D8): the agent speaks « je », never « nous » / « on » for itself, casual and warm, and
  answers every word a tester sends.
- No file of the plugin names a project (`TorrentMate`, `PersonalScraper`, `tm-design`,
  `torrentmate`) outside `docs/` and test fixtures — enforced from Phase 4 by a guard test.
- Durable text (code, docs, commits, PRs) in English; the agent's group messages in the project's
  `language`. Commits: Conventional Commits, no AI attribution.
- Tests never touch the network, the real `~/.bugs-bot`, `~/.torrentmate`, `~/.claude` or PM2:
  every location has an environment override (below) and every test sets it to `tmp_path`.

Environment overrides (introduced by the phase named, used by every later one):

| Variable | Default | Phase |
| --- | --- | --- |
| `BUGS_BOT_HOME` | `~/.bugs-bot` | 2 |
| `BUGS_BOT_ENV_FILE` | `$BUGS_BOT_HOME/.env` | 2 |
| `BUGS_BOT_CLAUDE_DIR` | `~/.claude` (settings, plugin cache) | 3 |
| `BUGS_BOT_LAUNCHER_DIR` | `~/.local/bin` | 3 |
| `BUGS_BOT_GAUGE` | newest `<claude dir>/plugins/cache/lounisbou/orchestrator/*/skills/context-gauge/scripts/context-gauge.sh` | 4 |
| `BUGS_BOT_API_ROOT` | `https://api.telegram.org` | 5 |

## Review Focus

The five inputs the spec implies and no carried-over test exercises, most likely to bite first —
each pinned by a test in the phase that owns the code:

1. **The offset is machine-wide but reports are per project**: one `getUpdates` batch mixing two
   registered groups and an unregistered one must land each message in its own project's inbox, the
   unregistered one in `unregistered.json`, and the offset advance past all of them — Phase 2.
2. **A media group or a failed download in one project never blocks another**: a failed image
   download keeps the offset (today's rule) — so it re-delivers the whole batch; reports already
   written for the other project must not be duplicated on the retry — Phase 2.
3. **`init` while Pull runs**: a `getUpdates` from `init` would cut Pull's held request (Telegram
   answers 409 to one of two concurrent pollers); `init` must read `unregistered.json` and never call
   `getUpdates` when a Pull process is running — Phase 3.
4. **The launcher on a fresh install or a half-removed version**: no version directory, or one
   without `bin/bugs-bot`, must print one line and exit non-zero, never run an older broken version
   silently — Phase 3.
5. **`handover read` by a successor that crashed half-way**: read twice prints nothing new and
   never loses the note; a `handover write` while an unread note exists refuses rather than
   overwrites — Phase 4.

---

## Phase plan

| # | Kind | Branch (stacked on) | Delivers |
| --- | --- | --- | --- |
| 1 | conversion | `feat/p1-package` (`main`) | plugin skeleton; `tm_bugs.py` split into `bugs_bot/` modules + `bin/bugs-bot`; the 173 tests carried over, green, behaviour unchanged |
| 2 | behaviour | `feat/p2-projects` (p1) | project file, registry, data under `~/.bugs-bot/<project>/`, machine offset, Pull routes by chat id, `--project`; `bind` removed |
| 3 | behaviour | `feat/p3-init-doctor` (p2) | `init`, `remove`, `doctor`, the fixed launcher; `/bugs-bot:init`, `/bugs-bot:remove`, `/bugs-bot:doctor` |
| 4 | behaviour | `feat/p4-agent` (p3) | generic `AGENT.md` + `SKILL.md`, startup-prompt injection, `/bugs-bot:start`, `handover write\|read`, `gate --measure`, `deployed`, follow-ups after `follow_up_hours` (spec § 3.6), the project-name guard |
| 5 | behaviour | `feat/p5-ops` (p4) | `pm2.config.js` (`bugs-bot-pull`), the migration script and its rehearsal test, the E2E script, README, CHANGELOG |
| 6 | verification | `feat/p6-verify` (p5) | spec conformity section by section, E2E run, fixes of what it finds only |
| 7 | conversion | `feat/p7-inbound` (`main`) | the Channel reads normalised messages (`poll` → `Batch`); the factory `channel_for`; Pull, init, people and the CLI free of Telegram's shape and helpers; tests through a fake `Channel` |
| 8 | behaviour | `feat/p8-language-cap` (p7) | per-person `language` (recorded by Pull, `person-lang`, shown by `person`), `fixed --note` records the ref and posts nothing (no developer reference in the group), the agent writes in the person's language; `delete` of the bot's own messages and edit/delete on the agent's own judgment; `handover write` capped at 40 lines / 8 000 characters; one question at a time per person (spec § 3.5): `reply --awaits` refused while the person awaits another answer, the question queued, `wait` prints `ask <id>` |
| 9 | behaviour | `feat/p9-slack` (p8) | `channel` in the project file, registry keyed `<channel>:<chat_id>`, `SlackChannel` (polling, threads, files, mentions, 429), Pull reads both channels, `init --channel slack`, `doctor`'s Slack check, migration script and docs updated |
| 10 | behaviour | `feat/p10-lock` (p9) | every update of a `report.json` or a person card is a locked read-modify-write (spec § 3.2, « One update at a time »): `store.update_report`, `people.update_card`, one per-project lock |
| 11 | behaviour | `feat/p11-images` (p10) | screenshots to reporters (spec § 3.8): `Channel.send_images` (Telegram, Slack), `reply`/`post --image`, sent images recorded on the reply, the « capture » protocol in `AGENT.md` |
| 12 | behaviour | `feat/p12-edits` (p11) | edited messages update their report (spec § 3.2, « Edited messages »): Telegram `edited_message`, Slack `message_changed`, `edits` kept, `wait` prints `edited <id>` |
| 13 | verification | `feat/p13-verify` (p12) | the conformity document updated for the amended sections, E2E with a fake Slack API beside the fake Bot API, fixes of what it finds only |

Phases 7–13 follow the operator's rulings of 2026-10-02 (spec header « Amended »). Phases 1–6 are
merged on `main`; Phase 7 branches from `main`. The project ships by **auto-merge** (operator,
2026-10-02): each PR, once reviewed and its correction round verified, is squash-merged by the
orchestrator.

Worktrees: `git -C /Users/izno/dev/claude-bugs-bot worktree add /Users/izno/dev/claude-bugs-bot-wt/p<N> -b <branch> <base>`
(made by the orchestrator; `workspace.sh create` is not used — brief). One writer per worktree.

---

### Phase 1 — Package and split (conversion)

**Proof of the phase: nothing observable changed.** Same commands, same arguments, same outputs,
same files written, same Telegram payloads; the 173 carried-over tests pass with their assertions
untouched.

**Files:**
- Create: `.claude-plugin/plugin.json` (`name` `bugs-bot`, `version` `0.0.0`, author Lounis Bou
  `lounis.bou@gmail.com`, `homepage`/`repository` `https://github.com/LounisBou/claude-bugs-bot`,
  `license` `MIT`; shape of `/Users/izno/dev/claude-orchestrator/.claude-plugin/plugin.json`),
  `LICENSE` (MIT, Lounis Bou, 2026), `.gitignore` (`__pycache__/`, `.pytest_cache/`).
- Create: `bin/bugs-bot` (executable, `#!/usr/bin/env python3`, puts the repository root on
  `sys.path`, `sys.exit(cli.main())`).
- Create: `bugs_bot/__init__.py`, `errors.py`, `channel.py`, `telegram.py`, `store.py`,
  `reports.py`, `people.py`, `pull.py`, `agent.py`, `gate.py`, `cli.py`.
- Copy verbatim (they are rewritten in Phase 4/5, not here): `AGENT.md` → `agent/AGENT.md`,
  `SKILL.md` → `skills/bugs-bot/SKILL.md`, `pm2.config.js` → `pm2.config.js` (only its `script`
  line changes, to `__dirname + '/bin/bugs-bot'`).
- Create: `tests/` — the nine files of `~/.claude/skills/tm-bugs/tests/` copied, then the
  mechanical edits below only; `pytest.ini` (`testpaths = tests`).

**Module map** (source line ranges in `tm_bugs.py`, `grep -nE '^(def |class )'`):

| Module | Takes |
| --- | --- |
| `errors.py` | `BugsError` |
| `channel.py` | `Transport` type, `Channel` protocol (below) |
| `telegram.py` | `API_ROOT`, `HTTP_TIMEOUT`, `mask`, `http_transport`, `read_token`, `Api`, `TelegramChannel`, `utf16_len`, the mention entity builder |
| `store.py` | `DEFAULT_HOME`, `Store`, `write_json`, status sets, `load_report` |
| `pull.py` | poll/backoff/purge constants, `largest_photo`, `attachments`, `has_content`, `author_of`, `group_messages`, `build_report`, `purge_old_done`, `set_reaction`, `retry_pending_reactions`, `cmd_pull`, `pull_loop`, `watch_loop`, `chats_seen`, `cmd_bind` |
| `reports.py` | `one_line`, `cmd_list`, `cmd_show`, `bound_chat`, `send_reply`, `cmd_reply`, `cmd_edit`, `move_to`, `say_reaction_pending`, `cmd_taken`, `cmd_fixed`, `cmd_done`, `cmd_post`, `cmd_backfill_authors` |
| `people.py` | `person_ref`, `load_person`, `cmd_person`, `cmd_person_note` |
| `agent.py` | `KINDS`, `WAIT_*`, `AGENT_MD` (now `<repo>/agent/AGENT.md`), shape regexes, `cmd_triage`, `untriaged`, `cmd_wait`, `cmd_pending`, `cmd_agent_prompt` |
| `gate.py` | gate constants, `_gate_setting`, `cmd_gate` |
| `cli.py` | `_int_arg`, `build_parser`, `main` (same signature) |

**Interfaces — Produces** (consumed by every later phase):

```python
# bugs_bot/channel.py
Transport = Callable[..., tuple[int, bytes]]   # (url, payload: dict | None, timeout: float | None = None)

class Mention(TypedDict):
    user_id: int | None
    username: str | None
    name: str

class Channel(Protocol):
    def get_updates(self, offset: int | None, timeout: int, allowed_updates: list[str] | None = None) -> list[dict]: ...
    def send(self, chat_id: int, text: str, reply_to: int | None = None, mention: Mention | None = None) -> dict: ...
    # returns {"message_id": int, "text": str}: the text as posted (mention prefix included)
    def edit(self, chat_id: int, message_id: int, text: str, mention: Mention | None = None) -> dict: ...
    def react(self, chat_id: int, message_id: int, emoji: str) -> None: ...
    def get_file(self, file_id: str) -> bytes: ...
    def list_admins(self, chat_id: int) -> list[dict]: ...
    def member_count(self, chat_id: int) -> int: ...   # backfill-authors proves « every member is an admin »
    @property
    def secret(self) -> str | None: ...   # for masking only

# bugs_bot/telegram.py
class TelegramChannel:            # implements Channel over Api(token, transport)
    def __init__(self, token: str, transport: Transport) -> None: ...

# bugs_bot/cli.py — unchanged signature
def main(argv: list[str] | None = None, *, transport: Transport | None = None,
         env: Mapping[str, str] | None = None, now: float | None = None,
         sleep: Callable[[float], None] | None = None, clock: Callable[[], float] | None = None) -> int: ...
```

Every `cmd_*` that touched `Api` now takes a `Channel`. `api.call("<method>", …)` appears only in
`telegram.py`: `grep -n 'call("' bugs_bot/*.py` lists `telegram.py` lines only. A `getUpdates`
held open keeps today's read timeout (`timeout + POLL_READ_MARGIN`).

**Test carry-over — the only edits allowed** (the diff of `tests/` against the source shows these
and nothing else: `diff -r ~/.claude/skills/tm-bugs/tests tests`):

- `conftest.py`: `sys.path` points at the repository root; `import tm_bugs` → `from bugs_bot import cli`;
  `tm_bugs.main(` → `cli.main(`; a `REPO_ROOT` constant for the paths below.
- `tm_bugs.mask` → `telegram.mask`; `tm_bugs.UNBOUND_WAIT` → `pull.UNBOUND_WAIT`;
  `tm_bugs.DEFAULT_HOME` → `store.DEFAULT_HOME`; `Path(tm_bugs.__file__).resolve().parent.parent / "AGENT.md"`
  → `REPO_ROOT / "agent" / "AGENT.md"`; `… / "pm2.config.js"` → `REPO_ROOT / "pm2.config.js"`.
- Python 3.10: `from datetime import UTC` → `timezone.utc` wherever it appears (code and tests).

**Steps:**
- [ ] Copy the tests, apply the edits above, run `python3 -m pytest -q` → fails on `ModuleNotFoundError: bugs_bot`.
- [ ] Skeleton files (plugin.json, LICENSE, .gitignore, pytest.ini, verbatim copies) — commit `chore: plugin skeleton`.
- [ ] Move code module by module (errors → channel/telegram → store → pull → reports → people → agent → gate → cli), suite run after each; one commit per module group, `refactor(<module>): …`.
- [ ] Introduce `Channel`/`TelegramChannel`; `cmd_*` take a `Channel` — commit `refactor(channel): …`.
- [ ] `bin/bugs-bot` — run `./bin/bugs-bot --help` (prog name and command list identical to `python3 ~/.claude/skills/tm-bugs/scripts/tm_bugs.py --help` but for `prog`) — commit.
- [ ] Final: `python3 -m pytest -q | tail -1` → `173 passed` on Python 3.12 AND on a 3.10 interpreter if one is installed (`ls ~/.pyenv/versions`; none → say so in the PR); `wc -l bugs_bot/*.py` (each ≤ 300).

**Test matrix:** the 173 carried-over tests; no new test (a conversion adds none). `grep -rn 'api.telegram.org\|getUpdates\|sendMessage' bugs_bot | grep -v telegram.py` → empty.

**Definition of done:** draft PR `refactor: split tm-bugs into the bugs_bot package` on `main`;
`173 passed`; `diff -r` of tests shows only the listed edits; every module ≤ 300 lines; no
behaviour change claimed or made.

**Review focus:** a « harmless » change slipped into the move (an error message, an argument
default, a payload key); `Channel` leaking Telegram names (`message_id` is fine, `sendMessage` is
not); masking still applied on every error path (`main`'s two `except` branches).

---

### Phase 2 — Projects, registry, routing (behaviour)

**Proof: the behaviour changed and tests drive it.** One machine-wide Pull serves N projects.

**Files:**
- Create: `bugs_bot/project.py`, `bugs_bot/registry.py`, `tests/test_project.py`, `tests/test_registry.py`, `tests/test_routing.py`.
- Modify: `store.py` (homes), `telegram.py` (`read_token`), `pull.py` (routing, unregistered log, machine offset; `cmd_bind` deleted, `chats_seen` kept), `cli.py` (`--project` on every per-project command; error prefix `bugs-bot:`; `prog` `bugs-bot`), `agent.py`/`gate.py`/`reports.py`/`people.py` (take a per-project `Store`), `tests/conftest.py` and the carried-over tests (fixtures register a project instead of binding).

**Data layout** (spec § 3.3):

```
$BUGS_BOT_HOME/                      default ~/.bugs-bot
  .env                               TELEGRAM_BOT_TOKEN (BUGS_BOT_ENV_FILE overrides)
  state.json                         {"offset": int | null}            machine-wide, Pull only
  projects.json                      {"<chat_id>": {"project": str, "repo": "/abs/path"}}
  unregistered.json                  {"<chat_id>": {"title": str, "type": str, "last_seen": iso}}
  <project>/inbox/<report-id>/       as today
  <project>/people/                  as today
  <project>/state.json               {"posts": [...]} (and, from Phase 4, "agent", "handovers")
  <project>/agent.json               as today until Phase 4
```

**Interfaces — Produces:**

```python
# bugs_bot/project.py
PROJECT_FILE = ".bugs-bot.json"
PROJECT_ID = re.compile(r"[a-z0-9-]+")
DEFAULT_GATE_TOKENS = 300_000

@dataclass(frozen=True)
class Project:
    project: str
    chat_id: int
    title: str
    agent_title: str
    repo: Path                       # the directory holding PROJECT_FILE
    deploy_url: str | None = None
    deploy_check: str | None = None
    docs: tuple[str, ...] = ()
    language: str = "fr"
    gate_tokens: int = DEFAULT_GATE_TOKENS
    follow_up_hours: float = 24        # spec § 3.6; > 0, BugsError otherwise

def find_project_file(start: Path) -> Path | None          # start, then each parent
def load_project(path: Path) -> Project                     # BugsError naming the bad key
def dump_project(project: Project) -> dict                  # the JSON shape of spec § 3.3 (no "repo")
def resolve_project(name: str | None, cwd: Path, registry: "Registry") -> Project
    # name given → registry.by_project(name) → load_project(repo / PROJECT_FILE)
    # name None → find_project_file(cwd); none → BugsError("no .bugs-bot.json here or above: run /bugs-bot:init")

# bugs_bot/registry.py
@dataclass(frozen=True)
class Entry:
    project: str
    repo: Path

class Registry:
    def __init__(self, path: Path) -> None
    def entries(self) -> dict[int, Entry]                    # {} when the file is absent; BugsError if unparseable
    def project_for(self, chat_id: int) -> Entry | None
    def by_project(self, project: str) -> tuple[int, Entry] | None
    def add(self, chat_id: int, project: str, repo: Path) -> None
        # idempotent; the same project under a new chat id replaces its old entry;
        # a chat id held by ANOTHER project → BugsError
    def remove(self, project: str) -> bool                  # True when an entry was removed

# bugs_bot/store.py
DEFAULT_HOME = Path.home() / ".bugs-bot"
def bugs_home(env: Mapping[str, str]) -> Path              # BUGS_BOT_HOME or DEFAULT_HOME
class Machine:                                              # the machine-wide files above
    def __init__(self, home: Path) -> None
    registry: Registry
    def load_offset(self) -> int | None
    def save_offset(self, offset: int | None) -> None
    def note_unregistered(self, chat: dict, now: float) -> None
    def unregistered(self) -> dict[int, dict]
    def project_store(self, project: str) -> Store          # Store(home / project)

# bugs_bot/pull.py
def cmd_pull(channel: Channel | None, machine: Machine, now: float, poll_timeout: int = 0, purge: bool = True) -> None
```

**Behaviour:**
- Pull reads the registry every round; an empty registry still polls (spec § 3.2: an unregistered
  chat is dropped AND logged, which is how `init` finds the first group while Pull runs) — every chat
  goes to `unregistered.json`, the offset advances. (Amended after review: an earlier text kept
  today's `UNBOUND_WAIT` sleep, which left the first project undiscoverable while Pull ran.)
- Each message of a registered chat → that project's inbox (media groups, 👀, pending reactions
  retried per project, 30-day purge per project — unchanged).
- A message of an unregistered group chat → `note_unregistered` + one stderr line
  `bugs-bot: unregistered chat <id> '<title>' dropped`; never written to an inbox.
- The offset advances past every update of the batch, machine-wide; a failed download keeps it
  (today's rule), and the re-delivered batch writes no duplicate report (report id = date + message id
  already exists → skipped).
- Every per-project command takes `--project <p>`, else the project of the current directory.

**Test matrix (new):** project file valid/invalid shapes (bad id, missing chat_id, gate_tokens ≤ 0);
`find_project_file` from a nested directory; `resolve_project` by name and by cwd, and its refusal;
registry add idempotent / replace / conflicting chat id / remove / unparseable file; routing:
one batch with project A, project B and an unregistered group → two inboxes, one `unregistered.json`
entry, one stderr line, offset past all; the Review Focus 2 retry (failed download in B, batch
re-delivered, A not duplicated); `--project` overrides cwd. Carried-over tests: fixtures register
the `GROUP_ID` group as project `demo` instead of binding; `bind` tests deleted (their discovery
cases move to Phase 3); assertion changes limited to paths, the `bugs-bot:` prefix and `bind`.

**Definition of done:** draft PR stacked on p1; `python3 -m pytest -q` green; the PR body lists
every carried-over test whose assertion changed and why (`git diff feat/p1-package -- tests/`);
`grep -rn 'torrentmate\|tm-bugs\|TM_BUGS' bugs_bot bin` → empty.

**Review focus:** the offset/duplicate logic of the retry; a path built from a report id or a
project id escaping `BUGS_BOT_HOME` (both validated by regex before any join); `Store` still per
project everywhere (no command reaching another project's inbox).

---

### Phase 3 — init, remove, doctor, the fixed launcher (behaviour)

**Files:**
- Create: `bugs_bot/init.py`, `bugs_bot/doctor.py`, `commands/init.md`, `commands/remove.md`,
  `commands/doctor.md`, `tests/test_init.py`, `tests/test_doctor.py`, `tests/test_launcher.py`.
- Modify: `cli.py` (three commands), `pull.py` (nothing but imports, if any).

**CLI:**

```
bugs-bot init --project <id> [--chat-id N --title T] [--agent-title T] [--deploy-url U]
              [--deploy-check CMD] [--docs P ...] [--language L] [--gate-tokens N] [--repo DIR]
bugs-bot remove [--project <p>]
bugs-bot doctor [--install-launcher]
```

**Interfaces — Produces:**

```python
# bugs_bot/init.py
def git_exclude_path(repo: Path) -> Path                    # `git -C repo rev-parse --git-path info/exclude`, absolute
def add_exclude(repo: Path) -> bool                         # appends "/.bugs-bot.json" once; True when added
def discover_groups(channel: Channel | None, machine: Machine, pull_running: bool) -> dict[int, dict]
    # pull_running → machine.unregistered() only, NO getUpdates;
    # else getUpdates WITHOUT offset (consumes nothing) through chats_seen(), merged with unregistered()
def cmd_init(channel: Channel | None, machine: Machine, repo: Path, args: InitArgs, pull_running: bool) -> int
def cmd_remove(machine: Machine, project: str) -> None      # by registry name, the project file need not load; prints the data dir and project file kept

# bugs_bot/doctor.py
@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str                                              # never the token
def pull_processes(ps_output: str) -> list[int]             # pids whose command runs `bugs-bot` … `pull --watch`
def run_checks(env: Mapping[str, str], ps_output: str) -> list[Check]
def install_launcher(target_dir: Path) -> Path              # writes target_dir / "bugs-bot", mode 0755
LAUNCHER_TEXT: str
```

**init rules:** `repo` = `--repo` or `git rev-parse --show-toplevel` of cwd; first run needs
`--project`, `--agent-title` and a group (`--chat-id` with `--title`, or exactly one discovered
group — zero or several: list them and exit 1, never guess); a re-run keeps every value not given
on the command line, updates the file and the registry entry, never duplicates either; the
`.git/info/exclude` line is added once; the project's `.gitignore` is never touched; prints the
written file and the registry line.

**Launcher** (`LAUNCHER_TEXT`, the spec's « 3-line launcher », plus its refusal line):

```sh
#!/bin/sh
d=$(ls -d "${BUGS_BOT_CLAUDE_DIR:-$HOME/.claude}"/plugins/cache/lounisbou/bugs-bot/*/bin/bugs-bot 2>/dev/null | sort -V | tail -1)
[ -n "$d" ] || { echo "bugs-bot: no installed version found — run /bugs-bot:doctor" >&2; exit 127; }
exec python3 "$d" "$@"
```

**doctor checks** (each a `Check`, exit 0 only when all pass): Python ≥ 3.10; the token readable
(« present », never its value); registry parseable; exactly one Pull process; the orchestrator
plugin installed (`<claude dir>/plugins/cache/lounisbou/orchestrator/*/`); the launcher installed
and identical to `LAUNCHER_TEXT`; the allow rule `Bash(bugs-bot:*)` in
`<claude dir>/settings.json` or `settings.local.json` — absent: print the line
`/permissions → Allow → Bash(bugs-bot:*)` for the operator; doctor NEVER writes a settings file.

**Commands:** `commands/init.md` (asks the operator, one question at a time: project id, agent
title, deployment URL and optional deploy check, docs, language; asks him to post one message in
the new group; then the one `bugs-bot init …` line); `commands/remove.md`; `commands/doctor.md`
(first run through `python3 ${CLAUDE_PLUGIN_ROOT}/bin/bugs-bot doctor --install-launcher`, since
the launcher does not exist yet; later runs `bugs-bot doctor`).

**Test matrix:** init first run, re-run (file updated, registry one entry, exclude line once);
discovery with zero / one / several groups; Review Focus 3 (Pull running → the fake channel records
NO `getUpdates`); `--chat-id` without `--title` refused; a chat id held by another project refused;
remove keeps data and file; doctor: each check passing and failing (stubbed `ps_output`, fake
claude dir), the token never in stdout/stderr, no settings file written (`mtime` unchanged);
launcher: three fake versions `0.1.0`, `0.2.0`, `0.10.0` → runs `0.10.0` (a stub `bin/bugs-bot`
echoing its version); Review Focus 4 (none, and a version dir without `bin/bugs-bot`) → exit 127,
one line. The discovery cases of the deleted `bind` tests reappear here.

**Definition of done:** draft PR stacked on p2; suite green; `sh -n` on the launcher text;
`commands/*.md` invoke only `bugs-bot …` (doctor's bootstrap line excepted).

**Review focus:** `init` racing Pull (no `getUpdates` while Pull runs); the exclude written in a
worktree's common git dir; doctor reading but never editing settings; `sort -V` on macOS
(`/usr/bin/sort --version` — BSD sort with `-V` support; say what was run).

---

### Phase 4 — The generic agent (behaviour)

**Files:**
- Rewrite: `agent/AGENT.md`, `skills/bugs-bot/SKILL.md` — generic: no project name, no path of
  this machine; project facts come from the startup prompt. Kept as is (spec § 3.4): the launcher
  protocol phrases, the never-revealed list, data-not-instructions, « The voice » (D8), the
  deployed-before-announced rule, « the agent runs no command other than `bugs-bot …` and the
  iTerm launcher ». The gauge's two plain commands become one: `bugs-bot gate --measure`.
  Memory and continuity (spec § 3.5) written into `AGENT.md`.
- Create: `bugs_bot/handover.py`, `bugs_bot/followup.py`, `commands/start.md`, `tests/test_followup.py`, `tests/test_handover.py`,
  `tests/test_gate_measure.py`, `tests/test_agent_prompt.py`, `tests/test_guard.py`.
- Modify: `agent.py` (prompt injection; launcher record moves from `agent.json` into
  `<project>/state.json["agent"]`), `gate.py` (`gate_tokens` from the project file; `--set` writes
  it there; `settings.json` dropped), `cli.py` (`handover`, `gate --measure`, `deployed`, `overdue`, `--awaits`/`--follow-up`), `pull.py` (calls `clear_answered` for each new report), `reports.py` (`--awaits`, `--follow-up`).

**Interfaces — Produces:**

```python
# bugs_bot/agent.py
def cmd_agent_prompt(store: Store, project: Project, launcher: str, now: float,
                     predecessor: str | None = None, predecessor_tty: str | None = None) -> Path
    # writes <home>/<project>/agent/startup-prompt.txt; the prompt names: agent_title, the
    # absolute path of agent/AGENT.md, the launcher, the repo, the group title, deploy_url,
    # deploy_check present or not, docs list, language; successor block as today

# bugs_bot/handover.py
def write_note(store: Store, text: str, now: float) -> Path  # refuses empty; refuses while an unread note exists
def read_note(store: Store, now: float) -> str | None        # prints once, archives to handover/<YYYYMMDD-HHMMSS>.md,
                                                             # appends to state.json["handovers"]; None when no note

# bugs_bot/gate.py
def locate_gauge(env: Mapping[str, str]) -> Path             # BUGS_BOT_GAUGE, else newest by version; BugsError when none
def measure(env: Mapping[str, str], run: Callable[[list[str]], str]) -> tuple[int, int]   # (tokens, window)
def cmd_gate(project: Project, set_to: int | None, window: int | None, tokens: int | None,
             measure_now: bool, env: Mapping[str, str]) -> None
    # prints gate_tokens=; with tokens or --measure also context_tokens=, context_window=, handover=yes|no

# CLI
bugs-bot handover write "<text>" | handover read
bugs-bot gate [--set N] [--window W --tokens N] [--measure]
bugs-bot deployed <commit>      # runs deploy_check with BUGS_BOT_COMMIT=<commit> in the repo:
                                # exit 0 → "deployed=yes"; non-zero → "deployed=no", exit 1;
                                # no deploy_check → "deployed=unknown: the launcher's word decides", exit 2
```


**Follow-ups (spec § 3.6, operator's order 2026-10-02).** `Project.follow_up_hours` exists from
Phase 2 (parsed and validated there); Phase 4 builds the behaviour:

```python
# bugs_bot/followup.py
def mark_awaiting(report_dir: Path, report: dict, reply_index: int, now: float) -> None
    # report["awaiting"] = {"since": iso(now), "reply": reply_index}; cleared by clear_answered
def clear_answered(store: Store, author_id: int | None, author: str, since: float) -> list[str]
    # called by Pull for every new report: clears "awaiting" on that person's reports whose
    # "since" precedes the new message; returns the cleared ids
def due(store: Store, hours: float, now: float) -> list[str]
    # report ids whose "awaiting" is older than hours and not yet reminded
def mark_reminded(report_dir: Path, report: dict, now: float) -> None
    # report["awaiting"]["reminded"] = iso(now): one reminder per awaited message

# CLI
bugs-bot reply <id> "<text>" [--mention] [--awaits | --follow-up]   # exclusive; --follow-up needs a due awaiting
bugs-bot edit  <id> "<text>" [--reply N] [--mention] [--awaits]
bugs-bot overdue                                                    # one line per due follow-up
bugs-bot wait                                                       # now also prints "follow-up <id>" when one falls due
```

`AGENT.md`: « demander », « vérifier », the in-doubt question and any message of the agent's own that
asks the person something are posted with `--awaits`; a greeting, a thank-you, « de rien » never.
On `follow-up <id>`: `person <id>`, `show <id>`, then ONE reminder `reply <id> "<text>" --mention
--follow-up`, in « The voice » (light, warm, never a reproach, never the first message repeated).
ONE reminder only (operator, « ok va pour une seule »): still unanswered `follow_up_hours` after it,
`wait` prints `unanswered <id>` (once: `awaiting["escalated"]` recorded by `bugs-bot escalated <id>`)
and the agent tells its launcher in one line; it never reminds again. `pending` shows due follow-ups
and unanswered ones at restart.

`/bugs-bot:start` (`commands/start.md`): refuses without `.bugs-bot.json` (points to
`/bugs-bot:init`); `ListAgents` — a live row named `agent_title` → refuse (« you already have
one » / « it belongs to <launcher> », from `state.json["agent"]`); `bugs-bot agent-prompt
--launcher "<name [ref]>"`; spawn through the newest orchestrator `iterm-agent.sh`
(`spawn --dir <repo> --title "<agent_title>" --prompt-file <path> --right-of self`), `list`,
`move` if needed, `verify`, `ListAgents` — today's five steps, made generic; no orchestrator
plugin → say so and stop.

**Guard test** (`tests/test_guard.py`): walks every tracked file (`git ls-files`) outside `docs/`
and `tests/fixtures/`; fails on `TorrentMate`, `PersonalScraper`, `tm-design`, `torrentmate`
(case-insensitive), naming the file and line. Seen failing first on a planted line.

**Test matrix:** prompt carries each project field and no other project's; launcher/predecessor
shape refusals (carried over); handover write/read/read-again/unread-refusal (Review Focus 5),
archive name and `state.json` entry; `gate --measure` with a stub gauge script printing
`context_tokens=310000` / `context_window=1000000` → `handover=yes`, and a failing gauge → exit 1;
`gate --set` writes the project file; small window rule (80 %) carried over; `deployed` three
outcomes; follow-ups: `--awaits` records, a later message of the same person clears (and of
another person does not), `due` at `follow_up_hours` − 1 s / + 1 s, one reminder only (`--follow-up` twice
refused), `wait` wakes on a due follow-up, `unanswered` once after a further `follow_up_hours` and never again, `follow_up_hours` from the project file (non-default
value); guard test.

**Definition of done:** draft PR stacked on p3; suite green including the guard; `grep -n
'python3 \|\$(' agent/AGENT.md skills/bugs-bot/SKILL.md commands/*.md` shows no invocation other
than `bugs-bot …` and the iTerm launcher path read by `ls -d … | sort -V | tail -1`.

**Review focus:** a voice or protocol rule lost in the rewrite (diff the two `AGENT.md` side by
side, rule by rule); injection of project-file values into the prompt (a docs entry or title with
newlines or quotes must not break or extend the prompt — validated or quoted); `deploy_check`
runs in the repo, never through a shell built from report text.

---

### Phase 5 — Operations: PM2, migration, E2E, docs (behaviour)

**Files:**
- Modify: `pm2.config.js` — `name: 'bugs-bot-pull'`, `script: __dirname + '/bin/bugs-bot'`,
  `args: 'pull --watch'`, `interpreter: process.env.BUGS_BOT_PYTHON || 'python3'`, today's
  `autorestart`, `restart_delay`, `kill_timeout`, no `cron_restart`, comments kept.
- Modify: `telegram.py` (`API_ROOT` from `BUGS_BOT_API_ROOT`, for the E2E only).
- Create: `docs/migration/tm_bugs_to_bugs_bot.py` — spec § 6 step 3 as a script:
  `--legacy-home DIR --bugs-home DIR --project ID --repo DIR --env-file FILE [--copy]` — moves
  (or with `--copy` copies) `inbox/` and `people/` to `<bugs-home>/<project>/`, the offset from the
  legacy `state.json` to `<bugs-home>/state.json` EXACTLY, the token line to `<bugs-home>/.env`
  (mode 0600, value never printed), `posts` to the project's `state.json`; refuses when the target
  project directory is non-empty. Lives under `docs/` (it names the legacy layout).
- Create: `docs/migration/RUNBOOK.md` — spec § 6 steps 1–6 as commands, the rehearsal first.
- Create: `tests/test_migration.py` (a fixture legacy tree → migrated tree; offset identical;
  token absent from output; second run refused), `tests/e2e.sh` (a local fake Bot API on
  `http.server`, `BUGS_BOT_API_ROOT` pointed at it, `bin/bugs-bot` driven through `init`, `pull`,
  `list`, `reply --mention`, `taken`, `fixed`, `handover write/read`, two projects; kills its server;
  prints `E2E OK`).
- Create: `README.md` (house shape of `/Users/izno/dev/claude-orchestrator/README.md`: what it is,
  install, the allow rule, commands, setup by the operator — BotFather privacy, group admin —,
  tests), `CHANGELOG.md` (`## 0.1.0 — unreleased`).

**Test matrix:** migration test; PM2 config test (carried-over pm2 tests updated to the new name);
`tests/e2e.sh` run.

**Definition of done:** draft PR stacked on p4; `python3 -m pytest -q` green; `sh tests/e2e.sh`
→ `E2E OK` and `ps -eo pid,command | grep -c '[h]ttp.server'` → `0` after it.

**Review focus:** the offset copied exactly (no `+1`, no `null` turned into `0`); the token file's
mode; the E2E server killed on failure paths too (`trap`).

---

### Phase 6 — Final verification

**Files:** only fixes of what this phase finds, each with a test; `docs/verification/2026-10-02-conformity.md`.

**Steps:**
- [ ] Spec conformity: for each section § 1–§ 9 and each success criterion 1–6, the file/test that
  meets it, or the gap — written in `docs/verification/…`.
- [ ] `python3 -m pytest -q`, `sh tests/e2e.sh`, the guard, `wc -l bugs_bot/*.py`.
- [ ] Migration rehearsal on a COPY: `cp -R ~/.torrentmate/tm-bugs <tmp>/legacy` then the script
  with `--copy` into a temp `--bugs-home`, a test registry; compare offset, report count
  (`ls <tmp>/legacy/inbox | wc -l` vs the migrated inbox), people count. Nothing under the real
  `~/.bugs-bot`; the temp tree deleted after (`ls` proves it).
- [ ] Gaps that are defects: fixed here with a test. Gaps that are scope: listed for the operator.

**Definition of done:** draft PR stacked on p5 with the conformity document; every check above run
and its output quoted in the PR.

---

### Phase 7 — Normalised inbound messages behind the Channel (conversion)

**Proof of the phase: nothing observable changed.** Same commands, outputs, files written
(`report.json` byte for byte, `state.json`, `unregistered.json`, `projects.json`), same Telegram
payloads. Existing tests keep their assertions; tests that drove Pull, init or `backfill-authors`
through the HTTP transport may stay — new tests drive them through a fake `Channel`.

**Files:**
- Modify: `bugs_bot/channel.py` (the types below, `mask`), `bugs_bot/telegram.py` (parsers become
  private; `poll`; may split into `telegram.py` + `telegram_inbound.py` to stay ≤ 300 lines),
  `bugs_bot/pull.py`, `bugs_bot/init.py`, `bugs_bot/people.py`, `bugs_bot/reports.py`,
  `bugs_bot/doctor.py`, `bugs_bot/cli.py`.
- Create: `bugs_bot/channels.py` (the factory), `tests/fake_channel.py` (a `FakeChannel`
  recording every call), `tests/test_inbound.py`.

**Interfaces — Produces:**

```python
# bugs_bot/channel.py
ChatId = int | str
MessageId = int | str

@dataclass(frozen=True)
class Author:
    id: int | str | None
    username: str | None
    name: str                 # what author_of gives today: username, else first name
    language: str | None      # platform code as given (Telegram language_code); None when absent
    is_bot: bool

@dataclass(frozen=True)
class Attachment:
    file_id: str
    ext: str                  # ".jpg", ".png" … as attachments() gives today

@dataclass(frozen=True)
class InboundMessage:
    chat_id: ChatId
    message_id: MessageId
    date: float               # epoch seconds
    author: Author
    text: str                 # text, else caption, else ""
    attachments: tuple[Attachment, ...]
    group_key: str | None     # Telegram media_group_id; None when alone
    thread_of: MessageId | None = None   # Slack thread parent (Phase 9); None for Telegram

@dataclass(frozen=True)
class Batch:
    messages: list[InboundMessage]       # content only: no service message, no bot post
    chats: dict[ChatId, dict]            # every chat seen: {"id", "title", "type"} as chats_seen gives today
    migrations: dict[ChatId, ChatId]     # old -> new chat id (Telegram supergroup promotion)
    cursor: dict                         # opaque, channel-owned; saved by the caller only

class Channel(Protocol):
    kind: str                                                    # "telegram"
    def poll(self, cursor: dict | None, chats: list[ChatId], timeout: int) -> Batch: ...
    def send(self, chat_id: ChatId, text: str, reply_to: MessageId | None = None, mention: Mention | None = None) -> dict: ...
    def edit(self, chat_id: ChatId, message_id: MessageId, text: str, mention: Mention | None = None) -> dict: ...
    def react(self, chat_id: ChatId, message_id: MessageId, emoji: str) -> None: ...
    def get_file(self, file_id: str) -> bytes: ...
    def list_admins(self, chat_id: ChatId) -> list[Author]: ...   # was list[dict] of raw ChatMember
    def member_count(self, chat_id: ChatId) -> int: ...
    @property
    def secret(self) -> str | None: ...

def mask(text: str, secret: str | None) -> str: ...   # moved from telegram.py, same behaviour

# bugs_bot/channels.py — the one module naming the implementations
def channel_for(kind: str, env: Mapping[str, str], transport: Transport) -> Channel: ...
    # reads that kind's token and API root itself; BugsError on an unknown kind or a missing token
def token_problem(kind: str, env: Mapping[str, str]) -> str | None: ...   # for doctor: the reason the token cannot be read (env file, variable), never the token; None when fine
```

`Mention.user_id` widens to `int | str | None`. `get_updates` leaves the protocol (it stays a
`TelegramChannel` method used by `poll`). Telegram's cursor is `{"offset": int | None}`, stored as
today's `offset` key of `~/.bugs-bot/state.json` (`Machine.load_cursor(kind) -> dict | None`,
`Machine.save_cursor(kind, cursor)`; Telegram maps to `offset`, the file unchanged).
`init.discover_groups` reads `Batch.chats` from `poll(cursor, [], 0)` and never saves the cursor.
The second guard's allowed residue: the contract's own names (`Author.is_bot`, the comment naming
`media_group_id`) and the stored report key `"media_group_id"` written by `pull.py` (the file is
unchanged) — no Telegram wire field read outside the Telegram modules.

**Steps:**
- [ ] `tests/fake_channel.py` + `tests/test_inbound.py`: `TelegramChannel.poll` on recorded updates
  (photo, image document, media group, bot post, service message, migration) gives the expected
  `Batch` — failing, then green. Commit.
- [ ] A golden test: one recorded `getUpdates` batch through `cmd_pull` before the change writes
  `report.json`, `state.json`, `unregistered.json`; the same files after — committed FIRST, green
  on the old code, kept green throughout.
- [ ] Move: `pull.py` (`build_report`, `cmd_pull`, `follow_migrations`, `clear_answered` call) to
  `InboundMessage`/`Batch`; `chats_seen` → `TelegramChannel`; `init.py`; `people.py`
  (`cmd_backfill_authors`); `reports.py`/`doctor.py` imports; `cli.py` and `pull.py`'s loops build
  through `channel_for("telegram", env, transport)`. One `refactor(<module>): …` commit each, suite
  green after each.
- [ ] Pull, init and backfill tests through `FakeChannel` (no transport): routing of two projects
  and an unregistered chat, a failed download keeping the cursor, init while Pull runs.

**Test matrix:** all existing tests unchanged in their assertions; the golden test; `test_inbound.py`;
the fake-Channel tests above. Guard: `grep -rn 'from bugs_bot.telegram\|import telegram' bugs_bot | grep -v 'channels.py'` → empty;
`grep -rnE "update_id|migrate_to_chat_id|media_group_id|is_bot|\[.from.\]" bugs_bot | grep -v 'telegram'` → empty.

**Definition of done:** PR `refactor: normalised inbound messages behind the channel` on `main`;
suite green on 3.12 and 3.10; golden files identical; each module ≤ 300 lines.

**Review focus:** a stored field that changed type or key (an `int` id becoming a `str`, `author`
computed differently); a cursor saved by `init`; masking lost when `mask` moved; the factory
reading the token anywhere else.

---

### Phase 8 — Per-person language and the handover cap (behaviour)

**Files:** `bugs_bot/people.py`, `bugs_bot/pull.py`, `bugs_bot/reports.py`, `bugs_bot/handover.py`,
`bugs_bot/parser.py`, `bugs_bot/cli.py`, `agent/AGENT.md`, `skills/bugs-bot/SKILL.md`; tests
`tests/test_language.py`, `tests/test_handover.py`.

**Interfaces — Produces:**

```python
# bugs_bot/people.py
def record_language(store: Store, author: Author) -> None: ...
    # sets the card's "language" from author.language (first two letters, lower case) when the card has none; never overwrites
def cmd_person_lang(store: Store, ref: str, code: str) -> None: ...   # sets it (the agent's correction); code [a-z]{2}
def language_of(store: Store, project_language: str, author_id: int | str | None, author: str) -> str: ...
    # the card's language, else project_language

# bugs_bot/reports.py
def cmd_fixed(channel: Channel, store: Store, chat_id: ChatId, report_id: str, note: str | None, now: float) -> int: ...
    # status fixed, 👌, report["fix_ref"] = note when given; NOTHING posted in the group
def cmd_delete(channel: Channel, store: Store, chat_id: ChatId, report_id: str, now: float, number: int | None = None) -> None: ...
    # deletes the bot's last reply on the report, or the number-th as `show` numbers them; the reply kept,
    # marked {"deleted": iso}; awaiting lifted when it pointed at that reply; BugsError on a reply already deleted

# bugs_bot/channel.py — Channel gains
    def delete(self, chat_id: ChatId, message_id: MessageId) -> None: ...   # Telegram deleteMessage (Slack: chat.delete, Phase 9)

# bugs_bot/handover.py
NOTE_MAX_LINES = 40
NOTE_MAX_CHARS = 8000
def write_note(store: Store, text: str, now: float) -> Path: ...
    # BugsError "handover note too long: <n> lines, <m> characters (limit 40 lines, 8000 characters)"; nothing written
```

CLI: `bugs-bot person-lang <report-id|author-id> <code>`; `person` prints `language: <code>` (or
`language: unknown`). `cmd_fixed` records `fix_ref` and posts nothing (spec § 3.5, no developer
reference in the group); `show` prints the ref for the agent. Pull calls `record_language` for each kept message's author.

`AGENT.md`: every message to a person is written in their language (`person <id>` shows it); when a
person writes in another language than their card says, `person-lang` first. The project's
`language` is the default only. « corrigé <id> <ref> »: `fixed <id> --note "<ref>"`, then the agent
tells the person in its own sentence that it is fixed — never a PR number, commit, branch or ticket
id in the group; it asks them to check (« vérifier ») once deployed. `edit` and `delete` of its own
messages on its own judgment (a wrong fact, a duplicate, the wrong report), not only on « réécrire »;
never a tester's message. CLI: `bugs-bot delete <id> [--reply N]`. The handover note: refused when too long → shorten, write again.

**One question at a time** (spec § 3.5): the card gains `questions: [{"report": id, "text": str, "queued": iso}]`.
`reply <id> "<text>" --awaits` to an author who already has an `awaiting` on ANOTHER open report:
nothing posted, the question appended to their queue, exit 0 with the line `queued <id>: <author>
already awaits <other id>`. When `clear_answered` lifts their wait, the oldest queued question
surfaces: `wait` prints `ask <report-id>` and the agent posts it (`reply … --awaits`), in the voice,
from the current state of that subject. `follow-up`/`unanswered` keep their meaning; a reminder is
the question in flight, not a new one. `AGENT.md`: one question per message, one subject per
person at a time; the other subjects worked on in parallel without asking.

**Test matrix:** one question at a time — a second `--awaits` to the same person on another report
queued, not posted; a non-awaiting reply to them still posted; their answer → `wait` prints `ask`;
two people never block each other; a queued question on a report closed meanwhile dropped. Then:
language recorded on first sight, never overwritten (Pull twice, then a
`person-lang`, then Pull again); `person` shows it; `fixed --note "#680"` posts nothing (the fake
Channel records no `send`) and stores `fix_ref`; `delete` removes the N-th reply through the Channel, keeps it marked deleted,
lifts its awaiting, refuses a second delete; `show` marks it deleted; the AGENT.md rule « no PR number, commit or ticket
id in the group » pinned; the note at 40 lines / 8 000 characters accepted, 41 lines or 8 001 characters
refused with nothing written and the previous unread note untouched; the AGENT.md rules pinned as
text.

**Definition of done:** PR `feat: per-person language, one question at a time, no developer reference in the group, capped handover note` on p7.

**Review focus:** a card's language overwritten by Pull; the prefix chosen from the project instead
of the person; a refused note leaving a partial file.

---

### Phase 9 — Slack (behaviour)

**Files:** create `bugs_bot/slack.py` (≤ 300 lines; split if needed), `tests/test_slack.py`,
`tests/http_server_fake_slack_api.py`; modify `bugs_bot/channels.py`, `bugs_bot/project.py`,
`bugs_bot/registry.py`, `bugs_bot/store.py`, `bugs_bot/pull.py`, `bugs_bot/init.py`,
`bugs_bot/doctor.py`, `bugs_bot/parser.py`, `commands/init.md`, `docs/migration/tm_bugs_to_bugs_bot.py`
(registry key), `README.md`, `CHANGELOG.md`.

**Interfaces — Produces:**

```python
# bugs_bot/channel.py
Transport = Callable[..., tuple[int, bytes]]   # (url, payload, timeout=None, headers: dict | None = None)

# bugs_bot/slack.py
class SlackChannel:              # implements Channel; kind = "slack"
    def __init__(self, token: str, transport: Transport, root: str = "https://slack.com/api") -> None: ...
    # poll: conversations.history per chat since cursor[chat]["ts"], then conversations.replies of the
    #   threads listed in cursor[chat]["threads"] (the open reports' message ts); messages oldest first
    # cursor = {"<chat>": {"ts": str, "threads": {"<parent ts>": "<last reply ts>"}}}
    # react: 👀 -> "eyes", 👌 -> "ok_hand", ✅ -> "white_check_mark", unknown -> BugsError
    # send: chat.postMessage, thread_ts = reply_to; mention "<@U…> " prefix; returns {"message_id": ts, "text": …}
    # get_file: url_private with "Authorization: Bearer <token>"
    # HTTP 429: BugsError carrying Retry-After; the watch loop sleeps that long

# bugs_bot/registry.py — keys "<channel>:<chat_id>"
class Registry:
    def entries(self) -> dict[tuple[str, ChatId], Entry]: ...
    def add(self, channel: str, chat_id: ChatId, project: str, repo: Path) -> None: ...
    def project_for(self, channel: str, chat_id: ChatId) -> Entry | None: ...

# bugs_bot/project.py
Project.channel: str   # "telegram" (default) | "slack"
```

Pull: one round = Telegram `poll` (held 50 s, 10 s while a Slack project is registered) then
Slack `poll` of every Slack project; each cursor saved after its batch is on disk. Unregistered
Slack channels are not logged (init lists them itself). `init --channel slack`: lists
`users.conversations` (channels the bot is in) and takes `--chat <id>` or asks. `doctor`: for each
channel kind with a registered project, the token present and `auth.test` (Slack) / `getMe`
(Telegram) answering. Environment override `BUGS_BOT_SLACK_API_ROOT` (https or loopback, as
`BUGS_BOT_API_ROOT`).

**Test matrix:** every `Channel` method of `SlackChannel` against a fake transport (payloads,
headers, thread_ts, mention, reaction names); poll: new top-level message → report, file → image,
bot post skipped, thread reply → answer to the waiting report (clears `awaiting`), cursor advanced
only by the caller; 429 → wait then retry; registry: a Telegram and a Slack project side by side,
same chat id string never confused; a project file without `channel` reads as Telegram; migration
script writes `telegram:<id>` keys; `init --channel slack` idempotent; the guard: Slack's URL and
method names only in `slack.py`.

**Definition of done:** PR `feat: Slack channel` on p8; suite green; `sh tests/e2e.sh` green.

**Review focus:** a Slack `ts` compared as a float (precision loss); a thread reply turned into a new
report; the token in a log line or an exception; Telegram's hold left at 50 s with Slack registered.

---

### Phase 10 — One update at a time (behaviour)

**Files:** modify `bugs_bot/store.py`, `bugs_bot/people.py`, and every module that loads, changes and
saves a `report.json` or a card (`pull.py`, `reports.py`, `followup.py`, `questions.py`, `agent.py`,
`reactions.py` — `grep -rn "write_json(\|save_person(" bugs_bot` lists them); create `tests/test_lock.py`.

**Interfaces — Produces:**

```python
# bugs_bot/store.py
@contextmanager
def locked(store: Store) -> Iterator[None]: ...      # fcntl.flock(LOCK_EX) on <store root>/.lock; re-entrant within a process
def update_report(store: Store, report_id: str, change: Callable[[dict], T]) -> T: ...
    # under `locked`: load report.json, call change(report) (mutates it), write_json atomically, return change's result
    # raises BugsError (« no report <id> ») when it is gone — purged meanwhile

# bugs_bot/people.py
def update_card(store: Store, key: str, change: Callable[[dict], T], name: str, author_id: int | str | None) -> T: ...
    # same, on the person's card (created as card_of creates it)
```

Every read-modify-write of a report or a card goes through them; a plain `load_report` stays for
reads. A channel call (send, react, delete) is made OUTSIDE the lock — the lock is never held over
the network — and its result written in a second, locked update that re-reads the file (so a send
followed by a crash leaves the message posted and unrecorded, as today, never a stale overwrite).
Pull's new report is written to a temporary directory and renamed into `inbox/` (already the case:
keep it). The lock file is per project, never the machine's `state.json`.

**Test matrix:** two writers interleaved by hand (a `change` that, mid-call, runs a second update in a
thread blocked on the lock): both changes present after; Pull's reaction marking vs the agent's
`done` on the same report: status `done` and the reply kept (the 2026-10-02 defect, rebuilt in a
test that FAILS on p9's head); a card: `record_language` vs `queue_question` both kept; a report
purged meanwhile → BugsError, nothing written; no channel call made while the lock is held (a fake
channel asserting the lock is free); the guard: no `write_json(` on a `report.json` or card path
outside `update_report`/`update_card` (grep test).

**Definition of done:** PR `fix: one update at a time on reports and person cards` on p9; suite green on
3.12 and 3.10; `sh tests/e2e.sh` green.

**Review focus:** a lock held across a network call; a path still doing load→change→save by hand; a
deadlock (re-entrance, a nested update on another file under the same lock); the lock file inside a
report directory (purged with it).

---

### Phase 11 — Screenshots to reporters (behaviour)

**Files:** modify `bugs_bot/channel.py` (protocol), `bugs_bot/telegram.py`, `bugs_bot/slack.py`,
`bugs_bot/reports.py` (`cmd_reply`, `cmd_post`), `bugs_bot/parser.py`, `agent/AGENT.md`,
`skills/bugs-bot/SKILL.md`, `README.md`, `CHANGELOG.md`; create `bugs_bot/images.py` (checks and the
record copy), `tests/test_images.py`. Modules ≤ 300 lines.

**Interfaces — Produces:**

```python
# bugs_bot/channel.py — Channel gains
def send_images(self, chat_id: ChatId, text: str, paths: list[Path], reply_to: MessageId | None = None,
                mention: Author | None = None) -> list[dict]: ...
    # one dict per message posted ({"message_id", "text"}), in order; the first carries the text when the
    # platform allows a caption of that length, else a text message is posted first, then the images

# bugs_bot/images.py
MAX_IMAGES = 10
MAX_BYTES = 10 * 1024 * 1024
def check_images(paths: list[str]) -> list[Path]: ...   # exists, PNG/JPEG/WebP by magic bytes, size; BugsError before any send
def record_sent(report_dir: Path, reply_number: int, paths: list[Path]) -> list[str]: ...  # copies to sent/<n>-<k>.<ext>, returns names
```

Telegram: `sendPhoto` (one image, multipart, caption ≤ 1024 characters) or `sendMediaGroup`
(2–10, caption on the first); `reply_to` → `reply_parameters`. Slack: `files.getUploadURLExternal`
per file, the upload POST, then one `files.completeUploadExternal` with `channel_id`, `thread_ts`,
`initial_comment` (mention prefixed as `send` does). The transport gains multipart bodies where
needed (standard library only). CLI: `reply <id> "<text>" --image <path>` (repeatable) and
`post "<text>" --image <path>`; the reply record carries `images: [<names>]`; `show` lists them;
`--awaits`, `--mention`, `--follow-up` and the one-question queue unchanged (a queued question with
images is refused: ask first, show after — said in AGENT.md). AGENT.md: the « capture » line to the
launcher, the look-before-sending rule and its never-revealed list for pixels (spec § 3.8), and when
a screenshot helps (a manipulation to explain, a fix or a proposed fix to show).

**Test matrix:** each channel against its fake transport: one image, several, caption too long,
thread/reply_to, mention; `check_images` refusals (missing, not an image by magic bytes, > 10 MB,
> 10 files) with nothing sent; the record copy and `show`; Telegram multipart body parsed back in the
test; Slack's three calls in order with the token header and no token in an error; the E2E sends one
image through the fake Bot API.

**Definition of done:** PR `feat: screenshots to reporters` on p10; suite green on 3.12 and 3.10;
`sh tests/e2e.sh` green.

**Review focus:** an image sent before every check passed; a partial send recorded as whole (the
second upload fails); multipart boundaries and filenames with spaces; the agent's instructions
leaving room to post a screenshot it has not looked at.

---

### Phase 12 — Edited messages (behaviour)

**Files:** modify `bugs_bot/channel.py` (the normalised message gains `edited: bool`), `bugs_bot/telegram.py`
(`edited_message` in `allowed_updates` and normalised), `bugs_bot/slack.py` (`message_changed` subtype:
the inner `message`, `edited` true), `bugs_bot/pull.py` (an edited message routed to its report),
`bugs_bot/agent.py` (`wait` prints `edited <id>`), `bugs_bot/reports.py` (`show` prints the edits and marks
them seen), `agent/AGENT.md`, `CHANGELOG.md`; create `tests/test_edits.py`. Modules ≤ 300 lines.

**Interfaces — Produces:**

```python
# bugs_bot/channel.py — InboundMessage gains
edited: bool = False      # True when this is a new version of a message already sent

# bugs_bot/store.py
def find_by_message(store: Store, chat_id: ChatId, message_id: MessageId) -> str | None: ...
    # the id of the report recording that message (first message, media-group member, or answer), else None

# report.json gains
"edits": [{"date": iso, "message_id": id, "previous": str, "seen": bool}]
```

Pull: an edited message whose report is found → under the Phase 10 lock, the recorded text (report
`text`, or the answer's `text`) replaced, the previous one appended to `edits` with `seen: false`; not
found → ignored, logged at debug level only. `wait` prints `edited <report-id>` while an edit is
unseen; `show` prints the edits (« modifié : <previous> → <current> ») and marks them seen. AGENT.md:
on `edited <id>`, `show <id>` and treat the new text as what the person says now; never comment on the
edit to the person.

**Test matrix:** Telegram `edited_message` on a report's message → text replaced, `edits` kept, `wait`
prints `edited`, `show` silences it; on a media-group member; on a Slack thread answer; an edit of an
unknown message → nothing written, no report created; an edit leaves status, awaiting and
reactions unchanged; `allowed_updates` contains `edited_message`; Slack `message_changed` normalised
with the inner message's ts; the cursor moves past an edit like any message.

**Definition of done:** PR `feat: edited messages update their report` on p11; suite green on 3.12 and
3.10; `sh tests/e2e.sh` green.

**Review focus:** an edit creating a report; Slack's `message_changed` read as a new top-level
message; an edit written without the lock; the previous text lost.

---

### Phase 13 — Verification of the amendment

As Phase 6, on the amended sections (spec header « Amended »), criterion 6 re-judged; `tests/e2e.sh`
extended to one Slack project on a fake Slack API on loopback beside the Telegram ones; the
migration rehearsal re-run on a copy. A live Slack smoke test only if the operator provides a token
and a test channel — otherwise said so in the document (operator, 2026-10-02: no live Slack test
before 0.1.0). The Slack edit path (`message_changed`, never returned by `conversations.history`)
is documented as a known limitation of 0.1.0 in the README, the CHANGELOG and the conformity
document (operator, 2026-10-02: « B »); its code is not removed. PR `docs: conformity of the
amendment` on `main`.

---

## After the build (orchestrator, not implementers)

1. GitHub repository `LounisBou/claude-bugs-bot` (public, MIT) created when Phase 1's PR needs it;
   `main` pushed.
2. Each PR: review session + norms check, one correction round, rebased; then squash-merged by the
   orchestrator (auto-merge, operator 2026-10-02).
3. Marketplace: a PR on `LounisBou/claude-statusbar` adding `bugs-bot` (source github
   `LounisBou/claude-bugs-bot`); « Orch : optim plugin 5 » told.
4. Release 0.1.0: on the operator's word.
5. Migration (spec § 6): proposed to « Orch : TM frontend », run at a quiet point with its agreement
   — rehearsal first, then the RUNBOOK; the allow rule is the operator's `/permissions`; the
   PersonalScraper PR removing the two old allow rules from a worktree of mine.
