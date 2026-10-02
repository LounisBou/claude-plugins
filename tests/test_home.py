"""Where the machine's files live: ``BUGS_BOT_HOME`` and the token file."""

from __future__ import annotations

from pathlib import Path

import pytest
from samples import TOKEN

from bugs_bot.errors import BugsError
from bugs_bot.store import DEFAULT_HOME, bugs_home
from bugs_bot.telegram import read_token


def test_the_default_home_is_dot_bugs_bot_in_the_user_home():
    assert DEFAULT_HOME == Path.home() / ".bugs-bot"


def test_bugs_home_defaults_and_is_overridden_by_the_environment(tmp_path):
    assert bugs_home({}) == DEFAULT_HOME
    assert bugs_home({"BUGS_BOT_HOME": ""}) == DEFAULT_HOME
    assert bugs_home({"BUGS_BOT_HOME": str(tmp_path)}) == tmp_path


def test_the_token_defaults_to_the_env_file_of_the_home(tmp_path):
    (tmp_path / ".env").write_text(f"TELEGRAM_BOT_TOKEN={TOKEN}\n")
    assert read_token({"BUGS_BOT_HOME": str(tmp_path)}) == TOKEN


def test_the_env_file_override_wins_over_the_home(tmp_path):
    (tmp_path / ".env").write_text("TELEGRAM_BOT_TOKEN=from-home\n")
    other = tmp_path / "other.env"
    other.write_text(f"TELEGRAM_BOT_TOKEN={TOKEN}\n")
    assert read_token({"BUGS_BOT_HOME": str(tmp_path), "BUGS_BOT_ENV_FILE": str(other)}) == TOKEN


def test_the_legacy_variable_names_are_not_read(tmp_path):
    (tmp_path / "legacy.env").write_text(f"TELEGRAM_BOT_TOKEN={TOKEN}\n")
    with pytest.raises(BugsError):
        read_token({"BUGS_BOT_HOME": str(tmp_path), "TM_BUGS_ENV_FILE": str(tmp_path / "legacy.env")})
