"""The agent writes to its launcher only to bring it information, and its wait stays under the cache lifetime."""

from __future__ import annotations

import re

import pytest

from conftest import REPO_ROOT

AGENT_MD = REPO_ROOT / "agent" / "AGENT.md"


def section(title: str) -> str:
    """Return the text of the ``## <title>`` section of AGENT.md, up to the next ``## `` heading."""
    match = re.search(rf"^## {re.escape(title)}\n(.*?)(?=^## |\Z)", AGENT_MD.read_text(), re.S | re.M)
    assert match, title
    return match.group(1)


def test_the_rule_is_stated_where_the_launcher_is_introduced():
    assert "write to your launcher only to bring it information: a report, a question, an answer it needs, a failure" in section("Who you are")


def test_the_launcher_message_outside_the_table_is_answered_only_when_it_asks():
    answers = section("The launcher's answers")

    assert "Acknowledge" not in answers
    assert "acknowledgement" in answers  # the rule that there is none
    assert "only when it asks a question" in answers


def test_a_restart_asks_nothing_about_reports_already_relayed():
    start = section("Start (and every restart)")

    assert "where each stand" not in start
    assert "where does each stand" not in start
    assert "ONE message" not in start
    assert "No round asking where the reports stand" in start
    assert "nothing to send" in start
    assert "no restart message of your own" in start
    assert "first `wait`" in start
    assert "« Each new report »" in start
    assert "« Waiting for an answer »" in start


def test_the_launcher_is_never_confirmed():
    text = AGENT_MD.read_text()

    assert "no confirmation round" in text
    assert "the agent does not ask" in text


def test_the_predecessor_no_longer_tells_the_launcher_about_the_handover():
    text = AGENT_MD.read_text()

    assert "successeur lancé" not in text
    assert "relève à" not in text
    assert "relève confirmée" in text
    assert "handed over" in text


def test_the_successor_reads_the_note_instead_of_asking_the_launcher():
    last = section("Succession").split("**The successor's first move**")[1]

    assert "ONE message to your launcher" not in last
    assert "asks the launcher nothing" in last


@pytest.mark.parametrize("phrase", [
    "ceiling is 3300 seconds",
    "timeout of 3600000 ms",
    "exit code 3",
])
def test_the_wait_is_documented_under_the_cache_lifetime(phrase):
    assert phrase in section("The wait")


def test_the_old_ceiling_is_gone():
    text = AGENT_MD.read_text()

    assert "7000" not in text
    assert "7200000" not in text


def test_the_command_table_names_the_ceiling_exit_code():
    row = next(line for line in AGENT_MD.read_text().splitlines() if line.startswith("| `wait` |"))

    assert "3300" in row
    assert "exits 3" in row


SKILL_MD = REPO_ROOT / "skills" / "bugs-bot" / "SKILL.md"


def test_the_launcher_is_not_told_a_restart_asks_where_the_reports_stand():
    text = SKILL_MD.read_text()

    assert "it asks you, in one message, where each open report stands" not in text
    assert "the agent asks nothing" in text


def test_the_launcher_is_not_told_of_a_succession():
    text = SKILL_MD.read_text()

    assert "relève à <N> tokens, successeur lancé" not in text
    assert "one message to you" not in text
    assert "restarts as usual (`pending`, then its wait)" in text
    assert "you hear nothing of a succession" in text


def test_wait_exiting_3_is_not_a_failure():
    text = AGENT_MD.read_text()
    paragraph = next(line for line in text.splitlines() if line.startswith("`taken` or `fixed` exiting 1"))

    assert "`wait` exiting 3 is its ceiling (« The wait »), not a failure." in paragraph



def test_the_call_timeout_is_above_the_ceiling_and_not_called_under_the_lifetime():
    wait = section("The wait")

    assert "Give the call a timeout of 3600000 ms, above the ceiling:" in wait
    assert "and under that lifetime" not in wait
