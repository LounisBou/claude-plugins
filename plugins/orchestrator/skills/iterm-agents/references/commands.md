# Commands

Read before typing any `iterm-agent.sh` command, and again when one fails, hangs or says on stderr that a fallback served it. SKILL.md carries when to spawn, close, move or rotate and in what order; the conditions that come with an option stay beside it here.

- Quick reference — `list`, `spawn`, `verify`, `screen`, `close`, `move`, `rotate`, `pair`, `trust prune`, `tools`, the dry run
- Agents as windows of a home session — where the launcher puts an agent, what each command does there, `home`, `takeover`
- How the launcher builds a tab — trust, servers, focus, the launch file, the shell, the anchor's window, titles, hidden panes, the environment
- When iTerm2 does not answer — the cause named, the two rungs, what the fallback cannot do

## Quick reference

```bash
SCRIPT=${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh

$SCRIPT list
    # w1/t3 | /dev/ttys000 | ✳ chaining the PRs | Orch: plugin family | self
    # w1/t4 | /dev/ttys004 | ◐ reading the brief | Agent: phase 2
    # w1/t5 | /dev/ttys007 | ◐ Chat | (host default) | hidden   ← behind a maximized sibling pane
    # tab title, then the session's NAME (the host registry's, else its --name; `(host
    # default)` when neither gives one), then `self` on YOUR OWN tab.

$SCRIPT spawn --dir <workdir> (--tier deep|standard|light | --model <name> --effort <low|medium|high|xhigh|max> | --inherit-model) [--permission-mode auto] \
    --title "Agent: <subject>" --brief <brief-path> --orchestrator "<name [ref]>" [--right-of self | --successor] [--mcp <name>] [--gate-tokens <N>] \
    [--keep-tool <name>] [--drop-tool <name>] [--keep-synced-skills]
    # --brief lints the brief (skills/orchestrator/scripts/brief-lint.sh) before any tab
    # exists; a finding no longer refuses the spawn — it is printed on stderr as a warning
    # and the launch goes on. It builds the startup prompt itself either way, exactly
    # "Read and execute <absolute brief path>. Your orchestrator is
    # <name [ref]>." --brief needs --orchestrator and
    # is exclusive with --prompt/--prompt-file, which stay for a spawn that carries no brief
    # (`--prompt "Read and execute <path>. Your orchestrator is <name [ref]>."` hand-built,
    # unlinted).
    # One of --brief, --prompt or --prompt-file is REQUIRED: a launch carrying none of the
    # three is refused before any tab exists (the host writes no transcript before a first
    # prompt, so the session's mode could never be read, §29) — --no-verify does not lift
    # this, a promptless session stays refused whether or not the mode is checked.
    # --title is `Orch: <subject>` for an orchestrator and its successor, `Agent: <subject>`
    # for anything you spawn, the subject at most 25 characters; any other title, or none, is
    # refused unless `--title-free`, under which no title means `agent`.
    # The session's servers are CHOSEN. The launch is strict by default, and carries a file
    # the launcher writes for that session from the operator's catalogue,
    # <state dir>/mcp.json (ORCHESTRATOR_MCP_CATALOGUE overrides the path): named
    # definitions in the host's own shape, and a `default` list every agent gets.
    # --mcp <name> adds a catalogued server for the agent that needs it — repeatable,
    # or comma-separated — and --mcp none gives the session no server at all. A name the
    # catalogue does not hold is refused before a tab exists, naming the ones it holds;
    # with no catalogue at all a plain spawn launches with nothing and says so on stderr.
    # --account-connectors: this ONE spawn also loads every connector of the OPERATOR'S
    # ACCOUNT — not one of them, all of them, the same set a session the operator opens by
    # hand already loads. It drops --strict-mcp-config for this spawn only; the chosen
    # servers above still travel exactly as before, and the project's own "enable these MCP
    # servers?" dialog, which strict otherwise makes moot, is pre-answered so the session
    # never parks on it. Off unless asked — the default launch is byte-for-byte unchanged
    # without it. `rotate` forwards it like any other spawn option.
    # --gate-tokens <N>: THIS session's context gate, a positive integer of tokens; zero,
    # a negative, a fraction or a non-number is refused before a tab exists. The launch then
    # exports ORCHESTRATOR_CONTEXT_GATE_TOKENS=<N> beside ORCHESTRATOR_SPAWNED=1, so the
    # module's context gate and its band, which both read it from their environment, use
    # it. Absent, nothing is exported and the default (300,000 tokens) holds. The gate is the
    # smaller of the option and the window's percentage gate. With --brief, the startup
    # prompt adds « Your context gate is the smaller of <N> tokens and the percentage of the
    # reported window » (a --prompt or --prompt-file spawn gets the export, not that line); a brief
    # that says 300,000 is not rewritten. A successor does not inherit
    # the predecessor's gate: it carries one only if the option is given. `rotate` forwards it.
    # --keep-tool <name> / --drop-tool <name>: the session's tools are CHOSEN too (§65). Every
    # launched session is started with `--disallowedTools` naming the tools no session has
    # called: Artifact, SendFeedback, Workflow, ScheduleWakeup and ReportFindings, and, for any
    # title but `Orch:` and `Coord:`, the three that move an orchestrator between machines
    # (mcp__orchestrator__move_send, move_probe, end_session). --keep-tool removes a name from
    # that set (a brief that asks for a page keeps Artifact); --drop-tool adds any tool name or
    # permission pattern to it. Both repeat, take one name each, and are honoured by every path
    # that builds a launch: a plain spawn, --successor, --wake, --open, --auditor and the
    # other special spawns, and `rotate`, which forwards them. Refused before a tab exists:
    # an empty name, and one name given to both options. A kept name the default never removed
    # is harmless. `tools` lists what exists. The dry run prints `tools_removed=` with the set.
    # The same launch carries the host's cuts in its one --settings: an `Agent:` session
    # loses the away recap and the silent-turn reminder. The host compacts where the operator's settings say; the plugin sets only the gates: agent 240,000, others 300,000.
    # Every launched session loses the
    # token countdown, and the account's synced skills (`anthropic-skills:*`) are hidden
    # for it through `syncClaudeAiSkills: false` in that same --settings, which moves nothing
    # on disk; --keep-synced-skills leaves them in, for a brief that invokes one (§65).
    # The key must NEVER go into a settings file: in the user's settings the host moves
    # ~/.claude/skills/synced to the trash at its next launch, where in --settings it moves nothing.
    # The host's `enableArtifact` switch is never passed: it also drops
    # the « Scratchpad directory » line the agent briefs rely on.
    # An agent comes up with remote control off; only a successor comes up under it (§39).
    # The spawn then reads the mode the session came up in, on its own transcript, and
    # refuses a session that came up in another one — closing the tab it just made and
    # naming both modes, the model, and the two repairs: rebind the tier, or pass
    # --permission-mode acceptEdits for an agent that only edits. A transcript that has
    # not appeared within ORCHESTRATOR_MODE_TIMEOUT (20s) refuses the spawn too, the tab
    # closed the same way, naming the checkout, the timeout, and the remedy: read the tab
    # with `screen` before retrying, or raise ORCHESTRATOR_MODE_TIMEOUT if the machine is
    # only slow. --no-verify skips it, with the CLI check (but not the promptless refusal
    # above, which runs before either check and does not depend on --verify).
    # writes the prompt to a file under the plugin's state directory, writes the launch
    # to a second file, asks the app to run it in a new tab AT AN INDEX, WAITS until the
    # host CLI is running on the new tty (30 s, ORCHESTRATOR_SPAWN_TIMEOUT), and prints
    # the tty on its last line. `--prompt-file <path>` uses a file you already wrote.
    # The host is the process whose pid has a host registry file, or whose program's
    # basename is ORCHESTRATOR_HOST_CLI's or that of what it resolves to; a session that
    # wrote its transcript in --dir since the launch has started too. The chain (an agent
    # appended, a successor handed yours) is written only once the session is verified.
    # Every refusal after the tab exists — never started, mode unread or wrong, no tty —
    # closes that tab, prints its tty on stdout and says on stderr whether the close
    # happened (`the tab on <tty> was NOT closed: close it with close --tty <tty>`), the
    # chain untouched. A caller that is not a tab of the app writes no chain entry.
    # Every launched session carries its model and its effort (decision 3 of
    # docs/agent-dispatches.md). The dry run prints what it types and where it came from:
    # `effort=<level>` (`none` for the host's default) and `pair_source=` — `transcript <path>`,
    # `tier <t>` (`tier deep, effort from transcript <path>` when the effort is yours),
    # `flag`, `record` or `host default`; a real spawn says the same on stderr.
    # --inherit-model types the calling session's current model AND effort, read on its
    # transcript (its last main-thread request); --tier, --model and --effort are exclusive
    # with it. A succession reads them the same way without it.
    # --model <name> --effort <level> types that pair for this one spawn, exclusive with
    # --tier: the pair the orchestrator chose. --model without --effort is refused (an
    # agent's effort is the orchestrator's to name), and so is an agent given neither
    # --tier nor --model.
    # --tier resolves through the operator's map (<state dir>/models.json, or
    # ORCHESTRATOR_TIER_DEEP/_STANDARD/_LIGHT). An unbound tier types no model argument: the
    # host chooses the model. `resolve-tier <tier>` prints the binding: `<model>` or
    # `<model>/<effort>`; a tier may be bound to {"model": "<alias>", "effort": "<level>"}.
    # The effort typed with a tier: --effort, else the map's, else the plugin's shipped one
    # (standard high, light medium), and for deep the calling orchestrator's own live effort.
    # --successor: the new session takes yours — immediately right of you, chain ignored, your chain handed to it (§34).
    #   With no --title it takes YOUR OWN name, read from the process table, so every brief
    #   that cites you still cites it; and it comes up under remote control under that name
    #   (--no-remote-control drops that). A session the older launcher named carries its
    #   prompt in its own process line, so the derivation refuses it and the title is typed
    #   by hand instead, and so is a name under an older convention, which no longer
    #   derives. An `Orch:` title with --right-of/--left-of
    #   is refused: a plain anchor lands after your chain, which is not a successor's place.
    #   A successor runs on your live model and effort, read on your transcript:
    #   --tier, --model and --effort are refused beside --successor, and a pair that cannot
    #   be read refuses the launch, naming the file and what was missing.
    #   From an `Audit: <subject>` session (an auditor kept on past its report, §9.4), or one
    #   whose role word is qualified (`Audit neutre : <subject>`), it takes that name too, comes
    #   up under remote control, keeps your plugin set (the enabledPlugins of your --settings,
    #   with or without a plugin directory) and takes and hands NO chain (chain=none): an
    #   auditor has none, and written into one it would anchor the orchestrator's next agent.
    #   --no-remote-control is refused there too; a typed audit title still is, off --auditor.
    # --wake: a paused orchestrator relaunched on the operator's word, its predecessor already
    #   gone. Needs --title "Orch: <subject>", the one recorded at its pause. Its pair: the one
    #   the transcript of --resume <session> holds, else the recorded --model <id> --effort
    #   <level>, else none (the host's default), never asked of the operator; a recorded model
    #   without its effort is refused. Lands immediately right of you, joins no chain (chain=none) and
    #   comes up under remote control under its name. Refuses --successor, --auditor, an
    #   anchor, --title-free, --tier, --inherit-model, --resident and --no-remote-control.
    # --open: a new orchestrator opened on the operator's order, by the session that carries
    #   it out, never by an agent. `--open` comes right after `spawn`. Needs
    #   --title "Orch: <subject>" without a reference and a prompt (--prompt or --prompt-file).
    #   Its pair is the one the order names, --model <id> --effort <level>, or neither: the
    #   host's default for the session applies. A model alone and an effort alone are refused,
    #   and so are --tier and --inherit-model: a tier or the caller's own live pair would be a
    #   pair nobody ordered. Lands immediately right of you, joins no chain (chain=none) and
    #   comes up under remote control under its name. Refuses every succession flag,
    #   --wake, an anchor (--right-of, --left-of), --title-free, --resident, --brief,
    #   --orchestrator and --no-remote-control.

$SCRIPT verify --tty /dev/ttysNNN [--pid <pid>]
    # succeeds with the pid when the host CLI runs on that tty; exit 1 otherwise. With --pid
    # (an integer; anything else is a usage error) it succeeds only when that very process
    # is one of the host CLIs on the tty, and exit 1 means no host CLI there or only others.

$SCRIPT screen --tty /dev/ttysNNN [--lines 40]
    # the last N lines, trailing blanks dropped: a tall terminal is blank at the top and
    # the prompt an agent is stopped on sits at the bottom.

$SCRIPT close --tty /dev/ttysNNN --expect-title <substring> [--keep-checkout]
    # tty-exact; refuses if the session's current title does not contain the substring;
    # waits for the host CLI to leave the tty, and fails loudly naming what survived.
    # Once the close is proved, the checkout the session worked in is deleted when it is
    # a checkout or a pin under the workspaces root: `workspace.sh delete`, never
    # --discard, its host temporary directory with it. The directory is read BEFORE the
    # close. The outcome is on stderr (`close: deleted checkout <path>` or
    # `close: kept checkout <path>: <reason>`); the stdout line `closed 1 session on <tty>`
    # is unchanged and a refused delete never fails the close. --keep-checkout opts out
    # (the checkout is then deleted by hand, or by the next sweep). `rotate` always keeps it.
    # A host pid the hooks module's store records on the tty and the table still lists after
    # the close is named on stderr, `close: pid <n> lingers (<state>)`, the exit unchanged.

$SCRIPT move --tty /dev/ttysNNN (--right-of self | --right-of /dev/ttysMMM | --left-of /dev/ttysMMM | --leftmost) [--force]
    # places a tab immediately beside another (same window), or at the FIRST place of its
    # window with --leftmost, exclusive with --left-of and --right-of; idempotent, verified
    # after the move. `self` is the calling session's own tty, found by walking up the
    # process tree.
    # A --tty that is neither your own tab nor one of your chain is moved anyway, with a
    # warning on stderr and in close.log. The tabs that stay refused need --force,
    # which moves them and says so on stderr.

$SCRIPT rotate --dir <workdir> --old-tty <tty> [--trust] [--tier <tier> | --model <name> --effort <level>] [--expect-title <s>] \
    [--title <t>] [--prompt <text> | --prompt-file <path>] [--right-of self | --left-of <tty>] [--mcp <name>] [--gate-tokens <N>] \
    [--keep-tool <name>] [--drop-tool <name>] [--keep-synced-skills]
    # spawns the replacement FIRST and verifies it is running, then closes the old tab
    # Before any spawn it refuses what `close` refuses by its own checks for the old session,
    # and what a rotation cannot do safely. Nothing is spawned then; the exact lines:
    # - `rotate: refused: the window on <tty> is window 0, …` (window 0 of a home session)
    # - `rotate: refused: <tty> is a window of another tmux session (…), …`
    # - `rotate: refused: the window on <tty> is named '…', which does not contain '…'` and
    #   `rotate: refused: session on <tty> is titled '…', which does not contain '…'` (a
    #   window's name or a tab's title that does not hold --expect-title)
    # - `rotate: no session found on <tty>` (a tab, or a home tab, with no session behind it)
    #   and `rotate: no window of this home session runs on <tty>`
    # - `rotate: no terminal backend could serve this. …` (a title no rung can read)
    # - `rotate: refused: the session of the orchestrator in window 0 of the home server
    #   <server> cannot be read: …` (a home tab)
    # - `rotate: refused: <tty> is the tab that shows this session's own home server
    #   <server>, where the replacement would be made as a window: …` (its close would end
    #   that server, the replacement and the caller with it), and, from a caller in a tmux
    #   pane, `rotate: refused: whether <tty> shows this session's own home server <server>
    #   cannot be read (…): nothing was spawned` (a process table that could not be read)
    # - `rotate: refused: whether <tty> shows a home server cannot be read (…): nothing was
    #   spawned` (a process table that could not be read, from any caller)
    # - `rotate: refused: the old session on <tty> cannot be read before the spawn (…):
    #   nothing was spawned` (its host's tty or its host unread, a process table that could not
    #   be read included), and `rotate: refused: the session on <tty> can be told from another
    #   neither by its id (…) nor by its title (…): nothing was spawned`
    # - `rotate: refused: the session on <tty> can be told from another neither by its id (…)
    #   nor by its title ('…'), which holds no word a close could be guarded on: nothing was
    #   spawned` (a tab the app gives no id for, whose title holds no word character, the
    #   host's activity glyphs alone, spaced or not: no close of it could be guarded once the
    #   replacement runs)
    # - `rotate: refused: the spawn's options cannot be read (…): nothing was spawned` (a
    #   spawn option given with no value, `--tier` last on the line), exit 1
    # - `rotate: refused: <tty> is an auditor's tab (…)`, and a line of the same shape for the
    #   tab of the machine's supervising session: neither is an agent, so both are refused without
    #   --force, as are a flag that is not a rotation's and a pair that cannot be read (below)
    # A Ctrl-C during these reads, before the spawn begins, ends on the interpreter's traceback
    # and exit 130: nothing was spawned.
    # On success stdout carries the spawn's tty line, then the close's `closed 1 session on
    # <old tty>` line, and for a home tab a third line, `home: ended the server <server> and
    # its <n> window(s), session <id>`; the exit is 0.
    # Before the spawn the old session is read by who it is, not by its tty, which may be
    # handed to another session meanwhile: a window by its tmux id, a tab by the app's id of
    # its session, and its host by pid and start time. It is closed only while that same
    # window or session is on its tty. When the app gives no id (the AppleScript rung), its
    # close is guarded on the title it had before the spawn (`--expect-title`), and made only
    # while its host read before the spawn still runs: once that host has ended, a session on
    # its tty titled the same may be a stranger's, and nothing is closed (below). A title with
    # no word character guards nothing, and such a session is refused before the spawn (above).
    # The spawn's own refusal is the one close of the new session: a replacement whose terminal
    # failed after the tab was made, that came back with no tty, that never started, or whose
    # transcript carries no mode or another mode than the one asked, is closed by the spawn
    # before it returns, as any refused spawn is, while it may already run; the old session is
    # not touched then. Its tty, when known, is on stdout, and the line, exit 1: `rotate: the
    # spawn refused the replacement it made on <tty> (…) and closed it; the old session on
    # <old tty> was not touched, and nothing is left to close`. A close of it that failed keeps
    # both: `rotate: the spawn refused the replacement it made on <tty> (…) and could not close
    # it, so the old session on <old tty> was not closed; the replacement made on <tty> is
    # kept, though it was refused, and its chain entry may be missing; <check> before ending
    # the old session: …`, then the step as below. <check> names the replacement's host by its
    # pid, the one the spawn found or the one on its tty as the line is written: `check that it
    # runs with verify --tty <tty> --pid <pid>`, for a verify of the tty alone passes any host on
    # it; with no host there, `no host was seen on <tty> as this line was written: check that
    # the replacement runs there, which list shows,`. An interrupt during that close: `rotate:
    # the rotation was interrupted by <signal> while the spawn closed the replacement it made on
    # <tty>, which it refused (…): whether that close went through is not known: if list still
    # shows a session on <tty>, close it with close --tty <tty> --expect-title '<title>'
    # --keep-checkout; the old session on <old tty> was not touched`, guarded on the title it
    # was made with, for the tty may be given to another session once that close went through
    # (`no close of it is named, for its title holds no word a close could be guarded on` when
    # that title has none), and usually no tty line. One that lands once that close returned
    # gets the line of its outcome above, `… and closed it; …` or `… and could not close it,
    # …`.
    # Any other failure once the replacement may exist, from the start of its creation, ends
    # on one line too, exit 1, never on a traceback: an error of the app's connection inside
    # the creation, a tmux new-window or an AppleScript that times out, a tmux client killed by
    # a signal (`the tmux client of new-window was killed by <signal>, …`, which a kill aimed at
    # that child rather than at the launcher's process group gives), or anything the spawn
    # dies of after. Before its tty is known, no step ends the old session: the replacement
    # carries the old session's title, and a step taken on what list shows under it could end
    # the only agent. `rotate: the spawn failed while its replacement was being made (…), so the
    # old session on <old tty> was not closed; a window may exist, named '<title>', which list
    # shows; the old session is left as it was, and no step here ends it while no replacement's
    # tty is known`, with `the window <@N> it made, named '<title>', may still run, which list
    # shows` (or `the tab <id> it made, …`) when the creation answered its id. A tmux window
    # made and then killed by the spawn: `rotate: the spawn failed once tmux made the window
    # <@N> for its replacement (…), and that window was killed: nothing of the replacement is
    # left, and the old session on <old tty> was left as it was`. A creation that died before
    # it made anything (`no session found on <anchor>`, `iTerm2 has no current window`):
    # `rotate: the spawn failed before its replacement was made (…): nothing was made, and the
    # old session on <old tty> was left as it was`. Once its tty is known: `rotate: the spawn
    # failed once its replacement was made on <tty> (…), so the old session on <old tty> was not
    # closed; the replacement made on <tty> is kept, though whether it started was not verified,
    # and its chain entry may be missing; <check> before ending the old session: …`.
    # Once the spawn has returned, the replacement is never closed, for two agents can be
    # recovered by hand and none cannot. Whatever fails after the spawn ends on one `rotate:`
    # line on stderr that names both, with `the replacement runs on <tty> and is kept`; the
    # exit is 1, a stdout whose reader is gone included, and stdout carries the spawn's tty
    # line (usually none on an interrupt during the spawn, none on a failure of its creation
    # before the tty is known, nor on a failure of the spawn once its replacement is verified,
    # below), and the `closed` line only when the old session was closed:
    # - the old session no longer on its tty: `rotate: the old session on <tty> was not
    #   closed: its window or tab is gone since the spawn; …`, or `…: <tty> now holds another
    #   session (…), not the <window @N | session <id>> read before the spawn; …`
    # - a read of it before the close that failed (tmux not answering): `rotate: the old
    #   session on <tty> could not be read after the spawn (…), so it was not closed; …`
    # - a tab known by its title alone whose host read before the spawn has ended: `rotate: the
    #   old session on <tty> was not closed: its tab is known by its title alone, and its host
    #   read before the spawn has ended; …`
    # - a close refused by its own checks before it ended anything (a title that changed
    #   during the spawn): `rotate: the old session on <tty> was not closed: its close refused
    #   before it ended anything; …`
    # - a close that began ending the old session (a signal, a window or tab closed, a home
    #   server asked to end) and failed, or an error of any kind: `rotate: the close of the
    #   old session on <tty> failed (…); …`
    # - a close that went through and failed after, the write of its `closed` line to a
    #   reader gone included: `rotate: the old session on <tty> was closed, but what followed
    #   failed (…); …; nothing left to close`
    # - an interrupt (SIGINT, SIGTERM, SIGHUP) once the replacement runs: `rotate: the
    #   rotation was interrupted by <signal> after the spawn, before the close of the old
    #   session on <tty>, so it was not closed; …`, `rotate: the old session on <tty> was not
    #   closed: its close was interrupted by <signal> before it ended anything; …`, or `rotate:
    #   the close of the old session on <tty> failed (interrupted by <signal>); …`
    # - an interrupt during the spawn, once the terminal has made the replacement: `rotate: the
    #   rotation was interrupted by <signal> during the spawn, once its replacement was made on
    #   <tty>, so the old session on <old tty> was not closed; the replacement made on <tty> is
    #   kept, though whether it started was not verified, and its chain entry may be missing;
    #   <check> before ending the old session: …` (`the
    #   replacement runs on <tty>, verified, and is kept, …`, with no check, once it was
    #   verified). One that lands while the terminal makes it is held until the creation
    #   returns: the terminal's own children (the tmux client, the AppleScript runner) run in a
    #   session of their own meanwhile, so an interrupt sent to the launcher's process group
    #   does not kill them halfway. A tmux client killed by a signal anyway ends on the line of
    #   a failed spawn above.
    #   Before it is made: `rotate: the rotation was interrupted by <signal> before its
    #   replacement was made: nothing was spawned, and the old session on <old tty> was left
    #   as it was`
    # Each but the `was closed` one ends on what is left of the old session and the step that
    # ends it, and only it. A pid is named for a kill only when it is the old host read before
    # the spawn by its pid and start time, and still that process: whatever else runs on its
    # tty, the replacement's host or a stranger's, is described and never named for a kill.
    # Every value a step carries, a tty, a name or a title, is quoted for the shell (single
    # quotes where it needs any), so a step is safe to paste: a title holding quotes, a single
    # quote, `$(…)` or backquotes comes back as one argument. Every close a line names carries
    # `--keep-checkout`: the replacement works in the same checkout, which a close without it
    # deletes.
    # Still there: `its window or tab is still there, the same <window @N | session <id>> as
    # before the spawn: close it with close --tty <old tty> --expect-title '<name>'
    # --keep-checkout (its chain entry is left for that close)`, a window's name read again with its id, a tab's title
    # the one read before the spawn, so that a session given the tty later is refused; for a
    # tab, with its host still running, then `should that close refuse on a title rewritten
    # since, end the old session alone with kill <pid>, its host (pid <pid>) read before the
    # spawn, which still runs`. That printed step is the one place a rotation names
    # `--expect-title` itself, and the exception to passing none to a rotation: it is read
    # before the spawn, or again by the window's id, never typed from a title that changed. A
    # name or title made of glyphs alone guards nothing: no close is named, only `end the old
    # session alone with kill <pid>, its host (pid <pid>) read before the spawn, which still
    # runs; its <window | tab> and its chain entry are left`. A home tab still there gets its
    # close, guarded the same way on the title read before the spawn (read even when no
    # --expect-title is given), which ends its server and window 0's host with it, and that
    # host's kill should the close refuse, unless that close began and left the host running,
    # which is then named as below. Its identity never read: `a session titled '…' is on
    # <tty>, and the old one's id could not be read before the spawn (…): close it with close
    # --tty <tty> --expect-title '<old title>' --keep-checkout, which closes it only while its
    # title holds the old one's`, then, with its host's pid read before the spawn and that host
    # still running, `should that close refuse on a title rewritten since, end the old session
    # alone with kill <pid>, …`. Once that host has ended, no close: `its host ended` (with
    # `another host runs on <tty> now, …` when one does), then `a session titled '…' is on
    # <tty>, and the old one's id could not be read before the spawn (…): nothing tells it from
    # another session's, so no close of <tty> is named; its chain entry is left`. Gone with its host still running, which no command of this tool ends: `its
    # host (pid <pid>) still runs on <tty>, and no command of this tool ends it: end it with
    # kill <pid>`, then `its window or tab is gone, and its chain entry is left`. Gone with its
    # host: `nothing left to close`, and when another host runs on the tty, `another host runs
    # on <tty> now, not the one read before the spawn, and no step here ends it`. No host read
    # before the spawn: `a host runs on <tty>, but the old one's pid was not read before the
    # spawn, so it cannot be told from another session's: no kill is named`, or, with a process
    # table that cannot be read, `whether a host runs on <tty> is not known (the process table
    # could not be read)`. A process table that cannot be read: `whether its host (pid <pid>,
    # started <time>) still runs is not known (the process table could not be read): if pid
    # <pid> still shows that start time, end it with kill <pid>`. Its tty held by another
    # session: the old host alone, by the pid read before the spawn, and `no close of <tty> is
    # to be made: it would end the session now on it`. Unread: `if it is, close it with close
    # --tty <tty> --expect-title '<old title>' --keep-checkout`, or, with a title of glyphs
    # alone, `no close of <tty> is named`; once another host is seen on its tty, no close at
    # all: `…, and another host runs on <tty>: no close of <tty> is named`; nor with no host
    # read before the spawn and one that may run there: `…, and nothing tells the session on
    # <tty> from another's: no close of <tty> is named`. The host of a home tab, in window 0 of
    # its server, is read the same way.
    # A replacement given the old session's own tty is not closed either, and nothing is:
    # a close of that tty would end it, and the line says so. So with the tty the old host ran
    # on, window 0's behind a home tab: `rotate: the replacement was given <tty>, the tty the
    # host of the old session on <old tty> ran on: that host is no longer on it, so nothing was
    # closed, for a kill of what runs on <tty> would end the replacement; …`. A failure of the
    # spawn once the replacement is verified running (its chain entry's write) prints no tty
    # line on stdout and ends on `rotate: the replacement runs on <tty>, verified, but what
    # followed its spawn failed (…), so the old session on <old tty> was not closed; the
    # replacement is kept, its chain entry may be missing; …`, then the step as above; on the
    # old session's own tty, or its host's, the recycled line, with `what followed its spawn
    # failed too (…)`, and no close step.
    # A rotation is a succession: given no pair, the replacement runs on the ROTATED agent's
    # live model and effort, read on that agent's transcript (pair_source=transcript <path>);
    # a tier, or --model with --effort, is the orchestrator naming the pair (an escalation),
    # typed as given (pair_source=tier <t> or flag). An unreadable pair refuses the rotation
    # before anything is spawned.
    # every argument it does not consume reaches the spawn, `--trust` and `--mcp <name>`
    # included: an agent that needed a server is replaced by one that still has it.
    # One of --prompt, --prompt-file or --brief is required here too — a promptless
    # rotation is refused the same way a promptless spawn is, before the replacement's
    # tab exists and with the old session untouched. --no-verify is refused: the old tab
    # is closed only on a replacement verified running. --keep-tool, --drop-tool and
    # --keep-synced-skills are forwarded like --mcp, and only those given to `rotate`: the
    # replacement is opened with the default set, not the original's, so a rotation of an
    # agent that was given Artifact or the synced skills gives them again.

$SCRIPT pair
    # read-only: the calling session's model and effort now, `model=<model> effort=<level>`,
    # read on its transcript; exit 1 and the reason (the file, what was missing) otherwise.
    # The answer to a pause (`paused-ready`) and a move's record are filled from it.

$SCRIPT trust prune [--apply]      # entries of the trust record whose directory is gone; --apply removes them

$SCRIPT tools [--transcript <path>]
    # loaded    | Artifact | 55250 | 12238 | Orch,Coord,Audit,Agent
    # loaded    | mcp__orchestrator__move_send | 2013 | 446 | Audit,Agent
    # loaded    | SendFeedback | ? | ? | Orch,Coord,Audit,Agent     ← the reader's own session lacks it
    # deferred  | CronCreate | 10 | 2 | -
    # skills    | superpowers:brainstorming | 330 | 73 | -
    # agent-types | Explore | 520 | 115 | -
    # skills    | anthropic-skills:pdf | 290 | 64 | Orch,Coord,Audit,Agent
    # mcp       | context7 | 644 | 143 | -
    # What a session on this machine is given, and what each item costs on EVERY call, read
    # from a transcript; nothing is launched. By default the caller's own, found by
    # CLAUDE_CODE_SESSION_ID under the host's projects directory; --transcript reads another
    # (a session launched without the defaults shows the whole set). One row per item, fields
    # separated by ` | `: kind (loaded: the schema is sent on every call; deferred: only the
    # name, until a search loads the schema; skills; agent-types; mcp), name, characters,
    # tokens (characters × 0.2215, the ratio measured on tool schemas), and the roles whose
    # default removes it, `-` when none. Every name of the default removed sets is listed even
    # when the transcript lacks it, with `?` for what it cannot say. The `mcp` rows are the
    # catalogue's servers (<state dir>/mcp.json): the default set first, then what `--mcp
    # <name>` adds; their size is the transcript's server instructions, else `?`. Refused: no
    # session id and no --transcript, no transcript for the id, a missing file.
```

`ORCHESTRATOR_DRY_RUN=1` makes `spawn`, `close` and `move` print what they would ask the app for — the launch, the prompt file, the anchor — touching no terminal. It is the test suite's door, and yours when a launch looks wrong; `rotate` walks its whole order through it.

## Agents as windows of a home session

An orchestrator's tab holds a tmux session of its own, its **home session**, on a server of its own (`-L orch-<id>`, started with the plugin's `skills/iterm-agents/tmux/home.conf` and nothing of the operator's tmux setup). The orchestrator is in window 0, and **the launcher puts an agent where its caller runs**: a caller inside a home session (`$TMUX` set and the session carrying the plugin's mark) gets a window, any other caller a tab. Windows are a placement, not a rung of « When iTerm2 does not answer »: a failed iTerm2 call never falls to tmux, and a tmux that cannot answer inside a pane is a refusal that names the cause. The auditor is made as a tab, and so is a woken or opened orchestrator (as a home session of its own, shown by a tab).

- **`spawn`** makes the window with `new-window -d` (the operator's view stays put), named by `-n` with the title, because a window not named takes its program's name. It takes the next free index; `--right-of self` is read as « after my last agent », and a first place or `--left-of` is said to be unsupported there. Its chain entry is `tmux:<socket>:@N`, owned by `tmux:<socket>:%N`.
- **`list`** prints the home session's windows, one row each, the caller's own marked `self`, then the app's tabs it did not make as windows (an auditor's, for one). **`screen`** reads a window with `capture-pane`.
- **`close`** kills the window, guarded by `--expect-title` against the window's name, proved gone on the process table (a host still there is sent SIGTERM, then SIGKILL, as for a tab), the checkout deleted as for a tab. A tty of another tmux session is refused. On a tab that shows a home session it ends the whole server first and prints a `home:` line. A home session's window 0 is closed only by `takeover`: `close` refuses it, before anything is killed.
- **`move`** is `move-window`, with the operator's view kept; window 0 is refused as a subject, as an anchor to place something before, and as `--leftmost`. **`rotate`** spawns, verifies, then closes, as for tabs, after refusing before any spawn whatever `close` would refuse (window 0 included).
- **`home --session <id> --name "Orch: <subject>"`** is run by the hooks module at the end of the turn that names an orchestrator, never by hand: it makes the server, resumes the same conversation in window 0 and opens a tab showing it, printing `moved: …` or `stay: <why>` (a session that is not an orchestrator, or already in a home session, stays). **`home-release`** is window 0's watcher, closing the tab the orchestrator left once the resumed host is proved running. **`takeover --tty <predecessor> --expect-title <words>`** is a successor's close of its predecessor: window 0 killed (the title being required) and its host proved gone, sent SIGTERM then SIGKILL when it stays, then the successor's window moved to index 0.
- **The tab bar** shows one block per window — the name, then the state icon the module wrote on the window: busy ●, idle ○, asks ✋, done ✓, gate ⚠. A click on a block or `C-b n` / `C-b p` switches; the windows keep their numbers, so `C-b <digit>` still selects one, though the bar shows none. `C-b C-b` sends a Ctrl-B to the pane.
- **`ORCHESTRATOR_TMUX`** names the tmux binary (the suite stands a recorder in for it); `ORCHESTRATOR_HOME_WAIT` is how long window 0 waits for the moved session to end in its old place.

## How the launcher builds a tab

- **A directory the host has never opened stops the session on a workspace question**, whose highlighted answer is « exit ». Nobody sits at that keyboard: the session waits for ever having never read its brief, or takes a stray keystroke and quits — and from outside both look like a launched agent, because the process genuinely runs. `spawn` refuses such a launch before making a tab, and `--trust` records the answer for ONE directory (the limit is in `SKILL.md`'s launch safety order). The record is the host's own, `~/.claude.json`, and writing to it is why the flag is explicit rather than automatic. It never rewrites an entry that already says yes, and a record it cannot read is said on stderr rather than launched past in silence; entries outlive their directories — `trust prune` lists them, `--apply` removes them.
- **A spawn never takes the operator's focus.** The tab is created unselected: someone is working in another tab, and a launch that pulls the window across interrupts them every time an agent starts.
- **The tab runs the launch through a login shell** (`ORCHESTRATOR_LOGIN_SHELL`, else `SHELL`, else `/bin/zsh`), so the agent inherits the operator's PATH, the package manager's binaries included. The launch names the CLI by ABSOLUTE path, resolved from the orchestrator's own environment, so a profile that breaks PATH cannot kill it.
- **The app splits the command into words itself.** A compound command handed over raw is run by no shell at all. The launch goes to a FILE and the app is asked to run `/bin/sh <file>`: a path has no quoting, and quoting for someone else's tokenizer is the losing game the typed version already played.
- **A window's tab list is a cached copy.** Read a reorder back through the object you already held and it looks like a reorder that never happened — or reports the position the tab used to have. Re-fetch the app after any mutation.
- **The tab is born in the anchor's window, whichever window is in front.** The anchor is now searched across every window, and an anchor that is not there is refused before a tab exists (`spawn: no session found on <tty>`).
- **The title is the session's name.** `--title` is passed to the host as the session's name (shown in its prompt, its resume picker, the terminal title, and applied with a variant when a live session already holds it), in the shape `spawn` gives above. `--title-free` is the escape and the dry run says when it is on.
- **The tools a session is given are chosen, and the default is lean (§65).** The host sends every loaded tool's schema on every call; five tools no session has called and, for an agent or an auditor, the three that move an orchestrator weigh about 19,400 tokens per call. The launch names them in `--disallowedTools`, placed before the strict flag and the server file so the pair stays closed by `--permission-mode` (the option takes several values, like `--mcp-config`, and is never last). `--keep-tool` and `--drop-tool` change the set for one spawn; `tools` shows what exists and what each costs. The account's synced skills (`anthropic-skills:*`, never invoked) are hidden the same way, through the host's `syncClaudeAiSkills: false` in the launch's own `--settings`, which hides them for that session and moves nothing on disk (the same key in the operator's user settings would move the synced directory to the trash); `--keep-synced-skills` leaves them in. Artifact is removed by name, never by the host's `enableArtifact` setting, which also drops the « Scratchpad directory » line from the session's environment.
- **The first character of a title is an activity glyph, and it flips on its own** — one shape while the session works, another once it idles. `--expect-title` compares titles with that glyph stripped from both sides.
- **A pane behind a maximized sibling is still a session, and it is listed as `hidden`.** The host extension's « Chat / Diff / Code Review » bar opens each view as a sibling pane of the agent's tab and maximizes the one shown, so an agent with a review open is hidden and its tab shows the review. The tool reads hidden panes like visible ones; `close --tty` closes that SESSION alone and leaves the review pane and the tab.
- **The app's API must be enabled** (Preferences > General > Magic > Enable Python API), and the first connection asks macOS for permission once. `move` needs no Accessibility grant any more, does not bring the app to the front, and flickers no focus: the menu-driven version did all three.
- **The environment is the installer's, not yours.** `/orchestrator:install` builds it under the state directory; recent macOS refuses to install into a package-managed interpreter, and a plugin has no business writing into one it did not create. Without it the tooling refuses to run and says how to build it. `ORCHESTRATOR_PYTHON` overrides the choice.

## When iTerm2 does not answer

The launcher drives iTerm2 for the tabs it makes, and iTerm2 can stop answering. When it does, the launcher **names the cause** — it never hangs, it never reports a thing it did not verify, and it never quietly hands you a terminal you did not ask for.

**Why a menu stops an API.** A menu, a sheet or a modal dialog runs a NESTED event loop. While one runs, the app's main thread never returns to its default run loop mode and **AppleEvents are not dispatched** — they queue and expire on their own two-minute timeout, silently. The terminals keep scrolling the whole time, because a session's I/O runs on other threads, so nothing looks wrong from the outside. A sheet check does not find a context menu.

**Two rungs, and no third.** Every command tries them in order and says on stderr which one served it and why the one above did not:

| Rung | Serves | Does not survive |
|---|---|---|
| `api` | the normal case; it alone places tabs and keeps the chain | anything that stops the app answering |
| `applescript` | the module missing, the environment unbuilt, the API server off, a cookie refused — it drove this plugin before the API existed | a wedged main thread: it needs the same run loop |

`ORCHESTRATOR_BACKEND` names one rung and only that one, for a caller who wants the API's failure rather than a fallback that hides it. When both rungs are down, the app itself is wedged, and the launcher names the remedy and stops; `SKILL.md` says why no third rung exists.

**No AppleScript here is ever unbounded**, including the library's own cookie request: the app is asked the cheapest question there is — its version, under a deadline this process holds — BEFORE the API library is entered, because the library's authentication is a blocking read no timeout inside the call could reach. An app that cannot answer in eight seconds is never asked for a cookie.

**The cause is named, with its remedy.** When the app does not answer, the launcher samples its main thread and says what holds it. A modal loop reads:

> iTerm2's main thread is inside a MODAL event loop: a context menu, a menu or a dialog is
> open in the app. […] Dismiss it — press Escape in the iTerm2 window, or click elsewhere.
> No restart and no change of settings is needed, and no session is lost.

That is the whole repair for that fault: one keystroke. It needs no restart, which matters because a restart takes every running session with it.

**What the fallback cannot do is placement.** The app's AppleScript dictionary declares a tab `index` but does not implement it (`-1728` on every form, measured on 3.7.0), and the only placement left there drives the menu bar through the accessibility layer — a grant, the app brought to the front, a focus flicker per move — which is exactly what the API replaced. A fallback spawn lands where the app puts it and says so. A tab in the wrong place is an agent that runs; `move` it once the API answers again.
