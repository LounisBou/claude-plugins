"""The context gate: the size at which the agent hands over to a successor, and its measure."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path

from bugs_bot.errors import BugsError
from bugs_bot.jsonio import write_json
from bugs_bot.project import PROJECT_FILE, Project, dump_project

# The agent hands over at the project's gate_tokens on a window of GATE_FULL_WINDOW or more;
# on a smaller one, at GATE_SMALL_WINDOW_SHARE of the window.
GATE_FULL_WINDOW = 1_000_000
GATE_SMALL_WINDOW_SHARE = 0.8
# The orchestrator plugin's hooks module writes one JSON line per session at
# <config dir>/claude-orchestrator/measure/<session id>.json; `gate --measure` reads it.
# The config dir, never ORCHESTRATOR_STATE_DIR: that override governs only the roots the
# module shares with surviving shell writers, and the measure file is the module's own
# artifact — its readers resolve the config dir as its writer does.


def _config_dir(env: Mapping[str, str]) -> Path:
    """Return the host's config dir: the tool's override, else the host's, else ``~/.claude``."""
    return Path(env.get("BUGS_BOT_CLAUDE_DIR") or env.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


def measure_path(env: Mapping[str, str]) -> Path | None:
    """Return the measure file of the session the environment names, or ``None`` without one.

    The agent runs one plain command, ``bugs-bot gate --measure``: the session id and the
    config dir it inherits from the host name the file, and no versioned path ever reaches
    a permission rule.
    """
    session = env.get("CLAUDE_CODE_SESSION_ID", "")
    if not session:
        return None
    return _config_dir(env) / "claude-orchestrator" / "measure" / f"{session}.json"


def read_measure(path: Path) -> dict | None:
    """Read the module's measure file: one JSON line, the ``MeasureReading`` shape.

    A partial, empty or unparseable line — a write caught mid-flight, or a session the
    module closed by emptying its file — reads as unmeasured (``None``): a reader between
    two of the module's writes is the normal case, never an error to raise. The module's
    own reader keeps the same rule.
    """
    try:
        reading = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(reading, dict):
        return None
    for key in ("context_tokens", "context_window"):
        value = reading.get(key)
        if not isinstance(value, int) or isinstance(value, bool):
            return None
    return reading


def measure(env: Mapping[str, str]) -> tuple[int, int]:
    """Read the module's measure file and return ``(context_tokens, context_window)``.

    Args:
        env: Where the session id and the config dir are (``measure_path``).

    Raises:
        BugsError: If the environment names no session, or its measure file holds no
            readable line (absent, empty, partial).
    """
    path = measure_path(env)
    if path is None:
        raise BugsError("no session id: CLAUDE_CODE_SESSION_ID is unset in the agent's environment")
    reading = read_measure(path)
    if reading is None:
        raise BugsError(
            f"no readable measure at {path}: the orchestrator plugin's hooks module writes it "
            "each turn — load the plugin, take one turn, then retry"
        )
    return reading["context_tokens"], reading["context_window"]


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
        measure_now: Read both from the orchestrator module's measure file instead.
        env: The environment (the session id and config dir that name the measure file).

    Raises:
        BugsError: If ``set_to`` is not positive or the project file cannot be written, figures are
            both given and measured, or the measure file cannot be read.
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
        tokens, window = measure(env)
    if window is not None and window < GATE_FULL_WINDOW:
        gate = min(gate, int(window * GATE_SMALL_WINDOW_SHARE))
    print(f"gate_tokens={gate}")
    if tokens is not None:
        print(f"context_tokens={tokens}")
        if window is not None:
            print(f"context_window={window}")
        print(f"handover={'yes' if tokens >= gate else 'no'}")
