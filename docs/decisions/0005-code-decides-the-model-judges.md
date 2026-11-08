# 0005 — Code decides, the model judges

**Context.** About 165,000 tokens of prompts across the plugins at import, 65 sentences said
in more than one file. Much of it describes what code already enforces or could compute: the
orchestrator's rules restate its guards, github has every session read a 3,300-token writing
guide before any authoring call, norms runs eight agents where several of its checks are
mechanical. Every rule a model must read is a rule it may misread, and every restatement is a
chance to contradict the first.

**Decision.** A step that needs no judgment is code: answered by the module, checked by a lint,
enforced by a guard whose refusal says what to do. A prompt carries judgment, and each rule of
judgment exists once in the repository. CI measures each plugin's prompt tokens and the
sentences said more than once, and both only fall.

**Cost.** Each mechanical step moved out of a prompt is code to write and test; the token cost
it removes is paid on every session, the code once.
