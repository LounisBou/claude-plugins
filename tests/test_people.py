"""A memory per interlocutor: dated notes in ``people/<author_id>.json``, outside git, never sent anywhere."""

from __future__ import annotations

import json
from pathlib import Path

from samples import BASE_DATE, FakeTelegram
from test_mention import DOCS, STAMP, write_report


def person_json(home: Path, key: str) -> dict:
    return json.loads((home / "people" / f"{key}.json").read_text())


def test_person_note_by_report_id_creates_the_card_keyed_by_author_id(run, bound, capsys):
    write_report(bound, 5, author="Laura", author_id=1776440711, author_username=None)
    tg = FakeTelegram()

    assert run("person-note", f"{STAMP}-5", "iPhone SE, iOS 26.6.2", transport=tg, now=BASE_DATE) == 0

    card = person_json(bound, "1776440711")
    assert card["name"] == "Laura" and card["author_id"] == 1776440711
    assert [n["text"] for n in card["notes"]] == ["iPhone SE, iOS 26.6.2"]
    assert card["notes"][0]["date"].startswith("20")
    assert tg.sent == []  # nothing goes to Telegram


def test_notes_accumulate_and_person_prints_them_by_report_id_or_author_id(run, bound, capsys):
    write_report(bound, 5, author="Laura", author_id=1776440711, author_username=None)
    assert run("person-note", f"{STAMP}-5", "PWA sur l'écran d'accueil", now=BASE_DATE) == 0
    assert run("person-note", "1776440711", "répond vite, avec captures", now=BASE_DATE + 60) == 0
    capsys.readouterr()

    for ref in (f"{STAMP}-5", "1776440711"):
        assert run("person", ref) == 0
        out = capsys.readouterr().out
        assert "Laura" in out and "PWA sur l'écran d'accueil" in out and "répond vite, avec captures" in out
        assert out.index("PWA") < out.index("répond")


def test_person_without_a_card_says_so_for_a_report_and_fails_for_an_unknown_id(run, bound, capsys):
    write_report(bound, 5, author="Laura", author_id=1776440711, author_username=None)

    assert run("person", f"{STAMP}-5") == 0
    assert "no notes" in capsys.readouterr().out
    assert run("person", "999") != 0
    assert "no such person" in capsys.readouterr().err


def test_a_report_without_author_id_falls_back_to_the_author_name(run, bound):
    write_report(bound, 5, author="Zoé D.")

    assert run("person-note", f"{STAMP}-5", "préfère le tutoiement", now=BASE_DATE) == 0

    [card] = list((bound / "people").glob("*.json"))
    assert json.loads(card.read_text())["name"] == "Zoé D."
    assert "/" not in card.name[:-5] and card.name.startswith("name-")


def test_person_refuses_a_ref_that_could_leave_the_directory(run, bound, capsys):
    assert run("person-note", "../state", "x", now=BASE_DATE) != 0
    assert not (bound / "people").exists()


def test_person_note_refuses_an_empty_text(run, bound):
    write_report(bound, 5, author="Laura", author_id=1, author_username=None)

    assert run("person-note", f"{STAMP}-5", "  ") != 0
    assert not (bound / "people").exists()


def test_the_memory_is_documented_and_the_agent_may_use_it():
    agent, skill = DOCS["AGENT.md"].read_text(), DOCS["SKILL.md"].read_text()
    for command in ("person <", "person-note <"):
        assert command in agent and command in skill
