"""Telegram: the Bot API over an injectable transport. The token lives here only."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from bugs_bot.channel import (
    Author, Batch, ChatId, ImagesNotSent, Mention, MessageId, SentImages, Transport, Upload, checked_root, multipart,
)
from bugs_bot.errors import BugsError
from bugs_bot.envfile import read_secret
from bugs_bot.images import wire_file
from bugs_bot.telegram_inbound import ALLOWED_UPDATES, to_author, to_batch

DEFAULT_API_ROOT = "https://api.telegram.org"
# A held getUpdates request is read this much longer than Telegram holds it, so it is never cut.
POLL_READ_MARGIN = 10
# A photo's caption, in UTF-16 code units (the mention included): a longer text is posted before the images.
CAPTION_MAX = 1024


def api_root(env: Mapping[str, str]) -> str:
    """Return the Bot API root: ``BUGS_BOT_API_ROOT`` when set (the end-to-end run's fake), else Telegram's.

    The token travels in every URL built from the root: only ``https://`` and plain-http loopback pass.

    Raises:
        BugsError: If the variable holds any other URL. The message never repeats the value.
    """
    return checked_root(env, "BUGS_BOT_API_ROOT", DEFAULT_API_ROOT)


def read_token(env: Mapping[str, str]) -> str:
    """Read ``TELEGRAM_BOT_TOKEN`` from the ``.env`` file, nowhere else.

    Raises:
        BugsError: If the file or the variable is missing.
    """
    return read_secret(env, "TELEGRAM_BOT_TOKEN")


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

    def call(self, method: str, *, http_timeout: float | None = None, form: Upload | None = None, **params: Any) -> Any:
        """Call a Bot API method and return its ``result``.

        Args:
            method: Method name, e.g. ``getUpdates``.
            http_timeout: Read timeout for a request Telegram holds open (long polling).
            form: A multipart body, sent instead of ``params`` (a file upload).
            **params: JSON parameters.

        Returns:
            The ``result`` member of the answer.

        Raises:
            BugsError: On ``ok: false`` (whatever the HTTP status) or an unreadable answer.
        """
        url = f"{self._root}/bot{self._token}/{method}"
        payload = params if form is None else form
        status, body = self._transport(url, payload) if http_timeout is None else self._transport(url, payload, http_timeout)
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
    exclusive = True  # Telegram hands a bot's updates to one getUpdates consumer
    # A bot token's shape (digits, a colon, a secret): masked in any text, even when it is not the token in use.
    TOKEN_SHAPE = re.compile(r"\d{3,}:[A-Za-z0-9_-]{10,}")

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

    def poll(
        self,
        cursor: dict | None,
        chats: list[ChatId],
        timeout: int,
        *,
        threads: Mapping[ChatId, Sequence[MessageId]] | None = None,
    ) -> Batch:
        """Read the pending updates from ``cursor`` (``{"offset": int | None}``) and normalise them.

        Telegram hands a bot the updates of every chat it is in: ``chats`` does not narrow them, and a reply
        arrives as any message does, so ``threads`` is not needed. Nothing is confirmed to Telegram until a
        later poll is given the returned cursor.
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

    def send_images(
        self, chat_id: ChatId, text: str, paths: list[Path], reply_to: MessageId | None = None, mention: Mention | None = None
    ) -> SentImages:
        """Post images with ``text``: ``sendPhoto`` for one, ``sendMediaGroup`` for several (the caption on the first).

        A caption longer than ``CAPTION_MAX`` is posted first as a message, the images after it on the same thread.

        Raises:
            ImagesNotSent: The text went out first and the images failed, refused or never answered.
            BugsError: Nothing was posted.
        """
        files = [wire_file(path, rank) for rank, path in enumerate(paths, 1)]  # read before anything goes out
        caption, entities = with_mention(mention, text) if mention else (text, [])
        posted = []
        if utf16_len(caption) > CAPTION_MAX:
            posted.append(self.send(chat_id, text, reply_to, mention))
            caption, entities = "", []
        fields = {"chat_id": str(chat_id)}
        if reply_to is not None:
            fields["reply_parameters"] = json.dumps({"message_id": reply_to})
        try:
            if len(files) == 1:
                fields |= {"caption": caption} if caption else {}
                fields |= {"caption_entities": json.dumps(entities)} if entities else {}
                sent = [self._api.call("sendPhoto", form=multipart(fields, [("photo", *files[0])]))]
            else:
                media: list[dict[str, Any]] = [{"type": "photo", "media": f"attach://image{rank}"} for rank in range(1, len(files) + 1)]
                media[0] |= {"caption": caption} if caption else {}
                media[0] |= {"caption_entities": entities} if entities else {}
                fields["media"] = json.dumps(media, ensure_ascii=False)
                sent = self._api.call("sendMediaGroup", form=multipart(fields, [(f"image{rank}", *file) for rank, file in enumerate(files, 1)]))
        except (BugsError, OSError) as exc:  # OSError: the request failed on its way (timeout, reset, unreachable)
            if posted:
                raise ImagesNotSent(f"the text was posted alone, not the images: {exc}", posted[0]) from None
            raise
        message_ids = [message["message_id"] for message in posted + sent]
        return SentImages(posted[0]["text"] if posted else caption, message_ids, [], files)

    def edit(self, chat_id: ChatId, message_id: MessageId, text: str, mention: Mention | None = None) -> dict:
        """Rewrite a posted message; Telegram's « message is not modified » is raised as ``BugsError``."""
        extra: dict[str, Any] = {}
        if mention:
            text, extra["entities"] = with_mention(mention, text)
        self._api.call("editMessageText", chat_id=chat_id, message_id=message_id, text=text, **extra)
        return {"message_id": message_id, "text": text}

    def delete(self, chat_id: ChatId, message_id: MessageId) -> None:
        """Delete a message the bot posted (a bot may delete its own messages in a group)."""
        self._api.call("deleteMessage", chat_id=chat_id, message_id=message_id)

    def delete_file(self, file_id: str) -> None:
        """Telegram's images are messages: there is no file to delete apart from them."""
        raise BugsError(f"no file apart from its message on Telegram: {file_id}")

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

    def whoami(self) -> str:
        """Return the bot's username: ``getMe`` answers only for a valid token."""
        me = self._api.call("getMe")
        return f"@{me.get('username') or me.get('first_name') or me.get('id')}"
