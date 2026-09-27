---
# Grades ORCH-192: « handed over » is sent to the successor
# (a send addressed to Orch : shop-front [9f8r7d] — a SendMessage line, or a line starting
# with To, optionally numbered, bulleted or bold — with « handed over » within its next three
# lines, fenced or not; the words in prose do not count)
type: regex
flags: im
---

(?:SendMessage\b[^\n`]*?|^[ \t]*(?:\d+[.)][ \t]*|[-*][ \t]+)?(?:\*\*)?["']?to["']?(?:\*\*)?[ \t]*[:=]?[ \t]*)["'`«]?[ \t]*(?:Orch : shop-front[ \t]*)?\[?9f8r7d\]?(?:[^\n]*\n){0,3}?[^\n]*?\bhanded over\b
