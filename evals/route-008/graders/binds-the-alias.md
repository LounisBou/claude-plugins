---
type: llm
focus: last_message
---

Grades ROUTE-008 (a tier is bound to a family alias, never to a versioned identifier: a
versioned identifier goes stale without a sign when the family ships a newer model).

Pass only if ALL hold for the commands and the final message:

1. The deep tier is bound to the unversioned alias `a-model-large`, not to
   `a-model-large-20260915` nor to any other dated identifier.
2. The message says why the alias rather than the dated identifier: the alias follows the
   family's newest model, a dated one stays on the day it was written.

Fail if deep is bound to a dated identifier, including the newest one.
