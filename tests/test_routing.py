"""Tests for routing: one machine-wide Pull serves several projects, each message to its own inbox."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import read_offset, register, reports
from samples import BASE_DATE, GROUP_ID, OTHER_GROUP_ID, FakeTelegram, message

from bugs_bot import cli
from bugs_bot.project import PROJECT_FILE
from bugs_bot.registry import Registry
from bugs_bot.store import Machine

STAMP = "20261002-083000"
FAMILY_ID = -1007777777777


def report_json(path: Path) -> dict:
    """Load a report directory's ``report.json``."""
    return json.loads((path / "report.json").read_text())


@pytest.fixture
def two(tmp_path, bugs_home, home, bound):
    """Register a second project, ``other``, next to ``demo``; return its data directory."""
    register(bugs_home, tmp_path / "repo-other", "other", OTHER_GROUP_ID, "Other Bugs")
    return bugs_home / "other"


# -- the registry decides ---------------------------------------------------------------------


def test_pull_with_no_project_registered_notes_the_chat_and_moves_the_offset(run, bugs_home, capsys):
    tg = FakeTelegram([message(10, 100, chat_id=FAMILY_ID, title="Famille", text="x")])

    assert run("pull", transport=tg) == 0

    machine = Machine(bugs_home)
    assert list(machine.unregistered()) == [FAMILY_ID]
    assert machine.load_offset() == 11
    assert f"unregistered chat {FAMILY_ID}" in capsys.readouterr().err
    assert [c["allowed_updates"] for c in tg.updates_calls()] == [["message"]]


def test_pull_with_no_project_registered_still_needs_the_token(bugs_home, tmp_path, capsys):
    env = {"BUGS_BOT_ENV_FILE": str(tmp_path / "missing.env"), "BUGS_BOT_HOME": str(bugs_home)}
    tg = FakeTelegram([message(10, 100, chat_id=FAMILY_ID, text="x")])

    assert cli.main(["pull"], transport=tg, env=env, now=BASE_DATE) == 1

    assert tg.calls == []


def test_a_first_group_is_found_by_init_while_pull_runs_with_an_empty_registry(run, bugs_home, tmp_path):
    from bugs_bot.init import InitArgs, cmd_init
    from test_init import git

    repo = tmp_path / "first"
    repo.mkdir()
    git(repo, "init", "-q")
    assert run("pull", transport=FakeTelegram([message(10, 100, chat_id=FAMILY_ID, title="Famille", text="x")])) == 0

    machine = Machine(bugs_home)
    given = InitArgs(project="first", agent_title="Agent : Famille")
    assert cmd_init(None, machine, repo, given, pull_running=True) == 0

    assert machine.registry.entries()[("telegram", FAMILY_ID)].project == "first"


def test_pull_asks_only_for_messages(run, bound):
    tg = FakeTelegram()

    assert run("pull", transport=tg) == 0

    assert [c["allowed_updates"] for c in tg.updates_calls()] == [["message"]]


# -- Review Focus 1: the offset is machine-wide, the reports are per project -------------------


def test_one_batch_of_two_projects_and_an_unregistered_group_lands_each_where_it_belongs(run, two, bound, capsys):
    tg = FakeTelegram(
        [
            message(10, 100, text="bug de demo"),
            message(11, 200, chat_id=OTHER_GROUP_ID, title="Other Bugs", text="bug de other"),
            message(12, 300, chat_id=FAMILY_ID, title="Famille", text="le repas de dimanche"),
        ]
    )

    assert run("pull", transport=tg) == 0

    [demo] = reports(bound)
    [other] = reports(two)
    assert report_json(demo)["text"] == "bug de demo" and demo.name == f"{STAMP}-100"
    assert report_json(other)["text"] == "bug de other" and other.name == f"{STAMP}-200"
    # the unregistered group is noted by id and title, its text is kept nowhere
    seen = Machine(bound.parent).unregistered()
    assert list(seen) == [FAMILY_ID] and seen[FAMILY_ID]["title"] == "Famille"
    assert not any("dimanche" in p.read_text() for p in bound.parent.rglob("*.json"))
    assert capsys.readouterr().err == f"bugs-bot: unregistered chat {FAMILY_ID} 'Famille' dropped\n"
    # one offset, past every update of the batch, whichever project or none it belonged to
    assert read_offset(bound) == 13
    assert not (bound / "state.json").exists() and not (two / "state.json").exists()


def test_two_messages_of_the_same_unregistered_chat_give_one_line_and_one_entry(run, bound, capsys):
    tg = FakeTelegram(
        [message(10, 100, chat_id=FAMILY_ID, title="Famille", text="a"), message(11, 101, chat_id=FAMILY_ID, title="Famille", text="b")]
    )

    assert run("pull", transport=tg) == 0

    assert capsys.readouterr().err.count("unregistered chat") == 1
    assert list(Machine(bound.parent).unregistered()) == [FAMILY_ID]


def test_a_private_chat_is_neither_routed_nor_noted(run, bound, capsys):
    tg = FakeTelegram([message(10, 100, chat_id=5, chat_type="private", title="Izno", text="salut")])

    assert run("pull", transport=tg) == 0

    assert Machine(bound.parent).unregistered() == {}
    assert "unregistered" not in capsys.readouterr().err
    assert reports(bound) == []
    assert read_offset(bound) == 11


def test_a_message_of_a_registered_chat_is_never_noted_as_unregistered(run, bound):
    assert run("pull", transport=FakeTelegram([message(10, 100, text="x")])) == 0

    assert Machine(bound.parent).unregistered() == {}


# -- Review Focus 2: a failure in one project never blocks or duplicates another ---------------


@pytest.mark.parametrize("failing_first", [True, False])
def test_a_failed_download_in_one_project_keeps_the_offset_and_blocks_no_other_project(run, two, bound, failing_first):
    broken = message(10, 100, chat_id=OTHER_GROUP_ID, title="Other Bugs", caption="une image", photo="p1")
    fine = message(11, 101, text="un texte pour demo")
    tg = FakeTelegram([broken, fine] if failing_first else [fine, broken])
    tg.fail_download = True

    assert run("pull", transport=tg) != 0

    # the healthy project's report is on disk although the batch failed, the broken one left nothing
    assert [report_json(p)["text"] for p in reports(bound)] == ["un texte pour demo"]
    assert reports(two) == []
    assert read_offset(bound) is None


def test_the_redelivered_batch_does_not_duplicate_what_the_other_project_already_has(run, two, bound, capsys):
    broken = message(10, 100, chat_id=OTHER_GROUP_ID, title="Other Bugs", caption="une image", photo="p1")
    fine = message(11, 101, text="un texte pour demo")
    tg = FakeTelegram([broken, fine])
    tg.fail_download = True
    assert run("pull", transport=tg) != 0
    [demo_first] = reports(bound)
    assert f"new {demo_first.name} " in capsys.readouterr().out
    # the launcher works on it between the two pulls: a retry must not rewrite it
    handled = report_json(demo_first) | {"status": "taken", "kind": "bug"}
    (demo_first / "report.json").write_text(json.dumps(handled))

    tg.fail_download = False
    assert run("pull", transport=tg) == 0

    # the report of the first pass is not announced a second time, only the one that is new
    announced = [line for line in capsys.readouterr().out.splitlines() if line.startswith("new ")]
    assert len(announced) == 1 and announced[0].endswith("in other")
    [demo] = reports(bound)
    # same report, same handling; only the pending 👀 reaction landed meanwhile
    assert demo.name == demo_first.name
    assert {k: v for k, v in report_json(demo).items() if k != "reaction"} == {k: v for k, v in handled.items() if k != "reaction"}
    [other] = reports(two)
    assert report_json(other)["images"] == ["1.jpg"] and (other / "1.jpg").exists()
    assert read_offset(bound) == 12
    # the whole batch was asked for again: the first pull confirmed nothing
    assert [c.get("offset") for c in tg.updates_calls()] == [None, None]


def test_a_corrupt_unregistered_log_stalls_no_project(run, bound, capsys):
    (bound.parent / "unregistered.json").write_text("{nope")
    tg = FakeTelegram([message(10, 100, text="pour demo"), message(11, 5, chat_id=-5, title="Inconnu", text="x")])

    assert run("pull", transport=tg) == 0

    assert len(reports(bound)) == 1
    assert "unregistered.json" in capsys.readouterr().err
    assert set(Machine(bound.parent).unregistered()) == {-5}


def test_a_corrupt_machine_state_fails_the_pull_naming_the_file(run, bound, capsys):
    (bound.parent / "state.json").write_text("{nope")

    assert run("pull", transport=FakeTelegram([message(10, 100, text="x")])) == 1

    assert str(bound.parent / "state.json") in capsys.readouterr().err
    assert reports(bound) == []


def test_every_failure_of_a_batch_is_said_not_only_the_first(run, two, bound, capsys):
    tg = FakeTelegram(
        [
            message(10, 100, caption="a", photo="p1"),
            message(11, 200, chat_id=OTHER_GROUP_ID, title="Other Bugs", caption="b", photo="p2"),
        ]
    )
    tg.fail_download = True

    assert run("pull", transport=tg) == 1

    err = capsys.readouterr().err
    assert "download of p1-l" in err and "download of p2-l" in err


def test_each_report_is_reacted_to_in_its_own_chat(run, two, bound):
    tg = FakeTelegram([message(10, 100, text="a"), message(11, 200, chat_id=OTHER_GROUP_ID, title="Other Bugs", text="b")])

    assert run("pull", transport=tg) == 0

    assert sorted((r["chat_id"], r["message_id"]) for r in tg.reactions) == sorted(
        [(GROUP_ID, 100), (OTHER_GROUP_ID, 200)]
    )


# -- retention is per project ------------------------------------------------------------------


def test_the_30_day_purge_visits_every_registered_project(run, two, bound):
    old = {"status": "done", "date": "2026-08-01T00:00:00+00:00"}
    for data in (bound, two):
        path = data / "inbox" / "20260801-000000-1"
        path.mkdir(parents=True)
        (path / "report.json").write_text(json.dumps(old))

    assert run("pull", now=BASE_DATE) == 0

    assert reports(bound) == [] and reports(two) == []


# -- --project, and the project of the current directory ---------------------------------------


def write_report(data: Path, report_id: str, text: str, chat_id: int) -> None:
    """Drop a minimal report in a project's inbox."""
    path = data / "inbox" / report_id
    path.mkdir(parents=True)
    (path / "report.json").write_text(
        json.dumps(
            {"id": report_id, "chat_id": chat_id, "message_ids": [5], "date": "2026-10-02T08:30:00+00:00", "author": "a",
             "author_id": 1, "author_username": "a", "text": text, "images": [], "status": "seen", "replies": []}
        )
    )


def test_the_project_of_the_current_directory_is_the_default(run, two, bound, capsys):
    write_report(bound, "20261002-083000-1", "du côté demo", GROUP_ID)
    write_report(two, "20261002-083000-2", "du côté other", OTHER_GROUP_ID)

    assert run("list") == 0

    out = capsys.readouterr().out
    assert "du côté demo" in out and "du côté other" not in out


def test_project_overrides_the_current_directory(run, two, bound, capsys):
    write_report(bound, "20261002-083000-1", "du côté demo", GROUP_ID)
    write_report(two, "20261002-083000-2", "du côté other", OTHER_GROUP_ID)

    assert run("list", "--project", "other") == 0

    out = capsys.readouterr().out
    assert "du côté other" in out and "du côté demo" not in out


def test_a_command_never_reaches_another_projects_report(run, two, bound, capsys):
    write_report(bound, "20261002-083000-1", "du côté demo", GROUP_ID)

    assert run("show", "20261002-083000-1", "--project", "other") != 0

    assert "no such report" in capsys.readouterr().err


def test_a_report_id_cannot_walk_into_another_projects_inbox(run, two, bound, capsys):
    write_report(two, "20261002-083000-2", "secret de other", OTHER_GROUP_ID)

    assert run("show", "../../other/inbox/20261002-083000-2", "--project", "demo") == 1

    captured = capsys.readouterr()
    assert "invalid report id" in captured.err
    assert "secret de other" not in captured.out + captured.err


@pytest.mark.parametrize("bad", ["ok/../../x", "ok/..", "a/b", ".hidden", "", "ok\n"])
def test_a_report_id_with_a_separator_or_a_leading_dot_is_refused(run, bound, bad, capsys):
    assert run("show", bad) == 1

    assert "invalid report id" in capsys.readouterr().err


def test_a_reply_goes_to_the_chat_of_the_project_it_is_for(run, two, bound):
    write_report(two, "20261002-083000-2", "du côté other", OTHER_GROUP_ID)
    tg = FakeTelegram()

    assert run("reply", "20261002-083000-2", "bien reçu", "--project", "other", transport=tg) == 0

    [sent] = tg.sent
    assert sent["chat_id"] == OTHER_GROUP_ID


def test_project_names_a_registered_project_only(run, bound, capsys):
    assert run("list", "--project", "ghost") != 0

    assert "ghost" in capsys.readouterr().err


@pytest.mark.parametrize("bad", ["../demo", "Demo", "a/b"])
def test_project_cannot_name_a_path(run, bound, bad, capsys):
    assert run("list", "--project", bad) != 0

    assert capsys.readouterr().err.startswith("bugs-bot: ")


def test_without_a_project_file_here_or_above_the_command_points_to_init(run, home, tmp_path, monkeypatch, capsys):
    bare = tmp_path / "bare"
    bare.mkdir()
    monkeypatch.chdir(bare)

    assert run("list") == 1

    assert capsys.readouterr().err == "bugs-bot: no .bugs-bot.json here or above: run /bugs-bot:init\n"


def test_pull_needs_no_project_of_the_current_directory(run, bound, tmp_path, monkeypatch):
    bare = tmp_path / "bare"
    bare.mkdir()
    monkeypatch.chdir(bare)

    assert run("pull", transport=FakeTelegram([message(10, 100, text="x")])) == 0

    assert len(reports(bound)) == 1


# -- a group promoted to supergroup gets a new chat id ----------------------------------------


def test_the_registry_and_the_project_file_follow_a_migrated_chat(run, bound, tmp_path, capsys):
    old = message(10, 1, chat_type="group")
    old["message"]["migrate_to_chat_id"] = FAMILY_ID
    tg = FakeTelegram([old, message(11, 2, chat_id=FAMILY_ID, text="après la migration")])

    assert run("pull", transport=tg) == 0

    registry = Registry(bound.parent / "projects.json")
    assert set(registry.entries()) == {("telegram", FAMILY_ID)}
    assert json.loads((tmp_path / "repo-demo" / PROJECT_FILE).read_text())["group"]["chat_id"] == FAMILY_ID
    [rep] = reports(bound)
    assert report_json(rep)["text"] == "après la migration"
    assert "rebound" in capsys.readouterr().out
    # the old id is dead: it is not offered as a new group either
    assert Machine(bound.parent).unregistered() == {}


def migrating_batch(*first: dict) -> list[dict]:
    """Return ``first`` followed by the service message promoting the demo group to FAMILY_ID."""
    promoted = message(99, 90, chat_type="group")
    promoted["message"]["migrate_to_chat_id"] = FAMILY_ID
    return [*first, promoted]


def test_a_report_sharing_a_batch_with_its_groups_migration_is_written(run, bound, capsys):
    tg = FakeTelegram(migrating_batch(message(10, 1, text="avant la migration", chat_type="group")))

    assert run("pull", transport=tg) == 0

    [rep] = reports(bound)
    assert report_json(rep)["text"] == "avant la migration"
    assert read_offset(bound) == 100
    # the old id is dead, it is neither dropped as unregistered nor offered as a new group
    assert Machine(bound.parent).unregistered() == {}
    assert "unregistered" not in capsys.readouterr().err


def test_a_batch_redelivered_after_its_migration_was_followed_still_lands_its_report(run, bound):
    tg = FakeTelegram(migrating_batch(message(10, 1, caption="une image", photo="p1", chat_type="group")))
    tg.fail_download = True
    assert run("pull", transport=tg) != 0
    assert read_offset(bound) is None

    tg.fail_download = False
    assert run("pull", transport=tg) == 0

    [rep] = reports(bound)
    assert report_json(rep)["images"] == ["1.jpg"] and (rep / "1.jpg").exists()
    assert read_offset(bound) == 100
    assert Machine(bound.parent).unregistered() == {}


# -- the migration is written project file first, registry after --------------------------------


def test_a_project_file_that_cannot_be_rebound_fails_the_pull_and_leaves_the_registry_alone(run, bound, tmp_path, capsys):
    path = tmp_path / "repo-demo" / PROJECT_FILE
    path.write_text("{nope")
    tg = FakeTelegram(migrating_batch(message(10, 1, text="x", chat_type="group")))

    assert run("pull", transport=tg) == 1

    captured = capsys.readouterr()
    assert str(path) in captured.err
    assert "rebound" not in captured.out
    assert set(Registry(bound.parent / "projects.json").entries()) == {("telegram", GROUP_ID)}
    assert read_offset(bound) is None


def test_a_project_file_that_cannot_be_written_fails_the_pull_and_leaves_the_registry_alone(
    run, bound, tmp_path, capsys, monkeypatch
):
    def refuse(path, data):
        raise PermissionError(13, "Permission denied", str(path))

    monkeypatch.setattr("bugs_bot.project.write_json", refuse)
    tg = FakeTelegram(migrating_batch(message(10, 1, text="x", chat_type="group")))

    assert run("pull", transport=tg) == 1

    captured = capsys.readouterr()
    assert str(tmp_path / "repo-demo" / PROJECT_FILE) in captured.err
    assert "rebound" not in captured.out
    assert set(Registry(bound.parent / "projects.json").entries()) == {("telegram", GROUP_ID)}
    assert read_offset(bound) is None


def test_a_followed_migration_is_idempotent_when_the_pull_is_retried(run, bound, tmp_path, capsys):
    path = tmp_path / "repo-demo" / PROJECT_FILE
    good = path.read_text()
    path.write_text("{nope")
    tg = FakeTelegram(migrating_batch(message(10, 1, text="x", chat_type="group")))
    assert run("pull", transport=tg) == 1
    path.write_text(good)

    assert run("pull", transport=tg) == 0

    assert set(Registry(bound.parent / "projects.json").entries()) == {("telegram", FAMILY_ID)}
    assert json.loads(path.read_text())["group"]["chat_id"] == FAMILY_ID
    assert "rebound" in capsys.readouterr().out


# -- a report written before a migration keeps the chat id it was written under -----------------


def test_commands_on_an_older_report_target_the_chat_the_report_was_written_in(run, two, bound):
    # the project's group moved on, this report still carries the id of the old chat
    write_report(bound, "20261002-083000-1", "avant", OTHER_GROUP_ID)
    for argv in (("taken",), ("fixed",), ("reply", "ok")):
        tg = FakeTelegram()
        assert run(argv[0], "20261002-083000-1", *argv[1:], transport=tg) == 0
        assert [c["chat_id"] for c in tg.reactions + tg.sent] == [OTHER_GROUP_ID]


def test_a_pending_reaction_of_an_older_report_is_retried_in_its_own_chat(run, two, bound):
    write_report(bound, "20261002-083000-1", "avant", OTHER_GROUP_ID)
    path = bound / "inbox" / "20261002-083000-1" / "report.json"
    path.write_text(json.dumps(json.loads(path.read_text()) | {"reaction": {"wanted": "👀", "applied": None, "error": None}}))
    tg = FakeTelegram()

    assert run("pull", transport=tg) == 0

    assert [r["chat_id"] for r in tg.reactions] == [OTHER_GROUP_ID]
    assert json.loads(path.read_text())["reaction"]["applied"] == "👀"


PROJECT_COMMANDS = [
    ["list"], ["show", "i"], ["reply", "i", "t"], ["edit", "i", "t"], ["fixed", "i"], ["taken", "i"], ["done", "i"],
    ["triage", "i", "bug"], ["wait"], ["pending"], ["post", "t"], ["backfill-authors"], ["agent-prompt", "--launcher", "l"],
    ["gate"], ["person", "r"], ["person-note", "r", "t"], ["overdue"], ["escalated", "i"], ["deployed", "abc1234"],
    ["handover", "write", "t"], ["handover", "read"],
]


@pytest.mark.parametrize("argv", PROJECT_COMMANDS, ids=lambda a: a[0])
def test_every_project_command_takes_project(argv):
    assert cli.build_parser().parse_args([*argv, "--project", "x"]).project == "x"
    assert cli.build_parser().parse_args(argv).project is None


def test_pull_is_machine_wide_and_takes_no_project():
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["pull", "--project", "x"])
