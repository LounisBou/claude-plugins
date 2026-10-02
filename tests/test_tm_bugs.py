"""Tests for tm_bugs, on recorded-shape samples and a fake transport."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from conftest import read_offset, register, reports
from samples import BASE_DATE, GROUP_ID, OTHER_GROUP_ID, TOKEN, FakeTelegram, image_bytes, message

from bugs_bot import cli, store, telegram
from bugs_bot.registry import Registry
from bugs_bot.store import Machine

FIRST_STAMP = "20261002-083000"


def report_json(path: Path) -> dict:
    return json.loads((path / "report.json").read_text())


# -- pull ---------------------------------------------------------------------


def test_pull_text_message(run, bound, capsys):
    tg = FakeTelegram([message(10, 100, text="le bouton ne répond pas")])

    assert run("pull", transport=tg) == 0

    [rep] = reports(bound)
    assert rep.name == f"{FIRST_STAMP}-100"
    data = report_json(rep)
    assert data["text"] == "le bouton ne répond pas"
    assert data["status"] == "seen"
    assert data["message_ids"] == [100]
    assert data["author"] == "izno_op"
    assert data["replies"] == []
    assert read_offset(bound) == 11
    assert capsys.readouterr().out.count("\n") == 1


def test_pull_photo_with_caption_keeps_largest_size(run, bound):
    tg = FakeTelegram([message(10, 100, caption="écran cassé", photo="p1")])

    assert run("pull", transport=tg) == 0

    [rep] = reports(bound)
    assert report_json(rep)["text"] == "écran cassé"
    assert (rep / "1.jpg").read_bytes() == image_bytes("p1-l")


def test_pull_media_group_of_three_is_one_report(run, bound):
    tg = FakeTelegram(
        [
            message(10, 100, caption="trois vues", photo="a", media_group_id="g1"),
            message(11, 101, photo="b", media_group_id="g1"),
            message(12, 102, photo="c", media_group_id="g1"),
        ]
    )

    assert run("pull", transport=tg) == 0

    [rep] = reports(bound)
    data = report_json(rep)
    assert data["message_ids"] == [100, 101, 102]
    assert data["text"] == "trois vues"
    assert [(rep / f"{i}.jpg").read_bytes() for i in (1, 2, 3)] == [
        image_bytes("a-l"),
        image_bytes("b-l"),
        image_bytes("c-l"),
    ]


def test_pull_image_document_keeps_its_extension(run, bound):
    doc = {"file_id": "doc1", "file_name": "capture.png", "mime_type": "image/png"}
    tg = FakeTelegram([message(10, 100, document=doc)])

    assert run("pull", transport=tg) == 0

    [rep] = reports(bound)
    assert (rep / "1.png").read_bytes() == image_bytes("doc1")


def test_pull_ignores_other_chat_but_advances_offset(run, bound):
    tg = FakeTelegram([message(10, 100, chat_id=OTHER_GROUP_ID, title="Famille", text="secret")])

    assert run("pull", transport=tg) == 0

    assert reports(bound) == []
    assert read_offset(bound) == 11
    # nothing of the other chat was downloaded or stored
    assert not any("secret" in p.read_text() for p in bound.parent.rglob("*.json"))


def test_pull_with_nothing_new_says_so_in_one_line(run, bound, capsys):
    assert run("pull") == 0

    assert capsys.readouterr().out == "bugs-bot: no new report\n"


def test_pull_passes_stored_offset_and_zero_timeout(run, bound):
    Machine(bound.parent).save_offset(50)
    tg = FakeTelegram([])

    assert run("pull", transport=tg) == 0

    [payload] = tg.updates_calls()
    assert payload["offset"] == 50
    assert payload["timeout"] == 0


def test_pull_api_error_exits_non_zero_with_description(run, bound, capsys):
    tg = FakeTelegram()
    tg.api_error = {"ok": False, "error_code": 401, "description": "Unauthorized: invalid token specified"}

    assert run("pull", transport=tg) != 0

    assert "Unauthorized: invalid token specified" in capsys.readouterr().err


def test_pull_ok_false_with_http_200_is_an_error(run, bound, capsys):
    class Sloppy(FakeTelegram):
        def __call__(self, url, payload=None):
            return 200, json.dumps({"ok": False, "description": "Conflict: webhook is active"}).encode()

    assert run("pull", transport=Sloppy()) != 0

    assert "Conflict: webhook is active" in capsys.readouterr().err


def test_pull_download_failure_keeps_offset_and_writes_nothing(run, bound, capsys):
    tg = FakeTelegram(
        [
            message(10, 100, text="d'abord un texte"),
            message(11, 101, caption="puis une image", photo="p1"),
        ]
    )
    tg.fail_download = True

    assert run("pull", transport=tg) != 0

    assert read_offset(bound) is None
    # no half-written report, no leftover temporary directory
    leftovers = [p for p in reports(bound) if not (p / "report.json").exists()]
    assert leftovers == []
    assert not list((bound / "inbox").glob(".*")) if (bound / "inbox").exists() else True


def test_pull_retry_after_failure_is_complete_and_not_duplicated(run, bound):
    tg = FakeTelegram(
        [
            message(10, 100, text="d'abord un texte"),
            message(11, 101, caption="puis une image", photo="p1"),
        ]
    )
    tg.fail_download = True
    assert run("pull", transport=tg) != 0

    tg.fail_download = False
    assert run("pull", transport=tg) == 0

    names = sorted(p.name for p in reports(bound))
    assert names == [f"{FIRST_STAMP}-100", f"{FIRST_STAMP}-101"]
    assert read_offset(bound) == 12


def test_pull_with_no_project_registered_exits_zero_with_one_line(run, home, capsys):
    assert run("pull") == 0

    out = capsys.readouterr()
    assert out.out.count("\n") == 1
    assert "no project registered" in out.out
    assert not (home / "inbox").exists()


def test_pull_deletes_done_reports_older_than_30_days(run, bound):
    old = bound / "inbox" / "20260801-000000-1"
    fresh_done = bound / "inbox" / "20260925-000000-2"
    old_new = bound / "inbox" / "20260802-000000-3"
    for path, status, date in (
        (old, "done", "2026-08-01T00:00:00+00:00"),
        (fresh_done, "done", "2026-09-25T00:00:00+00:00"),
        (old_new, "new", "2026-08-02T00:00:00+00:00"),
    ):
        path.mkdir(parents=True)
        (path / "report.json").write_text(json.dumps({"status": status, "date": date}))

    assert run("pull", now=BASE_DATE) == 0

    assert not old.exists()
    assert fresh_done.exists()
    assert old_new.exists()  # never delete what was not handled


# -- secrecy ------------------------------------------------------------------


def test_token_is_masked_in_a_transport_error(run, bound, capsys):
    tg = FakeTelegram()
    tg.raise_on_call = OSError(f"<urlopen error> https://api.telegram.org/bot{TOKEN}/getUpdates")

    assert run("pull", transport=tg) != 0

    err = capsys.readouterr().err
    assert TOKEN not in err
    assert TOKEN.split(":")[1] not in err
    assert "getUpdates" in err


def test_token_is_masked_in_an_api_description(run, bound, capsys):
    tg = FakeTelegram()
    tg.api_error = {"ok": False, "error_code": 400, "description": f"Bad Request: {TOKEN}"}

    assert run("pull", transport=tg) != 0

    assert TOKEN not in capsys.readouterr().err


def test_mask_hides_any_bot_token_shape():
    masked = telegram.mask("GET /bot999:ABCdef_ghi-123/getMe failed", TOKEN)

    assert "ABCdef_ghi-123" not in masked


def test_token_never_written_to_disk(run, bound):
    tg = FakeTelegram([message(10, 100, caption="x", photo="p1")])
    assert run("pull", transport=tg) == 0

    for path in bound.parent.rglob("*"):
        if path.is_file() and path.suffix in {".json", ".txt"}:
            assert TOKEN not in path.read_text()


# -- migration ----------------------------------------------------------------


def migration_updates() -> list[dict]:
    """The pair Telegram sends when a group becomes a supergroup."""
    old = message(10, 1, chat_id=OTHER_GROUP_ID, chat_type="group")
    old["message"]["migrate_to_chat_id"] = GROUP_ID
    new = message(11, 2)
    new["message"]["migrate_from_chat_id"] = OTHER_GROUP_ID
    return [old, new]


def test_pull_rebinds_when_the_registered_chat_migrates(run, bugs_home, home, tmp_path, monkeypatch, capsys):
    repo = register(bugs_home, tmp_path / "repo-demo", "demo", OTHER_GROUP_ID)
    monkeypatch.chdir(repo)
    tg = FakeTelegram([*migration_updates(), message(12, 3, text="après la migration")])

    assert run("pull", transport=tg) == 0

    assert list(Registry(bugs_home / "projects.json").entries()) == [GROUP_ID]
    assert read_offset(home) == 13
    [rep] = reports(home)
    assert report_json(rep)["text"] == "après la migration"
    out = capsys.readouterr().out
    assert "rebound" in out and str(GROUP_ID) in out


def test_pull_ignores_migration_of_another_chat(run, bound):
    old = message(10, 1, chat_id=OTHER_GROUP_ID, chat_type="group")
    old["message"]["migrate_to_chat_id"] = -1005555555555

    assert run("pull", transport=FakeTelegram([old])) == 0

    assert list(Registry(bound.parent / "projects.json").entries()) == [GROUP_ID]
    assert Machine(bound.parent).unregistered() == {}


def test_pull_ignores_messages_sent_by_a_bot(run, bound):
    own = message(10, 1, text="la réponse du bot lui-même")
    own["message"]["from"] = {"id": 8266923011, "is_bot": True, "first_name": "Notifier"}

    assert run("pull", transport=FakeTelegram([own])) == 0

    assert reports(bound) == []
    assert read_offset(bound) == 11


def test_pull_keeps_every_human_author(run, bound):
    other = message(11, 2, text="un autre membre")
    other["message"]["from"] = {"id": 77, "is_bot": False, "first_name": "Léa"}

    assert run("pull", transport=FakeTelegram([message(10, 1, text="a"), other])) == 0

    assert sorted(report_json(r)["author"] for r in reports(bound)) == ["Léa", "izno_op"]


def test_pull_skips_service_messages_without_content(run, bound):
    service = message(10, 1)
    service["message"]["new_chat_title"] = "TM Bugs"

    assert run("pull", transport=FakeTelegram([service])) == 0

    assert reports(bound) == []
    assert read_offset(bound) == 11


# -- reactions: seen (pull) and fixed ------------------------------------------

EYES = {"type": "emoji", "emoji": "\U0001f440"}
OK_HAND = {"type": "emoji", "emoji": "\U0001f44c"}


def test_pull_reacts_with_eyes_on_the_first_message_of_each_report(run, bound):
    tg = FakeTelegram(
        [
            message(10, 100, text="un texte"),
            message(11, 101, caption="trois", photo="a", media_group_id="g1"),
            message(12, 102, photo="b", media_group_id="g1"),
        ]
    )

    assert run("pull", transport=tg) == 0

    assert [(r["chat_id"], r["message_id"], r["reaction"]) for r in tg.reactions] == [
        (GROUP_ID, 100, [EYES]),
        (GROUP_ID, 101, [EYES]),
    ]
    for rep in reports(bound):
        data = report_json(rep)
        assert data["status"] == "seen"
        assert data["reaction"]["applied"] == "\U0001f440"


def test_failed_reaction_keeps_the_report_and_is_retried_at_next_pull(run, bound, capsys):
    tg = FakeTelegram([message(10, 100, text="un texte")])
    tg.fail_reaction = True

    assert run("pull", transport=tg) == 0

    [rep] = reports(bound)
    data = report_json(rep)
    assert data["reaction"]["applied"] is None
    assert "REACTION_INVALID" in data["reaction"]["error"]
    assert "REACTION_INVALID" in capsys.readouterr().err
    assert read_offset(bound) == 11

    tg.fail_reaction = False
    assert run("pull", transport=tg) == 0

    data = report_json(rep)
    assert data["reaction"]["applied"] == "\U0001f440" and data["reaction"]["error"] is None
    assert len(tg.reactions) == 1


def test_reaction_on_a_deleted_message_is_given_up_not_retried_forever(run, bound, capsys):
    tg = FakeTelegram([message(10, 100, text="un texte")])
    tg.fail_reaction = True
    tg.reaction_error = "Bad Request: message to react not found"
    assert run("pull", transport=tg) == 0
    capsys.readouterr()
    attempts = sum(1 for u, _ in tg.calls if u.endswith("/setMessageReaction"))

    assert run("pull", transport=tg) == 0

    assert sum(1 for u, _ in tg.calls if u.endswith("/setMessageReaction")) == attempts
    [rep] = reports(bound)
    assert report_json(rep)["reaction"]["gone"] is True
    assert "pending" not in capsys.readouterr().err


def test_a_landed_reaction_is_not_sent_again(run, bound):
    tg = FakeTelegram([message(10, 100, text="un texte")])
    assert run("pull", transport=tg) == 0

    assert run("pull", transport=tg) == 0

    assert len(tg.reactions) == 1


def test_fixed_replaces_the_reaction_and_sets_status(run, bound, capsys):
    pulled(run, bound)
    tg = FakeTelegram()
    capsys.readouterr()

    assert run("fixed", f"{FIRST_STAMP}-100", transport=tg) == 0

    assert tg.reactions == [{"chat_id": GROUP_ID, "message_id": 100, "reaction": [OK_HAND]}]
    assert tg.sent == []  # no note, no reply
    data = report_json(bound / "inbox" / f"{FIRST_STAMP}-100")
    assert data["status"] == "fixed"
    assert data["reaction"]["applied"] == "\U0001f44c"
    capsys.readouterr()
    run("list")
    assert f"{FIRST_STAMP}-100" not in capsys.readouterr().out


def test_fixed_with_note_replies_in_the_group(run, bound):
    pulled(run, bound)
    tg = FakeTelegram()

    assert run("fixed", f"{FIRST_STAMP}-100", "--note", "corrigé dans la PR 42", transport=tg) == 0

    [sent] = tg.sent
    assert sent["reply_parameters"] == {"message_id": 100}
    assert "corrigé dans la PR 42" in sent["text"]
    [reply] = report_json(bound / "inbox" / f"{FIRST_STAMP}-100")["replies"]
    assert "corrigé dans la PR 42" in reply["text"]


def test_fixed_with_a_refused_reaction_keeps_status_and_pull_retries(run, bound, capsys):
    pulled(run, bound)
    tg = FakeTelegram()
    tg.fail_reaction = True

    assert run("fixed", f"{FIRST_STAMP}-100", "--note", "n", transport=tg) != 0

    data = report_json(bound / "inbox" / f"{FIRST_STAMP}-100")
    assert data["status"] == "fixed" and data["reaction"]["applied"] != "\U0001f44c"
    assert "REACTION_INVALID" in capsys.readouterr().err
    assert len(tg.sent) == 1  # the note still went out

    tg.fail_reaction = False
    assert run("pull", transport=tg) == 0

    assert tg.reactions[-1] == {"chat_id": GROUP_ID, "message_id": 100, "reaction": [OK_HAND]}
    assert report_json(bound / "inbox" / f"{FIRST_STAMP}-100")["reaction"]["applied"] == "\U0001f44c"


def test_done_does_not_react(run, bound):
    pulled(run, bound)
    tg = FakeTelegram()

    assert run("done", f"{FIRST_STAMP}-100", transport=tg) == 0

    assert tg.reactions == []


def test_pull_deletes_old_fixed_reports_too(run, bound):
    old = bound / "inbox" / "20260801-000000-1"
    old.mkdir(parents=True)
    (old / "report.json").write_text(json.dumps({"status": "fixed", "date": "2026-08-01T00:00:00+00:00"}))

    assert run("pull", now=BASE_DATE) == 0

    assert not old.exists()


# -- list / show / reply / done ----------------------------------------------


def pulled(run, bound):
    tg = FakeTelegram(
        [
            message(10, 100, text="premier\nseconde ligne"),
            message(11, 101, caption="avec image", photo="p1", date=BASE_DATE + 60),
        ]
    )
    assert run("pull", transport=tg) == 0


def test_list_shows_new_reports_oldest_first(run, bound, capsys):
    pulled(run, bound)
    capsys.readouterr()

    assert run("list") == 0

    lines = capsys.readouterr().out.strip().splitlines()
    assert len(lines) == 2
    assert lines[0].startswith(f"{FIRST_STAMP}-100")
    assert "premier" in lines[0] and "seconde" not in lines[0]
    assert "1 image" in lines[1]


def test_show_prints_text_and_absolute_image_paths(run, bound, capsys):
    pulled(run, bound)
    capsys.readouterr()

    assert run("show", "20261002-083100-101") == 0

    out = capsys.readouterr().out
    assert "avec image" in out
    path = [ln for ln in out.splitlines() if ln.endswith(".jpg")][0].strip()
    assert os.path.isabs(path) and Path(path).read_bytes() == image_bytes("p1-l")


def test_show_unknown_id_fails(run, bound, capsys):
    assert run("show", "nope") != 0

    assert "nope" in capsys.readouterr().err


@pytest.mark.parametrize("bad", ["../state.json", "a/b", ".."])
def test_ids_cannot_escape_the_inbox(run, bound, bad):
    assert run("show", bad) != 0
    assert run("done", bad) != 0


def test_done_hides_the_report_from_list(run, bound, capsys):
    pulled(run, bound)

    assert run("done", f"{FIRST_STAMP}-100") == 0
    capsys.readouterr()
    run("list")

    out = capsys.readouterr().out
    assert f"{FIRST_STAMP}-100" not in out
    assert report_json(bound / "inbox" / f"{FIRST_STAMP}-100")["status"] == "done"


def test_reply_threads_on_first_message_and_is_recorded(run, bound):
    pulled(run, bound)
    tg = FakeTelegram()

    assert run("reply", f"{FIRST_STAMP}-100", "bien reçu", transport=tg) == 0

    [sent] = tg.sent
    assert sent["chat_id"] == GROUP_ID
    assert sent["text"] == "bien reçu"
    assert sent["reply_parameters"] == {"message_id": 100}
    [reply] = report_json(bound / "inbox" / f"{FIRST_STAMP}-100")["replies"]
    assert reply["text"] == "bien reçu" and reply["message_id"] == 777


def test_reply_failure_records_nothing(run, bound, capsys):
    pulled(run, bound)
    tg = FakeTelegram()
    tg.api_error = {"ok": False, "error_code": 403, "description": "Forbidden: bot was kicked"}

    assert run("reply", f"{FIRST_STAMP}-100", "x", transport=tg) != 0

    assert report_json(bound / "inbox" / f"{FIRST_STAMP}-100")["replies"] == []
    assert "Forbidden: bot was kicked" in capsys.readouterr().err


def test_report_write_is_atomic(run, bound):
    pulled(run, bound)

    assert run("done", f"{FIRST_STAMP}-100") == 0

    assert not list((bound / "inbox").rglob("*.tmp"))


def test_unknown_command_exits_non_zero():
    with pytest.raises(SystemExit) as exc:
        cli.main(["frobnicate"], transport=FakeTelegram(), env={})

    assert exc.value.code != 0


def test_default_state_dir_is_the_torrentmate_inbox():
    assert str(store.DEFAULT_HOME).endswith(".bugs-bot")
