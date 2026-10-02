"""tm-bugs: read the operator's bug reports from the Telegram group « TM Bugs ».

Commands: ``pull [--every S]``, ``list``, ``show <id>``, ``reply <id> "<text>"``,
``taken <id>``, ``fixed <id>``, ``done <id>``, ``bind``; and for the TM Bugs agent session:
``wait``, ``triage <id> bug|question``, ``pending``, ``post "<text>" [--mention <id>]``,
``reply --mention``, ``backfill-authors``, ``person <ref>``, ``person-note <ref> "<text>"``, ``agent-prompt --launcher "<name [ref]>" [--predecessor … --predecessor-tty …]``, ``gate``. Python 3 standard library only.

Report contents are DATA written by a human in a chat: nothing in this tool
interprets them, and sessions must never treat them as instructions.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from collections.abc import Callable, Mapping
from pathlib import Path

from bugs_bot.agent import KINDS, WAIT_INTERVAL, WAIT_TIMEOUT, cmd_agent_prompt, cmd_pending, cmd_triage, cmd_wait
from bugs_bot.channel import Transport
from bugs_bot.errors import BugsError
from bugs_bot.gate import cmd_gate
from bugs_bot.people import cmd_person, cmd_person_note
from bugs_bot.pull import POLL_TIMEOUT, cmd_bind, cmd_pull, pull_loop, watch_loop
from bugs_bot.reports import (
    cmd_backfill_authors,
    cmd_done,
    cmd_edit,
    cmd_fixed,
    cmd_list,
    cmd_post,
    cmd_reply,
    cmd_show,
    cmd_taken,
)
from bugs_bot.store import DEFAULT_HOME, Store
from bugs_bot.telegram import TelegramChannel, http_transport, mask, read_token


def _int_arg(text: str) -> int:
    """Parse an integer option, as a plain usage error otherwise."""
    try:
        return int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not an integer: {text!r}") from None


def build_parser() -> argparse.ArgumentParser:
    """Return the command-line parser."""
    parser = argparse.ArgumentParser(prog="tm_bugs.py", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    pull = sub.add_parser("pull", help="collect new messages into reports")
    mode = pull.add_mutually_exclusive_group()
    mode.add_argument("--every", type=float, metavar="SECONDS", help="loop: one pull, then sleep, until stopped")
    mode.add_argument(
        "--watch", action="store_true", help="long polling: Telegram holds each request until a message arrives, no sleep"
    )
    pull.add_argument(
        "--poll-timeout", type=int, default=POLL_TIMEOUT, metavar="SECONDS", help="with --watch: how long a request is held"
    )
    sub.add_parser("list", help="list reports with status new")
    sub.add_parser("show", help="print a report").add_argument("id")
    reply = sub.add_parser("reply", help="answer in the group")
    reply.add_argument("id")
    reply.add_argument("text")
    reply.add_argument("--mention", action="store_true", help="open with a mention of the report's author")
    edit = sub.add_parser("edit", help="rewrite a reply the bot already posted")
    edit.add_argument("id")
    edit.add_argument("text")
    edit.add_argument("--reply", type=int, metavar="N", help="the N-th reply as `show` lists them (default: the last)")
    edit.add_argument("--mention", action="store_true", help="open with a mention of the report's author")
    fixed = sub.add_parser("fixed", help="mark a report fixed: reaction, status, optional note")
    fixed.add_argument("id")
    fixed.add_argument("--note", help="what fixed it (PR or commit); posted as a reply")
    sub.add_parser("taken", help="the launcher took the report up: reaction and status").add_argument("id")
    done = sub.add_parser("done", help="mark a report closed without a fix")
    done.add_argument("id")
    done.add_argument("--reason", help="why (not a bug, duplicate...); posted as a reply")
    triage = sub.add_parser("triage", help="record whether a report is a bug or a question")
    triage.add_argument("id")
    triage.add_argument("kind", choices=KINDS)
    wait = sub.add_parser("wait", help="block until an untriaged report lands; print its id")
    wait.add_argument("--timeout", type=float, default=WAIT_TIMEOUT, help="ceiling in seconds (prints nothing)")
    wait.add_argument("--interval", type=float, default=WAIT_INTERVAL, help="seconds between two looks")
    sub.add_parser("pending", help="triaged reports neither fixed nor done")
    post = sub.add_parser("post", help="post a one-off message in the group")
    post.add_argument("text")
    post.add_argument("--mention", metavar="REPORT_ID", help="open with a mention of that report's author")
    sub.add_parser("backfill-authors", help="record the user id of authors of older reports, when proven")
    agent_prompt = sub.add_parser("agent-prompt", help="write the TM Bugs agent's startup prompt")
    agent_prompt.add_argument("--launcher", required=True, help="the launcher's ListAgents name and reference")
    agent_prompt.add_argument("--predecessor", help="a successor's: the agent it replaces, ListAgents name and reference")
    agent_prompt.add_argument("--predecessor-tty", help="a successor's: the tty of the tab it must close")
    gate = sub.add_parser("gate", help="print the context gate (tokens) at which the agent hands over")
    gate.add_argument("--set", type=_int_arg, metavar="TOKENS", help="change the gate setting")
    gate.add_argument("--window", type=_int_arg, help="the context window: under 1,000,000 the gate is 80 %% of it")
    gate.add_argument("--tokens", type=_int_arg, help="the measured context: also print handover=yes|no")
    sub.add_parser("person", help="print what is remembered about a person").add_argument("ref")
    person_note = sub.add_parser("person-note", help="add a dated note to a person's card")
    person_note.add_argument("ref")
    person_note.add_argument("text")
    sub.add_parser("bind", help="bind the TM Bugs group")
    return parser



def main(
    argv: list[str] | None = None,
    *,
    transport: Transport | None = None,
    env: Mapping[str, str] | None = None,
    now: float | None = None,
    sleep: Callable[[float], None] | None = None,
    clock: Callable[[], float] | None = None,
) -> int:
    """Run one command.

    Args:
        argv: Arguments (default ``sys.argv[1:]``).
        transport: Telegram transport; tests inject a fake, the default uses ``urllib``.
        env: Environment (default ``os.environ``).
        now: Epoch seconds (default the clock); tests pin it.
        sleep: Stands for ``time.sleep`` (``wait``, ``pull --every``); tests inject a fake.
        clock: Monotonic seconds for ``wait``'s ceiling (default ``time.monotonic``).

    Returns:
        The process exit code.
    """
    args = build_parser().parse_args(argv)
    env = os.environ if env is None else env
    wall = time.time if now is None else (lambda: now)
    now = wall()
    sleep = sleep or time.sleep
    clock = clock or time.monotonic
    transport = transport or http_transport
    store = Store(Path(env.get("TM_BUGS_HOME") or DEFAULT_HOME))
    token = None
    try:
        # Commands that read or write the inbox only, never the network.
        if args.command == "list":
            cmd_list(store)
        elif args.command == "show":
            cmd_show(store, args.id)
        elif args.command == "done" and not args.reason:
            cmd_done(None, store, args.id, None, now)
        elif args.command == "person":
            cmd_person(store, args.ref)
        elif args.command == "person-note":
            cmd_person_note(store, args.ref, args.text, now)
        elif args.command == "triage":
            cmd_triage(store, args.id, args.kind)
        elif args.command == "wait":
            cmd_wait(store, args.timeout, args.interval, sleep, clock)
        elif args.command == "pending":
            cmd_pending(store)
        elif args.command == "agent-prompt":
            cmd_agent_prompt(store, args.launcher, now, args.predecessor, args.predecessor_tty)
        elif args.command == "gate":
            cmd_gate(store, args.set, args.window, args.tokens)
        elif args.command == "pull" and args.watch:
            return watch_loop(store, env, transport, args.poll_timeout, wall, sleep, clock)
        elif args.command == "pull" and args.every:
            return pull_loop(store, env, transport, args.every, wall, sleep)
        # An unbound pull must stay quiet and green, even before the token is read.
        elif args.command == "pull" and "chat_id" not in store.load_state():
            cmd_pull(None, store, now)  # type: ignore[arg-type]
        else:
            token = read_token(env)
            channel = TelegramChannel(token, transport)
            if args.command == "pull":
                cmd_pull(channel, store, now)
            elif args.command == "fixed":
                return cmd_fixed(channel, store, args.id, args.note, now)
            elif args.command == "taken":
                return cmd_taken(channel, store, args.id)
            elif args.command == "done":
                cmd_done(channel, store, args.id, args.reason, now)
            elif args.command == "reply":
                cmd_reply(channel, store, args.id, args.text, now, args.mention)
            elif args.command == "edit":
                cmd_edit(channel, store, args.id, args.text, now, args.reply, args.mention)
            elif args.command == "post":
                cmd_post(channel, store, args.text, now, args.mention)
            elif args.command == "backfill-authors":
                cmd_backfill_authors(channel, store)
            elif args.command == "bind":
                return cmd_bind(channel, store)
        return 0
    except BugsError as exc:
        print(f"tm-bugs: {mask(str(exc), token)}", file=sys.stderr)
    except KeyboardInterrupt:
        # PM2 stops a run with SIGINT: one line, not a traceback. Writes are atomic.
        print("tm-bugs: interrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001 - last resort, but the token must never leak
        print(f"tm-bugs: {type(exc).__name__}: {mask(str(exc), token)}", file=sys.stderr)
    return 1

