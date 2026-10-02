"""Follow-ups: a message of the agent that waits for a person's answer, one reminder, then the launcher.

A reply posted with ``--awaits`` records ``awaiting = {since, reply}`` on its report. A later message
of the same person in the group answers it (Pull clears it). Still unanswered after the project's
``follow_up_hours``, the wait is due: the agent sends ONE reminder (``--follow-up``, recorded as
``reminded``). Unanswered as long again after it, the wait is ``unanswered``: the agent tells its
launcher once (``escalated``) and never reminds again.
"""

from __future__ import annotations

from datetime import datetime, timezone

from bugs_bot.errors import BugsError
from bugs_bot.store import Store, update_report


def _iso(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).isoformat()


def _epoch(iso: str) -> float:
    return datetime.fromisoformat(iso).timestamp()


def mark_awaiting(store: Store, report_id: str, reply_index: int, now: float) -> None:
    """Record that reply ``reply_index`` (1-based, as ``show`` numbers them) waits for the person's answer.

    A wait already there is replaced: a new question is awaited, and may be reminded, afresh.
    """
    update_report(store, report_id, lambda report: report.update(awaiting={"since": _iso(now), "reply": reply_index}))


def same_person(report: dict, author_id: int | str | None, author: str) -> bool:
    """Tell whether a message's author wrote ``report``: same user id, else the same display name."""
    if author_id is not None and report.get("author_id") is not None:
        return report["author_id"] == author_id
    return bool(author) and report.get("author") == author


def clear_answered(store: Store, author_id: int | str | None, author: str, since: float) -> list[str]:
    """Clear the waits a new message answers: that person's, posted before the message.

    Returns:
        The ids of the reports whose wait was cleared.
    """

    def answered(report: dict) -> bool:
        wait = report.get("awaiting")
        return bool(wait) and same_person(report, author_id, author) and _epoch(wait["since"]) < since

    def clear(report: dict) -> bool:
        # Asked again: the read below may be older than a wait the agent set since.
        if not answered(report):
            return False
        del report["awaiting"]
        return True

    return [rid for rid, _, report in store.reports() if answered(report) and update_report(store, rid, clear)]


def is_due(report: dict, hours: float, now: float) -> bool:
    """Tell whether the report's wait is owed its one reminder."""
    wait = report.get("awaiting")
    return (
        bool(wait)
        and report["status"] != "done"
        and "reminded" not in wait
        and now - _epoch(wait["since"]) >= hours * 3600
    )


def is_unanswered(report: dict, hours: float, now: float) -> bool:
    """Tell whether the report's reminded wait is still unanswered and the launcher not yet told."""
    wait = report.get("awaiting")
    return (
        bool(wait)
        and report["status"] != "done"
        and "reminded" in wait
        and "escalated" not in wait
        and now - _epoch(wait["reminded"]) >= hours * 3600
    )


def due(store: Store, hours: float, now: float) -> list[str]:
    """Return the ids of the reports not done whose wait is ``hours`` old or more and not yet reminded."""
    return [rid for rid, _, report in store.reports() if is_due(report, hours, now)]


def unanswered(store: Store, hours: float, now: float) -> list[str]:
    """Return the ids of the reports not done still unanswered ``hours`` after their reminder, launcher not yet told."""
    return [rid for rid, _, report in store.reports() if is_unanswered(report, hours, now)]


def require_due(report: dict, hours: float, now: float) -> None:
    """Refuse a reminder that is not owed: no wait, already reminded, or not yet ``hours`` old.

    Raises:
        BugsError: If no follow-up is due on the report.
    """
    if not is_due(report, hours, now):
        raise BugsError(f"no follow-up due on {report['id']}: one reminder only, once the wait is {hours:g} hours old")


def mark_reminded(store: Store, report_id: str, now: float) -> None:
    """Record the one reminder of the current wait (none left: nothing to record)."""

    def remind(report: dict) -> None:
        if report.get("awaiting"):
            report["awaiting"]["reminded"] = _iso(now)

    update_report(store, report_id, remind)


def cmd_escalated(store: Store, report_id: str, now: float) -> None:
    """Record that the launcher was told a reminded wait stays unanswered: ``wait`` prints it no more.

    Raises:
        BugsError: If the report's wait was never reminded, or the launcher was already told.
    """

    def escalate(report: dict) -> None:
        wait = report.get("awaiting") or {}
        if "reminded" not in wait or "escalated" in wait:
            raise BugsError(f"nothing to escalate on {report_id}: no reminded wait, or the launcher was already told")
        wait["escalated"] = _iso(now)

    update_report(store, report_id, escalate)
    print(f"escalated {report_id}")

