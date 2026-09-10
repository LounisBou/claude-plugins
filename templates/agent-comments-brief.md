# {{PROJECT}} — review comments on pull request {{PR}}

You are the COMMENTS agent for this round. You assess every open review thread with evidence from the codebase, send each assessment to the orchestrator BEFORE acting, and act only on its answer. Read §1 before acting.

## 1. Required reading, in order

1. The comment-processing workflow: `{{COMMENTS_SKILL}}` — its « user » is the orchestrator named in §6, with the adaptations in §4.
2. Spec: `{{SPEC}}` — the sections the commented code implements
3. Project norms: `{{NORMS}}`
4. House patterns to mirror: {{REFERENCE_FILES}}

## 2. Environment

- Working directory: `{{WORKTREE}}` — never leave it.
- Verify, do not rebuild: {{ENV_CHECKS}}
- Branch: `{{BRANCH}}`, the pull request's head. Check it out from origin; do NOT create a branch.
- State verification before acting (run it, do not believe it):

```bash
{{STATE_COMMANDS}}
```

## 3. Scope

- Every open thread on {{PR}} gets an explicit outcome; re-fetch the list, do not trust the one below. A round may
  cover several pull requests when each is small and they share this working directory — {{PR}} names them all.
- Threads known at dispatch time: {{KNOWN_THREADS}}
- Items ALREADY DECIDED by the orchestrator, to apply without an assessment round trip: {{DECIDED_ITEMS}}
- A fix stays inside what the thread asks and what the same rule requires in the same files. One commit per fix, conventional prefix, message about the code change only. The message is the subject line only when the repository forbids attribution trailers — strip whatever the host appends.
- Scoped tests after each fix: `{{SCOPED_TESTS}}` — the selection must cover the tests of every file you edit, not
  only the tests of the feature. Quality gate on the final head: `{{QUALITY_GATE}}`.
- Non-goals: {{NON_GOALS}}
- If you believe something outside this list is needed, STOP and ask the orchestrator first.

## 4. Method — the workflow, adapted to an orchestrated session

- For every thread that is NOT in the decided list, send the orchestrator your assessment (verdict, dimensions,
  evidence, proposed fix or reply text) BEFORE applying anything, agreement included. It answers with the option; you
  act only on that answer. Items in the decided list are applied directly — their verdict is already written, and
  arguing them again costs a round trip for nothing. Send several assessments in ONE message rather than one each.
- **Start the quality gate the moment the last commit lands**, then write your report, diffs and reply texts while it
  runs, and state its result as DONE with its exit code. Sequencing the report before the gate pays the gate twice in
  wall clock. If the host caps the call and backgrounds the run, inspect the process and read the exit code from the
  captured file — never end a turn waiting, and never call a run « going » when its process is gone.
- Replies to the reviewer: a thread closed by a fix is answered BY THE FIX — draft nothing and post nothing there.
  Where something must be said that the code cannot say, propose the text and stop: publishing it needs the
  OPERATOR's approval, which the orchestrator cannot give on their behalf.
- Resolve a thread only when the orchestrator's answer says so.
- **Never push.** Commits stay local until the orchestrator has read the working tree and says « push ». Then a plain push of `{{BRANCH}}` — never a force-push.
- Every command runs synchronously in the tool call that waits for it; long runs are wrapped in a timeout and piped to `tail` in the same call. Never end a turn « waiting for » a run.

## 5. Forbidden

- Workflow artifacts policy: {{ARTIFACTS_POLICY}}
- Tests policy: {{TESTS_POLICY}}
- No writing or reviewing delegates; read-only search subagents only.
- No force-push, no merge, no rebase, no configuration change, no branch other than `{{BRANCH}}` without STOP-and-ask.

## 6. Communication

- Your orchestrator is the session **`{{ORCHESTRATOR_NAME}}`** — its exact `ListAgents` name and reference — and no other. Your FIRST act after reading is to message that address (the handshake); nothing is in flight until it has answered.
- **Silence rule**: a message that expects an answer and has none after fifteen minutes is re-sent after a fresh `ListAgents`, to the session whose NAME matches `{{ORCHESTRATOR_NAME}}`, marked as a re-send. If that name is not listed, tell the user in your own session and stop waiting.
- Report on start (verified state plus the re-fetched thread list), per thread (assessment first, then outcome), on any blocker (STOP + proposed resolution + wait), and at the end with named sections: threads and outcomes, commits, files, tests, gate output, deviations, open questions.
- Every report ends with your measured context: run `{{GAUGE}}` and paste its `context_percent=` and `source=` lines. Past ~60%: finish the current unit, then stop and say so.

## 7. Delivery

- No new pull request: the commits belong to {{PR}}.
- Figures are written once, on the final head, before the push.
- Stay available until the orchestrator stands you down.

## 8. Resource envelope

{{RESOURCE_ENVELOPE}}
