"""Pull rounds: every channel kind with a registered project read in turn, once or in a loop until stopped."""

from __future__ import annotations

import signal
import sys
from collections.abc import Callable, Mapping

from bugs_bot.channel import Transport
from bugs_bot.channels import LONG_POLL_KINDS, channel_for, mask, token_problem
from bugs_bot.errors import BugsError
from bugs_bot.pull import cmd_pull
from bugs_bot.store import Machine

# Long polling (`pull --watch`): the channel holds a request until a message arrives or POLL_TIMEOUT seconds pass.
POLL_TIMEOUT = 50
# While a channel that cannot hold a request (Slack) is registered, the held one is cut to this, so it is read
# at least this often in the same process.
SHORT_HOLD = 10
# A failed watch round waits BACKOFF_FIRST s, doubling up to BACKOFF_CEILING, unless the platform said how long.
BACKOFF_FIRST = 5
BACKOFF_CEILING = 60
# The 30-day purge needs no more than an hourly look.
PURGE_EVERY = 3600


class Failure:
    """One channel's failed pull: the error, and the credential to mask in it."""

    def __init__(self, error: Exception, secret: str | None) -> None:
        self.error = error
        self.secret = secret

    def line(self, typed: bool) -> str:
        """Return the error as one masked line, its type named when ``typed``."""
        text = mask(str(self.error), self.secret)
        return f"bugs-bot: {type(self.error).__name__}: {text}" if typed else f"bugs-bot: {text}"

    @property
    def retry_after(self) -> float:
        """Seconds the platform asked to wait before the next call, 0 when it asked nothing."""
        return float(getattr(self.error, "retry_after", 0) or 0)


def pull_round(
    machine: Machine,
    env: Mapping[str, str],
    transport: Transport,
    now: float,
    poll_timeout: int = 0,
    purge: bool = True,
    quiet: bool = False,
) -> tuple[list[Failure], bool]:
    """Pull every channel kind once: the long-polled one first (held ``poll_timeout`` s, or ``SHORT_HOLD`` while
    another kind is registered), then each chat of every other kind, its cursor saved after its own batch.

    A long-polled kind (Telegram) is read while one of its projects is registered, while nothing at all is, or while
    its token is there: the chats it drops are how ``init`` finds a new group. One channel's failure never keeps another unread.
    ``quiet`` drops the « no new report » trace (a loop of rounds would print it every few seconds).

    Returns:
        ``(the failures in order, empty when every pull went through; whether a read was held)``.
    """
    try:
        entries = machine.registry.entries()  # read afresh each round: a new registration needs no restart
    except BugsError as exc:
        return [Failure(exc, None)], False
    kinds = {kind for kind, _ in entries}
    failures: list[Failure] = []
    hold = poll_timeout if kinds <= LONG_POLL_KINDS else min(poll_timeout, SHORT_HOLD)
    held = False
    for kind in sorted(LONG_POLL_KINDS):
        if kind in kinds or not kinds or token_problem(kind, env) is None:
            failures += _pull(machine, env, transport, kind, now, hold, purge, None, quiet)
            held = held or hold > 0
    for kind in sorted(kinds - LONG_POLL_KINDS):
        for chat_id in [chat for k, chat in entries if k == kind]:
            failures += _pull(machine, env, transport, kind, now, 0, purge, [chat_id], quiet)
    return failures, held


def _pull(
    machine: Machine,
    env: Mapping[str, str],
    transport: Transport,
    kind: str,
    now: float,
    hold: int,
    purge: bool,
    chats: list | None,
    quiet: bool,
) -> list[Failure]:
    """Pull one channel kind (``chats`` of it only, when given); its failure is returned, never raised."""
    secret = None
    try:
        # Read afresh each round: a repaired .env or a new registration needs no restart.
        channel = channel_for(kind, env, transport, clock=lambda: now)  # the round's time, which tests pin
        secret = channel.secret
        cmd_pull(channel, machine, now, hold, purge, chats, quiet)
    except Exception as exc:  # noqa: BLE001 - one channel's failure must not keep the others unread
        return [Failure(exc, secret)]
    return []


def cmd_pull_once(machine: Machine, env: Mapping[str, str], transport: Transport, now: float) -> int:
    """Run one round and say its failures; return the exit code."""
    failures, _ = pull_round(machine, env, transport, now)
    for failure in failures:
        typed = not isinstance(failure.error, BugsError)
        print(failure.line(typed), file=sys.stderr)
    return 1 if failures else 0


def pull_loop(
    machine: Machine,
    env: Mapping[str, str],
    transport: Transport,
    every: float,
    wall: Callable[[], float],
    sleep: Callable[[float], None],
) -> int:
    """Pull, sleep ``every`` seconds, again, until SIGINT or SIGTERM; a failed round is logged, never fatal.

    This replaces PM2's ``cron_restart``, which fires twice around a boundary and
    kills the run it has just started (measured 2026-10-02 11:00 and 11:15).

    Returns:
        0 once stopped by a signal.
    """

    def stop(*_: object) -> None:
        raise KeyboardInterrupt

    previous = signal.signal(signal.SIGTERM, stop)
    try:
        while True:
            for failure in pull_round(machine, env, transport, wall())[0]:
                print(failure.line(typed=True), file=sys.stderr)
            sys.stdout.flush()
            sleep(every)
    except KeyboardInterrupt:
        print("bugs-bot: stopped")
        return 0
    finally:
        signal.signal(signal.SIGTERM, previous)


def watch_loop(
    machine: Machine,
    env: Mapping[str, str],
    transport: Transport,
    poll_timeout: int,
    wall: Callable[[], float],
    sleep: Callable[[float], None],
    clock: Callable[[], float],
) -> int:
    """Long-poll the channels until SIGINT or SIGTERM: a message is seen as it arrives.

    Rounds chain with no sleep, the long-polled channel holding each request; when none was held (no Telegram read),
    a clean round is followed by ``SHORT_HOLD`` s of sleep instead. A failed round (network,
    5xx, 409, 429) is logged and followed by the wait the platform asked for (``Retry-After``), else a
    backoff growing to ``BACKOFF_CEILING``, reset by the next success; it is never fatal. The 30-day
    purge runs about hourly. A signal interrupts the held request itself (the handler raises), so a stop
    takes no longer than PM2's.

    Returns:
        0 once stopped by a signal.
    """

    def stop(*_: object) -> None:
        raise KeyboardInterrupt

    previous = signal.signal(signal.SIGTERM, stop)
    backoff = 0.0
    last_purge: float | None = None
    try:
        while True:
            at = clock()
            purge = last_purge is None or at - last_purge >= PURGE_EVERY
            failures, held = pull_round(machine, env, transport, wall(), poll_timeout, purge, quiet=True)
            if purge and not failures:
                last_purge = at
            if failures:
                for failure in failures:
                    print(failure.line(typed=True), file=sys.stderr)
                backoff = min(backoff * 2, BACKOFF_CEILING) if backoff else BACKOFF_FIRST
                asked = max(failure.retry_after for failure in failures)
                sys.stdout.flush()
                sleep(asked or backoff)
            else:
                backoff = 0.0
                if not held:
                    sys.stdout.flush()
                    sleep(SHORT_HOLD)  # no request was held (Slack only): the round itself would not pause
            sys.stdout.flush()
    except KeyboardInterrupt:
        print("bugs-bot: stopped")
        return 0
    finally:
        signal.signal(signal.SIGTERM, previous)
