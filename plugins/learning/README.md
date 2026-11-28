# learning

Reads the learning journals the plugins write and answers, with no model turn, what they hold. The
design, the event and what is deliberately not recorded: `docs/specs/learning-design.md` in the
repository; the event's contract is `packages/core/src/learning.ts`.

## Commands

- `/learning:health`: the journals under `${CLAUDE_CONFIG_DIR:-~/.claude}` (each plugin's
  `<plugin>/journal/`) over the contract's window: refusals per guard code, findings by severity
  (the norms agents' own severities, error, warning and info, on a line of their own, read from the
  event's code `norms.<agent>.<severity>`), answers and escapes, and the files that are not events of the contract. One more section only
  prints, and refuses nothing: the guard codes with refusals in the journals and none in the window,
  one line each (code, plugin, days since the last refusal), proposed for removal. The hooks module answers it from
  `skills/learning/scripts/health.ts`; the markdown command runs the same script where the module
  does not load.

## The distiller

`skills/learning/scripts/distil.ts --config <dir>` computes the candidates of the journals, with no
model, and prints one JSON line each: the events of the window, grouped by signature (kind,
code, the finding's severity, the classes of its paths, its languages), a group being a candidate at
three events from two pull requests. A refusal that names its repository and no pull request is grouped
by that repository too, its signature ending in `@owner/name`, and is a candidate at three events from
two sessions (version 2 of the candidate, which holds the sessions). Besides the version 1 events, it reads the audit trail's: a review
decision that kept its finding is a `finding`, with the severity and the file it names, and a failure of
the method is an `escape`; the other audit facts form no candidate. The retrospective and forget and
check read the same events. An event names a pull request when it holds both its repository
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
  per signature under `<dir>/learning/candidates/` (core's `candidateStateFile`). The cause is a claim (the first upstream failure,
  the counterfactual, the events it rests on, the alternatives weighed, a confidence) or unresolved
  with the observation that would have decided; a resolved cause carries a remedy with its scope, its
  rung, its target repository and its proof (a test's path, or an eval case for a prompt rule). A
  judgment that lacks a part is refused with the sentence that says which; the candidate, its events
  and the time are code's, never the judgment's.
- `mark --config <dir> <signature> <state> [--pr <owner/name#n>] [--ruling <text>]`: a later state,
  `merged` or `ineffective` with the remedy's pull request, `rejected` with the ruling.
- `start --config <dir>`: starts the session, headless (`claude -p`, its output in
  `<dir>/learning/retrospective.log`), when at least three candidates wait and none was started in
  the last 24 hours. implement runs it at the end of the turn that ran `implement:close`, the
  orchestrator at the end of a turn that declared a `done` wait, each only where
  `learning@lounisbou` is enabled.

A candidate waits when it has no state, when it was rejected or left unresolved and its events
have since doubled, or when its remedy proved ineffective. The states, the scopes, the rungs, the thresholds and the validator are core's
(`CANDIDATE_STATE_CONTRACT`, `RETROSPECTIVE_CONTRACT`, `readCandidateState`). Opening a remedy's pull
request is not built: the remedy's pull request is the retrospective's act, recorded by `mark`.

## The outcomes of the guards in warn

`skills/learning/scripts/outcomes.ts --config <dir>` is a report, and changes nothing. A guard in
warn lets a call through and leaves an escape under its code, the refusal it would have made as its
evidence. For each pull request those escapes name, it asks the forge (`gh pr view --json
mergedAt,commits`): a commit after the first would-be refusal and before the merge makes it right, a
merge with none wrong, neither yet open. Per code it prints the tally and the phase core gives it:
`warn`, `ready to enforce` (nine in ten of at least five decided, `isEnforceable`; for a learned
guard, `guardPhase`, which also needs its remedy merged), or `proved wrong, proposed for removal`
(five decided and under that precision, `provedWrong`). A learned guard is a candidate's state whose
remedy is a guard; its escapes are under its candidate's code. Raising a guard to enforce, or
removing it, is a pull request.

## Forget and check

`skills/learning/scripts/forget.ts --config <dir>`, with no model and no forge:

- a merged remedy is checked once a window (30 days) has passed since its merge: its candidate's
  signature must fall to half of its count over the window before the merge; otherwise the state is
  moved to `ineffective`, the candidate reopens for the retrospective, and the remedy is proposed for
  removal (`afterLanding`);
- a learned guard with no event under its code over two windows is proposed for removal
  (`isSilentGuard`).

The proposals are printed; a removal is a pull request. The rules and their thresholds are core's
(`FORGET_CONTRACT`). A prompt rule's removal reads its ablation (`npm run ablation`,
`evals/outcome/README.md`). The rules are tested on fixtures; their proof on live data needs two
windows of journals.

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
