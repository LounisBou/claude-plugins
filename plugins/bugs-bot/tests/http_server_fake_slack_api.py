"""A fake Slack Web API on ``http.server`` (hence the file name: a leftover shows in ``ps | grep http.server``) for ``tests/e2e.sh``: loopback only, one process, no dependency.

Usage: ``http_server_fake_slack_api.py PORT_FILE LOG_FILE TOKEN`` — binds a free port of 127.0.0.1, writes it to
``PORT_FILE``, appends one JSON line per Web API call to ``LOG_FILE``, and serves until killed.

Besides the Web API paths (``/api/<method>``, answered only with ``Authorization: Bearer TOKEN``):
``POST /_post`` adds a JSON list of messages ``{"channel", "ts", "user", "text"[, "thread_ts"]}`` (what a
channel's members post); the channels the bot is in are those messages' channels, named after their id.
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qsl, urlsplit

PORT_FILE, LOG_FILE, TOKEN = sys.argv[1:4]
MESSAGES: list[dict] = []
USERS = {"U0ANA": {"id": "U0ANA", "name": "ana", "real_name": "Ana", "profile": {"display_name": "Ana"}, "locale": "fr-FR"}}
NEXT_TS = [2_000_000_000]


class Handler(BaseHTTPRequestHandler):
    """Answer Web API calls the way Slack does, with just what the CLI uses."""

    def log_message(self, *args) -> None:  # silence the default stderr access log
        pass

    def _reply(self, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _api(self, params: dict) -> None:
        parts = urlsplit(self.path)
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self._reply({"ok": False, "error": "invalid_auth"})
        method = parts.path.rsplit("/", 1)[-1]
        params = params or dict(parse_qsl(parts.query))
        with open(LOG_FILE, "a") as log:
            log.write(json.dumps({"method": method, "payload": params}) + "\n")
        self._reply(answer(method, params))

    def do_GET(self) -> None:  # noqa: N802 - http.server's name
        self._api({})

    def do_POST(self) -> None:  # noqa: N802 - http.server's name
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/_post":
            MESSAGES.extend(payload)
            return self._reply({"ok": True, "count": len(MESSAGES)})
        self._api(payload)


def answer(method: str, params: dict) -> dict:
    """Return Slack's answer to one call."""
    channel = params.get("channel")
    if method == "conversations.history":
        found = [m for m in MESSAGES if m["channel"] == channel and float(m["ts"]) > float(params.get("oldest") or 0)
                 and m.get("thread_ts", m["ts"]) == m["ts"]]
        return {"ok": True, "messages": sorted(found, key=lambda m: float(m["ts"]), reverse=True), "has_more": False}
    if method == "conversations.replies":
        parent = [m for m in MESSAGES if m["channel"] == channel and m["ts"] == params["ts"]]
        replies = [m for m in MESSAGES if m["channel"] == channel and m.get("thread_ts") == params["ts"] and m["ts"] != params["ts"]
                   and float(m["ts"]) > float(params.get("oldest") or 0)]
        return {"ok": True, "messages": parent + replies}
    if method == "users.info":
        return {"ok": True, "user": USERS[params["user"]]} if params["user"] in USERS else {"ok": False, "error": "user_not_found"}
    if method == "users.conversations":
        ids = sorted({m["channel"] for m in MESSAGES})
        return {"ok": True, "channels": [{"id": cid, "name": cid.lower(), "is_private": False} for cid in ids]}
    if method == "chat.postMessage":
        NEXT_TS[0] += 1
        return {"ok": True, "channel": channel, "ts": f"{NEXT_TS[0]}.000100"}
    if method == "auth.test":
        return {"ok": True, "user": "bugsbot", "team": "E2E"}
    return {"ok": True}


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(PORT_FILE, "w") as port_file:
    port_file.write(str(server.server_address[1]))
server.serve_forever()
