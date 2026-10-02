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

from bugs_bot import cli  # noqa: E402
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
