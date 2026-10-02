"""Tests for the Slack channel: every ``Channel`` method against a fake Web API transport, the payloads pinned."""

from __future__ import annotations

import json

import pytest
from fake_slack import CHANNEL, ROOT, SLACK_TOKEN, FakeSlack, msg, ts, user

from bugs_bot.channel import Attachment, Author, Body
from bugs_bot.channels import channel_for, mask, token_problem
from bugs_bot.errors import BugsError, RateLimited
from bugs_bot.slack import GONE, SlackChannel

NOW = 1790929800 + 3600
AUTH = {"Authorization": f"Bearer {SLACK_TOKEN}"}


@pytest.fixture
def api() -> FakeSlack:
    return FakeSlack()


@pytest.fixture
def slack(api: FakeSlack) -> SlackChannel:
    return SlackChannel(SLACK_TOKEN, api, ROOT, clock=lambda: NOW)


# -- writing ------------------------------------------------------------------------------------------


def test_send_posts_json_with_the_token_in_the_header_only(slack, api):
    sent = slack.send(CHANNEL, "merci, je regarde")

    (call,) = api.calls
    assert (call["url"], call["post"], call["headers"]) == (f"{ROOT}/chat.postMessage", True, AUTH)
    assert call["params"] == {"channel": CHANNEL, "text": "merci, je regarde"}
    assert sent == {"message_id": "1790934801.000100", "text": "merci, je regarde"}


def test_send_threads_on_the_report_and_mentions_by_user_id(slack, api):
    sent = slack.send(CHANNEL, "c'est corrigé", ts(0), {"user_id": "U0ANA", "username": "ana", "name": "Ana"})

    assert api.of("chat.postMessage") == [{"channel": CHANNEL, "text": "<@U0ANA> c'est corrigé", "thread_ts": ts(0)}]
    assert sent["text"] == "<@U0ANA> c'est corrigé"


def test_a_mention_without_a_user_id_falls_back_to_the_name_as_text(slack, api):
    slack.send(CHANNEL, "coucou", None, {"user_id": None, "username": None, "name": "Ana"})

    assert api.of("chat.postMessage")[0]["text"] == "@Ana coucou"


def test_edit_updates_by_ts(slack, api):
    edited = slack.edit(CHANNEL, ts(9), "plutôt ceci", {"user_id": "U0ANA", "username": "ana", "name": "Ana"})

    assert api.of("chat.update") == [{"channel": CHANNEL, "ts": ts(9), "text": "<@U0ANA> plutôt ceci"}]
    assert edited == {"message_id": ts(9), "text": "<@U0ANA> plutôt ceci"}


def test_delete_deletes_by_ts(slack, api):
    slack.delete(CHANNEL, ts(9))

    assert api.of("chat.delete") == [{"channel": CHANNEL, "ts": ts(9)}]


@pytest.mark.parametrize(
    "emoji, name",
    [("\U0001f440", "eyes"), ("\U0001f44c", "ok_hand"), ("✅", "white_check_mark"), ("\U0001f468‍\U0001f4bb", "male-technologist")],
)
def test_react_puts_the_slack_name_and_takes_the_others_off(slack, api, emoji, name):
    slack.react(CHANNEL, ts(0), emoji)

    assert api.of("reactions.add") == [{"channel": CHANNEL, "timestamp": ts(0), "name": name}]
    removed = {params["name"] for params in api.of("reactions.remove")}
    assert removed == {"eyes", "ok_hand", "white_check_mark", "male-technologist"} - {name}
    assert api.methods()[-1] == "reactions.add"


def test_react_refuses_an_emoji_it_has_no_name_for_without_calling(slack, api):
    with pytest.raises(BugsError, match="no Slack reaction"):
        slack.react(CHANNEL, ts(0), "\U0001f525")
    assert api.calls == []


def test_react_takes_nothing_to_remove_and_already_there_as_done(slack, api):
    api.answers["reactions.remove"] = {"ok": False, "error": "no_reaction"}
    api.answers["reactions.add"] = {"ok": False, "error": "already_reacted"}

    slack.react(CHANNEL, ts(0), "\U0001f440")


def test_react_on_a_deleted_message_says_it_is_gone(slack, api):
    api.answers["reactions.remove"] = {"ok": False, "error": "message_not_found"}

    with pytest.raises(BugsError, match=GONE):
        slack.react(CHANNEL, ts(0), "\U0001f440")


# -- reading files, members, the bot itself -------------------------------------------------------------


def test_get_file_downloads_the_private_url_with_the_token_header(slack, api):
    url = "https://files.slack.com/files-pri/T0-F0/capture.png"
    api.files[url] = b"\x89PNG-fake"

    assert slack.get_file(url) == b"\x89PNG-fake"
    assert api.calls[0]["headers"] == AUTH and api.calls[0]["post"] is False


@pytest.mark.parametrize(
    "url",
    ["https://evil.example/files.slack.com/x.png", "http://files.slack.com/x.png", "https://files.slack.com.evil.example/x.png",
     "https://user@files.slack.com/x.png", "file:///etc/passwd"],
)
def test_get_file_never_sends_the_token_off_slack(slack, api, url):
    with pytest.raises(BugsError, match="not on Slack"):
        slack.get_file(url)
    assert api.calls == []


def test_get_file_refuses_the_sign_in_page_slack_serves_without_a_valid_token(slack):
    page = SlackChannel(SLACK_TOKEN, lambda *a: (200, Body(b"<!DOCTYPE html>", {"Content-Type": "text/html"})), ROOT)

    with pytest.raises(BugsError, match="download"):
        page.get_file("https://files.slack.com/x.png")


def test_list_admins_returns_the_admins_and_owners_among_the_members(slack, api):
    api.users |= {"U0ADM": user("U0ADM", "adm", is_admin=True), "U0OWN": user("U0OWN", "own", is_owner=True)}
    api.answers["conversations.members"] = [
        {"ok": True, "members": ["U0ANA", "U0ADM"], "response_metadata": {"next_cursor": "page2"}},
        {"ok": True, "members": ["U0OWN"], "response_metadata": {"next_cursor": ""}},
    ]

    admins = slack.list_admins(CHANNEL)

    assert [a.id for a in admins] == ["U0ADM", "U0OWN"]
    assert api.of("conversations.members")[1]["cursor"] == "page2"


def test_member_count_reads_the_channel_info(slack, api):
    api.answers["conversations.info"] = {"ok": True, "channel": {"id": CHANNEL, "num_members": 7}}

    assert slack.member_count(CHANNEL) == 7
    assert api.of("conversations.info") == [{"channel": CHANNEL, "include_num_members": "true"}]


def test_whoami_asks_auth_test(slack, api):
    assert slack.whoami() == "@bugsbot (Fake Team)"
    assert api.methods() == ["auth.test"]


# -- failures -------------------------------------------------------------------------------------------


def test_a_refusal_names_the_method_and_the_error_never_the_token(api):
    channel = SlackChannel("xoxb-wrong-token", api, ROOT)

    with pytest.raises(BugsError, match="chat.postMessage: invalid_auth") as caught:
        channel.send(CHANNEL, "x")
    assert "xoxb" not in str(caught.value)


def test_http_429_raises_rate_limited_carrying_retry_after(slack, api):
    api.statuses["conversations.history"] = (429, {"Retry-After": "30"})

    with pytest.raises(RateLimited, match="retry after 30") as caught:
        slack.poll(None, [CHANNEL], 0)
    assert caught.value.retry_after == 30


def test_http_429_without_retry_after_asks_no_particular_wait(slack, api):
    api.statuses["chat.postMessage"] = (429, {})

    with pytest.raises(RateLimited) as caught:
        slack.send(CHANNEL, "x")
    assert caught.value.retry_after == 0


def test_an_answer_that_is_not_json_is_a_clear_error():
    channel = SlackChannel(SLACK_TOKEN, lambda *a: (502, b"<html>bad gateway</html>"), ROOT)

    with pytest.raises(BugsError, match="auth.test: HTTP 502, answer is not JSON"):
        channel.whoami()


def test_mask_hides_slack_tokens_of_every_kind():
    text = "boom xoxb-1-2-abc and xoxp-9-zz and xoxa-2-q in a url ?token=xoxb-777-x"

    assert mask(text, None) == "boom <token> and <token> and <token> in a url ?token=<token>"
    assert SLACK_TOKEN not in mask(f"failed with {SLACK_TOKEN}", None)


# -- the factory ----------------------------------------------------------------------------------------


@pytest.fixture
def slack_env(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(f"TELEGRAM_BOT_TOKEN=123456789:AAAAAAAAAAAAAAAAAAAA\nSLACK_BOT_TOKEN={SLACK_TOKEN}\n")
    return {"BUGS_BOT_ENV_FILE": str(env_file), "BUGS_BOT_HOME": str(tmp_path / "home")}


def test_the_factory_builds_slack_from_its_own_token(slack_env, api):
    channel = channel_for("slack", slack_env, api)

    assert channel.kind == "slack" and channel.secret == SLACK_TOKEN
    channel.whoami()
    assert api.calls[0]["url"] == f"{ROOT}/auth.test"


def test_the_factory_takes_the_slack_api_root_from_the_environment(slack_env, api):
    channel = channel_for("slack", slack_env | {"BUGS_BOT_SLACK_API_ROOT": "http://127.0.0.1:8765/api"}, api)

    channel.whoami()
    assert api.calls[0]["url"] == "http://127.0.0.1:8765/api/auth.test"


@pytest.mark.parametrize("root", ["http://evil.example/api", "ftp://slack.com/api", "https://x@slack.com/api"])
def test_the_factory_refuses_any_other_slack_api_root_and_names_the_variable(slack_env, api, root):
    with pytest.raises(BugsError, match="BUGS_BOT_SLACK_API_ROOT") as caught:
        channel_for("slack", slack_env | {"BUGS_BOT_SLACK_API_ROOT": root}, api)
    assert root not in str(caught.value)


def test_a_missing_slack_token_is_named_never_guessed(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("TELEGRAM_BOT_TOKEN=123456789:AAAAAAAAAAAAAAAAAAAA\n")
    env = {"BUGS_BOT_ENV_FILE": str(env_file)}

    assert token_problem("slack", env) == f"SLACK_BOT_TOKEN not found in {env_file}"
    assert token_problem("telegram", env) is None
    with pytest.raises(BugsError, match="SLACK_BOT_TOKEN"):
        channel_for("slack", env, FakeSlack())


# -- polling --------------------------------------------------------------------------------------------


def test_a_first_poll_reads_a_day_back_oldest_first_with_authors_from_users_info(slack, api):
    api.history[CHANNEL] = [msg(ts(1), "premier"), msg(ts(2), "second &lt;b&gt; &amp; co", "U0BOB"), msg(ts(3), "encore")]

    batch = slack.poll(None, [CHANNEL], 50)

    assert api.of("conversations.history")[0] == {"channel": CHANNEL, "oldest": f"{NOW - 86400:.6f}", "limit": "200"}
    assert [(m.message_id, m.text) for m in batch.messages] == [(ts(1), "premier"), (ts(2), "second <b> & co"), (ts(3), "encore")]
    first = batch.messages[0]
    assert (first.chat_id, first.date, first.group_key, first.thread_of) == (CHANNEL, 1790929801.0001, None, None)
    assert first.author == Author(id="U0ANA", username="ana", name="Ana", language="fr-FR", is_bot=False)
    assert api.of("users.info") == [{"user": "U0ANA", "include_locale": "true"}, {"user": "U0BOB", "include_locale": "true"}]
    assert batch.cursor == {CHANNEL: {"ts": ts(3), "threads": {}}}
    assert (batch.chats, batch.migrations) == ({}, {})


def test_the_next_poll_reads_from_the_cursor_and_the_caller_s_cursor_is_never_moved(slack, api):
    api.history[CHANNEL] = [msg(ts(1), "vu"), msg(ts(2), "nouveau")]
    cursor = {CHANNEL: {"ts": ts(1), "threads": {}}}
    before = json.dumps(cursor)

    batch = slack.poll(cursor, [CHANNEL], 0)

    assert api.of("conversations.history")[0]["oldest"] == ts(1)
    assert [m.text for m in batch.messages] == ["nouveau"]
    assert json.dumps(cursor) == before
    assert batch.cursor == {CHANNEL: {"ts": ts(2), "threads": {}}}


def test_an_empty_poll_gives_the_cursor_back(slack, api):
    cursor = {CHANNEL: {"ts": ts(1), "threads": {}}}

    assert slack.poll(cursor, [CHANNEL], 0).cursor == cursor


def test_bot_posts_service_messages_and_empty_ones_are_skipped_but_passed(slack, api):
    api.users["U0BOT"] = user("U0BOT", "bugsbot", is_bot=True)
    api.history[CHANNEL] = [
        msg(ts(1), "Comment signaler un bug", bot_id="B0X"),
        msg(ts(2), "a rejoint le canal", subtype="channel_join"),
        msg(ts(3), "bonjour", "U0BOT"),
        msg(ts(4), ""),
        msg(ts(5), "un vrai message"),
    ]

    batch = slack.poll(None, [CHANNEL], 0)

    assert [m.text for m in batch.messages] == ["un vrai message"]
    assert batch.cursor[CHANNEL]["ts"] == ts(5)


def test_image_files_are_attachments_by_private_url_and_other_files_are_not(slack, api):
    files = [
        {"id": "F1", "name": "Capture.PNG", "mimetype": "image/png", "url_private": "https://files.slack.com/F1/Capture.PNG",
         "url_private_download": "https://files.slack.com/F1/download/Capture.PNG"},
        {"id": "F2", "name": "", "mimetype": "image/jpeg", "url_private": "https://files.slack.com/F2/x"},
        {"id": "F3", "name": "log.pdf", "mimetype": "application/pdf", "url_private": "https://files.slack.com/F3/log.pdf"},
    ]
    api.history[CHANNEL] = [msg(ts(1), "", subtype="file_share", files=files)]

    (message,) = slack.poll(None, [CHANNEL], 0).messages

    assert message.attachments == (
        Attachment("https://files.slack.com/F1/download/Capture.PNG", ".png"),
        Attachment("https://files.slack.com/F2/x", ".jpg"),
    )


def test_ts_are_compared_exactly_never_as_floats(slack, api):
    # Two messages of the same second, a microsecond apart: a float would merge or misorder them.
    api.history[CHANNEL] = [msg("1790929801.000009", "neuf"), msg("1790929801.000010", "dix")]

    batch = slack.poll({CHANNEL: {"ts": "1790929801.000008", "threads": {}}}, [CHANNEL], 0)

    assert [m.message_id for m in batch.messages] == ["1790929801.000009", "1790929801.000010"]
    assert batch.cursor[CHANNEL]["ts"] == "1790929801.000010"


def test_history_follows_every_page(slack, api):
    api.answers["conversations.history"] = [
        {"ok": True, "messages": [msg(ts(4), "quatre"), msg(ts(3), "trois")], "has_more": True, "response_metadata": {"next_cursor": "p2"}},
        {"ok": True, "messages": [msg(ts(2), "deux")], "has_more": False, "response_metadata": {"next_cursor": ""}},
    ]

    batch = slack.poll(None, [CHANNEL], 0)

    assert [m.text for m in batch.messages] == ["deux", "trois", "quatre"]
    assert api.of("conversations.history")[1]["cursor"] == "p2"


def test_replies_of_the_listed_threads_are_read_from_their_last_reply(slack, api):
    api.history[CHANNEL] = [msg(ts(1), "le bug"), msg(ts(2), "un autre")]
    api.replies[(CHANNEL, ts(1))] = [msg(ts(10), "déjà lu", thread_ts=ts(1)), msg(ts(20), "oui c'est mieux", thread_ts=ts(1))]
    api.replies[(CHANNEL, ts(2))] = [msg(ts(15), "réponse", "U0BOB", thread_ts=ts(2))]
    cursor = {CHANNEL: {"ts": ts(2), "threads": {ts(1): ts(10), ts(9): ts(9)}}}

    batch = slack.poll(cursor, [CHANNEL], 0, threads={CHANNEL: [ts(1), ts(2)]})

    replies = api.of("conversations.replies")
    assert [(r["ts"], r["oldest"]) for r in replies] == [(ts(1), ts(10)), (ts(2), ts(2))]
    assert [(m.text, m.thread_of) for m in batch.messages] == [("réponse", ts(2)), ("oui c'est mieux", ts(1))]
    # A thread no longer listed (its report closed) is dropped; each kept one moves past its last reply.
    assert batch.cursor == {CHANNEL: {"ts": ts(2), "threads": {ts(1): ts(20), ts(2): ts(15)}, "threads_read": NOW}}


def test_without_threads_given_the_known_ones_are_still_read(slack, api):
    api.replies[(CHANNEL, ts(1))] = [msg(ts(20), "suite", thread_ts=ts(1))]

    batch = slack.poll({CHANNEL: {"ts": ts(2), "threads": {ts(1): ts(10)}}}, [CHANNEL], 0)

    assert [m.text for m in batch.messages] == ["suite"]
    assert batch.cursor[CHANNEL]["threads"] == {ts(1): ts(20)}


def test_a_reply_also_sent_to_the_channel_is_one_message(slack, api):
    broadcast = msg(ts(20), "aussi ici", thread_ts=ts(1), subtype="thread_broadcast")
    api.history[CHANNEL] = [msg(ts(1), "le bug"), broadcast]
    api.replies[(CHANNEL, ts(1))] = [broadcast]

    batch = slack.poll({CHANNEL: {"ts": ts(0), "threads": {}}}, [CHANNEL], 0, threads={CHANNEL: [ts(1)]})

    assert [(m.text, m.thread_of) for m in batch.messages] == [("le bug", None), ("aussi ici", ts(1))]


def test_each_author_is_asked_once_per_poll(slack, api):
    api.history[CHANNEL] = [msg(ts(1), "a"), msg(ts(2), "b"), msg(ts(3), "c")]

    slack.poll(None, [CHANNEL], 0)

    assert len(api.of("users.info")) == 1


def test_two_chats_keep_their_own_cursors(slack, api):
    api.history[CHANNEL] = [msg(ts(1), "ici")]
    api.history["G0OTHER"] = [msg(ts(2), "là")]
    cursor = {"G0OTHER": {"ts": ts(0), "threads": {}}}

    batch = slack.poll(cursor, [CHANNEL], 0)

    assert [m.text for m in batch.messages] == ["ici"]
    assert batch.cursor == {"G0OTHER": {"ts": ts(0), "threads": {}}, CHANNEL: {"ts": ts(1), "threads": {}}}


def test_a_poll_of_no_chat_lists_the_channels_the_bot_is_in(slack, api):
    api.answers["users.conversations"] = [
        {"ok": True, "channels": [{"id": CHANNEL, "name": "demo-bugs", "is_private": False}], "response_metadata": {"next_cursor": "n"}},
        {"ok": True, "channels": [{"id": "G0PRIV", "name": "secret-bugs", "is_private": True}]},
    ]

    batch = slack.poll(None, [], 0)

    assert batch.chats == {
        CHANNEL: {"id": CHANNEL, "title": "demo-bugs", "type": "public_channel"},
        "G0PRIV": {"id": "G0PRIV", "title": "secret-bugs", "type": "private_channel"},
    }
    assert batch.messages == [] and batch.cursor == {}
    assert api.of("users.conversations")[0] == {"types": "public_channel,private_channel", "exclude_archived": "true", "limit": "200"}


@pytest.mark.parametrize("error", ["thread_not_found", "message_not_found"])
def test_a_thread_whose_parent_is_gone_is_dropped_and_the_poll_goes_on(slack, api, error):
    api.history[CHANNEL] = [msg(ts(5), "nouveau")]
    api.answers["conversations.replies"] = {"ok": False, "error": error}
    cursor = {CHANNEL: {"ts": ts(2), "threads": {ts(1): ts(3)}}}

    batch = slack.poll(cursor, [CHANNEL], 0, threads={CHANNEL: [ts(1)]})

    assert [m.text for m in batch.messages] == ["nouveau"]
    assert batch.cursor[CHANNEL]["ts"] == ts(5) and ts(1) not in batch.cursor[CHANNEL]["threads"]


def test_any_other_refusal_of_a_thread_still_fails_the_poll(slack, api):
    api.answers["conversations.replies"] = {"ok": False, "error": "channel_not_found"}

    with pytest.raises(BugsError, match="conversations.replies: channel_not_found"):
        slack.poll({CHANNEL: {"ts": ts(2), "threads": {}}}, [CHANNEL], 0, threads={CHANNEL: [ts(1)]})


def test_threads_are_read_at_most_once_a_minute_and_history_every_round(api):
    from bugs_bot.slack_inbound import THREADS_EVERY

    at = [NOW]
    slack = SlackChannel(SLACK_TOKEN, api, ROOT, clock=lambda: at[0])
    api.history[CHANNEL] = [msg(ts(1), "le bug"), msg(ts(2), "un autre")]
    listed = {CHANNEL: [ts(1), ts(2)]}
    cursor = slack.poll({CHANNEL: {"ts": ts(0), "threads": {}}}, [CHANNEL], 0, threads=listed).cursor
    api.replies[(CHANNEL, ts(1))] = [msg(ts(30), "oui c'est mieux", thread_ts=ts(1))]

    at[0] = NOW + 10
    second = slack.poll(cursor, [CHANNEL], 0, threads=listed)
    at[0] = NOW + THREADS_EVERY
    third = slack.poll(second.cursor, [CHANNEL], 0, threads=listed)

    assert len(api.of("conversations.history")) == 3
    assert [r["ts"] for r in api.of("conversations.replies")] == [ts(1), ts(2), ts(1), ts(2)]  # none in the second round
    assert second.messages == [] and second.cursor[CHANNEL]["threads"] == {ts(1): ts(1), ts(2): ts(2)}
    assert [(m.text, m.thread_of) for m in third.messages] == [("oui c'est mieux", ts(1))]
    assert third.cursor[CHANNEL]["threads"][ts(1)] == ts(30) and third.cursor[CHANNEL]["threads_read"] == NOW + THREADS_EVERY


def test_a_member_users_info_refuses_is_named_by_id_and_the_poll_goes_on(slack, api):
    api.history[CHANNEL] = [msg(ts(1), "qui suis-je", "U0GHOST"), msg(ts(2), "encore moi", "U0GHOST"), msg(ts(3), "moi c'est Ana")]

    batch = slack.poll(None, [CHANNEL], 0)

    assert [(m.text, m.author.name) for m in batch.messages] == [("qui suis-je", "U0GHOST"), ("encore moi", "U0GHOST"), ("moi c'est Ana", "Ana")]
    assert batch.messages[0].author == Author(id="U0GHOST", username="U0GHOST", name="U0GHOST", language=None, is_bot=False)
    assert sorted(call["user"] for call in api.of("users.info")) == ["U0ANA", "U0GHOST"]  # the fallback is kept as any author


def test_a_rate_limited_users_info_still_fails_the_poll(slack, api):
    api.history[CHANNEL] = [msg(ts(1), "bonjour")]
    api.statuses["users.info"] = (429, {"Retry-After": "3"})

    with pytest.raises(RateLimited):
        slack.poll(None, [CHANNEL], 0)


# -- redirects ------------------------------------------------------------------------------------------


@pytest.fixture
def redirecting():
    """A loopback server answering 302 to ``/file``, toward ``/elsewhere``; every path asked recorded."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    asked: list[tuple[str, str | None]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - http.server's name
            asked.append((self.path, self.headers.get("Authorization")))
            if self.path == "/file":
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/elsewhere")
                self.end_headers()
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"landed")

        def log_message(self, *_):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}", asked
    server.shutdown()
    server.server_close()
    thread.join()


def test_the_transport_follows_no_redirect_with_a_credential_in_the_headers(redirecting):
    from bugs_bot.channels import http_transport

    root, asked = redirecting

    status, _ = http_transport(f"{root}/file", None, None, AUTH)

    assert status == 302 and asked == [("/file", f"Bearer {SLACK_TOKEN}")]


def test_the_transport_still_follows_a_redirect_of_a_request_without_one(redirecting):
    from bugs_bot.channels import http_transport

    root, asked = redirecting

    assert http_transport(f"{root}/file") == (200, b"landed") and [path for path, _ in asked] == ["/file", "/elsewhere"]


def test_a_redirected_download_is_an_error_without_the_token(redirecting):
    from bugs_bot.channels import http_transport

    root, asked = redirecting
    slack = SlackChannel(SLACK_TOKEN, http_transport, root)

    with pytest.raises(BugsError) as caught:
        slack.get_file(f"{root}/file")

    assert "download of a Slack file: HTTP 302" in str(caught.value) and SLACK_TOKEN not in str(caught.value)
    assert [path for path, _ in asked] == ["/file"]


def test_a_redirect_answered_by_the_transport_is_never_followed_by_the_channel(api):
    calls = []

    def transport(url, payload=None, timeout=None, headers=None):
        calls.append(url)
        return 302, Body(b"", {"Location": "https://elsewhere.example/x"})

    slack = SlackChannel(SLACK_TOKEN, transport, ROOT)
    with pytest.raises(BugsError) as caught:
        slack.get_file("https://files.slack.com/F1/a.png")

    assert calls == ["https://files.slack.com/F1/a.png"] and SLACK_TOKEN not in str(caught.value)
    with pytest.raises(BugsError, match=r"^chat\.postMessage: HTTP 302") as posted:
        slack.send(CHANNEL, "x")
    assert SLACK_TOKEN not in str(posted.value)
