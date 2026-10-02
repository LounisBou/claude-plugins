"""The inbox on disk: ``state.json`` and ``inbox/<report-id>/``."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from bugs_bot.errors import BugsError

DEFAULT_HOME = Path.home() / ".torrentmate" / "tm-bugs"
# Statuses still waiting for a fix, and those that retention may delete.
OPEN_STATUSES = {"new", "seen", "taken"}
CLOSED_STATUSES = {"done", "fixed"}
# All three are in the Bot API's ReactionTypeEmoji set; a bot holds one reaction per message,
# so setting one replaces the last.
EMOJI_SEEN = "\U0001f440"  # 👀
EMOJI_TAKEN = "\U0001f468‍\U0001f4bb"  # 👨‍💻
EMOJI_FIXED = "\U0001f44c"  # 👌


def write_json(path: Path, data: dict) -> None:
    """Write JSON atomically: a temp file in the same directory, then rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, path)


class Store:
    """The inbox on disk: ``state.json`` and ``inbox/<report-id>/``."""

    def __init__(self, home: Path) -> None:
        self.home = home
        self.inbox = home / "inbox"
        self.state_path = home / "state.json"
        self.people = home / "people"

    def load_state(self) -> dict:
        """Return the state, or ``{}`` before the first ``bind``."""
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
