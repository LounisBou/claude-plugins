"""``bugs-bot plugin-path``: the host's record names the active install; the newest cached copy is a fallback."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bugs_bot import cli
from bugs_bot.errors import BugsError
from bugs_bot.plugin_path import plugin_path


@pytest.fixture
def claude(tmp_path: Path) -> Path:
    return tmp_path / "claude"


def env_of(claude: Path) -> dict[str, str]:
    return {"BUGS_BOT_CLAUDE_DIR": str(claude)}


def install(claude: Path, version: str) -> Path:
    path = claude / "plugins" / "cache" / "lounisbou" / "orchestrator" / version
    path.mkdir(parents=True)
    return path


def record(claude: Path, install_path: Path) -> None:
    entry = {"scope": "user", "installPath": str(install_path), "version": install_path.name}
    (claude / "plugins").mkdir(parents=True, exist_ok=True)
    (claude / "plugins" / "installed_plugins.json").write_text(json.dumps({"version": 2, "plugins": {"orchestrator@lounisbou": [entry]}}))


def test_the_record_wins_over_a_newer_stale_directory(claude):
    active = install(claude, "0.49.1")
    install(claude, "0.50.0")
    record(claude, active)

    assert plugin_path("orchestrator", env_of(claude)) == active


def test_a_version_installed_from_a_tag_is_found(claude):
    install(claude, "0.49.0")
    tagged = install(claude, "0.49.1-2afa38391c2b")
    record(claude, tagged)

    assert plugin_path("orchestrator", env_of(claude)) == tagged


def test_the_fallback_takes_the_newest_directory_when_there_is_no_record(claude):
    install(claude, "0.9.0")
    newest = install(claude, "0.10.0")

    assert plugin_path("orchestrator", env_of(claude)) == newest


def test_the_fallback_is_used_when_the_record_is_unreadable_or_stale(claude):
    newest = install(claude, "0.49.1")
    (claude / "plugins" / "installed_plugins.json").write_text("{not json")
    assert plugin_path("orchestrator", env_of(claude)) == newest

    record(claude, claude / "plugins" / "cache" / "lounisbou" / "orchestrator" / "gone")
    assert plugin_path("orchestrator", env_of(claude)) == newest


def test_a_plugin_that_is_nowhere_is_an_error(claude):
    with pytest.raises(BugsError):
        plugin_path("orchestrator", env_of(claude))


def test_the_command_prints_the_recorded_path(claude, capsys, monkeypatch):
    active = install(claude, "0.49.1")
    install(claude, "0.50.0")
    record(claude, active)

    code = cli.main(["plugin-path", "orchestrator"], env=env_of(claude))

    assert code == 0
    assert capsys.readouterr().out.strip() == str(active)
