---
# Grades ITERM-064: the expected title does not carry the glyph
# (a launcher command line whose --expect-title value holds the glyph, quoted or not, with a
# space or '=', continuations allowed; a sentence that mentions the glyph to leave it out
# does not count)
type: regex
flags: m
match: not_contains
---

(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?(?:"(?:[^"\n]*iterm-agent\.sh|\$\{?SCRIPT\}?)"|'[^'\n]*iterm-agent\.sh'|[^\s"'`]*iterm-agent\.sh|\$\{?SCRIPT\}?)[ \t]+[a-z-]+\b(?:[^\n]|\\\n)*?--expect-title[ =](?:"[^"\n]*⠐|'[^'\n]*⠐|[^\s"']*⠐)
