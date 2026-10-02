"""The handover note: what an agent at its gate leaves its successor, read once and archived."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from bugs_bot.errors import BugsError
from bugs_bot.store import Store

# The note is read by a successor on its first turn: past this it costs more than the handover saves.
NOTE_MAX_LINES = 40
NOTE_MAX_CHARS = 8000


def note_path(store: Store) -> Path:
    """Return where the unread note waits: ``handover.md`` in the project's data directory."""
    return store.home / "handover.md"


def write_note(store: Store, text: str, now: float) -> Path:
    """Write the note for the successor and return its path.

    Raises:
        BugsError: If the text is empty, longer than ``NOTE_MAX_LINES`` lines or ``NOTE_MAX_CHARS``
            characters (nothing is written: the agent shortens it and writes again), or a note nobody
            has read yet is still there (it is never overwritten: the successor that should have read
            it may have crashed half-way).
    """
    if not text.strip():
        raise BugsError("empty handover note")
    body = text.rstrip("\n")
    lines, chars = len(body.splitlines()), len(body)
    if lines > NOTE_MAX_LINES or chars > NOTE_MAX_CHARS:
        raise BugsError(
            f"handover note too long: {lines} lines, {chars} characters "
            f"(limit {NOTE_MAX_LINES} lines, {NOTE_MAX_CHARS} characters)"
        )
    path = note_path(store)
    if path.exists():
        raise BugsError(f"an unread handover note is already there: {path} (`handover read` first)")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(body + "\n")
    os.replace(tmp, path)
    return path


def read_note(store: Store, now: float) -> str | None:
    """Return the note once: it is moved to ``handover/<YYYYMMDD-HHMMSS>.md`` and recorded in ``state.json``.

    The move comes first and is atomic, so a successor that crashes half-way loses nothing: the
    note is in the archive, and a second read returns ``None`` rather than the same note again.

    Returns:
        The note's text, or ``None`` when there is no unread note.
    """
    path = note_path(store)
    if not path.exists():
        return None
    text = path.read_text()
    archive_dir = store.home / "handover"
    archive_dir.mkdir(exist_ok=True)
    stamp = datetime.fromtimestamp(now, timezone.utc).strftime("%Y%m%d-%H%M%S")
    archive, n = archive_dir / f"{stamp}.md", 1
    while archive.exists():  # two handovers in one second keep both notes
        n += 1
        archive = archive_dir / f"{stamp}-{n}.md"
    os.replace(path, archive)
    state = store.load_state()
    state.setdefault("handovers", []).append(
        {"read": datetime.fromtimestamp(now, timezone.utc).isoformat(), "archive": str(archive)}
    )
    store.save_state(state)
    return text


def last_archive(store: Store) -> Path | None:
    """Return the newest archived note, or ``None`` when none was ever read.

    It is looked up in the archive directory, not in ``state.json``: a successor that crashed
    between the move and the state write left the note there and no record of it.
    """

    def order(path: Path) -> tuple[str, str, int]:
        day, clock, *n = path.stem.split("-")  # <YYYYMMDD>-<HHMMSS>[-<n>]
        return day, clock, int(n[0]) if n else 1

    archives = list((store.home / "handover").glob("*.md"))
    return max(archives, key=order) if archives else None
