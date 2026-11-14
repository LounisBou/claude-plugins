# learning

Reads the learning journals the plugins write and answers, with no model turn, what they hold. The
design, the event and what is deliberately not recorded: `docs/specs/learning-design.md` in the
repository; the event's contract is `packages/core/src/learning.ts`.

## Commands

- `/learning:health`: the journals under `${CLAUDE_CONFIG_DIR:-~/.claude}` (each plugin's
  `<plugin>/journal/`) over the contract's window: refusals per guard code, findings by severity,
  answers and escapes, and the files that are not events of the contract. The hooks module answers
  it from `skills/learning/scripts/health.ts`; the markdown command runs the same script where the
  module does not load.

No plugin writes a journal yet, so the report says so.

## Tests

`tests/run-tests.sh`: the plugin validates, the scripts' tests pass, then the command line end to
end over a scratch configuration directory.
