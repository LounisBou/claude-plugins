"""Reports: list, show, answer in the group, move through the statuses, post, recover authors."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from bugs_bot.channel import Channel, Mention
from bugs_bot.errors import BugsError
from bugs_bot.store import CLOSED_STATUSES, EMOJI_FIXED, EMOJI_TAKEN, OPEN_STATUSES, Store, load_report, write_json
from bugs_bot.telegram import mask


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
    for name in report["images"]:
        print(f"  {(path / name).resolve()}")
    for number, reply in enumerate(report["replies"], 1):
        edits = len(reply.get("edits", []))
        count = f" ({edits} edit{'s' if edits > 1 else ''})" if edits else ""
        print(f"reply {number} {reply['date']}: {reply['text']}{count}")


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


def send_reply(
    channel: Channel, chat_id: int, path: Path, report: dict, text: str, now: float, mention: Mention | None = None
) -> None:
    """Post ``text`` threaded on the report's first message and record it in ``report.json``."""
    sent = channel.send(report.get("chat_id", chat_id), text, report["message_ids"][0], mention)
    report["replies"].append(
        {"date": datetime.fromtimestamp(now, timezone.utc).isoformat(), "text": sent["text"], "message_id": sent["message_id"]}
    )
    write_json(path / "report.json", report)


def cmd_reply(
    channel: Channel, store: Store, chat_id: int, report_id: str, text: str, now: float, tag: bool = False
) -> None:
    """Answer in the group, threaded on the report's first message; ``tag`` mentions its author."""
    path, report = load_report(store, report_id)
    send_reply(channel, chat_id, path, report, text, now, mention_of(report) if tag else None)
    print(f"replied to {report_id}")


def cmd_edit(
    channel: Channel,
    store: Store,
    chat_id: int,
    report_id: str,
    text: str,
    now: float,
    number: int | None = None,
    tag: bool = False,
) -> None:
    """Rewrite a reply the bot posted on a report: the last one, or the ``number``-th (1-based).

    The new text replaces the recorded one, the previous text goes to the reply's ``edits``.
    Telegram's « message is not modified » is reported, not failed.

    Raises:
        BugsError: On no such reply, a reply without ``message_id``, an empty text, or a Telegram error.
    """
    path, report = load_report(store, report_id)
    replies = report["replies"]
    number = len(replies) if number is None else number
    if not 1 <= number <= len(replies):
        raise BugsError(f"no such reply: {report_id} has {len(replies)} reply(ies), asked for {number}")
    reply = replies[number - 1]
    if not reply.get("message_id"):
        raise BugsError(f"reply {number} of {report_id} has no message_id: it cannot be edited")
    if not text.strip():
        raise BugsError("empty text: nothing to write")
    mention = mention_of(report) if tag else None
    try:
        edited = channel.edit(report.get("chat_id", chat_id), reply["message_id"], text, mention)
    except BugsError as exc:
        if "message is not modified" not in str(exc):
            raise
        print(f"reply {number} of {report_id}: message is not modified")
        return
    reply.setdefault("edits", []).append(
        {"date": datetime.fromtimestamp(now, timezone.utc).isoformat(), "text": reply["text"]}
    )
    reply["text"] = edited["text"]
    write_json(path / "report.json", report)
    print(f"edited reply {number} of {report_id}")


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


def cmd_taken(channel: Channel, store: Store, chat_id: int, report_id: str) -> int:
    """The launcher took the report up: 👨‍💻 reaction, status ``taken``.

    Returns:
        1 if the reaction could not be set (it stays pending), else 0.

    Raises:
        BugsError: If the report is already closed (``fixed`` or ``done``).
    """
    _, report = load_report(store, report_id)
    if report["status"] in CLOSED_STATUSES:
        raise BugsError(f"{report_id} is already {report['status']}")
    _, _, _, failure = move_to(channel, store, chat_id, report_id, "taken", EMOJI_TAKEN)
    print(f"taken {report_id}")
    return say_reaction_pending(channel, failure)


def cmd_fixed(channel: Channel, store: Store, chat_id: int, report_id: str, note: str | None, now: float) -> int:
    """Mark a report fixed: status, 👌 reaction, and an optional note posted as a reply.

    The status is saved before any network call, so a refused reaction leaves the
    report fixed and ``pull`` retries the reaction.

    Returns:
        1 if the reaction could not be set (it stays pending), else 0.
    """
    _, path, report, failure = move_to(channel, store, chat_id, report_id, "fixed", EMOJI_FIXED)
    if note:
        send_reply(channel, chat_id, path, report, f"Corrigé : {note}", now)
    print(f"fixed {report_id}")
    return say_reaction_pending(channel, failure)


def cmd_done(
    channel: Channel | None, store: Store, chat_id: int, report_id: str, reason: str | None, now: float
) -> None:
    """Close a report without a fix; with ``reason``, say why in a reply. No reaction change."""
    path, report = load_report(store, report_id)
    if reason:
        assert channel is not None
        send_reply(channel, chat_id, path, report, reason, now)
    report["status"] = "done"
    write_json(path / "report.json", report)
    print(f"done {report_id}")


def cmd_post(
    channel: Channel, store: Store, chat_id: int, text: str, now: float, mention_report: str | None = None
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


def cmd_backfill_authors(channel: Channel, store: Store, chat_id: int) -> None:
    """Record the user id of authors of reports written before ``author_id`` existed.

    Only when it is proven: the group's members are all administrators (the member count
    equals the administrator list), so a display name matching exactly one human
    administrator can only be that person. Anything else is left alone and said.
    """
    todo = [(rid, path, rep) for rid, path, rep in store.reports() if not rep.get("author_id")]
    if not todo:
        print("no report without an author id")
        return
    admins = channel.list_admins(chat_id)
    everyone_listed = channel.member_count(chat_id) <= len(admins)
    humans = [a["user"] for a in admins if not a["user"].get("is_bot")]
    for report_id, path, report in todo:
        same = [u for u in humans if (u.get("username") or u.get("first_name")) == report["author"]]
        if len(same) == 1 and everyone_listed:
            report["author_id"], report["author_username"] = same[0]["id"], same[0].get("username")
            write_json(path / "report.json", report)
            print(f"{report_id}  author id recorded")
        else:
            why = "several administrators share the name" if len(same) > 1 else (
                "no administrator has that name" if not same else "other members could share the name"
            )
            print(f"{report_id}  not proven, left alone: {why}")
