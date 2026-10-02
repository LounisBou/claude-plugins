"""The channel factory: the one module naming the implementations, and the default HTTP transport they share."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping

from bugs_bot import slack, telegram
from bugs_bot.channel import Body, Channel, Transport
from bugs_bot.errors import BugsError

HTTP_TIMEOUT = 30
# Each kind: its class, how its token is read, and its channel built from the token, the transport, the env and
# the clock.
_KINDS = {
    "telegram": (
        telegram.TelegramChannel,
        telegram.read_token,
        lambda token, transport, env, clock: telegram.TelegramChannel(token, transport, telegram.api_root(env)),
    ),
    "slack": (
        slack.SlackChannel,
        slack.read_token,
        lambda token, transport, env, clock: slack.SlackChannel(token, transport, slack.api_root(env), clock),
    ),
}
KINDS = tuple(_KINDS)
# The kinds whose platform holds a read until a message arrives and hands the bot's messages to one reader
# (``Channel.exclusive``): Pull long-polls them and logs the chats it drops, for ``init``. Any other kind is read
# again each round.
LONG_POLL_KINDS = frozenset(kind for kind, (cls, _, _) in _KINDS.items() if cls.exclusive)
# Every implementation's token shape: masked in any text shown, whichever channel is in use.
TOKEN_SHAPES = tuple(cls.TOKEN_SHAPE for cls, _, _ in _KINDS.values())


class _KeepCredentialHome(urllib.request.HTTPRedirectHandler):
    """Follow no redirect of a request carrying ``Authorization``: it would take the credential to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201 - urllib's signature
        if req.has_header("Authorization"):
            return None  # urllib then raises the 30x as an HTTPError, returned below like any other status
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_KeepCredentialHome)


def http_transport(
    url: str, payload: dict | None = None, timeout: float | None = None, headers: Mapping[str, str] | None = None
) -> tuple[int, bytes]:
    """Send one request with ``urllib``; HTTP errors are returned, not raised.

    Args:
        url: Full URL.
        payload: JSON body (POST) or ``None`` (GET).
        timeout: Read timeout in seconds (default ``HTTP_TIMEOUT``).
        headers: Extra request headers (a platform's ``Authorization``).

    Returns:
        ``(status, body)``; the body carries the response headers (``Body.headers``). A redirect of a request
        carrying ``Authorization`` is not followed: its 30x status is returned.
    """
    data = None if payload is None else json.dumps(payload).encode()
    sent = {} if payload is None else {"Content-Type": "application/json"}
    request = urllib.request.Request(url, data=data, headers={**sent, **(headers or {})})
    try:
        with _OPENER.open(request, timeout=timeout or HTTP_TIMEOUT) as resp:  # noqa: S310 - https or loopback, see each channel's API root
            return resp.status, Body(resp.read(), dict(resp.headers.items()))
    except urllib.error.HTTPError as exc:
        # A platform explains its refusals in the body, and how long to wait in the headers: keep both.
        return exc.code, Body(exc.read(), dict(exc.headers.items()) if exc.headers else {})


def channel_for(kind: str, env: Mapping[str, str], transport: Transport, clock: Callable[[], float] = time.time) -> Channel:
    """Return the channel of ``kind``, reading its token and API root itself.

    Args:
        kind: The channel kind, one of ``KINDS``.
        env: Process environment (where the token file and the API root are found).
        transport: What carries the requests; tests inject a fake.
        clock: Epoch seconds, for a channel that reads by its own time (Slack's first look back, its threads' pace).

    Returns:
        The channel.

    Raises:
        BugsError: On an unknown kind, a missing token, or an API root refused.
    """
    if kind not in _KINDS:
        raise BugsError(f"unknown channel: {kind}")
    _, read_token, build = _KINDS[kind]
    return build(read_token(env), transport, env, clock)


def token_problem(kind: str, env: Mapping[str, str]) -> str | None:
    """Return why ``kind``'s token cannot be read, ``None`` when it can; the token itself is never returned.

    Args:
        kind: The channel kind.
        env: Process environment.

    Returns:
        The reason (the env file unreadable, the variable missing, the kind unknown), or ``None``.
    """
    if kind not in _KINDS:
        return f"unknown channel: {kind}"
    try:
        _KINDS[kind][1](env)
    except BugsError as exc:
        return str(exc)
    return None


def mask(text: str, secret: str | None) -> str:
    """Hide the channel's credential, and anything shaped like any platform's token, in ``text``.

    Args:
        text: Message about to be shown (an error, a URL...).
        secret: The credential in use, if known.

    Returns:
        ``text`` with every credential replaced by ``<token>``.
    """
    if secret:
        text = text.replace(secret, "<token>")
        # A bot token is "<bot id>:<secret part>": the secret part alone must not show either.
        part = secret.split(":", 1)[-1]
        if part:
            text = text.replace(part, "<token>")
    for shape in TOKEN_SHAPES:
        text = shape.sub("<token>", text)
    return text
