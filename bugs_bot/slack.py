"""Slack: the Web API over an injectable transport, read by polling. The token lives here only."""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

from bugs_bot.channel import Author, Batch, ChatId, Mention, MessageId, SentImages, Transport, checked_root, headers_of, multipart
from bugs_bot.envfile import read_secret
from bugs_bot.errors import BugsError, RateLimited
from bugs_bot.images import wire_file
from bugs_bot.slack_inbound import read_chat, to_author

DEFAULT_API_ROOT = "https://slack.com/api"
# The reactions the bot puts, by the names Slack gives the emoji the rest of the package uses.
REACTIONS = {
    "\U0001f440": "eyes",  # 👀 seen
    "\U0001f468‍\U0001f4bb": "male-technologist",  # 👨‍💻 taken
    "\U0001f44c": "ok_hand",  # 👌 fixed
    "✅": "white_check_mark",
}
# Where a file's private URL or an upload URL may lead: the token is sent along, so never to any other host.
FILE_HOSTS = ("slack.com", ".slack.com")
# The phrase reactions.py reads as « the message is gone, stop retrying ».
GONE = "message to react not found"


class Refused(BugsError):
    """Slack answered the call, ``ok: false`` with an error code (HTTP 200): a refusal, not a failure to reach it."""

    def __init__(self, method: str, error: str) -> None:
        super().__init__(f"{method}: {error}")
        self.error = error


def api_root(env: Mapping[str, str]) -> str:
    """Return the Web API root: ``BUGS_BOT_SLACK_API_ROOT`` when set (the end-to-end run's fake), else Slack's.

    Raises:
        BugsError: If the variable holds anything but an https:// or loopback URL.
    """
    return checked_root(env, "BUGS_BOT_SLACK_API_ROOT", DEFAULT_API_ROOT)


def read_token(env: Mapping[str, str]) -> str:
    """Read ``SLACK_BOT_TOKEN`` from the ``.env`` file, nowhere else.

    Raises:
        BugsError: If the file or the variable is missing.
    """
    return read_secret(env, "SLACK_BOT_TOKEN")


def with_mention(mention: Mention, text: str) -> str:
    """Prefix ``text`` with a mention: ``<@U…>`` notifies the person; without a user id, their name as plain text."""
    return f"<@{mention['user_id']}> {text}" if mention["user_id"] else f"@{mention['username'] or mention['name']} {text}"


class SlackChannel:
    """The ``Channel`` over the Slack Web API (a bot token, ``xoxb-…``)."""

    kind = "slack"
    exclusive = False  # every read is a plain request: a second reader takes nothing from Pull
    # A Slack token's shape (bot, app, user): masked in any text, even when it is not the token in use.
    TOKEN_SHAPE = re.compile(r"xox[abp]-[A-Za-z0-9-]+")

    def __init__(
        self, token: str, transport: Transport, root: str = DEFAULT_API_ROOT, clock: Callable[[], float] = time.time
    ) -> None:
        self._token = token
        self._transport = transport
        self._root = root
        self._clock = clock
        self._users: dict[str, Author] = {}

    @property
    def secret(self) -> str:
        """The bot token, for masking only."""
        return self._token

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    def call(self, method: str, *, post: bool = False, **params: Any) -> dict:
        """Call a Web API method and return its answer.

        A read goes as a GET with a query string (Slack's read methods take no JSON body); a write as a
        JSON POST.

        Raises:
            RateLimited: On HTTP 429, carrying the ``Retry-After`` seconds (0 when Slack gave none).
            Refused: On ``ok: false`` with an error code, over HTTP 200.
            BugsError: On any other ``ok: false`` or an unreadable answer.
        """
        if post:
            status, body = self._transport(f"{self._root}/{method}", params, None, self._auth())
        else:
            query = urlencode({key: value for key, value in params.items() if value is not None})
            url = f"{self._root}/{method}" + (f"?{query}" if query else "")
            status, body = self._transport(url, None, None, self._auth())
        if status == 429:
            wait = headers_of(body).get("retry-after", "")
            raise RateLimited(f"{method}: rate limited (HTTP 429), retry after {wait or '?'} s", float(wait) if wait.isdigit() else 0)
        try:
            answer = json.loads(body)
        except ValueError:
            raise BugsError(f"{method}: HTTP {status}, answer is not JSON") from None
        if not isinstance(answer, dict) or not answer.get("ok"):
            error = answer.get("error") if isinstance(answer, dict) else None
            if status == 200 and error:
                raise Refused(method, error)
            raise BugsError(f"{method}: {error or f'HTTP {status}'}")
        return answer

    def _author(self, user_id: str) -> Author:
        """Return a member as an ``Author``, asked once per channel object (a poll round).

        A member Slack will not describe (``user_not_found``, a scope missing…) is named by their id: failing
        would hold the chat's cursor, and every message after theirs, for good.
        """
        if user_id not in self._users:
            try:
                self._users[user_id] = to_author(self.call("users.info", user=user_id, include_locale="true")["user"])
            except Refused:
                self._users[user_id] = to_author({"id": user_id, "name": user_id})
        return self._users[user_id]

    def poll(
        self,
        cursor: dict | None,
        chats: list[ChatId],
        timeout: int,
        *,
        threads: Mapping[ChatId, Sequence[MessageId]] | None = None,
    ) -> Batch:
        """Read each chat of ``chats`` since its cursor, then the replies in the threads of its open reports.

        Slack holds no request: ``timeout`` is ignored, the caller reads again each round. Asked about no
        chat at all (``init`` looking for one), it lists the channels the bot is a member of in ``chats``.
        """
        if not chats:
            return Batch(messages=[], chats=self._memberships(), migrations={}, cursor=dict(cursor or {}))
        moved = {key: dict(value) for key, value in (cursor or {}).items()}
        messages = []
        for chat_id in chats:
            listed = None if threads is None else threads.get(chat_id, [])
            found, moved[str(chat_id)] = read_chat(
                self.call, chat_id, moved.get(str(chat_id)), listed, self._clock(), self._author
            )
            messages += found
        return Batch(messages=messages, chats={}, migrations={}, cursor=moved)

    def _memberships(self) -> dict[ChatId, dict]:
        """Return the channels the bot is a member of, ``{"id", "title", "type"}`` by id."""
        found: dict[ChatId, dict] = {}
        cursor = ""
        while True:
            answer = self.call(
                "users.conversations", types="public_channel,private_channel", exclude_archived="true", limit=200, cursor=cursor or None
            )
            for item in answer.get("channels") or []:
                kind = "private_channel" if item.get("is_private") else "public_channel"
                found[item["id"]] = {"id": item["id"], "title": item.get("name") or "", "type": kind}
            cursor = (answer.get("response_metadata") or {}).get("next_cursor") or ""
            if not cursor:
                return found

    def send(self, chat_id: ChatId, text: str, reply_to: MessageId | None = None, mention: Mention | None = None) -> dict:
        """Post ``text``, in the thread of ``reply_to`` when given; return its ts and the text as posted."""
        if mention:
            text = with_mention(mention, text)
        extra = {} if reply_to is None else {"thread_ts": str(reply_to)}
        sent = self.call("chat.postMessage", post=True, channel=chat_id, text=text, **extra)
        return {"message_id": sent["ts"], "text": text}

    def send_images(
        self, chat_id: ChatId, text: str, paths: list[Path], reply_to: MessageId | None = None, mention: Mention | None = None
    ) -> SentImages:
        """Post images with ``text`` as one message: each file gets an upload URL and is uploaded, then
        ``files.completeUploadExternal`` shares them all, ``text`` as their comment, in ``reply_to``'s thread.

        Nothing is shared until every upload went through: a failed upload posts nothing. Slack does not
        say which message the share became: what was posted is named by its files' ids (``delete_file``).

        Raises:
            BugsError: Nothing was posted.
        """
        if mention:
            text = with_mention(mention, text)
        files, read = [], [wire_file(path, rank) for rank, path in enumerate(paths, 1)]  # read before any upload
        for name, data, kind in read:
            ticket = self.call("files.getUploadURLExternal", filename=name, length=len(data))
            if not self._on_slack(ticket["upload_url"]):
                raise BugsError("upload refused: the URL is not on Slack")
            status, _ = self._transport(ticket["upload_url"], multipart({}, [("filename", name, data, kind)]), None, self._auth())
            if status != 200:
                raise BugsError(f"upload of {name}: HTTP {status}")
            files.append({"id": ticket["file_id"], "title": name})
        extra = {"initial_comment": text} if text else {}
        if reply_to is not None:
            extra["thread_ts"] = str(reply_to)
        self.call("files.completeUploadExternal", post=True, files=files, channel_id=chat_id, **extra)
        return SentImages(text, [], [file["id"] for file in files], read)

    def edit(self, chat_id: ChatId, message_id: MessageId, text: str, mention: Mention | None = None) -> dict:
        """Rewrite a posted message."""
        if mention:
            text = with_mention(mention, text)
        self.call("chat.update", post=True, channel=chat_id, ts=str(message_id), text=text)
        return {"message_id": message_id, "text": text}

    def delete(self, chat_id: ChatId, message_id: MessageId) -> None:
        """Delete a message the bot posted."""
        self.call("chat.delete", post=True, channel=chat_id, ts=str(message_id))

    def delete_file(self, file_id: str) -> None:
        """Delete a file the bot shared: the images of a share go with it."""
        self.call("files.delete", post=True, file=file_id)

    def react(self, chat_id: ChatId, message_id: MessageId, emoji: str) -> None:
        """Put ``emoji`` on a message, taking the bot's other reactions off: it holds one, as on Telegram.

        Raises:
            BugsError: On an emoji with no Slack name here, or a refusal; a message deleted meanwhile says ``GONE``.
        """
        if emoji not in REACTIONS:
            raise BugsError(f"no Slack reaction for {emoji!r}")
        name = REACTIONS[emoji]
        try:
            for other in REACTIONS.values():
                if other != name:
                    self._quietly("reactions.remove", "no_reaction", channel=chat_id, timestamp=str(message_id), name=other)
            self._quietly("reactions.add", "already_reacted", channel=chat_id, timestamp=str(message_id), name=name)
        except BugsError as exc:
            if str(exc).endswith("message_not_found"):
                raise BugsError(f"{exc} ({GONE})") from None
            raise

    def _quietly(self, method: str, harmless: str, **params: Any) -> None:
        """Call a write method, its one harmless refusal (nothing to remove, already there) taken as done."""
        try:
            self.call(method, post=True, **params)
        except RateLimited:
            raise
        except BugsError as exc:
            if not str(exc).endswith(f": {harmless}"):
                raise

    def get_file(self, file_id: str) -> bytes:
        """Download a file by its private URL, the token in the ``Authorization`` header.

        Raises:
            BugsError: If the URL leads anywhere but Slack (or the configured root's host), or the download fails.
        """
        if not self._on_slack(file_id):
            raise BugsError("download refused: the file is not on Slack")
        status, body = self._transport(file_id, None, None, self._auth())
        # Without a valid token Slack answers 200 with its sign-in page, not the file.
        if status != 200 or headers_of(body).get("content-type", "").startswith("text/html"):
            raise BugsError(f"download of a Slack file: HTTP {status}")
        return body

    def _on_slack(self, url: str) -> bool:
        """Tell whether ``url`` leads to Slack (or the configured root's host): only there does the token go."""
        parts, root = urlsplit(url), urlsplit(self._root)
        host = parts.hostname or ""
        on_slack = parts.scheme == "https" and (host == FILE_HOSTS[0] or host.endswith(FILE_HOSTS[1]))
        return (on_slack or (parts.scheme, parts.netloc) == (root.scheme, root.netloc)) and "@" not in parts.netloc

    def list_admins(self, chat_id: ChatId) -> list[Author]:
        """Return the channel's members who are workspace admins or owners."""
        members: list[str] = []
        cursor = ""
        while True:
            answer = self.call("conversations.members", channel=chat_id, limit=200, cursor=cursor or None)
            members += answer.get("members") or []
            cursor = (answer.get("response_metadata") or {}).get("next_cursor") or ""
            if not cursor:
                break
        admins = []
        for user_id in members:
            user = self.call("users.info", user=user_id, include_locale="true")["user"]
            if user.get("is_admin") or user.get("is_owner"):
                admins.append(to_author(user))
        return admins

    def member_count(self, chat_id: ChatId) -> int:
        """Return how many members the channel has."""
        return self.call("conversations.info", channel=chat_id, include_num_members="true")["channel"]["num_members"]

    def whoami(self) -> str:
        """Return the bot's name and workspace: ``auth.test`` answers only for a valid token."""
        me = self.call("auth.test")
        return f"@{me.get('user') or me.get('user_id')} ({me.get('team') or me.get('team_id')})"
