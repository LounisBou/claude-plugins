"""Slack's channel history and thread replies read into the channel's normalised shape, and its cursor moved.

The cursor is ``{"<chat>": {"ts": str, "threads": {"<parent ts>": "<last reply ts>"}, "threads_read": float}}``,
the last key the epoch seconds the threads were last read, absent before. A ``ts`` is
Slack's message id, « seconds.microseconds » as text: it is compared as a ``Decimal``, never as a float,
which would merge two messages of the same second.
"""

from __future__ import annotations

import mimetypes
from collections.abc import Callable, Mapping, Sequence
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from bugs_bot.channel import Attachment, Author, ChatId, InboundMessage, MessageId
from bugs_bot.errors import BugsError

# A message of these subtypes is someone's words (a file shared, a thread reply also sent to the channel);
# every other subtype is a service message (a join, a topic change) or a bot's post.
CONTENT_SUBTYPES = {None, "file_share", "thread_broadcast"}
# Slack escapes these three in message text, and nothing else.
_ESCAPES = (("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&"))
PAGE = 200
# The refusals of a thread whose parent message is gone (deleted): nothing will ever be read there again.
GONE_THREAD = ("thread_not_found", "message_not_found")
# A chat's threads are read at most this often (seconds): one ``conversations.replies`` per open report each
# round would pass Slack's rate limit with a few of them. Its history is read every round.
THREADS_EVERY = 60
# A chat read for the first time is read from this far back, as Telegram keeps a bot's pending updates a day.
FIRST_LOOK_BACK = 86400

Call = Callable[..., Any]


def ts_key(ts: str) -> Decimal:
    """Return a ``ts`` as an exact number, for ordering.

    Raises:
        BugsError: If it is not one (never guessed around: a wrong cursor would replay or lose messages).
    """
    try:
        return Decimal(ts)
    except (InvalidOperation, TypeError):
        raise BugsError(f"slack: not a message ts: {ts!r}") from None


def latest(*stamps: str) -> str:
    """Return the latest of ``stamps``."""
    return max(stamps, key=ts_key)


def to_author(user: Mapping[str, Any]) -> Author:
    """Return a Slack ``user`` object (``users.info``) as an ``Author``; ``language`` is its ``locale`` as given."""
    profile = user.get("profile") or {}
    return Author(
        id=user.get("id"),
        username=user.get("name"),
        name=profile.get("display_name") or profile.get("real_name") or user.get("real_name") or user.get("name") or "",
        language=user.get("locale"),
        is_bot=bool(user.get("is_bot")) or user.get("id") == "USLACKBOT",
    )


def _text(raw: str) -> str:
    for escaped, plain in _ESCAPES:
        raw = raw.replace(escaped, plain)
    return raw


def _attachments(msg: Mapping[str, Any]) -> tuple[Attachment, ...]:
    """Return the images a message carries; the id to download one by is its private URL."""
    found = []
    for item in msg.get("files") or []:
        mimetype = str(item.get("mimetype") or "")
        url = item.get("url_private_download") or item.get("url_private")
        if not mimetype.startswith("image/") or not url:
            continue
        ext = Path(item.get("name") or "").suffix or mimetypes.guess_extension(mimetype) or ".img"
        found.append(Attachment(url, ext.lower()))
    return tuple(found)


def to_inbound(chat_id: ChatId, msg: Mapping[str, Any], author_of: Callable[[str], Author]) -> InboundMessage | None:
    """Return a message as an ``InboundMessage``; ``None`` for a service message or a bot's post.

    A message whose ``thread_ts`` is another message's is a reply in that thread (``thread_of``).
    """
    if msg.get("subtype") not in CONTENT_SUBTYPES or msg.get("bot_id") or not msg.get("user"):
        return None
    text, attachments = _text(msg.get("text") or ""), _attachments(msg)
    if not (text or attachments):
        return None
    author = author_of(msg["user"])
    if author.is_bot:
        return None
    ts, parent = msg["ts"], msg.get("thread_ts")
    return InboundMessage(
        chat_id=chat_id,
        message_id=ts,
        date=float(ts_key(ts)),
        author=author,
        text=text,
        attachments=attachments,
        group_key=None,
        thread_of=parent if parent and parent != ts else None,
    )


def _pages(call: Call, method: str, params: dict) -> list[dict]:
    """Return every message of a paginated read, following ``response_metadata.next_cursor``."""
    messages: list[dict] = []
    cursor = ""
    while True:
        answer = call(method, **params, limit=PAGE, **({"cursor": cursor} if cursor else {}))
        messages += answer.get("messages") or []
        cursor = (answer.get("response_metadata") or {}).get("next_cursor") or ""
        if not cursor:
            return messages


def followed(state: Mapping[str, Any], listed: Sequence[MessageId] | None) -> dict[str, str]:
    """Return the threads to read: those ``listed`` (the open reports), each from its last reply already read.

    A thread not read before starts at its parent; one no longer listed is dropped; ``None`` keeps them all.
    """
    known = dict(state.get("threads") or {})
    if listed is None:
        return known
    return {str(parent): known.get(str(parent), str(parent)) for parent in listed}


def read_chat(
    call: Call, chat_id: ChatId, state: Mapping[str, Any] | None, listed: Sequence[MessageId] | None, now: float,
    author_of: Callable[[str], Author],
) -> tuple[list[InboundMessage], dict]:
    """Read one chat from its cursor ``state``: the messages posted since, then the replies in its threads.

    The threads are read only when ``THREADS_EVERY`` seconds have passed since they last were (``now``).

    Returns:
        ``(messages oldest first, the chat's next cursor)``; the cursor moves past every message read,
        service messages and bots' posts included, so none is read twice.
    """
    state = state or {}
    since = state.get("ts") or f"{now - FIRST_LOOK_BACK:.6f}"
    raw = _pages(call, "conversations.history", {"channel": chat_id, "oldest": since})
    found: list[InboundMessage] = []
    top = since
    for msg in raw:
        top = latest(top, msg["ts"])
        inbound = to_inbound(chat_id, msg, author_of)
        if inbound is not None:
            found.append(inbound)
    threads = followed(state, listed)
    read_at = state.get("threads_read")
    due = bool(threads) and (read_at is None or now - read_at >= THREADS_EVERY)
    for parent, last in list(threads.items()) if due else []:
        try:
            replies = _pages(call, "conversations.replies", {"channel": chat_id, "ts": parent, "oldest": last})
        except BugsError as exc:
            if not str(exc).endswith(tuple(f": {error}" for error in GONE_THREAD)):
                raise
            del threads[parent]  # raising would hold the chat's cursor, and its new messages, for good
            continue
        for msg in replies:
            # The parent comes back with its replies, and ``oldest`` is a bound Slack may include.
            if msg["ts"] == parent or ts_key(msg["ts"]) <= ts_key(last):
                continue
            threads[parent] = latest(threads[parent], msg["ts"])
            inbound = to_inbound(chat_id, msg, author_of)
            if inbound is not None:
                found.append(inbound)
    unique = {m.message_id: m for m in found}  # a reply also sent to the channel is read twice
    ordered = sorted(unique.values(), key=lambda m: ts_key(str(m.message_id)))
    moved: dict[str, Any] = {"ts": top, "threads": threads}
    if due or read_at is not None:
        moved["threads_read"] = now if due else read_at
    return ordered, moved
