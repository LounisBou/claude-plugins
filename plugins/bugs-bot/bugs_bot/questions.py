"""One question at a time per person (spec § 3.5): a question to someone who owes an answer on another report waits on their card.

A person may raise several subjects; the agent works on all of them but asks about one at a time, so
nobody faces a volley of questions. ``reply --awaits`` to a person whose answer is awaited on another
report not done posts nothing: the question joins ``questions`` on their card. Once nothing of theirs is
awaited — they answered, the awaited message was deleted, or the wait was escalated to the launcher —
``wait`` prints ``ask <report-id>`` for the oldest one, and the agent asks it from the current state of
that subject.
"""

from __future__ import annotations

from datetime import datetime, timezone

from bugs_bot.errors import BugsError
from bugs_bot.people import card_key, load_person, update_card
from bugs_bot.store import Store, load_report


def _awaited(reports: list[tuple[str, object, dict]], key: str, exclude: str | None) -> str | None:
    """Return the first report but ``exclude`` on which the answer of the person with card ``key`` is awaited, or ``None``.

    A wait counts whatever the report's status but ``done`` (« vérifier » is asked on a ``fixed`` one);
    an escalated wait does not: the launcher was told, the person's next questions go on.
    """
    for report_id, _, report in reports:
        wait = report.get("awaiting")
        if (
            report_id != exclude
            and wait
            and "escalated" not in wait
            and report["status"] != "done"
            and card_key(report.get("author_id"), report["author"]) == key
        ):
            return report_id
    return None


def awaited_elsewhere(store: Store, report: dict) -> str | None:
    """Return the id of another report on which the answer of ``report``'s author is awaited, or ``None``."""
    return _awaited(store.reports(), card_key(report.get("author_id"), report["author"]), report["id"])


def queue_question(store: Store, report: dict, text: str, now: float) -> None:
    """Queue a question about ``report`` on its author's card, creating it.

    One question per report: one already queued about it takes the new text and keeps its date and its place.
    """

    def queue(card: dict) -> None:
        questions = card.setdefault("questions", [])
        for question in questions:
            if question["report"] == report["id"]:
                question["text"] = text
                break
        else:
            questions.append({"report": report["id"], "text": text, "queued": datetime.fromtimestamp(now, timezone.utc).isoformat()})

    update_card(store, card_key(report.get("author_id"), report["author"]), queue, report["author"], report.get("author_id"))


def _remove(store: Store, report: dict) -> bool:
    """Take the question queued about ``report`` off its author's card; tell whether there was one."""
    key = card_key(report.get("author_id"), report["author"])
    if load_person(store, key) is None:
        return False  # no card, no queue: none is created to say so

    def remove(card: dict) -> bool:
        questions = card.get("questions", [])
        kept = [question for question in questions if question["report"] != report["id"]]
        if len(kept) == len(questions):
            return False
        card["questions"] = kept
        return True

    return update_card(store, key, remove, None, None)


def asked(store: Store, report: dict) -> None:
    """Take the question queued about ``report`` off its author's queue: it has just been asked."""
    _remove(store, report)


def drop_closed(store: Store, report: dict) -> None:
    """Drop the question queued about ``report``: it is done, there is nothing left to ask."""
    _remove(store, report)


def cmd_unask(store: Store, report_id: str) -> None:
    """Drop the question queued about a report that no longer needs asking: the subject moved on.

    Raises:
        BugsError: If no question is queued about the report.
    """
    _, report = load_report(store, report_id)
    if not _remove(store, report):
        raise BugsError(f"no question queued about {report_id}")
    print(f"unasked {report_id}")


def asks(store: Store) -> list[str]:
    """Return the report ids to ask about now: per person whose answer is awaited nowhere, their oldest queued question.

    A question about a report done or gone in the meantime is passed over; one about a ``fixed`` report is kept.
    """
    reports = store.reports()
    askable = {report_id for report_id, _, report in reports if report["status"] != "done"}
    found = []
    for path in sorted(store.people.glob("*.json")):
        card = load_person(store, path.stem) or {}
        pending = [q["report"] for q in card.get("questions", []) if q["report"] in askable]
        if pending and _awaited(reports, path.stem, None) is None:
            found.append(pending[0])
    return found
