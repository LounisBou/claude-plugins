"""The stack a pull request belongs to, and the order its merge re-runs the least CI in.

A stack is the pull request's base chain (each base the head branch of another open pull request of
the repository) and the open pull requests based on its head, transitively. A long-lived branch
(the default branch, a protected one, one under a ruleset) is no stack base: a release pull request's
head is not.

The order is read from the repository's workflow files at the stack's base. Where a `pull_request`
workflow runs for the pull requests based on the stacked branches, each pull request has CI at its
head: merging bottom-up re-runs none (the bottom merges on the base, the next is retargeted to it and
merges on its checks). Where none does but the base's pull requests have CI, only the bottom one has
any: merging top-down starts none in the stacked branches and the bottom one waits on its CI once.
A filter this reader cannot read, or any other case, is bottom-up: the gate of each merge never lets
one through past a red or missing check.
"""

import base64
import re
import sys
from urllib.parse import quote

from . import errors, http

BOTTOM_UP = "bottom-up"
TOP_DOWN = "top-down"

_WORKFLOWS = ".github/workflows"
_RUNS_ON = ("opened", "synchronize", "reopened")


def _same_repo(pull, owner, name):
    head_repo = ((pull.get("head") or {}).get("repo") or {}).get("full_name") or ""
    return head_repo.lower() == ("%s/%s" % (owner, name)).lower()


def _long_lived(owner, name, branch, default, reads):
    """Whether a branch can be no stack base: the default branch, a protected one, one under a ruleset. A read
    that fails says why on stderr and counts as long-lived, as the gate reads a pull request not stacked then."""
    if branch == default:
        return True
    quoted = quote(branch, safe="")
    try:
        if "protected:" + branch not in reads:
            info = http.rest("GET", "/repos/%s/%s/branches/%s" % (owner, name, quoted)) or {}
            rules = http.rest("GET", "/repos/%s/%s/rules/branches/%s" % (owner, name, quoted), paginate=True) or []
            reads["protected:" + branch] = bool(info.get("protected")) or bool(rules)
        return reads["protected:" + branch]
    except (errors.GhError, OSError) as exc:
        why = exc.message if isinstance(exc, errors.GhError) else exc
        print("error: cannot read whether %s is a stacked base: %s" % (branch, why), file=sys.stderr)
        return True


def members(owner, name, number):
    """The open pull requests of the stack of `number`, bottom first by depth: [{"pr", "head", "base", "depth"}].
    One member when the pull request is in no stack. A draft above is left out with all that stands on it;
    a draft below stays, merging `number` needs it."""
    pull = http.rest("GET", "/repos/%s/%s/pulls/%s" % (owner, name, number))
    if not isinstance(pull, dict) or pull.get("state") != "open":
        raise errors.UsageError("pull request %s is not open" % number)
    default = (((pull.get("base") or {}).get("repo")) or {}).get("default_branch") or ""
    opened = [p for p in (http.rest("GET", "/repos/%s/%s/pulls?state=open" % (owner, name), paginate=True) or []) if isinstance(p, dict)]
    by_head = {(p.get("head") or {}).get("ref"): p for p in opened if _same_repo(p, owner, name)}
    reads = {}

    # Down: the base chain, while each base is the head of another open pull request and no long-lived branch.
    chain = [pull]
    seen = {pull.get("number")}
    while True:
        base = (chain[0].get("base") or {}).get("ref")
        parent = by_head.get(base)
        if parent is None or parent.get("number") in seen or _long_lived(owner, name, base, default, reads):
            break
        chain.insert(0, parent)
        seen.add(parent.get("number"))

    # Up: the open pull requests based on a member's head, transitively.
    found = [(p, depth) for depth, p in enumerate(chain)]
    queue = [(pull, len(chain) - 1)]
    while queue:
        node, depth = queue.pop(0)
        head = (node.get("head") or {}).get("ref")
        if not _same_repo(node, owner, name) or _long_lived(owner, name, head, default, reads):
            continue
        for child in sorted((p for p in opened if (p.get("base") or {}).get("ref") == head), key=lambda p: p.get("number") or 0):
            if child.get("number") in seen:
                continue
            seen.add(child.get("number"))
            if child.get("draft") is True:
                # Work stacked on a delivery is a draft on purpose: it is left out, and all that stands on it.
                continue
            found.append((child, depth + 1))
            queue.append((child, depth + 1))

    return [
        {
            "pr": p.get("number"),
            "head": (p.get("head") or {}).get("ref"),
            "base": (p.get("base") or {}).get("ref"),
            "depth": depth,
        }
        for p, depth in sorted(found, key=lambda pair: (pair[1], pair[0].get("number") or 0))
    ]


# ---- what a workflow file says of the pull requests it runs for ----

def _clean(line):
    """A line of YAML without its comment and its trailing blanks."""
    out = []
    quote_char = ""
    for at, char in enumerate(line):
        if quote_char:
            if char == quote_char:
                quote_char = ""
        elif char in "\"'":
            quote_char = char
        elif char == "#" and (at == 0 or line[at - 1] in " \t"):
            break
        out.append(char)
    return "".join(out).rstrip()


def _unquote(word):
    word = word.strip()
    if len(word) >= 2 and word[0] == word[-1] and word[0] in "\"'":
        return word[1:-1]
    return word


def _indent(line):
    return len(line) - len(line.lstrip())


def _flow_list(value):
    """The words of an inline list `[a, b]` or a single word; None for what is neither."""
    value = value.strip()
    if value.startswith("["):
        if not value.endswith("]"):
            return None
        return [_unquote(w) for w in value[1:-1].split(",") if w.strip()]
    if not value or value[0] in "{|>&*!%@`" or "${{" in value:
        return None
    return [_unquote(value)]


def _block(lines, at):
    """The lines under lines[at], deeper than it, and the index after them."""
    base = _indent(lines[at])
    end = at + 1
    while end < len(lines) and (not lines[end].strip() or _indent(lines[end]) > base):
        end += 1
    return [l for l in lines[at + 1:end] if l.strip()], end


def _key(line):
    found = re.match(r"^\s*(?:-\s+)?[\"']?([A-Za-z0-9_-]+)[\"']?\s*:\s*(.*)$", line)
    return (found.group(1), found.group(2)) if found else (None, None)


def _list_value(lines, at, value):
    """The words a key holds, inline or as `- item` lines under it; None when they cannot be read."""
    if value.strip():
        return _flow_list(value)
    body, _ = _block(lines, at)
    words = []
    for line in body:
        stripped = line.strip()
        if not stripped.startswith("- "):
            return None
        word = _flow_list(stripped[2:])
        if word is None or len(word) != 1:
            return None
        words.extend(word)
    return words


_GLOB_UNREADABLE = re.compile(r"[?+\[\]]")


def _glob(pattern, branch):
    """Whether a branch name matches a GitHub filter pattern (`*` inside a path segment, `**` across them);
    None for a pattern this reader does not read."""
    if _GLOB_UNREADABLE.search(pattern):
        return None
    out = ""
    at = 0
    while at < len(pattern):
        if pattern.startswith("**", at):
            out += ".*"
            at += 2
        elif pattern[at] == "*":
            out += "[^/]*"
            at += 1
        else:
            out += re.escape(pattern[at])
            at += 1
    return re.fullmatch(out, branch) is not None


def _accepts(patterns, branch, ignore):
    """Whether a `branches` (or `branches-ignore`) filter lets a base through; None when it cannot be told."""
    if ignore:
        for pattern in patterns:
            hit = _glob(pattern, branch)
            if hit is None:
                return None
            if hit:
                return False
        return True
    if not any(not p.startswith("!") for p in patterns):
        return None
    verdict = False
    for pattern in patterns:
        negated = pattern.startswith("!")
        hit = _glob(pattern[1:] if negated else pattern, branch)
        if hit is None:
            return None
        if hit:
            verdict = not negated
    return verdict


def _pull_request_filter(text):
    """What the `on:` of a workflow file says of `pull_request`: False when it does not run for one, True
    or a ("branches"|"branches-ignore", patterns) filter when it does, None when the file cannot be read."""
    lines = [_clean(l) for l in text.splitlines()]
    lines = [l for l in lines if l.strip()]
    at = next((i for i, l in enumerate(lines) if re.match(r"^[\"']?on[\"']?\s*:", l)), None)
    if at is None:
        return None
    value = lines[at].split(":", 1)[1].strip()
    if value:
        if value.startswith("{") or "${{" in value:
            return None if "pull_request" in value else False
        events = _flow_list(value)
        return None if events is None else "pull_request" in events
    body, _ = _block(lines, at)
    first = next((l for l in body if l.strip()), "")
    if first.strip().startswith("- "):
        events = [_unquote(l.strip()[2:]) for l in body if l.strip().startswith("- ")]
        return "pull_request" in events
    level = _indent(first)
    start = next((i for i, l in enumerate(body) if _indent(l) == level and _key(l)[0] == "pull_request"), None)
    if start is None:
        return False
    event_value = _key(body[start])[1].strip()
    if event_value and event_value != "{}":
        return None if event_value[0] in "{[" or "${{" in event_value else True
    under, _ = _block(body, start)
    filters = {}
    types = None
    cursor = 0
    while cursor < len(under):
        key, val = _key(under[cursor])
        if key in ("branches", "branches-ignore", "types"):
            words = _list_value(under, cursor, val)
            if words is None:
                return None
            if key == "types":
                types = words
            else:
                filters[key] = words
        cursor += 1
    if types is not None and not any(t in _RUNS_ON for t in types):
        return False
    if "branches" in filters and "branches-ignore" in filters:
        return None
    if filters:
        key, patterns = next(iter(filters.items()))
        return (key, patterns)
    return True


def _runs_for(text, branch):
    """Whether a workflow file runs on a pull request based on `branch`: True, False, or None when it cannot be told."""
    filtered = _pull_request_filter(text)
    if filtered is None or isinstance(filtered, bool):
        return filtered
    return _accepts(filtered[1], branch, filtered[0] == "branches-ignore")


def _workflow_texts(owner, name, ref):
    """The workflow files of the repository at a ref, their texts; None when they cannot be read."""
    quoted = quote(ref, safe="")
    try:
        listing = http.rest("GET", "/repos/%s/%s/contents/%s?ref=%s" % (owner, name, _WORKFLOWS, quoted))
    except errors.NotFound:
        return []
    except (errors.GhError, OSError):
        return None
    if not isinstance(listing, list):
        return None
    texts = []
    for entry in listing:
        path = entry.get("path") if isinstance(entry, dict) else None
        if not isinstance(path, str) or not path.endswith((".yml", ".yaml")):
            continue
        try:
            answer = http.rest("GET", "/repos/%s/%s/contents/%s?ref=%s" % (owner, name, quote(path, safe="/"), quoted))
            raw = answer.get("content") if isinstance(answer, dict) else None
            texts.append(base64.b64decode(raw).decode("utf-8") if isinstance(raw, str) else None)
        except (errors.GhError, OSError, ValueError):
            return None
        if texts[-1] is None:
            return None
    return texts


def _ci_for(texts, branch):
    """Whether any workflow runs on a pull request based on `branch`; None when one cannot be told."""
    states = [_runs_for(text, branch) for text in texts]
    if any(s is True for s in states):
        return True
    return None if any(s is None for s in states) else False


def order(owner, name, stack_members):
    """(order, why) of a merge of the stack: see the module's text."""
    bottom = min(stack_members, key=lambda m: m["depth"])
    base = bottom["base"]
    stacked = sorted({m["base"] for m in stack_members if m["depth"] > bottom["depth"]})
    texts = _workflow_texts(owner, name, base)
    if texts is None:
        return BOTTOM_UP, "the workflow files of %s cannot be read" % base
    on_base = _ci_for(texts, base)
    on_stacked = [_ci_for(texts, branch) for branch in stacked]
    if on_base is None or None in on_stacked:
        return BOTTOM_UP, "a pull_request filter of %s cannot be read" % base
    if on_base and not any(on_stacked):
        return TOP_DOWN, "no workflow runs for a pull request based on a stacked branch"
    if any(on_stacked):
        return BOTTOM_UP, "a workflow runs for a pull request based on a stacked branch"
    return BOTTOM_UP, "no workflow runs for a pull request of %s" % base


def plan(owner, name, number):
    """{"stack": {"order", "why", "base", "members"}} for a pull request in a stack of several, else None."""
    found = members(owner, name, number)
    if len(found) < 2:
        return None
    how, why = order(owner, name, found)
    bottom = min(found, key=lambda m: m["depth"])
    return {"stack": {"order": how, "why": why, "base": bottom["base"], "members": found}}
