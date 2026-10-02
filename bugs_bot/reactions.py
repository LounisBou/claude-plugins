"""Reactions: the bot's one emoji on a report's first message, a status move that sets it, and the retries of a refused one."""

from __future__ import annotations

import sys
from pathlib import Path

from bugs_bot.channel import Channel, mask
from bugs_bot.errors import BugsError
from bugs_bot.store import Store, load_report, write_json


def set_reaction(channel: Channel, chat_id: int, report: dict, emoji: str) -> None:
    """Put ``emoji`` on the report's first message and record the outcome in ``report``.

    A failure is recorded (not raised): the report must survive a refused reaction,
    and the next ``pull`` retries it.

    Raises:
        BugsError: Re-raised after recording, so the caller can say it.
    """
    state = report.setdefault("reaction", {"wanted": emoji, "applied": None, "error": None})
    state["wanted"] = emoji
    try:
        channel.react(report.get("chat_id", chat_id), report["message_ids"][0], emoji)
    except BugsError as exc:
        state["error"] = str(exc)
        # The operator deleted the message: no retry can ever land, stop trying.
        state["gone"] = "message to react not found" in str(exc)
        raise
    state["applied"] = emoji
    state["error"] = None


def retry_pending_reactions(channel: Channel, store: Store, chat_id: int) -> None:
    """Land every reaction that is wanted but not applied yet, in the chat each report was written in.

    ``chat_id`` is the project's current chat, used for a report that records none.
    Failures are reported on stderr and recorded; they do not fail the pull.
    """
    for report_id, path, report in store.reports():
        reaction = report.get("reaction")
        if not reaction or reaction.get("gone"):
            continue
        if reaction["wanted"] == reaction["applied"]:
            continue
        try:
            set_reaction(channel, chat_id, report, reaction["wanted"])
        except BugsError as exc:
            print(f"bugs-bot: reaction on {report_id} pending: {mask(str(exc), channel.secret)}", file=sys.stderr)
        write_json(path / "report.json", report)


def move_to(
    channel: Channel, store: Store, chat_id: int, report_id: str, status: str, emoji: str
) -> tuple[int, Path, dict, BugsError | None]:
    """Set a report's status and its reaction; the status is saved before any network call.

    A refused reaction leaves the new status in place and the reaction pending,
    which the next ``pull`` retries.

    Returns:
        ``(chat_id, dir, report, reaction failure or None)``.
    """
    path, report = load_report(store, report_id)
    report["status"] = status
    report["chat_id"] = report.get("chat_id", chat_id)
    report.setdefault("reaction", {"wanted": emoji, "applied": None, "error": None})["wanted"] = emoji
    write_json(path / "report.json", report)
    failure = None
    try:
        set_reaction(channel, chat_id, report, emoji)
    except BugsError as exc:
        failure = exc
    write_json(path / "report.json", report)
    return report["chat_id"], path, report, failure


def say_reaction_pending(channel: Channel, failure: BugsError | None) -> int:
    """Report a pending reaction on stderr; return the matching exit code."""
    if failure is None:
        return 0
    print(f"bugs-bot: reaction pending, `pull` will retry: {mask(str(failure), channel.secret)}", file=sys.stderr)
    return 1
