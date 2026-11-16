"""The Related PRs a new pull request names, each named back in the open pull request's own list."""

import re
import sys

from . import errors, http

_LABEL = "**Related PRs:**"
_PULL_URL = re.compile(r"https://github\.com/([^\s/]+)/([^\s/]+)/pull/(\d+)", re.IGNORECASE)


def _key(match):
    return (match.group(1).lower(), match.group(2).lower(), int(match.group(3)))


def _section(lines):
    """The label's line and the end of its items (the first blank line after it), or None."""
    for at, line in enumerate(lines):
        if line.strip().startswith(_LABEL):
            end = at + 1
            while end < len(lines) and lines[end].strip():
                end += 1
            return at, end
    return None


def named(body):
    """The pull requests the body's Related PRs section names, as (owner, repo, number), in order."""
    lines = body.split("\n")
    section = _section(lines)
    if not section:
        return []
    found = []
    for line in lines[section[0]:section[1]]:
        for match in _PULL_URL.finditer(line):
            if _key(match) not in found:
                found.append(_key(match))
    return found


def with_item(body, url):
    """The body with the pull request added to its Related PRs section, or None when it has no such
    section or names the pull request already."""
    newline = "\r\n" if "\r\n" in body else "\n"
    lines = body.split(newline)
    section = _section([line.rstrip("\r") for line in lines])
    match = _PULL_URL.search(url)
    if not section or not match or _key(match) in named(body.replace("\r\n", "\n")):
        return None
    at, end = section
    if lines[at].strip()[len(_LABEL):].strip().lower() == "none":
        lines[at] = _LABEL
    lines.insert(end, "- " + url)
    return newline.join(lines)


def backfill(url, body):
    """Name the new pull request in the Related PRs of each open pull request its own list names.
    Answers the pull requests changed as `owner/repo#N`. A pull request that cannot be read or
    written is printed on its own line on stderr and never fails the command."""
    changed = []
    for owner, name, number in named(body.replace("\r\n", "\n")):
        path = "/repos/%s/%s/pulls/%s" % (owner, name, number)
        label = "%s/%s#%s" % (owner, name, number)
        try:
            pull = http.rest("GET", path)
            if not isinstance(pull, dict):
                raise errors.ApiError("unexpected answer")
            text = pull.get("body") or ""
            if pull.get("state") != "open" or not text:
                continue
            updated = with_item(text, url)
            if updated is None:
                continue
            http.rest("PATCH", path, {"body": updated})
            changed.append(label)
        except errors.GhError as exc:
            print("error: related pull request %s not updated: %s" % (label, exc.message), file=sys.stderr)
        except OSError as exc:
            print("error: related pull request %s not updated: %s" % (label, exc), file=sys.stderr)
    return changed
