"""A ``Channel`` with no transport: batches handed over as given, every call recorded."""

from __future__ import annotations

from bugs_bot.channel import Author, Batch, ChatId, InboundMessage, Mention, MessageId, SentImages
from bugs_bot.errors import BugsError
from bugs_bot.images import wire_file

SECRET = "fake-channel-secret"


def author(id: int | str | None = 42, username: str | None = "izno_op", name: str | None = None, **rest) -> Author:
    """Return an author; ``name`` defaults to the username, as Telegram's is."""
    return Author(id=id, username=username, name=name if name is not None else username or "", language=rest.get("language"), is_bot=rest.get("is_bot", False))


def inbound(chat_id: ChatId, message_id: MessageId, text: str = "", *, date: float = 1790929800.0, **rest) -> InboundMessage:
    """Return one normalised message; ``rest`` sets ``author``, ``attachments``, ``group_key``, ``thread_of``, ``edited``."""
    return InboundMessage(
        chat_id=chat_id,
        message_id=message_id,
        date=date,
        author=rest.get("author") or author(),
        text=text,
        attachments=tuple(rest.get("attachments", ())),
        group_key=rest.get("group_key"),
        thread_of=rest.get("thread_of"),
        edited=rest.get("edited", False),
    )


def batch(*messages: InboundMessage, chats: dict | None = None, migrations: dict | None = None, cursor: dict | None = None) -> Batch:
    """Return a batch; the chats default to those of ``messages``, the cursor to ``{"offset": <count>}``."""
    seen = {m.chat_id: {"id": m.chat_id, "title": f"chat {m.chat_id}", "type": "supergroup"} for m in messages}
    return Batch(
        messages=list(messages),
        chats=seen if chats is None else chats,
        migrations=migrations or {},
        cursor=cursor if cursor is not None else {"offset": len(messages)},
    )


class FakeChannel:
    """Implements ``Channel``: ``poll`` hands out ``batches`` in turn, then empty ones keeping the cursor."""

    # The machine keeps cursors by kind: the fake stands in for Telegram, whose cursor is {"offset": int}.
    kind = "telegram"
    exclusive = True

    def __init__(self, *batches: Batch, kind: str = "telegram") -> None:
        self.kind = kind
        self.exclusive = kind == "telegram"
        self.batches = list(batches)
        self.polls: list[tuple[dict | None, list, int]] = []
        self.threads: list[dict | None] = []  # what each poll was given as ``threads``
        self.calls: list[tuple] = []
        self.files: dict[str, bytes] = {}
        self.fail_files: set[str] = set()
        self.admins: list[Author] = []
        self.members = 0

    @property
    def secret(self) -> str:
        return SECRET

    def poll(self, cursor: dict | None, chats: list, timeout: int, *, threads: dict | None = None) -> Batch:
        self.polls.append((cursor, list(chats), timeout))
        self.threads.append(None if threads is None else {chat: list(ids) for chat, ids in threads.items()})
        if self.batches:
            return self.batches.pop(0)
        return Batch(messages=[], chats={}, migrations={}, cursor=cursor or {})

    def send(self, chat_id: ChatId, text: str, reply_to: MessageId | None = None, mention: Mention | None = None) -> dict:
        self.calls.append(("send", chat_id, text, reply_to, mention))
        return {"message_id": 900 + len(self.calls), "text": text}

    def send_images(self, chat_id: ChatId, text: str, paths: list, reply_to: MessageId | None = None, mention: Mention | None = None) -> SentImages:
        self.calls.append(("send_images", chat_id, text, list(paths), reply_to, mention))
        files = [wire_file(path, rank) for rank, path in enumerate(paths, 1)]
        return SentImages(text, [900 + len(self.calls) + k for k in range(len(paths))], [], files)

    def edit(self, chat_id: ChatId, message_id: MessageId, text: str, mention: Mention | None = None) -> dict:
        self.calls.append(("edit", chat_id, message_id, text, mention))
        return {"message_id": message_id, "text": text}

    def delete(self, chat_id: ChatId, message_id: MessageId) -> None:
        self.calls.append(("delete", chat_id, message_id))

    def delete_file(self, file_id: str) -> None:
        self.calls.append(("delete_file", file_id))

    def react(self, chat_id: ChatId, message_id: MessageId, emoji: str) -> None:
        self.calls.append(("react", chat_id, message_id, emoji))

    def get_file(self, file_id: str) -> bytes:
        self.calls.append(("get_file", file_id))
        if file_id in self.fail_files:
            raise BugsError(f"download of {file_id}: refused")
        return self.files.get(file_id, b"bytes of " + file_id.encode())

    def list_admins(self, chat_id: ChatId) -> list[Author]:
        self.calls.append(("list_admins", chat_id))
        return self.admins

    def member_count(self, chat_id: ChatId) -> int:
        self.calls.append(("member_count", chat_id))
        return self.members

    def whoami(self) -> str:
        self.calls.append(("whoami",))
        return "@fake_bot"

    def of(self, name: str) -> list[tuple]:
        """Return the recorded calls of one method."""
        return [call for call in self.calls if call[0] == name]
