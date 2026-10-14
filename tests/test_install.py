"""``install``: once per machine — the fixed launcher, then exactly one ``bugs-bot-pull`` under PM2, saved.

PM2 is the fake of ``conftest.fake_pm2``; the process table is pinned through ``cli.read_ps``.
"""

from __future__ import annotations

import builtins
import getpass
import json
import os
from pathlib import Path

import pytest
from samples import TOKEN

from bugs_bot import cli, install
from bugs_bot.doctor import LAUNCHER_TEXT

ALLOW = "Bash(bugs-bot:*)"
PULL_PS = "4242 python3 /home/u/.local/bin/bugs-bot pull --watch\n"


@pytest.fixture
def machine(tmp_path: Path, env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """A machine with no launcher and no Pull yet; the allow rule granted."""
    claude = tmp_path / "claude"
    claude.mkdir()
    claude.joinpath("settings.json").write_text(json.dumps({"permissions": {"allow": [ALLOW]}}))
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(cli, "read_ps", lambda: "")
    return {
        **env,
        "PATH": os.environ["PATH"],
        "HOME": str(home),
        "BUGS_BOT_CLAUDE_DIR": str(claude),
        "BUGS_BOT_LAUNCHER_DIR": str(tmp_path / "localbin"),
    }


@pytest.fixture(autouse=True)
def _asks_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """``install`` asks no question: any prompt fails the test."""

    def refuse(*_args, **_kwargs):
        raise AssertionError("install asked a question")

    monkeypatch.setattr(builtins, "input", refuse)
    monkeypatch.setattr(getpass, "getpass", refuse)


def launcher_of(machine: dict[str, str]) -> str:
    return str(Path(machine["BUGS_BOT_LAUNCHER_DIR"]) / "bugs-bot")


def test_a_fresh_machine_gets_the_launcher_and_one_pull_started_and_saved(machine, fake_pm2, capsys):
    code = cli.main(["install"], env=machine)

    out = capsys.readouterr().out
    assert code == 0, out
    assert Path(launcher_of(machine)).read_text() == LAUNCHER_TEXT
    apps = fake_pm2.state["apps"]
    assert [(a["name"], a["script"], a["cwd"]) for a in apps] == [("bugs-bot-pull", launcher_of(machine), machine["HOME"])]
    assert fake_pm2.state["saved"] == ["bugs-bot-pull"]
    assert fake_pm2.verbs() == ["jlist", "start", "save"]
    assert fake_pm2.state["calls"][1]["argv"] == ["start", str(install.PM2_CONFIG)]
    assert "started bugs-bot-pull under PM2" in out and "/bugs-bot:init" in out


def test_install_twice_restarts_the_one_pull_and_never_starts_a_second(machine, fake_pm2, capsys):
    assert cli.main(["install"], env=machine) == 0
    assert cli.main(["install"], env=machine) == 0

    apps = fake_pm2.state["apps"]
    assert len(apps) == 1 and apps[0]["restarts"] == 1
    assert fake_pm2.verbs() == ["jlist", "start", "save", "jlist", "restart", "save"]
    assert "restarted bugs-bot-pull under PM2" in capsys.readouterr().out


@pytest.mark.parametrize("recorded", ["versioned", "throwaway-cwd"])
def test_a_pull_recorded_on_a_versioned_path_or_another_directory_is_replaced_by_one(machine, fake_pm2, tmp_path, recorded):
    if recorded == "versioned":
        fake_pm2.register("/home/u/.claude/plugins/cache/lounisbou/bugs-bot/0.1.0/bin/bugs-bot", machine["HOME"])
    else:
        fake_pm2.register(launcher_of(machine), str(tmp_path / "workspace"))

    assert cli.main(["install"], env=machine) == 0

    apps = fake_pm2.state["apps"]
    assert [(a["script"], a["cwd"]) for a in apps] == [(launcher_of(machine), machine["HOME"])]
    assert fake_pm2.verbs() == ["jlist", "delete", "start", "save"]


def test_a_pull_running_outside_pm2_is_reported_not_doubled(machine, fake_pm2, monkeypatch, capsys):
    monkeypatch.setattr(cli, "read_ps", lambda: PULL_PS)

    code = cli.main(["install"], env=machine)

    out = capsys.readouterr().out
    assert code == 1
    assert "FAIL  pull: a Pull already runs outside PM2 (pid 4242)" in out
    assert "start" not in fake_pm2.verbs() and fake_pm2.state["apps"] == []
    assert Path(launcher_of(machine)).is_file()  # the launcher is still installed


def test_without_pm2_it_says_how_to_get_it_and_still_installs_the_launcher(machine, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(install, "PM2_COMMAND", str(tmp_path / "absent" / "pm2"))

    code = cli.main(["install"], env=machine)

    out = capsys.readouterr().out
    assert code == 1
    assert "FAIL  pull: PM2 is not installed: `npm install -g pm2`, then /bugs-bot:install again" in out
    assert Path(launcher_of(machine)).is_file()


def test_a_missing_allow_rule_is_one_line_for_the_operator_and_no_settings_file_is_written(machine, capsys):
    settings = Path(machine["BUGS_BOT_CLAUDE_DIR"]) / "settings.json"
    settings.write_text(json.dumps({"permissions": {"allow": []}}))
    before = settings.read_text()

    code = cli.main(["install"], env=machine)

    out = capsys.readouterr().out
    assert code == 0
    assert [line for line in out.splitlines() if "allow rule" in line] == [
        "todo  allow rule: add it yourself, /permissions → Allow → Bash(bugs-bot:*)"
    ]
    assert settings.read_text() == before


def test_install_asks_no_platform_and_no_token_and_never_shows_one(machine, tmp_path, capsys):
    """No token file at all: install neither needs nor asks for one. With one, its value never shows."""
    Path(machine["BUGS_BOT_ENV_FILE"]).unlink()
    assert cli.main(["install"], env=machine) == 0
    first = capsys.readouterr().out
    assert "telegram" not in first.lower() and "slack" not in first.lower()

    Path(machine["BUGS_BOT_ENV_FILE"]).write_text(f"TELEGRAM_BOT_TOKEN={TOKEN}\n")
    assert cli.main(["install"], env=machine) == 0
    captured = capsys.readouterr()
    assert TOKEN not in captured.out + captured.err
