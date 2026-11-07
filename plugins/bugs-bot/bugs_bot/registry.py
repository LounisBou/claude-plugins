"""The registry ``projects.json``: the only file Pull reads to route a chat to a project."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from bugs_bot.channel import ChatId
from bugs_bot.errors import BugsError
from bugs_bot.jsonio import write_json
from bugs_bot.project import PROJECT_ID


@dataclass(frozen=True)
class Entry:
    """A registered project and the repository holding its project file."""

    project: str
    repo: Path


# A chat id as a key holds it: digits are an integer id (Telegram's), anything else a string (Slack's).
_INT_ID = re.compile(r"-?\d+")
Key = tuple[str, ChatId]


def _key_of(text: str) -> Key:
    """Return ``(channel, chat id)`` of a ``"<channel>:<chat_id>"`` key.

    Raises:
        ValueError: If the channel or the chat id is missing.
    """
    channel, sep, raw = text.partition(":")
    if not (sep and channel and raw):
        raise ValueError(text)
    return channel, int(raw) if _INT_ID.fullmatch(raw) else raw


def _text_of(channel: str, chat_id: ChatId) -> str:
    return f"{channel}:{chat_id}"


class Registry:
    """``{"<channel>:<chat_id>": {"project": ..., "repo": ...}}``, one entry per chat and per project.

    The channel is part of the key: two platforms may name two different chats alike.
    """

    def __init__(self, path: Path) -> None:
        self.path = path

    def entries(self) -> dict[Key, Entry]:
        """Return the entries by ``(channel, chat id)``, ``{}`` while the file is absent.

        Raises:
            BugsError: If the file is not valid JSON or an entry is misshapen: it is never guessed around.
        """
        try:
            raw = json.loads(self.path.read_text())
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as exc:
            raise BugsError(f"cannot read the registry {self.path}: {exc}") from None
        if not isinstance(raw, dict):
            raise BugsError(f"{self.path} is not a JSON object")
        entries: dict[Key, Entry] = {}
        for key, item in raw.items():
            try:
                parsed = _key_of(key)
                project, repo = item["project"], item["repo"]
                if not isinstance(project, str) or not PROJECT_ID.fullmatch(project) or not isinstance(repo, str):
                    raise ValueError(project)
            except (ValueError, TypeError, KeyError):
                raise BugsError(f"{self.path}: bad entry {key!r}") from None
            entries[parsed] = Entry(project, Path(repo))
        return entries

    def project_for(self, channel: str, chat_id: ChatId) -> Entry | None:
        """Return the entry registered for a chat of a channel, if any."""
        return self.entries().get(_key_of(_text_of(channel, chat_id)))

    def by_project(self, project: str) -> tuple[Key, Entry] | None:
        """Return ``((channel, chat id), entry)`` of a project, if registered."""
        for key, entry in self.entries().items():
            if entry.project == project:
                return key, entry
        return None

    def add(self, channel: str, chat_id: ChatId, project: str, repo: Path) -> None:
        """Register a project under a chat of a channel; idempotent.

        The same project under a new chat (or a new channel) replaces its old entry.

        Raises:
            BugsError: If the project id is not ``[a-z0-9-]+``, another project holds the chat,
                or the file is unreadable.
        """
        if not PROJECT_ID.fullmatch(project):
            raise BugsError(f"project must match [a-z0-9-]+, got {project!r}")
        key = _key_of(_text_of(channel, chat_id))  # as it will read back
        entries = self.entries()
        holder = entries.get(key)
        if holder is not None and holder.project != project:
            raise BugsError(f"{channel} chat {chat_id} already belongs to project {holder.project}")
        entries = {k: e for k, e in entries.items() if e.project != project}
        entries[key] = Entry(project, repo)
        self._write(entries)

    def remove(self, project: str) -> bool:
        """Drop a project's entry; ``True`` when there was one."""
        entries = self.entries()
        kept = {k: e for k, e in entries.items() if e.project != project}
        if len(kept) == len(entries):
            return False
        self._write(kept)
        return True

    def _write(self, entries: dict[Key, Entry]) -> None:
        write_json(self.path, {_text_of(*key): {"project": e.project, "repo": str(e.repo)} for key, e in entries.items()})
