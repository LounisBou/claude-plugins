"""Tests for the registry: which chat belongs to which project, and where its repository is."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bugs_bot.errors import BugsError
from bugs_bot.registry import Entry, Registry


@pytest.fixture
def registry(tmp_path: Path) -> Registry:
    """Return a registry over a file that does not exist yet."""
    return Registry(tmp_path / "projects.json")


def test_an_absent_file_is_an_empty_registry(registry):
    assert registry.entries() == {}
    assert registry.project_for(-1) is None
    assert registry.by_project("demo") is None


def test_add_then_look_up_both_ways(registry, tmp_path):
    registry.add(-100, "demo", tmp_path / "repo")
    assert registry.entries() == {-100: Entry("demo", tmp_path / "repo")}
    assert registry.project_for(-100) == Entry("demo", tmp_path / "repo")
    assert registry.by_project("demo") == (-100, Entry("demo", tmp_path / "repo"))


def test_the_file_has_the_documented_shape(registry, tmp_path):
    registry.add(-100, "demo", tmp_path / "repo")
    assert json.loads(registry.path.read_text()) == {"-100": {"project": "demo", "repo": str(tmp_path / "repo")}}


def test_add_is_idempotent(registry, tmp_path):
    registry.add(-100, "demo", tmp_path / "repo")
    before = registry.path.read_text()
    registry.add(-100, "demo", tmp_path / "repo")
    assert registry.path.read_text() == before


def test_add_updates_the_repo_of_the_same_project_and_chat(registry, tmp_path):
    registry.add(-100, "demo", tmp_path / "old")
    registry.add(-100, "demo", tmp_path / "new")
    assert registry.entries() == {-100: Entry("demo", tmp_path / "new")}


def test_the_same_project_under_a_new_chat_replaces_its_old_entry(registry, tmp_path):
    registry.add(-100, "demo", tmp_path / "repo")
    registry.add(-200, "demo", tmp_path / "repo")
    assert registry.entries() == {-200: Entry("demo", tmp_path / "repo")}


def test_a_chat_held_by_another_project_is_refused_and_nothing_changes(registry, tmp_path):
    registry.add(-100, "demo", tmp_path / "repo")
    before = registry.path.read_text()
    with pytest.raises(BugsError, match="demo"):
        registry.add(-100, "other", tmp_path / "x")
    assert registry.path.read_text() == before


def test_two_projects_live_side_by_side(registry, tmp_path):
    registry.add(-100, "a", tmp_path / "a")
    registry.add(-200, "b", tmp_path / "b")
    assert set(registry.entries()) == {-100, -200}


def test_remove_says_whether_it_removed_something(registry, tmp_path):
    registry.add(-100, "demo", tmp_path / "repo")
    assert registry.remove("ghost") is False
    assert registry.remove("demo") is True
    assert registry.entries() == {}
    assert registry.remove("demo") is False


@pytest.mark.parametrize("content", ["{nope", "[]", '{"x": {"project": "a", "repo": "/r"}}', '{"1": {"project": "a"}}',
                                     '{"1": {"project": "../a", "repo": "/r"}}', '{"1": "a"}'])
def test_an_unparseable_or_misshapen_file_is_a_clear_error(registry, content):
    registry.path.write_text(content)
    with pytest.raises(BugsError, match="projects.json"):
        registry.entries()


BAD_IDS = ["../evil", "demo/../x", "a/b", "a b", "demo\n"]


@pytest.mark.parametrize("bad", BAD_IDS)
def test_add_refuses_a_project_id_that_could_leave_the_home(registry, tmp_path, bad):
    with pytest.raises(BugsError, match="project"):
        registry.add(-1, bad, tmp_path)
    assert not registry.path.exists()


@pytest.mark.parametrize("bad", BAD_IDS)
def test_a_file_entry_with_a_project_id_that_could_leave_the_home_is_refused(registry, bad):
    registry.path.write_text(json.dumps({"1": {"project": bad, "repo": "/r"}}))
    with pytest.raises(BugsError, match="projects.json"):
        registry.entries()


def test_a_corrupt_file_is_never_overwritten_by_add(registry, tmp_path):
    registry.path.write_text("{nope")
    with pytest.raises(BugsError):
        registry.add(-1, "demo", tmp_path)
    assert registry.path.read_text() == "{nope"
