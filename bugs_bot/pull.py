"""Pull: collect the registered groups' messages into each project's reports (one pass, a timed loop, or long polling)."""

from __future__ import annotations

import os
import shutil
import signal
import sys
from collections.abc import Callable, Mapping
from datetime import datetime, timezone

from bugs_bot.channel import Channel, Transport
from bugs_bot.errors import BugsError
from bugs_bot.followup import clear_answered
from bugs_bot.reports import retry_pending_reactions
from bugs_bot.project import PROJECT_FILE, rebind_chat
from bugs_bot.store import CLOSED_STATUSES, EMOJI_SEEN, Machine, Store, write_json
from bugs_bot.registry import Entry
from bugs_bot.telegram import TelegramChannel, api_root, attachments, author_of, group_messages, has_content, mask, read_token

# Long polling (`pull --watch`): the channel holds a request until a message arrives or POLL_TIMEOUT seconds pass.
POLL_TIMEOUT = 50
# A failed watch round waits BACKOFF_FIRST s, doubling up to BACKOFF_CEILING.
BACKOFF_FIRST = 5
BACKOFF_CEILING = 60
# The 30-day purge needs no more than an hourly look.
PURGE_EVERY = 3600
RETENTION_DAYS = 30
# What Telegram is asked to send: it keeps the last setting asked, so every poller asks for the same.
ALLOWED_UPDATES = ("message",)
GROUP_CHAT_TYPES = {"group", "supergroup"}


def build_report(channel: Channel, store: Store, group: list[dict]) -> str | None:
    """Write one report for a message group; return its id, or ``None`` if it already exists.

    The report is built in a hidden temp directory and renamed into place, so a
    reader never sees a half-written one.

    Raises:
        BugsError: If an image cannot be downloaded (the temp directory is removed).
    """
    group = sorted(group, key=lambda m: m["message_id"])
    first = group[0]
    stamp = datetime.fromtimestamp(first["date"], timezone.utc).strftime("%Y%m%d-%H%M%S")
    report_id = f"{stamp}-{first['message_id']}"
    final = store.inbox / report_id
    if final.exists():
        return None  # a retry after a failed pull: already on disk
    tmp = store.inbox / f".{report_id}.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    try:
        images: list[str] = []
        for msg in group:
            for file_id, ext in attachments(msg):
                name = f"{len(images) + 1}{ext}"
                (tmp / name).write_bytes(channel.get_file(file_id))
                images.append(name)
        texts = [t for m in group if (t := m.get("text") or m.get("caption"))]
        write_json(
            tmp / "report.json",
            {
                "id": report_id,
                "chat_id": first["chat"]["id"],
                "message_ids": [m["message_id"] for m in group],
                "media_group_id": first.get("media_group_id"),
                "date": datetime.fromtimestamp(first["date"], timezone.utc).isoformat(),
                "author": author_of(first),
                "author_id": (first.get("from") or {}).get("id"),
                "author_username": (first.get("from") or {}).get("username"),
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


def follow_migrations(machine: Machine, entries: dict[int, Entry], updates: list[dict]) -> dict[int, int]:
    """Re-register the projects whose group was promoted to a supergroup (new chat id), updating ``entries`` in place.

    The project file is rewritten before the registry: a retry after a failure between the two finds it done.

    Returns:
        ``{old: new chat id}`` of every migration in ``updates``, even one already followed (a redelivered
        batch): messages sent before the promotion still carry the old id.

    Raises:
        BugsError: If a project file or the registry cannot be rewritten.
    """
    aliases: dict[int, int] = {}
    for update in updates:
        msg = update.get("message") or {}
        old, new = (msg.get("chat") or {}).get("id"), msg.get("migrate_to_chat_id")
        if not new or old is None:
            continue
        aliases[old] = new
        if old not in entries:
            continue
        entry = entries[old]
        rebind_chat(entry.repo / PROJECT_FILE, new)
        machine.registry.add(new, entry.project, entry.repo)
        entries[new] = entries.pop(old)
        print(f"bugs-bot: group migrated, project {entry.project} rebound to chat {new}")
    return aliases


def cmd_pull(channel: Channel, machine: Machine, now: float, poll_timeout: int = 0, purge: bool = True) -> None:
    """Collect new messages of every registered chat into its project's reports.

    The update offset is machine-wide: it moves past the whole batch, messages of unregistered
    chats included. A report that cannot be built (an image will not download) keeps the offset
    where it is, so the batch is delivered again; the reports of the other projects are written
    all the same and are skipped, not duplicated, on the retry.

    Args:
        channel: The channel. With no project registered the pull still runs: the chats it drops are how ``init`` finds a new group.
        machine: The machine-wide files; the registry says which chat belongs to which project.
        now: Epoch seconds.
        poll_timeout: Seconds Telegram may hold the request waiting for a message (0: answer at once).
        purge: Also delete closed reports past retention.

    Raises:
        BugsError: If a report could not be built, after every other one was (the others go to stderr).
    """
    entries = machine.registry.entries()
    updates = channel.get_updates(machine.load_offset(), poll_timeout, list(ALLOWED_UPDATES))
    aliases = follow_migrations(machine, entries, updates)
    for chat_id, chat in chats_seen(updates).items():
        if chat_id not in entries:
            machine.note_unregistered(chat, now)
            print(f"bugs-bot: unregistered chat {chat_id} {chat.get('title', '')!r} dropped", file=sys.stderr)
    kept: dict[int, list[dict]] = {}
    for update in updates:
        msg = update.get("message") or {}
        chat_id = aliases.get(old := (msg.get("chat") or {}).get("id"), old)
        if chat_id in entries and has_content(msg):
            kept.setdefault(chat_id, []).append(msg)
    created, failures = [], []
    for chat_id, messages in kept.items():
        project = entries[chat_id].project
        for group in group_messages(messages):
            try:
                report_id = build_report(channel, machine.project_store(project), group)
            except BugsError as exc:
                failures.append(exc)
                continue
            if report_id:
                created.append((project, report_id, group))
            # A message answers what its author was asked before it (spec § 3.6). Also when its
            # report is already there: a batch replayed after a crash must still lift the wait.
            first = min(group, key=lambda m: m["message_id"])
            clear_answered(machine.project_store(project), (first.get("from") or {}).get("id"), author_of(first), first["date"])
    if not created and not failures and not poll_timeout:
        print("bugs-bot: no new report")  # a scheduled run leaves a trace in the PM2 log; a held one would flood it
    for project, report_id, group in created:
        images = sum(len(attachments(m)) for m in group)
        print(f"new {report_id} ({images} image{'s' * (images != 1)}) in {project}")
    if failures:
        for exc in failures[1:]:  # the caller says the first one
            print(f"bugs-bot: {mask(str(exc), channel.secret)}", file=sys.stderr)
        raise failures[0]
    if updates:
        # Only now is every kept update on disk: confirming earlier could lose a report.
        machine.save_offset(max(u["update_id"] for u in updates) + 1)
    for chat_id, entry in entries.items():
        store = machine.project_store(entry.project)
        retry_pending_reactions(channel, store, chat_id)
        if purge:
            purge_old_done(store, now)


def chats_seen(updates: list[dict]) -> dict[int, dict]:
    """Return the group chats found in pending updates, by chat id.

    A chat replaced by a migration (its id is some update's ``migrate_to_chat_id``
    or ``migrate_from_chat_id``) is dropped: its id is dead.
    """
    chats: dict[int, dict] = {}
    replaced: set[int] = set()
    for update in updates:
        for key in ("message", "my_chat_member", "channel_post"):
            item = update.get(key) or {}
            chat = item.get("chat")
            if chat and chat.get("type") in GROUP_CHAT_TYPES:
                chats[chat["id"]] = chat
                if item.get("migrate_to_chat_id"):
                    replaced.add(chat["id"])
            if item.get("migrate_from_chat_id"):
                replaced.add(item["migrate_from_chat_id"])
    return {cid: chat for cid, chat in chats.items() if cid not in replaced}


def pull_loop(
    machine: Machine,
    env: Mapping[str, str],
    transport: Transport,
    every: float,
    wall: Callable[[], float],
    sleep: Callable[[float], None],
) -> int:
    """Pull, sleep ``every`` seconds, again, until SIGINT or SIGTERM; a failed round is logged, never fatal.

    This replaces PM2's ``cron_restart``, which fires twice around a boundary and
    kills the run it has just started (measured 2026-10-02 11:00 and 11:15).

    Returns:
        0 once stopped by a signal.
    """

    def stop(*_: object) -> None:
        raise KeyboardInterrupt

    previous = signal.signal(signal.SIGTERM, stop)
    try:
        while True:
            token = None
            try:
                # Read afresh each round: a repaired .env or a new registration needs no restart.
                token = read_token(env)
                cmd_pull(TelegramChannel(token, transport, api_root(env)), machine, wall())
            except Exception as exc:  # noqa: BLE001 - one bad round must not end the loop
                print(f"bugs-bot: {type(exc).__name__}: {mask(str(exc), token)}", file=sys.stderr)
            sys.stdout.flush()
            sleep(every)
    except KeyboardInterrupt:
        print("bugs-bot: stopped")
        return 0
    finally:
        signal.signal(signal.SIGTERM, previous)


def watch_loop(
    machine: Machine,
    env: Mapping[str, str],
    transport: Transport,
    poll_timeout: int,
    wall: Callable[[], float],
    sleep: Callable[[float], None],
    clock: Callable[[], float],
) -> int:
    """Long-poll Telegram until SIGINT or SIGTERM: a message is seen as it arrives.

    Rounds chain with no sleep, Telegram holding each request for ``poll_timeout`` seconds. A failed
    round (network, 5xx, 409) is logged and followed by a backoff growing to ``BACKOFF_CEILING``,
    reset by the next success; it is never fatal. The 30-day purge runs about hourly. A signal
    interrupts the held request itself (the handler raises), so a stop takes no longer than PM2's.

    Returns:
        0 once stopped by a signal.
    """

    def stop(*_: object) -> None:
        raise KeyboardInterrupt

    previous = signal.signal(signal.SIGTERM, stop)
    backoff = 0.0
    last_purge: float | None = None
    try:
        while True:
            token = None
            try:
                # Read afresh each round: a repaired .env or a new registration needs no restart.
                token = read_token(env)
                at = clock()
                purge = last_purge is None or at - last_purge >= PURGE_EVERY
                cmd_pull(TelegramChannel(token, transport, api_root(env)), machine, wall(), poll_timeout, purge)
                if purge:
                    last_purge = at
                backoff = 0.0
            except Exception as exc:  # noqa: BLE001 - one bad round must not end the loop
                print(f"bugs-bot: {type(exc).__name__}: {mask(str(exc), token)}", file=sys.stderr)
                backoff = min(backoff * 2, BACKOFF_CEILING) if backoff else BACKOFF_FIRST
                sys.stdout.flush()
                sleep(backoff)
            sys.stdout.flush()
    except KeyboardInterrupt:
        print("bugs-bot: stopped")
        return 0
    finally:
        signal.signal(signal.SIGTERM, previous)
