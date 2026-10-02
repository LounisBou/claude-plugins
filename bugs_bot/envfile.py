"""The machine's ``.env`` file, where each channel's token lives: read by that channel's own module only."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from bugs_bot.errors import BugsError
from bugs_bot.store import bugs_home


def read_secret(env: Mapping[str, str], name: str) -> str:
    """Read the variable ``name`` from the ``.env`` file, nowhere else (not the process environment).

    Args:
        env: Process environment (only ``BUGS_BOT_ENV_FILE`` and ``BUGS_BOT_HOME`` are consulted).
        name: The variable, e.g. a channel's token.

    Returns:
        Its value, unquoted.

    Raises:
        BugsError: If the file or the variable is missing; the message never holds a value.
    """
    path = Path(env.get("BUGS_BOT_ENV_FILE") or bugs_home(env) / ".env")
    try:
        lines = path.read_text().splitlines()
    except OSError as exc:
        raise BugsError(f"cannot read the env file {path}: {exc.strerror}") from None
    for line in lines:
        key, sep, value = line.partition("=")
        if sep and key.strip() == name and value.strip().strip("'\""):
            return value.strip().strip("'\"")
    raise BugsError(f"{name} not found in {path}")
