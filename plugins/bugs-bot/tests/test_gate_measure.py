"""``gate --measure``: the agent's context read from the orchestrator module's measure file, located by the CLI."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bugs_bot.gate import measure, measure_path, read_measure

SESSION = "s1"


def write_measure(config: Path, session: str, body: str) -> Path:
    """Write the module's measure file for ``session`` under ``config``; return its path."""
    measure = config / "claude-orchestrator" / "measure" / f"{session}.json"
    measure.parent.mkdir(parents=True, exist_ok=True)
    measure.write_text(body)
    return measure


def line(tokens: int, window: int, percent: int = 31, model: str = "a-model") -> str:
    """Return one JSON line as the module writes it (the MeasureReading shape)."""
    return (
        json.dumps(
            {
                "context_tokens": tokens,
                "context_window": window,
                "context_percent": percent,
                "model": model,
                "updated_at": "2026-10-10T10:00:00.000Z",
            }
        )
        + "\n"
    )


@pytest.fixture
def measure_of(env: dict[str, str], tmp_path: Path):
    """Return ``measure_of(body)``: point the tool at a config dir, name a session, write its file."""
    config = tmp_path / "claude"
    env["BUGS_BOT_CLAUDE_DIR"] = str(config)
    env["CLAUDE_CODE_SESSION_ID"] = SESSION

    def _write(body: str) -> Path:
        return write_measure(config, SESSION, body)

    return _write


# -- read_measure: the line itself ----------------------------------------------------------------


def test_reads_the_module_measure_file(tmp_path):
    measure = tmp_path / "measure" / "s1.json"
    measure.parent.mkdir(parents=True)
    measure.write_text('{"context_tokens":310000,"context_window":1000000,"context_percent":31,"model":"a-model","updated_at":"t"}\n')
    out = read_measure(measure)
    assert out["context_tokens"] == 310000


def test_a_partial_line_reads_as_unmeasured(tmp_path):
    measure = tmp_path / "measure" / "s2.json"
    measure.parent.mkdir(parents=True)
    measure.write_text('{"context_tokens":3100')
    assert read_measure(measure) is None


def test_an_empty_file_reads_as_unmeasured(tmp_path):
    # The module empties the file when a session ends: that state reads as unmeasured too.
    measure = tmp_path / "measure" / "s3.json"
    measure.parent.mkdir(parents=True)
    measure.write_text("")

    assert read_measure(measure) is None


def test_a_parseable_line_without_both_figures_reads_as_unmeasured(tmp_path):
    measure = tmp_path / "measure" / "s4.json"
    measure.parent.mkdir(parents=True)
    measure.write_text('{"model":"a-model","updated_at":"t"}\n')

    assert read_measure(measure) is None


def test_a_missing_file_reads_as_unmeasured(tmp_path):
    assert read_measure(tmp_path / "measure" / "never.json") is None


# -- measure_path: the file is named by the session id, under the config dir ----------------------


def test_measure_path_names_the_session_under_the_config_dir():
    env = {"CLAUDE_CODE_SESSION_ID": "abc123", "CLAUDE_CONFIG_DIR": "/config"}

    assert measure_path(env) == Path("/config/claude-orchestrator/measure/abc123.json")


def test_measure_path_takes_the_tool_override_over_the_host_config_dir():
    env = {"CLAUDE_CODE_SESSION_ID": "abc123", "BUGS_BOT_CLAUDE_DIR": "/override", "CLAUDE_CONFIG_DIR": "/config"}

    assert measure_path(env) == Path("/override/claude-orchestrator/measure/abc123.json")


def test_measure_path_never_answers_the_state_dir_override():
    # ORCHESTRATOR_STATE_DIR governs only the roots the module shares with surviving shell
    # writers; the measure file is the module's own artifact and stays under the config dir.
    env = {"CLAUDE_CODE_SESSION_ID": "abc123", "CLAUDE_CONFIG_DIR": "/config", "ORCHESTRATOR_STATE_DIR": "/elsewhere"}

    assert measure_path(env) == Path("/config/claude-orchestrator/measure/abc123.json")


def test_measure_path_without_a_session_id_is_none():
    assert measure_path({"CLAUDE_CONFIG_DIR": "/config"}) is None


# -- measure and the command ----------------------------------------------------------------------


def test_measure_returns_the_two_figures(tmp_path):
    config = tmp_path / "claude"
    write_measure(config, "s9", line(123, 456))

    assert measure({"BUGS_BOT_CLAUDE_DIR": str(config), "CLAUDE_CODE_SESSION_ID": "s9"}) == (123, 456)


def test_measure_at_the_gate_says_handover(run, bound, measure_of, capsys):
    measure_of(line(310000, 1000000))

    assert run("gate", "--measure") == 0

    assert capsys.readouterr().out.split() == [
        "gate_tokens=300000", "context_tokens=310000", "context_window=1000000", "handover=yes",
    ]


def test_measure_below_the_gate_says_no(run, bound, measure_of, capsys):
    measure_of(line(120000, 1000000))

    assert run("gate", "--measure") == 0

    assert capsys.readouterr().out.split()[-1] == "handover=no"


def test_measure_on_a_small_window_uses_80_percent_of_it(run, bound, measure_of, capsys):
    measure_of(line(170000, 200000))

    assert run("gate", "--measure") == 0

    out = capsys.readouterr().out.split()
    assert out[0] == "gate_tokens=160000" and out[-1] == "handover=yes"


def test_measure_reads_the_gate_from_the_project_file(run, bound, measure_of, capsys):
    project_file = Path.cwd() / ".bugs-bot.json"
    data = json.loads(project_file.read_text())
    project_file.write_text(json.dumps(data | {"gate_tokens": 100000}))
    measure_of(line(120000, 1000000))

    assert run("gate", "--measure") == 0

    out = capsys.readouterr().out.split()
    assert out[0] == "gate_tokens=100000" and out[-1] == "handover=yes"


def test_measure_reads_the_file_of_its_own_session(run, bound, env, tmp_path, capsys):
    config = tmp_path / "claude"
    env["BUGS_BOT_CLAUDE_DIR"] = str(config)
    env["CLAUDE_CODE_SESSION_ID"] = SESSION
    write_measure(config, "another-session", line(999999, 1000000))
    write_measure(config, SESSION, line(120000, 1000000))

    assert run("gate", "--measure") == 0

    assert capsys.readouterr().out.split() == [
        "gate_tokens=300000", "context_tokens=120000", "context_window=1000000", "handover=no",
    ]


def test_a_missing_measure_file_fails_the_command_with_one_line(run, bound, env, tmp_path, capsys):
    env["BUGS_BOT_CLAUDE_DIR"] = str(tmp_path / "claude")
    env["CLAUDE_CODE_SESSION_ID"] = SESSION

    assert run("gate", "--measure") == 1

    captured = capsys.readouterr()
    assert "handover=" not in captured.out
    assert "no readable measure" in captured.err and "orchestrator" in captured.err


def test_a_partial_line_fails_the_command_with_one_line(run, bound, measure_of, capsys):
    measure_of('{"context_tokens":3100')

    assert run("gate", "--measure") == 1

    captured = capsys.readouterr()
    assert "handover=" not in captured.out
    assert "no readable measure" in captured.err


def test_without_a_session_id_the_command_fails(run, bound, env, tmp_path, capsys):
    env["BUGS_BOT_CLAUDE_DIR"] = str(tmp_path / "claude")

    assert run("gate", "--measure") == 1

    captured = capsys.readouterr()
    assert "handover=" not in captured.out
    assert "CLAUDE_CODE_SESSION_ID" in captured.err


def test_measure_and_given_figures_do_not_mix(run, bound, measure_of, capsys):
    measure_of(line(1, 1000000))

    assert run("gate", "--measure", "--tokens", "5") == 1

    assert "--measure" in capsys.readouterr().err
