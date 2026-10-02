"""Telegram samples shaped like real Bot API answers, plus a fake transport.

The shapes follow https://core.telegram.org/bots/api (Update, Message,
PhotoSize, File); ids, names and bytes are invented.
"""

from __future__ import annotations

import json

TOKEN = "123456789:AAFakeTokenFakeTokenFakeTokenFake123"
GROUP_ID = -1001234567890
OTHER_GROUP_ID = -1009999999999
# 2026-10-02 08:30:00 UTC
BASE_DATE = 1790929800


def photo_sizes(tag: str) -> list[dict]:
    """Return three PhotoSize entries, the largest last, as Telegram does."""
    return [
        {"file_id": f"{tag}-s", "file_unique_id": f"u{tag}-s", "file_size": 900, "width": 90, "height": 90},
        {"file_id": f"{tag}-m", "file_unique_id": f"u{tag}-m", "file_size": 9000, "width": 320, "height": 320},
        {"file_id": f"{tag}-l", "file_unique_id": f"u{tag}-l", "file_size": 90000, "width": 1280, "height": 1280},
    ]


def message(
    update_id: int,
    message_id: int,
    *,
    chat_id: int = GROUP_ID,
    title: str = "TM Bugs",
    chat_type: str = "supergroup",
    date: int = BASE_DATE,
    text: str | None = None,
    caption: str | None = None,
    photo: str | None = None,
    media_group_id: str | None = None,
    document: dict | None = None,
) -> dict:
    """Build one ``message`` update."""
    msg: dict = {
        "message_id": message_id,
        "from": {"id": 42, "is_bot": False, "first_name": "Izno", "username": "izno_op"},
        "chat": {"id": chat_id, "title": title, "type": chat_type},
        "date": date,
    }
    if text is not None:
        msg["text"] = text
    if caption is not None:
        msg["caption"] = caption
    if photo is not None:
        msg["photo"] = photo_sizes(photo)
    if media_group_id is not None:
        msg["media_group_id"] = media_group_id
    if document is not None:
        msg["document"] = document
    return {"update_id": update_id, "message": msg}


def image_bytes(file_id: str) -> bytes:
    """Return the fake bytes served for a file id."""
    return b"\xff\xd8\xff-" + file_id.encode()


class FakeTelegram:
    """Injectable transport: ``(url, payload) -> (status, body)``, no network."""

    def __init__(self, updates: list[dict] | None = None) -> None:
        self.updates = updates or []
        self.calls: list[tuple[str, dict | None]] = []
        self.timeouts: list[float | None] = []
        self.fail_download = False
        self.api_error: dict | None = None
        self.raise_on_call: Exception | None = None
        self.sent: list[dict] = []
        self.reactions: list[dict] = []
        self.fail_reaction = False
        self.reaction_error = "Bad Request: REACTION_INVALID"
        self.admins: list[dict] = []
        self.member_count = 0
        self.edited: list[dict] = []
        self.edit_error: str | None = None

    def __call__(self, url: str, payload: dict | None = None, timeout: float | None = None) -> tuple[int, bytes]:
        self.calls.append((url, payload))
        self.timeouts.append(timeout)
        if self.raise_on_call is not None:
            raise self.raise_on_call
        if "/file/bot" in url:
            if self.fail_download:
                return 500, b"boom"
            file_id = url.rsplit("/", 1)[-1].rsplit(".", 1)[0]
            return 200, image_bytes(file_id)
        method = url.rsplit("/", 1)[-1]
        if method == "setMessageReaction":
            if self.fail_reaction:
                body = {"ok": False, "error_code": 400, "description": self.reaction_error}
                return 400, json.dumps(body).encode()
            self.reactions.append(payload)
            return 200, json.dumps({"ok": True, "result": True}).encode()
        if self.api_error is not None:
            return self.api_error["error_code"], json.dumps(self.api_error).encode()
        if method == "getUpdates":
            offset = (payload or {}).get("offset")
            result = [u for u in self.updates if offset is None or u["update_id"] >= offset]
            return 200, json.dumps({"ok": True, "result": result}).encode()
        if method == "getFile":
            file_id = payload["file_id"]
            ext = "png" if file_id.startswith("doc") else "jpg"
            body = {"ok": True, "result": {"file_id": file_id, "file_path": f"photos/{file_id}.{ext}"}}
            return 200, json.dumps(body).encode()
        if method == "getChatAdministrators":
            return 200, json.dumps({"ok": True, "result": self.admins}).encode()
        if method == "getChatMemberCount":
            return 200, json.dumps({"ok": True, "result": self.member_count}).encode()
        if method == "editMessageText":
            if self.edit_error:
                body = {"ok": False, "error_code": 400, "description": self.edit_error}
                return 400, json.dumps(body).encode()
            self.edited.append(payload)
            return 200, json.dumps({"ok": True, "result": {"message_id": payload["message_id"]}}).encode()
        if method == "sendMessage":
            self.sent.append(payload)
            return 200, json.dumps({"ok": True, "result": {"message_id": 777}}).encode()
        return 404, json.dumps({"ok": False, "error_code": 404, "description": "Not Found"}).encode()

    def updates_calls(self) -> list[dict]:
        """Return the payloads of every ``getUpdates`` call."""
        return [p or {} for u, p in self.calls if u.endswith("/getUpdates")]
