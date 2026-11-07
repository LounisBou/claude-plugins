"""``bin/setup``: find a Python 3.10+ already on the machine, install one with uv only when none is, remember it.

Every external command is a fake on a PATH of its own: nothing is installed, nothing is downloaded, and the
machine's own interpreters, pyenv and Homebrew are out of reach.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import REPO_ROOT

SETUP = REPO_ROOT / "bin" / "setup"
UV_INSTALLER_URL = "https://astral.sh/uv/install.sh"
# The utilities the script needs besides the fakes.
UTILITIES = ("sh", "mkdir", "mv", "rm", "mktemp")


def fake_python(path: Path, *, suitable: bool) -> Path:
    """A fake interpreter: the setup's probe passes (printing its own path) only when ``suitable``.

    Run with anything else, it prints what it was asked to run, as the CLI would be run through it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    probe = 'echo "$0"; exit 0' if suitable else "exit 1"
    path.write_text(f'#!/bin/sh\nif [ "$1" = -c ]; then {probe}; fi\necho "ran $0 $*"\n')
    path.chmod(0o755)
    return path


def fake_uv(path: Path, log: Path, python: Path) -> Path:
    """A fake uv: ``python install`` creates ``python`` (a suitable fake); ``python find`` names it once it exists."""
    path.parent.mkdir(parents=True, exist_ok=True)
    body = fake_python(python.parent / "template", suitable=True).read_text().replace("\n", "\\n")
    path.write_text(
        "#!/bin/sh\n"
        f'echo "$*" >> "{log}"\n'
        f'if [ "$1 $2" = "python install" ]; then {shutil.which("mkdir")} -p "{python.parent}"; printf \'{body}\' > "{python}"; '
        f'{shutil.which("chmod")} 755 "{python}"; exit 0; fi\n'
        f'if [ "$1 $2" = "python find" ] && [ -x "{python}" ]; then echo "{python}"; exit 0; fi\n'
        "exit 2\n"
    )
    path.chmod(0o755)
    return path


@pytest.fixture
def machine(tmp_path: Path) -> dict:
    """A fresh machine: an empty home, a PATH of utilities only, and no pyenv or Homebrew python."""
    bin_dir = tmp_path / "path"
    bin_dir.mkdir()
    for name in UTILITIES:
        (bin_dir / name).symlink_to(shutil.which(name))
    home = tmp_path / "home"
    home.mkdir()
    env = {
        "PATH": str(bin_dir),
        "HOME": str(home),
        "PYENV_ROOT": str(tmp_path / "pyenv"),
        "HOMEBREW_PREFIX": str(tmp_path / "brew"),
        "BUGS_BOT_HOME": str(tmp_path / "bugs"),
        "TMPDIR": str(tmp_path),
    }
    return {"bin": bin_dir, "home": home, "env": env, "tmp": tmp_path, "uv_log": tmp_path / "uv.log"}


def setup(machine: dict, *args: str, **extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["/bin/sh", str(SETUP), *args], capture_output=True, text=True, env={**machine["env"], **extra}, check=False
    )


def remembered(machine: dict) -> str:
    return (Path(machine["env"]["BUGS_BOT_HOME"]) / "python").read_text().strip()


def uv_calls(machine: dict) -> list[str]:
    log = machine["uv_log"]
    return log.read_text().splitlines() if log.exists() else []


def test_the_setup_script_is_valid_posix_sh():
    assert subprocess.run(["sh", "-n", str(SETUP)], capture_output=True, check=False).returncode == 0


def test_a_suitable_python_on_the_path_is_chosen_and_nothing_is_installed(machine):
    fake_python(machine["bin"] / "python3", suitable=False)
    chosen = fake_python(machine["bin"] / "python3.12", suitable=True)
    fake_uv(machine["bin"] / "uv", machine["uv_log"], machine["tmp"] / "uvpy" / "python3.12")

    result = setup(machine)

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().splitlines()[-1] == str(chosen)
    assert remembered(machine) == str(chosen)
    assert uv_calls(machine) == []  # uv neither asked nor used


def test_only_an_old_python_on_the_path_installs_one_with_uv(machine):
    fake_python(machine["bin"] / "python3", suitable=False)
    fake_python(machine["bin"] / "python3.9", suitable=False)
    installed = machine["tmp"] / "uvpy" / "python3.12"
    fake_uv(machine["bin"] / "uv", machine["uv_log"], installed)

    result = setup(machine)

    assert result.returncode == 0, result.stderr
    assert "python install 3.12" in uv_calls(machine)
    assert remembered(machine) == str(installed)
    assert result.stdout.strip().splitlines()[-1] == str(installed)
    assert "installing Python 3.12" in result.stderr


def test_without_uv_its_standalone_installer_runs_into_the_home_without_editing_profiles(machine):
    fake_python(machine["bin"] / "python3", suitable=False)
    installed = machine["tmp"] / "uvpy" / "python3.12"
    # The installer the fake curl downloads: it puts a fake uv where it is told, and only with profiles left alone.
    staged = fake_uv(machine["tmp"] / "staged" / "uv", machine["uv_log"], installed)
    installer = machine["tmp"] / "installer.sh"
    installer.write_text(
        '#!/bin/sh\n[ "$UV_NO_MODIFY_PATH" = 1 ] || exit 9\n'
        f'mkdir -p "$UV_INSTALL_DIR" && cp "{staged}" "$UV_INSTALL_DIR/uv"\n'
    )
    (machine["bin"] / "cp").symlink_to(shutil.which("cp"))
    curl_log = machine["tmp"] / "curl.log"
    curl = machine["bin"] / "curl"
    curl.write_text(
        f'#!/bin/sh\necho "$*" >> "{curl_log}"\n'
        'while [ "$#" -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\n'
        f'cp "{installer}" "$out"\n'
    )
    curl.chmod(0o755)

    result = setup(machine)

    assert result.returncode == 0, result.stderr
    assert UV_INSTALLER_URL in curl_log.read_text()
    assert (machine["home"] / ".local" / "bin" / "uv").is_file()
    assert "python install 3.12" in uv_calls(machine)
    assert remembered(machine) == str(installed)


def test_a_pyenv_version_is_found_when_the_path_has_none(machine):
    fake_python(machine["bin"] / "python3", suitable=False)
    chosen = fake_python(machine["tmp"] / "pyenv" / "versions" / "3.11.9" / "bin" / "python3", suitable=True)
    fake_uv(machine["bin"] / "uv", machine["uv_log"], machine["tmp"] / "uvpy" / "python3.12")

    result = setup(machine)

    assert result.returncode == 0, result.stderr
    assert remembered(machine) == str(chosen)
    assert uv_calls(machine) == []


def test_a_homebrew_python_is_found_when_the_path_has_none(machine):
    chosen = fake_python(machine["tmp"] / "brew" / "opt" / "python@3.13" / "bin" / "python3.13", suitable=True)

    result = setup(machine)

    assert result.returncode == 0, result.stderr
    assert remembered(machine) == str(chosen)


def test_the_remembered_interpreter_is_kept_while_it_still_runs(machine):
    kept = fake_python(machine["tmp"] / "kept" / "python3", suitable=True)
    fake_python(machine["bin"] / "python3.13", suitable=True)
    Path(machine["env"]["BUGS_BOT_HOME"]).mkdir()
    (Path(machine["env"]["BUGS_BOT_HOME"]) / "python").write_text(f"{kept}\n")

    result = setup(machine)

    assert result.returncode == 0, result.stderr
    assert remembered(machine) == str(kept)


def test_a_bugs_bot_python_that_is_too_old_is_refused_by_name(machine):
    old = fake_python(machine["tmp"] / "old" / "python3", suitable=False)

    result = setup(machine, BUGS_BOT_PYTHON=str(old))

    assert result.returncode == 1
    assert f"BUGS_BOT_PYTHON={old} is not a Python 3.10+" in result.stderr


def test_with_arguments_it_runs_this_plugins_cli_through_the_chosen_interpreter(machine):
    chosen = fake_python(machine["bin"] / "python3.12", suitable=True)

    result = setup(machine, "install")

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == f"ran {chosen} {REPO_ROOT}/bin/bugs-bot install"


def test_with_a_real_interpreter_the_remembered_path_is_its_own_executable(machine):
    """The probe records what the interpreter says it is (a pyenv binary, never its shim)."""
    shim = machine["bin"] / "python3.12"
    shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    shim.chmod(0o755)

    result = setup(machine)

    assert result.returncode == 0, result.stderr
    assert remembered(machine) == sys.executable
    assert os.access(remembered(machine), os.X_OK)
