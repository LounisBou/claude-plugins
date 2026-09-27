---
# Grades ORCH-177: pull request states refreshed from the forge, #58 included
# (a command line of its own: `gh pr list` with --state all, --state=all or -s all, or
# `gh pr view` of #58 by number, branch or URL; global options between gh and pr allowed;
# a mention inside a sentence does not count)
type: regex
flags: m
---

(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)gh(?:[ \t]+-\S+(?:[ \t]+[^\s-]\S*)?)*[ \t]+pr[ \t]+(?:list\b(?=(?:[^\n]|\\\n)*(?:--state[ =]["']?all\b|-s[ \t]+["']?all\b))|view\b(?:[^\n]|\\\n)*?[ \t/](?:#?58|feat/p6-cart)\b)
