"""The channel a bot talks through: the interface the rest of the package depends on.

Nothing outside the implementation of a channel names its wire protocol: what it reads arrives
here already normalised (``InboundMessage``, ``Batch``), and ids are ``int | str`` because a
platform may name its chats and messages with strings.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, TypedDict
from urllib.parse import urlsplit

from bugs_bot.errors import BugsError

# What a transport looks like: (url, payload, timeout=None, headers=None) -> (status, body); the payload is
# a JSON object, an ``Upload`` (a body that is not JSON: a multipart form, a file's bytes) or None (a GET).
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
    edited: bool = False  # True when this is a new version of a message already sent


@dataclass(frozen=True)
class Batch:
    """What one read of the channel gives."""

    messages: list[InboundMessage]  # content only: no service message, no bot post
    chats: dict[ChatId, dict]  # every group chat seen, ``{"id", "title", "type"}``; a migrated-away chat is not
    migrations: dict[ChatId, ChatId]  # old -> new chat id, in the order they happened
    cursor: dict  # opaque, the channel's own; reading never moves it, only the caller saving it does


@dataclass(frozen=True)
class Upload:
    """A request body that is not JSON: its bytes and their ``Content-Type``."""

    data: bytes
    content_type: str


def _quoted(value: str) -> str:
    """Return ``value`` fit for a quoted header parameter: backslashes and quotes escaped, line breaks dropped."""
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\r", "").replace("\n", "")


def multipart(fields: Mapping[str, str], files: Sequence[tuple[str, str, bytes, str]]) -> Upload:
    """Encode a ``multipart/form-data`` body: text ``fields``, then ``files`` as ``(field, filename, bytes, content type)``.

    The boundary is a fresh random one, drawn again in the unlikely case the content holds it.
    """
    contents = [value.encode() for value in fields.values()] + [data for _, _, data, _ in files]
    boundary = uuid.uuid4().hex
    while any(boundary.encode() in content for content in contents):
        boundary = uuid.uuid4().hex
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{_quoted(name)}"\r\n\r\n'.encode() + value.encode() + b"\r\n"
        for name, value in fields.items()
    ]
    parts += [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{_quoted(name)}"; filename="{_quoted(filename)}"\r\n'
        f"Content-Type: {kind}\r\n\r\n".encode() + data + b"\r\n"
        for name, filename, data, kind in files
    ]
    return Upload(b"".join(parts) + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}")


@dataclass(frozen=True)
class SentImages:
    """What ``send_images`` posted."""

    text: str  # the text as posted (the mention included), "" when there was none
    message_ids: list[MessageId]  # every message posted, in order: the text's first when it went alone
    file_ids: list[str]  # the files shared, on a platform that keeps them apart from messages (Slack); else []
    files: list[tuple[str, bytes, str]]  # each image as read and sent: (name, bytes, content type)


class ImagesNotSent(BugsError):
    """The text of a message with images went out on its own (too long for a caption), and the images failed after it.

    Attributes:
        sent: The text message posted, ``{"message_id", "text"}`` as ``send`` returns it.
    """

    def __init__(self, message: str, sent: dict) -> None:
        super().__init__(message)
        self.sent = sent


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

    def send_images(
        self, chat_id: ChatId, text: str, paths: list[Path], reply_to: MessageId | None = None, mention: Mention | None = None
    ) -> SentImages:
        """Post images (checked already) with ``text``, threaded on ``reply_to``; return what was posted.

        The first message carries the text as its caption when the platform allows one that long; else
        the text is posted first, then the images, on the same thread. Each image is read once, before
        anything goes out: those bytes are the ones sent, and the ones returned.

        Raises:
            ImagesNotSent: The text went out first and the images failed: only it was posted.
            BugsError: Nothing was posted.
        """
        ...

    def edit(self, chat_id: ChatId, message_id: MessageId, text: str, mention: Mention | None = None) -> dict:
        """Rewrite a posted message; return ``{"message_id": id, "text": str}`` as ``send`` does."""
        ...

    def delete(self, chat_id: ChatId, message_id: MessageId) -> None:
        """Delete a message the bot posted."""
        ...

    def delete_file(self, file_id: str) -> None:
        """Delete a file the bot shared, on a platform that keeps files apart from messages (``SentImages.file_ids``)."""
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
