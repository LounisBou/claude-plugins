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

**Amended 2026-11-15.** An E2E or norms waiver and an E2E exemption no longer need a consent
record: they rest on the operator's words quoted with their date in the record's `detail`. The
quote is visible, not judged; no forged waiver was observed, and the recorded route cost more than
it caught. Auto-merge and auto-deploy keep the recorded consent.

**Amended 2026-11-18.** Auto-merge and auto-deploy rest on the operator's words quoted with their
date too, in `words`: the consent record, its writers and its readers are gone, with the parsers
that read a grant in free words and the stop gate's guards on the turn's prose. No forged consent
was observed; the record and its keyword guards cost about fifteen fixes and caught nothing.
