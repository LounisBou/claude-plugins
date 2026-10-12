// hooks/tests/module-log.test.ts
// The module's log line: an append through hooks/log-append.sh, one argv every domain
// hands its own $.process.run. The script itself (the append, the rotation to one `.1`
// generation, the lock) is run for real by tests/run-tests.sh — the plugin test
// harness spawns no process.
import { expect, test } from 'claude-code/testing'
import { logArgv, logPath, LOG_CAP } from '../module-log.ts'

test('a log line is the append script, the shared log, one stamped line and the cap', () => {
  const at = new Date('2026-10-11T12:00:00.000Z')
  expect(logArgv('/plugins/orch-root', '/tmp/cfg', 'guards', 'stop gate: x', at)).toEqual([
    'sh', '/plugins/orch-root/hooks/log-append.sh', '/tmp/cfg/claude-orchestrator/hooks-module.log',
    '2026-10-11T12:00:00.000Z | guards | stop gate: x', String(LOG_CAP),
  ])
  expect(logPath('/c')).toBe('/c/claude-orchestrator/hooks-module.log')
})

test('the log and its one previous generation fit what one host read can take', () => {
  expect(LOG_CAP * 2).toBeLessThanOrEqual(4 * 1024 * 1024)
})
