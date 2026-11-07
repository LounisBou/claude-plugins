"""The bot's own messages already posted on a report: find one by its number, rewrite it, delete it."""

from __future__ import annotations

from datetime import datetime, timezone

from bugs_bot.channel import Channel, ChatId
from bugs_bot.errors import BugsError
from bugs_bot.followup import mark_awaiting
from bugs_bot.reports import mention_of
from bugs_bot.store import Store, load_report, update_report


def posted_reply(report: dict, number: int | None, verb: str) -> tuple[int, dict]:
    """Return ``(number, reply)`` of the bot's ``number``-th reply on ``report`` (1-based; ``None``: the last).

    Raises:
        BugsError: If there is no such reply, or it names nothing posted (no ``message_id`` nor ``file_ids``) or
            is deleted: it cannot be ``verb``.
    """
    replies = report["replies"]
    number = len(replies) if number is None else number
    if not 1 <= number <= len(replies):
        raise BugsError(f"no such reply: {report['id']} has {len(replies)} reply(ies), asked for {number}")
    reply = replies[number - 1]
    if not reply.get("message_id") and not reply.get("file_ids"):
        raise BugsError(f"reply {number} of {report['id']} has no message_id: it cannot be {verb}")
    if reply.get("deleted"):
        raise BugsError(f"reply {number} of {report['id']} is already deleted ({reply['deleted']}): it cannot be {verb}")
    return number, reply


def cmd_edit(
    channel: Channel,
    store: Store,
    chat_id: ChatId,
    report_id: str,
    text: str,
    now: float,
    number: int | None = None,
    tag: bool = False,
    awaits: bool = False,
) -> None:
    """Rewrite a reply the bot posted on a report: the last one, or the ``number``-th (1-based).

    The new text replaces the recorded one, the previous text goes to the reply's ``edits``;
    ``awaits`` records that the rewritten reply waits for the person's answer.
    Telegram's « message is not modified » is reported, not failed.

    Raises:
        BugsError: On no such reply, a reply without ``message_id`` or deleted, a reply carrying images, an empty
            text, or a channel error.
    """
    _, report = load_report(store, report_id)
    number, reply = posted_reply(report, number, "edited")
    if reply.get("images"):
        raise BugsError(f"reply {number} of {report_id} carries images: an image reply can only be deleted, not edited")
    if not text.strip():
        raise BugsError("empty text: nothing to write")
    mention = mention_of(report) if tag else None
    try:
        edited = channel.edit(report.get("chat_id", chat_id), reply["message_id"], text, mention)
    except BugsError as exc:
        if "message is not modified" not in str(exc):
            raise
        print(f"reply {number} of {report_id}: message is not modified")
        if awaits:  # the text stands as it was, and now waits for its answer
            mark_awaiting(store, report_id, number, now)
        return

    def record(fresh: dict) -> None:
        current = fresh["replies"][number - 1]  # replies are only ever appended: the number still holds
        current.setdefault("edits", []).append({"date": datetime.fromtimestamp(now, timezone.utc).isoformat(), "text": current["text"]})
        current["text"] = edited["text"]

    update_report(store, report_id, record)
    if awaits:
        mark_awaiting(store, report_id, number, now)
    print(f"edited reply {number} of {report_id}")


def cmd_delete(
    channel: Channel, store: Store, chat_id: ChatId, report_id: str, now: float, number: int | None = None
) -> None:
    """Delete a reply the bot posted on a report: the last one, or the ``number``-th (1-based, as ``show`` numbers them).

    Every message of the reply goes (each image of a group), and every file it shared. The reply stays in
    ``report.json``, marked ``deleted`` with the date: the record of what was said is kept. A wait that pointed at it is lifted: a deleted question awaits no answer. A message the
    group no longer has (« message to delete not found ») is marked the same, and said so.

    Raises:
        BugsError: On no such reply, a reply without ``message_id`` or already deleted, or another channel
            error (then nothing is marked).
    """
    _, report = load_report(store, report_id)
    number, reply = posted_reply(report, number, "deleted")
    gone = ""
    message_ids = reply.get("message_ids") or ([reply["message_id"]] if reply.get("message_id") else [])
    removals = [(channel.delete, (report.get("chat_id", chat_id), message_id)) for message_id in message_ids]
    removals += [(channel.delete_file, (file_id,)) for file_id in reply.get("file_ids", [])]
    for remove, args in removals:
        try:
            remove(*args)
        except BugsError as exc:
            # Deleted already (by an admin, or a delete whose answer was lost): the outcome is the one wanted.
            if "message to delete not found" not in str(exc):
                raise
            gone = " (already gone from the group)"

    def record(fresh: dict) -> None:
        fresh["replies"][number - 1]["deleted"] = datetime.fromtimestamp(now, timezone.utc).isoformat()
        if (fresh.get("awaiting") or {}).get("reply") == number:
            del fresh["awaiting"]

    update_report(store, report_id, record)
    print(f"deleted reply {number} of {report_id}{gone}")
