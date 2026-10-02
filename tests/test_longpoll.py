"""Tests for ``pull --watch``: Telegram long polling, so a message is seen as it arrives."""

from __future__ import annotations

import os
import signal

import pytest
from conftest import REPO_ROOT, reports
from samples import BASE_DATE, TOKEN, FakeTelegram, message

from bugs_bot import cli, pull


class Watch:
    """Drives ``pull --watch`` with a fake transport, sleep and monotonic clock.

    ``rounds`` ends the loop (SIGINT) once that many ``getUpdates`` calls were made;
    every call to the transport takes ``round_seconds`` of fake time, like a held request.
    """

    def __init__(self, env, tg: FakeTelegram, rounds: int, round_seconds: float = 0.0) -> None:
        self.env, self.tg, self.rounds, self.round_seconds = env, tg, rounds, round_seconds
        self.sleeps: list[float] = []
        self.t = 0.0
        self.hooks: dict[int, object] = {}
        inner = tg.__call__

        def transport(url, payload=None, timeout=None):
            self.t += self.round_seconds
            if url.endswith("/getUpdates"):
                n = len(tg.updates_calls()) + 1
                hook = self.hooks.get(n)
                if hook:
                    hook()
                if n > rounds:
                    raise KeyboardInterrupt
            return inner(url, payload, timeout)

        self.transport = transport

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds

    def __call__(self, *argv: str, now: float = BASE_DATE) -> int:
        return cli.main(
            ["pull", "--watch", *argv],
            transport=self.transport,
            env=self.env,
            now=now,
            sleep=self.sleep,
            clock=lambda: self.t,
        )


def test_watch_asks_telegram_to_hold_the_request_for_50_seconds_and_outwaits_it(env, bound):
    tg = FakeTelegram()
    watch = Watch(env, tg, rounds=1)

    assert watch() == 0

    assert tg.updates_calls()[0]["timeout"] == 50
    assert tg.timeouts[0] == 60  # the client must not cut the held request


def test_watch_poll_timeout_sets_both_the_hold_and_the_read_timeout(env, bound):
    tg = FakeTelegram()
    watch = Watch(env, tg, rounds=1)

    assert watch("--poll-timeout", "20") == 0

    assert tg.updates_calls()[0]["timeout"] == 20
    assert tg.timeouts[0] == 30


def test_plain_pull_stays_a_single_non_blocking_pull(run, bound):
    tg = FakeTelegram()

    assert run("pull", transport=tg) == 0

    assert tg.updates_calls()[0]["timeout"] == 0
    assert tg.timeouts[0] is None


def test_watch_chains_successful_rounds_without_sleeping(env, bound):
    tg = FakeTelegram([message(10, 100, text="un")])
    watch = Watch(env, tg, rounds=4)

    assert watch() == 0

    assert len(tg.updates_calls()) == 4  # the fifth request is the one the stop interrupted
    assert watch.sleeps == []
    assert len(reports(bound)) == 1


def test_watch_confirms_the_offset_so_a_message_is_not_pulled_twice(env, bound):
    tg = FakeTelegram([message(10, 100, text="un")])
    watch = Watch(env, tg, rounds=2)

    watch()

    assert [c.get("offset") for c in tg.updates_calls()[:2]] == [None, 11]


def test_watch_backs_off_after_a_failed_round_and_logs_it(env, bound, capsys):
    tg = FakeTelegram([message(10, 100, text="un")])
    tg.api_error = {"ok": False, "error_code": 502, "description": "Bad Gateway"}
    watch = Watch(env, tg, rounds=3)

    assert watch() == 0

    assert watch.sleeps == [5, 10, 20]
    err = capsys.readouterr().err
    assert err.count("Bad Gateway") == 3 and "Traceback" not in err


def test_watch_backoff_grows_to_a_ceiling_and_resets_after_a_success(env, bound):
    tg = FakeTelegram()
    tg.api_error = {"ok": False, "error_code": 409, "description": "Conflict: terminated by other getUpdates"}
    watch = Watch(env, tg, rounds=9)
    watch.hooks[8] = lambda: setattr(tg, "api_error", None)

    watch()

    assert watch.sleeps == [5, 10, 20, 40, 60, 60, 60]  # seven failures, then two chained successes


def test_watch_backoff_restarts_from_the_floor_after_a_success(env, bound):
    tg = FakeTelegram()
    tg.api_error = {"ok": False, "error_code": 502, "description": "Bad Gateway"}
    watch = Watch(env, tg, rounds=4)
    watch.hooks[2] = lambda: setattr(tg, "api_error", None)
    watch.hooks[3] = lambda: setattr(tg, "api_error", {"ok": False, "error_code": 502, "description": "Bad Gateway"})

    watch()

    assert watch.sleeps == [5, 5, 10]  # fail, success (backoff reset), fail, fail


def test_watch_never_leaks_the_token(env, bound, capsys):
    tg = FakeTelegram()
    tg.raise_on_call = OSError(f"connection to /bot{TOKEN}/getUpdates refused")
    watch = Watch(env, tg, rounds=2)

    assert watch() == 0

    err = capsys.readouterr().err
    assert "refused" in err and TOKEN not in err


def test_watch_does_not_spin_while_unbound(env, home):
    tg = FakeTelegram()
    watch = Watch(env, tg, rounds=0)
    sleeps_before_stop = []

    def stop_after_three(seconds: float) -> None:
        sleeps_before_stop.append(seconds)
        if len(sleeps_before_stop) == 3:
            raise KeyboardInterrupt

    watch.sleep = stop_after_three
    assert watch() == 0

    assert sleeps_before_stop == [pull.UNBOUND_WAIT] * 3
    assert tg.updates_calls() == []


def test_watch_stops_cleanly_on_sigterm_in_the_middle_of_a_held_request(env, bound, capsys):
    tg = FakeTelegram()
    inner = tg.__call__

    def held(url, payload=None, timeout=None):
        if url.endswith("/getUpdates"):
            os.kill(os.getpid(), signal.SIGTERM)  # what PM2's stop does while Telegram holds the request
            raise AssertionError("the request was not interrupted")
        return inner(url, payload, timeout)

    previous = signal.getsignal(signal.SIGTERM)
    code = cli.main(["pull", "--watch"], transport=held, env=env, now=BASE_DATE, sleep=lambda s: None)

    assert code == 0
    assert "stopped" in capsys.readouterr().out
    assert signal.getsignal(signal.SIGTERM) == previous


def test_watch_purges_old_reports_about_once_an_hour_not_every_round(env, bound, monkeypatch):
    purges: list[float] = []
    monkeypatch.setattr(pull, "purge_old_done", lambda store, now: purges.append(now))
    tg = FakeTelegram()
    watch = Watch(env, tg, rounds=130, round_seconds=50)  # 130 rounds of 50 s = 1 h 48

    watch()

    assert len(purges) == 2  # the first round, then once an hour: 0 s and 3600 s


def test_watch_still_lands_pending_reactions(env, bound):
    tg = FakeTelegram([message(10, 100, text="un")])
    tg.fail_reaction = True
    watch = Watch(env, tg, rounds=1)
    watch()
    assert tg.reactions == []

    tg.fail_reaction = False
    watch = Watch(env, tg, rounds=2)  # the call counter is cumulative: one more round
    watch()

    assert len(tg.reactions) == 1


def test_watch_is_quiet_when_nothing_arrives(env, bound, capsys):
    watch = Watch(env, FakeTelegram(), rounds=3)

    watch()

    assert "no new report" not in capsys.readouterr().out  # one line every 50 s would drown the log


def test_watch_and_every_are_mutually_exclusive(run, bound):
    with pytest.raises(SystemExit):
        run("pull", "--watch", "--every", "900")


def test_pm2_config_runs_the_long_poll_form():
    text = (REPO_ROOT / "pm2.config.js").read_text()

    assert "pull --watch" in text and "--every" not in text.split("module.exports", 1)[1]
    assert "kill_timeout" in text

