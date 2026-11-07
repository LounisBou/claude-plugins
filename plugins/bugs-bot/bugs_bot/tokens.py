"""``token``: whether a platform's bot token is in the ``.env`` file, and setting it there once.

The token never travels on a command line (``ps`` and the transcript would show it) and is never printed: ``--set``
reads it from a hidden prompt on the terminal, or from standard input when that is not a terminal.
"""

from __future__ import annotations

import getpass
import sys
from collections.abc import Callable, Mapping

from bugs_bot.channels import token_problem, token_spec
from bugs_bot.envfile import env_path, write_secret
from bugs_bot.errors import BugsError


def read_hidden(prompt: str) -> str:
    """Read one line: a hidden prompt on the terminal, else standard input's first line."""
    if sys.stdin.isatty():
        return getpass.getpass(prompt)
    return sys.stdin.readline()


def cmd_token(env: Mapping[str, str], kind: str, set_: bool, read: Callable[[str], str] = read_hidden) -> int:
    """Say whether ``kind``'s token is in the ``.env`` file; with ``set_``, ask for it when it is missing.

    Args:
        env: Environment (where the ``.env`` file is).
        kind: The platform, ``telegram`` or ``slack``.
        set_: Ask for the token when it is missing and write it; a token already there is never asked again.
        read: Reads the token from the operator, given the prompt; tests inject one.

    Returns:
        0 when the token is there (or was just written), 1 when it is missing.

    Raises:
        BugsError: On an unknown kind, a value that is not shaped like the platform's token, or a file not writable.
            No message holds the value.
    """
    name, shape = token_spec(kind)
    path = env_path(env)
    if token_problem(kind, env) is None:
        print(f"{kind} token: present in {path}")
        return 0
    if not set_:
        print(f"{kind} token: missing from {path} ({name}): `bugs-bot token --channel {kind} --set` asks for it")
        return 1
    value = read(f"{name} (hidden, not echoed): ").strip().strip("'\"")
    if not value:
        raise BugsError(f"no {kind} token given: nothing written")
    if not shape.fullmatch(value):
        raise BugsError(f"what was given is not shaped like a {kind} bot token: nothing written")
    print(f"{kind} token: written to {write_secret(env, name, value)} (mode 0600)")
    return 0
