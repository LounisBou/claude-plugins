// The command line: append with the session_end enriched from its transcript, check, export when
// the repository is unset, backfill, and the usage.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backfillEvent, enrich, readSecrets, realGit, run, type Deps } from './telemetry.ts'

const S = '60ed5626-9879-4041-892a-5db0ff0bad69'
const FIXTURE = fileURLToPath(new URL(`../../../tests/fixtures/${S}.jsonl`, import.meta.url))
const end = JSON.stringify({ v: 1, ts: '2026-11-13T20:00:00.000Z', event: 'session_end', session: S, reason: 'other' })

function harness(work: (config: string, deps: Deps & { outs: string[]; errs: string[] }, setStdin: (text: string) => void) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'telemetry-cli-'))
  const config = join(root, 'config')
  const envFile = join(root, 'env')
  writeFileSync(envFile, 'SERVICE_PASS=a-long-enough-value\n')
  let stdin = ''
  const outs: string[] = []
  const errs: string[] = []
  const deps = {
    env: { TELEMETRY_ENV_FILE: envFile, TELEMETRY_MACHINE: 'box' }, stdin: () => stdin, out: (l: string) => outs.push(l), err: (l: string) => errs.push(l),
    git: realGit, now: () => Date.parse('2026-11-13T21:00:00Z'), outs, errs,
  }
  try {
    work(config, deps, text => { stdin = text })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('append: the session_end takes its transcript\'s title, role, effort, models and totals; secrets redacted', () => {
  harness((config, deps, setStdin) => {
    mkdirSync(join(config, 'projects', '-w'), { recursive: true })
    cpSync(FIXTURE, join(config, 'projects', '-w', `${S}.jsonl`))
    setStdin(`${end}\n${JSON.stringify({ v: 1, ts: '2026-11-13T20:00:01.000Z', event: 'tool_call', session: S, bash: { line: 'x=a-long-enough-value' } })}\nbad\n`)
    assert.equal(run(['append', '--config', config], deps), 0)
    assert.deepEqual(deps.errs, ['telemetry: a line was refused (not JSON)'])
    const [first, second] = readFileSync(join(config, 'telemetry', 'events', '2026-11-13.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    assert.equal(first?.['title'], 'Orch: billing')
    assert.equal(first?.['role'], 'orchestrator')
    assert.equal(first?.['effort'], 'medium')
    assert.deepEqual(first?.['totals'], { in: 15, out: 150, cache_read: 3000, cache_write: 500 })
    assert.deepEqual(second?.['bash'], { line: 'x=[REDACTED:env]' })
    assert.equal(run(['check', '--config', config], deps), 0)
    assert.equal(deps.outs.at(-1), 'check: no secret found')
  })
})

test('check: a planted secret fails it; export unset pushes nothing', () => {
  harness((config, deps) => {
    mkdirSync(join(config, 'telemetry', 'events'), { recursive: true })
    writeFileSync(join(config, 'telemetry', 'events', '2026-11-13.jsonl'), `${end.replace('"other"', '"a-long-enough-value"')}\n`)
    assert.equal(run(['check', '--config', config], deps), 1)
    assert.deepEqual(deps.outs, ['2026-11-13.jsonl:1: env', 'check: 1 finding(s)'])
    assert.equal(run(['export', '--config', config], deps), 0)
    assert.match(deps.outs.at(-1) ?? '', /CLAUDE_LOGS_REPO is not set/)
  })
})

test('backfill: one session_summary per transcript, a file of another name skipped', () => {
  harness((config, deps) => {
    assert.equal(run(['backfill', '--config', config, FIXTURE, '/x/notes.jsonl'], deps), 0)
    assert.deepEqual(deps.errs, ['backfill: notes.jsonl is not a session transcript, skipped'])
    assert.deepEqual(deps.outs, ['backfill: 1 session(s) summarized'])
    const line = JSON.parse(readFileSync(join(config, 'telemetry', 'events', '2026-11-13.jsonl'), 'utf8')) as Record<string, unknown>
    assert.equal(line['event'], 'session_summary')
    assert.equal(line['ts'], '2026-11-13T19:32:00.000Z')
    assert.equal(line['source'], 'transcript')
  })
})

test('usage: no subcommand, no config, an unknown subcommand', () => {
  harness((config, deps) => {
    assert.equal(run([], deps), 2)
    assert.equal(run(['append'], deps), 2)
    assert.equal(run(['nope', '--config', config], deps), 2)
    assert.equal(deps.errs.length, 3)
  })
})

test('enrich leaves other events and unknown sessions as they came; secrets of a missing file are none', () => {
  assert.equal(enrich('bad', '/nowhere'), 'bad')
  assert.equal(enrich(end, '/nowhere'), end)
  assert.equal(readSecrets({ TELEMETRY_ENV_FILE: '/nowhere/.env' }).size, 0)
  assert.equal(backfillEvent('/x/notes.jsonl', 0), undefined)
})
