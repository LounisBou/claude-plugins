"""``init`` and ``remove``: the project file, the registry, the git exclude, group discovery."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from samples import GROUP_ID, OTHER_GROUP_ID, TOKEN, FakeTelegram, message

from bugs_bot import cli, init
from bugs_bot.errors import BugsError
from bugs_bot.init import InitArgs, add_exclude, cmd_init, cmd_remove, discover_groups, git_exclude_path
from bugs_bot.project import PROJECT_FILE, load_project
from bugs_bot.registry import Registry
from bugs_bot.store import Machine
from bugs_bot.telegram import TelegramChannel

EXCLUDE_LINE = "/" + PROJECT_FILE


def git(repo: Path, *argv: str) -> str:
    """Run git in ``repo`` with an identity of its own; return stdout."""
    result = subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", *argv],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A fresh git repository."""
    path = tmp_path / "repo"
    path.mkdir()
    git(path, "init", "-q")
    return path


@pytest.fixture
def machine(bugs_home: Path) -> Machine:
    return Machine(bugs_home)


def channel_with(*updates: dict) -> tuple[TelegramChannel, FakeTelegram]:
    tg = FakeTelegram(list(updates))
    return TelegramChannel(TOKEN, tg), tg


def args(**given) -> InitArgs:
    """The arguments of a first run, overridden by ``given``."""
    base = {"project": "demo", "agent_title": "Agent : Demo Bugs", "chat_id": GROUP_ID, "title": "Demo Bugs"}
    return InitArgs(**{**base, **given})


# -- the git exclude ------------------------------------------------------------


def test_git_exclude_path_is_absolute_and_inside_the_git_dir(repo):
    path = git_exclude_path(repo)

    assert path.is_absolute()
    assert path == (repo / ".git" / "info" / "exclude").resolve() or path == repo / ".git" / "info" / "exclude"


def test_git_exclude_path_of_a_worktree_is_the_common_git_dirs(repo, tmp_path):
    git(repo, "commit", "-q", "--allow-empty", "-m", "x")
    worktree = tmp_path / "wt"
    git(repo, "worktree", "add", "-q", str(worktree), "-b", "other")

    assert git_exclude_path(worktree).resolve() == (repo / ".git" / "info" / "exclude").resolve()


def test_git_exclude_path_outside_a_repository_is_refused(tmp_path):
    with pytest.raises(BugsError, match="git"):
        git_exclude_path(tmp_path)


def test_add_exclude_appends_once(repo):
    assert add_exclude(repo) is True
    assert add_exclude(repo) is False

    lines = git_exclude_path(repo).read_text().splitlines()
    assert lines.count(EXCLUDE_LINE) == 1


def test_add_exclude_keeps_existing_lines_and_ends_a_line_without_newline(repo):
    path = git_exclude_path(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("*.log")

    add_exclude(repo)

    assert path.read_text().splitlines() == ["*.log", EXCLUDE_LINE]


def test_the_project_file_is_then_ignored_by_git(repo):
    add_exclude(repo)
    (repo / PROJECT_FILE).write_text("{}")

    assert git(repo, "status", "--porcelain") == ""


# -- discovery ------------------------------------------------------------------


def test_discovery_reads_updates_without_an_offset_when_pull_is_not_running(machine):
    channel, tg = channel_with(message(10, 100, text="salut"), message(11, 5, chat_id=OTHER_GROUP_ID, title="Famille"))

    found = discover_groups(channel, machine, pull_running=False)

    assert {cid: chat["title"] for cid, chat in found.items()} == {GROUP_ID: "TM Bugs", OTHER_GROUP_ID: "Famille"}
    assert tg.updates_calls() and all("offset" not in p for p in tg.updates_calls())
    # Telegram keeps the last setting: asking for more than Pull does would change what Pull receives
    assert [p["allowed_updates"] for p in tg.updates_calls()] == [["message"]]
    assert machine.load_offset() is None


def test_discovery_while_pull_runs_reads_unregistered_and_never_calls_get_updates(machine):
    """A getUpdates here would cut Pull's held request: Telegram answers 409 to one of two pollers."""
    machine.note_unregistered({"id": GROUP_ID, "title": "New Bugs", "type": "supergroup"}, 1790929800)
    channel, tg = channel_with(message(10, 100, text="never read", chat_id=OTHER_GROUP_ID, title="Famille"))

    found = discover_groups(channel, machine, pull_running=True)

    assert {cid: chat["title"] for cid, chat in found.items()} == {GROUP_ID: "New Bugs"}
    assert tg.updates_calls() == []


def test_discovery_merges_updates_with_what_pull_dropped(machine):
    machine.note_unregistered({"id": OTHER_GROUP_ID, "title": "Famille", "type": "group"}, 1790929800)
    channel, _ = channel_with(message(10, 100, text="a"))

    assert set(discover_groups(channel, machine, pull_running=False)) == {GROUP_ID, OTHER_GROUP_ID}


def test_discovery_without_a_channel_is_the_unregistered_log(machine):
    machine.note_unregistered({"id": GROUP_ID, "title": "New Bugs", "type": "supergroup"}, 1790929800)

    assert set(discover_groups(None, machine, pull_running=False)) == {GROUP_ID}


def test_discovery_ignores_a_private_chat(machine):
    channel, _ = channel_with(message(10, 100, chat_type="private", title="TM Bugs", text="a"))

    assert discover_groups(channel, machine, pull_running=False) == {}


def test_discovery_drops_a_migrated_chat(machine):
    old = message(10, 1, chat_id=OTHER_GROUP_ID, chat_type="group")
    old["message"]["migrate_to_chat_id"] = GROUP_ID
    new = message(11, 2)
    new["message"]["migrate_from_chat_id"] = OTHER_GROUP_ID
    channel, _ = channel_with(old, new)

    assert set(discover_groups(channel, machine, pull_running=False)) == {GROUP_ID}


# -- init: first run ------------------------------------------------------------


def test_init_with_one_discovered_group_writes_the_file_and_registers(repo, machine, capsys):
    channel, tg = channel_with(message(10, 100, text="salut"))
    given = args(chat_id=None, title=None)

    assert cmd_init(channel, machine, repo, given, pull_running=False) == 0

    project = load_project(repo / PROJECT_FILE)
    assert (project.project, project.chat_id, project.title, project.agent_title) == ("demo", GROUP_ID, "TM Bugs", "Agent : Demo Bugs")
    assert machine.registry.project_for("telegram", GROUP_ID).project == "demo"
    assert machine.load_offset() is None
    assert all("offset" not in p for p in tg.updates_calls())
    out = capsys.readouterr().out
    assert PROJECT_FILE in out and str(GROUP_ID) in out


def test_init_with_explicit_group_needs_no_channel(repo, machine):
    assert cmd_init(None, machine, repo, args(), pull_running=False) == 0

    assert load_project(repo / PROJECT_FILE).chat_id == GROUP_ID


def test_init_writes_every_option(repo, machine):
    given = args(
        deploy_url="https://x.example", deploy_check="curl -f x", docs=("docs/a.md", "docs/"), language="en", gate_tokens=150000
    )

    cmd_init(None, machine, repo, given, pull_running=False)

    project = load_project(repo / PROJECT_FILE)
    assert project.deploy_url == "https://x.example" and project.deploy_check == "curl -f x"
    assert project.docs == ("docs/a.md", "docs/") and project.language == "en" and project.gate_tokens == 150000


def test_init_in_a_subdirectory_keeps_its_project_file_out_of_git_status(repo, machine):
    sub = repo / "services" / "api"
    sub.mkdir(parents=True)

    assert cmd_init(None, machine, sub, args(), pull_running=False) == 0

    assert (sub / PROJECT_FILE).exists()
    assert git(repo, "status", "--porcelain") == ""
    assert "/services/api/" + PROJECT_FILE in git_exclude_path(repo).read_text().splitlines()


def test_init_at_the_root_still_writes_the_root_anchored_line(repo, machine):
    cmd_init(None, machine, repo, args(), pull_running=False)

    assert git_exclude_path(repo).read_text().splitlines().count(EXCLUDE_LINE) == 1
    assert git(repo, "status", "--porcelain") == ""


def test_init_adds_the_exclude_line_and_leaves_gitignore_alone(repo, machine):
    cmd_init(None, machine, repo, args(), pull_running=False)

    assert EXCLUDE_LINE in git_exclude_path(repo).read_text().splitlines()
    assert not (repo / ".gitignore").exists()
    assert git(repo, "status", "--porcelain") == ""


def test_init_first_run_without_project_or_agent_title_is_refused(repo, machine):
    with pytest.raises(BugsError, match="--project"):
        cmd_init(None, machine, repo, args(project=None), pull_running=False)
    with pytest.raises(BugsError, match="--agent-title"):
        cmd_init(None, machine, repo, args(agent_title=None), pull_running=False)

    assert not (repo / PROJECT_FILE).exists()
    assert machine.registry.entries() == {}


def test_init_refuses_a_bad_project_id_before_writing_anything(repo, machine):
    with pytest.raises(BugsError, match="project"):
        cmd_init(None, machine, repo, args(project="Bad Id"), pull_running=False)

    assert not (repo / PROJECT_FILE).exists()
    assert machine.registry.entries() == {}


def test_init_chat_id_without_title_is_refused(repo, machine):
    with pytest.raises(BugsError, match="--title"):
        cmd_init(None, machine, repo, args(title=None), pull_running=False)

    assert not (repo / PROJECT_FILE).exists()


def test_init_title_without_chat_id_is_refused(repo, machine):
    with pytest.raises(BugsError, match="--chat-id"):
        cmd_init(None, machine, repo, args(chat_id=None), pull_running=False)


def test_init_refuses_a_chat_held_by_another_project_and_writes_nothing(repo, machine, tmp_path):
    machine.registry.add("telegram", GROUP_ID, "other", tmp_path / "elsewhere")

    with pytest.raises(BugsError, match="other"):
        cmd_init(None, machine, repo, args(), pull_running=False)

    assert not (repo / PROJECT_FILE).exists()
    assert machine.registry.project_for("telegram", GROUP_ID).project == "other"


# -- init: discovery outcomes (the cases of the former `bind`) --------------------


def test_init_with_no_group_lists_nothing_and_exits_1(repo, machine, capsys):
    channel, _ = channel_with(message(10, 100, chat_type="private", text="a"))

    assert cmd_init(channel, machine, repo, args(chat_id=None, title=None), pull_running=False) == 1

    assert not (repo / PROJECT_FILE).exists()
    assert machine.registry.entries() == {}
    assert "no group" in capsys.readouterr().err.lower()


def test_init_with_zero_updates_exits_1(repo, machine):
    channel, _ = channel_with()

    assert cmd_init(channel, machine, repo, args(chat_id=None, title=None), pull_running=False) == 1

    assert not (repo / PROJECT_FILE).exists()


def test_init_with_two_groups_lists_them_and_never_guesses(repo, machine, capsys):
    channel, _ = channel_with(message(10, 100, text="a"), message(11, 5, chat_id=OTHER_GROUP_ID, title="Famille"))

    assert cmd_init(channel, machine, repo, args(chat_id=None, title=None), pull_running=False) == 1

    captured = capsys.readouterr()
    assert "several" in captured.err.lower()
    assert "TM Bugs" in captured.out and "Famille" in captured.out and str(OTHER_GROUP_ID) in captured.out
    assert not (repo / PROJECT_FILE).exists()
    assert machine.registry.entries() == {}


def test_init_two_unmigrated_groups_next_to_a_migrated_one_are_still_refused(repo, machine):
    old = message(10, 1, chat_id=OTHER_GROUP_ID, chat_type="group")
    old["message"]["migrate_to_chat_id"] = GROUP_ID
    new = message(11, 2)
    new["message"]["migrate_from_chat_id"] = OTHER_GROUP_ID
    channel, _ = channel_with(old, new, message(12, 9, chat_id=-1007777777777, title="Autre"))

    assert cmd_init(channel, machine, repo, args(chat_id=None, title=None), pull_running=False) == 1


def test_init_a_migrated_chat_is_dropped_and_the_remaining_one_chosen(repo, machine):
    old = message(10, 1, chat_id=OTHER_GROUP_ID, chat_type="group")
    old["message"]["migrate_to_chat_id"] = GROUP_ID
    new = message(11, 2)
    new["message"]["migrate_from_chat_id"] = OTHER_GROUP_ID
    channel, _ = channel_with(old, new)

    assert cmd_init(channel, machine, repo, args(chat_id=None, title=None), pull_running=False) == 0

    assert load_project(repo / PROJECT_FILE).chat_id == GROUP_ID


def test_init_does_not_offer_a_group_another_project_already_holds(repo, machine, tmp_path):
    machine.registry.add("telegram", OTHER_GROUP_ID, "other", tmp_path / "elsewhere")
    channel, _ = channel_with(message(10, 100, text="a"), message(11, 5, chat_id=OTHER_GROUP_ID, title="Famille"))

    assert cmd_init(channel, machine, repo, args(chat_id=None, title=None), pull_running=False) == 0

    assert load_project(repo / PROJECT_FILE).chat_id == GROUP_ID


def test_init_keeps_the_stored_offset(repo, machine):
    machine.save_offset(33)
    channel, _ = channel_with(message(40, 100, text="a"))

    cmd_init(channel, machine, repo, args(chat_id=None, title=None), pull_running=False)

    assert machine.load_offset() == 33


def test_init_while_pull_runs_finds_the_group_in_the_unregistered_log_without_get_updates(repo, machine):
    machine.note_unregistered({"id": GROUP_ID, "title": "New Bugs", "type": "supergroup"}, 1790929800)
    channel, tg = channel_with(message(10, 100, text="never read", chat_id=OTHER_GROUP_ID, title="Famille"))

    assert cmd_init(channel, machine, repo, args(chat_id=None, title=None), pull_running=True) == 0

    assert tg.updates_calls() == []
    assert load_project(repo / PROJECT_FILE).chat_id == GROUP_ID


def test_init_discovery_without_a_channel_says_how_to_go_on(repo, machine):
    with pytest.raises(BugsError, match="--chat-id"):
        cmd_init(None, machine, repo, args(chat_id=None, title=None), pull_running=False)


# -- init: re-run ---------------------------------------------------------------


def test_init_rerun_updates_the_file_keeps_unspecified_values_and_never_duplicates(repo, machine):
    cmd_init(None, machine, repo, args(deploy_url="https://x.example", docs=("docs/",)), pull_running=False)
    rerun = InitArgs(language="en")

    assert cmd_init(None, machine, repo, rerun, pull_running=False) == 0

    project = load_project(repo / PROJECT_FILE)
    assert project.language == "en"
    assert (project.project, project.chat_id, project.agent_title) == ("demo", GROUP_ID, "Agent : Demo Bugs")
    assert project.deploy_url == "https://x.example" and project.docs == ("docs/",)
    assert machine.registry.entries().keys() == {("telegram", GROUP_ID)}
    assert git_exclude_path(repo).read_text().splitlines().count(EXCLUDE_LINE) == 1


def test_init_rerun_with_a_new_group_replaces_the_registry_entry(repo, machine):
    cmd_init(None, machine, repo, args(), pull_running=False)

    cmd_init(None, machine, repo, InitArgs(chat_id=OTHER_GROUP_ID, title="Moved"), pull_running=False)

    assert machine.registry.entries().keys() == {("telegram", OTHER_GROUP_ID)}
    assert load_project(repo / PROJECT_FILE).title == "Moved"


def test_init_rerun_restores_a_missing_registry_entry(repo, machine):
    cmd_init(None, machine, repo, args(), pull_running=False)
    machine.registry.remove("demo")

    cmd_init(None, machine, repo, InitArgs(), pull_running=False)

    assert machine.registry.project_for("telegram", GROUP_ID).project == "demo"


def test_init_rerun_does_not_look_for_a_group(repo, machine):
    cmd_init(None, machine, repo, args(), pull_running=False)
    channel, tg = channel_with(message(10, 100, text="a", chat_id=OTHER_GROUP_ID, title="Famille"))

    assert cmd_init(channel, machine, repo, InitArgs(), pull_running=False) == 0

    assert tg.updates_calls() == []
    assert load_project(repo / PROJECT_FILE).chat_id == GROUP_ID


def test_init_rerun_under_another_project_id_is_refused(repo, machine):
    cmd_init(None, machine, repo, args(), pull_running=False)

    with pytest.raises(BugsError, match="demo"):
        cmd_init(None, machine, repo, InitArgs(project="renamed"), pull_running=False)

    assert load_project(repo / PROJECT_FILE).project == "demo"


def test_init_rerun_on_an_unreadable_project_file_is_refused_not_overwritten(repo, machine):
    (repo / PROJECT_FILE).write_text("{not json")

    with pytest.raises(BugsError, match="JSON"):
        cmd_init(None, machine, repo, args(), pull_running=False)

    assert (repo / PROJECT_FILE).read_text() == "{not json"


def test_init_refuses_a_project_id_registered_for_another_repository(repo, machine, tmp_path):
    other = tmp_path / "other-repo"
    other.mkdir()
    git(other, "init", "-q")
    cmd_init(None, machine, other, args(), pull_running=False)
    before = (machine.registry.path.read_text(), (other / PROJECT_FILE).read_text())

    with pytest.raises(BugsError, match=str(other)):
        cmd_init(None, machine, repo, args(chat_id=OTHER_GROUP_ID, title="Elsewhere"), pull_running=False)

    assert (machine.registry.path.read_text(), (other / PROJECT_FILE).read_text()) == before
    assert not (repo / PROJECT_FILE).exists()


def test_init_validates_before_writing_anything(repo, machine):
    with pytest.raises(BugsError, match="gate_tokens"):
        cmd_init(None, machine, repo, args(gate_tokens=0), pull_running=False)

    assert not (repo / PROJECT_FILE).exists()
    assert machine.registry.entries() == {}


def test_cli_init_with_an_invalid_value_exits_1_and_writes_nothing(run, repo, bugs_home, monkeypatch, capsys):
    monkeypatch.setattr(cli, "read_ps", lambda: "")
    monkeypatch.chdir(repo)

    code = run("init", "--project", "demo", "--agent-title", "A", "--chat-id", "-5", "--title", "T", "--gate-tokens", "0")

    assert code == 1
    assert not (repo / PROJECT_FILE).exists()
    assert Registry(bugs_home / "projects.json").entries() == {}
    assert "gate_tokens" in capsys.readouterr().err


# -- remove ---------------------------------------------------------------------


def test_remove_drops_the_registry_entry_and_keeps_data_and_file(repo, machine, capsys):
    cmd_init(None, machine, repo, args(), pull_running=False)
    data = machine.project_store("demo").home
    (data / "inbox").mkdir(parents=True)
    capsys.readouterr()

    cmd_remove(machine, "demo")

    assert machine.registry.entries() == {}
    assert (data / "inbox").is_dir() and (repo / PROJECT_FILE).is_file()
    out = capsys.readouterr().out
    assert str(data) in out and str(repo / PROJECT_FILE) in out


def test_remove_of_an_unregistered_project_says_so(repo, machine, capsys):
    cmd_init(None, machine, repo, args(), pull_running=False)
    machine.registry.remove("demo")
    capsys.readouterr()

    cmd_remove(machine, "demo")

    assert "not registered" in capsys.readouterr().out


def test_remove_never_needs_the_project_file(repo, machine, capsys):
    cmd_init(None, machine, repo, args(), pull_running=False)
    data = machine.project_store("demo").home
    (data / "inbox").mkdir(parents=True)
    (repo / PROJECT_FILE).unlink()

    cmd_remove(machine, "demo")

    assert machine.registry.entries() == {}
    assert (data / "inbox").is_dir()


def test_cli_remove_by_name_with_a_missing_project_file(run, repo, bugs_home, no_pull, monkeypatch):
    monkeypatch.chdir(repo)
    run("init", "--project", "demo", "--agent-title", "A", "--chat-id", "-5", "--title", "T")
    (repo / PROJECT_FILE).unlink()
    monkeypatch.chdir(repo.parent)

    assert run("remove", "--project", "demo") == 0

    assert Registry(bugs_home / "projects.json").entries() == {}


def test_cli_remove_by_name_with_a_corrupt_project_file_keeps_it(run, repo, bugs_home, no_pull, monkeypatch):
    monkeypatch.chdir(repo)
    run("init", "--project", "demo", "--agent-title", "A", "--chat-id", "-5", "--title", "T")
    (repo / PROJECT_FILE).write_text("{corrupt")
    (bugs_home / "demo").mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(repo.parent)

    assert run("remove", "--project", "demo") == 0

    assert Registry(bugs_home / "projects.json").entries() == {}
    assert (repo / PROJECT_FILE).read_text() == "{corrupt"
    assert (bugs_home / "demo").is_dir()


def test_cli_remove_from_the_repository_with_a_corrupt_file(run, repo, bugs_home, no_pull, monkeypatch):
    monkeypatch.chdir(repo)
    run("init", "--project", "demo", "--agent-title", "A", "--chat-id", "-5", "--title", "T")
    (repo / PROJECT_FILE).write_text("{corrupt")

    assert run("remove") == 0

    assert Registry(bugs_home / "projects.json").entries() == {}


def test_cli_remove_of_an_unknown_project_says_so(run, no_pull, capsys):
    assert run("remove", "--project", "ghost") == 0

    assert "not registered: ghost" in capsys.readouterr().out


# -- through the CLI ------------------------------------------------------------


@pytest.fixture
def no_pull(monkeypatch):
    """The process table is never read by a test: ``ps`` says nothing runs."""
    monkeypatch.setattr(cli, "read_ps", lambda: "")


def test_cli_init_end_to_end(run, repo, bugs_home, no_pull, monkeypatch):
    monkeypatch.chdir(repo)

    code = run("init", "--project", "demo", "--agent-title", "Agent : Demo Bugs", "--chat-id", str(GROUP_ID), "--title", "Demo Bugs")

    assert code == 0
    assert json.loads((repo / PROJECT_FILE).read_text())["group"] == {"chat_id": GROUP_ID, "title": "Demo Bugs"}
    assert Registry(bugs_home / "projects.json").project_for("telegram", GROUP_ID).repo == repo.resolve()


def test_cli_init_repo_option_names_the_repository(run, repo, no_pull):
    code = run("init", "--repo", str(repo), "--project", "demo", "--agent-title", "A", "--chat-id", "-5", "--title", "T")

    assert code == 0 and (repo / PROJECT_FILE).is_file()


def test_cli_init_discovers_through_the_bot_and_never_prints_the_token(run, repo, no_pull, monkeypatch, capsys):
    monkeypatch.chdir(repo)
    tg = FakeTelegram([message(10, 100, text="salut")])

    assert run("init", "--project", "demo", "--agent-title", "A", transport=tg) == 0

    captured = capsys.readouterr()
    assert TOKEN not in captured.out + captured.err
    assert load_project(repo / PROJECT_FILE).chat_id == GROUP_ID


def test_cli_init_while_pull_runs_makes_no_get_updates(run, repo, bugs_home, monkeypatch):
    monkeypatch.setattr(cli, "read_ps", lambda: "  4242 python3 /x/bin/bugs-bot pull --watch\n")
    monkeypatch.chdir(repo)
    Machine(bugs_home).note_unregistered({"id": GROUP_ID, "title": "New Bugs", "type": "supergroup"}, 1790929800)
    tg = FakeTelegram([message(10, 100, text="never read", chat_id=OTHER_GROUP_ID, title="Famille")])

    assert run("init", "--project", "demo", "--agent-title", "A", transport=tg) == 0

    assert tg.updates_calls() == []


@pytest.fixture
def broken_ps(monkeypatch):
    def fail():
        raise BugsError("cannot read the process table: boom")

    monkeypatch.setattr(cli, "read_ps", fail)


def test_cli_init_with_an_explicit_group_never_reads_the_process_table(run, repo, broken_ps, monkeypatch):
    monkeypatch.chdir(repo)

    code = run("init", "--project", "demo", "--agent-title", "A", "--chat-id", "-5", "--title", "T")

    assert code == 0 and (repo / PROJECT_FILE).is_file()


def test_cli_init_rerun_never_reads_the_process_table(run, repo, no_pull, broken_ps, monkeypatch):
    monkeypatch.chdir(repo)
    cmd_init(None, Machine(repo.parent / "bugs-bot"), repo, args(), pull_running=False)

    assert run("init") == 0


def test_cli_init_discovery_says_when_the_process_table_cannot_be_read(run, repo, bugs_home, broken_ps, monkeypatch, capsys):
    monkeypatch.chdir(repo)

    code = run("init", "--project", "demo", "--agent-title", "A", transport=FakeTelegram([message(10, 100, text="x")]))

    assert code == 1
    assert "process table" in capsys.readouterr().err
    assert not (repo / PROJECT_FILE).exists()


def test_cli_init_outside_a_git_repository_is_refused(run, no_pull, capsys):
    assert run("init", "--project", "demo", "--agent-title", "A", "--chat-id", "-5", "--title", "T") == 1

    assert "git" in capsys.readouterr().err


def test_cli_remove_by_name_keeps_the_file(run, repo, bugs_home, no_pull, monkeypatch):
    monkeypatch.chdir(repo)
    run("init", "--project", "demo", "--agent-title", "A", "--chat-id", "-5", "--title", "T")
    monkeypatch.chdir(repo.parent)

    assert run("remove", "--project", "demo") == 0

    assert Registry(bugs_home / "projects.json").entries() == {}
    assert (repo / PROJECT_FILE).is_file()


def test_init_module_names_no_telegram_api():
    assert "getUpdates" not in Path(init.__file__).read_text()
