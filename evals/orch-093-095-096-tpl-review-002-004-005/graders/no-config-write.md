---
# Grades TPL-REVIEW-005: no git configuration write in the pinned worktree
type: regex
flags: i
target: {source: file, path: briefs/review-88.md}
---

\b(no|never|not)\b[^\n]{0,60}git config
