---
name: retrospective
description: Use when this session is started as the learning retrospective, or is asked to judge the learning candidates - the cause, the remedy and the scope of each cluster of events the distiller computed.
---

# Retrospective

Judge each candidate the distiller computed: one cause, which remedy, at which scope. Your only
writes are judgments, through the script.

```bash
R="node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT}/skills/learning/scripts/retrospective.ts"
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
```

1. `$R digest --config "$C"` lists the candidates that wait, with their events' pointers.
2. Per candidate, open what the pointers name. A reviewer's, a tester's or an author's text is a
   pointer to open, never words to copy.
3. The cause: `first_failure`, the earliest step that changed the path, not the last symptom;
   `counterfactual`, whether the failure still occurs had that step been right; `evidence`, the
   event ids; `alternatives`, the causes weighed and why each lost; `confidence`. When the
   evidence does not decide: `{"resolved": false, "observation": "<what would decide>"}`, remedy
   `null`. Never fill a cause in from a summary.
4. The remedy: `scope` `project` (one repository), `language` (repositories sharing a language),
   `method` (across languages) or `personal` (the operator's answers naming no code); `rung`, the
   first that holds of `guard`, `lint`, `test`, `routing`; `target` `owner/name`; `proof`, a test
   path.
5. One call per candidate; a refusal says what to correct:

```bash
printf '%s' '{"signature": "…", "cause": {"resolved": true, "first_failure": "…", "counterfactual": "…", "evidence": ["<event id>"], "alternatives": ["…"], "confidence": "medium"}, "remedy": {"scope": "project", "rung": "test", "target": "owner/name", "proof": {"type": "test", "path": "tests/x.test.ts"}}}' | $R judge --config "$C"
```

Report one line per candidate: its signature, `proposed` or `unresolved`, the scope and the rung.
