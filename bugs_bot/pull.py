"""Pull: collect the group's messages into reports (one pass, a timed loop, or long polling)."""

from __future__ import annotations

import os
import shutil
import signal
import sys
from collections.abc import Callable, Mapping
from datetime import datetime, timezone

from bugs_bot.channel import Channel, Transport
from bugs_bot.errors import BugsError
from bugs_bot.reports import retry_pending_reactions
from bugs_bot.store import CLOSED_STATUSES, EMOJI_SEEN, Store, write_json
from bugs_bot.telegram import TelegramChannel, attachments, author_of, group_messages, has_content, mask, read_token

GROUP_TITLE = "TM Bugs"
# Long polling (`pull --watch`): the channel holds a request until a message arrives or
# POLL_TIMEOUT seconds pass.
POLL_TIMEOUT = 50
# A failed watch round waits BACKOFF_FIRST s, doubling up to BACKOFF_CEILING; unbound, it waits UNBOUND_WAIT.
BACKOFF_FIRST = 5
BACKOFF_CEILING = 60
UNBOUND_WAIT = 30
# The 30-day purge needs no more than an hourly look.
PURGE_EVERY = 3600
RETENTION_DAYS = 30
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


def cmd_pull(channel: Channel, store: Store, now: float, poll_timeout: int = 0, purge: bool = True) -> None:
    """Collect new messages of the bound chat into reports.

    Args:
        channel: The group's channel (``None`` is accepted while unbound: nothing is fetched).
        store: The inbox.
        now: Epoch seconds.
        poll_timeout: Seconds Telegram may hold the request waiting for a message (0: answer at once).
        purge: Also delete closed reports past retention.
    """
    state = store.load_state()
    if "chat_id" not in state:
        print("tm-bugs: unbound — run `tm_bugs.py bind` after posting in the group")
        return
    updates = channel.get_updates(state.get("offset"), poll_timeout, ["message"])
    for update in updates:
        msg = update.get("message") or {}
        # A group promoted to supergroup gets a new chat id: follow it.
        if msg.get("chat", {}).get("id") == state["chat_id"] and msg.get("migrate_to_chat_id"):
            state["chat_id"] = msg["migrate_to_chat_id"]
            print(f"tm-bugs: group migrated, rebound to chat {state['chat_id']}")
    kept = [
        u["message"]
        for u in updates
        if u.get("message", {}).get("chat", {}).get("id") == state["chat_id"] and has_content(u["message"])
    ]
    created = []
    for group in group_messages(kept):
        report_id = build_report(channel, store, group)
        if report_id:
            created.append((report_id, group))
    if updates:
        # Only now is every kept update on disk: confirming earlier could lose a report.
        state["offset"] = max(u["update_id"] for u in updates) + 1
        store.save_state(state)
    if not created and not poll_timeout:
        print("tm-bugs: no new report")  # a scheduled run leaves a trace in the PM2 log; a held one would flood it
    for report_id, group in created:
        images = sum(len(attachments(m)) for m in group)
        print(f"new {report_id} ({images} image{'s' * (images != 1)})")
    retry_pending_reactions(channel, store, state["chat_id"])
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


def cmd_bind(channel: Channel, store: Store) -> int:
    """List the group chats seen in pending updates and bind « TM Bugs »."""
    # No offset: Telegram only confirms (drops) updates when one is passed.
    updates = channel.get_updates(None, 0, ["message", "my_chat_member"])
    chats = chats_seen(updates)
    for chat_id, chat in chats.items():
        print(f"{chat['type']}  {chat_id}  {chat.get('title', '')!r}")
    if not chats:
        print("no group chat in the pending updates")
    matches = [cid for cid, chat in chats.items() if chat.get("title") == GROUP_TITLE]
    if not matches:
        print(f"no group titled exactly {GROUP_TITLE!r}: post a message in it, then retry", file=sys.stderr)
        return 1
    if len(matches) > 1:
        print(f"several groups titled {GROUP_TITLE!r}: refusing to guess", file=sys.stderr)
        return 1
    state = store.load_state()
    state["chat_id"] = matches[0]
    state.setdefault("offset", None)
    store.save_state(state)
    print(f"bound {GROUP_TITLE!r} ({matches[0]})")
    return 0


def pull_loop(
    store: Store,
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
                # Read afresh each round: a repaired .env or a new bind needs no restart.
                token = read_token(env) if "chat_id" in store.load_state() else None
                cmd_pull(TelegramChannel(token, transport) if token else None, store, wall())  # type: ignore[arg-type]
            except Exception as exc:  # noqa: BLE001 - one bad round must not end the loop
                print(f"tm-bugs: {type(exc).__name__}: {mask(str(exc), token)}", file=sys.stderr)
            sys.stdout.flush()
            sleep(every)
    except KeyboardInterrupt:
        print("tm-bugs: stopped")
        return 0
    finally:
        signal.signal(signal.SIGTERM, previous)


def watch_loop(
    store: Store,
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
                # Read afresh each round: a repaired .env or a new bind needs no restart.
                if "chat_id" not in store.load_state():
                    sys.stdout.flush()
                    sleep(UNBOUND_WAIT)  # nothing to hold yet: do not spin
                    continue
                token = read_token(env)
                at = clock()
                purge = last_purge is None or at - last_purge >= PURGE_EVERY
                cmd_pull(TelegramChannel(token, transport), store, wall(), poll_timeout, purge)
                if purge:
                    last_purge = at
                backoff = 0.0
            except Exception as exc:  # noqa: BLE001 - one bad round must not end the loop
                print(f"tm-bugs: {type(exc).__name__}: {mask(str(exc), token)}", file=sys.stderr)
                backoff = min(backoff * 2, BACKOFF_CEILING) if backoff else BACKOFF_FIRST
                sys.stdout.flush()
                sleep(backoff)
            sys.stdout.flush()
    except KeyboardInterrupt:
        print("tm-bugs: stopped")
        return 0
    finally:
        signal.signal(signal.SIGTERM, previous)
