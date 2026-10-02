"""The registry ``projects.json``: the only file Pull reads to route a chat to a project."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from bugs_bot.errors import BugsError
from bugs_bot.jsonio import write_json
from bugs_bot.project import PROJECT_ID


@dataclass(frozen=True)
class Entry:
    """A registered project and the repository holding its project file."""

    project: str
    repo: Path


class Registry:
    """``{"<chat_id>": {"project": ..., "repo": ...}}``, one entry per chat and per project."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def entries(self) -> dict[int, Entry]:
        """Return the entries by chat id, ``{}`` while the file is absent.

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
        entries: dict[int, Entry] = {}
        for key, item in raw.items():
            try:
                chat_id = int(key)
                project, repo = item["project"], item["repo"]
                if not isinstance(project, str) or not PROJECT_ID.fullmatch(project) or not isinstance(repo, str):
                    raise ValueError(project)
            except (ValueError, TypeError, KeyError):
                raise BugsError(f"{self.path}: bad entry {key!r}") from None
            entries[chat_id] = Entry(project, Path(repo))
        return entries

    def project_for(self, chat_id: int) -> Entry | None:
        """Return the entry registered for a chat, if any."""
        return self.entries().get(chat_id)

    def by_project(self, project: str) -> tuple[int, Entry] | None:
        """Return ``(chat id, entry)`` of a project, if registered."""
        for chat_id, entry in self.entries().items():
            if entry.project == project:
                return chat_id, entry
        return None

    def add(self, chat_id: int, project: str, repo: Path) -> None:
        """Register a project under a chat; idempotent.

        The same project under a new chat id replaces its old entry.

        Raises:
            BugsError: If the project id is not ``[a-z0-9-]+``, another project holds the chat id,
                or the file is unreadable.
        """
        if not PROJECT_ID.fullmatch(project):
            raise BugsError(f"project must match [a-z0-9-]+, got {project!r}")
        entries = self.entries()
        holder = entries.get(chat_id)
        if holder is not None and holder.project != project:
            raise BugsError(f"chat {chat_id} already belongs to project {holder.project}")
        entries = {cid: e for cid, e in entries.items() if e.project != project}
        entries[chat_id] = Entry(project, repo)
        self._write(entries)

    def remove(self, project: str) -> bool:
        """Drop a project's entry; ``True`` when there was one."""
        entries = self.entries()
        kept = {cid: e for cid, e in entries.items() if e.project != project}
        if len(kept) == len(entries):
            return False
        self._write(kept)
        return True

    def _write(self, entries: dict[int, Entry]) -> None:
        write_json(self.path, {str(cid): {"project": e.project, "repo": str(e.repo)} for cid, e in entries.items()})
