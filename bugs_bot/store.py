"""The inbox on disk: ``state.json`` and ``inbox/<report-id>/``."""

from __future__ import annotations

import json
import re
import sys
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path

from bugs_bot.errors import BugsError
from bugs_bot.jsonio import write_json
from bugs_bot.project import PROJECT_ID
from bugs_bot.registry import Registry

DEFAULT_HOME = Path.home() / ".bugs-bot"
# Statuses still waiting for a fix, and those that retention may delete.
OPEN_STATUSES = {"new", "seen", "taken"}
CLOSED_STATUSES = {"done", "fixed"}
# All three are in the Bot API's ReactionTypeEmoji set; a bot holds one reaction per message,
# so setting one replaces the last.
EMOJI_SEEN = "\U0001f440"  # 👀
EMOJI_TAKEN = "\U0001f468‍\U0001f4bb"  # 👨‍💻
EMOJI_FIXED = "\U0001f44c"  # 👌


def bugs_home(env: Mapping[str, str]) -> Path:
    """Return the machine's data directory: ``BUGS_BOT_HOME``, else ``DEFAULT_HOME``."""
    return Path(env.get("BUGS_BOT_HOME") or DEFAULT_HOME)


class Machine:
    """The machine-wide files of the bugs home, shared by every project.

    ``state.json`` holds the update offset (one consumer per bot, so one per machine),
    ``projects.json`` the registry, ``unregistered.json`` the group chats Pull dropped.
    """

    def __init__(self, home: Path) -> None:
        self.home = home
        self.registry = Registry(home / "projects.json")
        self.state_path = home / "state.json"
        self.unregistered_path = home / "unregistered.json"

    def load_offset(self) -> int | None:
        """Return the next update offset, ``None`` before the first pull.

        Raises:
            BugsError: If ``state.json`` is unreadable or not a JSON object (never guessed around:
                a wrong offset would replay or lose messages).
        """
        try:
            state = json.loads(self.state_path.read_text())
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            raise BugsError(f"cannot read {self.state_path}: {exc}") from None
        if not isinstance(state, dict):
            raise BugsError(f"{self.state_path} is not a JSON object")
        return state.get("offset")

    def save_offset(self, offset: int | None) -> None:
        """Write the offset atomically."""
        write_json(self.state_path, {"offset": offset})

    def note_unregistered(self, chat: dict, now: float) -> None:
        """Record a group chat Pull dropped, so that ``init`` can offer it; the latest sighting wins."""
        seen = self.unregistered()
        seen[chat["id"]] = {
            "title": chat.get("title") or "",
            "type": chat.get("type") or "",
            "last_seen": datetime.fromtimestamp(now, timezone.utc).isoformat(),
        }
        write_json(self.unregistered_path, {str(cid): item for cid, item in seen.items()})

    def unregistered(self) -> dict[int, dict]:
        """Return the dropped group chats by chat id, ``{}`` when none was seen.

        A log that cannot be read is only a list of suggestions for ``init``, and one bad file must
        not stall Pull for every project: it counts as empty (one line on stderr) and the next
        sighting rewrites it.
        """
        try:
            raw = json.loads(self.unregistered_path.read_text())
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as exc:
            return self._ignore_unregistered(exc)
        try:
            return {int(cid): dict(item) for cid, item in raw.items()}
        except (AttributeError, TypeError, ValueError) as exc:
            return self._ignore_unregistered(exc)

    def _ignore_unregistered(self, exc: Exception) -> dict[int, dict]:
        print(f"bugs-bot: {self.unregistered_path} ignored: {exc}", file=sys.stderr)
        return {}

    def project_store(self, project: str) -> Store:
        """Return the store of one project.

        Raises:
            BugsError: If the id is not ``[a-z0-9-]+``: it is a directory name and must not leave the home.
        """
        if not PROJECT_ID.fullmatch(project):
            raise BugsError(f"project must match [a-z0-9-]+, got {project!r}")
        return Store(self.home / project)


class Store:
    """The inbox on disk: ``state.json`` and ``inbox/<report-id>/``."""

    def __init__(self, home: Path) -> None:
        self.home = home
        self.inbox = home / "inbox"
        self.state_path = home / "state.json"
        self.people = home / "people"

    def load_state(self) -> dict:
        """Return the project's state (``posts``...), or ``{}`` while there is none."""
        try:
            return json.loads(self.state_path.read_text())
        except FileNotFoundError:
            return {}

    def save_state(self, state: dict) -> None:
        """Write the state atomically."""
        write_json(self.state_path, state)

    def report_dir(self, report_id: str) -> Path:
        """Return an existing report's directory.

        Raises:
            BugsError: If the id is not a plain name or no such report exists.
        """
        # An id is a directory name: refuse anything that could leave the inbox.
        if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z_-]*", report_id):
            raise BugsError(f"invalid report id: {report_id!r}")
        path = self.inbox / report_id
        if not (path / "report.json").is_file():
            raise BugsError(f"no such report: {report_id}")
        return path

    def reports(self) -> list[tuple[str, Path, dict]]:
        """Return ``(id, dir, report)`` for every complete report, oldest first."""
        if not self.inbox.is_dir():
            return []
        found = []
        for path in sorted(self.inbox.iterdir()):
            if path.name.startswith(".") or not (path / "report.json").is_file():
                continue
            found.append((path.name, path, json.loads((path / "report.json").read_text())))
        return found


def load_report(store: Store, report_id: str) -> tuple[Path, dict]:
    """Return a report's directory and its ``report.json`` content."""
    path = store.report_dir(report_id)
    return path, json.loads((path / "report.json").read_text())
