"""``deployed <commit>``: the project's deploy check says whether a fix is served before it is announced."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path

import pytest

COMMIT = "0123abc4567def"


def set_check(command: str | None) -> None:
    """Write ``deploy_check`` into the project file of the current directory (``None`` removes it)."""
    path = Path.cwd() / ".bugs-bot.json"
    data = json.loads(path.read_text())
    data.pop("deploy_check", None)
    if command is not None:
        data["deploy_check"] = command
    path.write_text(json.dumps(data))


def test_a_check_that_passes_says_deployed_yes(run, bound, capsys):
    set_check(f'test "$BUGS_BOT_COMMIT" = {COMMIT}')

    assert run("deployed", COMMIT) == 0

    assert capsys.readouterr().out.strip() == "deployed=yes"


def test_a_check_that_fails_says_deployed_no(run, bound, capsys):
    set_check(f'test "$BUGS_BOT_COMMIT" = {COMMIT}')

    assert run("deployed", "fedcba9876") == 1

    assert capsys.readouterr().out.strip() == "deployed=no"


def test_without_a_check_the_launchers_word_decides(run, bound, capsys):
    set_check(None)

    assert run("deployed", COMMIT) == 2

    assert capsys.readouterr().out.strip() == "deployed=unknown: the launcher's word decides"


def test_the_check_runs_in_the_repository_whatever_the_current_directory(run, bound, tmp_path, monkeypatch, capsys):
    out = tmp_path / "where"
    set_check(f'pwd -P > "{out}"')
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)

    assert run("deployed", COMMIT, "--project", "demo") == 0

    assert out.read_text().strip() == str((tmp_path / "repo-demo").resolve())


@pytest.mark.parametrize(
    "bad",
    ["abc; touch pwned", "$(touch pwned)", "abc", "x" * 41, "", "abcdef1;touch pwned", "abcdef1\n", "abcdef1 ", "abcdef"],
)
def test_a_commit_that_is_not_a_hash_is_refused_before_anything_runs(run, bound, bad, capsys):
    set_check("touch ran")

    assert run("deployed", bad) == 1

    assert not (Path.cwd() / "ran").exists() and not (Path.cwd() / "pwned").exists()
    assert "deployed=" not in capsys.readouterr().out


@pytest.mark.parametrize("good", ["abcdef1", "a" * 40, "ABCDEF1"])
def test_seven_to_forty_hex_digits_are_accepted(run, bound, good, capsys):
    set_check("true")

    assert run("deployed", good) == 0

    assert capsys.readouterr().out.strip() == "deployed=yes"


def alive(pid: int) -> bool:
    """Tell whether process ``pid`` still runs (a zombie waiting to be reaped is not a process left)."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


def test_a_check_that_times_out_is_reported_without_its_command_and_leaves_no_process(
    run, bound, tmp_path, monkeypatch, capsys
):
    monkeypatch.setattr("bugs_bot.agent.DEPLOY_CHECK_TIMEOUT", 1)
    pidfile = tmp_path / "grandchild.pid"
    set_check(f"sleep 30 & echo $! > '{pidfile}'; wait # fake-secret-token-123")

    try:
        assert run("deployed", COMMIT) == 1
        out = capsys.readouterr()

        assert "the deploy check timed out after 1 s" in out.err
        assert "fake-secret-token-123" not in out.out + out.err
        assert "deployed=" not in out.out
        grandchild = int(pidfile.read_text())
        deadline = time.monotonic() + 3
        while alive(grandchild) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not alive(grandchild)
    finally:
        if pidfile.exists() and alive(int(pidfile.read_text())):
            os.kill(int(pidfile.read_text()), signal.SIGKILL)


def test_a_check_that_cannot_run_is_reported_without_its_command(run, bound, monkeypatch, capsys):
    set_check("true # fake-secret-token-123")

    def fail(*args, **kwargs):
        raise OSError(2, "No such file or directory")

    monkeypatch.setattr(subprocess, "Popen", fail)

    assert run("deployed", COMMIT) == 1
    out = capsys.readouterr()

    assert "the deploy check could not run: No such file or directory" in out.err
    assert "fake-secret-token-123" not in out.out + out.err


def test_the_check_reads_no_standard_input_and_leads_its_own_process_group(run, bound, monkeypatch):
    set_check("true")
    seen = {}
    real = subprocess.Popen

    def spy(*args, **kwargs):
        seen.update(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", spy)

    assert run("deployed", COMMIT) == 0
    assert seen["stdin"] == subprocess.DEVNULL
    assert seen["start_new_session"] is True
