"""No developer reference reaches a person: ``fixed --note`` records the ref for the agent and posts nothing."""

from __future__ import annotations

import json

import pytest
from fake_channel import FakeChannel
from samples import BASE_DATE, GROUP_ID, FakeTelegram
from test_mention import DOCS, STAMP, write_report

from bugs_bot.reports import cmd_fixed
from bugs_bot.store import Store

REPORT = f"{STAMP}-5"


def test_fixed_with_a_note_records_the_ref_and_posts_nothing(bound):
    write_report(bound, 5, author="Laura", author_id=7)
    channel = FakeChannel()

    assert cmd_fixed(channel, Store(bound), GROUP_ID, REPORT, "#680", BASE_DATE) == 0

    assert channel.of("send") == []
    assert [c[1:] for c in channel.of("react")] == [(GROUP_ID, 5, "\U0001f44c")]
    report = json.loads((bound / "inbox" / REPORT / "report.json").read_text())
    assert report["fix_ref"] == "#680" and report["status"] == "fixed" and report["replies"] == []


def test_fixed_without_a_note_records_no_ref(bound):
    write_report(bound, 5, author="Laura", author_id=7)

    cmd_fixed(FakeChannel(), Store(bound), GROUP_ID, REPORT, None, BASE_DATE)

    assert "fix_ref" not in json.loads((bound / "inbox" / REPORT / "report.json").read_text())


def test_show_prints_the_ref_for_the_agent(run, bound, capsys):
    write_report(bound, 5, author="Laura", author_id=7)
    tg = FakeTelegram()
    run("fixed", REPORT, "--note", "PR #680, commit 1a2b3c4", transport=tg)
    capsys.readouterr()

    assert run("show", REPORT) == 0

    assert "fix ref: PR #680, commit 1a2b3c4" in capsys.readouterr().out.splitlines()
    assert tg.sent == []


@pytest.mark.parametrize("phrase", [
    "never a PR number, commit, branch or ticket id in the group",
    "`fixed <id> --note \"<ref>\"` | Launcher: « corrigé <id> <ref> » → 👌, status `fixed`, the ref recorded for you, nothing posted",
    "in your own sentence",
])
def test_the_agent_tells_the_fix_in_its_own_words_never_with_the_ref(phrase):
    assert phrase in DOCS["AGENT.md"].read_text()


def test_the_skill_says_the_note_is_recorded_not_posted():
    text = DOCS["SKILL.md"].read_text()
    assert "records it in the report (`show` prints it) and posts nothing" in text
    assert "No PR number, commit, branch or ticket id is ever posted in the group" in text
