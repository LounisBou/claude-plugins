"""``init`` and ``remove``: bind a repository to a Telegram group, or release it."""

from __future__ import annotations

import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path

from bugs_bot.channel import Channel
from bugs_bot.errors import BugsError
from bugs_bot.jsonio import write_json
from bugs_bot.project import PROJECT_FILE, Project, build_project, dump_project, find_project_file, load_project
from bugs_bot.pull import ALLOWED_UPDATES, chats_seen
from bugs_bot.store import Machine


@dataclass(frozen=True)
class InitArgs:
    """What the operator gave on the command line; ``None`` means « not given », so a re-run keeps the file's value."""

    project: str | None = None
    agent_title: str | None = None
    chat_id: int | None = None
    title: str | None = None
    deploy_url: str | None = None
    deploy_check: str | None = None
    docs: tuple[str, ...] | None = None
    language: str | None = None
    gate_tokens: int | None = None


def _git(directory: Path, *argv: str) -> str:
    """Run git in ``directory``; return its stdout, stripped.

    Raises:
        BugsError: If git is missing or the command fails (``directory`` is not in a repository).
    """
    try:
        result = subprocess.run(["git", "-C", str(directory), *argv], capture_output=True, text=True, check=False)
    except OSError as exc:
        raise BugsError(f"cannot run git: {exc.strerror}") from None
    if result.returncode:
        raise BugsError(f"{directory} is not inside a git repository ({result.stderr.strip() or 'git failed'})")
    return result.stdout.strip()


def repo_root(directory: Path) -> Path:
    """Return the top of the working tree holding ``directory``."""
    return Path(_git(directory, "rev-parse", "--show-toplevel"))


def git_exclude_path(repo: Path) -> Path:
    """Return the absolute ``info/exclude`` of ``repo``: in a worktree, the one of the common git directory."""
    path = Path(_git(repo, "rev-parse", "--git-path", "info/exclude"))
    return path if path.is_absolute() else repo / path


def exclude_line(repo: Path) -> str:
    """Return the ``info/exclude`` pattern of ``repo``'s project file.

    Patterns there are anchored at the top of the working tree, so a repository
    that is a subdirectory of it needs its path in front.
    """
    prefix = _git(repo, "rev-parse", "--show-prefix")  # "" at the root, else "sub/dir/"
    return f"/{prefix}{PROJECT_FILE}"


def add_exclude(repo: Path) -> bool:
    """Keep the project file out of git without touching the project's ``.gitignore``.

    Returns:
        ``True`` when the line was added, ``False`` when it was already there.
    """
    path = git_exclude_path(repo)
    line = exclude_line(repo)
    text = path.read_text() if path.exists() else ""
    if line in (existing.strip() for existing in text.splitlines()):
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + ("" if not text or text.endswith("\n") else "\n") + line + "\n")
    return True


def discover_groups(channel: Channel | None, machine: Machine, pull_running: bool) -> dict[int, dict]:
    """Return the group chats the bot has seen, by chat id.

    Pull holds the bot's update stream, and a second poller would cut its held request: while it runs
    only the chats it dropped are known. Otherwise the pending updates are read without an offset, so
    nothing is consumed, and merged with those chats.
    """
    found = {cid: {"title": item["title"], "type": item["type"]} for cid, item in machine.unregistered().items()}
    if not pull_running and channel is not None:
        updates = channel.get_updates(None, 0, list(ALLOWED_UPDATES))
        found |= {cid: {"title": chat.get("title") or "", "type": chat["type"]} for cid, chat in chats_seen(updates).items()}
    return found


def _chosen_group(
    channel: Channel | None, machine: Machine, name: str, pull_running: bool | Callable[[], bool]
) -> tuple[int, str] | None:
    """Return the one new group, else say why there is none (or which are there) and return ``None``."""
    held = {cid for cid, entry in machine.registry.entries().items() if entry.project != name}
    pull_running = pull_running() if callable(pull_running) else pull_running  # asked only now: only a search needs it
    groups = {cid: chat for cid, chat in discover_groups(channel, machine, pull_running).items() if cid not in held}
    if len(groups) == 1:
        (cid, chat), = groups.items()
        return cid, chat["title"]
    if not groups:
        if channel is None and not pull_running:
            raise BugsError("no bot token to look for the group: pass --chat-id and --title")
        print("bugs-bot: no group found: post one message in the new group, then run init again", file=sys.stderr)
        return None
    for cid, chat in sorted(groups.items()):
        print(f"{cid}  {chat['title']}")
    print("bugs-bot: several groups found: pick one with --chat-id and --title", file=sys.stderr)
    return None


def cmd_init(channel: Channel | None, machine: Machine, repo: Path, args: InitArgs, pull_running: bool | Callable[[], bool]) -> int:
    """Write ``repo``'s project file and register it; re-running updates both and never duplicates.

    Args:
        channel: To look for the group; ``None`` without a token.
        machine: The machine-wide files (registry, unregistered chats).
        repo: The repository the project file goes in.
        args: The command-line values.
        pull_running: Whether Pull runs, so that the group is looked for without a second poller; or a
            function that tells, called only when a group has to be looked for.

    Returns:
        0 when written; 1 when no group, or several, was found (they are listed, nothing is written).

    Raises:
        BugsError: On a missing or invalid value, a chat held by another project, or a repo outside git.
    """
    exclude = git_exclude_path(repo)  # before any write: outside a repository, nothing is done
    path = repo / PROJECT_FILE
    existing = load_project(path) if path.exists() else None
    name = args.project or (existing.project if existing else None)
    if name is None:
        raise BugsError("--project is required on a first run")
    if existing and name != existing.project:
        raise BugsError(f"this repository is already project {existing.project}: re-run without --project {name}")
    if (args.chat_id is None) != (args.title is None):
        raise BugsError("--chat-id and --title go together" + (": --title is missing" if args.title is None else ": --chat-id is missing"))
    if existing is None and not args.agent_title:
        raise BugsError("--agent-title is required on a first run")
    chat_id, title = args.chat_id, args.title
    if chat_id is None and existing is None:
        group = _chosen_group(channel, machine, name, pull_running)
        if group is None:
            return 1
        chat_id, title = group
    base = existing or Project(project=name, chat_id=chat_id, title=title, agent_title=args.agent_title, repo=repo)
    given = {
        key: value
        for key, value in {
            "chat_id": chat_id,
            "title": title,
            "agent_title": args.agent_title,
            "deploy_url": args.deploy_url,
            "deploy_check": args.deploy_check,
            "docs": args.docs,
            "language": args.language,
            "gate_tokens": args.gate_tokens,
        }.items()
        if value is not None
    }
    project = replace(base, **given)
    data = dump_project(project)
    build_project(data, repo)  # the same validation as a load, before anything is written
    held = machine.registry.by_project(project.project)
    if held and held[1].repo.resolve() != repo.resolve():
        raise BugsError(f"project {project.project} is already registered for {held[1].repo}: run remove there first")
    machine.registry.add(project.chat_id, project.project, repo)
    write_json(path, data)
    if add_exclude(repo):
        print(f"added {exclude_line(repo)} to {exclude}")
    print(f"wrote {path}")
    print(f"registered {project.chat_id} -> {project.project} {repo}")
    return 0


def cmd_remove(machine: Machine, project: str) -> None:
    """Unregister a project by name: Pull stops routing its group; its data and project file stay.

    The project file is never read: a missing or corrupt one must not keep a vanished repository routed.
    """
    found = machine.registry.by_project(project)
    machine.registry.remove(project)
    print(f"{'unregistered' if found else 'not registered'}: {project}")
    kept = [f"{machine.project_store(project).home} (data)"]
    if found:
        kept.append(f"{found[1].repo / PROJECT_FILE} (project file)")
    print("kept: " + ", ".join(kept))
