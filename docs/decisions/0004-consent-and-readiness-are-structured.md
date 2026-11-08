# 0004 — Consent and readiness are structured acts

**Context.** Every plugin inferred the operator's consent from words in his last prompt
(`/\bpush/` lets « don't push » through), gated the orchestrator's stop on the wording of its
last line, and accepted review and norms records whose figures the model itself reported.

**Decision.** Consent is a recorded answer to a question the plugin asked (a tool call or a
choice). A wait is declared by a tool call (`declare_wait`). Readiness is one gate, owned by
github: a review or norms record is written by a session other than the implementer, bound to
the head it read, and computed from the tool's output.

**Cost.** Each plugin's guards and skills change; the transitional reading of the old forms is
kept until the new one has shipped and the prompts teach only it.
