"""Telegram: the Bot API over an injectable transport. The token lives here only."""

from __future__ import annotations

import json
from urllib.parse import urlsplit
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from bugs_bot.channel import Author, Batch, ChatId, Mention, MessageId, Transport
from bugs_bot.errors import BugsError
from bugs_bot.store import bugs_home
from bugs_bot.telegram_inbound import ALLOWED_UPDATES, to_author, to_batch

DEFAULT_API_ROOT = "https://api.telegram.org"
LOOPBACK_HOSTS = ("127.0.0.1", "localhost")
API_ROOT_RULE = "BUGS_BOT_API_ROOT must be an https:// URL or http://127.0.0.1 / http://localhost"
# A held getUpdates request is read this much longer than Telegram holds it, so it is never cut.
POLL_READ_MARGIN = 10


def api_root(env: Mapping[str, str]) -> str:
    """Return the Bot API root: ``BUGS_BOT_API_ROOT`` when set (the end-to-end run's fake), else Telegram's.

    The token travels in every URL built from the root: only ``https://`` and plain-http loopback pass.

    Args:
        env: Process environment (only ``BUGS_BOT_API_ROOT`` is consulted).

    Returns:
        The root, without a trailing slash.

    Raises:
        BugsError: If the variable holds any other URL. The message never repeats the value.
    """
    root = env.get("BUGS_BOT_API_ROOT") or DEFAULT_API_ROOT
    try:
        parts = urlsplit(root)
        parts.port  # noqa: B018 - raises ValueError on a malformed port
    except ValueError:
        raise BugsError(API_ROOT_RULE) from None
    local = parts.scheme == "http" and parts.hostname in LOOPBACK_HOSTS
    if "@" in parts.netloc or not (local or (parts.scheme == "https" and parts.hostname)):
        raise BugsError(API_ROOT_RULE)
    return root.rstrip("/")


def read_token(env: Mapping[str, str]) -> str:
    """Read ``TELEGRAM_BOT_TOKEN`` from the ``.env`` file, nowhere else.

    Args:
        env: Process environment (only ``BUGS_BOT_ENV_FILE`` and ``BUGS_BOT_HOME`` are consulted).

    Returns:
        The token.

    Raises:
        BugsError: If the file or the variable is missing.
    """
    path = Path(env.get("BUGS_BOT_ENV_FILE") or bugs_home(env) / ".env")
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


class Api:
    """Thin Telegram Bot API client over an injectable transport."""

    def __init__(self, token: str, transport: Transport, root: str = DEFAULT_API_ROOT) -> None:
        self._token = token
        self._transport = transport
        self._root = root

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
        url = f"{self._root}/bot{self._token}/{method}"
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
        status, body = self._transport(f"{self._root}/file/bot{self._token}/{file_path}", None)
        if status != 200:
            raise BugsError(f"download of {file_id}: HTTP {status}")
        return body


class TelegramChannel:
    """The ``Channel`` over the Bot API."""

    kind = "telegram"

    def __init__(self, token: str, transport: Transport, root: str = DEFAULT_API_ROOT) -> None:
        self._api = Api(token, transport, root)

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

    def poll(self, cursor: dict | None, chats: list[ChatId], timeout: int) -> Batch:
        """Read the pending updates from ``cursor`` (``{"offset": int | None}``) and normalise them.

        Telegram hands a bot the updates of every chat it is in: ``chats`` does not narrow them. Nothing is
        confirmed to Telegram until a later poll is given the returned cursor.
        """
        updates = self.get_updates((cursor or {}).get("offset"), timeout, list(ALLOWED_UPDATES))
        return to_batch(updates, cursor)

    def send(self, chat_id: ChatId, text: str, reply_to: MessageId | None = None, mention: Mention | None = None) -> dict:
        """Post ``text``, threaded on ``reply_to`` when given; return the id and the text as posted."""
        extra: dict[str, Any] = {}
        if mention:
            text, extra["entities"] = with_mention(mention, text)
        if reply_to is not None:
            extra["reply_parameters"] = {"message_id": reply_to}
        sent = self._api.call("sendMessage", chat_id=chat_id, text=text, **extra)
        return {"message_id": sent["message_id"], "text": text}

    def edit(self, chat_id: ChatId, message_id: MessageId, text: str, mention: Mention | None = None) -> dict:
        """Rewrite a posted message; Telegram's « message is not modified » is raised as ``BugsError``."""
        extra: dict[str, Any] = {}
        if mention:
            text, extra["entities"] = with_mention(mention, text)
        self._api.call("editMessageText", chat_id=chat_id, message_id=message_id, text=text, **extra)
        return {"message_id": message_id, "text": text}

    def react(self, chat_id: ChatId, message_id: MessageId, emoji: str) -> None:
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

    def list_admins(self, chat_id: ChatId) -> list[Author]:
        """Return the group's administrators, bots included."""
        return [to_author(member.get("user")) for member in self._api.call("getChatAdministrators", chat_id=chat_id)]

    def member_count(self, chat_id: ChatId) -> int:
        """Return how many members the group has."""
        return self._api.call("getChatMemberCount", chat_id=chat_id)
