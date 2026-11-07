"""Telegram's updates read into the channel's normalised shape: messages, the chats seen, migrations, the cursor."""

from __future__ import annotations

import mimetypes
from pathlib import Path

from bugs_bot.channel import Attachment, Author, Batch, ChatId, InboundMessage

# What Telegram is asked to send: it keeps the last setting asked, so every poller asks for the same.
# A message's new version (an edit) comes as ``edited_message``.
ALLOWED_UPDATES = ("message", "edited_message")
GROUP_CHAT_TYPES = {"group", "supergroup"}


def to_author(user: dict | None) -> Author:
    """Return a Telegram ``User`` (absent for a message with no sender) as an ``Author``."""
    user = user or {}
    return Author(
        id=user.get("id"),
        username=user.get("username"),
        name=user.get("username") or user.get("first_name") or "",
        language=user.get("language_code"),
        is_bot=bool(user.get("is_bot")),
    )


def _largest_photo(sizes: list[dict]) -> dict:
    """Return the biggest ``PhotoSize`` of a photo."""
    return max(sizes, key=lambda s: (s.get("file_size") or 0, s.get("width", 0) * s.get("height", 0)))


def _attachments(msg: dict) -> tuple[Attachment, ...]:
    """Return each image a message carries: its photo, an image sent as a document."""
    found = []
    if msg.get("photo"):
        found.append(Attachment(_largest_photo(msg["photo"])["file_id"], ".jpg"))
    doc = msg.get("document")
    if doc and str(doc.get("mime_type", "")).startswith("image/"):
        ext = Path(doc.get("file_name") or "").suffix or mimetypes.guess_extension(doc["mime_type"]) or ".img"
        found.append(Attachment(doc["file_id"], ext.lower()))
    return tuple(found)


def _inbound(msg: dict, edited: bool = False) -> InboundMessage | None:
    """Return a message as an ``InboundMessage``; ``None`` for a service message or a bot post.

    An ``edited`` one is the message as now written, dated when it was edited.
    """
    author = to_author(msg.get("from"))
    attachments = _attachments(msg)
    text = msg.get("text") or msg.get("caption") or ""
    chat_id = (msg.get("chat") or {}).get("id")
    if author.is_bot or not (text or attachments) or chat_id is None:
        return None  # the bot's own posts (the group's how-to, replies) and service messages are not reports
    return InboundMessage(
        chat_id=chat_id,
        message_id=msg["message_id"],
        date=float(msg.get("edit_date") or msg["date"]) if edited else float(msg["date"]),
        author=author,
        text=text,
        attachments=attachments,
        group_key=msg.get("media_group_id"),
        edited=edited,
    )


def _chats_seen(updates: list[dict]) -> dict[ChatId, dict]:
    """Return the group chats found in updates, by chat id.

    A chat replaced by a migration (its id is some update's ``migrate_to_chat_id``
    or ``migrate_from_chat_id``) is dropped: its id is dead.
    """
    chats: dict[ChatId, dict] = {}
    replaced: set[ChatId] = set()
    for update in updates:
        for key in ("message", "my_chat_member", "channel_post"):
            item = update.get(key) or {}
            chat = item.get("chat")
            if chat and chat.get("type") in GROUP_CHAT_TYPES:
                chats[chat["id"]] = {"id": chat["id"], "title": chat.get("title", ""), "type": chat["type"]}
                if item.get("migrate_to_chat_id"):
                    replaced.add(chat["id"])
            if item.get("migrate_from_chat_id"):
                replaced.add(item["migrate_from_chat_id"])
    return {cid: chat for cid, chat in chats.items() if cid not in replaced}


def _migrations(updates: list[dict]) -> dict[ChatId, ChatId]:
    """Return ``{old: new chat id}`` of every group promoted to supergroup in ``updates``, in order."""
    found: dict[ChatId, ChatId] = {}
    for update in updates:
        msg = update.get("message") or {}
        old, new = (msg.get("chat") or {}).get("id"), msg.get("migrate_to_chat_id")
        if new and old is not None:
            found[old] = new
    return found


def to_batch(updates: list[dict], cursor: dict | None) -> Batch:
    """Return pending updates as a ``Batch``; its cursor is past the last update, else the one given."""
    messages = []
    for update in updates:
        edited = "edited_message" in update
        inbound = _inbound(update.get("edited_message" if edited else "message") or {}, edited)
        if inbound is not None:
            messages.append(inbound)
    moved = {"offset": max(u["update_id"] for u in updates) + 1} if updates else dict(cursor or {})
    return Batch(messages=messages, chats=_chats_seen(updates), migrations=_migrations(updates), cursor=moved)
