"""Reports: list, show, answer in the group, move through the statuses, post."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from bugs_bot.answers import show_answers
from bugs_bot.channel import Channel, ChatId, Mention
from bugs_bot.errors import BugsError
from bugs_bot.followup import mark_awaiting, mark_reminded, require_due
from bugs_bot.questions import asked, awaited_elsewhere, drop_closed, queue_question
from bugs_bot.reactions import move_to, say_reaction_pending
from bugs_bot.store import CLOSED_STATUSES, EMOJI_FIXED, EMOJI_TAKEN, OPEN_STATUSES, Store, load_report, update_report


def one_line(text: str, width: int = 70) -> str:
    """Return the first line of ``text``, shortened."""
    line = text.strip().splitlines()[0] if text.strip() else ""
    return line if len(line) <= width else line[: width - 1] + "…"


def cmd_list(store: Store) -> None:
    """Print the ``new`` reports, oldest first."""
    for report_id, _, report in store.reports():
        if report["status"] not in OPEN_STATUSES:
            continue
        count = len(report["images"])
        print(
            f"{report_id}  {report['status']:<5}  {report['date'][:16]}  {one_line(report['text'])}"
            f"  [{count} image{'s' * (count != 1)}]"
        )


def cmd_show(store: Store, report_id: str) -> None:
    """Print a report's text and the absolute paths of its images."""
    path = store.report_dir(report_id)
    report = json.loads((path / "report.json").read_text())
    print(
        f"id: {report_id}  date: {report['date']}  author: {report['author']}  status: {report['status']}"
        f"  kind: {report.get('kind') or 'untriaged'}"
    )
    print(report["text"] or "(no text)")
    if report.get("fix_ref"):
        print(f"fix ref: {report['fix_ref']}")
    for name in report["images"]:
        print(f"  {(path / name).resolve()}")
    for number, reply in enumerate(report["replies"], 1):
        edits = len(reply.get("edits", []))
        count = f" ({edits} edit{'s' if edits > 1 else ''})" if edits else ""
        gone = f" (deleted {reply['deleted']})" if reply.get("deleted") else ""
        print(f"reply {number} {reply['date']}: {reply['text']}{count}{gone}")
    for line in show_answers(store, report_id, path, report):
        print(line)


def mention_of(report: dict) -> Mention:
    """Return who a mention of the report's author addresses.

    Raises:
        BugsError: If the report records neither a username nor a user id.
    """
    if not report.get("author_username") and not (report.get("author_id") and report.get("author")):
        raise BugsError(
            f"cannot mention the author of {report['id']}: no user id nor username recorded "
            "(try `backfill-authors`, else reply without --mention: a threaded reply notifies the author)"
        )
    return {
        "user_id": report.get("author_id"),
        "username": report.get("author_username"),
        "name": report.get("author") or "",
    }


def send_reply(
    channel: Channel, chat_id: ChatId, store: Store, report: dict, text: str, now: float, mention: Mention | None = None
) -> int:
    """Post ``text`` threaded on the report's first message, then record it in ``report.json``.

    Returns:
        The reply's number (1-based, as ``show`` numbers them) in the report as it is now.
    """
    sent = channel.send(report.get("chat_id", chat_id), text, report["message_ids"][0], mention)
    reply = {"date": datetime.fromtimestamp(now, timezone.utc).isoformat(), "text": sent["text"], "message_id": sent["message_id"]}

    def record(fresh: dict) -> int:
        fresh["replies"].append(reply)
        return len(fresh["replies"])

    return update_report(store, report["id"], record)


def cmd_reply(
    channel: Channel,
    store: Store,
    chat_id: ChatId,
    report_id: str,
    text: str,
    now: float,
    tag: bool = False,
    awaits: bool = False,
    follow_up_hours: float | None = None,
) -> None:
    """Answer in the group, threaded on the report's first message; ``tag`` mentions its author.

    ``awaits`` records that the reply waits for the person's answer — unless their answer is already
    awaited on another report not done: one question at a time (spec § 3.5), so nothing is posted and
    the question is queued on their card, for ``wait`` to hand back (``ask <id>``) once they answer.
    ``follow_up_hours`` makes it the one reminder of a wait that old (refused before anything is
    sent when none is due).
    """
    _, report = load_report(store, report_id)
    if follow_up_hours is not None:
        require_due(report, follow_up_hours, now)
    other = awaited_elsewhere(store, report) if awaits else None
    if other:
        queue_question(store, report, text, now)
        print(f"queued {report_id}: {report['author']} already awaits {other}")
        return
    number = send_reply(channel, chat_id, store, report, text, now, mention_of(report) if tag else None)
    if awaits:
        mark_awaiting(store, report_id, number, now)
        asked(store, report)
    if follow_up_hours is not None:
        mark_reminded(store, report_id, now)
    print(f"replied to {report_id}")


def posted_reply(report: dict, number: int | None, verb: str) -> tuple[int, dict]:
    """Return ``(number, reply)`` of the bot's ``number``-th reply on ``report`` (1-based; ``None``: the last).

    Raises:
        BugsError: If there is no such reply, or it has no ``message_id`` or is deleted: it cannot be ``verb``.
    """
    replies = report["replies"]
    number = len(replies) if number is None else number
    if not 1 <= number <= len(replies):
        raise BugsError(f"no such reply: {report['id']} has {len(replies)} reply(ies), asked for {number}")
    reply = replies[number - 1]
    if not reply.get("message_id"):
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
        BugsError: On no such reply, a reply without ``message_id`` or deleted, an empty text, or a channel error.
    """
    _, report = load_report(store, report_id)
    number, reply = posted_reply(report, number, "edited")
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

    The reply stays in ``report.json``, marked ``deleted`` with the date: the record of what was said is
    kept. A wait that pointed at it is lifted: a deleted question awaits no answer. A message the
    group no longer has (« message to delete not found ») is marked the same, and said so.

    Raises:
        BugsError: On no such reply, a reply without ``message_id`` or already deleted, or another channel
            error (then nothing is marked).
    """
    _, report = load_report(store, report_id)
    number, reply = posted_reply(report, number, "deleted")
    gone = ""
    try:
        channel.delete(report.get("chat_id", chat_id), reply["message_id"])
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


def cmd_taken(channel: Channel, store: Store, chat_id: ChatId, report_id: str) -> int:
    """The launcher took the report up: 👨‍💻 reaction, status ``taken``.

    Returns:
        1 if the reaction could not be set (it stays pending), else 0.

    Raises:
        BugsError: If the report is already closed (``fixed`` or ``done``).
    """
    _, report = load_report(store, report_id)
    if report["status"] in CLOSED_STATUSES:
        raise BugsError(f"{report_id} is already {report['status']}")
    _, failure = move_to(channel, store, chat_id, report_id, "taken", EMOJI_TAKEN)
    print(f"taken {report_id}")
    return say_reaction_pending(channel, failure)


def cmd_fixed(channel: Channel, store: Store, chat_id: ChatId, report_id: str, note: str | None, now: float) -> int:
    """Mark a report fixed: status, 👌 reaction, and the fix's ref (``note``) recorded as ``fix_ref``.

    Nothing is posted: a PR number or a commit means nothing to a tester (spec § 3.5); the agent
    tells them in its own words, and ``show`` gives it the ref. The status is saved before any
    network call, so a refused reaction leaves the report fixed and ``pull`` retries the reaction.

    Returns:
        1 if the reaction could not be set (it stays pending), else 0.
    """
    _, failure = move_to(channel, store, chat_id, report_id, "fixed", EMOJI_FIXED)
    if note:
        update_report(store, report_id, lambda report: report.update(fix_ref=note))
    print(f"fixed {report_id}")
    return say_reaction_pending(channel, failure)


def cmd_done(
    channel: Channel | None, store: Store, chat_id: ChatId, report_id: str, reason: str | None, now: float
) -> None:
    """Close a report without a fix; with ``reason``, say why in a reply. No reaction change."""
    _, report = load_report(store, report_id)
    if reason:
        assert channel is not None
        send_reply(channel, chat_id, store, report, reason, now)
    update_report(store, report_id, lambda fresh: fresh.update(status="done"))
    drop_closed(store, report)
    print(f"done {report_id}")


def cmd_post(
    channel: Channel, store: Store, chat_id: ChatId, text: str, now: float, mention_report: str | None = None
) -> None:
    """Post a one-off message in the group (an announcement), recorded in ``state.json``.

    With ``mention_report`` (a report id) the text opens with a mention of that report's author.
    """
    mention = mention_of(load_report(store, mention_report)[1]) if mention_report else None
    sent = channel.send(chat_id, text, None, mention)
    state = store.load_state()
    state.setdefault("posts", []).append(
        {"date": datetime.fromtimestamp(now, timezone.utc).isoformat(), "text": sent["text"], "message_id": sent["message_id"]}
    )
    store.save_state(state)
    print(f"posted message {sent['message_id']}")

