"""A fake Slack Web API transport: canned answers per method, every request recorded."""

from __future__ import annotations

import json
from urllib.parse import parse_qsl, urlsplit

from bugs_bot.channel import Body

SLACK_TOKEN = "xoxb-1111-2222-FakeSlackTokenValue"
ROOT = "https://slack.com/api"
CHANNEL = "C0FAKE01"
BASE_TS = 1790929800  # 2026-10-02 08:30 UTC, as samples.BASE_DATE


def ts(seconds: int, micro: int = 100) -> str:
    """Return a Slack ``ts`` ``seconds`` after ``BASE_TS``."""
    return f"{BASE_TS + seconds}.{micro:06d}"


def user(user_id: str, name: str, **rest) -> dict:
    """Return a ``users.info`` user object."""
    return {
        "id": user_id,
        "name": name,
        "real_name": rest.get("real_name", name.title()),
        "profile": {"display_name": rest.get("display_name", ""), "real_name": rest.get("real_name", name.title())},
        "is_bot": rest.get("is_bot", False),
        "locale": rest.get("locale", "fr-FR"),
        "is_admin": rest.get("is_admin", False),
        "is_owner": rest.get("is_owner", False),
    }


def msg(stamp: str, text: str = "", user_id: str = "U0ANA", **rest) -> dict:
    """Return a message as ``conversations.history`` gives it."""
    found = {"type": "message", "ts": stamp, "user": user_id, "text": text}
    found.update(rest)
    return found


class FakeSlack:
    """A transport: ``(url, payload, timeout, headers) -> (status, body)``.

    ``history[chat]`` holds the channel's messages (oldest first, served newest first as Slack does),
    ``replies[(chat, parent)]`` a thread's replies. Any method can be given a canned answer in
    ``answers[method]`` (a dict, or a list served in turn), or an HTTP status in ``statuses[method]``.
    """

    def __init__(self, token: str = SLACK_TOKEN) -> None:
        self.token = token
        self.calls: list[dict] = []
        self.history: dict[str, list[dict]] = {}
        self.replies: dict[tuple[str, str], list[dict]] = {}
        self.users: dict[str, dict] = {"U0ANA": user("U0ANA", "ana"), "U0BOB": user("U0BOB", "bob", locale="en-US")}
        self.answers: dict[str, object] = {}
        self.statuses: dict[str, tuple[int, dict]] = {}
        self.files: dict[str, bytes] = {}
        self.next_ts = [BASE_TS + 5000]
        self.uploads: list[dict] = []  # each POST to an upload URL: its URL and body
        self.upload_status: dict[int, int] = {}  # the n-th upload (1-based) answered with this HTTP status

    def methods(self) -> list[str]:
        return [call["method"] for call in self.calls]

    def of(self, method: str) -> list[dict]:
        """Return the parameters of every call of ``method``."""
        return [call["params"] for call in self.calls if call["method"] == method]

    def __call__(self, url: str, payload: dict | None = None, timeout: float | None = None, headers: dict | None = None):
        parts = urlsplit(url)
        method = parts.path.rsplit("/", 1)[-1]
        params = payload if payload is not None else dict(parse_qsl(parts.query))
        self.calls.append({"url": url, "method": method, "params": params, "headers": dict(headers or {}), "post": payload is not None})
        if (headers or {}).get("Authorization") != f"Bearer {self.token}":
            return 200, json.dumps({"ok": False, "error": "invalid_auth"}).encode()
        if url in self.files:
            return 200, Body(self.files[url], {"Content-Type": "image/png"})
        if "/upload/" in parts.path:
            self.uploads.append({"url": url, "body": payload})
            status = self.upload_status.get(len(self.uploads), 200)
            return status, Body(f"OK - {len(payload.data)}".encode() if status == 200 else b"upload failed", {})
        if method in self.statuses:
            status, header = self.statuses.pop(method)
            return status, Body(json.dumps({"ok": False, "error": "ratelimited"}).encode(), header)
        if method in self.answers:
            answer = self.answers[method]
            if isinstance(answer, list):
                answer = answer.pop(0) if len(answer) > 1 else answer[0]
            return 200, json.dumps(answer).encode()
        return 200, json.dumps(self._answer(method, params)).encode()

    def _answer(self, method: str, params: dict) -> dict:
        if method == "conversations.history":
            oldest = float(params.get("oldest") or 0)
            found = [m for m in self.history.get(params["channel"], []) if float(m["ts"]) > oldest]
            return {"ok": True, "messages": list(reversed(found)), "has_more": False}
        if method == "conversations.replies":
            parent = params["ts"]
            oldest = float(params.get("oldest") or 0)
            thread = self.replies.get((params["channel"], parent), [])
            head = [m for m in self.history.get(params["channel"], []) if m["ts"] == parent]
            return {"ok": True, "messages": head + [m for m in thread if float(m["ts"]) > oldest]}
        if method == "users.info":
            if params["user"] not in self.users:
                return {"ok": False, "error": "user_not_found"}
            return {"ok": True, "user": self.users[params["user"]]}
        if method == "chat.postMessage":
            self.next_ts[0] += 1
            return {"ok": True, "channel": params["channel"], "ts": f"{self.next_ts[0]}.000100", "message": {"text": params["text"]}}
        if method == "files.getUploadURLExternal":
            number = len(self.of(method))
            return {"ok": True, "upload_url": f"https://files.slack.com/upload/v1/ticket{number}", "file_id": f"F0FILE{number}"}
        if method == "auth.test":
            return {"ok": True, "user": "bugsbot", "team": "Fake Team", "user_id": "U0BOT"}
        return {"ok": True}
