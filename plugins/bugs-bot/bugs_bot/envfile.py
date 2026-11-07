"""The machine's ``.env`` file, where each channel's token lives: read by that channel's own module only."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Mapping
from pathlib import Path

from bugs_bot.errors import BugsError
from bugs_bot.store import bugs_home


def env_path(env: Mapping[str, str]) -> Path:
    """Return the ``.env`` file: ``BUGS_BOT_ENV_FILE``, else ``.env`` in the bugs home."""
    return Path(env.get("BUGS_BOT_ENV_FILE") or bugs_home(env) / ".env")


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
    path = env_path(env)
    try:
        lines = path.read_text().splitlines()
    except OSError as exc:
        raise BugsError(f"cannot read the env file {path}: {exc.strerror}") from None
    for line in lines:
        key, sep, value = line.partition("=")
        if sep and key.strip() == name and value.strip().strip("'\""):
            return value.strip().strip("'\"")
    raise BugsError(f"{name} not found in {path}")


def write_secret(env: Mapping[str, str], name: str, value: str) -> Path:
    """Set ``name`` in the ``.env`` file: one line for it, the other lines kept; the file left at mode 0600.

    The new text goes to a temporary file created 0600 in the same directory, then replaces the file: the value is
    never readable by another user, not even for a moment, and no reader sees a half-written file.

    Returns:
        The file's path; the value is never returned or printed.

    Raises:
        BugsError: If the file cannot be read or written; the message never holds the value.
    """
    path = env_path(env)
    try:
        lines = path.read_text().splitlines() if path.exists() else []
    except OSError as exc:
        raise BugsError(f"cannot read the env file {path}: {exc.strerror}") from None
    kept = [line for line in lines if line.partition("=")[0].strip() != name]
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".env.")
    except OSError as exc:
        raise BugsError(f"cannot write the env file {path}: {exc.strerror}") from None
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write("\n".join([*kept, f"{name}={value}"]) + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except OSError as exc:
        Path(tmp).unlink(missing_ok=True)
        raise BugsError(f"cannot write the env file {path}: {exc.strerror}") from None
    return path
