"""Each person's language: recorded by Pull on first sight, corrected by the agent, the project's only a default."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fake_channel import FakeChannel, inbound
from fake_channel import author as fake_author
from fake_channel import batch as fake_batch
from samples import BASE_DATE, GROUP_ID
from test_mention import DOCS, STAMP, write_report

from bugs_bot import pull
from bugs_bot.people import language_of, record_language
from bugs_bot.store import Machine, Store

LAURA = fake_author(7, None, "Laura", language="fr-FR")


def card(home: Path, key: str) -> dict:
    return json.loads((home / "people" / f"{key}.json").read_text())


def pull_from(bugs_home: Path, *messages) -> None:
    pull.cmd_pull(FakeChannel(fake_batch(*messages)), Machine(bugs_home), BASE_DATE + 60)


# -- recorded by Pull, never overwritten -------------------------------------------------------


def test_pull_records_the_language_on_first_sight(bound, bugs_home):
    pull_from(bugs_home, inbound(GROUP_ID, 100, "ça plante", author=LAURA))

    assert card(bound, "7") == {"key": "7", "name": "Laura", "author_id": 7, "notes": [], "language": "fr"}


def test_pull_never_overwrites_a_language_already_there(bound, bugs_home):
    pull_from(bugs_home, inbound(GROUP_ID, 100, "ça plante", author=LAURA))

    pull_from(bugs_home, inbound(GROUP_ID, 101, "it crashes", author=fake_author(7, None, "Laura", language="en")))

    assert card(bound, "7")["language"] == "fr"


def test_the_agents_correction_survives_the_next_pull(run, bound, bugs_home, capsys):
    pull_from(bugs_home, inbound(GROUP_ID, 100, "ça plante", author=LAURA))

    assert run("person-lang", "7", "en") == 0
    pull_from(bugs_home, inbound(GROUP_ID, 101, "encore", author=LAURA))

    assert card(bound, "7")["language"] == "en"
    assert "language 7: en" in capsys.readouterr().out


def test_pull_records_nothing_for_an_author_without_a_language(bound, bugs_home):
    pull_from(bugs_home, inbound(GROUP_ID, 100, "x", author=fake_author(7, None, "Laura")))

    assert not (bound / "people").exists()


def test_recording_keeps_the_notes_of_an_existing_card(run, bound):
    write_report(bound, 5, author="Laura", author_id=7, author_username=None)
    run("person-note", f"{STAMP}-5", "iPhone SE", now=BASE_DATE)

    record_language(Store(bound), LAURA)

    assert card(bound, "7")["language"] == "fr"
    assert [n["text"] for n in card(bound, "7")["notes"]] == ["iPhone SE"]


def test_an_author_without_an_id_is_recorded_under_their_name(bound):
    record_language(Store(bound), fake_author(None, None, "Zoé D.", language="ES"))

    assert card(bound, "name-zo-d")["language"] == "es"


@pytest.mark.parametrize("code", ["", "f", "1a", "é"])
def test_a_platform_code_that_is_not_two_letters_is_not_recorded(bound, code):
    record_language(Store(bound), fake_author(7, None, "Laura", language=code))

    assert not (bound / "people").exists()


# -- shown by person, corrected by person-lang --------------------------------------------------


def test_person_shows_the_language_or_says_it_is_unknown(run, bound, capsys):
    write_report(bound, 5, author="Laura", author_id=7, author_username=None)

    run("person", f"{STAMP}-5")
    assert "language: unknown" in capsys.readouterr().out

    run("person-lang", f"{STAMP}-5", "it")
    capsys.readouterr()
    run("person", f"{STAMP}-5")
    assert "language: it" in capsys.readouterr().out.splitlines()


@pytest.mark.parametrize("code", ["FR", "fra", "f", "", "f1"])
def test_person_lang_refuses_a_code_that_is_not_two_lower_case_letters(run, bound, capsys, code):
    write_report(bound, 5, author="Laura", author_id=7, author_username=None)

    assert run("person-lang", f"{STAMP}-5", code) == 1

    assert "not a language code" in capsys.readouterr().err
    assert not (bound / "people").exists()


def test_person_lang_by_report_id_of_an_author_without_id_uses_the_name_card(run, bound):
    write_report(bound, 5, author="Zoé D.")

    assert run("person-lang", f"{STAMP}-5", "es") == 0

    assert card(bound, "name-zo-d")["language"] == "es"


# -- the person's language first, the project's as the default ---------------------------------


def test_language_of_is_the_persons_then_the_projects(bound):
    store = Store(bound)
    record_language(store, LAURA)

    assert language_of(store, "en", 7, "Laura") == "fr"
    assert language_of(store, "en", 8, "Mathis") == "en"
    assert language_of(store, "en", None, "Zoé") == "en"


def test_language_of_a_card_without_language_is_the_projects(run, bound):
    write_report(bound, 5, author="Laura", author_id=7, author_username=None)
    run("person-note", f"{STAMP}-5", "iPhone SE", now=BASE_DATE)

    assert language_of(Store(bound), "de", 7, "Laura") == "de"


# -- the agent writes in each person's language --------------------------------------------------


@pytest.mark.parametrize("phrase", [
    "written in their language",
    "`person-lang <report-id> <code>` first",
    "the project's `language` is the default only",
])
def test_the_agent_writes_to_each_person_in_their_language(phrase):
    assert phrase in DOCS["AGENT.md"].read_text()


def test_the_skill_documents_person_lang():
    assert "person-lang <report-id\\|author_id> <code>" in DOCS["SKILL.md"].read_text()


def test_the_startup_prompt_gives_the_projects_language_as_the_default(run, bound, capsys):
    from test_agent_prompt import prompt_of

    assert "default language of your messages in the group (a person's own language comes first)" in prompt_of(run, capsys)
