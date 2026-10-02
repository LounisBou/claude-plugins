"""Telegram, the one channel: the Bot API over an injectable transport. The token lives here only."""

from __future__ import annotations

import json
import mimetypes
import re
import urllib.error
import urllib.request
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from bugs_bot.channel import Mention, Transport
from bugs_bot.errors import BugsError

DEFAULT_ENV_FILE = Path("/Users/izno/dev/PersonalScraper/.env")
API_ROOT = "https://api.telegram.org"
HTTP_TIMEOUT = 30
# A held getUpdates request is read this much longer than Telegram holds it, so it is never cut.
POLL_READ_MARGIN = 10

_BOT_TOKEN_SHAPE = re.compile(r"\d{3,}:[A-Za-z0-9_-]{10,}")


def mask(text: str, token: str | None) -> str:
    """Hide the bot token, and anything shaped like one, in ``text``.

    Args:
        text: Message about to be shown (an error, a URL...).
        token: The token in use, if known.

    Returns:
        ``text`` with every token replaced by ``<token>``.
    """
    if token:
        text = text.replace(token, "<token>")
        secret = token.split(":", 1)[-1]
        if secret:
            text = text.replace(secret, "<token>")
    return _BOT_TOKEN_SHAPE.sub("<token>", text)


def http_transport(url: str, payload: dict | None = None, timeout: float | None = None) -> tuple[int, bytes]:
    """Send one request with ``urllib``; HTTP errors are returned, not raised.

    Args:
        url: Full URL.
        payload: JSON body (POST) or ``None`` (GET).
        timeout: Read timeout in seconds (default ``HTTP_TIMEOUT``).

    Returns:
        ``(status, body)``.
    """
    data = None if payload is None else json.dumps(payload).encode()
    headers = {} if payload is None else {"Content-Type": "application/json"}
    request = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout or HTTP_TIMEOUT) as resp:  # noqa: S310 - fixed https host
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        # Telegram explains its refusals in the body: keep it for the caller.
        return exc.code, exc.read()


def read_token(env: Mapping[str, str]) -> str:
    """Read ``TELEGRAM_BOT_TOKEN`` from the ``.env`` file, nowhere else.

    Args:
        env: Process environment (only ``TM_BUGS_ENV_FILE`` is consulted).

    Returns:
        The token.

    Raises:
        BugsError: If the file or the variable is missing.
    """
    path = Path(env.get("TM_BUGS_ENV_FILE") or DEFAULT_ENV_FILE)
    try:
        lines = path.read_text().splitlines()
    except OSError as exc:
        raise BugsError(f"cannot read the env file {path}: {exc.strerror}") from None
    for line in lines:
        key, sep, value = line.partition("=")
        if sep and key.strip() == "TELEGRAM_BOT_TOKEN" and value.strip().strip("'\""):
            return value.strip().strip("'\"")
    raise BugsError(f"TELEGRAM_BOT_TOKEN not found in {path}")


def utf16_len(text: str) -> int:
    """Return the length of ``text`` in UTF-16 code units, which is how Telegram counts entities."""
    return len(text.encode("utf-16-le")) // 2


def with_mention(mention: Mention, text: str) -> tuple[str, list[dict]]:
    """Prefix ``text`` with a mention.

    ``@username`` when there is one, else the display name as a ``text_mention`` carrying
    the user id: Telegram notifies the person either way.

    Returns:
        ``(text with the mention, entities)`` for ``sendMessage``.
    """
    if mention["username"]:
        name, entity = f"@{mention['username']}", {"type": "mention"}
    else:
        name, entity = mention["name"], {"type": "text_mention", "user": {"id": mention["user_id"]}}
    return f"{name} {text}", [{**entity, "offset": 0, "length": utf16_len(name)}]


def largest_photo(sizes: list[dict]) -> dict:
    """Return the biggest ``PhotoSize`` of a photo."""
    return max(sizes, key=lambda s: (s.get("file_size") or 0, s.get("width", 0) * s.get("height", 0)))


def attachments(msg: dict) -> list[tuple[str, str]]:
    """Return ``(file_id, extension)`` for each image carried by a message."""
    found = []
    if msg.get("photo"):
        found.append((largest_photo(msg["photo"])["file_id"], ".jpg"))
    doc = msg.get("document")
    if doc and str(doc.get("mime_type", "")).startswith("image/"):
        ext = Path(doc.get("file_name") or "").suffix or mimetypes.guess_extension(doc["mime_type"]) or ".img"
        found.append((doc["file_id"], ext.lower()))
    return found


def has_content(msg: dict) -> bool:
    """Tell a report from a service message (title change, migration...) or a bot post."""
    if (msg.get("from") or {}).get("is_bot"):
        return False  # the bot's own posts (the group's how-to, replies) are not reports
    return bool(msg.get("text") or msg.get("caption") or attachments(msg))


def author_of(msg: dict) -> str:
    """Return the author as Telegram gives it: username, else first name."""
    sender = msg.get("from") or {}
    return sender.get("username") or sender.get("first_name") or ""


def group_messages(messages: list[dict]) -> list[list[dict]]:
    """Group messages by ``media_group_id``; the others stay alone. Order is kept."""
    groups: list[list[dict]] = []
    by_media: dict[str, list[dict]] = {}
    for msg in messages:
        media_id = msg.get("media_group_id")
        if media_id is None:
            groups.append([msg])
        elif media_id in by_media:
            by_media[media_id].append(msg)
        else:
            by_media[media_id] = [msg]
            groups.append(by_media[media_id])
    return groups


class Api:
    """Thin Telegram Bot API client over an injectable transport."""

    def __init__(self, token: str, transport: Transport) -> None:
        self._token = token
        self._transport = transport

    @property
    def token(self) -> str:
        """The token, for masking only."""
        return self._token

    def call(self, method: str, *, http_timeout: float | None = None, **params: Any) -> Any:
        """Call a Bot API method and return its ``result``.

        Args:
            method: Method name, e.g. ``getUpdates``.
            http_timeout: Read timeout for a request Telegram holds open (long polling).
            **params: JSON parameters.

        Returns:
            The ``result`` member of the answer.

        Raises:
            BugsError: On ``ok: false`` (whatever the HTTP status) or an unreadable answer.
        """
        url = f"{API_ROOT}/bot{self._token}/{method}"
        status, body = self._transport(url, params) if http_timeout is None else self._transport(url, params, http_timeout)
        try:
            answer = json.loads(body)
        except ValueError:
            raise BugsError(f"{method}: HTTP {status}, answer is not JSON") from None
        if not answer.get("ok"):
            raise BugsError(f"{method}: {answer.get('description') or f'HTTP {status}'}")
        return answer["result"]

    def download(self, file_id: str) -> bytes:
        """Download a file by id: ``getFile``, then the file URL.

        Args:
            file_id: Telegram file id.

        Returns:
            The file's bytes.

        Raises:
            BugsError: If either step fails.
        """
        file_path = self.call("getFile", file_id=file_id)["file_path"]
        status, body = self._transport(f"{API_ROOT}/file/bot{self._token}/{file_path}", None)
        if status != 200:
            raise BugsError(f"download of {file_id}: HTTP {status}")
        return body


class TelegramChannel:
    """The ``Channel`` over the Bot API."""

    def __init__(self, token: str, transport: Transport) -> None:
        self._api = Api(token, transport)

    @property
    def secret(self) -> str:
        """The bot token, for masking only."""
        return self._api.token

    def get_updates(self, offset: int | None, timeout: int, allowed_updates: list[str] | None = None) -> list[dict]:
        """Fetch pending updates; without ``offset`` Telegram confirms (drops) none of them."""
        params: dict[str, Any] = {"timeout": timeout}
        if allowed_updates is not None:
            params["allowed_updates"] = allowed_updates
        if offset is not None:
            params["offset"] = offset
        held = {"http_timeout": timeout + POLL_READ_MARGIN} if timeout else {}
        return self._api.call("getUpdates", **params, **held)

    def send(self, chat_id: int, text: str, reply_to: int | None = None, mention: Mention | None = None) -> dict:
        """Post ``text``, threaded on ``reply_to`` when given; return the id and the text as posted."""
        extra: dict[str, Any] = {}
        if mention:
            text, extra["entities"] = with_mention(mention, text)
        if reply_to is not None:
            extra["reply_parameters"] = {"message_id": reply_to}
        sent = self._api.call("sendMessage", chat_id=chat_id, text=text, **extra)
        return {"message_id": sent["message_id"], "text": text}

    def edit(self, chat_id: int, message_id: int, text: str, mention: Mention | None = None) -> dict:
        """Rewrite a posted message; Telegram's « message is not modified » is raised as ``BugsError``."""
        extra: dict[str, Any] = {}
        if mention:
            text, extra["entities"] = with_mention(mention, text)
        self._api.call("editMessageText", chat_id=chat_id, message_id=message_id, text=text, **extra)
        return {"message_id": message_id, "text": text}

    def react(self, chat_id: int, message_id: int, emoji: str) -> None:
        """Put ``emoji`` on a message (a bot holds one reaction per message: it replaces the last)."""
        self._api.call(
            "setMessageReaction",
            chat_id=chat_id,
            message_id=message_id,
            reaction=[{"type": "emoji", "emoji": emoji}],
        )

    def get_file(self, file_id: str) -> bytes:
        """Download an attachment by its file id."""
        return self._api.download(file_id)

    def list_admins(self, chat_id: int) -> list[dict]:
        """Return the group's administrators."""
        return self._api.call("getChatAdministrators", chat_id=chat_id)

    def member_count(self, chat_id: int) -> int:
        """Return how many members the group has."""
        return self._api.call("getChatMemberCount", chat_id=chat_id)
