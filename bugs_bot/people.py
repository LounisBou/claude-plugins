"""People: what the agent remembers about each reporter, one card per author, and recovering the user id of older reports' authors."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from bugs_bot.channel import Channel
from bugs_bot.errors import BugsError
from bugs_bot.store import Store, load_report, write_json


def person_ref(store: Store, ref: str) -> tuple[str, str | None, int | None]:
    """Resolve a report id or an author id to ``(card key, display name, author id)``.

    The key is the author id; a report without one falls back to its author's name.

    Raises:
        BugsError: If ``ref`` is neither digits nor the id of an existing report.
    """
    if re.fullmatch(r"\d+", ref):
        return ref, None, int(ref)
    _, report = load_report(store, ref)
    if report.get("author_id"):
        return str(report["author_id"]), report["author"], report["author_id"]
    slug = re.sub(r"[^0-9A-Za-z]+", "-", report["author"]).strip("-").lower() or "unknown"
    return f"name-{slug}", report["author"], None


def load_person(store: Store, key: str) -> dict | None:
    """Return a person's card, or ``None`` when there is none."""
    try:
        return json.loads((store.people / f"{key}.json").read_text())
    except FileNotFoundError:
        return None


def cmd_person(store: Store, ref: str) -> None:
    """Print what is remembered about a person: the name and the dated notes."""
    key, name, _ = person_ref(store, ref)
    card = load_person(store, key)
    if card is None and name is None:
        raise BugsError(f"no such person: {ref}")
    print(f"person: {(card or {}).get('name') or name}  key: {key}")
    if not card or not card["notes"]:
        print("no notes yet")
        return
    for note in card["notes"]:
        print(f"{note['date']}  {note['text']}")


def cmd_person_note(store: Store, ref: str, text: str, now: float) -> None:
    """Add a dated note to a person's card, creating it. Nothing is sent to Telegram.

    Raises:
        BugsError: If the text is empty.
    """
    text = text.strip()
    if not text:
        raise BugsError("empty note")
    key, name, author_id = person_ref(store, ref)
    card = load_person(store, key) or {"key": key, "name": name, "author_id": author_id, "notes": []}
    card["name"] = name or card["name"]
    card["notes"].append({"date": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds"), "text": text})
    write_json(store.people / f"{key}.json", card)
    print(f"noted {key}")


def cmd_backfill_authors(channel: Channel, store: Store, chat_id: int) -> None:
    """Record the user id of authors of reports written before ``author_id`` existed.

    Only when it is proven: the group's members are all administrators (the member count
    equals the administrator list), so a display name matching exactly one human
    administrator can only be that person. Anything else is left alone and said.
    """
    todo = [(rid, path, rep) for rid, path, rep in store.reports() if not rep.get("author_id")]
    if not todo:
        print("no report without an author id")
        return
    admins = channel.list_admins(chat_id)
    everyone_listed = channel.member_count(chat_id) <= len(admins)
    humans = [a["user"] for a in admins if not a["user"].get("is_bot")]
    for report_id, path, report in todo:
        same = [u for u in humans if (u.get("username") or u.get("first_name")) == report["author"]]
        if len(same) == 1 and everyone_listed:
            report["author_id"], report["author_username"] = same[0]["id"], same[0].get("username")
            write_json(path / "report.json", report)
            print(f"{report_id}  author id recorded")
        else:
            why = "several administrators share the name" if len(same) > 1 else (
                "no administrator has that name" if not same else "other members could share the name"
            )
            print(f"{report_id}  not proven, left alone: {why}")
