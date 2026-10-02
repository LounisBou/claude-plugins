"""The channel a bot talks through: the interface the rest of the package depends on.

Nothing outside the implementation of a channel names its wire protocol: what it reads arrives
here already normalised (``InboundMessage``, ``Batch``), and ids are ``int | str`` because a
platform may name its chats and messages with strings.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol, TypedDict

# What a transport looks like: (url, json payload or None[, read timeout]) -> (status, body).
# The timeout is passed only for a held (long-poll) request; otherwise the transport's default applies.
Transport = Callable[..., "tuple[int, bytes]"]

# A platform may name its chats and messages with strings (Slack's are).
ChatId = int | str
MessageId = int | str

# A bot token's shape (digits, a colon, a secret): hidden even when it is not the token in use.
_BOT_TOKEN_SHAPE = re.compile(r"\d{3,}:[A-Za-z0-9_-]{10,}")


class Mention(TypedDict):
    """Who a message addresses: ``username`` when there is one, else ``name`` tied to ``user_id``."""

    user_id: int | str | None
    username: str | None
    name: str


@dataclass(frozen=True)
class Author:
    """Who wrote a message, as the platform names them."""

    id: int | str | None
    username: str | None
    name: str  # what reports record as ``author``: the username, else the first name
    language: str | None  # the platform's code as given; None when absent
    is_bot: bool


@dataclass(frozen=True)
class Attachment:
    """An image a message carries: the id to download it by, and the extension to save it with."""

    file_id: str
    ext: str


@dataclass(frozen=True)
class InboundMessage:
    """One message of a chat, normalised."""

    chat_id: ChatId  # the chat it was sent in, even when that chat has since migrated
    message_id: MessageId
    date: float  # epoch seconds
    author: Author
    text: str  # text, else caption, else ""
    attachments: tuple[Attachment, ...]
    group_key: str | None  # the media group (Telegram's media_group_id) it belongs to; None when alone
    thread_of: MessageId | None = None  # the thread parent, on a platform that threads; None otherwise


@dataclass(frozen=True)
class Batch:
    """What one read of the channel gives."""

    messages: list[InboundMessage]  # content only: no service message, no bot post
    chats: dict[ChatId, dict]  # every group chat seen, ``{"id", "title", "type"}``; a migrated-away chat is not
    migrations: dict[ChatId, ChatId]  # old -> new chat id, in the order they happened
    cursor: dict  # opaque, the channel's own; reading never moves it, only the caller saving it does


class Channel(Protocol):
    """A group chat the bot reads from and writes to."""

    kind: str

    def poll(self, cursor: dict | None, chats: list[ChatId], timeout: int) -> Batch:
        """Return what arrived since ``cursor`` in ``chats``; the channel may hold the request ``timeout`` seconds.

        ``None`` (or ``{}``) reads from wherever the platform stands. An empty batch returns the cursor given.
        """
        ...

    def send(self, chat_id: ChatId, text: str, reply_to: MessageId | None = None, mention: Mention | None = None) -> dict:
        """Post ``text``, threaded on ``reply_to``; return ``{"message_id": id, "text": str}``.

        ``text`` in the answer is the text as posted: the mention prefix included.
        """
        ...

    def edit(self, chat_id: ChatId, message_id: MessageId, text: str, mention: Mention | None = None) -> dict:
        """Rewrite a posted message; return ``{"message_id": id, "text": str}`` as ``send`` does."""
        ...

    def react(self, chat_id: ChatId, message_id: MessageId, emoji: str) -> None:
        """Put ``emoji`` on a message, replacing the bot's previous reaction."""
        ...

    def get_file(self, file_id: str) -> bytes:
        """Download an attachment."""
        ...

    def list_admins(self, chat_id: ChatId) -> list[Author]:
        """Return the group's administrators, bots included."""
        ...

    def member_count(self, chat_id: ChatId) -> int:
        """Return how many members the group has."""
        ...

    @property
    def secret(self) -> str | None:
        """The credential, for masking only."""
        ...


def mask(text: str, secret: str | None) -> str:
    """Hide the channel's credential, and anything shaped like a bot token, in ``text``.

    Args:
        text: Message about to be shown (an error, a URL...).
        secret: The credential in use, if known.

    Returns:
        ``text`` with every credential replaced by ``<token>``.
    """
    if secret:
        text = text.replace(secret, "<token>")
        # A bot token is "<bot id>:<secret part>": the secret part alone must not show either.
        part = secret.split(":", 1)[-1]
        if part:
            text = text.replace(part, "<token>")
    return _BOT_TOKEN_SHAPE.sub("<token>", text)
