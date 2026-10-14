"""Shared fixtures: an isolated bugs home, a registered project, a fake token file, a runner for the CLI."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(HERE))

from bugs_bot import cli, install  # noqa: E402
from bugs_bot.project import PROJECT_FILE  # noqa: E402
from bugs_bot.registry import Registry  # noqa: E402
from bugs_bot.store import Machine  # noqa: E402
from samples import GROUP_ID, TOKEN, FakeTelegram  # noqa: E402


@pytest.fixture(autouse=True)
def _outside_any_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Start every test in an empty directory, so no stray project file above the checkout is found."""
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    monkeypatch.chdir(cwd)


@pytest.fixture(autouse=True)
def _no_pm2(monkeypatch: pytest.MonkeyPatch):
    """Never ask the real PM2: ``doctor`` reads its process list through ``cli.read_pm2``, absent here.

    Returns the real ``read_pm2``, for the one test that drives it through a fake ``subprocess.run``.
    """
    real = cli.read_pm2
    monkeypatch.setattr(cli, "read_pm2", lambda: None)
    return real


@pytest.fixture
def bugs_home(tmp_path: Path) -> Path:
    """Return the machine's data directory used by the tests (never the real one)."""
    return tmp_path / "bugs-bot"


@pytest.fixture
def home(bugs_home: Path) -> Path:
    """Return the data directory of the project ``demo``."""
    return bugs_home / "demo"


@pytest.fixture
def env(tmp_path: Path, bugs_home: Path) -> dict[str, str]:
    """Return an environment pointing the script at a fake token and data directory."""
    env_file = tmp_path / ".env"
    env_file.write_text(f"OTHER=1\nTELEGRAM_BOT_TOKEN={TOKEN}\nTELEGRAM_CHAT_ID=5\n")
    return {"BUGS_BOT_ENV_FILE": str(env_file), "BUGS_BOT_HOME": str(bugs_home)}


def register(bugs_home: Path, repo: Path, project: str, chat_id: int | str, title: str = "Bugs", channel: str = "telegram") -> Path:
    """Write ``repo``'s project file and register it, as ``init`` will; return ``repo``."""
    repo.mkdir(parents=True, exist_ok=True)
    data = {"project": project, "group": {"chat_id": chat_id, "title": title}, "agent_title": f"Agent : {title}"}
    if channel != "telegram":
        data["channel"] = channel
    (repo / PROJECT_FILE).write_text(json.dumps(data))
    Registry(bugs_home / "projects.json").add(channel, chat_id, project, repo)
    return repo


@pytest.fixture
def bound(tmp_path: Path, bugs_home: Path, home: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Register the ``GROUP_ID`` group as project ``demo`` and work from its repository.

    Returns the project's data directory.
    """
    repo = register(bugs_home, tmp_path / "repo-demo", "demo", GROUP_ID, "Demo Bugs")
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(repo)
    return home


@pytest.fixture
def run(env: dict[str, str]):
    """Return ``run(*argv, transport=..., now=...) -> exit code``."""

    def _run(*argv: str, transport: FakeTelegram | None = None, now: float | None = None) -> int:
        return cli.main(list(argv), transport=transport or FakeTelegram(), env=env, now=now)

    return _run


def read_state(home: Path) -> dict:
    """Load a project's ``state.json``, ``{}`` while there is none."""
    try:
        return json.loads((home / "state.json").read_text())
    except FileNotFoundError:
        return {}


def read_offset(home: Path) -> int | None:
    """Return the machine-wide update offset, ``home`` being a project's data directory."""
    return Machine(home.parent).load_offset()


def reports(home: Path) -> list[Path]:
    """Return the report directories, hidden temp ones included."""
    inbox = home / "inbox"
    return sorted(inbox.iterdir()) if inbox.exists() else []


class FakePm2:
    """The fake PM2 every test runs instead of the machine's: its state, as ``tests/fake_pm2.py`` keeps it."""

    def __init__(self, directory: Path) -> None:
        directory.mkdir()
        self.state_path = directory / "state.json"
        self.program = directory / "pm2"
        self.program.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{HERE / "fake_pm2.py"}" "{self.state_path}" "$@"\n')
        self.program.chmod(0o755)

    @property
    def state(self) -> dict:
        return json.loads(self.state_path.read_text()) if self.state_path.exists() else {"apps": [], "saved": None, "calls": []}

    def register(self, script: str, cwd: str) -> None:
        """Record a ``bugs-bot-pull`` as an earlier ``pm2 start`` left it."""
        state = self.state
        state["apps"].append({"name": "bugs-bot-pull", "script": script, "cwd": cwd, "restarts": 0})
        self.state_path.write_text(json.dumps(state))

    def verbs(self) -> list[str]:
        return [" ".join(call["argv"][:1]) for call in self.state["calls"]]


@pytest.fixture(autouse=True)
def fake_pm2(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> FakePm2:
    """Never reach the machine's PM2: ``install`` runs this fake."""
    fake = FakePm2(tmp_path / "fakepm2")
    monkeypatch.setattr(install, "PM2_COMMAND", str(fake.program))
    return fake
