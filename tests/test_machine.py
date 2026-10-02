"""Tests for the machine-wide files: the offset, the unregistered chats, the per-project stores."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from samples import BASE_DATE

from bugs_bot.errors import BugsError
from bugs_bot.registry import Registry
from bugs_bot.store import Machine, Store


@pytest.fixture
def machine(tmp_path) -> Machine:
    """Return a machine over an empty home."""
    return Machine(tmp_path / "home")


def test_the_registry_is_the_projects_file_of_the_home(machine, tmp_path):
    assert isinstance(machine.registry, Registry)
    assert machine.registry.path == tmp_path / "home" / "projects.json"


def test_the_offset_is_none_before_the_first_save(machine):
    assert machine.load_offset() is None


def test_the_offset_round_trips_in_the_machine_state_file(machine, tmp_path):
    machine.save_offset(11)
    assert machine.load_offset() == 11
    assert json.loads((tmp_path / "home" / "state.json").read_text()) == {"offset": 11}


def test_a_none_offset_is_saved_as_null(machine, tmp_path):
    machine.save_offset(11)
    machine.save_offset(None)
    assert machine.load_offset() is None
    assert json.loads((tmp_path / "home" / "state.json").read_text()) == {"offset": None}


def test_nothing_is_unregistered_at_first(machine):
    assert machine.unregistered() == {}


def test_note_unregistered_records_title_type_and_last_seen(machine, tmp_path):
    machine.note_unregistered({"id": -5, "title": "Famille", "type": "supergroup"}, BASE_DATE)
    seen = datetime.fromtimestamp(BASE_DATE, timezone.utc).isoformat()
    assert machine.unregistered() == {-5: {"title": "Famille", "type": "supergroup", "last_seen": seen}}
    assert json.loads((tmp_path / "home" / "unregistered.json").read_text()) == {
        "-5": {"title": "Famille", "type": "supergroup", "last_seen": seen}
    }


def test_note_unregistered_twice_keeps_one_entry_with_the_latest_sighting(machine):
    machine.note_unregistered({"id": -5, "title": "Old", "type": "group"}, BASE_DATE)
    machine.note_unregistered({"id": -5, "title": "New", "type": "supergroup"}, BASE_DATE + 60)
    [(chat_id, entry)] = machine.unregistered().items()
    assert chat_id == -5 and entry["title"] == "New" and entry["type"] == "supergroup"
    assert entry["last_seen"] == datetime.fromtimestamp(BASE_DATE + 60, timezone.utc).isoformat()


def test_note_unregistered_without_a_title_records_an_empty_one(machine):
    machine.note_unregistered({"id": -5, "type": "group"}, BASE_DATE)
    assert machine.unregistered()[-5]["title"] == ""


def test_project_store_is_the_project_directory(machine, tmp_path):
    store = machine.project_store("demo")
    assert isinstance(store, Store) and store.home == tmp_path / "home" / "demo"


@pytest.mark.parametrize("bad", ["../x", "a/b", "Demo", "", ".", "..", "a b", "demo/../x", "demo\n"])
def test_project_store_refuses_an_id_that_could_leave_the_home(machine, bad):
    with pytest.raises(BugsError, match="project"):
        machine.project_store(bad)


def test_a_corrupt_unregistered_log_is_an_empty_one_and_says_so(machine, tmp_path, capsys):
    (tmp_path / "home").mkdir()
    path = tmp_path / "home" / "unregistered.json"
    path.write_text("{nope")

    assert machine.unregistered() == {}

    err = capsys.readouterr().err.splitlines()
    assert len(err) == 1 and str(path) in err[0]


@pytest.mark.parametrize("content", ["[]", '{"x": {}}', '{"1": "a"}'])
def test_a_misshapen_unregistered_log_is_an_empty_one(machine, tmp_path, content, capsys):
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / "unregistered.json").write_text(content)

    assert machine.unregistered() == {}

    assert "unregistered.json" in capsys.readouterr().err


def test_noting_a_chat_repairs_a_corrupt_unregistered_log(machine, tmp_path):
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / "unregistered.json").write_text("{nope")

    machine.note_unregistered({"id": -5, "title": "T", "type": "group"}, BASE_DATE)

    assert set(machine.unregistered()) == {-5}


@pytest.mark.parametrize("content", ["{nope", "[]", "3"])
def test_a_corrupt_machine_state_is_an_error_naming_the_file(machine, tmp_path, content):
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / "state.json").write_text(content)

    with pytest.raises(BugsError, match="state.json"):
        machine.load_offset()
