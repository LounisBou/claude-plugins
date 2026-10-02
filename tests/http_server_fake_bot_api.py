"""A fake Bot API on ``http.server`` (hence the file name: a leftover shows in ``ps | grep http.server``) for ``tests/e2e.sh``: loopback only, one process, no dependency.

Usage: ``http_server_fake_bot_api.py PORT_FILE LOG_FILE TOKEN`` — binds a free port of 127.0.0.1, writes it to
``PORT_FILE``, appends one JSON line per Bot API call to ``LOG_FILE``, and serves until killed.

Besides the Bot API paths (``/bot<token>/<method>``, answered only for ``TOKEN``):
``POST /_enqueue`` queues a JSON list of updates (what a group's members post).
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT_FILE, LOG_FILE, TOKEN = sys.argv[1:4]
UPDATES: list[dict] = []
NEXT_MESSAGE_ID = [9000]


class Handler(BaseHTTPRequestHandler):
    """Answer Bot API calls the way Telegram does, with just what the CLI uses."""

    def log_message(self, *args) -> None:  # silence the default stderr access log
        pass

    def _reply(self, status: int, body: dict | bytes) -> None:
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _record(self, method: str, payload: dict) -> None:
        with open(LOG_FILE, "a") as log:
            log.write(json.dumps({"method": method, "payload": payload}) + "\n")

    def do_GET(self) -> None:  # noqa: N802 - http.server's name
        if self.path.startswith(f"/file/bot{TOKEN}/"):
            self._reply(200, b"\xff\xd8\xff-fake-image")
        else:
            self._reply(404, {"ok": False, "error_code": 404, "description": "Not Found"})

    def do_POST(self) -> None:  # noqa: N802 - http.server's name
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/_enqueue":
            UPDATES.extend(payload)
            return self._reply(200, {"ok": True, "result": len(UPDATES)})
        prefix = f"/bot{TOKEN}/"
        if not self.path.startswith(prefix):
            return self._reply(401, {"ok": False, "error_code": 401, "description": "Unauthorized"})
        method = self.path[len(prefix):]
        self._record(method, payload)
        if method == "getUpdates":
            offset = payload.get("offset")
            result = [u for u in UPDATES if offset is None or u["update_id"] >= offset]
        elif method in ("sendMessage", "editMessageText"):
            NEXT_MESSAGE_ID[0] += 1
            result = {"message_id": payload.get("message_id") or NEXT_MESSAGE_ID[0]}
        elif method == "getFile":
            result = {"file_path": "photos/fake.jpg"}
        else:
            result = True
        self._reply(200, {"ok": True, "result": result})


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(PORT_FILE, "w") as port_file:
    port_file.write(str(server.server_address[1]))
server.serve_forever()
