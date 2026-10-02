"""One question at a time per person: a second question while they owe an answer is queued, asked once they answer."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from samples import BASE_DATE, FakeTelegram
from test_followup import person_message
from test_mention import DOCS, STAMP, write_report

HOUR = 3600
FIRST, SECOND, MATHIS = f"{STAMP}-5", f"{STAMP}-6", f"{STAMP}-9"


@pytest.fixture
def laura(bound) -> Path:
    """Two open reports of Laura (id 7), one of Mathis (id 8)."""
    write_report(bound, 5, author="Laura", author_id=7, text="la liste saute")
    write_report(bound, 6, author="Laura", author_id=7, text="le bouton Lecture ne répond pas")
    write_report(bound, 9, author="Mathis", author_id=8, text="écran noir")
    return bound


def card(home: Path, key: str = "7") -> dict:
    return json.loads((home / "people" / f"{key}.json").read_text())


def report(home: Path, report_id: str) -> dict:
    return json.loads((home / "inbox" / report_id / "report.json").read_text())


def wait_lines(run, capsys, now: float = BASE_DATE + 120) -> list[str]:
    capsys.readouterr()
    assert run("wait", "--timeout", "0", now=now) == 0
    return capsys.readouterr().out.splitlines()


def laura_answers(run, at: float = BASE_DATE + 60) -> None:
    """Laura writes in the group: Pull lifts what she was asked before."""
    tg = FakeTelegram([person_message(10, 100, user_id=7, name="Laura", date=int(at), text="iPhone SE")])
    assert run("pull", transport=tg, now=at + 1) == 0


@pytest.fixture
def queued(run, laura, capsys) -> FakeTelegram:
    """Laura asked about FIRST, then a second question about SECOND queued; returns the second call's transport."""
    assert run("reply", FIRST, "Tu es sur quel iPhone ?", "--awaits", now=BASE_DATE) == 0
    tg = FakeTelegram()
    assert run("reply", SECOND, "Il répond au deuxième appui ?", "--awaits", transport=tg, now=BASE_DATE + 10) == 0
    return tg


# -- a second question is queued, not posted ---------------------------------------------------


def test_a_second_question_to_the_same_person_is_queued_not_posted(queued, laura, capsys):
    assert queued.sent == []
    assert capsys.readouterr().out.strip().splitlines()[-1] == f"queued {SECOND}: Laura already awaits {FIRST}"
    assert card(laura)["questions"] == [
        {"report": SECOND, "text": "Il répond au deuxième appui ?", "queued": "2026-10-02T08:30:10+00:00"}
    ]
    assert "awaiting" not in report(laura, SECOND) and report(laura, SECOND)["replies"] == []


def test_a_reply_that_asks_nothing_is_still_posted(queued, run, laura):
    tg = FakeTelegram()

    assert run("reply", SECOND, "Merci pour la capture !", transport=tg, now=BASE_DATE + 20) == 0

    assert len(tg.sent) == 1


def test_a_new_question_on_the_report_already_awaited_is_posted(run, laura):
    run("reply", FIRST, "Tu es sur quel iPhone ?", "--awaits", now=BASE_DATE)
    tg = FakeTelegram()

    assert run("reply", FIRST, "Et quelle version d'iOS ?", "--awaits", transport=tg, now=BASE_DATE + 10) == 0

    assert len(tg.sent) == 1 and report(laura, FIRST)["awaiting"]["reply"] == 2


def test_two_people_never_block_each_other(run, laura):
    run("reply", FIRST, "Tu es sur quel iPhone ?", "--awaits", now=BASE_DATE)
    tg = FakeTelegram()

    assert run("reply", MATHIS, "Tu es sur quel navigateur ?", "--awaits", transport=tg, now=BASE_DATE + 10) == 0

    assert len(tg.sent) == 1 and "awaiting" in report(laura, MATHIS)


def test_a_wait_on_a_done_report_blocks_nothing(run, laura):
    run("reply", FIRST, "Tu peux vérifier ?", "--awaits", now=BASE_DATE)
    run("done", FIRST, now=BASE_DATE + 5)
    tg = FakeTelegram()

    assert run("reply", SECOND, "Il répond au deuxième appui ?", "--awaits", transport=tg, now=BASE_DATE + 10) == 0

    assert len(tg.sent) == 1


# -- their answer surfaces the next question ----------------------------------------------------


def test_wait_says_nothing_of_the_queue_while_the_person_owes_an_answer(queued, run, capsys):
    assert f"ask {SECOND}" not in wait_lines(run, capsys)


def test_their_answer_makes_wait_print_ask(queued, run, capsys):
    laura_answers(run)

    assert f"ask {SECOND}" in wait_lines(run, capsys)


def test_posting_the_queued_question_takes_it_off_the_queue(queued, run, laura, capsys):
    laura_answers(run)
    tg = FakeTelegram()

    assert run("reply", SECOND, "Et le bouton Lecture, il répond au deuxième appui ?", "--awaits", transport=tg, now=BASE_DATE + 90) == 0

    assert len(tg.sent) == 1 and card(laura)["questions"] == []
    assert f"ask {SECOND}" not in wait_lines(run, capsys)


def test_questions_surface_one_at_a_time_oldest_first(queued, run, laura, capsys):
    write_report(laura, 7, author="Laura", author_id=7, text="un troisième sujet")
    third = f"{STAMP}-7"
    run("reply", third, "Ça arrive aussi en Wi-Fi ?", "--awaits", now=BASE_DATE + 20)
    laura_answers(run)

    lines = wait_lines(run, capsys)

    assert f"ask {SECOND}" in lines and f"ask {third}" not in lines


def test_deleting_the_awaited_question_surfaces_the_next(queued, run, capsys):
    run("delete", FIRST, now=BASE_DATE + 30)

    assert f"ask {SECOND}" in wait_lines(run, capsys)


def test_a_reminder_is_the_question_in_flight_not_a_new_one(queued, run, laura):
    tg = FakeTelegram()

    assert run("reply", FIRST, "Petite relance : quel iPhone ?", "--follow-up", transport=tg, now=BASE_DATE + 25 * HOUR) == 0

    assert len(tg.sent) == 1 and len(card(laura)["questions"]) == 1


# -- a subject closed meanwhile ---------------------------------------------------------------


def test_a_queued_question_on_a_report_done_meanwhile_is_dropped(queued, run, laura, capsys):
    run("done", SECOND, now=BASE_DATE + 30)
    laura_answers(run)

    assert card(laura)["questions"] == []
    assert not any(line.startswith("ask ") for line in wait_lines(run, capsys))


def test_a_queued_question_on_a_report_gone_from_disk_is_not_asked(queued, run, laura, capsys):
    import shutil

    shutil.rmtree(laura / "inbox" / SECOND)
    laura_answers(run)

    assert not any(line.startswith("ask ") for line in wait_lines(run, capsys))


# -- a wait on a fixed report: « vérifier » is a question like any other ----------------------


@pytest.fixture
def verify(run, laura) -> Path:
    """FIRST is fixed, then Laura is asked to verify it at BASE_DATE."""
    assert run("fixed", FIRST, now=BASE_DATE - 60) == 0
    assert run("reply", FIRST, "Tu peux vérifier ?", "--awaits", now=BASE_DATE) == 0
    return laura


def test_a_wait_on_a_fixed_report_queues_the_next_question(verify, run, capsys):
    tg = FakeTelegram()

    assert run("reply", SECOND, "Il répond au deuxième appui ?", "--awaits", transport=tg, now=BASE_DATE + 10) == 0

    assert tg.sent == [] and [q["report"] for q in card(verify)["questions"]] == [SECOND]
    assert f"ask {SECOND}" not in wait_lines(run, capsys)


def test_their_answer_on_a_fixed_report_makes_wait_print_ask(verify, run, capsys):
    run("reply", SECOND, "Il répond au deuxième appui ?", "--awaits", now=BASE_DATE + 10)
    laura_answers(run)

    assert f"ask {SECOND}" in wait_lines(run, capsys)


def test_a_wait_on_a_fixed_report_is_reminded_once_due(verify, run, capsys):
    assert f"follow-up {FIRST}" not in wait_lines(run, capsys, now=BASE_DATE + 24 * HOUR - 1)

    assert f"follow-up {FIRST}" in wait_lines(run, capsys, now=BASE_DATE + 24 * HOUR)
    assert run("reply", FIRST, "Petite relance : tu as pu vérifier ?", "--follow-up", now=BASE_DATE + 24 * HOUR) == 0
    assert f"unanswered {FIRST}" in wait_lines(run, capsys, now=BASE_DATE + 48 * HOUR)


def test_fixed_keeps_the_queued_questions_of_the_report(queued, run, laura, capsys):
    run("fixed", SECOND, now=BASE_DATE + 30)
    laura_answers(run)

    assert [q["report"] for q in card(laura)["questions"]] == [SECOND]
    assert f"ask {SECOND}" in wait_lines(run, capsys)


# -- an escalated wait no longer holds the person's next questions --------------------------------


@pytest.fixture
def escalated(queued, run) -> None:
    """Laura's wait on FIRST reminded, still unanswered, the launcher told."""
    assert run("reply", FIRST, "Petite relance : quel iPhone ?", "--follow-up", now=BASE_DATE + 24 * HOUR) == 0
    assert run("escalated", FIRST, now=BASE_DATE + 48 * HOUR) == 0


def test_an_escalated_wait_lets_wait_print_ask(escalated, run, laura, capsys):
    assert f"ask {SECOND}" in wait_lines(run, capsys, now=BASE_DATE + 48 * HOUR + 1)
    assert "escalated" in report(laura, FIRST)["awaiting"]


def test_an_escalated_wait_lets_the_next_question_be_posted(escalated, run, laura):
    tg = FakeTelegram()

    assert run("reply", SECOND, "Et le bouton Lecture ?", "--awaits", transport=tg, now=BASE_DATE + 48 * HOUR + 1) == 0

    assert len(tg.sent) == 1 and card(laura)["questions"] == []


# -- one queued question per report ---------------------------------------------------------------


def test_a_second_queue_on_one_report_replaces_its_text_and_keeps_its_place(queued, run, laura):
    write_report(laura, 7, author="Laura", author_id=7, text="un troisième sujet")
    third = f"{STAMP}-7"
    run("reply", third, "Ça arrive aussi en Wi-Fi ?", "--awaits", now=BASE_DATE + 20)

    assert run("reply", SECOND, "Le bouton répond au deuxième appui ?", "--awaits", now=BASE_DATE + 30) == 0

    assert card(laura)["questions"] == [
        {"report": SECOND, "text": "Le bouton répond au deuxième appui ?", "queued": "2026-10-02T08:30:10+00:00"},
        {"report": third, "text": "Ça arrive aussi en Wi-Fi ?", "queued": "2026-10-02T08:30:20+00:00"},
    ]


def test_asking_a_report_queued_twice_leaves_none_of_it(queued, run, laura, capsys):
    run("reply", SECOND, "Le bouton répond au deuxième appui ?", "--awaits", now=BASE_DATE + 30)
    laura_answers(run, at=BASE_DATE + 40)

    assert run("reply", SECOND, "Et le bouton Lecture ?", "--awaits", now=BASE_DATE + 90) == 0

    assert card(laura)["questions"] == []
    run("reply", FIRST, "Merci !", now=BASE_DATE + 95)
    laura_answers(run, at=BASE_DATE + 100)
    assert f"ask {SECOND}" not in wait_lines(run, capsys)


# -- a person without user id: their card, by its key -------------------------------------------


@pytest.fixture
def nameless(run, bound) -> Path:
    """Two reports of « Laura Martin », no user id recorded; asked about the first, the second queued; card name lost."""
    write_report(bound, 5, author="Laura Martin", text="la liste saute")
    write_report(bound, 6, author="Laura Martin", text="le bouton Lecture ne répond pas")
    assert run("reply", FIRST, "Tu es sur quel iPhone ?", "--awaits", now=BASE_DATE) == 0
    assert run("reply", SECOND, "Il répond au deuxième appui ?", "--awaits", now=BASE_DATE + 10) == 0
    path = bound / "people" / "name-laura-martin.json"
    path.write_text(json.dumps(json.loads(path.read_text()) | {"name": None}))
    return bound


def test_a_person_without_user_id_is_not_asked_while_they_owe_an_answer(nameless, run, capsys):
    assert f"ask {SECOND}" not in wait_lines(run, capsys)


def test_the_guard_holds_for_a_person_without_user_id(nameless, run):
    tg = FakeTelegram()

    assert run("reply", SECOND, "Le bouton répond ?", "--awaits", transport=tg, now=BASE_DATE + 20) == 0

    assert tg.sent == []


def test_a_person_without_user_id_is_asked_once_free(nameless, run, capsys):
    tg = FakeTelegram([person_message(10, 100, user_id=70, name="Laura Martin", date=int(BASE_DATE + 60), text="iPhone SE")])
    assert run("pull", transport=tg, now=BASE_DATE + 61) == 0

    assert wait_lines(run, capsys).count(f"ask {SECOND}") == 1


# -- a queued question the agent judges moot -----------------------------------------------------


def test_unask_drops_the_queued_question_and_wait_no_longer_asks_it(queued, run, laura, capsys):
    capsys.readouterr()

    assert run("unask", SECOND) == 0

    assert capsys.readouterr().out == f"unasked {SECOND}\n"
    assert card(laura)["questions"] == []
    laura_answers(run)
    assert not any(line.startswith("ask ") for line in wait_lines(run, capsys))


def test_unask_is_refused_when_nothing_is_queued(queued, run, laura, capsys):
    capsys.readouterr()

    assert run("unask", FIRST) == 1

    assert capsys.readouterr().err == f"bugs-bot: no question queued about {FIRST}\n"
    assert [q["report"] for q in card(laura)["questions"]] == [SECOND]


# -- the agent sees the queue, and keeps to one question ----------------------------------------


def test_person_shows_the_queued_questions(queued, run, capsys):
    capsys.readouterr()
    run("person", FIRST)

    out = capsys.readouterr().out
    assert f"question queued 2026-10-02T08:30 for {SECOND}: Il répond au deuxième appui ?" in out.splitlines()


@pytest.mark.parametrize("phrase", [
    "One message carries one question, in its own sentence",
    "One subject per person at a time.",
    "`ask <id>`",
    "A queued question that no longer needs asking (the subject moved on): `unask <id>`.",
    "queued <id>: <author> already awaits <other id>",
    "Their other subjects are worked on in parallel without asking",
])
def test_the_agent_asks_one_question_at_a_time(phrase):
    assert phrase in DOCS["AGENT.md"].read_text()


def test_the_skill_states_one_question_at_a_time():
    assert "One question at a time" in DOCS["SKILL.md"].read_text()
