"""Pull: collect the registered groups' messages into each project's reports (one pass, a timed loop, or long polling)."""

from __future__ import annotations

import os
import shutil
import sys
from datetime import datetime, timezone

from bugs_bot.answers import record_answer
from bugs_bot.channel import Channel, ChatId, InboundMessage, MessageId
from bugs_bot.channels import mask
from bugs_bot.errors import BugsError
from bugs_bot.followup import clear_answered
from bugs_bot.people import record_language
from bugs_bot.reactions import retry_pending_reactions
from bugs_bot.project import PROJECT_FILE, rebind_chat
from bugs_bot.store import CLOSED_STATUSES, EMOJI_SEEN, Machine, Store, write_json
from bugs_bot.registry import Entry

# Long polling (`pull --watch`): the channel holds a request until a message arrives or POLL_TIMEOUT seconds pass.
POLL_TIMEOUT = 50
RETENTION_DAYS = 30


def group_messages(messages: list[InboundMessage]) -> list[list[InboundMessage]]:
    """Group messages by media group; the others stay alone. Order is kept."""
    groups: list[list[InboundMessage]] = []
    by_key: dict[str, list[InboundMessage]] = {}
    for msg in messages:
        if msg.group_key is None:
            groups.append([msg])
        elif msg.group_key in by_key:
            by_key[msg.group_key].append(msg)
        else:
            by_key[msg.group_key] = [msg]
            groups.append(by_key[msg.group_key])
    return groups


def in_order(msg: InboundMessage) -> tuple[float, MessageId]:
    """Return the sort key of a message: its date, then its id (ids alone may be text, which sorts lexically)."""
    return msg.date, msg.message_id


def build_report(channel: Channel, store: Store, group: list[InboundMessage]) -> str | None:
    """Write one report for a message group; return its id, or ``None`` if it already exists.

    The report is built in a hidden temp directory and renamed into place, so a
    reader never sees a half-written one.

    Raises:
        BugsError: If an image cannot be downloaded (the temp directory is removed).
    """
    group = sorted(group, key=in_order)
    first = group[0]
    stamp = datetime.fromtimestamp(first.date, timezone.utc).strftime("%Y%m%d-%H%M%S")
    # An id is a directory name: a message id such as Slack's "1790929800.000100" loses its dot.
    report_id = f"{stamp}-{first.message_id}".replace(".", "-")
    final = store.inbox / report_id
    if final.exists():
        return None  # a retry after a failed pull: already on disk
    tmp = store.inbox / f".{report_id}.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    try:
        images: list[str] = []
        for msg in group:
            for attachment in msg.attachments:
                name = f"{len(images) + 1}{attachment.ext}"
                (tmp / name).write_bytes(channel.get_file(attachment.file_id))
                images.append(name)
        texts = [m.text for m in group if m.text]
        write_json(
            tmp / "report.json",
            {
                "id": report_id,
                "chat_id": first.chat_id,
                "message_ids": [m.message_id for m in group],
                "media_group_id": first.group_key,  # the stored key keeps its first name
                "date": datetime.fromtimestamp(first.date, timezone.utc).isoformat(),
                "author": first.author.name,
                "author_id": first.author.id,
                "author_username": first.author.username,
                "text": "\n".join(texts),
                "images": images,
                "status": "seen",
                "reaction": {"wanted": EMOJI_SEEN, "applied": None, "error": None},
                "replies": [],
            },
        )
        os.replace(tmp, final)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return report_id


def purge_old_done(store: Store, now: float) -> None:
    """Delete closed (``done``/``fixed``) reports older than the retention period."""
    for _, path, report in store.reports():
        if report.get("status") not in CLOSED_STATUSES:
            continue
        age = now - datetime.fromisoformat(report["date"]).timestamp()
        if age > RETENTION_DAYS * 86400:
            shutil.rmtree(path)


def follow_migrations(machine: Machine, kind: str, entries: dict[ChatId, Entry], migrations: dict[ChatId, ChatId]) -> None:
    """Re-register the projects whose group was promoted to a supergroup (new chat id), updating ``entries`` in place.

    The project file is rewritten before the registry: a retry after a failure between the two finds it done.
    A migration already followed (a redelivered batch) finds its old id gone and is skipped.

    Raises:
        BugsError: If a project file or the registry cannot be rewritten.
    """
    for old, new in migrations.items():
        if old not in entries:
            continue
        entry = entries[old]
        rebind_chat(entry.repo / PROJECT_FILE, new)
        machine.registry.add(kind, new, entry.project, entry.repo)
        entries[new] = entries.pop(old)
        print(f"bugs-bot: group migrated, project {entry.project} rebound to chat {new}")


def open_threads(machine: Machine, entries: dict[ChatId, Entry]) -> dict[ChatId, list[MessageId]]:
    """Return, per chat, the first message of each report not ``done``: the threads a platform that threads reads replies in.

    A ``fixed`` report is still followed: the person is asked to check the fix there, and answers there.
    """
    threads: dict[ChatId, list[MessageId]] = {}
    for chat_id, entry in entries.items():
        reports = machine.project_store(entry.project).reports()
        threads[chat_id] = [
            report["message_ids"][0]
            for _, _, report in reports
            if report["status"] != "done" and report.get("chat_id", chat_id) == chat_id and report.get("message_ids")
        ]
    return threads


def cmd_pull(
    channel: Channel,
    machine: Machine,
    now: float,
    poll_timeout: int = 0,
    purge: bool = True,
    chats: list[ChatId] | None = None,
    quiet: bool = False,
) -> None:
    """Collect new messages of every registered chat of the channel into its project's reports.

    The channel's cursor is machine-wide: it moves past the whole batch, messages of unregistered
    chats included. A report that cannot be built (an image will not download) keeps the cursor
    where it is, so the batch is delivered again; the reports of the other projects are written
    all the same and are skipped, not duplicated, on the retry. A reply in a report's thread is an
    answer recorded on that report, never a report of its own.

    Args:
        channel: The channel. With no project registered the pull still runs: the chats it drops are how ``init`` finds a new group.
        machine: The machine-wide files; the registry says which chat belongs to which project.
        now: Epoch seconds.
        poll_timeout: Seconds the channel may hold the request waiting for a message (0: answer at once).
        purge: Also delete closed reports past retention.
        chats: Only these chats of the channel (default: every registered one).
        quiet: Print no « no new report » line (a loop of rounds would print it every round).

    Raises:
        BugsError: If a report could not be built, after every other one was (the others go to stderr).
    """
    entries = {
        chat_id: entry
        for (kind, chat_id), entry in machine.registry.entries().items()
        if kind == channel.kind and (chats is None or chat_id in chats)
    }
    cursor = machine.load_cursor(channel.kind)
    batch = channel.poll(cursor, list(entries), poll_timeout, threads=open_threads(machine, entries))
    follow_migrations(machine, channel.kind, entries, batch.migrations)
    for chat_id, chat in batch.chats.items():
        if chat_id not in entries:
            machine.note_unregistered(chat, now)
            print(f"bugs-bot: unregistered chat {chat_id} {chat.get('title', '')!r} dropped", file=sys.stderr)
    kept: dict[ChatId, list[InboundMessage]] = {}
    for msg in batch.messages:
        # Messages sent before a promotion still carry the old id.
        chat_id = batch.migrations.get(msg.chat_id, msg.chat_id)
        if chat_id in entries:
            kept.setdefault(chat_id, []).append(msg)
    created, answers, failures = [], [], []
    for chat_id, messages in kept.items():
        project = entries[chat_id].project
        store = machine.project_store(project)
        for msg in messages:
            # The platform's language of each author, on first sight: what the agent writes to them in (spec § 3.5).
            record_language(store, msg.author)
        for group in group_messages([m for m in messages if m.thread_of is None]):
            try:
                report_id = build_report(channel, store, group)
            except BugsError as exc:
                failures.append(exc)
                continue
            if report_id:
                created.append((project, report_id, group))
            # A message answers what its author was asked before it (spec § 3.6). Also when its
            # report is already there: a batch replayed after a crash must still lift the wait.
            first = min(group, key=in_order)
            clear_answered(store, first.author.id, first.author.name, first.date)
        # After the reports: a thread opened on a report of this very batch finds it.
        for msg in sorted((m for m in messages if m.thread_of is not None), key=in_order):
            try:
                answered = record_answer(channel, store, chat_id, msg)
            except BugsError as exc:
                failures.append(exc)
                continue
            if answered:
                answers.append((project, answered))
            clear_answered(store, msg.author.id, msg.author.name, msg.date)
    if not created and not answers and not failures and not quiet:
        print("bugs-bot: no new report")  # a scheduled run leaves a trace in the PM2 log
    for project, report_id, group in created:
        images = sum(len(m.attachments) for m in group)
        print(f"new {report_id} ({images} image{'s' * (images != 1)}) in {project}")
    for project, report_id in answers:
        print(f"answer on {report_id} in {project}")
    if failures:
        for exc in failures[1:]:  # the caller says the first one
            print(f"bugs-bot: {mask(str(exc), channel.secret)}", file=sys.stderr)
        raise failures[0]
    if batch.cursor != (cursor or {}):
        # Only now is every kept message on disk: moving the cursor earlier could lose a report.
        machine.save_cursor(channel.kind, batch.cursor)
    for chat_id, entry in entries.items():
        store = machine.project_store(entry.project)
        retry_pending_reactions(channel, store, chat_id)
        if purge:
            purge_old_done(store, now)
