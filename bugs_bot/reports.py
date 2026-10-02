"""Reports: list, show, answer in the group, move through the statuses, post."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from bugs_bot.answers import show_answers
from bugs_bot.channel import Channel, ChatId, Mention
from bugs_bot.errors import BugsError
from bugs_bot.followup import mark_awaiting, mark_reminded, require_due
from bugs_bot.images import check_images, post, record_sent
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
        for name in reply.get("images", []):
            print(f"  {(path / name).resolve()}")
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
    channel: Channel, chat_id: ChatId, store: Store, report: dict, text: str, now: float,
    mention: Mention | None = None, images: list[Path] | None = None,
) -> int:
    """Post ``text`` threaded on the report's first message, with ``images`` (checked) when given, then record it
    in ``report.json``: the images sent are copied beside the report and listed on the reply.

    Returns:
        The reply's number (1-based, as ``show`` numbers them) in the report as it is now.

    Raises:
        ImagesNotSent: The text went out alone: it is recorded, without images.
    """
    posted, shown, failure = post(channel, report.get("chat_id", chat_id), text, images or [], report["message_ids"][0], mention)
    reply = {"date": datetime.fromtimestamp(now, timezone.utc).isoformat(), **posted}

    def record(fresh: dict) -> int:
        fresh["replies"].append(reply)
        if shown:
            reply["images"] = record_sent(store.inbox / report["id"], len(fresh["replies"]), shown)
        return len(fresh["replies"])

    number = update_report(store, report["id"], record)
    if failure:
        raise failure
    return number


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
    images: list[str] | None = None,
) -> None:
    """Answer in the group, threaded on the report's first message; ``tag`` mentions its author.

    ``awaits`` records that the reply waits for the person's answer — unless their answer is already
    awaited on another report not done: one question at a time (spec § 3.5), so nothing is posted and
    the question is queued on their card, for ``wait`` to hand back (``ask <id>``) once they answer.
    ``follow_up_hours`` makes it the one reminder of a wait that old (refused before anything is
    sent when none is due). ``images`` go with the text, every one checked before anything is sent; a
    question that would be queued is refused with them: ask first, show after.
    """
    paths = check_images(images) if images else []
    _, report = load_report(store, report_id)
    if follow_up_hours is not None:
        require_due(report, follow_up_hours, now)
    other = awaited_elsewhere(store, report) if awaits else None
    if other:
        if paths:
            raise BugsError(f"{report['author']} already awaits {other}: a question is queued without images — ask first, show after")
        queue_question(store, report, text, now)
        print(f"queued {report_id}: {report['author']} already awaits {other}")
        return
    number = send_reply(channel, chat_id, store, report, text, now, mention_of(report) if tag else None, paths)
    if awaits:
        mark_awaiting(store, report_id, number, now)
        asked(store, report)
    if follow_up_hours is not None:
        mark_reminded(store, report_id, now)
    print(f"replied to {report_id}")


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
    channel: Channel, store: Store, chat_id: ChatId, text: str, now: float, mention_report: str | None = None,
    images: list[str] | None = None,
) -> None:
    """Post a one-off message in the group (an announcement), recorded in ``state.json``.

    With ``mention_report`` (a report id) the text opens with a mention of that report's author;
    ``images`` go with it, every one checked before anything is sent (the post records their count).
    """
    paths = check_images(images) if images else []
    mention = mention_of(load_report(store, mention_report)[1]) if mention_report else None
    posted, shown, failure = post(channel, chat_id, text, paths, None, mention)
    entry = {"date": datetime.fromtimestamp(now, timezone.utc).isoformat(), **posted}
    state = store.load_state()
    state.setdefault("posts", []).append(entry | ({"images": len(shown)} if shown else {}))
    store.save_state(state)
    if failure:
        raise failure
    if "message_id" in posted:
        print(f"posted message {posted['message_id']}")
    else:
        print(f"posted file{'s' * (len(posted['file_ids']) > 1)} {' '.join(posted['file_ids'])}")

