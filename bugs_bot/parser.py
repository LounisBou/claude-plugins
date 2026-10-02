"""The command line of bugs-bot: every command, its arguments and their help."""

from __future__ import annotations

import argparse

from bugs_bot.agent import KINDS as REPORT_KINDS, WAIT_INTERVAL, WAIT_TIMEOUT
from bugs_bot.channels import KINDS
from bugs_bot.watch import POLL_TIMEOUT


def _int_arg(text: str) -> int:
    """Parse an integer option, as a plain usage error otherwise."""
    try:
        return int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not an integer: {text!r}") from None


def _chat_id_arg(text: str) -> int | str:
    """Parse a chat id: digits are an integer id (Telegram's), anything else a string (a Slack channel id)."""
    try:
        return int(text)
    except ValueError:
        if not text.strip():
            raise argparse.ArgumentTypeError("an empty chat id") from None
        return text


def build_parser(description: str) -> argparse.ArgumentParser:
    """Return the command-line parser, ``description`` heading its help."""
    parser = argparse.ArgumentParser(prog="bugs-bot", description=description)
    # Every command but pull works on one project: the named one, else the one of the current directory.
    project = argparse.ArgumentParser(add_help=False)
    project.add_argument("--project", metavar="ID", help="the project (default: the one of the current directory)")
    sub = parser.add_subparsers(dest="command", required=True)
    pull = sub.add_parser("pull", help="collect new messages into reports")
    mode = pull.add_mutually_exclusive_group()
    mode.add_argument("--every", type=float, metavar="SECONDS", help="loop: one pull, then sleep, until stopped")
    mode.add_argument(
        "--watch", action="store_true", help="long polling: the channel holds each request until a message arrives, no sleep"
    )
    pull.add_argument(
        "--poll-timeout", type=int, default=POLL_TIMEOUT, metavar="SECONDS", help="with --watch: how long a request is held"
    )
    init = sub.add_parser("init", help="bind this repository to its group (Telegram) or channel (Slack) and register the project")
    init.add_argument("--project", metavar="ID", help="the project id, [a-z0-9-]+ (required on a first run)")
    init.add_argument("--agent-title", help="the agent session's tab title (required on a first run)")
    init.add_argument("--channel", choices=KINDS, help="where the group is (default: the project file's, else telegram)")
    init.add_argument(
        "--chat-id", "--chat", dest="chat_id", type=_chat_id_arg, help="the group's chat id (else the one group the bot has seen)"
    )
    init.add_argument("--title", help="the group's title, with --chat-id")
    init.add_argument("--deploy-url", help="where the project is deployed")
    init.add_argument("--deploy-check", metavar="CMD", help="a shell command proving a commit is served")
    init.add_argument("--docs", nargs="+", metavar="PATH", help="the documentation the agent answers from")
    init.add_argument("--language", help="the language of the agent's messages in the group")
    init.add_argument("--gate-tokens", type=_int_arg, metavar="N", help="the context size at which the agent hands over")
    init.add_argument("--repo", metavar="DIR", help="the repository (default: the git top level of the current directory)")
    doctor = sub.add_parser("doctor", help="check the setup of this machine")
    doctor.add_argument("--install-launcher", action="store_true", help="install the fixed launcher first")
    sub.add_parser("remove", parents=[project], help="unregister a project (its data and project file are kept)")
    sub.add_parser("list", parents=[project], help="list reports with status new")
    sub.add_parser("show", parents=[project], help="print a report").add_argument("id")
    reply = sub.add_parser("reply", parents=[project], help="answer in the group")
    reply.add_argument("id")
    reply.add_argument("text")
    reply.add_argument("--mention", action="store_true", help="open with a mention of the report's author")
    waits = reply.add_mutually_exclusive_group()
    waits.add_argument("--awaits", action="store_true", help="the reply asks the person something: wait for the answer")
    waits.add_argument("--follow-up", action="store_true", help="the one reminder of a wait that is due")
    reply.add_argument("--image", action="append", metavar="PATH", help="a screenshot to send with the text (repeatable, up to 10)")
    edit = sub.add_parser("edit", parents=[project], help="rewrite a reply the bot already posted")
    edit.add_argument("id")
    edit.add_argument("text")
    edit.add_argument("--reply", type=int, metavar="N", help="the N-th reply as `show` lists them (default: the last)")
    edit.add_argument("--mention", action="store_true", help="open with a mention of the report's author")
    edit.add_argument("--awaits", action="store_true", help="the rewritten reply asks the person something")
    delete = sub.add_parser("delete", parents=[project], help="delete a reply the bot posted (kept in the report, marked deleted)")
    delete.add_argument("id")
    delete.add_argument("--reply", type=int, metavar="N", help="the N-th reply as `show` lists them (default: the last)")
    fixed = sub.add_parser("fixed", parents=[project], help="mark a report fixed: reaction, status, the fix's ref recorded")
    fixed.add_argument("id")
    fixed.add_argument("--note", help="what fixed it (PR or commit); recorded for the agent, never posted")
    sub.add_parser("taken", parents=[project], help="the launcher took the report up: reaction and status").add_argument("id")
    done = sub.add_parser("done", parents=[project], help="mark a report closed without a fix")
    done.add_argument("id")
    done.add_argument("--reason", help="why (not a bug, duplicate...); posted as a reply")
    triage = sub.add_parser("triage", parents=[project], help="record whether a report is a bug or a question")
    triage.add_argument("id")
    triage.add_argument("kind", choices=REPORT_KINDS)
    wait = sub.add_parser("wait", parents=[project], help="block until an untriaged report lands or a wait falls due; print it")
    wait.add_argument("--timeout", type=float, default=WAIT_TIMEOUT, help="ceiling in seconds (prints nothing)")
    wait.add_argument("--interval", type=float, default=WAIT_INTERVAL, help="seconds between two looks")
    sub.add_parser("pending", parents=[project], help="triaged reports neither fixed nor done, and the overdue waits")
    sub.add_parser("overdue", parents=[project], help="the follow-ups due and the waits unanswered after their reminder")
    sub.add_parser("escalated", parents=[project], help="the launcher was told a wait stays unanswered").add_argument("id")
    sub.add_parser("unask", parents=[project], help="drop the question queued about a report: it no longer needs asking").add_argument("id")
    post = sub.add_parser("post", parents=[project], help="post a one-off message in the group")
    post.add_argument("text")
    post.add_argument("--mention", metavar="REPORT_ID", help="open with a mention of that report's author")
    post.add_argument("--image", action="append", metavar="PATH", help="a screenshot to send with the text (repeatable, up to 10)")
    sub.add_parser("backfill-authors", parents=[project], help="record the user id of authors of older reports, when proven")
    agent_prompt = sub.add_parser("agent-prompt", parents=[project], help="write the agent's startup prompt")
    agent_prompt.add_argument("--launcher", required=True, help="the launcher's ListAgents name and reference")
    agent_prompt.add_argument("--predecessor", help="a successor's: the agent it replaces, ListAgents name and reference")
    agent_prompt.add_argument("--predecessor-tty", help="a successor's: the tty of the tab it must close")
    gate = sub.add_parser("gate", parents=[project], help="print the context gate (tokens) at which the agent hands over")
    gate.add_argument("--set", type=_int_arg, metavar="TOKENS", help="change the gate setting")
    gate.add_argument("--window", type=_int_arg, help="the context window: under 1,000,000 the gate is 80 %% of it")
    gate.add_argument("--tokens", type=_int_arg, help="the measured context: also print handover=yes|no")
    gate.add_argument("--measure", action="store_true", help="measure the context through the orchestrator's gauge")
    deployed = sub.add_parser("deployed", parents=[project], help="say whether a commit is served, through the deploy check")
    deployed.add_argument("commit")
    handover = sub.add_parser("handover", help="the note an agent leaves its successor")
    handover_sub = handover.add_subparsers(dest="action", required=True)
    handover_write = handover_sub.add_parser("write", parents=[project], help="write the note (refused while an unread one exists)")
    handover_write.add_argument("text")
    handover_sub.add_parser("read", parents=[project], help="print the note once, then archive it")
    sub.add_parser("person", parents=[project], help="print what is remembered about a person").add_argument("ref")
    person_lang = sub.add_parser("person-lang", parents=[project], help="set the language a person is written to in")
    person_lang.add_argument("ref")
    person_lang.add_argument("code", help="two lower-case letters: fr, en, es…")
    person_note = sub.add_parser("person-note", parents=[project], help="add a dated note to a person's card")
    person_note.add_argument("ref")
    person_note.add_argument("text")
    return parser
