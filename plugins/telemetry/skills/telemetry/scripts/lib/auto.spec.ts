// The automatic export, started from a session's end: due once a day, retried after a failure
// no sooner than an hour, never two at once, said once when the repository is unset, and the work
// handed to a detached process so the session's end is not held.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withLock } from '../../../../core/store.ts'
import { exportDue, isDue, readAuto, RETRY_MS, runAuto, type AutoOptions } from './auto.ts'
import type { Git } from './export.ts'
import { append, eventsDir } from './store.ts'

const S = '60ed5626-9879-4041-892a-5db0ff0bad69'
const event = (ts: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, ts, event: 'turn_end', session: S, ...extra })
const SECRET = ['sk-', 'ant-', 'api03-', 'q7Lm2Xp9Rz4Kw8Nv3Tb6Hc1Yd5Fs0Gj'].join('')
const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
const NOON = Date.parse('2026-11-14T12:00:00Z')

const git: Git = (args, cwd) => {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, ...ENV, HOME: cwd ?? tmpdir() } })
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

interface Rig {
  readonly root: string
  readonly remote: string
  readonly state: string
  readonly detached: number[]
  options(over?: Partial<AutoOptions>): AutoOptions
}

function rig(work: (r: Rig) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'telemetry-auto-'))
  try {
    const remote = join(root, 'logs.git')
    assert.equal(git(['init', '--quiet', '--bare', remote], root).status, 0)
    const state = join(root, 'state')
    const detached: number[] = []
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    work({
      root, remote, state, detached,
      options: (over = {}) => ({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git, now: () => NOON, foreground: true, detach: () => { detached.push(1) }, ...over }),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const mainExists = (remote: string): boolean => git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], remote).status === 0

test('unset: it says so once, then stays silent, and pushes nothing', () => {
  rig(r => {
    const first = runAuto(r.options({ repo: undefined }))
    assert.equal(first.code, 0)
    assert.equal(first.lines.length, 1)
    assert.match(first.lines[0] ?? '', /CLAUDE_LOGS_REPO is not set/)
    assert.deepEqual(runAuto(r.options({ repo: undefined })), { lines: [], code: 0 })
    assert.equal(r.detached.length, 0)
    assert.equal(mainExists(r.remote), false)
  })
})

test('unset again after being set: said again once', () => {
  rig(r => {
    runAuto(r.options({ repo: undefined }))
    runAuto(r.options({ now: () => NOON + 86_400_000 }))
    assert.equal(runAuto(r.options({ repo: undefined, now: () => NOON + 2 * 86_400_000 })).lines.length, 1)
  })
})

test('set and due, not in the foreground: the work is detached and nothing runs in this process', () => {
  rig(r => {
    assert.deepEqual(runAuto(r.options({ foreground: false })), { lines: [], code: 0 })
    assert.equal(r.detached.length, 1)
    assert.equal(mainExists(r.remote), false)
  })
})

test('in the foreground it exports, marks the day, and is not due again that day', () => {
  rig(r => {
    const first = runAuto(r.options())
    assert.deepEqual(first, { lines: ['export: 1 day file(s) of box pushed to the logs repository'], code: 0 })
    assert.equal(readAuto(r.state).exported_day, '2026-11-14')
    assert.equal(git(['rev-list', '--count', 'main'], r.remote).stdout.trim(), '1')
    assert.deepEqual(runAuto(r.options({ foreground: false, now: () => NOON + 3_600_000 })), { lines: [], code: 0 })
    assert.equal(r.detached.length, 0)
    assert.equal(readFileSync(join(r.state, 'export.log'), 'utf8'), 'export: 1 day file(s) of box pushed to the logs repository\n')
  })
})

test('the next day it is due again', () => {
  rig(r => {
    runAuto(r.options())
    append(eventsDir(r.state), event('2026-11-14T10:00:00Z'), new Map())
    const next = runAuto(r.options({ now: () => NOON + 86_400_000 }))
    assert.equal(next.code, 0)
    assert.equal(git(['rev-list', '--count', 'main'], r.remote).stdout.trim(), '2')
  })
})

test('a failed export is retried no sooner than the retry delay, and never marks the day', () => {
  rig(r => {
    writeFileSync(join(r.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    assert.equal(runAuto(r.options()).code, 1)
    assert.equal(readAuto(r.state).exported_day, null)
    assert.equal(isDue(readAuto(r.state), NOON + 60_000), false)
    assert.deepEqual(runAuto(r.options({ now: () => NOON + 60_000 })), { lines: [], code: 0 })
    writeFileSync(join(r.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    assert.equal(isDue(readAuto(r.state), NOON + RETRY_MS), true)
    assert.equal(runAuto(r.options({ now: () => NOON + RETRY_MS })).code, 0)
    assert.equal(readAuto(r.state).exported_day, '2026-11-14')
  })
})

test('a secret in the store refuses the automatic export too, names the finding and pushes nothing', () => {
  rig(r => {
    appendFileSync(join(eventsDir(r.state), '2026-11-13.jsonl'), `${event('2026-11-13T10:00:01Z', { note: SECRET })}\n`)
    const result = runAuto(r.options())
    assert.equal(result.code, 1)
    assert.deepEqual(result.lines, ['export refused: 1 secret(s) found in the store, nothing pushed', '  2026-11-13.jsonl:2: anthropic-key'])
    assert.equal(mainExists(r.remote), false)
    assert.equal(readAuto(r.state).exported_day, null)
    assert.ok(!readFileSync(join(r.state, 'export.log'), 'utf8').includes(SECRET))
  })
})

test('two sessions ending together: the one that finds the export running leaves it to the other, silently', () => {
  rig(r => {
    const second = withLock(join(r.state, 'export'), () => runAuto(r.options()))
    assert.deepEqual(second, { lines: [], code: 0 })
    assert.equal(mainExists(r.remote), false)
    assert.equal(existsSync(join(r.state, 'export.log')), false)
    assert.equal(runAuto(r.options()).code, 0)
    assert.equal(mainExists(r.remote), true)
  })
})

test('a start that finds the day already exported once it holds the lock does nothing', () => {
  rig(r => {
    assert.equal(runAuto(r.options()).code, 0)
    // The other session finished between the first session's check and its lock.
    assert.deepEqual(exportDue(r.options({ repo: r.remote })), { lines: [], code: 0 })
    assert.equal(git(['rev-list', '--count', 'main'], r.remote).stdout.trim(), '1')
  })
})

test('due: the day is not the exported one and the last attempt is old enough', () => {
  const state = { exported_day: '2026-11-13', attempted_at: Date.parse('2026-11-13T10:00:00Z'), unset_noticed: false }
  assert.equal(isDue(state, Date.parse('2026-11-13T23:59:59Z')), false)
  assert.equal(isDue(state, Date.parse('2026-11-14T00:00:00Z')), true)
  assert.equal(isDue({ exported_day: null, attempted_at: null, unset_noticed: false }, NOON), true)
})

test('a state file that is no state reads as none', () => {
  rig(r => {
    writeFileSync(join(r.state, 'auto.json'), '{"exported_day": 5}')
    assert.deepEqual(readAuto(r.state), { exported_day: null, attempted_at: null, unset_noticed: false })
    writeFileSync(join(r.state, 'auto.json'), 'not json')
    assert.equal(readAuto(r.state).exported_day, null)
  })
})
