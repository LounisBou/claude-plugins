"""The channel factory: the one module naming the implementations, and the default HTTP transport they share."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Mapping

from bugs_bot.channel import Channel, Transport
from bugs_bot.errors import BugsError
from bugs_bot.telegram import TelegramChannel, api_root, read_token

HTTP_TIMEOUT = 30


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
        with urllib.request.urlopen(request, timeout=timeout or HTTP_TIMEOUT) as resp:  # noqa: S310 - https or loopback, see each channel's API root
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        # A platform explains its refusals in the body: keep it for the caller.
        return exc.code, exc.read()


def channel_for(kind: str, env: Mapping[str, str], transport: Transport) -> Channel:
    """Return the channel of ``kind``, reading its token and API root itself.

    Args:
        kind: The channel kind, ``"telegram"``.
        env: Process environment (where the token file and the API root are found).
        transport: What carries the requests; tests inject a fake.

    Returns:
        The channel.

    Raises:
        BugsError: On an unknown kind, a missing token, or an API root refused.
    """
    if kind == "telegram":
        token = read_token(env)
        return TelegramChannel(token, transport, api_root(env))
    raise BugsError(f"unknown channel: {kind}")


def token_problem(kind: str, env: Mapping[str, str]) -> str | None:
    """Return why ``kind``'s token cannot be read, ``None`` when it can; the token itself is never returned.

    Args:
        kind: The channel kind.
        env: Process environment.

    Returns:
        The reason (the env file unreadable, the variable missing, the kind unknown), or ``None``.
    """
    if kind != "telegram":
        return f"unknown channel: {kind}"
    try:
        read_token(env)
    except BugsError as exc:
        return str(exc)
    return None
