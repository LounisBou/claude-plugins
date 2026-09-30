---
# Grades: « handed over » is sent to the successor
# (a send addressed to Orch : shop-front [9f8r7d] — a SendMessage line, or a line with a To
# marker: at the line's start, optionally numbered, bulleted or bold, or preceded by other
# text ending in a comma on the same line (e.g. "Message I send, to « Orch … »:") — with
# « handed over » anywhere in the body of that message, fenced or not, up to the next
# message's own SendMessage or To marker or the end of the output; the words in prose
# outside a message do not count, and a message addressed to anyone else does not count)
type: regex
flags: im
---

(?:SendMessage\b[^\n`]*?|(?:^[ \t]*(?:\d+[.)][ \t]*|[-*][ \t]+)?|[^\n]*,[ \t]*)(?:\*\*)?["']?to["']?(?:\*\*)?[ \t]*[:=]?[ \t]*)["'`«]?[ \t]*(?:Orch : shop-front[ \t]*)?\[?9f8r7d\]?(?:(?!(?:^[ \t]*(?:\d+[.)][ \t]*|[-*][ \t]+)?|[^\n]*,[ \t]*)(?:\*\*)?["']?to["']?(?:\*\*)?[ \t]*[:=]?[ \t]*|SendMessage\b)[\s\S])*?\bhanded over\b
