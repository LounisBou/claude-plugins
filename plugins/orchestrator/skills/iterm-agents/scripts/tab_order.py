"""The order of the app's tabs as the operator arranged it, kept across the closes and the reopenings.

Every reading of the app is woven into the record: the tabs on screen take the order they have there
(the latest reading wins, a tab moved by hand included), and a tab no longer on screen keeps its
place after the tab it followed. A session reopened later goes back to that place.

An entry is `{"name", "session", "tab"}`: the session's name, what else tells it (its session id, a
home server's socket) or "", and the app's id of its tab, which anchors a move while the app runs. A
tty is never part of it: it changes at every reopening. A closed entry also has `gone`, the time of
the first reading without it. A window is `{"window", "tabs"}`.
"""

# The closed tabs kept in one window, and the windows kept with no tab left open: the newest.
KEPT_GONE = 32
KEPT_WINDOWS = 4


def same(a, b):
    """Whether two entries are of one session: by its session id, or by its name, since a move to
    the other plan starts a new conversation under the same name."""
    return bool(a["session"] and a["session"] == b["session"]
                or a["name"] and a["name"] == b["name"])


def twins_of(old, base, same_window):
    """`{index in old: entry of base}`, each entry of `base` claimed once, the closest first: the
    same tab under the same name (a nameless tab is known by nothing else), the same session id,
    the same name and, in the window of the same id, the same tab for an entry with no session
    id: a shell retitles itself. The app gives new ids when it starts again."""
    found, claimed = {}, set()
    matches = [lambda a, b: bool(a["tab"]) and a["tab"] == b["tab"] and a["name"] == b["name"],
               lambda a, b: bool(a["session"]) and a["session"] == b["session"],
               lambda a, b: bool(a["name"]) and a["name"] == b["name"]]
    if same_window:
        matches.append(lambda a, b: not (a["session"] or a.get("gone"))
                       and bool(a["tab"]) and a["tab"] == b["tab"])
    for match in matches:
        for i, entry in enumerate(old):
            if i in found:
                continue
            for j, other in enumerate(base):
                if j not in claimed and match(entry, other):
                    found[i], _ = other, claimed.add(j)
                    break
    return found


def woven(old, base, live, now, same_window=False):
    """`base`, in its own order, with the entries of `old` it lacks and no tab of `live` shows,
    each marked closed and put after the one it followed, else before the one it preceded."""
    result, twins = list(base), twins_of(old, base, same_window)
    previous, leading = None, []

    def place(entries, at):
        result[at:at] = entries

    def index(entry):
        return next(i for i, other in enumerate(result) if other is entry)

    for i, entry in enumerate(old):
        if i in twins:
            if leading:
                place(leading, index(twins[i]))
                leading = []
            previous = twins[i]
            continue
        # A nameless tab cannot be reopened, and a session a tab shows is not closed.
        if not entry["name"] or any(same(entry, other) for other in live):
            continue
        closed = dict(entry, gone=entry.get("gone") or now)
        if previous is None:
            leading.append(closed)
        else:
            place([closed], index(previous) + 1)
            previous = closed
    place(leading, 0)
    return result


def capped(tabs):
    closed = sorted((e for e in tabs if e.get("gone")), key=lambda e: e["gone"])
    dropped = closed[:max(0, len(closed) - KEPT_GONE)]
    return [e for e in tabs if not any(e is d for d in dropped)]


def shared(recorded, tabs):
    return sum(1 for e in tabs if any(same(e, other) for other in recorded["tabs"]))


def merge(record, windows, now):
    """The record after a reading: `windows` is what the app shows, `record` what was kept."""
    live = [entry for window in windows for entry in window["tabs"]]
    rest, result = list(record), []
    for window in windows:
        base = next((w for w in rest if window["window"] and w["window"] == window["window"]), None)
        if base is not None:
            rest.remove(base)
        result.append({"window": window["window"],
                       "tabs": woven(base["tabs"] if base else [], window["tabs"], live, now,
                                     base is not None)})
    # Only once every window the app shows has its own record, whatever order it lists them in,
    # is a record left over given to another one.
    closed_windows = []
    for recorded in rest:
        # The app gives a window a new id when it starts again: a recorded one whose session a
        # window now shows is that window's.
        host = max(result, key=lambda w: shared(recorded, w["tabs"]), default=None)
        if host and shared(recorded, host["tabs"]):
            host["tabs"] = woven(recorded["tabs"], host["tabs"], live, now)
            continue
        tabs = woven(recorded["tabs"], [], live, now)
        if tabs:
            closed_windows.append({"window": recorded["window"], "tabs": tabs})
    result += closed_windows[:KEPT_WINDOWS]
    return [{"window": w["window"], "tabs": capped(w["tabs"])} for w in result]


def open_tab_named(windows, name):
    """The tab id of a tab on screen under `name`, or "": the one a new session of that name
    replaces."""
    return next((e["tab"] for w in windows for e in w["tabs"] if name and e["name"] == name), "")


def place_of(record, name, session):
    """Where a session closed earlier goes back, as `(tab id of an open neighbour, side)`: right
    of the nearest open tab it followed, else left of the nearest one it preceded. None when the
    record holds no closed entry of it, or none of its window's tabs is open. Its session id
    first, then its name; of two, the one closed last."""
    for key, wanted in (("session", session), ("name", name)):
        found = [(e["gone"], w["tabs"], i) for w in record for i, e in enumerate(w["tabs"])
                 if e.get("gone") and wanted and e[key] == wanted]
        if found:
            _, tabs, at = max(found, key=lambda hit: hit[0])
            before = [e["tab"] for e in tabs[:at] if not e.get("gone") and e["tab"]]
            after = [e["tab"] for e in tabs[at + 1:] if not e.get("gone") and e["tab"]]
            if before:
                return before[-1], "right"
            return (after[0], "left") if after else None
    return None


def valid(record):
    """`record` when it reads as one, else an empty one: a file's value."""
    def entry(e):
        return (isinstance(e, dict) and all(isinstance(e.get(k), str)
                                            for k in ("name", "session", "tab"))
                and type(e.get("gone", 0)) in (int, float))
    if isinstance(record, list) and all(
            isinstance(w, dict) and isinstance(w.get("window"), str)
            and isinstance(w.get("tabs"), list) and all(map(entry, w["tabs"])) for w in record):
        return record
    return []
