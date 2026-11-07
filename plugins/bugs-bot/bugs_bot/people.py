"""People: what the agent remembers about each reporter, one card per author (notes, language), and recovering the user id of older reports' authors."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from datetime import datetime, timezone
from typing import TypeVar

from bugs_bot.channel import Author, Channel, ChatId
from bugs_bot.errors import BugsError
from bugs_bot.store import Store, load_report, locked, update_report, write_json

T = TypeVar("T")


# A language as a card stores it: the two lower-case letters of ISO 639-1.
_LANGUAGE = re.compile(r"[a-z]{2}")


def card_key(author_id: int | str | None, author: str) -> str:
    """Return the card key of an author: their id, else ``name-<slug of their display name>``."""
    if author_id:
        return str(author_id)
    slug = re.sub(r"[^0-9A-Za-z]+", "-", author).strip("-").lower() or "unknown"
    return f"name-{slug}"


def person_ref(store: Store, ref: str) -> tuple[str, str | None, int | str | None]:
    """Resolve a report id or an author id to ``(card key, display name, author id)``.

    The key is the author id; a report without one falls back to its author's name. An author id is
    digits (Telegram's) or the key of an existing card (a Slack member id, ``U…``).

    Raises:
        BugsError: If ``ref`` is neither digits, nor a card's key, nor the id of an existing report.
    """
    if re.fullmatch(r"\d+", ref):
        return ref, None, int(ref)
    card = load_person(store, ref) if re.fullmatch(r"[0-9A-Za-z]+", ref) else None
    if card is not None:
        return ref, card.get("name"), card.get("author_id")
    _, report = load_report(store, ref)
    return card_key(report.get("author_id"), report["author"]), report["author"], report.get("author_id") or None


def load_person(store: Store, key: str) -> dict | None:
    """Return a person's card, or ``None`` when there is none."""
    try:
        return json.loads((store.people / f"{key}.json").read_text())
    except FileNotFoundError:
        return None


def card_of(store: Store, key: str, name: str | None, author_id: int | str | None) -> dict:
    """Return a person's card, or a new empty one (not yet written)."""
    card = load_person(store, key) or {"key": key, "name": name, "author_id": author_id, "notes": []}
    card["name"] = name or card["name"]
    return card


def update_card(store: Store, key: str, change: Callable[[dict], T], name: str | None, author_id: int | str | None) -> T:
    """Change a person's card under the project's lock: read it (or a new one, as ``card_of`` makes it), let
    ``change`` mutate it, write it back atomically.

    Args:
        store: The project's store.
        key: The card's key (``card_key``).
        change: Mutates the card it is given (the one on disk now); its result is returned.
        name: The person's display name, kept over the card's when given.
        author_id: The person's user id, for a card created here.

    Returns:
        What ``change`` returned.
    """
    with locked(store):
        card = card_of(store, key, name, author_id)
        result = change(card)
        write_json(store.people / f"{key}.json", card)
        return result


def record_language(store: Store, author: Author) -> None:
    """Record the language the platform gives for ``author`` on their card, on first sight only.

    The first two letters of the platform's code, lower-cased (« fr-FR » is ``fr``). A language
    already on the card — the platform's earlier one or the agent's correction — is never
    overwritten; a code that does not give two letters is ignored.
    """
    code = (author.language or "")[:2].lower()
    if not _LANGUAGE.fullmatch(code):
        return
    key = card_key(author.id, author.name)
    card = load_person(store, key)
    if card is not None and card.get("language"):
        return  # nothing to write: a card is not rewritten for every message

    def first_sight(fresh: dict) -> None:
        if not fresh.get("language"):  # the agent may have set one since the read above
            fresh["language"] = code

    update_card(store, key, first_sight, author.name or None, author.id)


def cmd_person_lang(store: Store, ref: str, code: str) -> None:
    """Set a person's language: the agent's correction when they write in another one than their card says.

    Raises:
        BugsError: If ``code`` is not two lower-case letters, or ``ref`` names no report nor author id.
    """
    if not _LANGUAGE.fullmatch(code):
        raise BugsError(f"not a language code: {code!r} (two lower-case letters, e.g. fr, en)")
    key, name, author_id = person_ref(store, ref)
    update_card(store, key, lambda card: card.update(language=code), name, author_id)
    print(f"language {key}: {code}")


def language_of(store: Store, project_language: str, author_id: int | str | None, author: str) -> str:
    """Return the language to write to a person in: their card's, else the project's default."""
    card = load_person(store, card_key(author_id, author)) or {}
    return card.get("language") or project_language


def cmd_person(store: Store, ref: str) -> None:
    """Print what is remembered about a person: the name, the language and the dated notes."""
    key, name, _ = person_ref(store, ref)
    card = load_person(store, key)
    if card is None and name is None:
        raise BugsError(f"no such person: {ref}")
    print(f"person: {(card or {}).get('name') or name}  key: {key}")
    print(f"language: {(card or {}).get('language') or 'unknown'}")
    for question in (card or {}).get("questions", []):
        print(f"question queued {question['queued'][:16]} for {question['report']}: {question['text']}")
    if not card or not card["notes"]:
        print("no notes yet")
        return
    for note in card["notes"]:
        print(f"{note['date']}  {note['text']}")


def cmd_person_note(store: Store, ref: str, text: str, now: float) -> None:
    """Add a dated note to a person's card, creating it. Nothing is sent to the group.

    Raises:
        BugsError: If the text is empty.
    """
    text = text.strip()
    if not text:
        raise BugsError("empty note")
    key, name, author_id = person_ref(store, ref)
    note = {"date": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds"), "text": text}
    update_card(store, key, lambda card: card["notes"].append(note), name, author_id)
    print(f"noted {key}")


def cmd_backfill_authors(channel: Channel, store: Store, chat_id: ChatId) -> None:
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
    humans = [a for a in admins if not a.is_bot]
    for report_id, _, report in todo:
        same = [a for a in humans if a.name == report["author"]]
        if len(same) == 1 and everyone_listed:
            update_report(store, report_id, lambda fresh, admin=same[0]: fresh.update(author_id=admin.id, author_username=admin.username))
            print(f"{report_id}  author id recorded")
        else:
            why = "several administrators share the name" if len(same) > 1 else (
                "no administrator has that name" if not same else "other members could share the name"
            )
            print(f"{report_id}  not proven, left alone: {why}")
