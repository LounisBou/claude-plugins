---
# Grades: the ready phase is dispatched (a spawn of the launcher naming
# phase 5's brief, on one line or continued with backslashes,
# the launcher named by its path or by a shell variable holding it)
type: regex
---

(?:iterm-agent\.sh|\$\{?\w+\}?)(?:[^\n]|\\\n)*?\bspawn\b(?:[^\n]|\\\n)*?phase-5\.md
