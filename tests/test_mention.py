"""Mentioning a report's author, recording who wrote it, recovering ids of older reports."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import REPO_ROOT
from samples import BASE_DATE, GROUP_ID, FakeTelegram, message

STAMP = "20261002-083000"


def report_json(home: Path, message_id: int) -> dict:
    return json.loads((home / "inbox" / f"{STAMP}-{message_id}" / "report.json").read_text())


def write_report(home: Path, message_id: int, **fields) -> Path:
    """Write a report as an older version of the tool would have (no author id)."""
    path = home / "inbox" / f"{STAMP}-{message_id}"
    path.mkdir(parents=True)
    report = {
        "id": f"{STAMP}-{message_id}", "chat_id": GROUP_ID, "message_ids": [message_id], "media_group_id": None,
        "date": "2026-10-02T08:30:00+00:00", "author": "Laura", "text": "bug", "images": [], "status": "taken",
        "reaction": {"wanted": "x", "applied": "x", "error": None}, "replies": [],
    } | fields
    (path / "report.json").write_text(json.dumps(report))
    return path


def from_user(update: dict, **user) -> dict:
    update["message"]["from"] = {"is_bot": False} | user
    return update


# -- recording the author ---------------------------------------------------------


def test_pull_records_the_author_id_and_username(run, bound):
    assert run("pull", transport=FakeTelegram([message(10, 1, text="a")])) == 0

    report = report_json(bound, 1)
    assert (report["author"], report["author_id"], report["author_username"]) == ("izno_op", 42, "izno_op")


def test_pull_records_no_username_as_null_and_keeps_the_display_name(run, bound):
    update = from_user(message(10, 1, text="a"), id=1776440711, first_name="Laura")

    assert run("pull", transport=FakeTelegram([update])) == 0

    report = report_json(bound, 1)
    assert (report["author"], report["author_id"], report["author_username"]) == ("Laura", 1776440711, None)


# -- --mention --------------------------------------------------------------------


def test_reply_mention_with_a_username_prefixes_it_and_sends_a_mention_entity(run, bound):
    write_report(bound, 5, author="mathis", author_id=7, author_username="mathis")
    tg = FakeTelegram()

    assert run("reply", f"{STAMP}-5", "Quel navigateur ?", "--mention", transport=tg) == 0

    [sent] = tg.sent
    assert sent["text"] == "@mathis Quel navigateur ?"
    assert sent["entities"] == [{"type": "mention", "offset": 0, "length": 7}]
    assert sent["reply_parameters"] == {"message_id": 5}
    assert report_json(bound, 5)["replies"][0]["text"] == "@mathis Quel navigateur ?"


def test_reply_mention_without_a_username_uses_a_text_mention_with_the_user_id(run, bound):
    write_report(bound, 5, author_id=1776440711, author_username=None)
    tg = FakeTelegram()

    assert run("reply", f"{STAMP}-5", "Quel modèle ?", "--mention", transport=tg) == 0

    [sent] = tg.sent
    assert sent["text"] == "Laura Quel modèle ?"
    assert sent["entities"] == [{"type": "text_mention", "offset": 0, "length": 5, "user": {"id": 1776440711}}]


def test_entity_length_counts_utf16_units(run, bound):
    write_report(bound, 5, author="Zoé 😀", author_id=9, author_username=None)
    tg = FakeTelegram()

    assert run("reply", f"{STAMP}-5", "é", "--mention", transport=tg) == 0

    [entity] = tg.sent[0]["entities"]
    assert tg.sent[0]["text"] == "Zoé 😀 é"
    assert entity["length"] == 6  # Z o é space + one emoji of two UTF-16 units


def test_mention_is_refused_when_the_report_has_neither_id_nor_username(run, bound, capsys):
    write_report(bound, 5)
    tg = FakeTelegram()

    assert run("reply", f"{STAMP}-5", "x", "--mention", transport=tg) != 0

    assert tg.sent == []
    err = capsys.readouterr().err
    assert "cannot mention" in err and "backfill-authors" in err
    assert report_json(bound, 5)["replies"] == []


def test_reply_without_mention_is_unchanged(run, bound):
    write_report(bound, 5, author_id=1, author_username="a")
    tg = FakeTelegram()

    assert run("reply", f"{STAMP}-5", "x", transport=tg) == 0

    assert "entities" not in tg.sent[0] and tg.sent[0]["text"] == "x"


def test_post_mention_names_the_author_of_a_report_and_is_not_threaded(run, bound):
    write_report(bound, 5, author_id=1776440711, author_username=None)
    tg = FakeTelegram()

    assert run("post", "Corrigé, pouvez-vous vérifier ?", "--mention", f"{STAMP}-5", transport=tg, now=BASE_DATE) == 0

    [sent] = tg.sent
    assert sent["text"] == "Laura Corrigé, pouvez-vous vérifier ?"
    assert sent["entities"][0]["type"] == "text_mention"
    assert "reply_parameters" not in sent
    assert json.loads((bound / "state.json").read_text())["posts"][0]["text"] == sent["text"]


def test_post_mention_refused_without_id_or_username(run, bound, capsys):
    write_report(bound, 5)
    tg = FakeTelegram()

    assert run("post", "x", "--mention", f"{STAMP}-5", transport=tg) != 0

    assert tg.sent == [] and "cannot mention" in capsys.readouterr().err


# -- backfill-authors ---------------------------------------------------------------

LAURA = {"status": "administrator", "user": {"id": 1776440711, "is_bot": False, "first_name": "Laura"}}
BOT = {"status": "administrator", "user": {"id": 8, "is_bot": True, "first_name": "Clawdbot", "username": "ClawBot"}}
OWNER = {"status": "creator", "user": {"id": 5, "is_bot": False, "first_name": "Izno", "username": "izno_op"}}


def test_backfill_recovers_the_id_of_a_unique_administrator_when_every_member_is_listed(run, bound, capsys):
    write_report(bound, 5)
    write_report(bound, 6, author="izno_op")
    tg = FakeTelegram()
    tg.admins, tg.member_count = [BOT, LAURA, OWNER], 3

    assert run("backfill-authors", transport=tg) == 0

    laura = report_json(bound, 5)
    assert (laura["author_id"], laura["author_username"]) == (1776440711, None)
    owner = report_json(bound, 6)
    assert (owner["author_id"], owner["author_username"]) == (5, "izno_op")
    assert "20261002-083000-5" in capsys.readouterr().out


def test_backfill_leaves_reports_alone_when_the_group_has_members_it_cannot_list(run, bound, capsys):
    write_report(bound, 5)
    tg = FakeTelegram()
    tg.admins, tg.member_count = [BOT, LAURA, OWNER], 4  # a plain member could be another « Laura »

    assert run("backfill-authors", transport=tg) == 0

    assert "author_id" not in report_json(bound, 5)
    assert "not proven" in capsys.readouterr().out


def test_backfill_leaves_reports_alone_when_two_administrators_share_the_name(run, bound):
    write_report(bound, 5)
    twin = {"status": "administrator", "user": {"id": 99, "is_bot": False, "first_name": "Laura"}}
    tg = FakeTelegram()
    tg.admins, tg.member_count = [LAURA, twin], 2

    assert run("backfill-authors", transport=tg) == 0

    assert "author_id" not in report_json(bound, 5)


def test_backfill_skips_reports_that_already_have_an_id_and_unknown_names(run, bound):
    write_report(bound, 5, author_id=1, author_username=None)
    write_report(bound, 6, author="Inconnu")
    tg = FakeTelegram()
    tg.admins, tg.member_count = [LAURA], 1

    assert run("backfill-authors", transport=tg) == 0

    assert report_json(bound, 5)["author_id"] == 1
    assert "author_id" not in report_json(bound, 6)


def test_backfill_unbound_refuses(run, home, capsys):
    assert run("backfill-authors") != 0
    assert "no .bugs-bot.json here or above" in capsys.readouterr().err


# -- the method is written down --------------------------------------------------------

DOCS = {
    "AGENT.md": REPO_ROOT / "agent" / "AGENT.md",
    "SKILL.md": REPO_ROOT / "skills" / "bugs-bot" / "SKILL.md",
}


@pytest.mark.parametrize("phrase", ["vérifier <id>", "demander <id>", "--mention"])
def test_agent_instructions_know_the_mention_phrases(phrase):
    assert phrase in DOCS["AGENT.md"].read_text()


@pytest.mark.parametrize("phrase", ["Talking to a reporter", "DEPLOYED", "tm-design-follow", "vérifier <id>", "backfill-authors"])
def test_skill_states_the_ask_fix_verify_method(phrase):
    assert phrase in DOCS["SKILL.md"].read_text()


@pytest.mark.parametrize("file, phrases", [
    ("AGENT.md", ["Answer a follow-up yourself", "never their fault", "still relay"]),
    ("SKILL.md", ["Answer every word a tester sends", "Pas de soucis, c'est que c'était pas clair"]),
])
def test_the_agent_answers_a_testers_follow_up_warmly(file, phrases):
    text = DOCS[file].read_text()
    for phrase in phrases:
        assert phrase in text


def test_the_voice_rule_is_in_the_skill_and_the_agent_points_to_it():
    assert "### The voice" in DOCS["SKILL.md"].read_text()
    assert "The voice" in DOCS["AGENT.md"].read_text()
