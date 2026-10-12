"""The hooks module's contract with the CLI: the `bugs` tool's commands are the parser's, `wait` and the machine's own aside."""

from __future__ import annotations

import json
import re

from conftest import REPO_ROOT

from bugs_bot.cli import build_parser

CORE = (REPO_ROOT / "hooks" / "core.ts").read_text()
# The commands an agent never runs through the tool: the machine's, and the 55-minute wait.
OUTSIDE_THE_TOOL = {"pull", "init", "remove", "doctor", "wait"}


def ts_list(name: str) -> list[str]:
    """Return the string literals of the ``export const <name> = [...]`` of core.ts."""
    body = re.search(rf"export const {name} = \[(.*?)\]", CORE, re.DOTALL)
    assert body, f"no {name} in core.ts"
    return re.findall(r"'([^']+)'", body.group(1))


def parser_commands() -> set[str]:
    """Return every subcommand the CLI's parser declares."""
    sub = next(a for a in build_parser()._actions if a.dest == "command")
    return set(sub.choices)


def test_the_tool_runs_every_cli_command_but_the_machines_and_wait():
    assert set(ts_list("TOOL_COMMANDS")) == parser_commands() - OUTSIDE_THE_TOOL


def test_the_tools_reads_are_commands_of_the_tool():
    reads = set(re.findall(r"'([^']+)'", re.search(r"export const READS = new Set\(\[(.*?)\]\)", CORE).group(1)))
    assert reads <= set(ts_list("TOOL_COMMANDS"))
    assert not reads & {"reply", "edit", "delete", "post", "taken", "fixed", "done", "gate", "handover"}


def test_the_module_is_declared_and_its_matchers_name_the_plugin():
    hooks = json.loads((REPO_ROOT / "hooks" / "hooks.json").read_text())
    assert hooks["modules"] == ["./register.ts"]
    name = json.loads((REPO_ROOT / ".claude-plugin" / "plugin.json").read_text())["name"]
    assert f"export const TOOL = 'mcp__{name}__bugs'" in CORE
    assert "{ command: START_COMMAND }" in (REPO_ROOT / "hooks" / "start.ts").read_text()
    assert f"export const START_COMMAND = '{name}:start'" in (REPO_ROOT / "hooks" / "start.ts").read_text()


def test_every_tool_matcher_spells_the_tools_own_name():
    spelled = {
        m
        for path in (REPO_ROOT / "hooks").glob("*.ts")
        for m in re.findall(r"\{ tool: '(mcp__[^']+)' \}", path.read_text())
    }
    assert spelled == {"mcp__bugs-bot__bugs"}
