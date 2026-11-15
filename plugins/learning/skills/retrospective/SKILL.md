---
name: retrospective
description: Use when this session is started as the learning retrospective, or is asked to judge the learning candidates - the cause, the remedy and the scope of each cluster of events the distiller computed.
---

# Retrospective

Judge each candidate the distiller computed: whether its cluster is one cause, which remedy, at
which scope. This session wrote none of the pull requests it reads. It changes no code, commits
nothing, pushes nothing: its only writes are judgments, through the script.

```bash
R="node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT}/skills/learning/scripts/retrospective.ts"
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
```

1. `$R digest --config "$C"` lists the candidates that wait, each with its events' pointers. When
   none waits, say so and stop.
2. Per candidate, open what the pointers name: the record, the check at its head, the file, the
   ruling's line, the pull request. A reviewer's, a tester's or a pull request author's text is a
   pointer to open, never words to copy into a judgment.
3. Name the cause as a claim:
   - `first_failure`: the earliest step that changed the path, not the last visible symptom;
   - `counterfactual`: had that step been right, everything before it unchanged, would the failure
     still have occurred;
   - `evidence`: the event identifiers the claim rests on;
   - `alternatives`: the other causes weighed, and why each lost;
   - `confidence`: `low`, `medium` or `high`.
   When the evidence does not decide, the cause is `{"resolved": false, "observation": "<what would
   have decided>"}` and the remedy is `null`. Never fill a cause in from a summary.
4. Name the remedy of a resolved cause:
   - `scope`: `project` when the events come from one repository; `language` when two repositories
     share the language; `method` when they span two repositories and two languages; `personal`
     for the operator's answers that name no code;
   - `rung`: the first that holds among `guard`, `lint`, `test`, `routing`; `prompt-rule` only when
     the remedy needs judgment;
   - `target`: the repository it lands in, `owner/name`;
   - `proof`: `{"type": "test", "path": "<the test's path>"}`, or for a prompt rule
     `{"type": "eval-case", "case": "<id>"}`.
   A `guard` remedy ships in warn, its phase a constant of its plugin's code (core's
   `learnedDecision`), raised to `enforce` only when core's `guardPhase` answers it. A rule for a
   project's `CONTRIBUTING.md` enters only after the person says « add ».
5. Keep it, one candidate a call:

```bash
printf '%s' '{"signature": "<signature>", "cause": {"resolved": true, "first_failure": "…", "counterfactual": "…", "evidence": ["<event id>"], "alternatives": ["…"], "confidence": "medium"}, "remedy": {"scope": "project", "rung": "test", "target": "owner/name", "proof": {"type": "test", "path": "tests/x.test.ts"}}}' | $R judge --config "$C"
```

   A refusal says what the judgment lacks: correct it and send it again. When the digest says more
   candidates wait past its ceiling, run it again after these.

Report one line per candidate: its signature, `proposed` or `unresolved`, the scope and the rung.
