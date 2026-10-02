"""The slash commands of the plugin: what they may run."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from conftest import REPO_ROOT

COMMANDS = sorted((REPO_ROOT / "commands").glob("*.md"))
# The one invocation that is not `bugs-bot ...`: the first doctor run, before the launcher exists.
BOOTSTRAP = "python3 ${CLAUDE_PLUGIN_ROOT}/bin/bugs-bot doctor"
BOOTSTRAP_RULE = f"{BOOTSTRAP}:*"
# start's two others: reading the newest iTerm launcher's path, then that launcher written out in full.
ITERM_PATH_LINE = "ls -d ~/.claude/plugins/cache/lounisbou/orchestrator/*/skills/iterm-agents/scripts/iterm-agent.sh | sort -V | tail -1"
ITERM_LAUNCHER = "$SCRIPT "
ALLOWED_RULES = {"bugs-bot:*"}
# Nothing in a command line may chain, pipe, substitute, fetch, delete or start a shell.
FORBIDDEN = (";", "|", "&&", "$(", "curl", "rm ", "sh -c", "bash")


def front_matter(text: str) -> dict[str, str]:
    """Return the ``key: value`` lines between the two ``---`` lines that open the file."""
    head = re.match(r"---\n(.*?)\n---\n", text, re.DOTALL)
    assert head, "no front matter"
    return dict(line.split(": ", 1) for line in head.group(1).splitlines())


def code_lines(text: str) -> list[str]:
    """Return the non-empty lines inside fenced code blocks, stripped."""
    lines, inside = [], False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            inside = not inside
        elif inside and line.strip():
            lines.append(line.strip())
    return lines


def rules_of(allowed_tools: str) -> list[str]:
    """Return the inner rule of each ``Bash(...)`` of an ``allowed-tools`` value, refusing anything else in it."""
    found = re.findall(r"Bash\(([^)]*)\)", allowed_tools)
    assert allowed_tools == ", ".join(f"Bash({rule})" for rule in found), f"unexpected allowed-tools: {allowed_tools!r}"
    return found


def test_the_four_commands_exist():
    assert {p.stem for p in COMMANDS} >= {"init", "start", "remove", "doctor"}


@pytest.mark.parametrize("path", COMMANDS, ids=lambda p: p.stem)
def test_a_command_may_only_use_the_rules_it_needs(path: Path):
    text = path.read_text()
    allowed = ALLOWED_RULES | ({BOOTSTRAP_RULE} if path.stem == "doctor" else set())
    # a git rule is justified only by a git command line in the file
    if any(line.startswith("git ") for line in code_lines(text)):
        allowed |= {"git:*"} if path.stem == "init" else set()

    rules = rules_of(front_matter(text)["allowed-tools"])

    assert set(rules) <= allowed, f"{path.name} allows {sorted(set(rules) - allowed)}"
    assert len(rules) == len(set(rules))


@pytest.mark.parametrize("path", COMMANDS, ids=lambda p: p.stem)
def test_every_command_line_is_one_plain_bugs_bot_invocation(path: Path):
    text = path.read_text()
    assert text.startswith("---\ndescription: ")

    for line in code_lines(text):
        if path.stem == "start" and line == ITERM_PATH_LINE:
            continue
        starts = {"doctor": ("bugs-bot ", BOOTSTRAP + " "), "start": ("bugs-bot ", ITERM_LAUNCHER)}.get(path.stem, ("bugs-bot ",))
        assert line.startswith(starts), f"{path.name}: {line!r} is not a bugs-bot command"
        for token in FORBIDDEN:
            assert token not in line, f"{path.name}: {line!r} carries {token!r}"
    assert "$(" not in text and "&&" not in text


def test_the_guard_reads_what_it_guards():
    assert len(COMMANDS) == 4
    assert all(code_lines(p.read_text()) for p in COMMANDS if p.stem in {"init", "doctor", "start"})


@pytest.mark.parametrize("phrase", [
    ".bugs-bot.json", "/bugs-bot:init", "ListAgents", "you already have one", "it belongs to",
    'bugs-bot agent-prompt --launcher "', "sort -V | tail -1", "--right-of self", "move --tty", "verify --tty",
    "orchestrator plugin",
])
def test_start_launches_the_projects_one_agent(phrase):
    assert phrase in (REPO_ROOT / "commands" / "start.md").read_text()


def test_the_orchestrator_plugin_start_needs_is_a_declared_dependency():
    manifest = json.loads((REPO_ROOT / ".claude-plugin" / "plugin.json").read_text())

    assert "orchestrator@lounisbou" in manifest.get("dependencies", [])


@pytest.mark.parametrize("kind", ["telegram", "slack"])
def test_doctor_tells_what_to_do_about_each_channels_token_and_bot_check(kind):
    from bugs_bot.channels import KINDS

    text = (REPO_ROOT / "commands" / "doctor.md").read_text()
    token = "token" if kind == "telegram" else f"{kind} token"  # the names doctor.py prints

    assert kind in KINDS
    assert f"- `{token}`:" in text and f"{kind.upper()}_BOT_TOKEN" in text
    assert f"`{kind} bot`" in text


@pytest.mark.parametrize("path, stale", [
    ("agent/AGENT.md", "the Telegram group"),
    ("commands/start.md", "Telegram group"),
    ("skills/bugs-bot/SKILL.md", "Telegram's description"),
    ("skills/bugs-bot/SKILL.md", "asks Telegram for"),
])
def test_no_instruction_says_a_projects_group_is_telegram_s_only(path, stale):
    assert stale not in (REPO_ROOT / path).read_text()


def test_the_skill_names_both_tokens_and_sets_up_both_channels():
    text = (REPO_ROOT / "skills" / "bugs-bot" / "SKILL.md").read_text()
    setup = text.split("## Setup by the operator", 1)[1]

    assert "SLACK_BOT_TOKEN" in text and "TELEGRAM_BOT_TOKEN" in text
    assert "Slack" in setup and "/invite" in setup
    assert "chat.update" in text
