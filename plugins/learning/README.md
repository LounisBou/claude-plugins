# learning

Reads the learning journals the plugins write and answers, with no model turn, what they hold. The
design, the event and what is deliberately not recorded: `docs/specs/learning-design.md` in the
repository; the event's contract is `packages/core/src/learning.ts`.

## Commands

- `/learning:health`: the journals under `${CLAUDE_CONFIG_DIR:-~/.claude}` (each plugin's
  `<plugin>/journal/`) over the contract's window: refusals per guard code, findings by severity,
  answers and escapes, and the files that are not events of the contract. Two more sections only
  print, and refuse nothing: the guard codes with refusals in the journals and none in the window,
  one line each (code, plugin, days since the last refusal), proposed for removal, and the decided
  removals the repository still holds (« Decided removals »). The hooks module answers it from
  `skills/learning/scripts/health.ts`; the markdown command runs the same script where the module
  does not load.

## Decided removals

A removal the operator decides is written in the project's rulings file
(`<config dir>/claude-orchestrator/briefs/<project>/rulings.md`) on one line of this form, the
last thing on the line:

```
- <ISO UTC> « <his words> » — removal: <repo path>[::<symbol>]
```

`<repo path>` is relative to the repository root, with no `..`; `<symbol>` is an identifier, read as
a whole word. `/learning:health` reads the rulings of every project under the configuration
directory and lists, as « not delivered », each line whose path exists in the repository of the
working directory (and, with a symbol, whose file still holds it), with the date it was decided.
The section says `none` when nothing is left. A line of another form is not read.

A guard that has never refused leaves no event, so it is not listed as silent: the section holds the
codes the journals have seen refuse.

A journal's writer drops the events past 90 days or 6,000 and counts them first, by signature and
week, in the one file `folded.json` of the journal's directory; `/learning:health` reads that file
as the fold (« older events folded into weekly counts »), never as an unreadable one.

The orchestrator's hooks write the audit trail into its journal (`plugins/orchestrator/hooks/audit.ts`); where no journal exists the report says so.

## Tests

`tests/run-tests.sh`: the plugin validates, the scripts' tests pass, then the command line end to
end over a scratch configuration directory.
