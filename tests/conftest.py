"""Shared fixtures: an isolated inbox, a fake token file, a runner for the CLI."""

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
from samples import GROUP_ID, TOKEN, FakeTelegram  # noqa: E402


@pytest.fixture
def home(tmp_path: Path) -> Path:
    """Return the inbox root used by the tests (never the real one)."""
    return tmp_path / "tm-bugs"


@pytest.fixture
def env(tmp_path: Path, home: Path) -> dict[str, str]:
    """Return an environment pointing the script at a fake token and inbox."""
    env_file = tmp_path / ".env"
    env_file.write_text(f"OTHER=1\nTELEGRAM_BOT_TOKEN={TOKEN}\nTELEGRAM_CHAT_ID=5\n")
    return {"TM_BUGS_ENV_FILE": str(env_file), "TM_BUGS_HOME": str(home)}


@pytest.fixture
def bound(home: Path) -> Path:
    """Bind the inbox to the TM Bugs group, as ``bind`` would."""
    home.mkdir(parents=True, exist_ok=True)
    (home / "state.json").write_text(json.dumps({"chat_id": GROUP_ID, "offset": None}))
    return home


@pytest.fixture
def run(env: dict[str, str]):
    """Return ``run(*argv, transport=..., now=...) -> exit code``."""

    def _run(*argv: str, transport: FakeTelegram | None = None, now: float | None = None) -> int:
        return cli.main(list(argv), transport=transport or FakeTelegram(), env=env, now=now)

    return _run


def read_state(home: Path) -> dict:
    """Load ``state.json``."""
    return json.loads((home / "state.json").read_text())


def reports(home: Path) -> list[Path]:
    """Return the report directories, hidden temp ones included."""
    inbox = home / "inbox"
    return sorted(inbox.iterdir()) if inbox.exists() else []
