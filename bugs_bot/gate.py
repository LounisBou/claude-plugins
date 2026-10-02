"""The context gate: the size at which the agent hands over to a successor, and its measure."""

from __future__ import annotations

import re
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import replace
from pathlib import Path

from bugs_bot.errors import BugsError
from bugs_bot.jsonio import write_json
from bugs_bot.project import PROJECT_FILE, Project, dump_project

# The agent hands over at the project's gate_tokens on a window of GATE_FULL_WINDOW or more;
# on a smaller one, at GATE_SMALL_WINDOW_SHARE of the window.
GATE_FULL_WINDOW = 1_000_000
GATE_SMALL_WINDOW_SHARE = 0.8
# The orchestrator plugin's gauge, under each installed version of it.
GAUGE_GLOB = "plugins/cache/lounisbou/orchestrator/*/skills/context-gauge/scripts/context-gauge.sh"
GAUGE_TIMEOUT = 60


def _version_key(name: str) -> tuple:
    """Order version directory names as ``sort -V`` does for plain dotted numbers (0.10.0 after 0.9.0)."""
    return tuple((0, int(part), "") if part.isdigit() else (1, 0, part) for part in re.split(r"(\d+)", name) if part)


def locate_gauge(env: Mapping[str, str]) -> Path:
    """Return the gauge to run: ``BUGS_BOT_GAUGE``, else the newest installed orchestrator's.

    The agent runs one plain command, ``bugs-bot gate --measure``: no versioned path ever reaches a
    permission rule, and a plugin update needs no new one.

    Raises:
        BugsError: If ``BUGS_BOT_GAUGE`` names no file, or no installed version carries the gauge.
    """
    override = env.get("BUGS_BOT_GAUGE")
    if override:
        if not Path(override).is_file():
            raise BugsError(f"BUGS_BOT_GAUGE is not a file: {override}")
        return Path(override)
    claude = Path(env.get("BUGS_BOT_CLAUDE_DIR") or Path.home() / ".claude")
    found = sorted(claude.glob(GAUGE_GLOB), key=lambda p: _version_key(p.parents[3].name))
    if not found:
        raise BugsError("no context gauge found: the orchestrator plugin is not installed")
    return found[-1]


def measure(env: Mapping[str, str], run: Callable[[list[str]], str]) -> tuple[int, int]:
    """Run the gauge and return ``(context_tokens, context_window)``.

    Args:
        env: Where to find the gauge (``locate_gauge``).
        run: Runs a command and returns its standard output; raises ``BugsError`` when it fails.

    Raises:
        BugsError: If the gauge cannot be found, fails, or does not print both figures as integers.
    """
    output = run(["bash", str(locate_gauge(env))])
    figures = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    try:
        return int(figures["context_tokens"]), int(figures["context_window"])
    except (KeyError, ValueError):
        raise BugsError(f"the context gauge gave no context_tokens / context_window figures: {output.strip()!r}") from None


def _run_gauge(env: Mapping[str, str]) -> Callable[[list[str]], str]:
    """Return a runner for the gauge, in the caller's environment (the gauge reads the session id there)."""

    def run(argv: list[str]) -> str:
        try:
            done = subprocess.run(argv, capture_output=True, text=True, env=dict(env), timeout=GAUGE_TIMEOUT)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise BugsError(f"the context gauge did not run: {exc}") from None
        if done.returncode != 0:
            raise BugsError(f"the context gauge failed (exit {done.returncode}): {done.stderr.strip()}")
        return done.stdout

    return run


def cmd_gate(
    project: Project, set_to: int | None, window: int | None, tokens: int | None, measure_now: bool, env: Mapping[str, str]
) -> None:
    """Print the context gate in tokens; with a context size (given or measured), also the verdict.

    The gate is the project file's ``gate_tokens``; ``--set`` rewrites it there, the operator's one line.

    Args:
        project: The project, whose file holds the gate.
        set_to: A new gate to write first.
        window: The context window, when given by hand.
        tokens: The context size, when given by hand.
        measure_now: Measure both through the gauge instead.
        env: The environment (where the gauge is, and what it reads).

    Raises:
        BugsError: If ``set_to`` is not positive or the project file cannot be written, figures are both given and measured, or the gauge fails.
    """
    if measure_now and (window is not None or tokens is not None):
        raise BugsError("--measure reads the window and the tokens itself: give neither")
    gate = project.gate_tokens
    if set_to is not None:
        if set_to <= 0:
            raise BugsError(f"the gate must be a positive number of tokens, got {set_to}")
        path = project.repo / PROJECT_FILE
        try:
            write_json(path, dump_project(replace(project, gate_tokens=set_to)))
        except OSError as exc:
            raise BugsError(f"cannot write {path}: {exc.strerror or exc}") from None
        gate = set_to
    if measure_now:
        tokens, window = measure(env, _run_gauge(env))
    if window is not None and window < GATE_FULL_WINDOW:
        gate = min(gate, int(window * GATE_SMALL_WINDOW_SHARE))
    print(f"gate_tokens={gate}")
    if tokens is not None:
        print(f"context_tokens={tokens}")
        if window is not None:
            print(f"context_window={window}")
        print(f"handover={'yes' if tokens >= gate else 'no'}")
