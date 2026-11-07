"""Reactions: the bot's one emoji on a report's first message, a status move that sets it, and the retries of a refused one."""

from __future__ import annotations

import sys

from bugs_bot.channel import Channel, ChatId
from bugs_bot.channels import mask
from bugs_bot.errors import BugsError
from bugs_bot.store import Store, update_report


def set_reaction(channel: Channel, chat_id: ChatId, report: dict, emoji: str) -> None:
    """Put ``emoji`` on the report's first message and record the outcome in ``report``, a copy in memory:
    ``record_reaction`` writes it, once the call is over (the lock is never held over the network).

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


def record_reaction(store: Store, report_id: str, outcome: dict) -> None:
    """Write the outcome of a reaction call (``set_reaction``'s ``reaction``) on the report as it is now.

    Only while that emoji is still the one wanted: a status moved meanwhile wants another, and the
    call that moved it records its own outcome. Everything else on the report is kept as it is now.
    """

    def record(report: dict) -> None:
        if (report.get("reaction") or {}).get("wanted") == outcome["wanted"]:
            report["reaction"] = dict(outcome)

    update_report(store, report_id, record)


def retry_pending_reactions(channel: Channel, store: Store, chat_id: ChatId) -> None:
    """Land every reaction that is wanted but not applied yet, in the chat each report was written in.

    ``chat_id`` is the project's current chat, used for a report that records none.
    Failures are reported on stderr and recorded; they do not fail the pull.
    """
    for report_id, _, report in store.reports():
        reaction = report.get("reaction")
        if not reaction or reaction.get("gone"):
            continue
        if reaction["wanted"] == reaction["applied"]:
            continue
        try:
            set_reaction(channel, chat_id, report, reaction["wanted"])
        except BugsError as exc:
            print(f"bugs-bot: reaction on {report_id} pending: {mask(str(exc), channel.secret)}", file=sys.stderr)
        # The copy read above may be stale by now (the agent closed or replied meanwhile): only its reaction is written.
        record_reaction(store, report_id, report["reaction"])


def move_to(
    channel: Channel, store: Store, chat_id: ChatId, report_id: str, status: str, emoji: str
) -> tuple[ChatId, BugsError | None]:
    """Set a report's status and its reaction; the status is saved before any network call.

    A refused reaction leaves the new status in place and the reaction pending,
    which the next ``pull`` retries.

    Returns:
        ``(chat_id, reaction failure or None)``.
    """

    def move(report: dict) -> dict:
        report["status"] = status
        report["chat_id"] = report.get("chat_id", chat_id)
        report.setdefault("reaction", {"wanted": emoji, "applied": None, "error": None})["wanted"] = emoji
        return report

    report = update_report(store, report_id, move)
    failure = None
    try:
        set_reaction(channel, chat_id, report, emoji)
    except BugsError as exc:
        failure = exc
    record_reaction(store, report_id, report["reaction"])
    return report["chat_id"], failure


def say_reaction_pending(channel: Channel, failure: BugsError | None) -> int:
    """Report a pending reaction on stderr; return the matching exit code."""
    if failure is None:
        return 0
    print(f"bugs-bot: reaction pending, `pull` will retry: {mask(str(failure), channel.secret)}", file=sys.stderr)
    return 1
