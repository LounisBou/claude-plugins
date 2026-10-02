"""Golden test: one recorded ``getUpdates`` batch through ``pull`` writes exactly the files it always wrote.

Every file of the bugs home and of the project files, what the command prints, and every request sent
to the Bot API are compared byte for byte with ``tests/golden/``. The batch mixes what Pull meets: two
projects, an unregistered chat, a photo, an image document, a media group, a bot post, service
messages, a group promoted to supergroup, an answer to an awaited question, a pending reaction and a
report past retention.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import register
from samples import BASE_DATE, GROUP_ID, OTHER_GROUP_ID, FakeTelegram, message

from bugs_bot import cli

GOLDEN = Path(__file__).resolve().parent / "golden"
FAMILY_ID = -1007777777777
OLD_ID = -555
PROMOTED_ID = -1005555555555
NOW = BASE_DATE + 3600


def recorded_batch() -> list[dict]:
    """Return the batch: every kind of update Pull meets, in Telegram's order."""
    photo = message(11, 101, caption="l'écran figé", photo="p1")
    album = [
        message(12, 102, caption="trois captures", photo="g1", media_group_id="album-1"),
        message(13, 103, photo="g2", media_group_id="album-1"),
        message(
            14,
            104,
            media_group_id="album-1",
            document={"file_id": "doc-g3", "file_name": "Capture.PNG", "mime_type": "image/png"},
        ),
    ]
    bot_post = message(15, 105, text="Comment signaler un bug")
    bot_post["message"]["from"] = {"id": 8, "is_bot": True, "first_name": "Clawdbot", "username": "ClawBot"}
    service = message(16, 106)
    service["message"]["new_chat_title"] = "TM Bugs 2"
    other = message(17, 201, chat_id=OTHER_GROUP_ID, title="Other Bugs", text="un autre projet")
    other["message"]["from"] = {"id": 77, "is_bot": False, "first_name": "Zoé", "language_code": "fr"}
    pdf = message(
        18,
        202,
        chat_id=OTHER_GROUP_ID,
        title="Other Bugs",
        caption="le journal",
        document={"file_id": "pdf-1", "file_name": "log.pdf", "mime_type": "application/pdf"},
    )
    stranger = message(19, 301, chat_id=FAMILY_ID, title="Famille", text="coucou")
    joined = {
        "update_id": 20,
        "my_chat_member": {
            "chat": {"id": -1004444444444, "title": "Nouveau", "type": "supergroup"},
            "from": {"id": 42, "is_bot": False, "first_name": "Izno"},
            "date": BASE_DATE,
        },
    }
    before = message(21, 401, chat_id=OLD_ID, title="Mig", chat_type="group", text="avant la promotion")
    promoted = message(22, 402, chat_id=OLD_ID, title="Mig", chat_type="group")
    promoted["message"]["migrate_to_chat_id"] = PROMOTED_ID
    arrived = message(23, 1, chat_id=PROMOTED_ID, title="Mig")
    arrived["message"]["migrate_from_chat_id"] = OLD_ID
    after = message(24, 2, chat_id=PROMOTED_ID, title="Mig", text="après la promotion", date=BASE_DATE + 60)
    answer = message(10, 100, text="oui, c'est réparé", date=BASE_DATE + 30)
    return [answer, photo, *album, bot_post, service, other, pdf, stranger, joined, before, promoted, arrived, after]


def seed(tmp_path: Path, bugs_home: Path) -> None:
    """Register three projects and leave the demo inbox as an earlier run would have."""
    register(bugs_home, tmp_path / "repo-demo", "demo", GROUP_ID, "Demo Bugs")
    register(bugs_home, tmp_path / "repo-other", "other", OTHER_GROUP_ID, "Other Bugs")
    register(bugs_home, tmp_path / "repo-mig", "mig", OLD_ID, "Mig Bugs")
    inbox = bugs_home / "demo" / "inbox"
    base = {
        "chat_id": GROUP_ID,
        "media_group_id": None,
        "author": "izno_op",
        "author_id": 42,
        "author_username": "izno_op",
        "images": [],
        "replies": [],
    }
    earlier = {
        "id": "20261001-083000-50",
        "message_ids": [50],
        "date": "2026-10-01T08:30:00+00:00",
        "text": "le lecteur plante",
        "status": "taken",
        "reaction": {"wanted": "\U0001f468‍\U0001f4bb", "applied": "\U0001f440", "error": "Bad Request"},
        "awaiting": {"since": "2026-10-01T09:00:00+00:00", "reply": 1},
    }
    stale = {
        "id": "20260801-083000-10",
        "message_ids": [10],
        "date": "2026-08-01T08:30:00+00:00",
        "text": "vieux",
        "status": "done",
        "reaction": {"wanted": "\U0001f44c", "applied": "\U0001f44c", "error": None},
    }
    for report in (earlier, stale):
        (inbox / report["id"]).mkdir(parents=True)
        (inbox / report["id"] / "report.json").write_text(json.dumps(base | report, ensure_ascii=False, indent=2) + "\n")


def snapshot(tmp_path: Path, bugs_home: Path, tg: FakeTelegram, code: int, out: str, err: str) -> dict:
    """Return everything observable after the run, ``tmp_path`` replaced by ``<tmp>``."""
    files = {}
    for path in sorted([*bugs_home.rglob("*"), *tmp_path.glob("repo-*/.bugs-bot.json")]):
        if path.is_file():
            files[str(path.relative_to(tmp_path))] = path.read_bytes().decode("utf-8", "backslashreplace")
    calls = [{"url": url.rsplit("/", 1)[-1] if "/file/" not in url else url.split("/bot", 1)[-1], "payload": payload} for url, payload in tg.calls]
    result = {"exit": code, "stdout": out, "stderr": err, "files": files, "calls": calls, "timeouts": tg.timeouts}
    return json.loads(json.dumps(result, ensure_ascii=False).replace(str(tmp_path), "<tmp>"))


def run_pull(tmp_path: Path, bugs_home: Path, env: dict, capsys, fail_download: bool) -> dict:
    seed(tmp_path, bugs_home)
    tg = FakeTelegram(recorded_batch())
    tg.fail_download = fail_download
    capsys.readouterr()
    code = cli.main(["pull"], transport=tg, env=env, now=NOW)
    captured = capsys.readouterr()
    return snapshot(tmp_path, bugs_home, tg, code, captured.out, captured.err)


@pytest.mark.parametrize("name, fail_download", [("pull", False), ("pull-failed-download", True)])
def test_a_recorded_batch_writes_exactly_the_golden_files(tmp_path, bugs_home, env, capsys, name, fail_download):
    got = run_pull(tmp_path, bugs_home, env, capsys, fail_download)

    expected = json.loads((GOLDEN / f"{name}.json").read_text())
    assert got == expected
