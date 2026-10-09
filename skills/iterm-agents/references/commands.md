# Commands

Read before typing any `iterm-agent.sh` command, and again when one fails, hangs or says on stderr that a fallback served it. SKILL.md carries when to spawn, close, move or rotate and in what order; the conditions that come with an option stay beside it here.

- Quick reference — `list`, `spawn`, `verify`, `screen`, `close`, `move`, `rotate`, `trust prune`, the dry run
- How the launcher builds a tab — trust, servers, focus, the launch file, the shell, the anchor's window, titles, hidden panes, the environment
- When iTerm2 does not answer — the cause named, the two rungs, what the fallback cannot do

## Quick reference

```bash
SCRIPT=${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh

$SCRIPT list
    # w1/t3 | /dev/ttys000 | ✳ chaining the PRs | Orch : plugin family | self
    # w1/t4 | /dev/ttys004 | ◐ reading the brief | Agent : phase 2
    # w1/t5 | /dev/ttys007 | ◐ Chat | (host default) | hidden   ← behind a maximized sibling pane
    # tab title, then the session's NAME (its --name, `(host default)` when it was launched
    # without one), then `self` on YOUR OWN tab.

$SCRIPT spawn --dir <workdir> [--tier deep|standard|light | --model <name> | --inherit-model] [--effort <low|medium|high|xhigh|max>] [--permission-mode auto] \
    --title "Agent : <subject>" --brief <brief-path> --orchestrator "<name [ref]>" [--right-of self | --successor] [--mcp <name>] [--gate-tokens <N>]
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
    # --title has a SHAPE — `Orch : <subject>` for an orchestrator and its successor,
    # `Agent : <subject>` for anything you spawn, the subject at most 25 characters —
    # because it is the session's name in every listing and the operator reads that listing.
    # Anything else is refused; `--title-free` is the escape for a probe that names its tab
    # otherwise, and only under `--title-free` does no title mean `agent` — without it, a
    # spawn with no title is refused.
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
    # context-gate hook and the status line, which both read it from their environment, use
    # it. Absent, nothing is exported and the default (300,000 tokens on a window of
    # 1,000,000 or more) holds. The token gate takes effect on a window of 1,000,000 tokens or
    # more only; below, the percentage gate of the window decides. With --brief, the startup
    # prompt adds « Your context gate is <N> tokens on a window of 1,000,000 tokens or more »
    # and says that below it the window's percentage gate holds (a --prompt or --prompt-file
    # spawn gets the export, not that line); a brief that says 300,000 is not rewritten. A successor does not inherit
    # the predecessor's gate: it carries one only if the option is given. `rotate` forwards it.
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
    # --inherit-model types the calling session's current model (from the context tap); for a successor.
    # --model <name> types that model for this one spawn, exclusive with --tier: the model the
    # orchestrator chose where the tier the work needs is unbound.
    # --tier resolves through the operator's map (<state dir>/models.json, or
    # ORCHESTRATOR_TIER_DEEP/_STANDARD/_LIGHT). An unbound tier and no --tier at all both
    # type no model argument: the host chooses. `resolve-tier <tier>` prints the binding:
    # `<model>` or `<model>/<effort>`; a tier may be bound to {"model": "<alias>", "effort": "<level>"}.
    # --effort types the effort after the model; --tier takes the map's, an explicit one wins.
    # None anywhere types no effort argument: the host applies its default.
    # --successor: the new session takes yours — immediately right of you, chain ignored, your chain handed to it (§34).
    #   With no --title it takes YOUR OWN name, read from the process table, so every brief
    #   that cites you still cites it; and it comes up under remote control under that name
    #   (--no-remote-control drops that). A session the older launcher named carries its
    #   prompt in its own process line, so the derivation refuses it and the title is typed
    #   by hand instead, and so is a name under an older convention, which no longer
    #   derives. An `Orch :` title with --right-of/--left-of
    #   is refused: a plain anchor lands after your chain, which is not a successor's place.
    #   From an `Audit : <subject>` session (an auditor kept on past its report, §9.4) it takes
    #   that name too, runs on your model whether or not --inherit-model is typed, comes up
    #   under remote control, and takes and hands NO chain (chain=none): an auditor has none,
    #   and written into one it would anchor the orchestrator's next agent. --tier, --model,
    #   --effort and --no-remote-control are refused there; a typed `Audit :` title still is, off --auditor.

$SCRIPT verify --tty /dev/ttysNNN
    # succeeds with the pid when the host CLI runs on that tty; exit 1 otherwise

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

$SCRIPT move --tty /dev/ttysNNN (--right-of self | --right-of /dev/ttysMMM | --left-of /dev/ttysMMM | --leftmost) [--force]
    # places a tab immediately beside another (same window), or at the FIRST place of its
    # window with --leftmost, exclusive with --left-of and --right-of; idempotent, verified
    # after the move. `self` is the calling session's own tty, found by walking up the
    # process tree.
    # Refuses a --tty that is neither your own tab nor one of your chain: a session you did
    # not launch is not yours to place. --force moves it anyway and says so on stderr.
    # --force is the operator's hand and the layout repair.

$SCRIPT rotate --dir <workdir> --old-tty <tty> [--trust] [--tier <tier>] [--expect-title <s>] \
    [--title <t>] [--prompt <text> | --prompt-file <path>] [--right-of self | --left-of <tty>] [--mcp <name>] [--gate-tokens <N>]
    # spawns the replacement FIRST and verifies it is running, then closes the old tab
    # every argument it does not consume reaches the spawn, `--trust` and `--mcp <name>`
    # included: an agent that needed a server is replaced by one that still has it.
    # One of --prompt, --prompt-file or --brief is required here too — a promptless
    # rotation is refused the same way a promptless spawn is, before the replacement's
    # tab exists and with the old session untouched.

$SCRIPT trust prune [--apply]      # entries of the trust record whose directory is gone; --apply removes them
```

`ORCHESTRATOR_DRY_RUN=1` makes `spawn`, `close` and `move` print what they would ask the app for — the launch, the prompt file, the anchor — touching no terminal. It is the test suite's door, and yours when a launch looks wrong; `rotate` walks its whole order through it.

## How the launcher builds a tab

- **A directory the host has never opened stops the session on a workspace question**, whose highlighted answer is « exit ». Nobody sits at that keyboard: the session waits for ever having never read its brief, or takes a stray keystroke and quits — and from outside both look like a launched agent, because the process genuinely runs. `spawn` refuses such a launch before making a tab, and `--trust` records the answer for ONE directory (the limit is in `SKILL.md`'s launch safety order). The record is the host's own, `~/.claude.json`, and writing to it is why the flag is explicit rather than automatic. It never rewrites an entry that already says yes, and a record it cannot read is said on stderr rather than launched past in silence; entries outlive their directories — `trust prune` lists them, `--apply` removes them.
- **A spawn never takes the operator's focus.** The tab is created unselected: someone is working in another tab, and a launch that pulls the window across interrupts them every time an agent starts.
- **The tab runs the launch through a login shell** (`ORCHESTRATOR_LOGIN_SHELL`, else `SHELL`, else `/bin/zsh`), so the agent inherits the operator's PATH, the package manager's binaries included. The launch names the CLI by ABSOLUTE path, resolved from the orchestrator's own environment, so a profile that breaks PATH cannot kill it.
- **The app splits the command into words itself.** A compound command handed over raw is run by no shell at all. The launch goes to a FILE and the app is asked to run `/bin/sh <file>`: a path has no quoting, and quoting for someone else's tokenizer is the losing game the typed version already played.
- **A window's tab list is a cached copy.** Read a reorder back through the object you already held and it looks like a reorder that never happened — or reports the position the tab used to have. Re-fetch the app after any mutation.
- **The tab is born in the anchor's window, whichever window is in front.** The anchor is now searched across every window, and an anchor that is not there is refused before a tab exists (`spawn: no session found on <tty>`). A spawn with no anchor still appends to the window in front: that is one more reason to always name one.
- **The title is the session's name, and the launcher holds it to the shape.** `--title` is passed to the host as the session's name (shown in its prompt, its resume picker, the terminal title, and applied with a variant when a live session already holds it), so it reads `Orch : <subject>` for an orchestrator and its successor or `Agent : <subject>` for anything an orchestrator spawns — an implementer, a review session, a comments agent, a probe, the subject saying which and at most 25 characters — and anything else, the spelled-out roles of the older convention and the old bare `agent` included, is refused before a tab exists. `--title-free` is the escape and the dry run says when it is on.
- **The first character of a title is an activity glyph, and it flips on its own** — one shape while the session works, another once it idles. `--expect-title` compares titles with that glyph stripped from both sides.
- **A pane behind a maximized sibling is still a session, and it is listed as `hidden`.** The host extension's « Chat / Diff / Code Review » bar opens each view as a sibling pane of the agent's tab and maximizes the one shown, so an agent with a review open is hidden and its tab shows the review. The tool reads hidden panes like visible ones; `close --tty` closes that SESSION alone and leaves the review pane and the tab.
- **The app's API must be enabled** (Preferences > General > Magic > Enable Python API), and the first connection asks macOS for permission once. `move` needs no Accessibility grant any more, does not bring the app to the front, and flickers no focus: the menu-driven version did all three.
- **The environment is the installer's, not yours.** `/orchestrator:install` builds it under the state directory; recent macOS refuses to install into a package-managed interpreter, and a plugin has no business writing into one it did not create. Without it the tooling refuses to run and says how to build it. `ORCHESTRATOR_PYTHON` overrides the choice.

## When iTerm2 does not answer

The launcher drives iTerm2, and iTerm2 can stop answering. When it does, the launcher **names the cause** — it never hangs, it never reports a thing it did not verify, and it never quietly hands you a terminal you did not ask for.

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
