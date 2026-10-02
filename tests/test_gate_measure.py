"""``gate --measure``: the agent's context read through the orchestrator's gauge, located by the CLI."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from bugs_bot.errors import BugsError
from bugs_bot.gate import locate_gauge, measure

GAUGE_TAIL = "skills/context-gauge/scripts/context-gauge.sh"


def stub_gauge(path: Path, body: str) -> Path:
    """Write a stand-in for the orchestrator's gauge: a shell script printing ``body``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!/bin/sh\n{body}\n")
    return path


@pytest.fixture
def gauge(tmp_path: Path, env: dict[str, str]):
    """Return ``gauge(body)``: point ``BUGS_BOT_GAUGE`` at a stub printing ``body``."""

    def _gauge(body: str) -> Path:
        path = stub_gauge(tmp_path / "gauge" / "context-gauge.sh", body)
        env["BUGS_BOT_GAUGE"] = str(path)
        return path

    return _gauge


def test_measure_at_the_gate_says_handover(run, bound, gauge, capsys):
    gauge("echo context_percent=31\necho context_tokens=310000\necho context_window=1000000")

    assert run("gate", "--measure") == 0

    assert capsys.readouterr().out.split() == [
        "gate_tokens=300000", "context_tokens=310000", "context_window=1000000", "handover=yes",
    ]


def test_measure_below_the_gate_says_no(run, bound, gauge, capsys):
    gauge("echo context_tokens=120000\necho context_window=1000000")

    assert run("gate", "--measure") == 0

    assert capsys.readouterr().out.split()[-1] == "handover=no"


def test_measure_on_a_small_window_uses_80_percent_of_it(run, bound, gauge, capsys):
    gauge("echo context_tokens=170000\necho context_window=200000")

    assert run("gate", "--measure") == 0

    out = capsys.readouterr().out.split()
    assert out[0] == "gate_tokens=160000" and out[-1] == "handover=yes"


def test_measure_reads_the_gate_from_the_project_file(run, bound, gauge, capsys):
    project_file = Path.cwd() / ".bugs-bot.json"
    data = json.loads(project_file.read_text())
    project_file.write_text(json.dumps(data | {"gate_tokens": 100000}))
    gauge("echo context_tokens=120000\necho context_window=1000000")

    assert run("gate", "--measure") == 0

    out = capsys.readouterr().out.split()
    assert out[0] == "gate_tokens=100000" and out[-1] == "handover=yes"


def test_a_failing_gauge_fails_the_command(run, bound, gauge, capsys):
    gauge("echo 'ERROR: no session id' >&2\nexit 3")

    assert run("gate", "--measure") == 1

    captured = capsys.readouterr()
    assert "handover=" not in captured.out
    assert "context gauge" in captured.err and "no session id" in captured.err


def test_a_gauge_without_the_figures_fails_the_command(run, bound, gauge, capsys):
    gauge("echo context_tokens=unavailable")

    assert run("gate", "--measure") == 1

    assert "context_tokens" in capsys.readouterr().err


def test_measure_and_given_figures_do_not_mix(run, bound, gauge, capsys):
    gauge("echo context_tokens=1\necho context_window=1000000")

    assert run("gate", "--measure", "--tokens", "5") == 1

    assert "--measure" in capsys.readouterr().err


def test_measure_runs_the_gauge_alone_and_parses_its_lines(tmp_path):
    path = stub_gauge(tmp_path / "g.sh", "")
    calls = []

    def run(argv: list[str]) -> str:
        calls.append(argv)
        return "context_percent=12\ncontext_tokens=123\ncontext_window=456\nmodel=x\n"

    assert measure({"BUGS_BOT_GAUGE": str(path)}, run) == (123, 456)
    assert calls == [["bash", str(path)]]


def test_locate_gauge_takes_the_override_first(tmp_path):
    path = stub_gauge(tmp_path / "g.sh", "")

    assert locate_gauge({"BUGS_BOT_GAUGE": str(path), "BUGS_BOT_CLAUDE_DIR": str(tmp_path / "none")}) == path


def test_locate_gauge_refuses_an_override_that_is_not_a_file(tmp_path):
    with pytest.raises(BugsError, match="BUGS_BOT_GAUGE"):
        locate_gauge({"BUGS_BOT_GAUGE": str(tmp_path / "missing.sh")})


def test_locate_gauge_takes_the_newest_installed_version(tmp_path):
    cache = tmp_path / "claude" / "plugins" / "cache" / "lounisbou" / "orchestrator"
    for version in ("0.9.0", "0.38.0", "0.10.0"):
        stub_gauge(cache / version / GAUGE_TAIL, "")
    (cache / "0.40.0").mkdir()  # a half-removed version, with no gauge

    found = locate_gauge({"BUGS_BOT_CLAUDE_DIR": str(tmp_path / "claude")})

    assert found == cache / "0.38.0" / GAUGE_TAIL


def test_locate_gauge_without_the_orchestrator_plugin_says_so(tmp_path):
    with pytest.raises(BugsError, match="orchestrator"):
        locate_gauge({"BUGS_BOT_CLAUDE_DIR": str(tmp_path / "claude")})


def test_the_gauge_runs_in_the_callers_environment(run, bound, env, gauge, capsys):
    # The real gauge reads the session id from its environment: whatever the caller has must reach it.
    env["GAUGE_PROBE"] = "123456"
    gauge("echo context_tokens=$GAUGE_PROBE\necho context_window=1000000")

    assert run("gate", "--measure") == 0

    assert "context_tokens=123456" in capsys.readouterr().out.split()


def test_a_gauge_that_hangs_fails_the_command_with_one_line(run, bound, env, gauge, monkeypatch, capsys):
    monkeypatch.setattr("bugs_bot.gate.GAUGE_TIMEOUT", 1)
    env["PATH"] = os.environ["PATH"]
    gauge("exec sleep 5")

    assert run("gate", "--measure") == 1

    captured = capsys.readouterr()
    assert "the context gauge did not run" in captured.err
    assert "handover=" not in captured.out
