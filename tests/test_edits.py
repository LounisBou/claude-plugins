"""Edited messages: a new version of a recorded message replaces its text in the report, the previous one kept."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from conftest import read_offset, register, reports
from fake_channel import FakeChannel, author, batch, inbound
from fake_slack import CHANNEL, FakeSlack, msg, ts
from samples import BASE_DATE, GROUP_ID, OTHER_GROUP_ID, FakeTelegram, message
from test_mention import STAMP, write_report

from bugs_bot import cli, edits, pull
from bugs_bot import reports as reports_
from bugs_bot.store import EMOJI_TAKEN, Machine, Store, update_report

REPORT = f"{STAMP}-10"
ANA = author(id="U0ANA", username="ana", name="Ana")


def edited(update_id: int, message_id: int, edit_date: int, **fields) -> dict:
    """Return an ``edited_message`` update: the message as now written, with the date of the edit."""
    update = message(update_id, message_id, **fields)
    return {"update_id": update_id, "edited_message": update["message"] | {"edit_date": edit_date}}


def iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def read(home: Path, report_id: str = REPORT) -> dict:
    return json.loads((home / "inbox" / report_id / "report.json").read_text())


# -- Telegram ------------------------------------------------------------------------------------------


def test_telegram_is_asked_for_edited_messages(bound, run):
    tg = FakeTelegram()

    assert run("pull", transport=tg) == 0

    assert tg.updates_calls()[0]["allowed_updates"] == ["message", "edited_message"]


def test_an_edit_replaces_the_report_text_keeps_the_previous_and_wait_says_it_until_show(bound, run, capsys):
    tg = FakeTelegram([message(1, 10, text="Autre point bloquant:")])
    assert run("pull", transport=tg) == 0
    update_report(Store(bound), REPORT, lambda report: report.update(kind="bug"))
    tg.updates.append(edited(2, 10, BASE_DATE + 120, text="Autre point bloquant: le lecteur gèle au lancement"))
    capsys.readouterr()

    assert run("pull", transport=tg) == 0

    after = read(bound)
    assert after["text"] == "Autre point bloquant: le lecteur gèle au lancement"
    assert after["edits"] == [{"date": iso(BASE_DATE + 120), "message_id": 10, "previous": "Autre point bloquant:", "seen": False}]
    assert [path.name for path in reports(bound)] == [REPORT]
    assert f"edited {REPORT} in demo" in capsys.readouterr().out
    assert read_offset(bound) == 3  # the cursor moves past an edit like any update

    assert run("wait", "--timeout", "0") == 0
    assert capsys.readouterr().out == f"edited {REPORT}\n"
    assert run("show", REPORT) == 0
    shown = capsys.readouterr().out
    assert "modifié : Autre point bloquant: → Autre point bloquant: le lecteur gèle au lancement" in shown
    assert read(bound)["edits"][0]["seen"] is True
    assert run("wait", "--timeout", "0") == 0
    assert capsys.readouterr().out == ""


def album(*captions: str) -> FakeTelegram:
    """Return a Telegram holding one media group, a photo per caption (``""``: a photo without one), ids from 10."""
    return FakeTelegram(
        [message(n + 1, 10 + n, photo=f"p{n}", media_group_id="g", **({"caption": c} if c else {})) for n, c in enumerate(captions)]
    )


def test_an_edit_of_a_media_group_member_corrects_that_member_only(bound, run):
    tg = album("la capture", "le menu")
    assert run("pull", transport=tg) == 0
    tg.updates.append(edited(3, 11, BASE_DATE + 60, photo="p1", caption="le menu Réglages", media_group_id="g"))

    assert run("pull", transport=tg) == 0

    (only,) = reports(bound)
    after = read(bound, only.name)
    assert after["text"] == "la capture\nle menu Réglages" and after["images"] == ["1.jpg", "2.jpg"]
    assert after["edits"] == [{"date": iso(BASE_DATE + 60), "message_id": 11, "previous": "le menu", "seen": False}]


def test_a_caption_removed_from_a_media_group_member_takes_that_member_s_line_only(bound, run):
    tg = album("la capture", "le menu")
    assert run("pull", transport=tg) == 0
    tg.updates.append(edited(3, 11, BASE_DATE + 60, photo="p1", media_group_id="g"))

    assert run("pull", transport=tg) == 0

    after = read(bound, reports(bound)[0].name)
    assert after["text"] == "la capture"
    assert after["edits"] == [{"date": iso(BASE_DATE + 60), "message_id": 11, "previous": "le menu", "seen": False}]


def test_a_media_group_member_edited_to_its_own_text_records_nothing(bound, run):
    tg = album("la capture", "le menu")
    assert run("pull", transport=tg) == 0
    before = read(bound, reports(bound)[0].name)
    tg.updates.append(edited(3, 11, BASE_DATE + 60, photo="p1", caption="le menu", media_group_id="g"))

    assert run("pull", transport=tg) == 0

    assert read(bound, reports(bound)[0].name) == before


def test_a_media_group_report_written_without_its_members_texts_keeps_its_text_and_records_the_edit(bound, run, capsys):
    # Written before each member's text was recorded: which line is this member's is unknown.
    write_report(bound, 10, message_ids=[10, 11], media_group_id="g", text="la capture\nle menu")
    tg = FakeTelegram([edited(1, 11, BASE_DATE + 60, photo="p1", caption="le menu Réglages", media_group_id="g")])

    assert run("pull", transport=tg) == 0

    after = read(bound)
    assert after["text"] == "la capture\nle menu"
    assert after["edits"] == [
        {"date": iso(BASE_DATE + 60), "message_id": 11, "previous": None, "text": "le menu Réglages", "seen": False}
    ]
    capsys.readouterr()
    assert run("show", REPORT) == 0
    assert "modifié : (not recorded) → le menu Réglages" in capsys.readouterr().out


def test_an_edit_of_a_message_never_recorded_writes_nothing(bound, run):
    write_report(bound, 10, text="bug")
    before = (bound / "inbox" / REPORT / "report.json").read_bytes()
    tg = FakeTelegram([edited(1, 99, BASE_DATE + 60, text="jamais vu")])

    assert run("pull", transport=tg) == 0

    assert [path.name for path in reports(bound)] == [REPORT]  # no report created
    assert (bound / "inbox" / REPORT / "report.json").read_bytes() == before
    assert read_offset(bound) == 2


def test_an_edit_changes_no_status_no_wait_and_no_reaction(bound, run):
    awaiting = {"since": iso(BASE_DATE + 10), "reply": 1}
    write_report(bound, 10, author_id=42, text="avant", status="taken", awaiting=awaiting,
                 reaction={"wanted": EMOJI_TAKEN, "applied": EMOJI_TAKEN, "error": None})
    tg = FakeTelegram([edited(1, 10, BASE_DATE + 600, text="après")])

    assert run("pull", transport=tg) == 0

    after = read(bound)
    assert after["text"] == "après"
    assert (after["status"], after["awaiting"], after["reaction"]["applied"]) == ("taken", awaiting, EMOJI_TAKEN)
    assert tg.reactions == [] and tg.sent == []


def test_an_edit_delivered_again_is_recorded_once(bound, run):
    tg = FakeTelegram([message(1, 10, text="avant"), edited(2, 10, BASE_DATE + 60, text="après")])
    assert run("pull", transport=tg) == 0

    edits.record_edit(Store(bound), GROUP_ID, inbound(GROUP_ID, 10, "après", date=BASE_DATE + 60, edited=True))

    assert read(bound)["edits"] == [{"date": iso(BASE_DATE + 60), "message_id": 10, "previous": "avant", "seen": False}]


def test_an_edit_replayed_after_a_later_one_is_never_recorded_again(bound, run, capsys):
    # A batch delivered again (the cursor held after a failure) brings back edits already recorded.
    tg = FakeTelegram([message(1, 10, text="A")])
    assert run("pull", transport=tg) == 0
    update_report(Store(bound), REPORT, lambda report: report.update(kind="bug"))  # wait announces it no more
    tg.updates += [edited(2, 10, BASE_DATE + 60, text="B"), edited(3, 10, BASE_DATE + 120, text="C")]
    assert run("pull", transport=tg) == 0
    assert run("show", REPORT) == 0
    capsys.readouterr()
    tg.updates += [edited(4, 10, BASE_DATE + 60, text="B"), edited(5, 10, BASE_DATE + 120, text="C")]

    assert run("pull", transport=tg) == 0

    after = read(bound)
    assert after["text"] == "C"
    assert [(e["previous"], e["date"]) for e in after["edits"]] == [("A", iso(BASE_DATE + 60)), ("B", iso(BASE_DATE + 120))]
    assert "edited" not in capsys.readouterr().out
    assert run("wait", "--timeout", "0") == 0
    assert capsys.readouterr().out == ""


def test_an_edit_of_the_same_message_id_in_another_chat_writes_nothing(bound, capsys):
    write_report(bound, 10, text="avant")
    before = (bound / "inbox" / REPORT / "report.json").read_bytes()

    found = edits.record_edit(Store(bound), OTHER_GROUP_ID, inbound(OTHER_GROUP_ID, 10, "ailleurs", date=BASE_DATE + 60, edited=True))

    assert found is None
    assert (bound / "inbox" / REPORT / "report.json").read_bytes() == before
    assert capsys.readouterr().out == ""


def test_an_edit_is_written_on_the_report_as_it_is_now(bound, monkeypatch):
    # The agent triages the report right after Pull read the inbox to find it: both changes land.
    write_report(bound, 10, text="avant")
    store = Store(bound)
    listed = store.reports
    calls = []

    def read_then_triage():
        found = listed()
        if not calls:
            update_report(store, REPORT, lambda report: report.update(kind="question"))
        calls.append(1)
        return found

    monkeypatch.setattr(store, "reports", read_then_triage)

    edits.record_edit(store, GROUP_ID, inbound(GROUP_ID, 10, "après", date=BASE_DATE + 60, edited=True))

    after = read(bound)
    assert (after["text"], after.get("kind")) == ("après", "question"), "the copy read before the lock was written back"


# -- Slack ---------------------------------------------------------------------------------------------


def test_an_edit_of_a_thread_answer_goes_to_that_answer(tmp_path, bugs_home):
    register(bugs_home, tmp_path / "repo-sla", "sla", CHANNEL, "sla-bugs", channel="slack")
    machine = Machine(bugs_home)
    report = inbound(CHANNEL, ts(1), "le bouton", author=ANA, date=BASE_DATE + 1)
    answer = inbound(CHANNEL, ts(900), "iphone", author=ANA, date=BASE_DATE + 900, thread_of=ts(1))
    pull.cmd_pull(FakeChannel(batch(report, answer), kind="slack"), machine, BASE_DATE + 1000)
    again = inbound(CHANNEL, ts(900), "iPhone SE, iOS 17", author=ANA, date=BASE_DATE + 950, thread_of=ts(1), edited=True)

    pull.cmd_pull(FakeChannel(batch(again), kind="slack"), machine, BASE_DATE + 1000)

    inbox = bugs_home / "sla" / "inbox"
    (only,) = [path for path in inbox.iterdir() if not path.name.startswith(".")]
    after = json.loads((only / "report.json").read_text())
    assert after["text"] == "le bouton"
    assert [a["text"] for a in after["answers"]] == ["iPhone SE, iOS 17"]
    assert after["edits"] == [{"date": iso(BASE_DATE + 950), "message_id": ts(900), "previous": "iphone", "seen": False}]


def test_show_prints_an_edit_of_a_thread_answer_from_its_previous_to_its_new_text(tmp_path, bugs_home, capsys):
    register(bugs_home, tmp_path / "repo-sla", "sla", CHANNEL, "sla-bugs", channel="slack")
    machine = Machine(bugs_home)
    report = inbound(CHANNEL, ts(1), "le bouton", author=ANA, date=BASE_DATE + 1)
    answer = inbound(CHANNEL, ts(900), "iphone", author=ANA, date=BASE_DATE + 900, thread_of=ts(1))
    pull.cmd_pull(FakeChannel(batch(report, answer), kind="slack"), machine, BASE_DATE + 1000)
    again = inbound(CHANNEL, ts(900), "iPhone SE, iOS 17", author=ANA, date=BASE_DATE + 950, thread_of=ts(1), edited=True)
    pull.cmd_pull(FakeChannel(batch(again), kind="slack"), machine, BASE_DATE + 1000)
    store = machine.project_store("sla")
    ((report_id, _, _),) = store.reports()
    capsys.readouterr()

    reports_.cmd_show(store, report_id)

    shown = capsys.readouterr().out
    assert "modifié : iphone → iPhone SE, iOS 17" in shown
    assert "le bouton" in shown.splitlines()[1]  # the report's own text is not the answer's


def changed(edit_ts: str, original_ts: str, text: str, **inner) -> dict:
    """Return a ``message_changed`` event as ``conversations.history`` lists it."""
    new = {"type": "message", "user": "U0ANA", "text": text, "ts": original_ts, "edited": {"user": "U0ANA", "ts": edit_ts}} | inner
    return {"type": "message", "subtype": "message_changed", "ts": edit_ts, "hidden": True, "message": new,
            "previous_message": {"type": "message", "user": "U0ANA", "text": "…", "ts": original_ts}}


def test_slack_message_changed_is_the_inner_message_edited_and_the_cursor_passes_it():
    from bugs_bot.slack import SlackChannel
    from fake_slack import ROOT, SLACK_TOKEN

    api = FakeSlack()
    api.history[CHANNEL] = [msg(ts(1), "avant"), changed(ts(50), ts(1), "après")]
    slack = SlackChannel(SLACK_TOKEN, api, ROOT, clock=lambda: BASE_DATE + 3600)

    batch_ = slack.poll({CHANNEL: {"ts": ts(0), "threads": {}}}, [CHANNEL], 0)

    original, edit = batch_.messages
    assert (original.message_id, original.edited, original.text) == (ts(1), False, "avant")
    assert (edit.message_id, edit.edited, edit.text, edit.thread_of) == (ts(1), True, "après", None)
    assert edit.date == float(ts(50)) and edit.author.id == "U0ANA"
    assert batch_.cursor[CHANNEL]["ts"] == ts(50)


def test_a_slack_edit_through_pull_replaces_the_text_and_creates_no_report(tmp_path, bugs_home):
    from fake_slack import SLACK_TOKEN
    from test_slack_pull import Both

    register(bugs_home, tmp_path / "repo-sla", "sla", CHANNEL, "sla-bugs", channel="slack")
    env_file = tmp_path / ".env"
    env_file.write_text(f"SLACK_BOT_TOKEN={SLACK_TOKEN}\n")
    env = {"BUGS_BOT_ENV_FILE": str(env_file), "BUGS_BOT_HOME": str(bugs_home)}
    api = FakeSlack()
    api.history[CHANNEL] = [msg(ts(1), "le bouton ne marche pas")]
    now = BASE_DATE + 3600
    assert cli.main(["pull"], transport=Both(FakeTelegram(), api), env=env, now=now) == 0
    api.history[CHANNEL].append(changed(ts(80), ts(1), "le bouton Valider ne marche pas"))

    assert cli.main(["pull"], transport=Both(FakeTelegram(), api), env=env, now=now + 60) == 0

    inbox = bugs_home / "sla" / "inbox"
    (only,) = [path for path in inbox.iterdir() if not path.name.startswith(".")]
    after = json.loads((only / "report.json").read_text())
    assert after["text"] == "le bouton Valider ne marche pas" and after["edits"][0]["previous"] == "le bouton ne marche pas"
    assert Machine(bugs_home).load_cursor("slack")[CHANNEL]["ts"] == ts(80)
