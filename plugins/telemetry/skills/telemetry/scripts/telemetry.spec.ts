// The command line: append with the session_end enriched from its transcript, check, export when
// the repository is unset, backfill, and the usage.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backfillEvent, enrich, readSecrets, realGit, run, transcriptPointer, type Deps } from './telemetry.ts'

const S = '60ed5626-9879-4041-892a-5db0ff0bad69'
const FIXTURE = fileURLToPath(new URL(`../../../tests/fixtures/${S}.jsonl`, import.meta.url))
const end = JSON.stringify({ v: 1, ts: '2026-11-13T20:00:00.000Z', event: 'session_end', session: S, reason: 'other' })

function harness(work: (config: string, deps: Deps & { outs: string[]; errs: string[]; detached: string[] }, setStdin: (text: string) => void) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'telemetry-cli-'))
  const config = join(root, 'config')
  const envFile = join(root, 'env')
  writeFileSync(envFile, 'SERVICE_PASS=a-long-enough-value\n')
  let stdin = ''
  const outs: string[] = []
  const errs: string[] = []
  const detached: string[] = []
  const deps = {
    env: { TELEMETRY_ENV_FILE: envFile, TELEMETRY_MACHINE: 'box' }, stdin: () => stdin, out: (l: string) => outs.push(l), err: (l: string) => errs.push(l),
    git: realGit, now: () => Date.parse('2026-11-13T21:00:00Z'), detach: (dir: string) => { detached.push(dir) }, exportWaitMs: 0, outs, errs, detached,
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
  assert.deepEqual(readSecrets({ TELEMETRY_ENV_FILE: '/nowhere/.env' }), { secrets: new Map() })
  assert.equal(backfillEvent('/x/notes.jsonl', 0), undefined)
})

test('an env file that exists but cannot be read refuses to write and to export, with its reason', () => {
  harness((config, deps, setStdin) => {
    const unreadable = join(config, 'env-dir')
    mkdirSync(unreadable, { recursive: true })
    const env = { ...deps.env, TELEMETRY_ENV_FILE: unreadable, CLAUDE_LOGS_REPO: join(config, 'logs.git') }
    setStdin(`${end}\n`)
    for (const sub of ['append', 'export']) {
      assert.equal(run([sub, '--config', config], { ...deps, env }), 1)
      assert.match(deps.errs.at(-1) ?? '', new RegExp(`^telemetry: ${sub} refused, nothing written or pushed: .*env-dir cannot be read \\(EISDIR\\)$`))
    }
    assert.deepEqual(deps.outs, [])
    assert.ok(!existsSync(join(config, 'telemetry')))
  })
})

const gitEnv = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }

/** A bare repository in the config's parent, and the deps pointing at it. */
function withLogs(config: string, deps: Deps): { remote: string; env: Deps['env']; show: (path: string) => string } {
  const remote = join(config, '..', 'logs.git')
  spawnSync('git', ['init', '--quiet', '--bare', remote], { env: { ...process.env, ...gitEnv } })
  return {
    remote,
    env: { ...deps.env, CLAUDE_LOGS_REPO: remote },
    show: path => spawnSync('git', ['show', `main:${path}`], { cwd: remote, encoding: 'utf8', env: { ...process.env, ...gitEnv } }).stdout,
  }
}

test('export --auto --foreground pushes the day files and the index, the manifest pointing at the transcript by its path under the config', () => {
  harness((config, deps, setStdin) => {
    mkdirSync(join(config, 'projects', '-w'), { recursive: true })
    cpSync(FIXTURE, join(config, 'projects', '-w', `${S}.jsonl`))
    setStdin(`${end}\n`)
    assert.equal(run(['append', '--config', config], deps), 0)
    const logs = withLogs(config, deps)
    const withRepo = { ...deps, env: logs.env, now: () => Date.parse('2026-11-14T09:00:00Z') }
    assert.equal(run(['export', '--auto', '--foreground', '--config', config], withRepo), 0)
    assert.equal(deps.outs.at(-1), 'export: 1 day file(s) of box pushed to the logs repository')
    const manifest = JSON.parse(logs.show('index/box/2026-11-13.json')) as { sessions: { session: string; role: string; transcript: string }[] }
    assert.deepEqual(manifest.sessions.map(({ session, role, transcript }) => ({ session, role, transcript })), [{ session: S, role: 'orchestrator', transcript: `projects/-w/${S}.jsonl` }])
    assert.ok(logs.show('index/README.md').length > 0)
    assert.deepEqual(deps.detached, [])
  })
})

test('export --auto without --foreground hands the work to a detached process and pushes nothing itself', () => {
  harness((config, deps, setStdin) => {
    setStdin(`${end}\n`)
    const logs = withLogs(config, deps)
    run(['append', '--config', config], { ...deps, env: { ...deps.env } })
    const before = deps.outs.length
    assert.equal(run(['export', '--auto', '--config', config], { ...deps, env: logs.env }), 0)
    assert.deepEqual(deps.detached, [config])
    assert.equal(logs.show('machines/box/2026-11-13.jsonl'), '')
    assert.equal(deps.outs.length, before)
  })
})

test('export --auto with the repository unset says so once', () => {
  harness((config, deps) => {
    assert.equal(run(['export', '--auto', '--config', config], deps), 0)
    assert.equal(run(['export', '--auto', '--config', config], deps), 0)
    assert.equal(deps.outs.length, 1)
    assert.match(deps.outs[0] ?? '', /CLAUDE_LOGS_REPO is not set/)
    assert.deepEqual(deps.detached, [])
  })
})

test('a session_end written starts the automatic export, detached; other events start nothing', () => {
  harness((config, deps, setStdin) => {
    const logs = withLogs(config, deps)
    const withRepo = { ...deps, env: logs.env }
    setStdin(`${JSON.stringify({ v: 1, ts: '2026-11-13T20:00:01.000Z', event: 'tool_call', session: S })}\n`)
    assert.equal(run(['append', '--config', config], withRepo), 0)
    assert.deepEqual(deps.detached, [])
    setStdin(`${end}\n`)
    assert.equal(run(['append', '--config', config], withRepo), 0)
    assert.deepEqual(deps.detached, [config])
    assert.equal(logs.show('machines/box/2026-11-13.jsonl'), '')
  })
})

test('a session_end written with the repository unset says so once, through the writer\'s output', () => {
  harness((config, deps, setStdin) => {
    setStdin(`${end}\n`)
    run(['append', '--config', config], deps)
    run(['append', '--config', config], deps)
    assert.equal(deps.outs.length, 1)
    assert.match(deps.outs[0] ?? '', /CLAUDE_LOGS_REPO is not set/)
  })
})

test('a plain export waits its turn behind a running one, and exits 1 saying so when it stays held', () => {
  harness((config, deps, setStdin) => {
    setStdin(`${end}\n`)
    run(['append', '--config', config], deps)
    const logs = withLogs(config, deps)
    const lock = join(config, 'telemetry', 'export.lock')
    writeFileSync(lock, '1\n')
    assert.equal(run(['export', '--config', config], { ...deps, env: logs.env }), 1)
    assert.equal(deps.outs.at(-1), 'export: another export is running, nothing pushed')
    rmSync(lock)
    assert.equal(run(['export', '--config', config], { ...deps, env: logs.env }), 0)
  })
})

test('the transcript pointer is relative to the config directory, undefined when there is none', () => {
  harness(config => {
    mkdirSync(join(config, 'projects', '-w'), { recursive: true })
    cpSync(FIXTURE, join(config, 'projects', '-w', `${S}.jsonl`))
    assert.equal(transcriptPointer(config, S), `projects/-w/${S}.jsonl`)
    assert.equal(transcriptPointer(config, '70ed5626-9879-4041-892a-5db0ff0bad69'), undefined)
  })
})
