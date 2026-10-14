"""``token``: whether a platform's token is in the ``.env`` file; ``--set`` asks for it once, only when missing.

The value is read from a hidden prompt or standard input, never from the command line, and never printed.
"""

from __future__ import annotations

import io
import stat
from pathlib import Path

import pytest
from fake_slack import SLACK_TOKEN
from samples import TOKEN

from bugs_bot import cli
from bugs_bot.errors import BugsError
from bugs_bot.tokens import cmd_token


class Asker:
    """Stands for the hidden prompt: answers ``value`` and counts the questions."""

    def __init__(self, value: str) -> None:
        self.value = value
        self.asked: list[str] = []

    def __call__(self, prompt: str) -> str:
        self.asked.append(prompt)
        return self.value + "\n"


@pytest.fixture
def empty(tmp_path: Path, bugs_home: Path) -> dict[str, str]:
    """A machine whose ``.env`` holds another variable but no token."""
    env_file = tmp_path / "tokens.env"
    env_file.write_text("OTHER=1\n")
    return {"BUGS_BOT_ENV_FILE": str(env_file), "BUGS_BOT_HOME": str(bugs_home)}


def env_lines(env: dict[str, str]) -> list[str]:
    return Path(env["BUGS_BOT_ENV_FILE"]).read_text().splitlines()


def test_a_token_already_there_is_never_asked_again(env, capsys):
    ask = Asker("999:never-used-never-used")

    assert cmd_token(env, "telegram", True, ask) == 0

    out = capsys.readouterr().out
    assert ask.asked == [] and "telegram token: present" in out and TOKEN not in out


def test_a_missing_token_is_reported_without_set_and_nothing_is_asked_or_written(empty, capsys):
    ask = Asker(TOKEN)
    before = Path(empty["BUGS_BOT_ENV_FILE"]).read_text()

    assert cmd_token(empty, "telegram", False, ask) == 1

    assert ask.asked == [] and Path(empty["BUGS_BOT_ENV_FILE"]).read_text() == before
    assert "missing" in capsys.readouterr().out


@pytest.mark.parametrize("kind, value, name", [("telegram", TOKEN, "TELEGRAM_BOT_TOKEN"), ("slack", SLACK_TOKEN, "SLACK_BOT_TOKEN")])
def test_set_asks_once_writes_the_key_once_at_mode_0600_and_never_prints_it(empty, capsys, kind, value, name):
    ask = Asker(value)

    assert cmd_token(empty, kind, True, ask) == 0

    captured = capsys.readouterr()
    assert len(ask.asked) == 1 and value not in ask.asked[0]
    assert value not in captured.out + captured.err
    assert env_lines(empty) == ["OTHER=1", f"{name}={value}"]
    assert stat.S_IMODE(Path(empty["BUGS_BOT_ENV_FILE"]).stat().st_mode) == 0o600
    assert cmd_token(empty, kind, False) == 0  # read back as the channel reads it


def test_set_leaves_one_line_for_the_key_when_the_file_held_an_empty_one(empty):
    Path(empty["BUGS_BOT_ENV_FILE"]).write_text("TELEGRAM_BOT_TOKEN=\nOTHER=1\nTELEGRAM_BOT_TOKEN=''\n")

    assert cmd_token(empty, "telegram", True, Asker(TOKEN)) == 0

    assert env_lines(empty) == ["OTHER=1", f"TELEGRAM_BOT_TOKEN={TOKEN}"]


def test_set_creates_the_file_and_its_directory_when_absent(tmp_path, bugs_home):
    env = {"BUGS_BOT_HOME": str(bugs_home)}

    assert cmd_token(env, "telegram", True, Asker(TOKEN)) == 0

    path = bugs_home / ".env"
    assert path.read_text() == f"TELEGRAM_BOT_TOKEN={TOKEN}\n"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


@pytest.mark.parametrize("given", ["", "not-a-token-at-all-but-secret", SLACK_TOKEN])
def test_a_value_not_shaped_like_the_token_is_refused_unechoed_and_nothing_is_written(empty, given):
    before = Path(empty["BUGS_BOT_ENV_FILE"]).read_text()

    with pytest.raises(BugsError) as raised:
        cmd_token(empty, "telegram", True, Asker(given))

    assert (given == "" or given not in str(raised.value)) and "nothing written" in str(raised.value)
    assert Path(empty["BUGS_BOT_ENV_FILE"]).read_text() == before


def test_the_cli_reads_the_token_from_stdin_never_from_its_arguments(empty, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO(f"{SLACK_TOKEN}\n"))

    assert cli.main(["token", "--channel", "slack", "--set"], env=empty) == 0

    captured = capsys.readouterr()
    assert SLACK_TOKEN not in captured.out + captured.err
    assert f"SLACK_BOT_TOKEN={SLACK_TOKEN}" in env_lines(empty)
    with pytest.raises(SystemExit):
        cli.main(["token", "--channel", "slack", "--set", SLACK_TOKEN], env=empty)


def test_the_cli_check_exits_1_when_missing_and_0_when_present(empty, env):
    assert cli.main(["token", "--channel", "telegram"], env=empty) == 1
    assert cli.main(["token"], env=env) == 0
