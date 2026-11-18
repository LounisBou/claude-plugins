"""The writing rules pr-create and pr-update refuse (engine/ghlib/writing.py), case by case.

Run by run-tests.sh with the engine's directory as argument: prints one `ok <case>` or
`FAIL <case>: <detail>` line per case.
"""

import sys

sys.path.insert(0, sys.argv[1])

from ghlib import writing  # noqa: E402

NONE = "**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none"
PHRASES = ("unchanged", "no dependency", "does not", "doesn't", "is not changed", "left untouched",
           "no other pull request", "without conflict")
CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def rules(body, geonative=True):
    """The rules a body breaks, each cut before its source, as the refusal names them."""
    return [r.split(" (")[0] for r in writing.body_rules(body, geonative, PHRASES)]


def title(text):
    return [r.split(" (")[0] for r in writing.title_rules(text)]


def eq(actual, expected, what=""):
    assert actual == expected, "%s: %r != %r" % (what, actual, expected)


HEADING = "no heading of any kind in a pull request description, it starts with the summary text"
TODO_BARE = "a TODO Staging or TODO Prod item is a task-list checkbox, `- [ ] <step>`, never a bare `- ` bullet"
TRAILER = "no trailer of any kind, such as Co-Authored-By, Signed-off-by or Claude-Session"
AFTER = "nothing after the four sections, a description ends with Related PRs"
NEGATIVE = "state what the PR does, never what it does not do"
RULE_LINE = "no horizontal rule, `---`, `***` or `___`, in a pull request description"
REF = ("no pull request reference in the summary above the sections, `#N`, `repo#N`, `owner/repo#N` or a pull"
       " request URL: it goes in PRs Dependency or Related PRs")
LABEL_TEXT = "a section's label line holds the label alone, or the label and `none`, nothing else"


@case
def a_semicolon_in_prose_is_refused_in_a_title_and_a_body():
    eq(title("fix: a; b"), ["no semicolon in prose"])
    eq(rules("Done; thanks\n\n" + NONE), ["no semicolon in prose"])


@case
def a_semicolon_in_code_a_url_or_a_character_reference_passes():
    body = "\n".join([
        "Use this:", "```ts", "const a = 1;", "```", "~~~~", "x = 1; y = 2", "~~~~",
        "Inline `let x = 1;` and ``a; `b` ;`` code.",
        "See https://example.com/a;b=c and <https://example.com/x;y>.",
        "Tom &amp; Jerry &#59; done",
    ])
    eq(rules(body + "\n\n" + NONE), [])
    eq(title("fix(parser): accept `a;b` in keys"), [])


@case
def a_heading_is_refused_a_hash_in_code_is_not():
    eq(rules("## Summary\nText\n\n" + NONE), [HEADING])
    eq(len(rules("Text\n\n# Notes\nmore\n\n" + NONE)), 1)
    for heading in ("## Summary", "## Self-review", "### self-review ###"):
        eq(rules("Adds the reset.\n\n" + heading + "\n- Tests: none missing.\n\n" + NONE), [HEADING], heading)
    eq(rules("Fixes #12\n#hashtag\n```sh\n# a shell comment\n```\n\n" + NONE), [])


@case
def a_todo_item_is_a_checkbox_links_stay_bullets():
    bare = ("Adds the reset.\n\n**TODO Staging:** none\n**TODO Prod:**\n- Deploy the API first\n\n**PRs Dependency:** none\n"
            "**Related PRs:**\n- https://github.com/o/r/pull/1")
    eq(rules(bare), [TODO_BARE])
    boxes = ("Adds the reset.\n\n**TODO Staging:**\n- [ ] Run the migration\n\n**TODO Prod:**\n- [x] Deploy the API first\n"
             "- [ ] Run the migration\n\n**PRs Dependency:**\n- https://github.com/o/r/pull/1\n\n**Related PRs:** none")
    eq(rules(boxes), [])
    eq(rules("A list of changes:\n- one\n- two\n\n" + NONE), [])


@case
def the_four_sections_bind_a_geonative_repository_only():
    body = "Adds the reset.\n\nSee #12 for the cause.\n\n- [ ] note\n\n**Note:** done"
    assert rules(body)
    eq(rules(body, False), [])
    eq(rules("Adds the reset; at last.", False), ["no semicolon in prose"])
    eq(rules("## Summary\nAdds the reset.", False), [HEADING])
    eq(rules("Adds the reset.\n\nCo-Authored-By: someone <a@b.c>", False), [TRAILER])
    eq(rules("Adds the reset, unchanged otherwise.", False), [NEGATIVE])
    eq(rules("Adds the reset.\n\n---\n\nmore", False), [RULE_LINE])


@case
def a_repository_is_geonatives_by_its_owner_whatever_the_case():
    assert writing.is_geonative("geonativefr")
    assert writing.is_geonative(" GeoNativeFr ")
    for other in ("LounisBou", "acme", "geonative", ""):
        assert not writing.is_geonative(other), other


@case
def a_todo_item_that_points_to_another_or_joins_two_actions_is_refused():
    alone = "a TODO item stands alone, it never points to another item"
    one = ("one checkbox, one action: an edit and the restart, reload or deploy that applies it are two checkboxes,"
           " never joined by « then » or « and run »")
    before = ("Lowers the pool.\n\n**TODO Staging:** none\n**TODO Prod:**\n- [ ] Set `size=1000` instead of `size=30000` in"
              " `FREDDIE_TRANSPORT_DSN` of the staging `/etc/caddy/caddy.env`, then run `sudo systemctl reload caddy`\n"
              "- [ ] Do the same edit on prod-01 to prod-05 and run `sudo systemctl reload caddy` on each\n\n"
              "**PRs Dependency:** none\n**Related PRs:** none")
    eq(rules(before), [alone, one])
    tail = "\n\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none"
    eq(rules("**TODO Staging:**\n- [ ] Same as above on staging" + tail), [alone])
    eq(rules("**TODO Staging:**\n- [ ] Run the migration and run the seeder" + tail), [one])
    after = ("Lowers the pool.\n\n**TODO Staging:** none\n**TODO Prod:**\n- [ ] Set `size=1000` instead of `size=30000` in"
             " `FREDDIE_TRANSPORT_DSN` of `/etc/caddy/caddy.env` on prod-01 to prod-05\n- [ ] Run `sudo systemctl reload"
             " caddy` on prod-01 to prod-05 to restart the Freddie workers\n\n**PRs Dependency:** none\n**Related PRs:** none")
    eq(rules(after), [])
    eq(rules("Reads the file, then caches it, the same as before.\n\n**TODO Staging:** none\n**TODO Prod:**\n"
             "- [ ] Set `mode=then` in `app.env` on prod-01\n\n**PRs Dependency:** none\n**Related PRs:** none"), [])


@case
def every_trailer_is_refused_a_mid_line_label_is_not():
    eq(rules("Text\n\nCo-Authored-By: someone <a@b.c>", False), [TRAILER])
    assert TRAILER in rules("Text\n\n" + NONE + "\n\nSigned-off-by: Dev <d@e.f>")
    for trailer in ("Reviewed-by: Dev <d@e.f>", "Acked-by: Dev <d@e.f>", "Change-Id: I0123456789abcdef",
                    "claude-session: 123", "Stand-by: waiting for the CI", "Drive-by: renamed a variable"):
        eq(rules("Looks right.\n\n" + trailer, False), [TRAILER], trailer)
    for text in ("Note: the cache is cold.\nFollow-up work: the index.", "We stand-by: no, we ship.",
                 "Stand by: the CI is running."):
        eq(rules(text, False), [], text)


@case
def a_description_ends_with_the_four_sections():
    head = "Adds the reset.\n\n**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:**\n"
    eq(rules(head + "- https://github.com/acme/front/pull/1620\n- https://github.com/acme/front/pull/1621"), [])
    eq(rules(head + "- https://github.com/acme/front/pull/1620\n\n- https://github.com/acme/front/pull/1621"), [AFTER])
    eq(rules("Adds the reset.\n\n" + NONE + "\n\nThanks for the review."), [AFTER])
    listed = head + "- https://github.com/acme/front/pull/1620\n\nThanks."
    eq(rules(listed), [AFTER])
    eq(rules(listed.replace("\n\nThanks.", "\n\n")), [])
    eq(rules("Adds the reset.\n\n" + NONE + "\n\n```\nnpm test\n```"), [AFTER])


@case
def a_title_past_the_margin_or_on_two_lines_is_refused():
    eq(title("feat(scope): " + "x" * (writing.TITLE_MAX - 13)), [])
    assert "about sixty characters" in title("feat(scope): " + "x" * (writing.TITLE_MAX - 12))[0]
    eq(title("fix: one\ntwo"), ["a title is one line"])
    eq(title("fix: patch CVE-2026-11111"), [])


@case
def an_unclosed_fence_runs_to_the_end():
    eq(writing.prose_lines("a\n````\nb;\n```\nc;"), ["a"])


CVE1743 = "\n".join([
    "symfony/expression-language, symfony/http-foundation and symfony/yaml to 8.1.9 ([CVE-2026-109449](https://symfony.com/cve-2026-109449), [CVE-2026-108082](https://symfony.com/cve-2026-108082), [CVE-2026-109413](https://symfony.com/cve-2026-109413))",
    "",
    "| | |", "|---|---|",
    "| Package | `symfony/expression-language` (locked at v8.1.1, now v8.1.9) |",
    "| Advisory | PKSA-vq1j-sc3k-jzzk / [CVE-2026-109449](https://symfony.com/cve-2026-109449) — Unbounded Nesting in the Expression Parser Lets Untrusted Expressions Crash the Process |",
    "| Affected | `>=2.4.0,<5.4.54`, `>=6.0.0,<6.4.48`, `>=7.0.0,<7.4.21` and `>=8.0.0,<8.1.9` |",
    "| Reference | https://symfony.com/cve-2026-109449 |",
    "",
    "| | |", "|---|---|",
    "| Package | `symfony/http-foundation` (locked at v8.1.4, now v8.1.9) |",
    "| Advisory | PKSA-xmwy-rmx5-m7h4 / [CVE-2026-108082](https://symfony.com/cve-2026-108082) — ReDoS in HeaderUtils::split() Reachable Through the Cache-Control Request Header |",
    "| Affected | `>=5.4.1,<5.4.54`, `>=6.0.1,<6.4.46`, `>=7.0.0,<7.4.19` and `>=8.0.0,<8.1.7` |",
    "| Reference | https://symfony.com/cve-2026-108082 |",
    "",
    "| | |", "|---|---|",
    "| Package | `symfony/yaml` (locked at v8.1.2, now v8.1.9) |",
    "| Advisory | PKSA-xz3r-9gp4-4m1z / [CVE-2026-109413](https://symfony.com/cve-2026-109413) — Unbounded Recursion in the YAML Inline Lexer Lets a Single Document Crash the Process |",
    "| Affected | `>=2.0.0,<5.4.54`, `>=6.0.0,<6.4.45`, `>=7.0.0,<7.4.18` and `>=8.0.0,<8.1.6` |",
    "| Reference | https://symfony.com/cve-2026-109413 |",
    "",
    NONE,
])
CVE1557 = "\n".join([
    "squizlabs/php_codesniffer to 4.0.4 (CVE-2026-67434)",
    "",
    "| | |", "|---|---|",
    "| Package | `squizlabs/php_codesniffer` (dev dependency, locked at 4.0.1) |",
    "| Advisory | PKSA-rdkp-vv9z-mjkg / CVE-2026-67434 — OS command injection, **high** |",
    "| Affected | `<3.13.6` and `>=4.0.0,<4.0.2` |",
    "| Reference | https://github.com/PHPCSStandards/PHP_CodeSniffer/security/advisories/GHSA-hmqg-cxww-wqhq |",
    "",
    NONE,
])
CVE_LINK = "a CVE id is a markdown link to its advisory, `[CVE-YYYY-NNNNN](<advisory URL>)`, never bare and never in a code span"
CVE_TABLES = ("a description whose first line names CVE ids has one table per advisory, with the Package, Advisory,"
              " Affected and Reference rows, its Advisory row naming the CVE id")


@case
def a_security_update_in_the_house_form_passes_a_bare_cve_id_is_refused():
    eq(rules(CVE1743), [])
    eq(rules(CVE1557), [CVE_LINK])
    eq(rules("Bumps the parser.\n\nThe advisory is `CVE-2026-11111`.\n\n" + NONE), [CVE_LINK])
    eq(rules("See https://example.com/cve-2026-11111 and <https://example.com/CVE-2026-11111>.\n```\nCVE-2026-11111\n```\n\n" + NONE), [])


@case
def a_security_update_without_its_tables_is_refused():
    first = ("symfony/yaml and symfony/process to 8.1.9 ([CVE-2026-11111](https://example.com/a),"
             " [CVE-2026-22222](https://example.com/b))")

    def table(cve, rows=("Package", "Advisory", "Affected", "Reference")):
        return "\n".join(["| | |", "|---|---|"] + [
            "| " + row + " | " + ("PKSA-aaaa / [" + cve + "](https://example.com/a) — A title" if row == "Advisory" else "`x`") + " |"
            for row in rows])

    eq(rules("\n\n".join([first, table("CVE-2026-11111"), table("CVE-2026-22222"), NONE])), [])
    eq(rules("\n\n".join([first, table("CVE-2026-11111"), NONE])), [CVE_TABLES])
    eq(rules("\n\n".join([first, NONE])), [CVE_TABLES])
    eq(rules("\n\n".join([first, table("CVE-2026-11111"), table("CVE-2026-22222", ("Package", "Advisory", "Affected")), NONE])),
       [CVE_TABLES])
    eq(rules("Reads the header once.\n\nSee [CVE-2026-11111](https://example.com/a \"advisory\") and [CVE-2026-22222][1].\n\n"
             "[1]: https://example.com/b\n\n" + NONE), [])
    moved = table("CVE-2026-33333").replace("](https://example.com/a)", "](https://example.com/CVE-2026-22222)")
    eq(rules("\n\n".join([first, table("CVE-2026-11111"), moved, NONE])), [CVE_TABLES])
    eq(rules("Reads the header once.\n\nThe check came with [CVE-2026-11111](https://example.com/a).\n\n" + NONE), [])


@case
def a_description_ends_with_the_four_sections_each_none_when_empty():
    eq(rules("Adds the reset.\n\n" + NONE), [])
    items = ("Adds the reset.\n\n**TODO Staging:**\n- [ ] Run `bin/console app:reset` on staging\n\n**TODO Prod:**\n"
             "- [ ] Run `bin/console app:reset` on prod-01\n\n**PRs Dependency:**\n- https://github.com/o/r/pull/1\n\n"
             "**Related PRs:**\n- https://github.com/o/r/pull/2\n- https://github.com/o/r/pull/3")
    eq(rules(items), [])
    dependency = "**PRs Dependency:**\n- https://github.com/acme/api/pull/412\n\n**Related PRs:** none"
    eq(rules("Adds the export.\n\n**TODO Staging:** none\n**TODO Prod:** none\n" + dependency), [])
    waiting = ("Adds the export.\n\n**TODO Staging:** none\n**TODO Prod:**\n- [ ] Set `EXPORT_ENABLED` to `true` in"
               " `/etc/app/app.env` on prod-01 once the existing records are updated by https://github.com/acme/api/pull/412\n\n"
               + dependency)
    eq(rules(waiting), [])


@case
def a_missing_misplaced_or_malformed_section_is_refused():
    eq(rules("Adds the reset."), ["a pull request description ends with the four sections, missing here: TODO Staging, TODO Prod, PRs Dependency, Related PRs"])
    eq(rules("Adds the reset.\n\n" + NONE.replace("**PRs Dependency:** none\n", "")),
       ["a pull request description ends with the four sections, missing here: PRs Dependency"])
    swapped = "**TODO Prod:** none\n**TODO Staging:** none\n**PRs Dependency:** none\n**Related PRs:** none"
    eq(rules("Adds the reset.\n\n" + swapped), ["the four sections come in this order: TODO Staging, TODO Prod, PRs Dependency, Related PRs, each once"])
    eq(rules("Adds the reset.\n\n" + NONE.replace("**TODO Prod:** none", "**TODO Prod:**")),
       ["an empty section is written `**<Label>:** none` on the label's line, never a label with nothing after it"])
    eq(rules("Adds the reset.\n\n" + NONE.replace("**TODO Prod:** none", "**TODO Prod:** none\n- [ ] Run the seeder on prod-01")),
       ["a section is either `none` on its label's line or its items below the label, never both"])
    eq(rules("Adds the reset.\n\n" + NONE.replace("**Related PRs:** none", "**Related PRs:** https://github.com/o/r/pull/2")), [LABEL_TEXT])
    for none in ("None", "NONE"):
        eq(rules("Adds the reset.\n\n" + NONE.replace("**Related PRs:** none", "**Related PRs:** " + none)), [LABEL_TEXT], none)


@case
def a_pull_request_reference_in_the_summary_is_refused():
    for summary in ("Ships in any order with #1620 and #1626.", "Ships after acme/front#1620.", "Ships after front#1620.",
                    "Ships after https://github.com/acme/front/pull/1620.", "Ships after #12.", "Ships after #1234.",
                    "Ships after git-flow#21.", "Ships after claude.github#21.", "Ships after LounisBou/claude-code#15."):
        eq(rules(summary + "\n\n" + NONE), [REF], summary)
    sectioned = ("Adds the reset.\n\n**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:**\n"
                 "- https://github.com/acme/front/pull/1620\n- acme/front#1626\n\n**Related PRs:** none")
    eq(rules(sectioned), [])
    eq(rules("Fixes #12, closes front#13 and resolves acme/front#14.\n\nUses `#15` and `front#16` and &#59;.\n\n" + NONE), [])
    for summary in ("Sets the border to #333 and the text to #112233.", "Follows [the deploy steps](#2-deploy-it).",
                    "Bumps the parser past v1.2#3.", "Reads the 2.0#1 marker."):
        eq(rules(summary + "\n\n" + NONE), [], summary)


@case
def a_horizontal_rule_or_another_bold_label_is_refused():
    for line in ("---", "***", "___", " - - -"):
        eq(rules("Adds the reset.\n\n" + line + "\n\n" + NONE), [RULE_LINE], line)
    eq(rules("Adds the reset.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n---\n```\n\n" + NONE), [])
    other = ("no bold label line other than the four sections, `**TODO Staging:**`, `**TODO Prod:**`,"
             " `**PRs Dependency:**`, `**Related PRs:**`")
    eq(rules("Adds the reset.\n\n**Desktop:**\n![d](https://example.com/d.png)\n\n" + NONE), [other])
    eq(rules("Adds the reset.\n\n**Note:** the cache is cold.\n\n" + NONE), [other])
    eq(rules("Adds the **reset** button.\n\n- **Desktop:** in a list\n\n" + NONE), [])


@case
def a_negative_phrasing_in_the_summary_is_refused_in_a_section_or_code_it_is_not():
    for phrase in PHRASES:
        eq(rules("Adds the reset. The rest " + phrase.upper() + " move.\n\n" + NONE), [NEGATIVE], phrase)
    eq(rules("Adds the reset. The topic doesn’t move.\n\n" + NONE), [NEGATIVE])
    in_section = ("Adds the reset.\n\n**TODO Staging:**\n- [ ] Check the stored data is unchanged on staging\n\n"
                  "**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none")
    eq(rules(in_section), [])
    eq(rules("Adds the reset, `unchanged` is a flag.\n\n" + NONE), [])
    eq(rules("Adds the unchanged-file check and the pre-unchanged hook.\n\n" + NONE), [])
    body = ("Adds the reset button.\n\n![desktop](https://github.com/user-attachments/assets/1.png)\nDesktop\n\n"
            "<img src=\"https://github.com/user-attachments/assets/2.png#1\" width=\"320\">\nMobile, the page unchanged at 320 px\n\n" + NONE)
    eq(rules(body), [NEGATIVE])
    eq(rules(body.replace(", the page unchanged at 320 px", "")), [])
    eq(rules("Adds the last alert column.\n\n**Settings page unchanged, after**\n![settings](https://github.com/user-attachments/assets/1.png)\n\n" + NONE),
       [NEGATIVE])


DESKTOP = ("**Devices list, desktop 1440 px, after**\n"
           "![Devices list, desktop 1440 px, after](https://github.com/user-attachments/assets/1.png)")
MOBILE = ("**Devices list, mobile 390 px, after**\n"
          "![Devices list, mobile 390 px, after](https://github.com/user-attachments/assets/2.png)")


@case
def a_rule_between_two_titled_screenshots_is_part_of_a_description():
    eq(rules("Adds the last alert column.\n\n" + DESKTOP + "\n\n---\n\n" + MOBILE + "\n\n---\n\n" + DESKTOP + "\n\n" + NONE), [])
    eq(rules("Adds the last alert column.\n\n**Devices list, desktop 1440 px, after**\n<img src=\"https://github.com/user-attachments/assets/1.png\" width=\"720\">\n\n---\n\n"
             "**Devices list, mobile 390 px, after**\n<img src=\"https://github.com/user-attachments/assets/2.png\" width=\"320\">\n\n" + NONE), [])
    for first in ("First", "Login screen [v2"):
        block = ("**" + first + "**\n![" + first + "](https://github.com/acme/thing/blob/pr-assets/a.png?raw=true)\n\n---\n\n"
                 "**Second**\n![Second](https://github.com/acme/thing/blob/pr-assets/b.png?raw=true)")
        eq(rules("Adds the reset button.\n\n" + block + "\n\n" + NONE), [], first)


@case
def a_rule_anywhere_else_is_refused_and_the_refusal_names_the_exception():
    summary = "Adds the last alert column.\n\n"
    url = "https://github.com/user-attachments/assets/1.png"
    for name, body in (
        ("above the first screenshot", summary + "---\n\n" + DESKTOP + "\n\n---\n\n" + MOBILE + "\n\n" + NONE),
        ("after the last screenshot", summary + DESKTOP + "\n\n---\n\n" + MOBILE + "\n\n---\n\n" + NONE),
        ("right under an image", summary + DESKTOP + "\n---\n\n" + MOBILE + "\n\n" + NONE),
        ("between two images with no title", summary + "![d](https://example.com/d.png)\n\n---\n\n![m](https://example.com/m.png)\n\n" + NONE),
        ("between a titled image and prose", summary + DESKTOP + "\n\n---\n\nThe column sorts by date.\n\n" + NONE),
        ("*** between two screenshots", summary + DESKTOP + "\n\n***\n\n" + MOBILE + "\n\n" + NONE),
        ("___ between two screenshots", summary + DESKTOP + "\n\n___\n\n" + MOBILE + "\n\n" + NONE),
        ("in a section", summary + NONE.replace("**Related PRs:** none", "**Related PRs:**\n- https://github.com/acme/front/pull/1620")
         + "\n\n" + DESKTOP + "\n\n---\n\n" + MOBILE),
        ("title with a colon above", summary + "**Devices list, desktop:**\n![Devices list](" + url + ")\n\n---\n\n" + MOBILE + "\n\n" + NONE),
        ("title with a space and a colon above", summary + "**Devices list, desktop :**\n![Devices list](" + url + ")\n\n---\n\n" + MOBILE + "\n\n" + NONE),
        ("title with a colon below", summary + DESKTOP + "\n\n---\n\n**Devices list, mobile:**\n![Devices list](" + url + ")\n\n" + NONE),
        ("detached title above", summary + "**Devices list, desktop**\n\n![Devices list](" + url + ")\n\n---\n\n" + MOBILE + "\n\n" + NONE),
        ("detached title below", summary + DESKTOP + "\n\n---\n\n**Devices list, mobile**\n\n![Devices list](" + url + ")\n\n" + NONE),
        ("no image above", summary + "**Devices list, desktop**\n\n---\n\n" + MOBILE + "\n\n" + NONE),
        ("no image below", summary + DESKTOP + "\n\n---\n\n**Devices list, mobile**\n\n" + NONE),
    ):
        assert RULE_LINE in rules(body), name
    refused = writing.body_rules(summary + "---\n\n" + NONE, True, PHRASES)
    assert any("a `---` is kept only between two screenshots, a blank line before it" in r for r in refused)


@case
def an_images_alt_text_url_and_attributes_are_never_the_summary():
    for image in (
        "![the page unchanged](https://github.com/user-attachments/assets/1.png)",
        "![mobile](https://example.com/unchanged.png)",
        "![front#12 after](https://github.com/user-attachments/assets/1.png)",
        "![desktop](https://github.com/user-attachments/assets/1.png#12)",
        "![mobile](assets/page#12.png)",
        "<img alt=\"the page unchanged at 320 px\" src=\"https://github.com/user-attachments/assets/2.png\" width=\"320\">",
    ):
        eq(rules("Adds the reset button.\n\n" + image + "\n\n" + NONE), [], image)


@case
def the_refusal_names_each_rule_and_its_field():
    try:
        writing.check("geonativefr", "fix: a; b", "Adds the reset.")
    except Exception as exc:  # noqa: BLE001 - the case reads the message
        text = str(exc)
        assert "- title: no semicolon in prose" in text, text
        assert "- body: a pull request description ends with the four sections, missing here" in text, text
    else:
        raise AssertionError("no refusal")
    writing.check("acme", "fix: a", "Adds the reset.")
    writing.check("acme", None, None)


failed = 0
for fn in CASES:
    try:
        fn()
        print("ok " + fn.__name__)
    except AssertionError as exc:
        failed += 1
        print("FAIL %s: %s" % (fn.__name__, exc))
sys.exit(1 if failed else 0)
