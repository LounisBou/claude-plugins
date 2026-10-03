"""The fixed launcher ``~/.local/bin/bugs-bot``: runs the newest installed version of the plugin's CLI."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import pytest

from bugs_bot.doctor import LAUNCHER_TEXT, install_launcher
from bugs_bot.errors import BugsError


@pytest.fixture
def claude_dir(tmp_path: Path) -> Path:
    return tmp_path / "claude"


@pytest.fixture
def launcher(tmp_path: Path) -> Path:
    return install_launcher(tmp_path / "bin")


def fake_version(claude_dir: Path, version: str, *, with_cli: bool = True) -> Path:
    """Install a fake plugin version whose CLI prints its version and its arguments."""
    root = claude_dir / "plugins" / "cache" / "lounisbou" / "bugs-bot" / version
    (root / "bin").mkdir(parents=True)
    if with_cli:
        (root / "bin" / "bugs-bot").write_text(f"import sys\nprint('{version}', *sys.argv[1:])\n")
    return root


def launch(launcher: Path, claude_dir: Path, *argv: str) -> subprocess.CompletedProcess:
    env = {"PATH": os.environ["PATH"], "HOME": str(claude_dir.parent / "nohome"), "BUGS_BOT_CLAUDE_DIR": str(claude_dir)}
    return subprocess.run([str(launcher), *argv], capture_output=True, text=True, env=env, check=False)


def test_the_launcher_text_is_valid_posix_sh():
    result = subprocess.run(["sh", "-n"], input=LAUNCHER_TEXT, capture_output=True, text=True, check=False)

    assert result.returncode == 0, result.stderr


def test_install_writes_an_executable_file_named_bugs_bot(tmp_path):
    path = install_launcher(tmp_path / "deep" / "bin")

    assert path == tmp_path / "deep" / "bin" / "bugs-bot"
    assert path.read_text() == LAUNCHER_TEXT
    assert stat.S_IMODE(path.stat().st_mode) == 0o755


def test_install_twice_replaces_an_older_launcher(tmp_path):
    path = install_launcher(tmp_path)
    older = LAUNCHER_TEXT.replace("python3", "python")
    assert older != LAUNCHER_TEXT
    path.write_text(older)

    install_launcher(tmp_path)

    assert path.read_text() == LAUNCHER_TEXT
    assert stat.S_IMODE(path.stat().st_mode) == 0o755


def test_install_replaces_a_symlink_and_leaves_its_destination_alone(tmp_path):
    destination = tmp_path / "elsewhere" / "bugs-bot"
    destination.parent.mkdir()
    install_launcher(destination.parent)
    destination.write_text(LAUNCHER_TEXT + "# a launcher the operator keeps there\n")
    kept = (destination.read_text(), destination.stat().st_mtime_ns)
    target_dir = tmp_path / "bin"
    target_dir.mkdir()
    (target_dir / "bugs-bot").symlink_to(destination)

    path = install_launcher(target_dir)

    assert not path.is_symlink() and path.read_text() == LAUNCHER_TEXT
    assert (destination.read_text(), destination.stat().st_mtime_ns) == kept


def test_install_refuses_a_foreign_file_and_leaves_it_untouched(tmp_path):
    tmp_path = tmp_path / "bin"
    tmp_path.mkdir()
    foreign = tmp_path / "bugs-bot"
    foreign.write_text("#!/bin/sh\necho mine\n")
    foreign.chmod(0o700)

    with pytest.raises(BugsError, match=str(foreign)):
        install_launcher(tmp_path)

    assert foreign.read_text() == "#!/bin/sh\necho mine\n" and stat.S_IMODE(foreign.stat().st_mode) == 0o700
    assert [p.name for p in tmp_path.iterdir()] == ["bugs-bot"]  # no temporary file left


def test_install_refuses_a_symlink_to_a_foreign_file(tmp_path):
    foreign = tmp_path / "mine"
    foreign.write_text("#!/bin/sh\necho mine\n")
    (tmp_path / "bugs-bot").symlink_to(foreign)

    with pytest.raises(BugsError, match="bugs-bot"):
        install_launcher(tmp_path)

    assert (tmp_path / "bugs-bot").is_symlink() and foreign.read_text() == "#!/bin/sh\necho mine\n"


def test_install_never_leaves_a_half_written_launcher(tmp_path, monkeypatch):
    tmp_path = tmp_path / "bin"
    path = install_launcher(tmp_path)
    older = LAUNCHER_TEXT + "# older\n"
    path.write_text(older)

    def refuse(*_):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", refuse)
    with pytest.raises(OSError):
        install_launcher(tmp_path)

    assert path.read_text() == older
    assert [p.name for p in tmp_path.iterdir()] == ["bugs-bot"]


def test_the_launcher_text_carries_the_marker_that_makes_it_replaceable():
    assert LAUNCHER_TEXT.startswith("#!/bin/sh\n#")


def test_the_newest_version_runs_not_the_lexically_last(launcher, claude_dir):
    for version in ("0.1.0", "0.2.0", "0.10.0"):
        fake_version(claude_dir, version)

    result = launch(launcher, claude_dir, "list", "--project", "demo")

    assert result.returncode == 0
    assert result.stdout.strip() == "0.10.0 list --project demo"


def test_arguments_with_spaces_reach_the_cli_intact(launcher, claude_dir):
    fake_version(claude_dir, "0.1.0")

    result = launch(launcher, claude_dir, "reply", "B-1", "a b  c")

    assert result.stdout.strip() == "0.1.0 reply B-1 a b  c"


def test_the_exit_code_of_the_cli_is_the_launchers(launcher, claude_dir):
    root = fake_version(claude_dir, "0.1.0")
    (root / "bin" / "bugs-bot").write_text("import sys\nsys.exit(3)\n")

    assert launch(launcher, claude_dir, "x").returncode == 3


def test_a_claude_dir_without_the_plugin_prints_one_line_and_exits_127(launcher, claude_dir):
    claude_dir.mkdir()

    result = launch(launcher, claude_dir, "list")

    assert result.returncode == 127
    assert result.stdout == ""
    assert result.stderr.count("\n") == 1 and "/bugs-bot:doctor" in result.stderr


def test_a_version_without_its_cli_is_refused_not_skipped_for_an_older_one(launcher, claude_dir):
    """A half-removed version must never let an older, possibly broken, one run silently."""
    fake_version(claude_dir, "0.1.0")
    fake_version(claude_dir, "0.2.0", with_cli=False)

    result = launch(launcher, claude_dir, "list")

    assert result.returncode == 127
    assert result.stdout == ""
    assert result.stderr.count("\n") == 1


def test_a_lone_version_without_its_cli_exits_127(launcher, claude_dir):
    fake_version(claude_dir, "0.1.0", with_cli=False)

    result = launch(launcher, claude_dir, "list")

    assert result.returncode == 127
    assert result.stderr.count("\n") == 1


def test_the_claude_dir_defaults_to_home_dot_claude(launcher, tmp_path):
    home = tmp_path / "home"
    fake_version(home / ".claude", "0.3.0")
    env = {"PATH": os.environ["PATH"], "HOME": str(home)}

    result = subprocess.run([str(launcher), "go"], capture_output=True, text=True, env=env, check=False)

    assert result.stdout.strip() == "0.3.0 go"


def test_the_chosen_interpreter_runs_the_cli(launcher, claude_dir, tmp_path):
    fake_version(claude_dir, "0.1.0")
    python = tmp_path / "py" / "python3"
    python.parent.mkdir()
    python.write_text('#!/bin/sh\necho "chosen $@"\n')
    python.chmod(0o755)
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path / "nohome"), "BUGS_BOT_CLAUDE_DIR": str(claude_dir), "BUGS_BOT_PYTHON": str(python)}

    result = subprocess.run([str(launcher), "pull"], capture_output=True, text=True, env=env, check=False)

    assert result.stdout.strip().endswith("0.1.0/bin/bugs-bot pull") and result.stdout.startswith("chosen ")
