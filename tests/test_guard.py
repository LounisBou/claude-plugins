"""The plugin is generic: no file of it names a project, outside the design documents and test fixtures."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

from conftest import REPO_ROOT

# The names of the first project the plugin served. This file names them to look for them, so it is
# the one test file left out of its own search.
PROJECT_NAMES = re.compile(r"TorrentMate|PersonalScraper|tm-design", re.IGNORECASE)
EXCLUDED_DIRS = ("docs/", "tests/fixtures/")
SELF = "tests/test_guard.py"


def tracked_files() -> list[str]:
    """Return the repository's tracked files, relative to its root."""
    out = subprocess.run(["git", "ls-files"], cwd=REPO_ROOT, capture_output=True, text=True, check=True).stdout
    return out.splitlines()


def project_names_in(root: Path, paths: list[str]) -> list[str]:
    """Return ``path:line: text`` for every line naming a project, in the files that must name none."""
    found = []
    for path in paths:
        if path.startswith(EXCLUDED_DIRS) or path == SELF:
            continue
        text = (root / path).read_text(errors="replace")
        for number, line in enumerate(text.splitlines(), 1):
            if PROJECT_NAMES.search(line):
                found.append(f"{path}:{number}: {line.strip()[:100]}")
    return found


def test_the_guard_searches_the_plugin_not_an_empty_list():
    # An empty list of tracked files would let the guard pass without looking at anything.
    files = tracked_files()

    assert "bugs_bot/cli.py" in files and "agent/AGENT.md" in files


def test_no_file_of_the_plugin_names_a_project():
    assert project_names_in(REPO_ROOT, tracked_files()) == []


# Where a name is a defect (the plugin's code, instructions, commands and tests) and where it is
# allowed (the design documents, the fixtures, and this file, which spells the names to search them).
SEARCHED = ["agent/AGENT.md", "skills/bugs-bot/SKILL.md", "commands/start.md", "bugs_bot/cli.py", "tests/x.py"]
ALLOWED = ["docs/specs/design.md", "tests/fixtures/sample.json", SELF]


@pytest.mark.parametrize("name", ["TorrentMate", "torrentmate", "PersonalScraper", "tm-design"])
def test_the_guard_sees_each_name_where_it_is_forbidden_and_only_there(tmp_path, name):
    for path in SEARCHED + ALLOWED:
        (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / path).write_text(f"ok\n# served by {name}\n")

    found = project_names_in(tmp_path, SEARCHED + ALLOWED)

    assert found == [f"{path}:2: # served by {name}" for path in SEARCHED]
