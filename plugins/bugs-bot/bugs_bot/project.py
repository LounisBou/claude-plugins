"""The project file ``.bugs-bot.json``: what one repository tells the bot about its group and its agent."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any

from bugs_bot.channel import ChatId
from bugs_bot.errors import BugsError
from bugs_bot.jsonio import write_json

if TYPE_CHECKING:
    from bugs_bot.registry import Registry

PROJECT_FILE = ".bugs-bot.json"
# A project id names a directory under the bugs home: nothing that could leave it.
PROJECT_ID = re.compile(r"[a-z0-9-]+")
DEFAULT_GATE_TOKENS = 300_000
DEFAULT_FOLLOW_UP_HOURS = 24
DEFAULT_LANGUAGE = "fr"
DEFAULT_CHANNEL = "telegram"
# Each channel kind and the shape of its chat ids: Telegram's are integers, Slack's a channel id
# (« C… » public, « G… » private). The one table here that grows with a new channel kind.
CHAT_IDS: dict[str, tuple[type, re.Pattern[str] | None]] = {
    "telegram": (int, None),
    "slack": (str, re.compile(r"[CG][A-Z0-9]+")),
}


@dataclass(frozen=True)
class Project:
    """One project, as its file declares it; ``repo`` is the directory holding the file."""

    project: str
    chat_id: ChatId
    title: str
    agent_title: str
    repo: Path
    deploy_url: str | None = None
    deploy_check: str | None = None
    docs: tuple[str, ...] = ()
    language: str = DEFAULT_LANGUAGE
    gate_tokens: int = DEFAULT_GATE_TOKENS
    follow_up_hours: float = DEFAULT_FOLLOW_UP_HOURS
    channel: str = DEFAULT_CHANNEL


def find_project_file(start: Path) -> Path | None:
    """Return the project file of ``start`` or of its nearest parent, ``None`` when there is none."""
    for directory in (start, *start.parents):
        candidate = directory / PROJECT_FILE
        if candidate.is_file():
            return candidate
    return None


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _valid_chat_id(channel: str, chat_id: Any) -> bool:
    """Tell whether ``chat_id`` has the shape of a chat id of ``channel``."""
    kind, shape = CHAT_IDS[channel]
    if kind is int:
        return _is_int(chat_id)
    return isinstance(chat_id, str) and (shape is None or shape.fullmatch(chat_id) is not None)


def load_project(path: Path) -> Project:
    """Read and validate a project file; ``repo`` is its directory.

    Raises:
        BugsError: If the file is unreadable, not a JSON object, or a key is missing or invalid
            (the message names the key).
    """
    try:
        data = json.loads(path.read_text())
    except OSError as exc:
        raise BugsError(f"cannot read {path}: {exc.strerror}") from None
    except ValueError as exc:
        raise BugsError(f"{path} is not valid JSON: {exc}") from None
    if not isinstance(data, dict):
        raise BugsError(f"{path} is not a JSON object")
    try:
        return build_project(data, path.parent)
    except BugsError as exc:
        raise BugsError(f"{path}: {exc}") from None


def build_project(data: dict, repo: Path) -> Project:
    """Validate a decoded project file and return the project; the errors name the key, the caller adds the path.

    Raises:
        BugsError: If a key is missing or invalid.
    """
    project = data.get("project")
    if not isinstance(project, str) or not PROJECT_ID.fullmatch(project):
        raise BugsError(f"project must match [a-z0-9-]+, got {project!r}")
    group = data.get("group")
    if not isinstance(group, dict):
        raise BugsError("group must be an object with chat_id and title")
    channel = data.get("channel", DEFAULT_CHANNEL)
    if channel not in CHAT_IDS:
        raise BugsError(f"channel must be one of {', '.join(CHAT_IDS)}, got {channel!r}")
    if not _valid_chat_id(channel, group.get("chat_id")):
        expected = "an integer" if CHAT_IDS[channel][0] is int else f"a {channel} channel id"
        raise BugsError(f"group.chat_id must be {expected}, got {group.get('chat_id')!r}")
    title = group.get("title")
    if not isinstance(title, str) or not title.strip():
        raise BugsError("group.title must be a non-empty string")
    agent_title = data.get("agent_title")
    if not isinstance(agent_title, str) or not agent_title.strip():
        raise BugsError("agent_title must be a non-empty string")
    for key in ("deploy_url", "deploy_check"):
        if data.get(key) is not None and not isinstance(data[key], str):
            raise BugsError(f"{key} must be a string")
    docs = data.get("docs", [])
    if not isinstance(docs, list) or not all(isinstance(d, str) for d in docs):
        raise BugsError("docs must be a list of strings")
    language = data.get("language", DEFAULT_LANGUAGE)
    if not isinstance(language, str) or not language.strip():
        raise BugsError("language must be a non-empty string")
    gate = data.get("gate_tokens", DEFAULT_GATE_TOKENS)
    if not _is_int(gate) or gate <= 0:
        raise BugsError(f"gate_tokens must be a positive integer, got {gate!r}")
    hours = data.get("follow_up_hours", DEFAULT_FOLLOW_UP_HOURS)
    if not (_is_int(hours) or isinstance(hours, float)) or isinstance(hours, bool) or not math.isfinite(hours) or hours <= 0:
        raise BugsError(f"follow_up_hours must be a positive number, got {hours!r}")
    return Project(
        project=project,
        chat_id=group["chat_id"],
        title=group["title"],
        agent_title=agent_title,
        repo=repo,
        deploy_url=data.get("deploy_url"),
        deploy_check=data.get("deploy_check"),
        docs=tuple(docs),
        language=language,
        gate_tokens=gate,
        follow_up_hours=hours,
        channel=channel,
    )


def dump_project(project: Project) -> dict:
    """Return the file's JSON shape (spec § 3.3): no ``repo``, no unset deploy key."""
    data: dict[str, Any] = {
        "project": project.project,
        "group": {"chat_id": project.chat_id, "title": project.title},
        "agent_title": project.agent_title,
    }
    if project.deploy_url is not None:
        data["deploy_url"] = project.deploy_url
    if project.deploy_check is not None:
        data["deploy_check"] = project.deploy_check
    data["docs"] = list(project.docs)
    if project.channel != DEFAULT_CHANNEL:
        data["channel"] = project.channel  # a Telegram project's file keeps the shape it always had
    data |= {
        "language": project.language,
        "gate_tokens": project.gate_tokens,
        "follow_up_hours": project.follow_up_hours,
    }
    return data


def rebind_chat(path: Path, chat_id: ChatId) -> None:
    """Write a new chat id into a project file, after the group was promoted to a supergroup.

    Raises:
        BugsError: If the file cannot be loaded or written (the message names it): the caller
            must not go on to the registry, which would then route where the file does not say.
    """
    project = load_project(path)
    try:
        write_json(path, dump_project(replace(project, chat_id=chat_id)))
    except OSError as exc:
        raise BugsError(f"cannot write {path}: {exc.strerror or exc}") from None


def resolve_project(name: str | None, cwd: Path, registry: Registry) -> Project:
    """Return the project named ``name`` (through the registry), else the one of ``cwd`` or a parent.

    Raises:
        BugsError: If no project file is found, the name is not registered, the file cannot be loaded,
            or the file declares another project than the registry's.
    """
    if name is not None:
        found = registry.by_project(name)
        if found is None:
            raise BugsError(f"no such project: {name} (not in the registry)")
        path = found[1].repo / PROJECT_FILE
        if not path.is_file():
            raise BugsError(f"project {name} is registered but {path} is missing: run /bugs-bot:init")
        project = load_project(path)
        if project.project != name:
            raise BugsError(f"{path} declares project {project.project}, not {name}: fix the file or the registry")
        return project
    path = find_project_file(cwd)
    if path is None:
        raise BugsError("no .bugs-bot.json here or above: run /bugs-bot:init")
    return load_project(path)
