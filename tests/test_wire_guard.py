"""Each platform's wire protocol is named by its own modules only: the rest of the package sees the Channel."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from conftest import REPO_ROOT

# Telegram's Bot API: its host, its methods, the update fields read, its token's variable; and its kind's name.
TELEGRAM_WIRE = re.compile(
    r"api\.telegram\.org|getUpdates|sendMessage|editMessageText|deleteMessage|setMessageReaction|getFile"
    r"|getChatAdministrators|getChatMemberCount|getMe|update_id|migrate_to_chat_id|migrate_from_chat_id"
    r"|media_group_id|language_code|reply_parameters|text_mention|TELEGRAM_BOT_TOKEN|is_bot|\[.from.\]"
    r"|BUGS_BOT_API_ROOT|allowed_updates|sendPhoto|sendMediaGroup|edited_message|[\"']telegram[\"']"
)
# Slack's Web API: its hosts, its methods, the message fields read, its token's variable and shape; and its kind's name.
SLACK_WIRE = re.compile(
    r"slack\.com|conversations\.(history|replies|members|info)|users\.(info|conversations)"
    r"|chat\.(postMessage|update|delete)|reactions\.(add|remove)|auth\.test|url_private|thread_ts"
    r"|SLACK_BOT_TOKEN|BUGS_BOT_SLACK_API_ROOT|xox[abp]-|response_metadata|next_cursor|bot_id"
    r"|\b(conversations|users|chat|reactions|files|auth)\.[a-z]+|[\"']slack[\"']"
)
OWNERS = {
    "telegram": ({"bugs_bot/telegram.py", "bugs_bot/telegram_inbound.py"}, TELEGRAM_WIRE),
    "slack": ({"bugs_bot/slack.py", "bugs_bot/slack_inbound.py"}, SLACK_WIRE),
}
# What may stay elsewhere, each with its reason: (file, text the line holds).
ALLOWED = {
    # The contract's own field, Author.is_bot (Slack's user object happens to name it alike).
    ("bugs_bot/channel.py", "is_bot: bool"),
    ("bugs_bot/people.py", "not a.is_bot"),
    ("bugs_bot/slack_inbound.py", 'user.get("is_bot")'),
    ("bugs_bot/slack_inbound.py", "if author.is_bot:"),
    # The contract's comment on group_key, and the key report.json has always stored it under.
    ("bugs_bot/channel.py", "Telegram's media_group_id"),
    ("bugs_bot/pull.py", '"media_group_id": first.group_key'),
    # The factory: the one module naming the implementations, by kind (spec § 3.1).
    ("bugs_bot/channels.py", '"telegram": ('),
    ("bugs_bot/channels.py", '"slack": ('),
    # A project file written before Slack names no channel: it reads as Telegram's.
    ("bugs_bot/project.py", 'DEFAULT_CHANNEL = "telegram"'),
    # The type each kind's chat id is checked against in a project file (a Telegram id is an int).
    ("bugs_bot/project.py", '"telegram": (int, None)'),
    ("bugs_bot/project.py", '"slack": (str, re.compile('),
    # Telegram's cursor stays the ``offset`` key state.json has always held.
    ("bugs_bot/store.py", 'if kind == "telegram":'),
    # A local variable named ``chat`` (a Batch's chat entry, a Telegram chat object), not Slack's ``chat.*`` methods.
    ("bugs_bot/init.py", 'chat.get("title")'),
    ("bugs_bot/pull.py", "chat.get('title', '')"),
    ("bugs_bot/store.py", '"title": chat.get("title")'),
    ("bugs_bot/store.py", '"type": chat.get("type")'),
    ("bugs_bot/telegram_inbound.py", 'chat.get("type") in GROUP_CHAT_TYPES'),
    ("bugs_bot/telegram_inbound.py", 'chat.get("title", "")'),
}


def sources(root: Path) -> list[str]:
    """Return the package's modules and the CLI entry point, relative to ``root``."""
    return sorted(str(path.relative_to(root)) for path in [*(root / "bugs_bot").glob("*.py"), root / "bin" / "bugs-bot"] if path.is_file())


def strays(root: Path, paths: list[str]) -> list[str]:
    """Return ``path:line: text`` for every wire name outside its platform's modules, the allowed residue aside."""
    found = []
    for path in paths:
        for number, line in enumerate((root / path).read_text().splitlines(), 1):
            for platform, (owners, wire) in OWNERS.items():
                if path in owners or not wire.search(line):
                    continue
                if any(path == where and text in line for where, text in ALLOWED):
                    continue
                found.append(f"{path}:{number}: {platform}: {line.strip()[:100]}")
    return found


def test_the_guard_searches_every_module():
    paths = sources(REPO_ROOT)

    assert {"bugs_bot/pull.py", "bugs_bot/slack.py", "bugs_bot/telegram.py", "bin/bugs-bot"} <= set(paths)


def test_no_wire_name_leaves_its_platform_s_modules():
    assert strays(REPO_ROOT, sources(REPO_ROOT)) == []


def test_every_allowed_residue_is_still_there():
    # A residue gone from its file is a stale exemption: remove it from ALLOWED.
    stale = [(path, text) for path, text in ALLOWED if text not in (REPO_ROOT / path).read_text()]

    assert stale == []


@pytest.mark.parametrize(
    "line, platform",
    [('x = call("getUpdates")', "telegram"), ('url = "https://slack.com/api"', "slack"), ('call("chat.postMessage")', "slack"),
     ('read_secret(env, "TELEGRAM_BOT_TOKEN")', "telegram"), ('m.get("thread_ts")', "slack")],
)
def test_the_guard_sees_a_wire_name_outside_its_modules_and_not_inside(tmp_path, line, platform):
    for path in ("bugs_bot/pull.py", "bugs_bot/telegram.py", "bugs_bot/slack.py"):
        (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / path).write_text(f"ok\n{line}\n")

    found = strays(tmp_path, ["bugs_bot/pull.py", "bugs_bot/telegram.py", "bugs_bot/slack.py"])

    owner = "bugs_bot/telegram.py" if platform == "telegram" else "bugs_bot/slack.py"
    assert f"bugs_bot/pull.py:2: {platform}: {line}" in found
    assert not any(item.startswith(owner) for item in found)


def test_the_generic_channel_module_names_no_token_shape():
    text = (REPO_ROOT / "bugs_bot" / "channel.py").read_text()

    assert not re.search(r"xox|\\d\{3,\}:|TOKEN_SHAPE", text)


def test_the_masks_and_the_long_polled_kinds_come_from_the_implementations():
    from bugs_bot import channels
    from bugs_bot.slack import SlackChannel
    from bugs_bot.telegram import TelegramChannel

    assert channels.TOKEN_SHAPES == (TelegramChannel.TOKEN_SHAPE, SlackChannel.TOKEN_SHAPE)
    assert channels.LONG_POLL_KINDS == {"telegram"} and not hasattr(__import__("bugs_bot.watch").watch, "TELEGRAM")
    assert channels.mask("a 999:ABCdef_ghi-123 and xoxb-1-2-abc", None) == "a <token> and <token>"
