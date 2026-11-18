"""The mechanical rules of engine/writing/ for a pull request's title and description.

pr-create and pr-update refuse a title or a body that breaks one, naming the rule, before anything is
sent. Only what code can decide without judgement is here: a semicolon in prose, a trailer of any
kind, a title on more than one line or far past « about sixty characters », a heading in a
description, a TODO item that points to another or joins two actions, a CVE id that is no link, a
security update without its tables, the four sections a description of a GeoNative repository ends
with and any text after them, a pull request reference, a negative phrase or a bold label in its
summary, a horizontal rule other than the `---` between two screenshots. The workflow vocabulary is
left out: « session » and « agent » are also real product words, and a refusal there would be a guess.

Patterns read ASCII word characters, as the rules were first written for.
"""

import json
import os
import re

from . import errors

# Past this a title is no longer « about sixty characters »: the margin keeps a title of 62 or 65
# characters, which the rule's « about » allows, out of reach.
TITLE_MAX = 72

# The GitHub organisation that holds GeoNative's repositories, whatever the case.
GEONATIVE_OWNER = "geonativefr"

# The four sections every description of a GeoNative repository ends with, in this order.
SECTIONS = ("TODO Staging", "TODO Prod", "PRs Dependency", "Related PRs")

# The phrasings that state what a pull request does not do, refused in a summary and in an image title.
with open(os.path.join(os.path.dirname(__file__), os.pardir, "negative-phrases.json"), encoding="utf-8") as _fh:
    NEGATIVE_PHRASES = tuple(json.load(_fh)["phrases"])

_A = re.ASCII
_I = re.ASCII | re.IGNORECASE


def negative_pattern(phrases):
    """The phrases as one whole-word, case-insensitive pattern, or None for none."""
    if not phrases:
        return None
    return re.compile(r"(?<![\w-])(%s)(?![\w-])" % "|".join(re.escape(p) for p in phrases), _I)


_NEGATIVE = negative_pattern(NEGATIVE_PHRASES)


def is_geonative(owner):
    return owner.strip().lower() == GEONATIVE_OWNER


_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def prose_lines(text, fenced=None):
    """The lines outside fenced code blocks. A fence closes on a run of its character at least as
    long, and an unclosed one runs to the end, as GitHub draws it. Given `fenced`, each line of a
    fenced block, its fences included, is kept as that text instead of left out."""
    out = []
    fence = None
    for line in re.split(r"\r?\n", text):
        marker = _FENCE.match(line)
        run = marker.group(1) if marker else ""
        if fence:
            if marker and run[0] == fence[0] and len(run) >= fence[1] and line.strip() == run:
                fence = None
            if fenced is not None:
                out.append(fenced)
            continue
        if marker:
            fence = (run[0], len(run))
            if fenced is not None:
                out.append(fenced)
            continue
        out.append(line)
    return out


_CODE_SPAN = re.compile(r"(`+)[\s\S]*?\1")
_AUTOLINK = re.compile(r"<[a-z][a-z0-9+.-]*:[^>\s]*>", _I)
_URL = re.compile(r"\b[a-z][a-z0-9+.-]*://\S+", _I)
_CHAR_REF = re.compile(r"&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);", _I)


def _strip(line):
    """A prose line with code spans, URLs, autolinks and character references taken out."""
    line = _CODE_SPAN.sub(" ", line)
    line = _AUTOLINK.sub(" ", line)
    line = _URL.sub(" ", line)
    return _CHAR_REF.sub(" ", line)


# A trailer of any kind: the `<word>-by` family, Claude-Session and Change-Id.
_TRAILER = re.compile(r"^\s*([a-z]+(-[a-z]+)*-by|claude-session|change-id)\s*:", _I)
_HEADING = re.compile(r"^ {0,3}#{1,6}(\s|$)", _A)
_TODO_LABEL = re.compile(r"^\*\*TODO (Staging|Prod):\*\*\s*$", _A)
_BOLD_LABEL = re.compile(r"^\*\*([^*]+):\*\*(.*)$", _A)
_ITEM = re.compile(r"^[-*+]\s", _A)
_BOX = re.compile(r"^[-*+]\s+\[[ xX]\]\s", _A)

_DESCRIPTIONS = " (writing/pull-requests.md, « Pull request descriptions »)"
SEMICOLON_RULE = ("no semicolon in prose (writing/pull-requests.md and writing/comments.md);"
                  " code in backticks or a fenced block may keep one")
TRAILER_RULE = "no trailer of any kind, such as Co-Authored-By, Signed-off-by or Claude-Session (writing/commits.md)"
TITLE_LINE_RULE = "a title is one line (writing/pull-requests.md, « Pull request titles »)"
TITLE_LENGTH_RULE = "a title is about sixty characters at most, this one has %d (writing/pull-requests.md, « Pull request titles »)"
HEADING_RULE = "no heading of any kind in a pull request description, it starts with the summary text" + _DESCRIPTIONS
TODO_RULE = ("a TODO Staging or TODO Prod item is a task-list checkbox, `- [ ] <step>`, never a bare `- ` bullet"
             + _DESCRIPTIONS)
TODO_ALONE_RULE = ("a TODO item stands alone, it never points to another item (« the same edit », « same as above »,"
                   " « likewise ») and writes the action in full" + _DESCRIPTIONS)
TODO_ONE_RULE = ("one checkbox, one action: an edit and the restart, reload or deploy that applies it are two"
                 " checkboxes, never joined by « then » or « and run »" + _DESCRIPTIONS)
CVE_LINK_RULE = ("a CVE id is a markdown link to its advisory, `[CVE-YYYY-NNNNN](<advisory URL>)`, never bare and"
                 " never in a code span (writing/security-updates.md)")
CVE_TABLE_RULE = ("a description whose first line names CVE ids has one table per advisory, with the Package,"
                  " Advisory, Affected and Reference rows, its Advisory row naming the CVE id"
                  " (writing/security-updates.md)")
MISSING_RULE = "a pull request description ends with the four sections, missing here: %s" + _DESCRIPTIONS
ORDER_RULE = "the four sections come in this order: " + ", ".join(SECTIONS) + ", each once" + _DESCRIPTIONS
EMPTY_RULE = ("an empty section is written `**<Label>:** none` on the label's line, never a label with nothing"
              " after it" + _DESCRIPTIONS)
NONE_ITEMS_RULE = "a section is either `none` on its label's line or its items below the label, never both" + _DESCRIPTIONS
LABEL_TEXT_RULE = "a section's label line holds the label alone, or the label and `none`, nothing else" + _DESCRIPTIONS
OTHER_LABEL_RULE = ("no bold label line other than the four sections, "
                    + ", ".join("`**%s:**`" % s for s in SECTIONS) + _DESCRIPTIONS)
REF_RULE = ("no pull request reference in the summary above the sections, `#N`, `repo#N`, `owner/repo#N` or a pull"
            " request URL: it goes in PRs Dependency or Related PRs" + _DESCRIPTIONS)
AFTER_RULE = "nothing after the four sections, a description ends with Related PRs" + _DESCRIPTIONS
RULE_LINE_RULE = ("no horizontal rule, `---`, `***` or `___`, in a pull request description" + _DESCRIPTIONS
                  + ": a `---` is kept only between two screenshots, a blank line before it")


def negative_rule(phrases):
    return ("state what the PR does, never what it does not do (the phrasings refused: "
            + ", ".join("« %s »" % p for p in phrases) + ")" + _DESCRIPTIONS)


def _todo_lines(lines):
    """The lines of the TODO sections: from a TODO label to the next bold label or prose line."""
    in_todo = False
    for raw in lines:
        line = raw.strip()
        if _TODO_LABEL.search(line):
            in_todo = True
            continue
        if _BOLD_LABEL.search(line):
            in_todo = False
            continue
        if not in_todo or line == "":
            continue
        yield line
        if not _ITEM.search(line):
            in_todo = False


def _bare_todo_item(lines):
    return any(_ITEM.search(line) and not _BOX.search(line) for line in _todo_lines(lines))


_POINTER = re.compile(r"\b(the same (edit|change|step|steps|command)|same as (above|before)|as above|as before|likewise)\b", _I)
_JOINED = re.compile(r"\b(then|and run)\b", _I)


def _todo_items(lines):
    """The checkbox items of the TODO sections, as prose with code spans taken out."""
    return [_strip(re.sub(r"^[-*+]\s+(\[[ xX]\]\s+)?", "", line, flags=_A))
            for line in _todo_lines(lines) if _ITEM.search(line)]


_CVE = re.compile(r"\bCVE-\d{4}-\d{4,}\b", _I)
# An inline link, a title after its URL included, or a reference link.
_CVE_LINK = re.compile(r"\[CVE-\d{4}-\d{4,}\](\([^)]*\)|\[[^\]]*\])", _I)
_TABLE_ROW = re.compile(r"^\s*\|\s*([^|]*?)\s*\|")


def _without_urls(line):
    """A line with its URLs taken out: a URL that holds a CVE id names no id. A link keeps its text."""
    line = re.sub(r"\]\([^)\s]+\)", "]", line)
    line = _AUTOLINK.sub(" ", line)
    return _URL.sub(" ", line)


def _bare_cve(lines):
    return any(_CVE.search(_without_urls(_CVE_LINK.sub(" ", line))) for line in lines)


def _cve_ids(text):
    return [m.group(0).upper() for m in _CVE.finditer(text)]


def _missing_cve_tables(lines):
    """A security update, its first line naming CVE ids, without its tables."""
    first = next((line for line in lines if line.strip() != ""), None)
    ids = _cve_ids(_without_urls(first)) if first is not None else []
    if not ids:
        return False
    tables = []
    table = None
    for line in lines:
        if not re.match(r"^\s*\|", line):
            table = None
            continue
        if table is None:
            table = []
            tables.append(table)
        table.append(line)

    def label(row):
        m = _TABLE_ROW.search(row)
        return m.group(1) if m else ""

    advisories = [rows for rows in tables if any(label(row) == "Advisory" for row in rows)]
    if any(not all(any(label(row) == name for row in rows) for name in ("Package", "Affected", "Reference"))
           for rows in advisories):
        return True
    named = {i for rows in advisories for row in rows if label(row) == "Advisory" for i in _cve_ids(_without_urls(row))}
    return any(i not in named for i in ids)


_HORIZONTAL_RULE = re.compile(r"^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$")
# A closing keyword links an issue, which GitHub reads only in the description.
_CLOSING = re.compile(r"\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+([\w.-]+(/[\w.-]+)?)?#\d+\b", _I)
# A bare `#N` that is no 3- or 6-hex-digit colour, or a `repo#N` whose repository has a name's
# shape: starting with a letter, its dots never before a digit, so a version such as `v1.2#3` is none.
_BARE_REF = re.compile(
    r"(^|[^\w&#/])#(?![0-9a-f]{3}\b|[0-9a-f]{6}\b)\d+\b"
    r"|(?<![\w./-])([A-Za-z0-9][\w.-]*/)?[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)*#\d+\b", _I)
# A link's target, `](…)`: an anchor such as `#2-deploy-it` is no reference.
_LINK_TARGET = re.compile(r"\]\([^)]*\)")
_PR_URL = re.compile(r"\bhttps?://github\.com/[^\s/]+/[^\s/]+/pull/\d+", _I)


def _without_images(line):
    """A line with its images and HTML tags taken out: a screenshot is never prose."""
    line = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", line)
    return re.sub(r"<[a-z][^>]*>", " ", line, flags=_I)


# A screenshot: its title in bold alone on its line, no colon at its end, its image on the next.
_SHOT_TITLE = re.compile(r"^\*\*([^*]+)\*\*$")
_SHOT_IMAGE = re.compile(r"^(!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>)$", _I)


def _shot_title(line):
    m = _SHOT_TITLE.search(line.strip())
    return bool(m) and not m.group(1).strip().endswith(":")


def _shot_image(line):
    return bool(_SHOT_IMAGE.search(line.strip()))


def _shot_separator(lines, i, summary_end):
    """A `---` between two screenshots in the summary, a blank line right above it."""
    def at(k):
        return lines[k] if 0 <= k < len(lines) else ""

    if at(i).strip() != "---" or i >= summary_end:
        return False
    if i < 3 or at(i - 1).strip() != "":
        return False
    above = i - 1
    while above >= 0 and at(above).strip() == "":
        above -= 1
    if above < 1 or not _shot_image(at(above)) or not _shot_title(at(above - 1)):
        return False
    below = i + 1
    while below < summary_end and at(below).strip() == "":
        below += 1
    return below + 1 < summary_end and _shot_title(at(below)) and _shot_image(at(below + 1))


def _section_label(line):
    """The section a line labels, its index in SECTIONS (-1 for another bold label), and its rest."""
    m = _BOLD_LABEL.search(line.strip())
    if not m:
        return None
    name = m.group(1).strip()
    return (SECTIONS.index(name) if name in SECTIONS else -1, m.group(2).strip())


def _section_faults(lines):
    faults = []

    def add(rule):
        if rule not in faults:
            faults.append(rule)

    seen = []
    for i, line in enumerate(lines):
        label = _section_label(line)
        if not label:
            continue
        index, rest = label
        if index < 0:
            add(OTHER_LABEL_RULE)
            continue
        seen.append(index)
        items = 0
        j = i + 1
        while j < len(lines) and lines[j].strip() != "" and not _section_label(lines[j]):
            items += 1
            j += 1
        none = rest == "none"
        if rest != "" and not none:
            add(LABEL_TEXT_RULE)
        elif none and items > 0:
            add(NONE_ITEMS_RULE)
        elif not none and items == 0:
            add(EMPTY_RULE)
    missing = [s for k, s in enumerate(SECTIONS) if k not in seen]
    if missing:
        add(MISSING_RULE % ", ".join(missing))
    if any(n > 0 and k <= seen[n - 1] for n, k in enumerate(seen)):
        add(ORDER_RULE)
    return faults


def _is_section(line):
    label = _section_label(line)
    return bool(label) and label[0] >= 0


def _text_after_sections(text):
    """Whether anything follows the last section's label and its items. A fenced block is text."""
    lines = prose_lines(text, "```")
    last = max((i for i, line in enumerate(lines) if _is_section(line)), default=-1)
    if last < 0:
        return False
    end = last + 1
    while end < len(lines) and lines[end].strip() != "" and not _section_label(lines[end]):
        end += 1
    return any(line.strip() != "" for line in lines[end:])


def _summary_lines(lines):
    """The lines above the first of the four sections."""
    first = next((i for i, line in enumerate(lines) if _is_section(line)), -1)
    return lines if first < 0 else lines[:first]


def _bare_reference(line):
    text = _CLOSING.sub(" ", _CODE_SPAN.sub(" ", _without_images(line)))
    return bool(_PR_URL.search(text)) or bool(_BARE_REF.search(_strip(_LINK_TARGET.sub("]", text))))


def says_not(text, pattern=None):
    """Whether a line states what the change does not do: a refused phrase outside code and images."""
    pattern = pattern or _NEGATIVE
    return bool(pattern) and bool(pattern.search(_strip(_without_images(text)).replace("’", "'")))


def title_rules(title):
    found = []
    if re.search(r"[\r\n]", title.strip()):
        found.append(TITLE_LINE_RULE)
    if len(title.strip()) > TITLE_MAX:
        found.append(TITLE_LENGTH_RULE % len(title.strip()))
    if ";" in _strip(title):
        found.append(SEMICOLON_RULE)
    return found


def body_rules(text, geonative=True, phrases=None):
    """Every rule a description breaks, each named once. The four sections and the rules that name
    them bind a GeoNative repository only."""
    phrases = NEGATIVE_PHRASES if phrases is None else tuple(phrases)
    found = []
    lines = prose_lines(text)
    if any(";" in _strip(line) for line in lines):
        found.append(SEMICOLON_RULE)
    if any(_TRAILER.search(line) for line in lines):
        found.append(TRAILER_RULE)
    if any(_HEADING.search(line) for line in lines):
        found.append(HEADING_RULE)
    if geonative:
        if _bare_todo_item(lines):
            found.append(TODO_RULE)
        items = _todo_items(lines)
        if any(_POINTER.search(i) for i in items):
            found.append(TODO_ALONE_RULE)
        if any(_JOINED.search(i) for i in items):
            found.append(TODO_ONE_RULE)
    if _bare_cve(lines):
        found.append(CVE_LINK_RULE)
    if _missing_cve_tables(lines):
        found.append(CVE_TABLE_RULE)
    if geonative:
        found.extend(_section_faults(lines))
        if _text_after_sections(text):
            found.append(AFTER_RULE)
    summary = _summary_lines(lines)
    if geonative and any(_bare_reference(line) for line in summary):
        found.append(REF_RULE)
    if any(_HORIZONTAL_RULE.search(line) and not _shot_separator(lines, i, len(summary)) for i, line in enumerate(lines)):
        found.append(RULE_LINE_RULE)
    pattern = negative_pattern(phrases)
    if pattern and any(says_not(line, pattern) for line in summary):
        found.append(negative_rule(phrases))
    return found


def check(owner, title=None, body=None):
    """Refuse, before anything is sent, a title or a description that breaks a writing rule."""
    found = []
    if title is not None:
        found.extend("title: " + rule for rule in title_rules(title))
    if body is not None:
        found.extend("body: " + rule for rule in body_rules(body, is_geonative(owner)))
    if found:
        raise errors.UsageError(
            "nothing was sent, the text breaks the writing rules of engine/writing/:\n"
            + "\n".join("- " + line for line in found)
        )
