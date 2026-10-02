"""Screenshots to reporters: the checks before anything is sent, each channel's wire, the record of what was sent."""

from __future__ import annotations

import json
import socket
from pathlib import Path

import pytest
from fake_slack import CHANNEL, SLACK_TOKEN, FakeSlack, ts
from samples import BASE_DATE, GROUP_ID, TOKEN, FakeTelegram, parse_multipart
from test_lock import LockProbe, lock_is_free
from test_mention import DOCS, STAMP, write_report

from bugs_bot import reports
from bugs_bot.channel import ImagesNotSent, SentImages, multipart
from bugs_bot.errors import BugsError
from bugs_bot.images import MAX_BYTES, MAX_IMAGES, check_images, record_sent
from bugs_bot.slack import SlackChannel
from bugs_bot.store import Store
from bugs_bot.telegram import TelegramChannel

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16
WEBP = b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"\x00" * 8


def image(where: Path, name: str, data: bytes = PNG) -> str:
    """Write an image file named ``name`` under ``where``; return its path as the CLI receives it."""
    path = where / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return str(path)


# -- check_images: everything checked before anything is sent ---------------------------------


def test_png_jpeg_and_webp_pass_by_their_magic_bytes_whatever_their_name(tmp_path):
    paths = [image(tmp_path, "a.png"), image(tmp_path, "photo sans extension", JPEG), image(tmp_path, "c.bin", WEBP)]

    assert check_images(paths) == [Path(p).resolve() for p in paths]


@pytest.mark.parametrize(
    "make, said",
    [
        (lambda d: str(d / "absent.png"), "no such file"),
        (lambda d: image(d, "notes.png", b"just some text, not an image"), "not a PNG, JPEG or WebP image"),
        (lambda d: image(d, "big.png", PNG + b"\x00" * MAX_BYTES), "over 10 MB"),
        (lambda d: str(d), "no such file"),
    ],
    ids=["missing", "not-an-image", "too-big", "a-directory"],
)
def test_a_bad_image_is_refused_and_named(tmp_path, make, said):
    good, bad = image(tmp_path, "ok.png"), make(tmp_path)

    with pytest.raises(BugsError, match=said) as refused:
        check_images([good, bad])

    assert Path(bad).name in str(refused.value)


def test_more_than_ten_images_are_refused(tmp_path):
    paths = [image(tmp_path, f"{k}.png") for k in range(MAX_IMAGES + 1)]

    with pytest.raises(BugsError, match="at most 10 images"):
        check_images(paths)


def test_ten_images_pass(tmp_path):
    assert len(check_images([image(tmp_path, f"{k}.png") for k in range(MAX_IMAGES)])) == MAX_IMAGES


# -- record_sent: what the person saw, kept beside the report ----------------------------------


def test_the_images_sent_are_copied_into_sent_named_by_reply_and_rank(tmp_path):
    report_dir = tmp_path / "inbox" / "r1"
    report_dir.mkdir(parents=True)
    files = [("image-1.png", PNG, "image/png"), ("image-2.jpg", JPEG, "image/jpeg")]

    names = record_sent(report_dir, 3, files)

    assert names == ["sent/3-1.png", "sent/3-2.jpg"]
    assert (report_dir / "sent" / "3-1.png").read_bytes() == PNG
    assert (report_dir / "sent" / "3-2.jpg").read_bytes() == JPEG


# -- Telegram: sendPhoto for one, sendMediaGroup for several, multipart read back --------------

LAURA = {"user_id": 7, "username": "laura_t", "name": "Laura"}


def telegram() -> tuple[TelegramChannel, FakeTelegram]:
    tg = FakeTelegram()
    return TelegramChannel(TOKEN, tg), tg


def test_telegram_one_image_is_a_photo_captioned_with_the_text(tmp_path):
    channel, tg = telegram()
    paths = check_images([image(tmp_path, "my shot.png")])

    sent = channel.send_images(GROUP_ID, "Voilà l'écran", paths)

    assert [url.rsplit("/", 1)[-1] for url, _ in tg.calls] == ["sendPhoto"]
    form = tg.photos[0]
    assert form["fields"] == {"chat_id": str(GROUP_ID), "caption": "Voilà l'écran"}
    assert form["files"] == {"photo": ("image-1.png", PNG, "image/png")}
    assert sent == SentImages("Voilà l'écran", [601], [], [("image-1.png", PNG, "image/png")])


def test_telegram_several_images_are_one_media_group_captioned_on_the_first(tmp_path):
    channel, tg = telegram()
    paths = check_images([image(tmp_path, "a.png"), image(tmp_path, "b", JPEG), image(tmp_path, "c", WEBP)])

    sent = channel.send_images(GROUP_ID, "Les trois étapes", paths, reply_to=55)

    form = tg.photos[0]
    assert form["method"] == "sendMediaGroup"
    assert json.loads(form["fields"]["media"]) == [
        {"type": "photo", "media": "attach://image1", "caption": "Les trois étapes"},
        {"type": "photo", "media": "attach://image2"},
        {"type": "photo", "media": "attach://image3"},
    ]
    assert json.loads(form["fields"]["reply_parameters"]) == {"message_id": 55}
    assert form["files"] == {
        "image1": ("image-1.png", PNG, "image/png"),
        "image2": ("image-2.jpg", JPEG, "image/jpeg"),
        "image3": ("image-3.webp", WEBP, "image/webp"),
    }
    assert (sent.text, sent.message_ids, sent.file_ids) == ("Les trois étapes", [610, 611, 612], [])
    assert [name for name, _, _ in sent.files] == ["image-1.png", "image-2.jpg", "image-3.webp"]


def test_telegram_threads_and_mentions_through_the_caption(tmp_path):
    channel, tg = telegram()

    sent = channel.send_images(GROUP_ID, "regarde", check_images([image(tmp_path, "a.png")]), reply_to=55, mention=LAURA)

    fields = tg.photos[0]["fields"]
    assert fields["caption"] == "@laura_t regarde"
    assert json.loads(fields["caption_entities"]) == [{"type": "mention", "offset": 0, "length": 8}]
    assert json.loads(fields["reply_parameters"]) == {"message_id": 55}
    assert sent.text == "@laura_t regarde"


def test_telegram_a_text_too_long_for_a_caption_goes_first_then_the_images_on_the_same_thread(tmp_path):
    channel, tg = telegram()
    text = "é" * 1020  # 1020 alone fits; with the mention it does not

    sent = channel.send_images(GROUP_ID, text, check_images([image(tmp_path, "a.png")]), reply_to=55, mention=LAURA)

    assert [url.rsplit("/", 1)[-1] for url, _ in tg.calls] == ["sendMessage", "sendPhoto"]
    assert tg.sent[0]["text"] == f"@laura_t {text}" and tg.sent[0]["reply_parameters"] == {"message_id": 55}
    fields = tg.photos[0]["fields"]
    assert "caption" not in fields and json.loads(fields["reply_parameters"]) == {"message_id": 55}
    assert (sent.text, sent.message_ids) == (f"@laura_t {text}", [777, 601])


def test_telegram_images_failing_after_the_text_say_the_text_alone_went_out(tmp_path):
    channel, tg = telegram()
    tg.photo_error = "Bad Request: IMAGE_PROCESS_FAILED"

    with pytest.raises(ImagesNotSent, match="IMAGE_PROCESS_FAILED") as failed:
        channel.send_images(GROUP_ID, "x" * 1100, check_images([image(tmp_path, "a.png")]))

    assert failed.value.sent == {"message_id": 777, "text": "x" * 1100}


def test_telegram_a_refused_photo_with_its_caption_posts_nothing_and_is_a_plain_error(tmp_path):
    channel, tg = telegram()
    tg.photo_error = "Bad Request: chat not found"

    with pytest.raises(BugsError, match="sendPhoto: Bad Request: chat not found") as failed:
        channel.send_images(GROUP_ID, "court", check_images([image(tmp_path, "a.png")]))

    assert not isinstance(failed.value, ImagesNotSent)
    assert TOKEN not in str(failed.value)


# -- the multipart body ------------------------------------------------------------------------


def test_a_multipart_body_reads_back_whole_with_a_filename_holding_spaces_and_quotes():
    body = multipart({"chat_id": "-100", "caption": "deux\r\nlignes « é »"}, [("photo", 'mon "écran" 1.png', PNG, "image/png")])

    form = parse_multipart(body)
    assert body.content_type.startswith("multipart/form-data; boundary=")
    assert form["fields"] == {"chat_id": "-100", "caption": "deux\r\nlignes « é »"}
    assert form["files"] == {"photo": ('mon "écran" 1.png', PNG, "image/png")}


def test_the_boundary_never_appears_inside_the_content(monkeypatch):
    import uuid

    from bugs_bot import channel as channel_module

    drawn = iter([uuid.UUID(int=1), uuid.UUID(int=2)])
    monkeypatch.setattr(channel_module.uuid, "uuid4", lambda: next(drawn))
    clash = uuid.UUID(int=1).hex.encode()

    body = multipart({}, [("photo", "a.png", b"before " + clash + b" after", "image/png")])

    assert uuid.UUID(int=2).hex in body.content_type


def test_the_http_transport_sends_an_upload_as_its_bytes_and_content_type(monkeypatch):
    from bugs_bot import channels

    seen = {}

    class Answer:
        status = 200
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return b'{"ok": true}'

    def open_(request, timeout):
        seen.update(data=request.data, type=request.get_header("Content-type"), auth=request.get_header("Authorization"))
        return Answer()

    # The transport's own opener (it follows no redirect carrying a credential): nothing reaches the network.
    monkeypatch.setattr(channels._OPENER, "open", open_)
    body = multipart({"chat_id": "1"}, [("photo", "image-1.png", PNG, "image/png")])

    status, _ = channels.http_transport("https://example.invalid/up", body, None, {"Authorization": "Bearer x"})

    assert status == 200
    assert (seen["data"], seen["type"], seen["auth"]) == (body.data, body.content_type, "Bearer x")


# -- Slack: files.getUploadURLExternal and the upload per file, then one files.completeUploadExternal


def slack() -> tuple[SlackChannel, FakeSlack]:
    api = FakeSlack()
    return SlackChannel(SLACK_TOKEN, api), api


def test_slack_uploads_each_image_then_shares_them_all_in_one_message(tmp_path):
    channel, api = slack()
    paths = check_images([image(tmp_path, "a shot.png"), image(tmp_path, "b", JPEG)])

    sent = channel.send_images(CHANNEL, "Voilà les deux écrans", paths)

    assert api.methods() == ["files.getUploadURLExternal", "ticket1", "files.getUploadURLExternal", "ticket2", "files.completeUploadExternal"]
    assert api.of("files.getUploadURLExternal") == [{"filename": "image-1.png", "length": str(len(PNG))}, {"filename": "image-2.jpg", "length": str(len(JPEG))}]
    assert [parse_multipart(upload["body"])["files"] for upload in api.uploads] == [
        {"filename": ("image-1.png", PNG, "image/png")},
        {"filename": ("image-2.jpg", JPEG, "image/jpeg")},
    ]
    assert api.of("files.completeUploadExternal") == [
        {"files": [{"id": "F0FILE1", "title": "image-1.png"}, {"id": "F0FILE2", "title": "image-2.jpg"}],
         "channel_id": CHANNEL, "initial_comment": "Voilà les deux écrans"}
    ]
    assert all(call["headers"] == {"Authorization": f"Bearer {SLACK_TOKEN}"} for call in api.calls)
    assert (sent.text, sent.message_ids, sent.file_ids) == ("Voilà les deux écrans", [], ["F0FILE1", "F0FILE2"])
    assert sent.files == [("image-1.png", PNG, "image/png"), ("image-2.jpg", JPEG, "image/jpeg")]


def test_slack_posts_the_images_in_the_reports_thread_with_the_mention(tmp_path):
    channel, api = slack()

    sent = channel.send_images(CHANNEL, "regarde", check_images([image(tmp_path, "a.png")]), reply_to=ts(1), mention={"user_id": "U0ANA", "username": None, "name": "Ana"})

    complete = api.of("files.completeUploadExternal")[0]
    assert (complete["thread_ts"], complete["initial_comment"]) == (ts(1), "<@U0ANA> regarde")
    assert (sent.text, sent.message_ids, sent.file_ids) == ("<@U0ANA> regarde", [], ["F0FILE1"])


def test_slack_a_failed_second_upload_shares_nothing(tmp_path):
    channel, api = slack()
    api.upload_status[2] = 500

    with pytest.raises(BugsError, match="upload of image-2.jpg: HTTP 500") as failed:
        channel.send_images(CHANNEL, "deux", check_images([image(tmp_path, "a.png"), image(tmp_path, "b", JPEG)]))

    assert "files.completeUploadExternal" not in api.methods()
    assert SLACK_TOKEN not in str(failed.value)


def test_slack_a_refused_share_is_an_error_without_the_token(tmp_path):
    channel, api = slack()
    api.answers["files.completeUploadExternal"] = {"ok": False, "error": "missing_scope"}

    with pytest.raises(BugsError, match="files.completeUploadExternal: missing_scope") as failed:
        channel.send_images(CHANNEL, "x", check_images([image(tmp_path, "a.png")]))

    assert SLACK_TOKEN not in str(failed.value)


def test_slack_never_uploads_to_a_host_that_is_not_slack(tmp_path):
    channel, api = slack()
    api.answers["files.getUploadURLExternal"] = {"ok": True, "upload_url": "https://evil.example/upload/x", "file_id": "F1"}

    with pytest.raises(BugsError, match="upload refused: the URL is not on Slack"):
        channel.send_images(CHANNEL, "x", check_images([image(tmp_path, "a.png")]))

    assert api.uploads == [] and "files.completeUploadExternal" not in api.methods()


# -- reply and post with --image: checked first, sent outside the lock, recorded after ---------

RID = f"{STAMP}-5"


def report_json(home: Path, report_id: str = RID) -> dict:
    return json.loads((home / "inbox" / report_id / "report.json").read_text())


def test_reply_with_images_threads_them_on_the_report_and_records_what_was_sent(run, bound, tmp_path, capsys):
    write_report(bound, 5, author_id=7, author_username="laura_t")
    tg = FakeTelegram()
    shots = [image(tmp_path, "shots/étape 1.png"), image(tmp_path, "shots/étape 2", JPEG)]

    assert run("reply", RID, "Voilà où appuyer", "--image", shots[0], "--image", shots[1], "--mention", transport=tg, now=BASE_DATE) == 0

    form = tg.photos[0]
    assert form["method"] == "sendMediaGroup" and json.loads(form["fields"]["reply_parameters"]) == {"message_id": 5}
    assert json.loads(form["fields"]["media"])[0]["caption"] == "@laura_t Voilà où appuyer"
    reply = report_json(bound)["replies"][0]
    assert reply == {"date": "2026-10-02T08:30:00+00:00", "text": "@laura_t Voilà où appuyer", "message_id": 610, "message_ids": [610, 611],
                     "images": ["sent/1-1.png", "sent/1-2.jpg"]}
    assert (bound / "inbox" / RID / "sent" / "1-2.jpg").read_bytes() == JPEG
    capsys.readouterr()
    assert run("show", RID) == 0
    shown = capsys.readouterr().out
    assert f"  {(bound / 'inbox' / RID / 'sent' / '1-1.png').resolve()}" in shown.splitlines()


def test_a_bad_image_among_good_ones_sends_nothing_and_records_nothing(run, bound, tmp_path, capsys):
    write_report(bound, 5)
    before = report_json(bound)
    tg = FakeTelegram()
    good, bad = image(tmp_path, "ok.png"), image(tmp_path, "notes.png", b"plain text")

    code = run("reply", RID, "regarde", "--image", good, "--image", bad, transport=tg, now=BASE_DATE)

    assert tg.calls == [], "something went out before every image was checked"
    assert code == 1
    assert report_json(bound) == before
    assert "not a PNG, JPEG or WebP image" in capsys.readouterr().err


def test_images_failing_after_a_long_text_record_the_text_alone(run, bound, tmp_path, capsys):
    write_report(bound, 5)
    tg = FakeTelegram()
    tg.photo_error = "Bad Request: IMAGE_PROCESS_FAILED"

    assert run("reply", RID, "x" * 1100, "--image", image(tmp_path, "a.png"), "--awaits", transport=tg, now=BASE_DATE) == 1

    after = report_json(bound)
    assert not (bound / "inbox" / RID / "sent").exists(), "images that never went out were recorded as sent"
    assert after["replies"] == [{"date": "2026-10-02T08:30:00+00:00", "text": "x" * 1100, "message_id": 777}]
    assert "awaiting" not in after, "a question whose images never went out does not wait"
    assert "the text was posted alone, not the images" in capsys.readouterr().err


def test_awaits_with_images_waits_on_that_reply(run, bound, tmp_path):
    write_report(bound, 5)

    assert run("reply", RID, "C'est bien cet écran ?", "--image", image(tmp_path, "a.png"), "--awaits", now=BASE_DATE) == 0

    assert report_json(bound)["awaiting"] == {"since": "2026-10-02T08:30:00+00:00", "reply": 1}


def test_a_question_that_would_be_queued_is_refused_with_its_images(run, bound, tmp_path, capsys):
    write_report(bound, 5, author_id=7)
    write_report(bound, 6, author_id=7)
    assert run("reply", RID, "Tu es sur quel iPhone ?", "--awaits", now=BASE_DATE) == 0
    tg = FakeTelegram()

    assert run("reply", f"{STAMP}-6", "Et là ?", "--awaits", "--image", image(tmp_path, "a.png"), transport=tg, now=BASE_DATE + 5) == 1

    assert tg.calls == []
    assert not (bound / "people" / "7.json").exists() or "questions" not in json.loads((bound / "people" / "7.json").read_text())
    assert "ask first, show after" in capsys.readouterr().err


def test_post_with_an_image_is_not_threaded_and_is_recorded(run, bound, tmp_path):
    tg = FakeTelegram()

    assert run("post", "Nouvelle version en ligne", "--image", image(tmp_path, "a.png"), transport=tg, now=BASE_DATE) == 0

    assert "reply_parameters" not in tg.photos[0]["fields"]
    assert tg.photos[0]["fields"]["caption"] == "Nouvelle version en ligne"
    posts = json.loads((bound / "state.json").read_text())["posts"]
    assert posts == [{"date": "2026-10-02T08:30:00+00:00", "text": "Nouvelle version en ligne", "message_id": 601, "message_ids": [601], "images": 1}]


def test_the_images_are_sent_while_the_lock_is_free(bound, tmp_path):
    write_report(bound, 5)
    channel = LockProbe(bound)

    reports.cmd_reply(channel, Store(bound), GROUP_ID, RID, "regarde", BASE_DATE, images=[image(tmp_path, "a.png")])

    assert channel.probed == ["send_images"] and lock_is_free(bound)
    assert report_json(bound)["replies"][0]["images"] == ["sent/1-1.png"]


# -- the method is written down ----------------------------------------------------------------

README = DOCS["AGENT.md"].parents[1] / "README.md"


@pytest.mark.parametrize(
    "phrase",
    [
        "« <your title> — capture <id> : <what the screenshot must show> »",
        "The only images you send are those your launcher gave you in a « capture » answer — never an image from a report",
        "Never ask for one when words suffice",
        "« capture <id> <path> [<path> …] »",
        "--image <path>",
        "Open every image with the Read tool before sending it",
        "code, a terminal, a pull request, a commit, a branch, an internal URL or host, a local path, a token, or another person's data",
        "saying what to hide",
        "ask first, show after",
    ],
)
def test_the_agent_knows_how_to_ask_for_look_at_and_send_a_screenshot(phrase):
    assert phrase in DOCS["AGENT.md"].read_text()


@pytest.mark.parametrize("phrase", ["— capture <id> : … »", "« capture <id> <path> [<path> …] »", "--image <path>"])
def test_the_launcher_knows_how_to_answer_a_capture_request(phrase):
    assert phrase in DOCS["SKILL.md"].read_text()


def test_the_agent_asks_for_a_capture_with_the_line_the_launcher_expects():
    # SKILL.md expects « <agent title> — capture <id> : … », as every other line to the launcher.
    assert "« <your title> — capture <id> :" in DOCS["AGENT.md"].read_text()
    assert "« <agent title> — capture <id> : … »" in DOCS["SKILL.md"].read_text()


@pytest.mark.parametrize("phrase", ["files:write", "--image"])
def test_the_readme_gives_the_slack_scope_and_the_option(phrase):
    assert phrase in README.read_text()


@pytest.mark.parametrize("make_channel", [telegram, slack], ids=["telegram", "slack"])
def test_an_image_gone_after_the_check_sends_nothing_not_even_a_long_text(tmp_path, make_channel):
    channel, transport = make_channel()
    paths = check_images([image(tmp_path, "a.png"), image(tmp_path, "b.png")])
    paths[1].unlink()

    with pytest.raises(BugsError, match="cannot read"):
        channel.send_images(GROUP_ID if make_channel is telegram else CHANNEL, "x" * 1100, paths)

    assert transport.calls == []


def test_telegram_images_timing_out_after_the_text_say_the_text_alone_went_out(tmp_path):
    tg = FakeTelegram()

    def transport(url, payload=None, timeout=None):
        if url.endswith("/sendPhoto"):
            raise socket.timeout("timed out")
        return tg(url, payload)

    channel = TelegramChannel(TOKEN, transport)

    with pytest.raises(ImagesNotSent, match="timed out") as failed:
        channel.send_images(GROUP_ID, "x" * 1100, check_images([image(tmp_path, "a.png")]))

    assert failed.value.sent == {"message_id": 777, "text": "x" * 1100}


def test_telegram_a_photo_timing_out_with_its_caption_posts_nothing_and_stays_a_transport_error(tmp_path):
    def transport(url, payload=None, timeout=None):
        raise socket.timeout("timed out")

    with pytest.raises(socket.timeout):
        TelegramChannel(TOKEN, transport).send_images(GROUP_ID, "court", check_images([image(tmp_path, "a.png")]))


@pytest.mark.parametrize("where", ["/upload/", "files.completeUploadExternal"])
def test_slack_a_share_timing_out_is_a_plain_error_nothing_was_posted_before_it(tmp_path, where):
    api = FakeSlack()

    def transport(url, payload=None, timeout=None, headers=None):
        if where in url:
            raise socket.timeout("timed out")
        return api(url, payload, timeout, headers)

    with pytest.raises(socket.timeout):
        SlackChannel(SLACK_TOKEN, transport).send_images(CHANNEL, "x" * 1100, check_images([image(tmp_path, "a.png")]))

    assert "chat.postMessage" not in api.methods()


# -- the caption is counted as Telegram counts it: UTF-16 code units, the mention included -----


def test_telegram_a_caption_of_astral_characters_too_long_in_utf16_goes_as_text_first(tmp_path):
    channel, tg = telegram()
    text = "😀" * 600  # 600 characters, 1200 UTF-16 units

    channel.send_images(GROUP_ID, text, check_images([image(tmp_path, "a.png")]))

    assert [url.rsplit("/", 1)[-1] for url, _ in tg.calls] == ["sendMessage", "sendPhoto"]


def test_telegram_a_caption_of_exactly_1024_utf16_units_with_its_mention_stays_a_caption(tmp_path):
    channel, tg = telegram()
    text = "😀" * 507 + "é" * 1  # "@laura_t " is 9 units: 9 + 1014 + 1 = 1024

    channel.send_images(GROUP_ID, text, check_images([image(tmp_path, "a.png")]), mention=LAURA)

    assert [url.rsplit("/", 1)[-1] for url, _ in tg.calls] == ["sendPhoto"]
    assert tg.photos[0]["fields"]["caption"] == f"@laura_t {text}"


# -- an image changed between the check and the send -------------------------------------------


@pytest.mark.parametrize("make_channel", [telegram, slack], ids=["telegram", "slack"])
def test_an_image_no_longer_an_image_after_the_check_sends_nothing_not_even_a_long_text(tmp_path, make_channel):
    channel, transport = make_channel()
    paths = check_images([image(tmp_path, "a.png"), image(tmp_path, "b.png")])
    paths[1].write_bytes(b"hello")

    with pytest.raises(BugsError, match="no longer a PNG, JPEG or WebP image"):
        channel.send_images(GROUP_ID if make_channel is telegram else CHANNEL, "x" * 1100, paths)

    assert transport.calls == []
