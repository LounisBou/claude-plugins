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

## What the report holds

A guard that has never refused leaves no event, so it is not listed as silent: the section holds the
codes the journals have seen refuse.

A journal's writer drops the events past 90 days or 6,000 and counts them first, by signature and
week, in the one file `folded.json` of the journal's directory; `/learning:health` reads that file
as the fold (« older events folded into weekly counts »), never as an unreadable one.

The orchestrator's hooks write the audit trail into its journal (`plugins/orchestrator/hooks/audit.ts`); where no journal exists the report says so.

## Tests

`tests/run-tests.sh`: the plugin validates, the scripts' tests pass, then the command line end to
end over a scratch configuration directory.
