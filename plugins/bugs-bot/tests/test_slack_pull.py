"""Pull and the commands on a Slack project: threads, answers, string ids, both channels in one round."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import register
from fake_channel import FakeChannel, author, batch, inbound
from fake_slack import CHANNEL, SLACK_TOKEN, FakeSlack, msg, ts
from samples import BASE_DATE, GROUP_ID, TOKEN, FakeTelegram, message

from bugs_bot import cli, pull
from bugs_bot.agent import WAIT_TIMED_OUT
from bugs_bot.channel import Attachment
from bugs_bot.store import Machine

ANA = author(id="U0ANA", username="ana", name="Ana", language="fr-FR")
NOW = BASE_DATE + 3600


@pytest.fixture
def env(tmp_path: Path, bugs_home: Path) -> dict[str, str]:
    """An environment holding both tokens."""
    env_file = tmp_path / ".env"
    env_file.write_text(f"TELEGRAM_BOT_TOKEN={TOKEN}\nSLACK_BOT_TOKEN={SLACK_TOKEN}\n")
    return {"BUGS_BOT_ENV_FILE": str(env_file), "BUGS_BOT_HOME": str(bugs_home)}


@pytest.fixture
def slack_repo(tmp_path: Path, bugs_home: Path) -> Path:
    return register(bugs_home, tmp_path / "repo-sla", "sla", CHANNEL, "sla-bugs", channel="slack")


def reports_of(bugs_home: Path, project: str) -> dict[str, dict]:
    inbox = bugs_home / project / "inbox"
    if not inbox.is_dir():
        return {}
    return {p.name: json.loads((p / "report.json").read_text()) for p in sorted(inbox.iterdir()) if (p / "report.json").is_file()}


class Both:
    """One transport for both platforms: Slack's root goes to the fake Web API, anything else to the fake Bot API.

    ``rounds`` ends a watch loop (SIGINT) at the ``getUpdates`` call after that many.
    """

    def __init__(self, tg: FakeTelegram, slack: FakeSlack, rounds: int | None = None) -> None:
        self.tg, self.slack, self.rounds = tg, slack, rounds

    def __call__(self, url: str, payload: dict | None = None, timeout: float | None = None, headers: dict | None = None):
        if self.rounds is not None and url.endswith("/getUpdates") and len(self.tg.updates_calls()) >= self.rounds:
            raise KeyboardInterrupt
        if url.startswith("https://slack.com/") or url.startswith("https://files.slack.com/"):
            return self.slack(url, payload, timeout, headers)
        return self.tg(url, payload) if timeout is None else self.tg(url, payload, timeout)


# -- through the fake Channel: string ids, threads -------------------------------------------------------


def test_string_chat_and_message_ids_make_a_report_whose_id_has_no_dot(bugs_home, slack_repo):
    channel = FakeChannel(batch(inbound(CHANNEL, ts(1), "ça plante", author=ANA, date=BASE_DATE + 1.0001)), kind="slack")

    pull.cmd_pull(channel, Machine(bugs_home), NOW)

    (report_id, report), = reports_of(bugs_home, "sla").items()
    assert report_id == "20261002-083001-1790929801-000100"
    assert (report["chat_id"], report["message_ids"], report["author_id"]) == (CHANNEL, [ts(1)], "U0ANA")
    assert channel.of("react") == [("react", CHANNEL, ts(1), "\U0001f440")]


def test_messages_are_ordered_by_date_then_id_never_by_id_alone(bugs_home, slack_repo):
    # Text ids sort lexically: "b" posted first must open the report all the same.
    group = [
        inbound(CHANNEL, "a", "second", author=ANA, date=BASE_DATE + 2, group_key="g"),
        inbound(CHANNEL, "b", "first", author=ANA, date=BASE_DATE + 1, group_key="g"),
    ]
    pull.cmd_pull(FakeChannel(batch(*group), kind="slack"), Machine(bugs_home), NOW)

    (report,) = reports_of(bugs_home, "sla").values()
    assert report["message_ids"] == ["b", "a"] and report["text"] == "first\nsecond"


def test_pull_gives_the_channel_the_open_reports_threads_per_chat(bugs_home, slack_repo):
    machine = Machine(bugs_home)
    channel = FakeChannel(batch(inbound(CHANNEL, ts(1), "un", author=ANA), inbound(CHANNEL, ts(2), "deux", author=ANA, date=BASE_DATE + 5)), kind="slack")
    pull.cmd_pull(channel, machine, NOW)
    closed = next(path for path in (bugs_home / "sla" / "inbox").iterdir() if path.name.endswith("000100") and "-1790929802-" in path.name)
    report = json.loads((closed / "report.json").read_text())
    (closed / "report.json").write_text(json.dumps(report | {"status": "done"}))

    pull.cmd_pull(channel, machine, NOW)

    assert channel.threads == [{CHANNEL: []}, {CHANNEL: [ts(1)]}]
    assert [poll[1] for poll in channel.polls] == [[CHANNEL], [CHANNEL]]


def test_a_thread_reply_is_an_answer_on_its_report_never_a_report(bugs_home, slack_repo, env, capsys, monkeypatch):
    machine = Machine(bugs_home)
    first = FakeChannel(batch(inbound(CHANNEL, ts(1), "le bouton", author=ANA, date=BASE_DATE + 1)), kind="slack")
    pull.cmd_pull(first, machine, NOW)
    (report_id, report), = reports_of(bugs_home, "sla").items()
    path = bugs_home / "sla" / "inbox" / report_id / "report.json"
    path.write_text(json.dumps(report | {"kind": "bug", "awaiting": {"since": "2026-10-02T08:40:00+00:00", "reply": 1}}))
    reply = inbound(CHANNEL, ts(900), "oui c'est mieux", author=ANA, date=BASE_DATE + 900, thread_of=ts(1),
                    attachments=[Attachment("https://files.slack.com/F1/a.png", ".png")])
    channel = FakeChannel(batch(reply, reply), kind="slack")  # delivered twice: recorded once

    pull.cmd_pull(channel, machine, NOW)

    assert list(reports_of(bugs_home, "sla")) == [report_id]
    after = reports_of(bugs_home, "sla")[report_id]
    assert "awaiting" not in after
    assert after["answers"] == [{
        "date": "2026-10-02T08:45:00+00:00", "author": "Ana", "author_id": "U0ANA", "text": "oui c'est mieux",
        "message_id": ts(900), "images": ["1.png"], "seen": False,
    }]
    assert (bugs_home / "sla" / "inbox" / report_id / "1.png").read_bytes() == b"bytes of https://files.slack.com/F1/a.png"
    assert channel.of("react") == []  # an answer gets no 👀 of its own
    assert f"answer on {report_id} in sla" in capsys.readouterr().out

    monkeypatch.chdir(slack_repo)
    assert cli.main(["wait", "--timeout", "0"], env=env, now=NOW) == 0
    assert capsys.readouterr().out == f"answer {report_id}\n"
    assert cli.main(["show", report_id], env=env, now=NOW) == 0
    shown = capsys.readouterr().out
    assert "answer 1 2026-10-02T08:45:00+00:00 Ana: oui c'est mieux" in shown and "1.png" in shown
    assert cli.main(["wait", "--timeout", "0"], env=env, now=NOW) == WAIT_TIMED_OUT
    assert capsys.readouterr().out == ""


def test_a_reply_in_a_thread_that_is_no_report_is_dropped(bugs_home, slack_repo):
    channel = FakeChannel(batch(inbound(CHANNEL, ts(5), "hors sujet", author=ANA, thread_of=ts(4))), kind="slack")

    pull.cmd_pull(channel, Machine(bugs_home), NOW)

    assert reports_of(bugs_home, "sla") == {}


def test_a_failed_answer_download_keeps_the_cursor_and_records_nothing(bugs_home, slack_repo):
    machine = Machine(bugs_home)
    pull.cmd_pull(FakeChannel(batch(inbound(CHANNEL, ts(1), "bug", author=ANA), cursor={"C": 1}), kind="slack"), machine, NOW)
    reply = inbound(CHANNEL, ts(9), "voilà", author=ANA, thread_of=ts(1), attachments=[Attachment("u1", ".png"), Attachment("u2", ".png")])
    channel = FakeChannel(batch(reply, cursor={"C": 2}), kind="slack")
    channel.fail_files.add("u2")

    with pytest.raises(Exception, match="u2"):
        pull.cmd_pull(channel, machine, NOW)

    (report_id, report), = reports_of(bugs_home, "sla").items()
    assert "answers" not in report or report["answers"] == []
    assert not (bugs_home / "sla" / "inbox" / report_id / "1.png").exists()
    assert machine.load_cursor("slack") == {"C": 1}


# -- through the Slack channel, from the command line ----------------------------------------------------


def test_pull_reads_slack_and_the_commands_answer_in_the_thread(bugs_home, slack_repo, env, monkeypatch, capsys):
    api = FakeSlack()
    api.history[CHANNEL] = [msg(ts(1), "la recherche est vide")]

    assert cli.main(["pull"], transport=Both(FakeTelegram(), api), env=env, now=NOW) == 0

    (report_id, report), = reports_of(bugs_home, "sla").items()
    assert report["author"] == "Ana" and report["reaction"]["applied"] == "\U0001f440"
    assert api.of("reactions.add") == [{"channel": CHANNEL, "timestamp": ts(1), "name": "eyes"}]
    assert Machine(bugs_home).load_cursor("slack") == {CHANNEL: {"ts": ts(1), "threads": {}}}
    people = json.loads((bugs_home / "sla" / "people" / "U0ANA.json").read_text())
    assert people["language"] == "fr"

    monkeypatch.chdir(slack_repo)
    assert cli.main(["reply", report_id, "je regarde", "--mention", "--awaits"], transport=api, env=env, now=NOW) == 0
    assert api.of("chat.postMessage")[-1] == {"channel": CHANNEL, "text": "<@U0ANA> je regarde", "thread_ts": ts(1)}
    assert cli.main(["person-lang", "U0ANA", "en"], env=env, now=NOW) == 0
    assert cli.main(["person", "U0ANA"], env=env, now=NOW) == 0
    assert "language: en" in capsys.readouterr().out

    # Ana answers in the thread: the next round reads it there, lifts the wait, and adds no report.
    api.replies[(CHANNEL, ts(1))] = [msg(ts(3700), "voilà la capture", thread_ts=ts(1))]
    assert cli.main(["pull"], transport=Both(FakeTelegram(), api), env=env, now=NOW + 60) == 0

    assert list(reports_of(bugs_home, "sla")) == [report_id]
    after = reports_of(bugs_home, "sla")[report_id]
    assert "awaiting" not in after and after["answers"][0]["text"] == "voilà la capture"
    assert api.of("conversations.replies")[-1] == {"channel": CHANNEL, "ts": ts(1), "oldest": ts(1), "limit": "200"}
    assert Machine(bugs_home).load_cursor("slack")[CHANNEL]["threads"] == {ts(1): ts(3700)}

    assert cli.main(["taken", report_id], transport=api, env=env, now=NOW) == 0
    assert api.of("reactions.add")[-1]["name"] == "male-technologist"
    assert cli.main(["delete", report_id], transport=api, env=env, now=NOW) == 0
    assert api.of("chat.delete")[-1]["channel"] == CHANNEL


def test_one_round_reads_telegram_held_ten_seconds_then_each_slack_project(tmp_path, bugs_home, slack_repo, env):
    register(bugs_home, tmp_path / "repo-tg", "tele", GROUP_ID, "Tele Bugs")
    register(bugs_home, tmp_path / "repo-sla2", "sla2", "G0SECOND", "sla2-bugs", channel="slack")
    tg = FakeTelegram([message(5, 50, text="un bug telegram")])
    api = FakeSlack()
    api.history[CHANNEL] = [msg(ts(1), "un bug slack")]
    api.history["G0SECOND"] = [msg(ts(2), "un autre", "U0BOB")]
    state = bugs_home / "state.json"

    code = cli.main(["pull", "--watch"], transport=Both(tg, api, rounds=1), env=env, now=NOW, sleep=_stop, clock=lambda: 0.0)

    assert code == 0
    assert tg.timeouts[0] == 20  # held 10 s, read 10 s longer
    assert tg.updates_calls()[0]["timeout"] == 10
    assert [c["params"]["channel"] for c in api.calls if c["method"] == "conversations.history"] == [CHANNEL, "G0SECOND"]
    assert len(reports_of(bugs_home, "tele")) == len(reports_of(bugs_home, "sla")) == len(reports_of(bugs_home, "sla2")) == 1
    saved = json.loads(state.read_text())
    assert saved["offset"] == 6 and set(saved["slack"]) == {CHANNEL, "G0SECOND"}


def _stop(seconds: float) -> None:
    raise KeyboardInterrupt


def test_telegram_alone_is_still_held_fifty_seconds(tmp_path, bugs_home, env):
    register(bugs_home, tmp_path / "repo-tg", "tele", GROUP_ID, "Tele Bugs")
    tg = FakeTelegram([message(5, 50, text="x")])

    cli.main(["pull", "--watch"], transport=Both(tg, FakeSlack(), rounds=1), env=env, now=NOW, sleep=_stop, clock=lambda: 0.0)

    assert tg.updates_calls()[0]["timeout"] == 50


def test_a_slack_rate_limit_waits_what_slack_asked_then_retries(bugs_home, slack_repo, env, capsys):
    api = FakeSlack()
    api.statuses["conversations.history"] = (429, {"Retry-After": "7"})
    api.history[CHANNEL] = [msg(ts(1), "après l'attente")]
    slept: list[float] = []

    tg = FakeTelegram()
    cli.main(["pull", "--watch"], transport=Both(tg, api, rounds=2), env=env, now=NOW, sleep=slept.append, clock=lambda: 0.0)

    assert slept[0] == 7
    assert len(reports_of(bugs_home, "sla")) == 1  # the round after the wait read it
    assert "rate limited" in capsys.readouterr().err


def test_a_slack_failure_never_keeps_telegram_unread(tmp_path, bugs_home, slack_repo, env, capsys):
    register(bugs_home, tmp_path / "repo-tg", "tele", GROUP_ID, "Tele Bugs")
    api = FakeSlack()
    api.answers["conversations.history"] = {"ok": False, "error": "channel_not_found"}
    tg = FakeTelegram([message(5, 50, text="un bug telegram")])

    code = cli.main(["pull"], transport=Both(tg, api), env=env, now=NOW)

    assert code == 1
    assert len(reports_of(bugs_home, "tele")) == 1
    err = capsys.readouterr().err
    assert "conversations.history: channel_not_found" in err and SLACK_TOKEN not in err
    assert Machine(bugs_home).load_cursor("slack") is None


def test_a_slack_only_machine_without_a_telegram_token_reads_slack_only(bugs_home, slack_repo, tmp_path):
    env_file = tmp_path / "slack-only.env"
    env_file.write_text(f"SLACK_BOT_TOKEN={SLACK_TOKEN}\n")
    env = {"BUGS_BOT_ENV_FILE": str(env_file), "BUGS_BOT_HOME": str(bugs_home)}
    api = FakeSlack()
    api.history[CHANNEL] = [msg(ts(1), "seul slack")]
    tg = FakeTelegram()

    assert cli.main(["pull"], transport=Both(tg, api), env=env, now=NOW) == 0

    assert tg.calls == [] and len(reports_of(bugs_home, "sla")) == 1


def test_an_unregistered_slack_channel_is_never_read_nor_logged(bugs_home, slack_repo, env):
    api = FakeSlack()
    api.history["C0STRANGER"] = [msg(ts(1), "ailleurs")]

    cli.main(["pull"], transport=Both(FakeTelegram(), api), env=env, now=NOW)

    assert [c["params"]["channel"] for c in api.calls if c["method"] == "conversations.history"] == [CHANNEL]
    assert not (bugs_home / "unregistered.json").exists()


# -- init --channel slack, doctor ------------------------------------------------------------------------


def channels(*items: tuple[str, str]) -> dict:
    return {"ok": True, "channels": [{"id": cid, "name": name, "is_private": cid.startswith("G")} for cid, name in items]}


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    import subprocess

    repo = tmp_path / "fresh"
    repo.mkdir()
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    return repo


def init(env, transport, repo, *extra: str) -> int:
    return cli.main(["init", "--repo", str(repo), *extra], transport=transport, env=env, now=NOW)


def test_init_slack_takes_the_one_channel_the_bot_is_in_and_is_idempotent(bugs_home, env, git_repo, capsys):
    api = FakeSlack()
    api.answers["users.conversations"] = channels((CHANNEL, "demo-bugs"))

    assert init(env, api, git_repo, "--channel", "slack", "--project", "demo", "--agent-title", "Agent : Demo") == 0
    first = (git_repo / ".bugs-bot.json").read_text()
    assert init(env, api, git_repo, "--language", "en") == 0  # a re-run keeps the channel and the group

    data = json.loads((git_repo / ".bugs-bot.json").read_text())
    assert (data["channel"], data["group"], data["language"]) == ("slack", {"chat_id": CHANNEL, "title": "demo-bugs"}, "en")
    assert json.loads(first)["group"] == data["group"]
    assert json.loads((bugs_home / "projects.json").read_text()) == {f"slack:{CHANNEL}": {"project": "demo", "repo": str(git_repo)}}
    assert len(api.of("users.conversations")) == 1  # the re-run looked for nothing
    assert not (bugs_home / "state.json").exists()
    assert f"registered {CHANNEL} -> demo" in capsys.readouterr().out


def test_init_slack_lists_the_channels_when_there_are_several_and_writes_nothing(bugs_home, env, git_repo, capsys):
    api = FakeSlack()
    api.answers["users.conversations"] = channels((CHANNEL, "demo-bugs"), ("G0PRIV", "secret"))

    assert init(env, api, git_repo, "--channel", "slack", "--project", "demo", "--agent-title", "A") == 1

    out = capsys.readouterr()
    assert f"{CHANNEL}  demo-bugs" in out.out and "G0PRIV  secret" in out.out and "--chat-id" in out.err
    assert not (git_repo / ".bugs-bot.json").exists()


def test_init_slack_with_an_explicit_channel_asks_nothing(bugs_home, env, git_repo):
    api = FakeSlack()

    assert init(env, api, git_repo, "--channel", "slack", "--project", "demo", "--agent-title", "A", "--chat", "G0PRIV", "--title", "secret") == 0

    assert api.calls == []
    assert json.loads((git_repo / ".bugs-bot.json").read_text())["group"] == {"chat_id": "G0PRIV", "title": "secret"}


def test_init_slack_never_offers_telegram_chats_nor_a_channel_another_project_holds(bugs_home, env, git_repo, tmp_path, capsys):
    machine = Machine(bugs_home)
    machine.note_unregistered({"id": -1004444, "title": "Telegram group", "type": "supergroup"}, NOW)
    register(bugs_home, tmp_path / "repo-other", "other", CHANNEL, "taken", channel="slack")
    api = FakeSlack()
    api.answers["users.conversations"] = channels((CHANNEL, "taken"))

    assert init(env, api, git_repo, "--channel", "slack", "--project", "demo", "--agent-title", "A") == 1

    assert "no group found" in capsys.readouterr().err


def test_doctor_asks_each_registered_platform_who_the_bot_is(tmp_path, bugs_home, env, slack_repo, monkeypatch, capsys):
    from test_doctor import PULL_PS

    register(bugs_home, tmp_path / "repo-tg", "tele", GROUP_ID, "Tele Bugs")
    monkeypatch.setattr(cli, "read_ps", lambda: PULL_PS)
    tg = FakeTelegram()
    api = FakeSlack()

    cli.main(["doctor"], transport=Both(tg, api), env=env, now=NOW)

    out = capsys.readouterr().out
    assert "ok    slack token: present" in out and "ok    slack bot: answering as @bugsbot (Fake Team)" in out
    assert "ok    token: present" in out and "telegram bot:" in out
    assert api.methods() == ["auth.test"] and [u for u, _ in tg.calls] == [f"https://api.telegram.org/bot{TOKEN}/getMe"]
    assert SLACK_TOKEN not in out and TOKEN not in out


def test_doctor_fails_the_slack_check_when_its_token_is_refused(bugs_home, slack_repo, tmp_path, monkeypatch, capsys):
    from test_doctor import PULL_PS

    env_file = tmp_path / "bad.env"
    env_file.write_text("SLACK_BOT_TOKEN=xoxb-revoked-0000\n")
    monkeypatch.setattr(cli, "read_ps", lambda: PULL_PS)

    code = cli.main(["doctor"], transport=FakeSlack(), env={"BUGS_BOT_ENV_FILE": str(env_file), "BUGS_BOT_HOME": str(bugs_home)}, now=NOW)

    out = capsys.readouterr().out
    assert code == 1 and "FAIL  slack bot: auth.test: invalid_auth" in out and "xoxb-revoked" not in out
    assert "  token:" not in out  # no Telegram project: its token is not needed


def test_an_unreadable_registry_fails_the_round_never_the_watch(bugs_home, env, capsys):
    bugs_home.mkdir(parents=True, exist_ok=True)
    (bugs_home / "projects.json").write_text("{broken")
    slept: list[float] = []

    def sleep(seconds: float) -> None:
        slept.append(seconds)
        if len(slept) == 2:
            raise KeyboardInterrupt

    code = cli.main(["pull", "--watch"], transport=Both(FakeTelegram(), FakeSlack()), env=env, now=NOW, sleep=sleep, clock=lambda: 0.0)

    assert code == 0 and slept == [5, 10]
    assert "cannot read the registry" in capsys.readouterr().err


def test_a_reply_in_the_thread_of_a_fixed_report_answers_its_check(bugs_home, slack_repo, env):
    # « vérifier » is asked once the report is fixed: its thread is still read.
    api = FakeSlack()
    api.history[CHANNEL] = [msg(ts(1), "le lecteur plante")]
    assert cli.main(["pull"], transport=Both(FakeTelegram(), api), env=env, now=NOW) == 0
    (report_id, report), = reports_of(bugs_home, "sla").items()
    path = bugs_home / "sla" / "inbox" / report_id / "report.json"
    path.write_text(json.dumps(report | {"status": "fixed", "awaiting": {"since": "2026-10-02T08:40:00+00:00", "reply": 1}}))
    api.replies[(CHANNEL, ts(1))] = [msg(ts(3700), "c'est bon chez moi", thread_ts=ts(1))]

    assert cli.main(["pull"], transport=Both(FakeTelegram(), api), env=env, now=NOW + 60) == 0

    after = reports_of(bugs_home, "sla")[report_id]
    assert after["answers"][0]["text"] == "c'est bon chez moi"
    assert "awaiting" not in after and after["status"] == "fixed"


class SlackRounds:
    """A Slack-only transport that stops a watch loop (SIGINT) at the ``conversations.history`` call after ``rounds``."""

    def __init__(self, api: FakeSlack, rounds: int) -> None:
        self.api, self.rounds = api, rounds

    def __call__(self, url: str, payload: dict | None = None, timeout: float | None = None, headers: dict | None = None):
        if "/conversations.history?" in url and len(self.api.of("conversations.history")) >= self.rounds:
            raise KeyboardInterrupt
        return self.api(url, payload, timeout, headers)


def test_a_slack_only_watch_pauses_between_clean_rounds(bugs_home, slack_repo, tmp_path):
    from bugs_bot.watch import SHORT_HOLD

    env_file = tmp_path / "slack-only.env"
    env_file.write_text(f"SLACK_BOT_TOKEN={SLACK_TOKEN}\n")
    env = {"BUGS_BOT_ENV_FILE": str(env_file), "BUGS_BOT_HOME": str(bugs_home)}
    slept: list[float] = []

    code = cli.main(["pull", "--watch"], transport=SlackRounds(FakeSlack(), rounds=3), env=env, now=NOW, sleep=slept.append, clock=lambda: 0.0)

    assert code == 0 and slept == [SHORT_HOLD] * 3  # nothing held the request: the loop waits instead


def test_a_round_whose_telegram_read_was_held_adds_no_pause(tmp_path, bugs_home, slack_repo, env):
    register(bugs_home, tmp_path / "repo-tg", "tele", GROUP_ID, "Tele Bugs")
    slept: list[float] = []

    cli.main(["pull", "--watch"], transport=Both(FakeTelegram(), FakeSlack(), rounds=3), env=env, now=NOW, sleep=slept.append, clock=lambda: 0.0)

    assert slept == []


def test_a_watch_on_a_slack_project_with_nothing_new_prints_nothing(tmp_path, bugs_home, slack_repo, env, capsys):
    register(bugs_home, tmp_path / "repo-tg", "tele", GROUP_ID, "Tele Bugs")

    cli.main(["pull", "--watch"], transport=Both(FakeTelegram(), FakeSlack(), rounds=3), env=env, now=NOW, sleep=_stop, clock=lambda: 0.0)

    assert capsys.readouterr().out == "bugs-bot: stopped\n"


def test_a_pull_reads_slack_back_from_its_own_time_never_the_machine_s_date(bugs_home, slack_repo, env):
    # A week before the clock of the machine running the tests: the day looked back is the round's.
    week = 7 * 86400
    api = FakeSlack()
    api.history[CHANNEL] = [msg(ts(1 - week), "un bug d'il y a une semaine")]

    assert cli.main(["pull"], transport=Both(FakeTelegram(), api), env=env, now=NOW - week) == 0

    assert api.of("conversations.history")[0]["oldest"] == f"{NOW - week - 86400:.6f}"
    assert len(reports_of(bugs_home, "sla")) == 1


def test_a_telegram_failure_never_keeps_slack_unread(tmp_path, bugs_home, slack_repo, env, capsys):
    register(bugs_home, tmp_path / "repo-tg", "tele", GROUP_ID, "Tele Bugs")
    tg = FakeTelegram([message(5, 50, text="perdu pour ce tour")])
    tg.api_error = {"ok": False, "error_code": 502, "description": "Bad Gateway"}
    api = FakeSlack()
    api.history[CHANNEL] = [msg(ts(1), "un bug slack")]

    code = cli.main(["pull"], transport=Both(tg, api), env=env, now=NOW)

    assert code == 1 and "Bad Gateway" in capsys.readouterr().err
    assert reports_of(bugs_home, "tele") == {} and len(reports_of(bugs_home, "sla")) == 1
    assert Machine(bugs_home).load_cursor("slack") == {CHANNEL: {"ts": ts(1), "threads": {}}}
    assert Machine(bugs_home).load_cursor("telegram") is None


def test_one_slack_chat_s_failure_never_keeps_another_unread(tmp_path, bugs_home, slack_repo, env, capsys):
    # Projects are read in registration order: the failing one first.
    register(bugs_home, tmp_path / "repo-sla2", "sla2", "G0SECOND", "sla2-bugs", channel="slack")
    api = FakeSlack()
    api.history["G0SECOND"] = [msg(ts(2), "un bug du second", "U0BOB")]
    real = api._answer

    def answer(method: str, params: dict) -> dict:
        if method == "conversations.history" and params["channel"] == CHANNEL:
            return {"ok": False, "error": "channel_not_found"}
        return real(method, params)

    api._answer = answer

    code = cli.main(["pull"], transport=Both(FakeTelegram(), api), env=env, now=NOW)

    assert code == 1 and "conversations.history: channel_not_found" in capsys.readouterr().err
    assert [c["params"]["channel"] for c in api.calls if c["method"] == "conversations.history"] == [CHANNEL, "G0SECOND"]
    assert reports_of(bugs_home, "sla") == {} and len(reports_of(bugs_home, "sla2")) == 1
    assert Machine(bugs_home).load_cursor("slack") == {"G0SECOND": {"ts": ts(2), "threads": {}}}
