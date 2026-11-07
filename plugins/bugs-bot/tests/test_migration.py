"""The one-off migration script of the previous single-project layout: a fixture tree in, a bugs home out."""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
from pathlib import Path

import pytest

from bugs_bot import cli
from bugs_bot.project import PROJECT_FILE
from conftest import REPO_ROOT
from samples import GROUP_ID, TOKEN

SCRIPT = REPO_ROOT / "docs" / "migration" / "tm_bugs_to_bugs_bot.py"
OTHER_SECRET = "SOME_OTHER_SECRET_VALUE"


def _load():
    spec = importlib.util.spec_from_file_location("tm_bugs_to_bugs_bot", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def legacy(tmp_path: Path) -> Path:
    """A legacy data directory: two reports, one person card, a state with an offset and one post."""
    root = tmp_path / "legacy"
    for rid in ("1001", "1002"):
        (root / "inbox" / rid).mkdir(parents=True)
        (root / "inbox" / rid / "report.json").write_text(json.dumps({"id": rid, "status": "new"}))
    (root / "people").mkdir()
    (root / "people" / "42.json").write_text(json.dumps({"name": "Ana"}))
    (root / "state.json").write_text(
        json.dumps({"chat_id": GROUP_ID, "offset": 987654321, "posts": [{"text": "hello", "message_id": 5}]})
    )
    return root


@pytest.fixture
def legacy_env(tmp_path: Path) -> Path:
    """The legacy ``.env``: the token among other variables."""
    path = tmp_path / "legacy.env"
    path.write_text(f"OTHER={OTHER_SECRET}\nTELEGRAM_BOT_TOKEN={TOKEN}\nTELEGRAM_CHAT_ID=5\n")
    return path


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A repository whose project file ``init`` already wrote."""
    path = tmp_path / "repo"
    path.mkdir()
    (path / ".bugs-bot.json").write_text(
        json.dumps({"project": "demo", "group": {"chat_id": GROUP_ID, "title": "Demo Bugs"}, "agent_title": "Agent : Demo"})
    )
    return path


@pytest.fixture
def migrate(tmp_path: Path, legacy: Path, legacy_env: Path, repo: Path, capsys):
    """Return ``migrate(*extra) -> exit code`` running the script on the fixtures."""
    module = _load()
    target = tmp_path / "bugs-home"

    def _migrate(*extra: str, **overrides: Path) -> int:
        args = {
            "--legacy-home": legacy, "--bugs-home": target, "--project": "demo",
            "--repo": repo, "--env-file": legacy_env,
        }
        args.update({f"--{k.replace('_', '-')}": v for k, v in overrides.items()})
        argv = [item for pair in args.items() for item in (pair[0], str(pair[1]))]
        return module.main(argv + list(extra))

    _migrate.target = target
    _migrate.module = module
    return _migrate


def _state(path: Path) -> dict:
    return json.loads((path / "state.json").read_text())


def test_inbox_and_people_are_moved_to_the_project_directory(migrate, legacy):
    assert migrate() == 0

    project = migrate.target / "demo"
    assert sorted(p.name for p in (project / "inbox").iterdir()) == ["1001", "1002"]
    assert (project / "people" / "42.json").is_file()
    assert not (legacy / "inbox").exists() and not (legacy / "people").exists()


def test_copy_keeps_the_legacy_tree(migrate, legacy):
    assert migrate("--copy") == 0

    assert (migrate.target / "demo" / "inbox" / "1001" / "report.json").is_file()
    assert (legacy / "inbox" / "1001" / "report.json").is_file()
    assert (legacy / "people" / "42.json").is_file()
    assert (legacy / "state.json").is_file()


@pytest.mark.parametrize("offset", [0, 1, 987654321, 2**40])
def test_the_offset_is_copied_exactly(migrate, legacy, offset):
    (legacy / "state.json").write_text(json.dumps({"chat_id": GROUP_ID, "offset": offset}))

    assert migrate() == 0

    assert _state(migrate.target) == {"offset": offset}


@pytest.mark.parametrize("legacy_state", [{"chat_id": GROUP_ID, "offset": None}, {"chat_id": GROUP_ID}])
def test_a_null_or_missing_offset_stays_null_never_zero(migrate, legacy, legacy_state):
    (legacy / "state.json").write_text(json.dumps(legacy_state))

    assert migrate() == 0

    assert _state(migrate.target) == {"offset": None}


@pytest.mark.parametrize("offset", ["12", 1.5, True, -3, [1]])
def test_an_offset_that_is_not_a_natural_number_is_refused_and_nothing_moves(migrate, legacy, offset):
    (legacy / "state.json").write_text(json.dumps({"chat_id": GROUP_ID, "offset": offset}))

    assert migrate() == 1

    assert (legacy / "inbox").is_dir()
    assert not migrate.target.exists()


def test_the_token_line_goes_to_the_bugs_home_env_with_mode_0600(migrate):
    old = os.umask(0o022)
    try:
        assert migrate() == 0
    finally:
        os.umask(old)

    env_file = migrate.target / ".env"
    assert stat.S_IMODE(env_file.stat().st_mode) == 0o600
    assert env_file.read_text() == f"TELEGRAM_BOT_TOKEN={TOKEN}\n"


def test_the_token_file_is_never_readable_by_others_even_under_a_permissive_umask(migrate):
    old = os.umask(0)
    try:
        assert migrate() == 0
    finally:
        os.umask(old)

    assert stat.S_IMODE((migrate.target / ".env").stat().st_mode) == 0o600


def test_the_token_is_never_printed(migrate, capsys):
    assert migrate() == 0

    out = capsys.readouterr()
    assert TOKEN not in out.out + out.err
    assert TOKEN.split(":")[1] not in out.out + out.err
    assert OTHER_SECRET not in out.out + out.err


def test_the_token_is_not_printed_when_the_run_is_refused(migrate, capsys):
    assert migrate() == 0
    capsys.readouterr()

    assert migrate() == 1

    out = capsys.readouterr()
    assert TOKEN not in out.out + out.err


def test_other_variables_of_the_legacy_env_are_not_copied(migrate):
    assert migrate() == 0

    assert OTHER_SECRET not in (migrate.target / ".env").read_text()


def test_posts_go_to_the_project_state(migrate):
    assert migrate() == 0

    assert _state(migrate.target / "demo") == {"posts": [{"text": "hello", "message_id": 5}]}


def test_no_posts_means_no_project_state(migrate, legacy):
    (legacy / "state.json").write_text(json.dumps({"chat_id": GROUP_ID, "offset": 3}))

    assert migrate() == 0

    assert not (migrate.target / "demo" / "state.json").exists()


def test_a_second_run_is_refused_and_changes_nothing(migrate, capsys):
    assert migrate("--copy") == 0
    before = sorted(str(p) for p in migrate.target.rglob("*"))

    assert migrate("--copy") == 1

    assert "not empty" in capsys.readouterr().err
    assert sorted(str(p) for p in migrate.target.rglob("*")) == before


def test_a_non_empty_project_directory_is_refused_before_anything_is_written(migrate, legacy):
    existing = migrate.target / "demo" / "inbox" / "9"
    existing.mkdir(parents=True)

    assert migrate() == 1

    assert not (migrate.target / ".env").exists()
    assert not (migrate.target / "state.json").exists()
    assert (legacy / "inbox" / "1001").is_dir()


@pytest.mark.parametrize("name", ["state.json", ".env"])
def test_an_existing_machine_file_is_never_overwritten(migrate, name):
    migrate.target.mkdir()
    (migrate.target / name).write_text("keep")

    assert migrate() == 1

    assert (migrate.target / name).read_text() == "keep"
    assert not (migrate.target / "demo").exists()


def test_an_empty_existing_project_directory_is_accepted(migrate):
    (migrate.target / "demo").mkdir(parents=True)

    assert migrate() == 0


def test_a_legacy_home_without_state_is_refused(migrate, legacy):
    (legacy / "state.json").unlink()

    assert migrate() == 1

    assert not migrate.target.exists()


def test_a_legacy_env_without_a_token_is_refused_and_nothing_moves(migrate, legacy, legacy_env):
    legacy_env.write_text(f"OTHER={OTHER_SECRET}\n")

    assert migrate() == 1

    assert (legacy / "inbox").is_dir()
    assert not migrate.target.exists()


def test_a_repository_registered_under_another_project_is_refused(migrate, repo):
    (repo / ".bugs-bot.json").write_text(
        json.dumps({"project": "other", "group": {"chat_id": GROUP_ID, "title": "x"}, "agent_title": "A"})
    )

    assert migrate() == 1

    assert not migrate.target.exists()


def test_a_repository_bound_to_another_group_is_refused(migrate, repo):
    (repo / ".bugs-bot.json").write_text(
        json.dumps({"project": "demo", "group": {"chat_id": -5, "title": "x"}, "agent_title": "A"})
    )

    assert migrate() == 1

    assert not migrate.target.exists()


def test_a_repository_without_a_project_file_is_refused(migrate, tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()

    assert migrate(repo=empty) == 1


@pytest.mark.parametrize("project", ["../x", "Demo", "a b", "demo/.."])
def test_a_bad_project_id_is_refused(migrate, repo, project):
    (repo / ".bugs-bot.json").write_text(
        json.dumps({"project": project, "group": {"chat_id": GROUP_ID, "title": "x"}, "agent_title": "A"})
    )

    assert migrate(project=project) == 1

    assert not migrate.target.exists()


def test_the_script_accepts_the_project_file_that_init_writes(migrate, tmp_path):
    fresh = tmp_path / "fresh-repo"
    fresh.mkdir()
    subprocess.run(["git", "-C", str(fresh), "init", "-q"], check=True)
    env = {"BUGS_BOT_HOME": str(tmp_path / "rehearsal-home")}
    assert cli.main(
        ["init", "--project", "demo", "--agent-title", "Agent : Demo", "--chat-id", str(GROUP_ID), "--title", "Demo", "--repo", str(fresh)],
        env=env,
    ) == 0

    assert migrate(repo=fresh) == 0
    # The project file init writes routes Telegram's group under its channel-qualified key.
    registry = json.loads((tmp_path / "rehearsal-home" / "projects.json").read_text())
    assert registry == {f"telegram:{GROUP_ID}": {"project": "demo", "repo": str(fresh.resolve())}}


def test_a_repository_bound_to_a_slack_channel_is_refused(migrate, repo):
    data = json.loads((repo / PROJECT_FILE).read_text())
    # Same chat id as the legacy state: only the channel tells the two apart.
    (repo / PROJECT_FILE).write_text(json.dumps({**data, "channel": "slack"}))

    assert migrate() == 1


# --- the legacy gate -------------------------------------------------------------------------------


def test_the_legacy_gate_is_printed_and_not_written(migrate, legacy, capsys):
    (legacy / "settings.json").write_text(json.dumps({"context_gate_tokens": 200000}))

    assert migrate() == 0

    assert "200000" in capsys.readouterr().out
    assert not any("200000" in p.read_text() for p in migrate.target.rglob("*") if p.is_file())


def test_without_settings_the_default_gate_is_said(migrate, capsys):
    assert migrate() == 0

    assert "300000" in capsys.readouterr().out


def test_a_settings_file_without_the_gate_says_the_default(migrate, legacy, capsys):
    (legacy / "settings.json").write_text("{}")

    assert migrate() == 0

    assert "300000" in capsys.readouterr().out


@pytest.mark.parametrize("content", ["not json", "[]", '{"context_gate_tokens": "big"}', '{"context_gate_tokens": true}'])
def test_a_settings_file_that_cannot_be_read_is_refused_and_nothing_moves(migrate, legacy, content):
    (legacy / "settings.json").write_text(content)

    assert migrate() == 1

    assert (legacy / "inbox").is_dir()
    assert not migrate.target.exists()


# --- preconditions and failures half-way -----------------------------------------------------------


def test_an_unreadable_people_directory_is_refused_before_anything_is_written(migrate, legacy, capsys):
    (legacy / "people").chmod(0)
    try:
        assert migrate() == 1
    finally:
        (legacy / "people").chmod(0o755)

    assert "Traceback" not in capsys.readouterr().err
    assert (legacy / "inbox" / "1001").is_dir()
    assert not migrate.target.exists()


def test_a_failure_half_way_lists_what_exists_and_exits_1(migrate, legacy, monkeypatch, capsys):
    module = migrate.module
    real_move = module.shutil.move

    def failing_move(source, destination):
        if source.endswith("people"):
            raise OSError("disk went away")
        return real_move(source, destination)

    monkeypatch.setattr(module.shutil, "move", failing_move)

    assert migrate() == 1

    err = capsys.readouterr().err
    assert "Traceback" not in err
    assert str(migrate.target / "demo" / "inbox") in err
    assert TOKEN not in err
    assert not (migrate.target / ".env").exists()
    assert not (migrate.target / "state.json").exists()


@pytest.mark.parametrize("which", ["bugs_home", "project"])
def test_a_target_that_is_a_file_is_refused_before_any_write(migrate, legacy, which, capsys):
    if which == "bugs_home":
        migrate.target.parent.mkdir(exist_ok=True)
        migrate.target.write_text("a file")
    else:
        migrate.target.mkdir()
        (migrate.target / "demo").write_text("a file")

    assert migrate() == 1

    assert "Traceback" not in capsys.readouterr().err
    assert (legacy / "inbox" / "1001").is_dir()
    if which == "bugs_home":
        assert migrate.target.read_text() == "a file"
    else:
        assert not (migrate.target / ".env").exists() and not (migrate.target / "state.json").exists()


def test_a_non_utf8_env_file_is_refused_without_printing_the_token(migrate, legacy_env, capsys):
    legacy_env.write_bytes(f"TELEGRAM_BOT_TOKEN={TOKEN}\n".encode() + b"\xff\xfe\n")

    assert migrate() == 1

    out = capsys.readouterr()
    assert "Traceback" not in out.err
    assert TOKEN not in out.out + out.err
    assert not migrate.target.exists()


# --- behaviours pinned ------------------------------------------------------------------------------


def test_a_project_file_without_a_group_chat_id_is_refused(migrate, repo):
    (repo / ".bugs-bot.json").write_text(json.dumps({"project": "demo", "group": {"title": "x"}, "agent_title": "A"}))

    assert migrate() == 1

    assert not migrate.target.exists()


@pytest.mark.parametrize("line", ["TELEGRAM_BOT_TOKEN=", "TELEGRAM_BOT_TOKEN=''", 'TELEGRAM_BOT_TOKEN=""'])
def test_an_empty_token_is_refused(migrate, legacy_env, line):
    legacy_env.write_text(line + "\n")

    assert migrate() == 1

    assert not migrate.target.exists()


@pytest.mark.parametrize("quote", ["'", '"'])
def test_the_token_line_is_kept_exactly_when_quoted(migrate, legacy_env, quote):
    legacy_env.write_text(f"TELEGRAM_BOT_TOKEN={quote}{TOKEN}{quote}\n")

    assert migrate() == 0

    assert (migrate.target / ".env").read_text() == f"TELEGRAM_BOT_TOKEN={quote}{TOKEN}{quote}\n"
