"""Tests for the project file: parsing, validation, lookup from a directory or by name."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from bugs_bot.errors import BugsError
from bugs_bot.project import (
    DEFAULT_GATE_TOKENS,
    PROJECT_FILE,
    Project,
    dump_project,
    find_project_file,
    load_project,
    resolve_project,
)
from bugs_bot.registry import Registry

FULL = {
    "project": "demo",
    "group": {"chat_id": -100123, "title": "Demo Bugs"},
    "agent_title": "Agent : Demo Bugs",
    "deploy_url": "https://demo.example.org",
    "deploy_check": "true",
    "docs": ["docs/a.md", "docs/"],
    "language": "en",
    "gate_tokens": 200000,
    "follow_up_hours": 12,
}
MINIMAL = {"project": "demo", "group": {"chat_id": -100123, "title": "Demo Bugs"}, "agent_title": "Agent : Demo Bugs"}


def write_project(directory: Path, data: dict) -> Path:
    """Write ``data`` as the project file of ``directory``."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / PROJECT_FILE
    path.write_text(json.dumps(data))
    return path


def test_load_reads_every_field_and_sets_repo_to_the_file_directory(tmp_path):
    project = load_project(write_project(tmp_path / "repo", FULL))
    assert project == Project(
        project="demo", chat_id=-100123, title="Demo Bugs", agent_title="Agent : Demo Bugs",
        repo=tmp_path / "repo", deploy_url="https://demo.example.org", deploy_check="true",
        docs=("docs/a.md", "docs/"), language="en", gate_tokens=200000, follow_up_hours=12,
    )


def test_load_applies_the_defaults_to_a_minimal_file(tmp_path):
    project = load_project(write_project(tmp_path, MINIMAL))
    assert (project.deploy_url, project.deploy_check, project.docs) == (None, None, ())
    assert (project.language, project.gate_tokens, project.follow_up_hours) == ("fr", DEFAULT_GATE_TOKENS, 24)


@pytest.mark.parametrize(
    ("change", "key"),
    [
        ({"project": "Demo"}, "project"),
        ({"project": "../x"}, "project"),
        ({"project": "demo/../x"}, "project"),
        ({"project": "a/b"}, "project"),
        ({"project": "a b"}, "project"),
        ({"project": "demo\n"}, "project"),
        ({"project": ""}, "project"),
        ({"project": None}, "project"),
        ({"group": {"title": "T"}}, "chat_id"),
        ({"group": {"chat_id": "12", "title": "T"}}, "chat_id"),
        ({"group": {"chat_id": True, "title": "T"}}, "chat_id"),
        ({"group": {"chat_id": 1}}, "title"),
        ({"group": "x"}, "group"),
        ({"agent_title": ""}, "agent_title"),
        ({"gate_tokens": 0}, "gate_tokens"),
        ({"gate_tokens": -5}, "gate_tokens"),
        ({"gate_tokens": "lots"}, "gate_tokens"),
        ({"gate_tokens": True}, "gate_tokens"),
        ({"follow_up_hours": 0}, "follow_up_hours"),
        ({"follow_up_hours": -1}, "follow_up_hours"),
        ({"follow_up_hours": "24"}, "follow_up_hours"),
        ({"docs": "docs/"}, "docs"),
        ({"docs": [1]}, "docs"),
        ({"language": 3}, "language"),
        ({"deploy_url": 3}, "deploy_url"),
        ({"deploy_check": 3}, "deploy_check"),
        ({"channel": "irc"}, "channel"),
        ({"channel": 3}, "channel"),
        ({"channel": "slack"}, "chat_id"),  # a Slack channel id is a string
        ({"channel": "slack", "group": {"chat_id": "", "title": "T"}}, "chat_id"),
        ({"channel": "slack", "group": {"chat_id": "C12 3", "title": "T"}}, "chat_id"),
        ({"channel": "slack", "group": {"chat_id": "U123", "title": "T"}}, "chat_id"),  # a user, not a channel
        ({"channel": "telegram", "group": {"chat_id": "C123", "title": "T"}}, "chat_id"),
    ],
)
def test_load_refuses_an_invalid_value_and_names_the_key(tmp_path, change, key):
    path = write_project(tmp_path, FULL | change)
    with pytest.raises(BugsError, match=key):
        load_project(path)


@pytest.mark.parametrize("key", ["project", "group", "agent_title"])
def test_load_refuses_a_missing_required_key(tmp_path, key):
    data = {k: v for k, v in MINIMAL.items() if k != key}
    with pytest.raises(BugsError, match=key):
        load_project(write_project(tmp_path, data))


def test_load_refuses_a_file_that_is_not_json_or_not_an_object(tmp_path):
    path = tmp_path / PROJECT_FILE
    path.write_text("{nope")
    with pytest.raises(BugsError, match=PROJECT_FILE):
        load_project(path)
    path.write_text("[]")
    with pytest.raises(BugsError, match=PROJECT_FILE):
        load_project(path)


def test_load_accepts_a_fractional_follow_up(tmp_path):
    assert load_project(write_project(tmp_path, MINIMAL | {"follow_up_hours": 0.5})).follow_up_hours == 0.5


def test_dump_gives_the_documented_shape_without_repo(tmp_path):
    project = load_project(write_project(tmp_path, FULL))
    assert dump_project(project) == FULL


def test_dump_omits_what_is_unset_and_round_trips(tmp_path):
    project = load_project(write_project(tmp_path, MINIMAL))
    dumped = dump_project(project)
    assert "deploy_url" not in dumped and "deploy_check" not in dumped
    assert load_project(write_project(tmp_path / "again", dumped)) == replace(project, repo=tmp_path / "again")


def test_find_project_file_looks_in_the_directory_then_each_parent(tmp_path):
    path = write_project(tmp_path / "repo", MINIMAL)
    nested = tmp_path / "repo" / "a" / "b"
    nested.mkdir(parents=True)
    assert find_project_file(nested) == path
    assert find_project_file(tmp_path / "repo") == path


def test_find_project_file_returns_none_when_there_is_none(tmp_path):
    assert find_project_file(tmp_path) is None


def test_resolve_by_cwd(tmp_path):
    write_project(tmp_path / "repo", MINIMAL)
    nested = tmp_path / "repo" / "src"
    nested.mkdir()
    project = resolve_project(None, nested, Registry(tmp_path / "projects.json"))
    assert project.project == "demo" and project.repo == tmp_path / "repo"


def test_resolve_by_name_goes_through_the_registry_and_ignores_cwd(tmp_path):
    repo = tmp_path / "repo"
    write_project(repo, MINIMAL)
    write_project(tmp_path / "elsewhere", MINIMAL | {"project": "other"})
    registry = Registry(tmp_path / "projects.json")
    registry.add("telegram", -100123, "demo", repo)
    project = resolve_project("demo", tmp_path / "elsewhere", registry)
    assert project.project == "demo" and project.repo == repo


def test_resolve_refuses_when_no_project_file_is_here_or_above(tmp_path):
    with pytest.raises(BugsError, match=r"no \.bugs-bot\.json here or above: run /bugs-bot:init"):
        resolve_project(None, tmp_path, Registry(tmp_path / "projects.json"))


def test_resolve_refuses_an_unregistered_name(tmp_path):
    with pytest.raises(BugsError, match="ghost"):
        resolve_project("ghost", tmp_path, Registry(tmp_path / "projects.json"))


def test_resolve_refuses_a_registered_project_whose_file_is_gone(tmp_path):
    registry = Registry(tmp_path / "projects.json")
    registry.add("telegram", -1, "demo", tmp_path / "gone")
    with pytest.raises(BugsError, match="demo"):
        resolve_project("demo", tmp_path, registry)


def test_resolve_by_name_refuses_a_file_that_declares_another_project(tmp_path):
    repo = tmp_path / "repo"
    write_project(repo, MINIMAL | {"project": "other"})
    registry = Registry(tmp_path / "projects.json")
    registry.add("telegram", -100123, "demo", repo)
    with pytest.raises(BugsError, match="demo.*other|other.*demo"):
        resolve_project("demo", tmp_path, registry)


def test_a_file_without_channel_reads_as_telegram(tmp_path):
    assert load_project(write_project(tmp_path, MINIMAL)).channel == "telegram"


@pytest.mark.parametrize("chat_id", ["C0123ABCD", "G0123ABCD"])
def test_a_slack_project_takes_its_channel_id_as_a_string(tmp_path, chat_id):
    data = MINIMAL | {"group": {"chat_id": chat_id, "title": "demo-bugs"}, "channel": "slack"}

    project = load_project(write_project(tmp_path, data))

    assert (project.channel, project.chat_id) == ("slack", chat_id)
    assert dump_project(project) == {**data, "docs": [], "language": "fr", "gate_tokens": DEFAULT_GATE_TOKENS, "follow_up_hours": 24}


def test_dump_writes_channel_only_when_it_is_not_telegram(tmp_path):
    # A Telegram project's file stays as it always was, key for key.
    assert "channel" not in dump_project(load_project(write_project(tmp_path, MINIMAL | {"channel": "telegram"})))
