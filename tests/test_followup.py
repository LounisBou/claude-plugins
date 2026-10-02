"""Follow-ups: a question the agent asks waits for its answer; unanswered, ONE reminder, then the launcher is told."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from samples import BASE_DATE, FakeTelegram, message

from bugs_bot import cli

HOUR = 3600
DAY = 24 * HOUR
FIRST = "20261002-082900-100"


def person_message(update_id: int, message_id: int, *, user_id: int, name: str, date: int, text: str = "x") -> dict:
    """Build a message update from a given person."""
    update = message(update_id, message_id, text=text, date=date)
    update["message"]["from"] = {"id": user_id, "is_bot": False, "first_name": name}
    return update


@pytest.fixture
def at(env):
    """Return ``at(now, *argv, transport=..., sleep=...) -> exit code``: the CLI at a given wall time.

    The fake clock advances by the slept time, so a wait sees time pass.
    """

    def _at(now: float, *argv: str, transport: FakeTelegram | None = None, sleep=None) -> int:
        clock = {"t": 0.0}

        def fake_sleep(seconds: float) -> None:
            clock["t"] += seconds
            if sleep:
                sleep(seconds)

        return cli.main(
            list(argv), transport=transport or FakeTelegram(), env=env, now=now, sleep=fake_sleep, clock=lambda: clock["t"]
        )

    return _at


@pytest.fixture
def asked(at, bound, capsys) -> Path:
    """A report from Laura (id 7), pulled, triaged, and asked a question with ``--awaits`` at BASE_DATE."""
    tg = FakeTelegram([person_message(10, 100, user_id=7, name="Laura", date=BASE_DATE - 60, text="ça plante")])
    assert at(BASE_DATE - 30, "pull", transport=tg) == 0
    assert at(BASE_DATE - 20, "triage", FIRST, "bug") == 0
    assert at(BASE_DATE, "reply", FIRST, "Tu es sur quel iPhone ?", "--awaits") == 0
    capsys.readouterr()
    return bound / "inbox" / FIRST / "report.json"


def awaiting(path: Path) -> dict | None:
    return json.loads(path.read_text()).get("awaiting")


def set_hours(hours: float) -> None:
    path = Path.cwd() / ".bugs-bot.json"
    path.write_text(json.dumps(json.loads(path.read_text()) | {"follow_up_hours": hours}))


# -- awaiting, and its answer -------------------------------------------------------------


def test_reply_awaits_records_the_wait(asked):
    assert awaiting(asked) == {"since": "2026-10-02T08:30:00+00:00", "reply": 1}


def test_a_plain_reply_awaits_nothing(at, bound, capsys):
    tg = FakeTelegram([person_message(10, 100, user_id=7, name="Laura", date=BASE_DATE - 60)])
    at(BASE_DATE - 30, "pull", transport=tg)

    assert at(BASE_DATE, "reply", FIRST, "Merci à toi !") == 0

    assert awaiting(bound / "inbox" / FIRST / "report.json") is None


def test_a_later_message_of_the_same_person_answers_it(at, asked):
    tg = FakeTelegram([person_message(11, 101, user_id=7, name="Laura B.", date=BASE_DATE + 600, text="iPhone 12")])

    assert at(BASE_DATE + 610, "pull", transport=tg) == 0

    assert awaiting(asked) is None


def test_a_batch_replayed_after_a_crash_still_lifts_the_wait(at, asked, bugs_home):
    answer = person_message(11, 101, user_id=7, name="Laura B.", date=BASE_DATE + 600, text="iPhone 12")
    assert at(BASE_DATE + 610, "pull", transport=FakeTelegram([answer])) == 0
    report = json.loads(asked.read_text())
    asked.write_text(json.dumps(report | {"awaiting": {"since": "2026-10-02T08:30:00+00:00", "reply": 1}}))
    (bugs_home / "state.json").unlink()  # the offset was never saved: the same batch comes again

    assert at(BASE_DATE + 620, "pull", transport=FakeTelegram([answer])) == 0

    assert awaiting(asked) is None
    assert len(list((asked.parent.parent).iterdir())) == 2  # replayed, not duplicated


def test_a_message_of_another_person_answers_nothing(at, asked):
    tg = FakeTelegram([person_message(11, 101, user_id=8, name="Laura", date=BASE_DATE + 600)])

    assert at(BASE_DATE + 610, "pull", transport=tg) == 0

    assert awaiting(asked) is not None


def test_without_a_user_id_the_display_name_decides(at, asked):
    report = json.loads(asked.read_text())
    asked.write_text(json.dumps(report | {"author_id": None}))
    tg = FakeTelegram([person_message(11, 101, user_id=99, name="Laura", date=BASE_DATE + 600)])

    assert at(BASE_DATE + 610, "pull", transport=tg) == 0

    assert awaiting(asked) is None


def test_a_message_older_than_the_question_answers_nothing(at, asked):
    tg = FakeTelegram([person_message(11, 101, user_id=7, name="Laura", date=BASE_DATE - 10)])

    assert at(BASE_DATE + 610, "pull", transport=tg) == 0

    assert awaiting(asked) is not None


def test_edit_awaits_records_the_rewritten_reply(at, asked):
    assert at(BASE_DATE + 60, "reply", FIRST, "Bien reçu.") == 0
    assert at(BASE_DATE + 120, "edit", FIRST, "Tu peux me dire ta version d'iOS ?", "--reply", "2", "--awaits") == 0

    assert awaiting(asked) == {"since": "2026-10-02T08:32:00+00:00", "reply": 2}


def test_edit_awaits_records_even_when_the_text_is_unchanged(at, asked):
    tg = FakeTelegram()
    tg.edit_error = "Bad Request: message is not modified"
    at(BASE_DATE + 60, "reply", FIRST, "Bien reçu.")

    assert at(BASE_DATE + 120, "edit", FIRST, "Bien reçu.", "--awaits", transport=tg) == 0

    assert awaiting(asked) == {"since": "2026-10-02T08:32:00+00:00", "reply": 2}


# -- due, and the one reminder -----------------------------------------------------------------


def test_due_one_second_before_and_after_the_delay(at, asked, capsys):
    assert at(BASE_DATE + DAY - 1, "overdue") == 0
    assert capsys.readouterr().out == ""

    assert at(BASE_DATE + DAY + 1, "overdue") == 0

    line = capsys.readouterr().out.strip()
    assert line.startswith(f"follow-up {FIRST}") and "Laura" in line and "Tu es sur quel iPhone ?" in line


def test_the_delay_comes_from_the_project_file(at, asked, capsys):
    set_hours(2)

    assert at(BASE_DATE + 2 * HOUR + 1, "overdue") == 0

    assert capsys.readouterr().out.startswith(f"follow-up {FIRST}")


# The four places the project's follow_up_hours is read; each must take it from the project file.
DELAY_READERS = {
    "overdue": ["overdue"],
    "wait": ["wait", "--timeout", "0"],
    "pending": ["pending"],
    "reply": ["reply", FIRST, "Petite relance ?", "--follow-up"],
}


def followed_up(asked: Path, out: str, command: str) -> bool:
    """Tell whether ``command`` saw the wait as due: it listed it, or (reply) it sent the reminder."""
    return "reminded" in awaiting(asked) if command == "reply" else f"follow-up {FIRST}" in out


@pytest.mark.parametrize("command", DELAY_READERS)
def test_every_command_takes_the_delay_from_the_project_file(at, asked, capsys, command):
    set_hours(2)
    capsys.readouterr()

    assert at(BASE_DATE + 2 * HOUR + 1, *DELAY_READERS[command]) == 0

    assert followed_up(asked, capsys.readouterr().out, command)


@pytest.mark.parametrize("command", DELAY_READERS)
def test_no_command_sees_the_wait_due_before_the_project_files_delay(at, asked, capsys, command):
    set_hours(2)
    capsys.readouterr()

    at(BASE_DATE + 2 * HOUR - 1, *DELAY_READERS[command])

    assert not followed_up(asked, capsys.readouterr().out, command)


def test_a_closed_report_is_never_followed_up(at, asked, capsys):
    at(BASE_DATE + 60, "done", FIRST)
    capsys.readouterr()

    assert at(BASE_DATE + 2 * DAY, "overdue") == 0

    assert capsys.readouterr().out == ""


def test_follow_up_is_refused_before_the_wait_is_due(at, asked, capsys):
    tg = FakeTelegram()

    assert at(BASE_DATE + DAY - 1, "reply", FIRST, "Petite relance ?", "--mention", "--follow-up", transport=tg) == 1

    assert tg.sent == [] and "no follow-up due" in capsys.readouterr().err


def test_follow_up_is_refused_without_a_wait(at, bound, capsys):
    tg = FakeTelegram([person_message(10, 100, user_id=7, name="Laura", date=BASE_DATE - 60)])
    at(BASE_DATE - 30, "pull", transport=tg)

    assert at(BASE_DATE + 2 * DAY, "reply", FIRST, "Relance", "--follow-up") == 1


def test_one_reminder_only(at, asked, capsys):
    assert at(BASE_DATE + DAY + 1, "reply", FIRST, "Petite relance ?", "--mention", "--follow-up") == 0
    assert awaiting(asked)["reminded"] == "2026-10-03T08:30:01+00:00"
    capsys.readouterr()

    assert at(BASE_DATE + DAY + 60, "reply", FIRST, "Encore ?", "--follow-up") == 1
    assert at(BASE_DATE + DAY + 60, "overdue") == 0
    assert "follow-up" not in capsys.readouterr().out


def test_awaits_and_follow_up_do_not_mix(at, asked):
    with pytest.raises(SystemExit):
        at(BASE_DATE + DAY + 1, "reply", FIRST, "x", "--awaits", "--follow-up")


def test_a_new_question_waits_afresh(at, asked):
    at(BASE_DATE + DAY + 1, "reply", FIRST, "Petite relance ?", "--follow-up")

    assert at(BASE_DATE + DAY + 600, "reply", FIRST, "Et sur Android ?", "--awaits") == 0

    assert awaiting(asked) == {"since": "2026-10-03T08:40:00+00:00", "reply": 3}


# -- the wait wakes the agent --------------------------------------------------------------------


def test_wait_prints_a_due_follow_up(at, asked, capsys):
    assert at(BASE_DATE + DAY, "wait") == 0

    assert capsys.readouterr().out.split("\n")[0] == f"follow-up {FIRST}"


def test_wait_wakes_when_a_follow_up_falls_due(at, asked, capsys):
    slept = []

    assert at(BASE_DATE + DAY - 12, "wait", "--interval", "5", sleep=slept.append) == 0

    assert capsys.readouterr().out.strip() == f"follow-up {FIRST}"
    assert slept == [5, 5, 5]


def test_unanswered_after_the_reminder_once_then_never_again(at, asked, capsys):
    at(BASE_DATE + DAY, "reply", FIRST, "Petite relance ?", "--follow-up")
    capsys.readouterr()

    assert at(BASE_DATE + 2 * DAY - 1, "wait", "--timeout", "0") == 0
    assert capsys.readouterr().out == ""
    assert at(BASE_DATE + 2 * DAY, "wait") == 0
    assert capsys.readouterr().out.strip() == f"unanswered {FIRST}"

    assert at(BASE_DATE + 2 * DAY + 60, "escalated", FIRST) == 0
    assert awaiting(asked)["escalated"] == "2026-10-04T08:31:00+00:00"
    capsys.readouterr()

    assert at(BASE_DATE + 9 * DAY, "wait", "--timeout", "0") == 0
    assert capsys.readouterr().out == ""
    assert at(BASE_DATE + 9 * DAY, "escalated", FIRST) == 1
    assert at(BASE_DATE + 9 * DAY, "reply", FIRST, "Relance", "--follow-up") == 1


def test_escalated_is_refused_before_any_reminder(at, asked, capsys):
    assert at(BASE_DATE + 3 * DAY, "escalated", FIRST) == 1

    assert "escalated" not in json.dumps(awaiting(asked))


def test_pending_shows_due_follow_ups_and_unanswered_ones(at, asked, bound, capsys):
    tg = FakeTelegram([person_message(11, 101, user_id=8, name="Mathis", date=BASE_DATE + 10)])
    at(BASE_DATE + 20, "pull", transport=tg)
    second = "20261002-083010-101"
    at(BASE_DATE + 30, "triage", second, "question")
    at(BASE_DATE + 40, "reply", second, "Tu as quel navigateur ?", "--awaits")
    at(BASE_DATE + DAY + 40, "reply", second, "Relance", "--follow-up")
    capsys.readouterr()

    assert at(BASE_DATE + 2 * DAY + 41, "pending") == 0

    out = capsys.readouterr().out
    assert f"follow-up {FIRST}" in out
    assert f"unanswered {second}" in out


# -- exact bounds and exact output ---------------------------------------------------------------


def test_the_follow_up_is_due_exactly_at_the_delay_and_the_unanswered_exactly_a_delay_after_the_reminder(
    at, asked, capsys
):
    assert at(BASE_DATE + DAY - 1, "overdue") == 0
    assert capsys.readouterr().out == ""
    assert at(BASE_DATE + DAY, "overdue") == 0
    assert capsys.readouterr().out == f"follow-up {FIRST}  Laura  since 2026-10-02T08:30  Tu es sur quel iPhone ?\n"
    at(BASE_DATE + DAY, "reply", FIRST, "Petite relance ?", "--follow-up")
    capsys.readouterr()

    assert at(BASE_DATE + 2 * DAY - 1, "overdue") == 0
    assert capsys.readouterr().out == ""
    assert at(BASE_DATE + 2 * DAY, "overdue") == 0
    assert capsys.readouterr().out == f"unanswered {FIRST}  Laura  since 2026-10-02T08:30  Tu es sur quel iPhone ?\n"


@pytest.fixture
def one_due_one_unanswered(at, asked, capsys) -> str:
    """``FIRST`` is due its reminder; a second report (Mathis) was reminded and is unanswered. Returns its id."""
    tg = FakeTelegram([person_message(11, 101, user_id=8, name="Mathis", date=BASE_DATE + 10, text="le bouton ne répond pas")])
    at(BASE_DATE + 20, "pull", transport=tg)
    second = "20261002-083010-101"
    at(BASE_DATE + 30, "triage", second, "question")
    at(BASE_DATE + 40, "reply", second, "Tu as quel navigateur ?", "--awaits")
    at(BASE_DATE + DAY + 40, "reply", second, "Relance", "--follow-up")
    capsys.readouterr()
    return second


def test_wait_prints_exactly_the_follow_up_then_the_unanswered(at, one_due_one_unanswered, capsys):
    assert at(BASE_DATE + 2 * DAY + 41, "wait") == 0

    assert capsys.readouterr().out == f"follow-up {FIRST}\nunanswered {one_due_one_unanswered}\n"


def test_pending_prints_exactly_the_open_reports_then_the_overdue_waits(at, one_due_one_unanswered, capsys):
    second = one_due_one_unanswered

    assert at(BASE_DATE + 2 * DAY + 41, "pending") == 0

    assert capsys.readouterr().out == (
        f"{FIRST}  bug       seen   Laura  ça plante\n"
        f"{second}  question  seen   Mathis  le bouton ne répond pas\n"
        f"follow-up {FIRST}  Laura  since 2026-10-02T08:30  Tu es sur quel iPhone ?\n"
        f"unanswered {second}  Mathis  since 2026-10-02T08:30  Tu as quel navigateur ?\n"
    )


# -- the rules are written down ----------------------------------------------------------------

AGENT_MD = Path(__file__).resolve().parent.parent / "agent" / "AGENT.md"
SKILL_MD = Path(__file__).resolve().parent.parent / "skills" / "bugs-bot" / "SKILL.md"


@pytest.mark.parametrize("phrase", [
    "--awaits", "--follow-up", "follow-up <id>", "unanswered <id>", "escalated <id>", "sans réponse <id>",
    "« de rien »", "ok va pour une seule", "never a reproach", "never the first message repeated",
])
def test_the_agent_knows_the_follow_up_rules(phrase):
    assert phrase in AGENT_MD.read_text()


@pytest.mark.parametrize("phrase", ["--awaits", "--follow-up", "follow_up_hours", "sans réponse <id>", "ok va pour une seule"])
def test_the_skill_states_the_follow_up_rules(phrase):
    assert phrase in SKILL_MD.read_text()
