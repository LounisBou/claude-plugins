"""The channel a bot talks through: the interface the rest of the package depends on.

Nothing outside the implementation of a channel names its wire protocol.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol, TypedDict

# What a transport looks like: (url, json payload or None[, read timeout]) -> (status, body).
# The timeout is passed only for a held (long-poll) request; otherwise the transport's default applies.
Transport = Callable[..., "tuple[int, bytes]"]


class Mention(TypedDict):
    """Who a message addresses: ``username`` when there is one, else ``name`` tied to ``user_id``."""

    user_id: int | None
    username: str | None
    name: str


class Channel(Protocol):
    """A group chat the bot reads from and writes to."""

    def get_updates(self, offset: int | None, timeout: int, allowed_updates: list[str] | None = None) -> list[dict]:
        """Return the pending updates; the channel holds the request up to ``timeout`` seconds."""
        ...

    def send(self, chat_id: int, text: str, reply_to: int | None = None, mention: Mention | None = None) -> dict:
        """Post ``text``, threaded on ``reply_to``; return ``{"message_id": int, "text": str}``.

        ``text`` in the answer is the text as posted: the mention prefix included.
        """
        ...

    def edit(self, chat_id: int, message_id: int, text: str, mention: Mention | None = None) -> dict:
        """Rewrite a posted message; return ``{"message_id": int, "text": str}`` as ``send`` does."""
        ...

    def react(self, chat_id: int, message_id: int, emoji: str) -> None:
        """Put ``emoji`` on a message, replacing the bot's previous reaction."""
        ...

    def get_file(self, file_id: str) -> bytes:
        """Download an attachment."""
        ...

    def list_admins(self, chat_id: int) -> list[dict]:
        """Return the group's administrators."""
        ...

    def member_count(self, chat_id: int) -> int:
        """Return how many members the group has."""
        ...

    @property
    def secret(self) -> str | None:
        """The credential, for masking only."""
        ...
