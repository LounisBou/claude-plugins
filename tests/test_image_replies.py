"""A message with images once posted, from the command line: what it records, how it is deleted, why it is not edited."""

from __future__ import annotations

import json
import socket
from pathlib import Path

import pytest
from conftest import register
from fake_slack import CHANNEL, SLACK_TOKEN, FakeSlack, ts
from samples import BASE_DATE, TOKEN, FakeTelegram
from test_mention import STAMP, write_report

from bugs_bot import cli

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16
RID = f"{STAMP}-5"


def image(where: Path, name: str, data: bytes = PNG) -> str:
    path = where / name
    path.write_bytes(data)
    return str(path)


def report_json(home: Path) -> dict:
    return json.loads((home / "inbox" / RID / "report.json").read_text())


def methods(tg: FakeTelegram) -> list[str]:
    return [url.rsplit("/", 1)[-1] for url, _ in tg.calls]


class OnImages:
    """A Telegram transport that runs ``action`` when an image call comes: it answers first, or raises ``fail``."""

    def __init__(self, tg: FakeTelegram, action=None, fail: Exception | None = None) -> None:
        self.tg, self.action, self.fail = tg, action, fail

    def __call__(self, url: str, payload=None, timeout=None):
        if url.endswith(("/sendPhoto", "/sendMediaGroup")):
            if self.fail is not None:
                self.tg.calls.append((url, payload))
                raise self.fail
            answer = self.tg(url, payload)
            self.action()
            return answer
        return self.tg(url, payload) if timeout is None else self.tg(url, payload, timeout)


# -- what is recorded is what was sent ------------------------------------------------------------


def test_a_source_image_deleted_once_sent_leaves_the_reply_recorded_with_its_image(run, bound, tmp_path):
    write_report(bound, 5)
    shot = Path(image(tmp_path, "a.png"))

    assert run("reply", RID, "regarde", "--image", str(shot), transport=OnImages(FakeTelegram(), shot.unlink), now=BASE_DATE) == 0

    reply = report_json(bound)["replies"][0]
    assert reply["images"] == ["sent/1-1.png"]
    assert (bound / "inbox" / RID / "sent" / "1-1.png").read_bytes() == PNG


def test_a_source_image_rewritten_once_sent_leaves_the_bytes_sent_in_sent(run, bound, tmp_path):
    write_report(bound, 5)
    shot = Path(image(tmp_path, "a.png"))
    tg = FakeTelegram()

    assert run("reply", RID, "regarde", "--image", str(shot), transport=OnImages(tg, lambda: shot.write_bytes(JPEG)), now=BASE_DATE) == 0

    assert tg.photos[0]["files"]["photo"][1] == PNG
    assert (bound / "inbox" / RID / "sent" / "1-1.png").read_bytes() == PNG
    assert report_json(bound)["replies"][0]["images"] == ["sent/1-1.png"]


# -- a text posted alone stays recorded, whatever stopped the images ------------------------------


def test_telegram_images_timing_out_after_a_long_text_record_the_text_alone(run, bound, tmp_path, capsys):
    write_report(bound, 5)
    tg = FakeTelegram()

    code = run("reply", RID, "x" * 1100, "--image", image(tmp_path, "a.png"), transport=OnImages(tg, fail=socket.timeout("timed out")), now=BASE_DATE)

    assert code == 1
    assert report_json(bound)["replies"] == [{"date": "2026-10-02T08:30:00+00:00", "text": "x" * 1100, "message_id": 777}]
    assert not (bound / "inbox" / RID / "sent").exists()
    assert "the text was posted alone, not the images: timed out" in capsys.readouterr().err


def test_a_post_whose_images_fail_after_its_text_records_the_text_then_fails(run, bound, tmp_path, capsys):
    tg = FakeTelegram()
    tg.photo_error = "Bad Request: IMAGE_PROCESS_FAILED"

    assert run("post", "y" * 1100, "--image", image(tmp_path, "a.png"), transport=tg, now=BASE_DATE) == 1

    posts = json.loads((bound / "state.json").read_text())["posts"]
    assert posts == [{"date": "2026-10-02T08:30:00+00:00", "text": "y" * 1100, "message_id": 777}]
    err = capsys.readouterr()
    assert "the text was posted alone, not the images: sendPhoto: Bad Request: IMAGE_PROCESS_FAILED" in err.err
    assert "posted message" not in err.out


# -- Telegram: a media group is every one of its messages ----------------------------------------


def test_a_two_image_reply_is_deleted_message_by_message(run, bound, tmp_path, capsys):
    write_report(bound, 5)
    tg = FakeTelegram()
    assert run("reply", RID, "les deux", "--image", image(tmp_path, "a.png"), "--image", image(tmp_path, "b.jpg", JPEG), transport=tg, now=BASE_DATE) == 0
    assert report_json(bound)["replies"][0]["message_ids"] == [610, 611]

    assert run("delete", RID, transport=tg, now=BASE_DATE + 60) == 0

    deleted = [payload for url, payload in tg.calls if url.endswith("/deleteMessage")]
    assert [payload["message_id"] for payload in deleted] == [610, 611]
    assert report_json(bound)["replies"][0]["deleted"]
    assert f"deleted reply 1 of {RID}" in capsys.readouterr().out


def test_an_image_reply_is_never_edited(run, bound, tmp_path, capsys):
    write_report(bound, 5)
    tg = FakeTelegram()
    assert run("reply", RID, "regarde", "--image", image(tmp_path, "a.png"), transport=tg, now=BASE_DATE) == 0
    before = report_json(bound)
    calls = len(tg.calls)

    assert run("edit", RID, "autre texte", transport=tg, now=BASE_DATE + 60) == 1

    assert tg.calls[calls:] == [], "an image reply was edited"
    assert report_json(bound) == before
    assert "an image reply can only be deleted" in capsys.readouterr().err


# -- Slack: a share is named by its files ---------------------------------------------------------


@pytest.fixture
def slack_env(tmp_path: Path, bugs_home: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """A Slack project ``sla`` holding report ``RID`` (its first message ``ts(1)``), worked from its repository."""
    env_file = tmp_path / ".env"
    env_file.write_text(f"TELEGRAM_BOT_TOKEN={TOKEN}\nSLACK_BOT_TOKEN={SLACK_TOKEN}\n")
    monkeypatch.chdir(register(bugs_home, tmp_path / "repo-sla", "sla", CHANNEL, "sla-bugs", channel="slack"))
    (bugs_home / "sla").mkdir(exist_ok=True)
    write_report(bugs_home / "sla", 5, chat_id=CHANNEL, message_ids=[ts(1)])
    return {"BUGS_BOT_ENV_FILE": str(env_file), "BUGS_BOT_HOME": str(bugs_home)}


def slack_cli(env: dict[str, str], api, *argv: str) -> int:
    return cli.main(list(argv), transport=api, env=env, now=BASE_DATE)


def test_a_slack_image_reply_records_its_files_and_is_deleted_file_by_file(slack_env, bugs_home, tmp_path):
    api = FakeSlack()
    shots = ["--image", image(tmp_path, "a.png"), "--image", image(tmp_path, "b.jpg", JPEG)]
    assert slack_cli(slack_env, api, "reply", RID, "les deux", *shots) == 0

    reply = report_json(bugs_home / "sla")["replies"][0]
    assert reply["file_ids"] == ["F0FILE1", "F0FILE2"] and reply.get("message_id") is None
    assert slack_cli(slack_env, api, "delete", RID) == 0

    assert api.of("files.delete") == [{"file": "F0FILE1"}, {"file": "F0FILE2"}]
    assert "chat.delete" not in api.methods()
    assert report_json(bugs_home / "sla")["replies"][0]["deleted"]


def test_a_slack_image_reply_is_never_edited(slack_env, bugs_home, tmp_path, capsys):
    api = FakeSlack()
    assert slack_cli(slack_env, api, "reply", RID, "regarde", "--image", image(tmp_path, "a.png")) == 0
    calls = len(api.calls)

    assert slack_cli(slack_env, api, "edit", RID, "autre texte") == 1

    assert api.calls[calls:] == []
    assert "an image reply can only be deleted" in capsys.readouterr().err


def test_a_slack_post_with_images_prints_and_records_its_files(slack_env, bugs_home, tmp_path, capsys):
    api = FakeSlack()

    assert slack_cli(slack_env, api, "post", "Nouvelle version", "--image", image(tmp_path, "a.png"), "--image", image(tmp_path, "b.jpg", JPEG)) == 0

    out = capsys.readouterr().out
    assert "posted files F0FILE1 F0FILE2" in out and "None" not in out
    posts = json.loads((bugs_home / "sla" / "state.json").read_text())["posts"]
    assert posts == [{"date": "2026-10-02T08:30:00+00:00", "text": "Nouvelle version", "file_ids": ["F0FILE1", "F0FILE2"], "images": 2}]


@pytest.mark.parametrize("where", ["upload", "files.completeUploadExternal"])
def test_a_slack_share_timing_out_records_nothing_and_is_a_plain_error(slack_env, bugs_home, tmp_path, capsys, where):
    api = FakeSlack()

    def transport(url, payload=None, timeout=None, headers=None):
        if ("/upload/" in url) if where == "upload" else url.endswith(f"/{where}"):
            raise socket.timeout("timed out")
        return api(url, payload, timeout, headers)

    assert cli.main(["reply", RID, "x" * 1100, "--image", image(tmp_path, "a.png")], transport=transport, env=slack_env, now=BASE_DATE) == 1

    assert report_json(bugs_home / "sla")["replies"] == []
    assert "posted alone" not in capsys.readouterr().err
