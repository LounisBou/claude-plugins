"""Where a plugin of the ``lounisbou`` marketplace is installed, from the host's own record."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from pathlib import Path

from bugs_bot.errors import BugsError

MARKETPLACE = "lounisbou"


def config_dir(env: Mapping[str, str]) -> Path:
    """Return the host's config dir: the tool's override, else the host's, else ``~/.claude``."""
    return Path(env.get("BUGS_BOT_CLAUDE_DIR") or env.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


def _recorded(claude: Path, name: str) -> Path | None:
    """Return the ``installPath`` the host records for the plugin, or ``None`` when absent or unreadable."""
    try:
        data = json.loads((claude / "plugins" / "installed_plugins.json").read_text())
        entries = data["plugins"][f"{name}@{MARKETPLACE}"]
        path = Path(entries[0]["installPath"])
    except (OSError, ValueError, KeyError, IndexError, TypeError, AttributeError):
        return None
    return path if path.is_dir() else None


def _version_key(directory: Path) -> list[tuple[int, str]]:
    """Order directory names like ``sort -V``: digit runs by value, so 0.10.0 follows 0.2.0."""
    return [(int(p), "") if p.isdigit() else (-1, p) for p in re.split(r"(\d+)", directory.name) if p]


def _newest_cached(claude: Path, name: str) -> Path | None:
    """Return the newest directory of the plugin's cache: a guess, as the host keeps every version."""
    found = [p for p in (claude / "plugins" / "cache" / MARKETPLACE / name).glob("*/") if p.is_dir()]
    return max(found, key=_version_key) if found else None


def plugin_path(name: str, env: Mapping[str, str]) -> Path:
    """Return the install directory of a plugin: the host's record first, the newest cached copy otherwise.

    The cache keeps every version side by side, plain (``0.49.1``) and tagged (``0.49.1-2afa38391c2b``):
    only the record says which one is active.

    Raises:
        BugsError: If the plugin is neither recorded nor cached.
    """
    claude = config_dir(env)
    path = _recorded(claude, name) or _newest_cached(claude, name)
    if path is None:
        raise BugsError(f"no installed {name} plugin found under {claude / 'plugins'}")
    return path
