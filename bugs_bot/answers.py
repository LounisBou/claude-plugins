"""Answers: a reply posted in a report's thread, recorded on that report, never a report of its own.

On a platform that threads (Slack), a person answers the agent under the report itself. Pull records
the reply in the report's ``answers`` (its images saved beside the report's) and lifts that person's
wait as any message of theirs does. ``wait`` prints ``answer <report-id>`` while an answer is unseen;
``show`` prints the answers and marks them seen.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from bugs_bot.channel import Channel, ChatId, InboundMessage
from bugs_bot.store import Store, update_report


def _image_count(report: dict) -> int:
    """Return how many images the report and its answers hold: the next one is numbered after them."""
    return len(report.get("images", [])) + sum(len(answer.get("images", [])) for answer in report.get("answers", []))


def _parent(store: Store, chat_id: ChatId, msg: InboundMessage) -> tuple[str, Path, dict] | None:
    """Return the report whose first message opened the thread ``msg`` was posted in, if there is one."""
    for report_id, path, report in store.reports():
        if report.get("message_ids", [None])[0] == msg.thread_of and report.get("chat_id", chat_id) == chat_id:
            return report_id, path, report
    return None


def record_answer(channel: Channel, store: Store, chat_id: ChatId, msg: InboundMessage) -> str | None:
    """Record a thread reply on the report it answers; return that report's id.

    ``None`` when the thread is not a report's (a bot post's thread), or the reply is already recorded
    (a batch delivered again).

    Raises:
        BugsError: If an image cannot be downloaded; nothing is recorded and the files written so far are removed.
    """
    found = _parent(store, chat_id, msg)
    if found is None:
        return None
    report_id, path, report = found
    answers = report.setdefault("answers", [])
    if any(answer["message_id"] == msg.message_id for answer in answers):
        return None
    images: list[str] = []
    try:
        for attachment in msg.attachments:
            name = f"{_image_count(report) + len(images) + 1}{attachment.ext}"
            (path / name).write_bytes(channel.get_file(attachment.file_id))
            images.append(name)
    except BaseException:
        for name in images:
            (path / name).unlink(missing_ok=True)
        raise
    answer = {
        "date": datetime.fromtimestamp(msg.date, timezone.utc).isoformat(),
        "author": msg.author.name,
        "author_id": msg.author.id,
        "text": msg.text,
        "message_id": msg.message_id,
        "images": images,
        "seen": False,
    }

    def record(fresh: dict) -> None:
        # The downloads ran unlocked on the copy read above; the answer joins the report as it is now.
        recorded = fresh.setdefault("answers", [])
        if not any(other["message_id"] == msg.message_id for other in recorded):
            recorded.append(answer)

    update_report(store, report_id, record)
    return report_id


def unseen(store: Store) -> list[str]:
    """Return the ids of the reports holding an answer ``show`` has not printed yet, oldest first."""
    return [rid for rid, _, report in store.reports() if any(not a.get("seen") for a in report.get("answers", []))]


def show_answers(store: Store, report_id: str, path: Path, report: dict) -> list[str]:
    """Return the lines ``show`` prints for the report's answers, and mark them seen in ``report.json``.

    Only the answers printed: one Pull records meanwhile stays unseen, for ``wait`` to announce.
    """
    lines = []
    for number, answer in enumerate(report.get("answers", []), 1):
        lines.append(f"answer {number} {answer['date']} {answer['author']}: {answer['text'] or '(no text)'}")
        lines += [f"  {(path / name).resolve()}" for name in answer.get("images", [])]
    shown = {answer["message_id"] for answer in report.get("answers", []) if not answer.get("seen")}
    if shown:

        def mark_seen(fresh: dict) -> None:
            for answer in fresh.get("answers", []):
                if answer["message_id"] in shown:
                    answer["seen"] = True

        update_report(store, report_id, mark_seen)
    return lines
