"""Edits: a new version of a message already recorded takes its place in the report, the previous text kept.

A tester may correct a message after sending it (operator, 2026-10-02: a report whose real text came in
an edit was lost). Pull routes the new version to the report recording that message — its first message,
a member of its media group, or an answer in its thread — and records the text it replaces in the report's
``edits``. ``wait`` prints ``edited <report-id>`` while an edit is unseen; ``show`` prints the edits and
marks them seen. An edit never creates a report, never sets or clears a wait, never changes a status or a
reaction; an edit of a message no report records is ignored.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from bugs_bot.channel import ChatId, InboundMessage
from bugs_bot.errors import BugsError
from bugs_bot.store import Store, find_by_message, update_report

_log = logging.getLogger(__name__)


def joined(message_ids: list, texts: dict[str, str]) -> str:
    """Return a report's text: its members' texts, in the order of its messages, one per line.

    ``texts`` maps a member's message id, as text (a JSON key), to its text; a member without one is absent.
    """
    return "\n".join(texts[str(m)] for m in message_ids if str(m) in texts)


def record_edit(store: Store, chat_id: ChatId, msg: InboundMessage) -> str | None:
    """Replace the recorded text of the message ``msg`` is a new version of; return its report's id.

    A member of a media group corrects its own text only, and the report's text is joined again. A report
    written before its members' texts were recorded, with several members, keeps its text: the edit holds
    the new one. ``None`` when no report records that message (logged at debug level only), when the
    report was purged meanwhile, when the text recorded is already this one, or when this edit, or a later
    one of that message, is already recorded (a batch delivered again).
    """
    report_id = find_by_message(store, chat_id, msg.message_id)
    if report_id is None:
        _log.debug("edit of message %s in chat %s ignored: no report records it", msg.message_id, chat_id)
        return None
    when = datetime.fromtimestamp(msg.date, timezone.utc)

    def replace(report: dict) -> bool:
        # Read again under the lock: the report as it is now, not as it was found.
        recorded = [e for e in report.get("edits", []) if e.get("message_id") == msg.message_id]
        if any(when <= datetime.fromisoformat(e["date"]) for e in recorded):
            return False
        edit = {"date": when.isoformat(), "message_id": msg.message_id}
        message_ids = report.get("message_ids", [])
        if msg.message_id in message_ids and "texts" in report:
            texts, key = report["texts"], str(msg.message_id)
            previous = texts.get(key, "")
            if previous == msg.text:
                return False
            if msg.text:
                texts[key] = msg.text
            else:
                texts.pop(key, None)
            report["text"] = joined(message_ids, texts)
        elif msg.message_id in message_ids and len(message_ids) > 1:
            # Which line of the text is this member's is unknown: the text stays, the edit holds the new one.
            previous = next((e["text"] for e in reversed(recorded) if "text" in e), None)
            if previous == msg.text:
                return False
            edit["text"] = msg.text
        else:
            holder = report
            if msg.message_id not in message_ids:
                holder = next((a for a in report.get("answers", []) if a.get("message_id") == msg.message_id), None)
                if holder is None:
                    return False
            previous = holder.get("text") or ""
            if previous == msg.text:
                return False
            holder["text"] = msg.text
        report.setdefault("edits", []).append(edit | {"previous": previous, "seen": False})
        return True

    try:
        changed = update_report(store, report_id, replace)
    except BugsError:
        return None  # purged since it was found: nothing left to correct
    return report_id if changed else None


def unseen_edits(store: Store) -> list[str]:
    """Return the ids of the reports holding an edit ``show`` has not printed yet, oldest first."""
    return [rid for rid, _, report in store.reports() if any(not edit.get("seen") for edit in report.get("edits", []))]


def _current(report: dict, message_id: object) -> str:
    """Return the text recorded now for a message of the report: its member's, the report's own, or its answer's."""
    if message_id in report.get("message_ids", []):
        if "texts" in report:
            return report["texts"].get(str(message_id), "")
        return report.get("text") or ""
    return next((a.get("text") or "" for a in report.get("answers", []) if a.get("message_id") == message_id), "")


def show_edits(store: Store, report_id: str, report: dict) -> list[str]:
    """Return the lines ``show`` prints for the report's edits, and mark them seen in ``report.json``.

    Each line goes from one version to the next: the text an edit replaced, then the one that replaced it.
    Only the edits printed are marked: one Pull records meanwhile stays unseen, for ``wait`` to announce.
    """
    found = report.get("edits", [])
    lines = []
    for number, edit in enumerate(found):
        later = next((e["previous"] for e in found[number + 1 :] if e["message_id"] == edit["message_id"]), None)
        if later is None:
            later = edit["text"] if "text" in edit else _current(report, edit["message_id"])
        before = "(not recorded)" if edit["previous"] is None else edit["previous"] or "(no text)"
        lines.append(f"modifié : {before} → {later or '(no text)'}")
    printed = len(found)
    if any(not edit.get("seen") for edit in found):

        def mark_seen(fresh: dict) -> None:
            for edit in fresh.get("edits", [])[:printed]:  # edits are only appended: the first ones are those shown
                edit["seen"] = True

        update_report(store, report_id, mark_seen)
    return lines
