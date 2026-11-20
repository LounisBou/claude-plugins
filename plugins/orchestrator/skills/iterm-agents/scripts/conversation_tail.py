"""The end of a session's conversation with the operator, read from its transcript.

A succession loses the last exchanges between the operator and the predecessor: his questions, its
answers, the commands it showed him. The launcher reads them here, from the predecessor's
transcript, once it has said « handed over » and before its window is killed; nothing is asked of
the predecessor and nothing is written to a file. `section` returns the text the command prints.

The window is the operator's last 3 messages or the last 10 minutes, whichever reaches further
back; every reply of the session after the first of those messages is kept, its text parts only.
"""
import datetime
import json
import os
import re

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python before 3.9
    ZoneInfo = None

HEADING = "conversation:"
# The transcript's tail read: the window is its last minutes, never its whole length.
TAIL_BYTES = 4 * 1024 * 1024
WINDOW_MESSAGES = 3
WINDOW_SECONDS = 600
REPLY_CAP = 1500
SECTION_CAP = 12000
# The least a prose segment keeps beside a fenced block kept whole.
PROSE_FLOOR = 200
CUT = " […] "

FENCE = re.compile(r"```.*?```", re.S)
COMMAND_NAME = re.compile(r"<command-name>\s*([^<\s]+)\s*</command-name>")
# The origins that are not the operator's own typing.
OPERATOR_ORIGIN = "human"


def paris(moment):
    """`moment` (an aware datetime) as `HH:MM` in Paris time, UTC where the zone is unknown."""
    if ZoneInfo is not None:
        try:
            return moment.astimezone(ZoneInfo("Europe/Paris")).strftime("%H:%M")
        except Exception:
            pass
    return moment.astimezone(datetime.timezone.utc).strftime("%H:%M UTC")


def stamp(entry):
    """The aware datetime of a transcript entry's `timestamp`, or None."""
    raw = entry.get("timestamp")
    if not isinstance(raw, str):
        return None
    try:
        moment = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=datetime.timezone.utc)


def read_tail(path):
    """The complete lines of the last TAIL_BYTES of `path`."""
    with open(path, "rb") as fh:
        size = fh.seek(0, os.SEEK_END)
        fh.seek(max(0, size - TAIL_BYTES))
        data = fh.read()
    lines = data.split(b"\n")
    if size > TAIL_BYTES:
        # The first line is cut where the read began.
        lines = lines[1:]
    return [line.decode("utf-8", "replace") for line in lines if line.strip()]


def parts_text(content):
    """The text of a message's content: a string, or the `text` parts of a list. A `tool_result`
    or any other part carries none."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part["text"] for part in content
                         if isinstance(part, dict) and part.get("type") == "text"
                         and isinstance(part.get("text"), str))
    return ""


def operator_text(entry):
    """What the operator typed in a `user` entry, or None where the entry is not his: only the
    `human` origin counts, never a peer, a plugin, a task notification or a system prompt, a
    meta entry or a sidechain. A slash command's wrapper is its name."""
    origin = entry.get("origin")
    if (entry.get("type") != "user" or not isinstance(origin, dict)
            or origin.get("kind") != OPERATOR_ORIGIN or entry.get("promptSource") == "system"
            or entry.get("isMeta") or entry.get("isSidechain")):
        return None
    message = entry.get("message")
    text = parts_text(message.get("content") if isinstance(message, dict) else None).strip()
    named = COMMAND_NAME.search(text)
    if named:
        text = named.group(1)
    return text or None


def reply_text(entry):
    """The text parts of an orchestrator reply, or None: a sidechain, a synthetic message and an
    API error are not replies."""
    message = entry.get("message")
    if (entry.get("type") != "assistant" or entry.get("isSidechain")
            or entry.get("isApiErrorMessage") or not isinstance(message, dict)
            or message.get("model") == "<synthetic>"):
        return None
    text = parts_text(message.get("content")).strip()
    return text or None


def shorten(text, room):
    """`text` cut to `room` characters, its head and its tail kept."""
    if len(text) <= room:
        return text
    head = room * 6 // 10
    return text[:head].rstrip() + CUT + text[len(text) - (room - head):].lstrip()


def cap_reply(text, cap=REPLY_CAP):
    """`text` within about `cap` characters: head and tail of the prose kept, each fenced block
    whole, so a command shown to the operator is never cut."""
    if len(text) <= cap:
        return text
    fenced = list(FENCE.finditer(text))
    kept = sum(len(m.group(0)) for m in fenced)
    prose = len(text) - kept
    room = max(cap - kept, PROSE_FLOOR)
    out, at = [], 0
    for match in fenced + [None]:
        end = len(text) if match is None else match.start()
        piece = text[at:end]
        out.append(shorten(piece, max(room * len(piece) // max(prose, 1), 40)))
        if match is not None:
            out.append(match.group(0))
            at = match.end()
    return "".join(out)


def env_secrets(path):
    """The values of the operator's ~/.env worth hiding: `export` and quotes dropped, comments
    skipped, a value shorter than 8 characters left alone. `(keys, values)`."""
    keys, values = [], []
    try:
        with open(path, errors="replace") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return keys, values
    for raw in lines:
        found = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$", raw)
        if not found or raw.lstrip().startswith("#"):
            continue
        value = found.group(2)
        quoted = re.match(r"^(?:\"((?:[^\"\\]|\\.)*)\"|'([^']*)')\s*(?:#.*)?$", value)
        if quoted:
            value = quoted.group(1) if quoted.group(1) is not None else quoted.group(2)
        else:
            value = re.sub(r"\s+#.*$", "", value)
        if len(value) >= 8:
            values.append(value)
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", found.group(1)):
                keys.append(found.group(1))
    return keys, values


def mask(name):
    return "[REDACTED:%s]" % name


# The patterns of telemetry's `redact.ts`, small: the secrets that keep one shape, then the
# headers, the URLs and the assignments that name one. Each is `(name, regex, kept groups)`.
SECRET_KEY = (r"[A-Za-z0-9_.-]*(?:token|secret|pass|pwd|api[_-]?key|apikey|private[_-]?key"
              r"|access[_-]?key|client[_-]?secret|credential)s?[A-Za-z0-9_.-]*")
PATTERNS = [
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"), 0),
    ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"), 0),
    ("anthropic-key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{16,}"), 0),
    ("openai-key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}"), 0),
    ("aws-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), 0),
    ("slack-token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}"), 0),
    ("google-key", re.compile(r"\bAIza[0-9A-Za-z_-]{30,}"), 0),
    ("stripe-key", re.compile(r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}"), 0),
    ("telegram-token", re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{30,}"), 0),
    ("npm-token", re.compile(r"\bnpm_[A-Za-z0-9]{30,}"), 0),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), 0),
    ("authorization", re.compile(r"\b((?:proxy-)?authorization[\"']?\s*[:=]\s*[\"']?)(?!\[REDACTED)[^\s\"'][^\"'\r\n]*", re.I), 1),
    ("bearer", re.compile(r"\b((?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]{8,}", re.I), 1),
    ("url-credentials", re.compile(r"\b([a-z][a-z0-9+.-]*://)[^\s/@:]+(?::[^\s/@]*)?@", re.I), 1),
    ("url-secret", re.compile(r"([?&](?:access_token|token|key|api_key|apikey|secret|password|sig|signature|auth)=)[^&#\s\"']+", re.I), 1),
    ("secret-flag", re.compile(r"(--(?:[A-Za-z0-9]+-)*(?:token|secret|passw(?:or)?d|passwd|pass|api-?key|apikey|private-key|access-key|credentials?)(?:\s+|=))(?!\[REDACTED)(?:\"[^\"]*\"|'[^']*'|[^\s\"'-][^\s\"']*)", re.I), 1),
    ("secret-assignment", re.compile(r"\b(%s[\"']?\s*[:=]\s*[\"']?)(?!\[REDACTED)[^\s\"',;&|)}]+" % SECRET_KEY, re.I), 1),
]


def redact(text, env_path=None):
    """`text` with every secret replaced by `[REDACTED:<pattern>]`: the values and the
    assignments of the names in ~/.env first, then the fixed patterns."""
    keys, values = env_secrets(env_path or os.path.expanduser("~/.env"))
    if values:
        text = re.sub("|".join(re.escape(v) for v in sorted(values, key=len, reverse=True)),
                      mask("env"), text)
    if keys:
        text = re.sub(r"\b(?:%s)=(?:\"[^\"]*\"|'[^']*'|[^\s;&|]*)" % "|".join(map(re.escape, keys)),
                      mask("env"), text)
    for name, regex, keep in PATTERNS:
        text = regex.sub(lambda m, keep=keep, name=name: (m.group(1) if keep else "") + mask(name), text)
    return text


def messages(path):
    """`[(moment, who, text)]` of the transcript's tail in order, `who` being `operator` or
    `reply`. A line that is not JSON is skipped."""
    found = []
    for line in read_tail(path):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        moment = stamp(entry) if isinstance(entry, dict) else None
        if moment is None:
            continue
        said = operator_text(entry)
        if said is not None:
            found.append((moment, "operator", said))
            continue
        said = reply_text(entry)
        if said is not None:
            found.append((moment, "reply", said))
    return found


def window(found, now):
    """The entries of the window: from the operator's first message kept (the earlier of his
    3rd last and the first within 10 minutes of `now`) to the end."""
    sent = [moment for moment, who, _ in found if who == "operator"]
    if not sent:
        return []
    third = sent[-WINDOW_MESSAGES] if len(sent) >= WINDOW_MESSAGES else sent[0]
    start = min(third, now - datetime.timedelta(seconds=WINDOW_SECONDS))
    first = next(moment for moment in sent if moment >= start)
    return [item for item in found if item[0] >= first]


def exchanges(items, env_path=None):
    """The window's lines grouped by operator message: each group the operator's message and the
    replies that follow it, every line capped and masked."""
    groups = []
    for moment, who, text in items:
        line = "[%s] %s: %s" % (paris(moment), "operator" if who == "operator" else "orchestrator",
                                redact(cap_reply(text), env_path))
        if who == "operator" or not groups:
            groups.append([])
        groups[-1].append(line)
    return groups


def fit(groups, cap=SECTION_CAP):
    """The groups' lines within `cap` characters, the oldest exchange dropped first; the last
    line alone is cut to its tail where it still exceeds it."""
    def size(rows):
        return sum(len(line) + 1 for group in rows for line in group)
    groups = [list(group) for group in groups]
    while len(groups) > 1 and size(groups) > cap:
        groups.pop(0)
    while size(groups) > cap and len(groups[0]) > 1:
        # The operator's own message heads the group and goes last.
        groups[0].pop(1)
    if size(groups) > cap:
        groups[0][0] = groups[0][0][-cap:]
    return groups


def section(path, now, env_path=None):
    """The conversation section for a transcript at `now` (an aware datetime): its heading, then
    the window's lines in Paris time, masked and capped; a line saying so where there is none."""
    try:
        items = window(messages(path), now)
    except OSError as exc:
        return "%s the transcript %s cannot be read (%s)" % (HEADING, path, exc.__class__.__name__)
    if not items:
        return "%s no message of the operator in the transcript's last %d MiB" % (
            HEADING, TAIL_BYTES >> 20)
    groups = fit(exchanges(items, env_path))
    return "%s the end of the conversation with the operator, Paris time\n%s" % (
        HEADING, "\n".join(line for group in groups for line in group))
