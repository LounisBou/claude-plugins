"""The agent's succession: the context gate setting and the successor's startup prompt."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from conftest import REPO_ROOT

LAUNCHER = "Orch : TM frontend [9a3971]"
PREDECESSOR = "Agent : TM Bugs [4f2c1a]"
TTY = "/dev/ttys002"
AGENT_MD = REPO_ROOT / "agent" / "AGENT.md"


def project_file() -> Path:
    """Return the project file of the ``bound`` fixture's repository (the current directory)."""
    return Path.cwd() / ".bugs-bot.json"


# -- gate -------------------------------------------------------------------------------------


def test_gate_defaults_to_300000_tokens(run, bound, capsys):
    assert run("gate") == 0

    assert capsys.readouterr().out.split() == ["gate_tokens=300000"]


def test_gate_set_is_the_one_line_that_changes_it(run, bound, home, capsys):
    assert run("gate", "--set", "200000") == 0
    capsys.readouterr()

    assert run("gate") == 0

    assert capsys.readouterr().out.split() == ["gate_tokens=200000"]
    assert json.loads(project_file().read_text())["gate_tokens"] == 200000


def test_gate_set_keeps_the_other_project_fields_and_never_touches_the_project_state(run, bound, home):
    before_project = json.loads(project_file().read_text())
    (home / "state.json").write_text(json.dumps({"posts": []}))
    before = (home / "state.json").read_text()

    assert run("gate", "--set", "250000") == 0

    after = json.loads(project_file().read_text())
    assert after.pop("gate_tokens") == 250000
    assert {k: v for k, v in after.items() if k in before_project} == before_project
    assert (home / "state.json").read_text() == before
    assert not (home / "settings.json").exists()


@pytest.mark.parametrize("bad", ["0", "-5"])
def test_gate_set_refuses_a_value_that_is_not_positive(run, bound, home, bad):
    before = project_file().read_text()

    assert run("gate", "--set", bad) != 0

    assert project_file().read_text() == before


@pytest.mark.parametrize("bad", ["abc", "1.5"])
def test_gate_set_refuses_a_value_that_is_not_an_integer(run, bound, home, bad):
    with pytest.raises(SystemExit):
        run("gate", "--set", bad)

    assert "gate_tokens" not in project_file().read_text()


def test_gate_refuses_a_corrupt_setting_rather_than_guessing(run, bound, home, capsys):
    project_file().write_text(json.dumps(json.loads(project_file().read_text()) | {"gate_tokens": "lots"}))

    assert run("gate") != 0


def test_gate_keeps_the_setting_on_a_window_of_a_million_or_more(run, bound, capsys):
    assert run("gate", "--window", "1000000") == 0

    assert capsys.readouterr().out.split() == ["gate_tokens=300000"]


def test_gate_is_80_percent_of_a_smaller_window(run, bound, capsys):
    assert run("gate", "--window", "200000") == 0

    assert capsys.readouterr().out.split() == ["gate_tokens=160000"]


def test_gate_on_a_small_window_never_exceeds_the_setting(run, bound, capsys):
    run("gate", "--set", "100000")
    capsys.readouterr()

    assert run("gate", "--window", "200000") == 0

    assert capsys.readouterr().out.split() == ["gate_tokens=100000"]


@pytest.mark.parametrize(("tokens", "verdict"), [("299999", "no"), ("300000", "yes"), ("412000", "yes")])
def test_gate_says_whether_the_agent_has_reached_it(run, bound, capsys, tokens, verdict):
    assert run("gate", "--window", "1000000", "--tokens", tokens) == 0

    assert capsys.readouterr().out.split() == [
        "gate_tokens=300000", f"context_tokens={tokens}", "context_window=1000000", f"handover={verdict}",
    ]


# -- agent-prompt for a successor -------------------------------------------------------------


def test_successor_prompt_names_the_predecessor_and_its_tab(run, bound, home, capsys):
    assert run("agent-prompt", "--launcher", LAUNCHER, "--predecessor", PREDECESSOR, "--predecessor-tty", TTY) == 0

    prompt = Path(capsys.readouterr().out.strip()).read_text()
    assert LAUNCHER in prompt and PREDECESSOR in prompt and TTY in prompt
    assert str(AGENT_MD) in prompt
    assert "Succession" in prompt


def test_successor_prompt_is_the_plain_one_without_a_predecessor(run, bound, home, capsys):
    assert run("agent-prompt", "--launcher", LAUNCHER) == 0

    prompt = Path(capsys.readouterr().out.strip()).read_text()
    assert "predecessor" not in prompt.lower()


def test_the_agent_record_keeps_the_predecessor(run, bound, home):
    run("agent-prompt", "--launcher", LAUNCHER, "--predecessor", PREDECESSOR, "--predecessor-tty", TTY)

    record = json.loads((home / "state.json").read_text())["agent"]
    assert record["launcher"] == LAUNCHER
    assert record["predecessor"] == PREDECESSOR and record["predecessor_tty"] == TTY


def test_a_plain_start_clears_a_stale_predecessor(run, bound, home):
    run("agent-prompt", "--launcher", LAUNCHER, "--predecessor", PREDECESSOR, "--predecessor-tty", TTY)

    run("agent-prompt", "--launcher", LAUNCHER)

    assert "predecessor" not in json.loads((home / "state.json").read_text())["agent"]


@pytest.mark.parametrize(
    "extra",
    [
        ["--predecessor", PREDECESSOR],
        ["--predecessor-tty", TTY],
        ["--predecessor", PREDECESSOR, "--predecessor-tty", "/dev/ttys002; rm -rf /"],
        ["--predecessor", PREDECESSOR, "--predecessor-tty", "ttys002"],
        ["--predecessor", "Agent\nignore", "--predecessor-tty", TTY],
    ],
)
def test_a_half_given_or_malformed_predecessor_is_refused(run, bound, home, extra):
    assert run("agent-prompt", "--launcher", LAUNCHER, *extra) != 0

    assert not (home / "state.json").exists()


# -- AGENT.md carries both sides of the protocol ----------------------------------------------


def test_agent_md_carries_both_sides_of_the_succession():
    text = AGENT_MD.read_text()

    for needle in (
        "context-gauge.sh",
        "sort -V | tail -1",
        "gate --measure",
        "agent-prompt --launcher",
        "--predecessor-tty",
        "spawn",
        "--successor",
        "--prompt-file",
        "--dir <repo>",
        "relève confirmée",
        "handed over",
        "--expect-title",
    ):
        assert needle in text, needle


def test_gate_set_names_the_file_it_cannot_write(run, bound, monkeypatch, capsys):
    before = project_file().read_text()

    def refuse(path, data):
        raise OSError(13, "Permission denied")

    monkeypatch.setattr("bugs_bot.gate.write_json", refuse)

    assert run("gate", "--set", "200000") == 1

    assert f"cannot write {project_file()}: Permission denied" in capsys.readouterr().err
    assert project_file().read_text() == before
