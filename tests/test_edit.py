"""``edit``: rewrite a reply the bot already posted, keeping the previous text."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from samples import BASE_DATE, GROUP_ID, FakeTelegram
from test_mention import DOCS, STAMP, report_json, write_report

RID = f"{STAMP}-5"


def two_replies(home: Path, **fields) -> None:
    write_report(
        home, 5,
        replies=[
            {"date": "2026-10-02T12:40:00+00:00", "text": "premier", "message_id": 901},
            {"date": "2026-10-02T12:41:00+00:00", "text": "second", "message_id": 902},
        ],
        **fields,
    )


def test_edit_rewrites_the_last_reply_in_the_right_chat(run, bound):
    two_replies(bound)
    tg = FakeTelegram()

    assert run("edit", RID, "nouveau", transport=tg, now=BASE_DATE) == 0

    assert tg.edited == [{"chat_id": GROUP_ID, "message_id": 902, "text": "nouveau"}]
    assert tg.sent == []


def test_edit_reply_n_targets_the_nth_reply_one_based(run, bound):
    two_replies(bound)
    tg = FakeTelegram()

    assert run("edit", RID, "nouveau", "--reply", "1", transport=tg, now=BASE_DATE) == 0

    assert tg.edited[0]["message_id"] == 901
    replies = report_json(bound, 5)["replies"]
    assert (replies[0]["text"], replies[1]["text"]) == ("nouveau", "second")


def test_the_record_holds_the_new_text_and_keeps_the_previous_one(run, bound):
    two_replies(bound)

    assert run("edit", RID, "nouveau", transport=FakeTelegram(), now=BASE_DATE) == 0

    reply = report_json(bound, 5)["replies"][1]
    assert reply["text"] == "nouveau" and reply["message_id"] == 902
    [edit] = reply["edits"]
    assert edit["text"] == "second" and edit["date"].startswith("20")
    assert run("edit", RID, "encore", transport=FakeTelegram(), now=BASE_DATE) == 0
    assert [e["text"] for e in report_json(bound, 5)["replies"][1]["edits"]] == ["second", "nouveau"]


def test_edit_mention_with_a_username_keeps_the_mention_entity(run, bound):
    two_replies(bound, author="mathis", author_id=7, author_username="mathis")
    tg = FakeTelegram()

    assert run("edit", RID, "Du neuf", "--mention", transport=tg, now=BASE_DATE) == 0

    [sent] = tg.edited
    assert sent["text"] == "@mathis Du neuf"
    assert sent["entities"] == [{"type": "mention", "offset": 0, "length": 7}]
    assert report_json(bound, 5)["replies"][1]["text"] == "@mathis Du neuf"


def test_edit_mention_without_a_username_uses_a_text_mention(run, bound):
    two_replies(bound, author_id=1776440711, author_username=None)
    tg = FakeTelegram()

    assert run("edit", RID, "Du neuf", "--mention", transport=tg, now=BASE_DATE) == 0

    assert tg.edited[0]["entities"] == [{"type": "text_mention", "offset": 0, "length": 5, "user": {"id": 1776440711}}]


def test_edit_without_mention_sends_no_entities(run, bound):
    two_replies(bound, author_id=1, author_username="a")
    tg = FakeTelegram()

    assert run("edit", RID, "x", transport=tg, now=BASE_DATE) == 0

    assert "entities" not in tg.edited[0]


def test_edit_mention_refused_without_id_or_username(run, bound, capsys):
    two_replies(bound)
    tg = FakeTelegram()

    assert run("edit", RID, "x", "--mention", transport=tg) != 0

    assert tg.edited == [] and "cannot mention" in capsys.readouterr().err
    assert report_json(bound, 5)["replies"][1]["text"] == "second"


@pytest.mark.parametrize("extra", [["--reply", "3"], ["--reply", "0"]])
def test_edit_refuses_a_reply_that_does_not_exist(run, bound, capsys, extra):
    two_replies(bound)
    tg = FakeTelegram()

    assert run("edit", RID, "x", *extra, transport=tg) != 0

    assert tg.edited == [] and "no such reply" in capsys.readouterr().err


def test_edit_refuses_a_report_without_replies(run, bound, capsys):
    write_report(bound, 5)
    tg = FakeTelegram()

    assert run("edit", RID, "x", transport=tg) != 0

    assert tg.edited == [] and "no such reply" in capsys.readouterr().err


def test_edit_refuses_a_reply_without_message_id(run, bound, capsys):
    write_report(bound, 5, replies=[{"date": "2026-10-02T12:40:00+00:00", "text": "vieux"}])
    tg = FakeTelegram()

    assert run("edit", RID, "x", transport=tg) != 0

    assert tg.edited == [] and "message_id" in capsys.readouterr().err


@pytest.mark.parametrize("text", ["", "   "])
def test_edit_refuses_an_empty_text(run, bound, capsys, text):
    two_replies(bound)
    tg = FakeTelegram()

    assert run("edit", RID, text, transport=tg) != 0

    assert tg.edited == [] and "empty" in capsys.readouterr().err


def test_message_is_not_modified_is_reported_as_such_with_exit_zero(run, bound, capsys):
    two_replies(bound)
    tg = FakeTelegram()
    tg.edit_error = "Bad Request: message is not modified: specified new message content is the same"

    assert run("edit", RID, "second", transport=tg, now=BASE_DATE) == 0

    assert "not modified" in capsys.readouterr().out
    assert "edits" not in report_json(bound, 5)["replies"][1]


def test_another_telegram_error_fails_and_leaves_the_record_alone(run, bound, capsys):
    two_replies(bound)
    tg = FakeTelegram()
    tg.edit_error = "Bad Request: message to edit not found"

    assert run("edit", RID, "x", transport=tg) != 0

    assert "not found" in capsys.readouterr().err
    assert report_json(bound, 5)["replies"][1]["text"] == "second"


def test_edit_unbound_refuses(run, home, capsys):
    assert run("edit", RID, "x") != 0
    assert "unbound" in capsys.readouterr().err


def test_show_numbers_the_replies_and_displays_the_edits_count(run, bound, capsys):
    two_replies(bound)
    assert run("edit", RID, "nouveau", transport=FakeTelegram(), now=BASE_DATE) == 0
    capsys.readouterr()

    assert run("show", RID) == 0

    lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith("reply")]
    assert lines[0].startswith("reply 1 ") and lines[0].endswith("premier")
    assert lines[1].startswith("reply 2 ") and lines[1].endswith("nouveau (1 edit)")


def test_skill_documents_edit_and_the_voice_prefers_it():
    skill = DOCS["SKILL.md"].read_text()
    assert "| `edit <id>" in skill
    assert "prefer it to a second message" in skill


def test_agent_may_use_edit_on_the_launchers_rewrite_phrase():
    agent = DOCS["AGENT.md"].read_text()
    assert "edit <id>" in agent and "réécrire <id>" in agent
