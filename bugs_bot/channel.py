"""The channel a bot talks through: the interface the rest of the package depends on.

Nothing outside the implementation of a channel names its wire protocol: what it reads arrives
here already normalised (``InboundMessage``, ``Batch``), and ids are ``int | str`` because a
platform may name its chats and messages with strings.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol, TypedDict
from urllib.parse import urlsplit

from bugs_bot.errors import BugsError

# What a transport looks like: (url, json payload or None, timeout=None, headers=None) -> (status, body).
# The timeout is passed only for a held (long-poll) request, otherwise the transport's default applies;
# headers only by a platform that authenticates through them.
Transport = Callable[..., "tuple[int, bytes]"]

# A platform may name its chats and messages with strings (Slack's are).
ChatId = int | str
MessageId = int | str


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
    # True when the platform hands the bot's messages to one reader only: a second poller (``init`` while
    # Pull runs) would steal them, so the chats Pull drops are logged for ``init`` instead.
    exclusive: bool

    def poll(
        self,
        cursor: dict | None,
        chats: list[ChatId],
        timeout: int,
        *,
        threads: Mapping[ChatId, Sequence[MessageId]] | None = None,
    ) -> Batch:
        """Return what arrived since ``cursor`` in ``chats``; the channel may hold the request ``timeout`` seconds.

        ``None`` (or ``{}``) reads from wherever the platform stands. An empty batch returns the cursor given.
        ``threads`` gives, per chat, the first message of each open report: a platform that threads also
        reads the replies posted under them (``thread_of`` set); the others ignore it.
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

    def delete(self, chat_id: ChatId, message_id: MessageId) -> None:
        """Delete a message the bot posted."""
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

    def whoami(self) -> str:
        """Return the bot's name as the platform gives it: the proof its credential is accepted."""
        ...

    @property
    def secret(self) -> str | None:
        """The credential, for masking only."""
        ...


LOOPBACK_HOSTS = ("127.0.0.1", "localhost")


class Body(bytes):
    """A response body that also carries the response's headers (``Retry-After``…), lower-cased."""

    headers: Mapping[str, str] = {}

    def __new__(cls, raw: bytes, headers: Mapping[str, str] | None = None) -> Body:
        body = super().__new__(cls, raw)
        body.headers = {key.lower(): value for key, value in (headers or {}).items()}
        return body


def headers_of(body: bytes) -> Mapping[str, str]:
    """Return the response headers a transport attached to ``body``; ``{}`` when it attached none."""
    return getattr(body, "headers", {}) or {}


def checked_root(env: Mapping[str, str], variable: str, default: str) -> str:
    """Return a platform's API root: ``env[variable]`` when set (the end-to-end run's fake), else ``default``.

    A credential travels with every request built from the root: only ``https://`` and plain-http loopback pass.

    Raises:
        BugsError: If the variable holds any other URL. The message never repeats the value.
    """
    rule = f"{variable} must be an https:// URL or http://127.0.0.1 / http://localhost"
    root = env.get(variable) or default
    try:
        parts = urlsplit(root)
        parts.port  # noqa: B018 - raises ValueError on a malformed port
    except ValueError:
        raise BugsError(rule) from None
    local = parts.scheme == "http" and parts.hostname in LOOPBACK_HOSTS
    if "@" in parts.netloc or not (local or (parts.scheme == "https" and parts.hostname)):
        raise BugsError(rule)
    return root.rstrip("/")
