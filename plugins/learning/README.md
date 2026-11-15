# learning

Reads the learning journals the plugins write and answers, with no model turn, what they hold. The
design, the event and what is deliberately not recorded: `docs/specs/learning-design.md` in the
repository; the event's contract is `packages/core/src/learning.ts`.

## Commands

- `/learning:health`: the journals under `${CLAUDE_CONFIG_DIR:-~/.claude}` (each plugin's
  `<plugin>/journal/`) over the contract's window: refusals per guard code, findings by severity,
  answers and escapes, and the files that are not events of the contract. One more section only
  prints, and refuses nothing: the guard codes with refusals in the journals and none in the window,
  one line each (code, plugin, days since the last refusal), proposed for removal. The hooks module answers it from
  `skills/learning/scripts/health.ts`; the markdown command runs the same script where the module
  does not load.

## The distiller

`skills/learning/scripts/distil.ts --config <dir>` computes the candidates of the journals, with no
model, and prints one JSON line each: the version 1 events of the window, grouped by signature (kind,
code, the finding's severity, the classes of its paths, its languages), a group being a candidate at
three events from two pull requests. An event names a pull request when it holds both its repository
and its number; an `external` event forms no cluster. The same journals at the same time give the same
lines. The signature, the thresholds and the candidate's validator are core's
(`packages/core/src/learning.ts`, `signatureOf`, `CANDIDATE_CONTRACT`, `parseCandidate`). A journal
that cannot be read is said on the error stream, and nothing is proposed.

## The retrospective

A session that judges what code cannot: for each candidate, whether the cluster is one cause, which
remedy, at which scope. It is another session than any that wrote the pull requests it reads; its
skill is `skills/retrospective/SKILL.md`, and its only writes go through
`skills/learning/scripts/retrospective.ts`:

- `digest --config <dir>`: the candidates that wait, each with its events' pointers (never their
  words), whole candidates only under a ceiling of 16,000 characters; the rest are counted.
- `judge --config <dir>`, a judgment as JSON on the input: kept as the candidate's state, one file
  per signature under `<dir>/learning/candidates/`. The cause is a claim (the first upstream failure,
  the counterfactual, the events it rests on, the alternatives weighed, a confidence) or unresolved
  with the observation that would have decided; a resolved cause carries a remedy with its scope, its
  rung, its target repository and its proof (a test's path, or an eval case for a prompt rule). A
  judgment that lacks a part is refused with the sentence that says which; the candidate, its events
  and the time are code's, never the judgment's.
- `mark --config <dir> <signature> <state> [--pr <owner/name#n>] [--ruling <text>]`: a later state,
  `merged` or `ineffective` with the remedy's pull request, `rejected` with the ruling.
- `start --config <dir>`: starts the session, headless (`claude -p`, its output in
  `<dir>/learning/retrospective.log`), when at least three candidates wait and none was started in
  the last 24 hours. implement runs it at the end of the turn that ran `implement:close`.

A candidate waits when it has no state, or when it was rejected or left unresolved and its events
have since doubled. The states, the scopes, the rungs, the thresholds and the validator are core's
(`CANDIDATE_STATE_CONTRACT`, `RETROSPECTIVE_CONTRACT`, `readCandidateState`). Opening a remedy's pull
request, a guard shipped in warn, the check after it lands and forgetting are not built.

## What the report holds

A guard that has never refused leaves no event, so it is not listed as silent: the section holds the
codes the journals have seen refuse.

A journal's writer drops the events past 90 days or 6,000 and counts them first, by signature and
week, in the one file `folded.json` of the journal's directory; `/learning:health` reads that file
as the fold (« older events folded into weekly counts »), never as an unreadable one.

The orchestrator's hooks write the audit trail into its journal (`plugins/orchestrator/hooks/audit.ts`); where no journal exists the report says so.

## Tests

`tests/run-tests.sh`: the plugin validates, the scripts' tests pass, then the command line end to
end over a scratch configuration directory: the report, the distiller, and a judgment kept.
