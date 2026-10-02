"""The context gate: the size at which the agent hands over to a successor."""

from __future__ import annotations

import json

from bugs_bot.errors import BugsError
from bugs_bot.project import DEFAULT_GATE_TOKENS
from bugs_bot.store import Store, write_json

# The agent hands over at DEFAULT_GATE_TOKENS tokens (project.py), on a window of GATE_FULL_WINDOW or more;
# on a smaller one, at GATE_SMALL_WINDOW_SHARE of the window.
GATE_FULL_WINDOW = 1_000_000
GATE_SMALL_WINDOW_SHARE = 0.8


def _gate_setting(store: Store) -> int:
    """Return the ``context_gate_tokens`` setting, the default when none is set.

    Raises:
        BugsError: If the settings file or the value is unusable (never guessed around).
    """
    try:
        settings = json.loads((store.home / "settings.json").read_text())
    except FileNotFoundError:
        return DEFAULT_GATE_TOKENS
    except ValueError as exc:
        raise BugsError(f"settings.json is not valid JSON: {exc}") from exc
    value = settings.get("context_gate_tokens", DEFAULT_GATE_TOKENS) if isinstance(settings, dict) else None
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise BugsError(f"context_gate_tokens must be a positive integer, got {value!r}")
    return value


def cmd_gate(store: Store, set_to: int | None, window: int | None, tokens: int | None) -> None:
    """Print the context gate in tokens; ``--set`` changes the setting, ``--tokens`` adds the verdict.

    The setting lives in ``settings.json``, not in ``state.json``: the latter is the tool's own
    record (``posts``...), written back whole by the commands that touch it, so a key set by hand
    there is not safe.

    Raises:
        BugsError: If ``set_to`` is not a positive integer, or the setting file is unusable.
    """
    if set_to is not None:
        if set_to <= 0:
            raise BugsError(f"the gate must be a positive number of tokens, got {set_to}")
        path = store.home / "settings.json"
        try:
            settings = json.loads(path.read_text())
        except FileNotFoundError:
            settings = {}
        if not isinstance(settings, dict):
            raise BugsError("settings.json is not a JSON object")
        write_json(path, settings | {"context_gate_tokens": set_to})
    gate = _gate_setting(store)
    if window is not None and window < GATE_FULL_WINDOW:
        gate = min(gate, int(window * GATE_SMALL_WINDOW_SHARE))
    print(f"gate_tokens={gate}")
    if tokens is not None:
        print(f"handover={'yes' if tokens >= gate else 'no'}")
