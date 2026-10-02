#!/usr/bin/env python3
"""Move the data of the previous single-project inbox into a bugs home, once.

The legacy layout is ``<legacy-home>/{inbox/, people/, state.json}`` with ``state.json`` holding
``chat_id``, ``offset`` and ``posts``, and the bot token in an ``.env`` file of its own. The target
is ``<bugs-home>/<project>/{inbox/, people/, state.json}`` plus the machine-wide
``<bugs-home>/state.json`` (the update offset) and ``<bugs-home>/.env`` (the token).

Every source is read and every target checked before the first write, so a refused run changes
nothing. The directories are written first, the offset and the token last: a failure half-way leaves
no machine-wide file, and the run says which paths exist and must be dealt with before a re-run. The
token value is never printed, and ``.env`` is created with mode 0600 from the start. The legacy
context gate (``settings.json``) is printed, never written: ``init --gate-tokens`` carries it.

Standard library only; it does not import the plugin, so it runs from any checkout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

PROJECT_ID = re.compile(r"[a-z0-9-]+")
PROJECT_FILE = ".bugs-bot.json"
SETTINGS_FILE = "settings.json"
GATE_KEY = "context_gate_tokens"
DEFAULT_GATE_TOKENS = 300_000  # bugs_bot.project.DEFAULT_GATE_TOKENS: this script does not import the plugin
TOKEN_KEY = "TELEGRAM_BOT_TOKEN"
MOVED_DIRS = ("inbox", "people")


class Refused(Exception):
    """A precondition failed: nothing has been written."""


def read_json_object(path: Path, what: str) -> dict:
    """Return the JSON object in ``path``.

    Raises:
        Refused: If the file is missing, unreadable or not a JSON object.
    """
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise Refused(f"cannot read {what} {path}: {exc}") from None
    if not isinstance(data, dict):
        raise Refused(f"{what} {path} is not a JSON object")
    return data


def check_offset(state: dict) -> int | None:
    """Return the legacy offset as it is: an integer >= 0, or ``None`` when absent or null.

    The value is copied, never adjusted: Telegram's offset is already « the next update », so
    ``+ 1`` would lose a message and ``0`` would replay the history.

    Raises:
        Refused: If it is anything else (a ``bool`` is not an offset).
    """
    offset = state.get("offset")
    if offset is None:
        return None
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise Refused(f"the legacy offset is not a natural number: {offset!r}")
    return offset


def read_token_line(env_file: Path) -> str:
    """Return the ``TELEGRAM_BOT_TOKEN=...`` line of ``env_file``, verbatim.

    Raises:
        Refused: If the file or the variable is missing. The message never holds the value.
    """
    try:
        lines = env_file.read_text().splitlines()
    except OSError as exc:
        raise Refused(f"cannot read the env file {env_file}: {exc.strerror}") from None
    except ValueError:
        raise Refused(f"the env file {env_file} is not valid UTF-8") from None
    for line in lines:
        key, sep, value = line.partition("=")
        if sep and key.strip() == TOKEN_KEY and value.strip().strip("'\""):
            return line
    raise Refused(f"{TOKEN_KEY} not found in {env_file}")


def read_gate(legacy: Path) -> int | None:
    """Return the legacy context gate from ``settings.json``, or ``None`` when there is none to carry.

    Raises:
        Refused: If the file exists but is unreadable, not an object, or the value is not a natural number.
    """
    path = legacy / SETTINGS_FILE
    if not path.exists():
        return None
    gate = read_json_object(path, "legacy settings").get(GATE_KEY)
    if gate is None:
        return None
    if isinstance(gate, bool) or not isinstance(gate, int) or gate < 1:
        raise Refused(f"{path}: {GATE_KEY} is not a positive integer: {gate!r}")
    return gate


def _unreadable(error: OSError) -> None:
    raise error


def check_readable(source: Path) -> None:
    """Check that every directory below ``source`` can be listed and every file read.

    Raises:
        Refused: Naming the first path that cannot be.
    """
    try:
        for root, _, files in os.walk(source, onerror=_unreadable):
            for name in files:
                if not os.access(Path(root) / name, os.R_OK):
                    raise Refused(f"cannot read {Path(root) / name}")
    except OSError as exc:
        raise Refused(f"cannot read {exc.filename or source}: {exc.strerror}") from None


def check_target_dir(path: Path) -> None:
    """Check that ``path`` is absent or a directory.

    Raises:
        Refused: If it is anything else.
    """
    if path.exists() and not path.is_dir():
        raise Refused(f"{path} exists and is not a directory")


def check_repo(repo: Path, project: str, chat_id: object) -> None:
    """Check that ``init`` already bound ``repo`` to this project and to the legacy group.

    Raises:
        Refused: If the project file is missing, names another project, another channel than Telegram
            (the legacy group's), or another group.
    """
    data = read_json_object(repo / PROJECT_FILE, "project file")
    if data.get("project") != project:
        raise Refused(f"{repo / PROJECT_FILE} is for project {data.get('project')!r}, not {project!r}")
    if data.get("channel", "telegram") != "telegram":
        raise Refused(f"{repo / PROJECT_FILE} is bound to a {data['channel']!r} channel, the legacy group is on Telegram")
    group = data.get("group")
    bound = group.get("chat_id") if isinstance(group, dict) else None
    if chat_id is not None and bound != chat_id:
        raise Refused(f"{repo / PROJECT_FILE} is bound to group {bound!r}, the legacy state to {chat_id!r}")


def write_text_private(path: Path, text: str) -> None:
    """Create ``path`` with mode 0600 from the first byte (no window at the umask's mode)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(text)
    os.chmod(path, 0o600)  # the umask can only narrow the mode at creation, never set it to anything else; this pins it


def write_json(path: Path, data: dict) -> None:
    """Write JSON atomically: a temp file next to ``path``, then rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, path)


def migrate(legacy: Path, bugs_home: Path, project: str, repo: Path, env_file: Path, copy: bool, done: list[str]) -> None:
    """Migrate the legacy tree, appending to ``done`` one line per thing written, as it is written.

    Args:
        legacy: The legacy data directory.
        bugs_home: The bugs home to fill.
        project: The project id.
        repo: The repository holding the project file.
        env_file: The legacy ``.env``.
        copy: Copy ``inbox/`` and ``people/`` instead of moving them.
        done: Receives the report lines (and, for a failure half-way, tells what exists).

    Raises:
        Refused: On any failed precondition, before anything is written.
        OSError: If a write fails half-way; ``done`` then holds what was written.
    """
    if not PROJECT_ID.fullmatch(project):
        raise Refused(f"project must match [a-z0-9-]+, got {project!r}")
    state = read_json_object(legacy / "state.json", "legacy state")
    offset = check_offset(state)
    gate = read_gate(legacy)
    token_line = read_token_line(env_file)
    check_repo(repo, project, state.get("chat_id"))

    target = bugs_home / project
    sources = [name for name in MOVED_DIRS if (legacy / name).is_dir()]
    for name in sources:
        check_readable(legacy / name)
    for path in (bugs_home, target):
        check_target_dir(path)
    if target.is_dir() and any(target.iterdir()):
        raise Refused(f"{target} is not empty: refusing to merge into it")
    for name in ("state.json", ".env"):
        if (bugs_home / name).exists():
            raise Refused(f"{bugs_home / name} already exists: refusing to overwrite it")

    for name in sources:
        source = legacy / name
        count = sum(1 for _ in source.iterdir())
        target.mkdir(parents=True, exist_ok=True)
        done.append(f"{target / name}/ may exist now ({'copy of' if copy else 'moved from'} {source})")
        if copy:
            shutil.copytree(source, target / name)
        else:
            shutil.move(str(source), str(target / name))
        done[-1] = f"{name}/ ({count} entries) {'copied' if copy else 'moved'} -> {target / name}"
    posts = state.get("posts")
    if posts:
        write_json(target / "state.json", {"posts": posts})
        done.append(f"{len(posts)} post(s) -> {target / 'state.json'}")
    write_json(bugs_home / "state.json", {"offset": offset})
    done.append(f"offset {offset} -> {bugs_home / 'state.json'}")
    write_text_private(bugs_home / ".env", token_line + "\n")
    done.append(f"token line -> {bugs_home / '.env'} (mode 0600)")
    if gate is None:
        done.append(f"legacy gate: none set, the default is {DEFAULT_GATE_TOKENS} tokens (nothing to carry)")
    else:
        done.append(f"legacy gate: {gate} tokens, not written: pass --gate-tokens {gate} to init")


def main(argv: list[str] | None = None) -> int:
    """Run the migration; return the exit code (0 done, 1 refused)."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--legacy-home", type=Path, required=True, help="the legacy data directory")
    parser.add_argument("--bugs-home", type=Path, required=True, help="the bugs home to fill")
    parser.add_argument("--project", required=True, help="the project id, [a-z0-9-]+")
    parser.add_argument("--repo", type=Path, required=True, help="the repository holding the project file")
    parser.add_argument("--env-file", type=Path, required=True, help="the legacy .env holding the token")
    parser.add_argument("--copy", action="store_true", help="copy inbox/ and people/ instead of moving them")
    args = parser.parse_args(argv)
    done: list[str] = []
    try:
        migrate(args.legacy_home, args.bugs_home, args.project, args.repo, args.env_file, args.copy, done)
    except Refused as exc:
        print(f"migration refused: {exc}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as exc:
        # The message never holds the token: only paths and the system's reason.
        print(f"migration failed half-way: {exc}", file=sys.stderr)
        print("these now exist; deal with them before a re-run (a move: move it back to the legacy home):", file=sys.stderr)
        print("\n".join(f"  {line}" for line in done) or "  (nothing)", file=sys.stderr)
        return 1
    print("\n".join(done))
    return 0


if __name__ == "__main__":
    sys.exit(main())
