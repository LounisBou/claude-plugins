"""``doctor``: the checks, the launcher install, and the promise never to write a settings file."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from samples import TOKEN

from bugs_bot import cli, doctor
from bugs_bot.errors import BugsError
from bugs_bot.doctor import LAUNCHER_TEXT, Check, install_launcher, pull_processes, run_checks

PULL_PS = "  4242 python3 /home/u/.claude/plugins/cache/lounisbou/bugs-bot/0.1.0/bin/bugs-bot pull --watch\n"
ALLOW = "Bash(bugs-bot:*)"


@pytest.fixture
def machine_env(tmp_path: Path, env: dict[str, str]) -> dict[str, str]:
    """A healthy machine: token, plugin cache, orchestrator, launcher, allow rule, all under ``tmp_path``."""
    claude = tmp_path / "claude"
    (claude / "plugins" / "cache" / "lounisbou" / "orchestrator" / "0.38.0").mkdir(parents=True)
    claude.joinpath("settings.json").write_text(json.dumps({"permissions": {"allow": [ALLOW]}}))
    install_launcher(tmp_path / "localbin")
    return {**env, "BUGS_BOT_CLAUDE_DIR": str(claude), "BUGS_BOT_LAUNCHER_DIR": str(tmp_path / "localbin")}


def by_name(checks: list[Check]) -> dict[str, Check]:
    return {c.name: c for c in checks}


def test_a_healthy_machine_passes_every_check(machine_env):
    checks = run_checks(machine_env, PULL_PS)

    assert [c.name for c in checks if not c.ok] == []
    assert len(checks) == 7


# -- pull_processes -------------------------------------------------------------


@pytest.mark.parametrize(
    "line,pids",
    [
        ("  4242 python3 /x/bin/bugs-bot pull --watch", [4242]),
        ("4242 /usr/bin/python3 /x/bin/bugs-bot pull --watch --poll-timeout 50", [4242]),
        ("77 python3 /x/bin/bugs-bot pull --poll-timeout 50 --watch", [77]),
        ("4242 /opt/homebrew/Cellar/python@3.11/3.11.9/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python /x/bin/bugs-bot pull --watch", [4242]),
        ("4243 python3 -u /x/bin/bugs-bot pull --watch", [4243]),
        ("4244 python3 -X dev /x/bin/bugs-bot pull --watch", [4244]),
        ("4245 python3 -W ignore -u -X utf8 /x/bin/bugs-bot pull --watch", [4245]),
        ("4246 python3 -X dev -c print(1) /x/bin/bugs-bot pull --watch", []),
        ("4247 python3 -X dev /x/other pull --watch", []),
        ("5 python3 /x/bin/bugs-bot pull --every 30", []),
        ("5 python3 /x/bin/bugs-bot pull", []),
        ("5 python3 /x/bin/bugs-bot list --project demo", []),
        ("5 tail -f /var/log/bugs-bot pull --watch.log", []),
        ("5 vim notes-about-pull--watch", []),
        ("5 grep bugs-bot pull --watch", []),
    ],
)
def test_pull_processes_recognises_only_a_watching_pull(line, pids):
    assert pull_processes(line + "\n") == pids


def test_pull_processes_over_a_table():
    table = "  PID COMMAND\n    1 /sbin/launchd\n" + PULL_PS + "  99 python3 /y/bin/bugs-bot pull --watch\n"

    assert pull_processes(table) == [4242, 99]


# -- the checks, one by one ---------------------------------------------------------


def test_python_check_reports_the_running_version(machine_env, monkeypatch):
    assert by_name(run_checks(machine_env, PULL_PS))["python"].ok

    monkeypatch.setattr(doctor.sys, "version_info", (3, 9, 18, "final", 0))
    check = by_name(run_checks(machine_env, PULL_PS))["python"]
    assert not check.ok and "3.9" in check.detail


def test_token_check_says_present_never_the_value(machine_env):
    check = by_name(run_checks(machine_env, PULL_PS))["token"]

    assert check.ok and "present" in check.detail
    assert all(TOKEN not in c.detail for c in run_checks(machine_env, PULL_PS))


def test_token_check_fails_when_the_env_file_is_missing(machine_env, tmp_path):
    machine_env["BUGS_BOT_ENV_FILE"] = str(tmp_path / "absent.env")

    check = by_name(run_checks(machine_env, PULL_PS))["token"]

    assert not check.ok and "env file" in check.detail


def test_token_check_fails_when_the_variable_is_absent_and_leaks_nothing(machine_env, tmp_path):
    other = tmp_path / "other.env"
    other.write_text(f"SOMETHING={TOKEN}\n")
    machine_env["BUGS_BOT_ENV_FILE"] = str(other)

    checks = run_checks(machine_env, PULL_PS)

    assert not by_name(checks)["token"].ok
    assert all(TOKEN not in c.detail for c in checks)


def test_registry_check(machine_env, bugs_home):
    assert by_name(run_checks(machine_env, PULL_PS))["registry"].ok  # absent file: an empty registry

    bugs_home.mkdir(parents=True, exist_ok=True)
    (bugs_home / "projects.json").write_text("{broken")
    check = by_name(run_checks(machine_env, PULL_PS))["registry"]

    assert not check.ok and "registry" in check.detail


@pytest.mark.parametrize("ps,ok", [("", False), (PULL_PS, True), (PULL_PS + PULL_PS.replace("4242", "4243"), False)])
def test_pull_runs_exactly_once(machine_env, ps, ok):
    check = by_name(run_checks(machine_env, ps))["pull"]

    assert check.ok is ok
    if len(pull_processes(ps)) > 1:
        assert "4242" in check.detail and "4243" in check.detail


def test_orchestrator_check(machine_env, tmp_path):
    (tmp_path / "claude" / "plugins" / "cache" / "lounisbou" / "orchestrator" / "0.38.0").rmdir()

    check = by_name(run_checks(machine_env, PULL_PS))["orchestrator"]

    assert not check.ok and "orchestrator" in check.detail


def test_launcher_check_fails_when_absent_or_different(machine_env, tmp_path):
    launcher = tmp_path / "localbin" / "bugs-bot"
    launcher.write_text("#!/bin/sh\necho stale\n")
    assert not by_name(run_checks(machine_env, PULL_PS))["launcher"].ok

    launcher.unlink()
    check = by_name(run_checks(machine_env, PULL_PS))["launcher"]
    assert not check.ok and "--install-launcher" in check.detail


def test_launcher_check_fails_when_not_executable(machine_env, tmp_path):
    (tmp_path / "localbin" / "bugs-bot").chmod(0o644)

    assert not by_name(run_checks(machine_env, PULL_PS))["launcher"].ok


@pytest.mark.parametrize("name", ["settings.json", "settings.local.json"])
def test_allow_rule_found_in_either_settings_file(machine_env, tmp_path, name):
    claude = tmp_path / "claude"
    (claude / "settings.json").write_text(json.dumps({"permissions": {"allow": ["Bash(ls:*)"]}}))
    assert not by_name(run_checks(machine_env, PULL_PS))["allow rule"].ok

    (claude / name).write_text(json.dumps({"permissions": {"allow": ["Bash(ls:*)", ALLOW]}}))

    assert by_name(run_checks(machine_env, PULL_PS))["allow rule"].ok


def test_allow_rule_missing_prints_the_permissions_line(machine_env, tmp_path):
    (tmp_path / "claude" / "settings.json").unlink()

    check = by_name(run_checks(machine_env, PULL_PS))["allow rule"]

    assert not check.ok and "/permissions → Allow → Bash(bugs-bot:*)" in check.detail


def test_an_unreadable_settings_file_is_a_failed_check_not_a_crash(machine_env, tmp_path):
    (tmp_path / "claude" / "settings.json").write_text("{nope")

    check = by_name(run_checks(machine_env, PULL_PS))["allow rule"]

    assert not check.ok and "settings.json" in check.detail


def test_doctor_never_writes_a_settings_file(machine_env, tmp_path):
    claude = tmp_path / "claude"
    (claude / "settings.local.json").write_text(json.dumps({"permissions": {"allow": []}}))
    before = {p.name: (p.stat().st_mtime_ns, p.read_text()) for p in claude.glob("settings*.json")}
    os.utime(claude / "settings.json", ns=(1_000_000_000, 1_000_000_000))
    before["settings.json"] = (1_000_000_000, before["settings.json"][1])

    run_checks({**machine_env, "BUGS_BOT_ENV_FILE": str(tmp_path / "x")}, "")

    after = {p.name: (p.stat().st_mtime_ns, p.read_text()) for p in claude.glob("settings*.json")}
    assert after == before
    assert sorted(p.name for p in claude.iterdir()) == ["plugins", "settings.json", "settings.local.json"]


def snapshot(claude: Path) -> dict:
    """Listing, mtime and content of everything under ``claude``'s settings files."""
    return {
        "listing": sorted(p.name for p in claude.iterdir()),
        "files": {p.name: (p.stat().st_mtime_ns, p.read_text()) for p in claude.glob("settings*.json")},
    }


def pin_mtimes(claude: Path) -> None:
    for path in claude.glob("settings*.json"):
        os.utime(path, ns=(1_000_000_000, 1_000_000_000))


@pytest.mark.parametrize(
    "files",
    [
        {},
        {"settings.json": json.dumps({"permissions": {"allow": ["Bash(ls:*)"]}}), "settings.local.json": "{}"},
        {"settings.json": "{nope"},
        {"settings.json": "{nope", "settings.local.json": json.dumps({"permissions": {"allow": []}})},
    ],
    ids=["no-file", "rule-missing-from-both", "one-unreadable", "unreadable-and-missing"],
)
@pytest.mark.parametrize("argv", [["doctor"], ["doctor", "--install-launcher"]], ids=["check", "install"])
def test_doctor_never_writes_a_settings_file_when_the_rule_is_missing(machine_env, ps, tmp_path, files, argv):
    claude = tmp_path / "claude"
    (claude / "settings.json").unlink()
    for name, content in files.items():
        (claude / name).write_text(content)
    pin_mtimes(claude)
    before = snapshot(claude)

    code = cli.main(argv, env=machine_env)

    assert code == 1  # the rule is missing: the operator adds it
    assert snapshot(claude) == before


@pytest.mark.parametrize(
    "content",
    [
        f"TELEGRAM_BOT_TOKEN={TOKEN}\n".encode() + b"\xff\xfe\n",  # not text
        f"TELEGRAM_BOT_TOKEN {TOKEN}\n".encode(),  # no `=`
        f"TELEGRAM_BOT_TOKEN_OLD={TOKEN}\n".encode(),  # another variable
    ],
    ids=["binary", "no-equal", "other-variable"],
)
@pytest.mark.parametrize("argv", [["doctor"], ["doctor", "--install-launcher"]], ids=["check", "install"])
def test_doctor_never_prints_the_token_of_a_broken_env_file(machine_env, ps, tmp_path, capsys, content, argv):
    broken = tmp_path / "broken.env"
    broken.write_bytes(content)
    machine_env["BUGS_BOT_ENV_FILE"] = str(broken)

    try:
        code = cli.main(argv, env=machine_env)
    except Exception as exc:  # noqa: BLE001 - whatever it raises must not carry the token either
        assert TOKEN not in str(exc)
        code = None

    captured = capsys.readouterr()
    assert TOKEN not in captured.out + captured.err
    assert code == 1, "doctor must say the token check failed, not crash"


def test_doctor_never_prints_the_token_when_the_env_file_is_unreadable(machine_env, ps, tmp_path, capsys):
    locked = tmp_path / "locked.env"
    locked.write_text(f"TELEGRAM_BOT_TOKEN={TOKEN}\n")
    locked.chmod(0o000)
    machine_env["BUGS_BOT_ENV_FILE"] = str(locked)
    try:
        code = cli.main(["doctor"], env=machine_env)
    finally:
        locked.chmod(0o600)

    captured = capsys.readouterr()
    assert code == 1 and TOKEN not in captured.out + captured.err


# -- through the CLI ------------------------------------------------------------


@pytest.fixture
def ps(monkeypatch):
    monkeypatch.setattr(cli, "read_ps", lambda: PULL_PS)


def test_cli_doctor_exits_0_when_everything_passes(machine_env, ps, capsys):
    code = cli.main(["doctor"], env=machine_env)

    out = capsys.readouterr().out
    assert code == 0 and "FAIL" not in out and "python" in out
    assert TOKEN not in out


def test_cli_doctor_exits_1_and_names_the_failures(machine_env, ps, capsys, tmp_path):
    (tmp_path / "claude" / "settings.json").unlink()

    code = cli.main(["doctor"], env=machine_env)

    out = capsys.readouterr().out
    assert code == 1 and "FAIL" in out and "/permissions → Allow → Bash(bugs-bot:*)" in out


def test_cli_doctor_install_launcher_writes_it_first(machine_env, ps, tmp_path, capsys):
    (tmp_path / "localbin" / "bugs-bot").unlink()

    code = cli.main(["doctor", "--install-launcher"], env=machine_env)

    assert code == 0
    assert (tmp_path / "localbin" / "bugs-bot").read_text() == LAUNCHER_TEXT
    assert str(tmp_path / "localbin" / "bugs-bot") in capsys.readouterr().out


def test_cli_doctor_runs_outside_any_project(machine_env, ps, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    assert cli.main(["doctor"], env=machine_env) == 0



def test_cli_doctor_reports_an_unreadable_process_table_as_a_failed_check(machine_env, monkeypatch, capsys):
    def fail():
        raise BugsError("cannot read the process table: boom")

    monkeypatch.setattr(cli, "read_ps", fail)

    code = cli.main(["doctor"], env=machine_env)

    out = capsys.readouterr().out
    assert code == 1
    assert "FAIL  pull: cannot read the process table: boom" in out
    assert out.count("ok  ") == 6  # every other check still ran


def test_run_checks_takes_the_error_of_a_failed_ps(machine_env):
    check = by_name(run_checks(machine_env, BugsError("cannot read the process table: boom")))["pull"]

    assert not check.ok and "boom" in check.detail
