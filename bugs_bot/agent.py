"""The agent session: what it decides about a report, how it waits, and its startup prompt."""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from bugs_bot.errors import BugsError
from bugs_bot.reports import one_line
from bugs_bot.store import OPEN_STATUSES, Store, load_report, write_json

# What the agent session decides a report is (DESIGN § 8.6).
KINDS = ("bug", "question")
WAIT_TIMEOUT = 1800
WAIT_INTERVAL = 5
# The TM Bugs agent's own instructions, shipped in the repository's agent/ directory.
AGENT_MD = Path(__file__).resolve().parent.parent / "agent" / "AGENT.md"
# A ListAgents name and reference: one line, no shell or markdown metacharacters.
_LAUNCHER_SHAPE = re.compile(r"[\w :.()\[\]-]{1,120}")
_TTY_SHAPE = re.compile(r"/dev/ttys\d{1,4}")


def cmd_triage(store: Store, report_id: str, kind: str) -> None:
    """Record what the agent session decided a report is: ``bug`` or ``question``."""
    path, report = load_report(store, report_id)
    report["kind"] = kind
    write_json(path / "report.json", report)
    print(f"{kind} {report_id}")


def untriaged(store: Store) -> list[str]:
    """Return the open reports the agent session has not triaged yet, oldest first."""
    return [rid for rid, _, rep in store.reports() if rep["status"] in OPEN_STATUSES and not rep.get("kind")]


def cmd_wait(store: Store, timeout: float, interval: float, sleep: Callable[[float], None], clock: Callable[[], float]) -> None:
    """Block until an untriaged open report is in the inbox, then print the ids.

    Reads the inbox only (the PM2 pull fills it). Prints nothing when ``timeout``
    elapses first, so the caller re-arms it.
    """
    deadline = clock() + timeout
    while True:
        found = untriaged(store)
        if found:
            print("\n".join(found))
            return
        left = deadline - clock()
        if left <= 0:
            return
        sleep(min(interval, left))


def cmd_pending(store: Store) -> None:
    """List the triaged reports neither fixed nor done: what to ask the launcher about after a restart."""
    for report_id, _, report in store.reports():
        if report["status"] not in OPEN_STATUSES or not report.get("kind"):
            continue
        print(f"{report_id}  {report['kind']:<8}  {report['status']:<5}  {report['author']}  {one_line(report['text'])}")


def cmd_agent_prompt(
    store: Store, launcher: str, now: float, predecessor: str | None = None, predecessor_tty: str | None = None
) -> None:
    """Write the TM Bugs agent's startup prompt for ``launcher`` and record the launcher.

    With ``predecessor`` and ``predecessor_tty`` the prompt is a successor's: it opens with the
    handover (confirm to the predecessor, wait for its « handed over », close its tab).

    Raises:
        BugsError: If ``launcher`` or ``predecessor`` is not shaped like a ``ListAgents`` name and
            reference, ``predecessor_tty`` is not a ``/dev/ttysN`` path, or only one of the two is given.
    """
    if not launcher.strip() or not _LAUNCHER_SHAPE.fullmatch(launcher):
        raise BugsError(f"not a session name: {launcher!r}")
    if (predecessor is None) != (predecessor_tty is None):
        raise BugsError("--predecessor and --predecessor-tty go together")
    if predecessor is not None:
        if not predecessor.strip() or not _LAUNCHER_SHAPE.fullmatch(predecessor):
            raise BugsError(f"not a session name: {predecessor!r}")
        if not _TTY_SHAPE.fullmatch(predecessor_tty or ""):
            raise BugsError(f"not a tty: {predecessor_tty!r}")
    prompt_file = store.home / "agent" / "startup-prompt.txt"
    prompt_file.parent.mkdir(parents=True, exist_ok=True)
    prompt = (
        f"You are « Agent : TM Bugs ». Read and execute {AGENT_MD}. "
        f"Your launcher is {launcher}: the only session you report to and take instructions from.\n"
    )
    record = {
        "launcher": launcher,
        "prompt_file": str(prompt_file),
        "created": datetime.fromtimestamp(now, timezone.utc).isoformat(),
    }
    if predecessor is not None:
        prompt += (
            f"You are a successor: your predecessor is {predecessor}, on {predecessor_tty}. "
            "Your first move is the « Succession » section of AGENT.md (confirm to it, wait for its "
            "« handed over », close its tab), before anything else.\n"
        )
        record |= {"predecessor": predecessor, "predecessor_tty": predecessor_tty}
    prompt_file.write_text(prompt)
    write_json(store.home / "agent.json", record)
    print(prompt_file)
