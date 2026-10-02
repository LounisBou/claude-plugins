"""The agent deletes a message it posted: through the channel, the reply kept in the report and marked deleted."""

from __future__ import annotations

import json

import pytest
from fake_channel import FakeChannel
from samples import BASE_DATE, GROUP_ID, TOKEN, FakeTelegram
from test_mention import DOCS, STAMP, write_report

from bugs_bot.errors import BugsError
from bugs_bot.reports import cmd_delete
from bugs_bot.store import Store
from bugs_bot.telegram import TelegramChannel

REPORT = f"{STAMP}-5"
REPLIES = [
    {"date": "2026-10-02T08:31:00+00:00", "text": "Merci !", "message_id": 901},
    {"date": "2026-10-02T08:32:00+00:00", "text": "Tu es sur quel iPhone ?", "message_id": 902},
    {"date": "2026-10-02T08:33:00+00:00", "text": "Et quelle version d'iOS ?", "message_id": 903},
]


def report(bound) -> dict:
    return json.loads((bound / "inbox" / REPORT / "report.json").read_text())


@pytest.fixture
def replied(bound):
    write_report(bound, 5, author="Laura", author_id=7, replies=[dict(r) for r in REPLIES])
    return bound


def test_delete_removes_the_nth_reply_through_the_channel_and_keeps_it_marked(replied):
    channel = FakeChannel()

    cmd_delete(channel, Store(replied), GROUP_ID, REPORT, BASE_DATE, 2)

    assert channel.calls == [("delete", GROUP_ID, 902)]
    replies = report(replied)["replies"]
    assert replies[1] == REPLIES[1] | {"deleted": "2026-10-02T08:30:00+00:00"}
    assert replies[0] == REPLIES[0] and replies[2] == REPLIES[2]


def test_delete_without_a_number_removes_the_last_reply(replied):
    channel = FakeChannel()

    cmd_delete(channel, Store(replied), GROUP_ID, REPORT, BASE_DATE)

    assert channel.calls == [("delete", GROUP_ID, 903)]
    assert "deleted" in report(replied)["replies"][2]


def test_a_second_delete_of_the_same_reply_is_refused_and_calls_nothing(replied):
    cmd_delete(FakeChannel(), Store(replied), GROUP_ID, REPORT, BASE_DATE, 2)
    channel = FakeChannel()

    with pytest.raises(BugsError, match="reply 2 of .* is already deleted"):
        cmd_delete(channel, Store(replied), GROUP_ID, REPORT, BASE_DATE + 60, 2)

    assert channel.calls == []
    assert report(replied)["replies"][1]["deleted"] == "2026-10-02T08:30:00+00:00"


def test_deleting_the_awaited_reply_lifts_the_wait(bound):
    awaiting = {"since": "2026-10-02T08:32:00+00:00", "reply": 2}
    write_report(bound, 5, author="Laura", author_id=7, replies=[dict(r) for r in REPLIES], awaiting=awaiting)

    cmd_delete(FakeChannel(), Store(bound), GROUP_ID, REPORT, BASE_DATE, 2)

    assert "awaiting" not in report(bound)


def test_deleting_another_reply_keeps_the_wait(bound):
    awaiting = {"since": "2026-10-02T08:33:00+00:00", "reply": 3}
    write_report(bound, 5, author="Laura", author_id=7, replies=[dict(r) for r in REPLIES], awaiting=awaiting)

    cmd_delete(FakeChannel(), Store(bound), GROUP_ID, REPORT, BASE_DATE, 1)

    assert report(bound)["awaiting"] == awaiting


@pytest.mark.parametrize("number, error", [(0, "no such reply"), (4, "no such reply")])
def test_delete_refuses_a_reply_that_does_not_exist(replied, number, error):
    with pytest.raises(BugsError, match=error):
        cmd_delete(FakeChannel(), Store(replied), GROUP_ID, REPORT, BASE_DATE, number)


def test_delete_refuses_a_reply_without_message_id(bound):
    write_report(bound, 5, author="Laura", replies=[{"date": "2026-10-02T08:31:00+00:00", "text": "vieux"}])

    with pytest.raises(BugsError, match="no message_id"):
        cmd_delete(FakeChannel(), Store(bound), GROUP_ID, REPORT, BASE_DATE)


def test_a_refused_delete_marks_nothing(replied):
    class Refusing(FakeChannel):
        def delete(self, chat_id, message_id):
            raise BugsError("deleteMessage: Bad Request: message can't be deleted")

    with pytest.raises(BugsError, match="can't be deleted"):
        cmd_delete(Refusing(), Store(replied), GROUP_ID, REPORT, BASE_DATE, 2)

    assert report(replied)["replies"] == REPLIES


def test_a_reply_already_gone_from_the_group_is_marked_deleted_and_lifts_the_wait(bound, capsys):
    class Gone(FakeChannel):
        def delete(self, chat_id, message_id):
            raise BugsError("deleteMessage: Bad Request: message to delete not found")

    awaiting = {"since": "2026-10-02T08:32:00+00:00", "reply": 2}
    write_report(bound, 5, author="Laura", author_id=7, replies=[dict(r) for r in REPLIES], awaiting=awaiting)

    cmd_delete(Gone(), Store(bound), GROUP_ID, REPORT, BASE_DATE, 2)

    assert report(bound)["replies"][1]["deleted"] == "2026-10-02T08:30:00+00:00"
    assert "awaiting" not in report(bound)
    assert capsys.readouterr().out == f"deleted reply 2 of {REPORT} (already gone from the group)\n"


def test_a_refused_delete_keeps_the_wait(bound):
    class Refusing(FakeChannel):
        def delete(self, chat_id, message_id):
            raise BugsError("deleteMessage: Bad Request: message can't be deleted")

    awaiting = {"since": "2026-10-02T08:32:00+00:00", "reply": 2}
    write_report(bound, 5, author="Laura", author_id=7, replies=[dict(r) for r in REPLIES], awaiting=awaiting)

    with pytest.raises(BugsError, match="can't be deleted"):
        cmd_delete(Refusing(), Store(bound), GROUP_ID, REPORT, BASE_DATE, 2)

    assert report(bound)["awaiting"] == awaiting and "deleted" not in report(bound)["replies"][1]


# -- through the command line ----------------------------------------------------------------


def test_the_cli_deletes_the_nth_reply_and_show_marks_it(run, replied, capsys):
    tg = FakeTelegram()

    assert run("delete", REPORT, "--reply", "2", transport=tg, now=BASE_DATE) == 0

    assert [p for u, p in tg.calls if u.endswith("/deleteMessage")] == [{"chat_id": GROUP_ID, "message_id": 902}]
    assert f"deleted reply 2 of {REPORT}" in capsys.readouterr().out
    run("show", REPORT)
    lines = capsys.readouterr().out.splitlines()
    assert "reply 2 2026-10-02T08:32:00+00:00: Tu es sur quel iPhone ? (deleted 2026-10-02T08:30:00+00:00)" in lines


def test_the_cli_refuses_a_second_delete(run, replied, capsys):
    run("delete", REPORT, transport=FakeTelegram(), now=BASE_DATE)

    assert run("delete", REPORT, transport=FakeTelegram(), now=BASE_DATE) == 1

    assert "already deleted" in capsys.readouterr().err


def test_a_deleted_reply_cannot_be_edited(run, replied, capsys):
    run("delete", REPORT, "--reply", "2", transport=FakeTelegram(), now=BASE_DATE)
    tg = FakeTelegram()

    assert run("edit", REPORT, "autre chose", "--reply", "2", transport=tg, now=BASE_DATE) == 1

    assert tg.edited == [] and "deleted" in capsys.readouterr().err


def test_telegram_deletes_with_delete_message():
    tg = FakeTelegram()

    TelegramChannel(TOKEN, tg).delete(GROUP_ID, 902)

    assert tg.calls == [(f"https://api.telegram.org/bot{TOKEN}/deleteMessage", {"chat_id": GROUP_ID, "message_id": 902})]


# -- the agent deletes its own messages, on its own judgment --------------------------------------


@pytest.mark.parametrize("phrase", [
    "`delete <id> [--reply N]`",
    "on your own judgment",
    "a wrong fact, a duplicate, a message posted on the wrong report",
    "never a tester's message",
    "its content posted on that report with `reply`",
])
def test_the_agent_edits_or_deletes_its_own_messages_on_its_own_judgment(phrase):
    assert phrase in DOCS["AGENT.md"].read_text()


def test_the_skill_documents_delete():
    assert "| `delete <id> [--reply N]` |" in DOCS["SKILL.md"].read_text()
