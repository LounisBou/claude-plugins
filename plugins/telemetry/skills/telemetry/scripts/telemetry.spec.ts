// The command line: append with the session_end enriched from its transcript, check, export when
// the repository is unset, backfill, and the usage.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findingId } from '../../../core/lens.ts'
import { backfillEvent, enrich, lastAnswer, readSecrets, realCheck, realGh, realGit, realRepositoryAt, run, type Deps } from './telemetry.ts'

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
    git: realGit, now: () => Date.parse('2026-11-13T21:00:00Z'), detach: (dir: string, work?: 'sweep') => { detached.push(work === undefined ? dir : `${work}:${dir}`) }, exportWaitMs: 0, outs, errs, detached,
    gh: realGh, check: () => ({ status: 1, stdout: '', stderr: 'no checkout' }), repositoryAt: () => undefined, cwd: root,
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

test('errors: the failed calls of the store, grouped, read without the env file; a bad --since is refused', () => {
  harness((config, deps) => {
    mkdirSync(join(config, 'telemetry', 'events'), { recursive: true })
    const refused = (ts: string, pr: number) => JSON.stringify({ v: 1, ts, event: 'tool_call', session: S, tool: 'mcp__github__gh', mcp_server: 'github', outcome: 'refused', decided_by: 'plugin:github', command: 'pr-merge', error_message: `github: a/b#${pr} is not ready` })
    writeFileSync(join(config, 'telemetry', 'events', '2026-11-13.jsonl'), `${refused('2026-11-13T20:00:00.000Z', 3)}\n${refused('2026-11-13T20:30:00.000Z', 4)}\n`)
    mkdirSync(join(config, 'env-dir'))
    const unreadable: Deps = { ...deps, env: { ...deps.env, TELEMETRY_ENV_FILE: join(config, 'env-dir') } }
    assert.equal(run(['errors', '--config', config, '--since', '2026-11-13T00:00:00Z'], unreadable), 0)
    assert.deepEqual(deps.outs.map(l => l.slice(0, 60)), [
      'errors since 2026-11-13T00:00Z: 2 failed call(s)', 'plugin (2 call(s), 1 group(s)):', '2× refused plugin:github pr-merge: github: <repo>#<n> is not ready'.slice(0, 60),
    ])
    assert.equal(existsSync(join(config, 'telemetry', 'errors.json')), false)
    assert.equal(run(['errors', '--config', config], unreadable), 0)
    assert.equal(existsSync(join(config, 'telemetry', 'errors.json')), true)
    assert.equal(run(['errors', '--config', config, '--since', 'yesterday'], unreadable), 2)
    assert.deepEqual(deps.errs, ['errors: --since takes an ISO time (2026-11-20T00:00:00Z)'])
  })
})

test('errors: --orchestration reads one orchestration with a cursor of its own, --plugins adds the plugins\' errors; a missing name, or --plugins alone, is refused', () => {
  harness((config, deps) => {
    mkdirSync(join(config, 'telemetry', 'events'), { recursive: true })
    const T2 = '11111111-2222-4333-8444-555555555555'
    const failed = (more: Record<string, unknown>) => JSON.stringify({ v: 1, ts: '2026-11-13T20:00:00.000Z', event: 'tool_call', session: S, outcome: 'error', ...more })
    const named = (session: string, title: string) => JSON.stringify({ v: 1, ts: '2026-11-13T19:00:00.000Z', event: 'tool_call', session, outcome: 'ok', tool: 'Edit', title })
    writeFileSync(join(config, 'telemetry', 'events', '2026-11-13.jsonl'), [
      named(S, 'Orch: demo'), named(T2, 'Orch: other'),
      failed({ tool: 'Edit', error_message: 'mine' }), failed({ tool: 'Edit', session: T2, error_message: 'theirs' }),
      failed({ tool: 'mcp__github__gh', mcp_server: 'github', session: T2, error_message: 'a plugin of theirs' }),
    ].join('\n') + '\n')
    const since = ['--since', '2026-11-13T00:00:00Z']
    assert.equal(run(['errors', '--config', config, ...since, '--orchestration', 'Orch: demo [a1b2c3]'], deps), 0)
    assert.deepEqual(deps.outs.map(l => l.slice(0, 44)), ['errors since 2026-11-13T00:00Z: 1 failed call(s)', 'other (1 call(s), 1 group(s)):', '1× error Edit: mine [11-13 20:00Z, 1 session(s)]'].map(l => l.slice(0, 44)))
    deps.outs.length = 0
    assert.equal(run(['errors', '--config', config, ...since, '--orchestration', 'Orch: demo', '--plugins'], deps), 0)
    assert.equal(deps.outs[0], 'errors since 2026-11-13T00:00Z: 2 failed call(s)')
    assert.equal(existsSync(join(config, 'telemetry', 'errors-Orch%3A%20demo.json')), false, '--since moves no cursor, scoped or not')
    assert.equal(run(['errors', '--config', config, '--orchestration', 'Orch: demo'], deps), 0)
    assert.equal(existsSync(join(config, 'telemetry', 'errors-Orch%3A%20demo.json')), true)
    assert.equal(existsSync(join(config, 'telemetry', 'errors.json')), false)
    for (const bad of [['--orchestration'], ['--orchestration', '--plugins'], ['--plugins'], ['--orchestration', 'billing'], ['--orchestration=Orch: demo'], ['--orchestration', 'Orch: demo', '--plugin']]) {
      deps.errs.length = 0
      assert.equal(run(['errors', '--config', config, ...bad], deps), 2, bad.join(' '))
      assert.deepEqual(deps.errs, ['errors: usage: [--since <ISO>] [--orchestration "Orch: billing" [--plugins]]; --orchestration takes a session name and --plugins goes with it'])
    }
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
// realGit, which the export runs, inherits this process's environment: the commit needs an identity a runner has no config for.
Object.assign(process.env, gitEnv)

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

test('export --auto --foreground pushes the day files, the index and the redacted transcript, the manifest pointing at its copy in the repository', () => {
  harness((config, deps, setStdin) => {
    mkdirSync(join(config, 'projects', '-w'), { recursive: true })
    cpSync(FIXTURE, join(config, 'projects', '-w', `${S}.jsonl`))
    setStdin(`${end}\n`)
    assert.equal(run(['append', '--config', config], deps), 0)
    const logs = withLogs(config, deps)
    const withRepo = { ...deps, env: logs.env, now: () => Date.parse('2026-11-14T09:00:00Z') }
    assert.equal(run(['export', '--auto', '--foreground', '--config', config], withRepo), 0)
    assert.equal(deps.outs.at(-1), 'export: 1 day file(s) and 1 transcript(s) of box pushed to the logs repository')
    const manifest = JSON.parse(logs.show('index/box/2026-11-13.json')) as { sessions: { session: string; role: string; transcript: string }[] }
    assert.deepEqual(manifest.sessions.map(({ session, role, transcript }) => ({ session, role, transcript })), [{ session: S, role: 'orchestrator', transcript: `machines/box/transcripts/${S}.jsonl` }])
    assert.ok(logs.show(`machines/box/transcripts/${S}.jsonl`).length > 0)
    assert.ok(logs.show('index/README.md').length > 0)
    // The end's own sweep, and no export handed on: the foreground run did it.
    assert.deepEqual(deps.detached, [`sweep:${config}`])
  })
})

test('export archives the closed rows\' files of the orchestrator\'s module directory, where its environment moved it, then removes them', () => {
  harness((config, deps) => {
    const module = join(config, 'elsewhere')
    mkdirSync(join(module, 'briefs', 'demo'), { recursive: true })
    writeFileSync(join(module, 'briefs', 'demo', 'dispatch-record.jsonl'), `${JSON.stringify({ id: 1, state: 'closed', closed: '2026-10-20T10:00:00Z', label: 'ONE: first' })}\n`)
    writeFileSync(join(module, 'briefs', 'demo', 'one-brief.md'), 'Row: 1 ONE: first\n')
    const logs = withLogs(config, deps)
    assert.equal(run(['export', '--config', config], { ...deps, env: { ...logs.env, ORCHESTRATOR_MODULE_DIR: module } }), 0)
    assert.deepEqual(deps.outs, ['export: 0 day file(s), 1 archived file(s) of box pushed to the logs repository', 'export: archive: 1 file(s) exported, 1 removed from this machine, 0 kept'])
    assert.equal(logs.show('demo/2026-10/box/brief/one-brief.md'), 'Row: 1 ONE: first\n')
    assert.equal(existsSync(join(module, 'briefs', 'demo', 'one-brief.md')), false)
  })
})

test('export --auto without --foreground hands the work to a detached process and pushes nothing itself', () => {
  harness((config, deps, setStdin) => {
    setStdin(`${end}\n`)
    const logs = withLogs(config, deps)
    run(['append', '--config', config], { ...deps, env: { ...deps.env } })
    const before = deps.outs.length
    assert.equal(run(['export', '--auto', '--config', config], { ...deps, env: logs.env }), 0)
    assert.deepEqual(deps.detached, [`sweep:${config}`, config])
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
    assert.deepEqual(deps.detached, [`sweep:${config}`, config])
    assert.equal(logs.show('machines/box/2026-11-13.jsonl'), '')
  })
})

test('a session_end starts the day\'s sweep, detached, until one took the day; sweep --auto runs once a day, sweep alone always', () => {
  harness((config, early, setStdin) => {
    // Two days after the transcript's last entry.
    const deps = { ...early, now: () => Date.parse('2026-11-15T06:00:00Z') }
    mkdirSync(join(config, 'projects', '-w'), { recursive: true })
    cpSync(FIXTURE, join(config, 'projects', '-w', `${S}.jsonl`))
    const other = '11111111-2222-4333-8444-555555555555'
    // An earlier session left events and no end; another one ends now.
    setStdin(`${JSON.stringify({ v: 1, ts: '2026-11-12T20:00:00.000Z', event: 'turn_end', session: S })}\n${end.replace(S, other)}\n`)
    assert.equal(run(['append', '--config', config], deps), 0)
    assert.deepEqual(deps.detached, [`sweep:${config}`])
    assert.equal(run(['sweep', '--auto', '--config', config], deps), 0)
    assert.equal(deps.outs.at(-1), 'sweep: 1 session(s) without an end summarized, 0 round question(s) recorded, 0 dispatch(es) recorded')
    const said = deps.outs.length
    assert.equal(run(['sweep', '--auto', '--config', config], deps), 0)
    assert.equal(deps.outs.length, said)
    setStdin(`${end.replace(S, other)}\n`)
    assert.equal(run(['append', '--config', config], deps), 0)
    assert.deepEqual(deps.detached, [`sweep:${config}`])
    assert.equal(run(['sweep', '--config', config], deps), 0)
    assert.equal(deps.outs.at(-1), 'sweep: 0 session(s) without an end summarized, 0 round question(s) recorded, 0 dispatch(es) recorded')
    const summaries = readFileSync(join(config, 'telemetry', 'events', '2026-11-13.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>).filter(e => e['event'] === 'session_summary')
    assert.deepEqual(summaries.map(e => [e['session'], e['source']]), [[S, 'sweep']])
  })
})

test('sweep reads the round of the orchestrator\'s module directory, where its environment moved it', () => {
  harness((config, deps) => {
    const module = join(config, 'elsewhere')
    mkdirSync(join(module, 'round'), { recursive: true })
    writeFileSync(join(module, 'round', 'q.json'), JSON.stringify({
      v: 2, id: 'q-1', sender: { session: S, name: 'Orch: billing' }, choices: [], recommended: null, status: 'answered', at: '2026-11-13T10:00:00.000Z',
      answer: { text: 'do it', by: 'tab', at: '2026-11-13T10:01:00.000Z' },
    }))
    writeFileSync(join(module, 'round', 'far.json'), JSON.stringify({
      v: 2, id: 'q-2', sender: { session: 'elsewhere', name: 'Orch: far' }, choices: [], recommended: null, status: 'answered', at: '2026-11-13T10:00:00.000Z',
      answer: { text: 'do it', by: 'tab', at: '2026-11-13T10:01:00.000Z' },
    }))
    assert.equal(run(['sweep', '--config', config], { ...deps, env: { ...deps.env, ORCHESTRATOR_MODULE_DIR: module } }), 0)
    assert.deepEqual(deps.errs, ['telemetry: a line was refused (bad session)'])
    assert.equal(deps.outs.at(-1), 'sweep: 0 session(s) without an end summarized, 1 round question(s) recorded, 0 dispatch(es) recorded')
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

test('report: the week\'s report is printed, an option it does not know refused', () => {
  harness((config, deps) => {
    assert.equal(run(['report', '--config', config, '--week', '2026-11-08', '--tool', 'acme/tool'], { ...deps, gh: () => ({ status: 1, stdout: '', stderr: 'offline' }) }), 0)
    assert.equal(deps.outs[0], 'weekly report 2026-11-08 → 2026-11-14 (Europe/Paris), tool: acme/tool')
    assert.equal(run(['report', '--config', config, '--day', 'x'], deps), 2)
    assert.equal(deps.errs.at(-1), 'report: --day x: expected --week <YYYY-MM-DD> or --tool <owner/name>')
  })
})

test('report needs no secret: an env file that cannot be read does not stop it', () => {
  harness((config, deps) => {
    const env = { ...deps.env, TELEMETRY_ENV_FILE: join(config, 'env-dir') }
    mkdirSync(join(config, 'env-dir'), { recursive: true })
    assert.equal(run(['report', '--config', config, '--tool', 'acme/tool'], { ...deps, env, gh: () => ({ status: 1, stdout: '', stderr: 'offline' }) }), 0)
    assert.match(deps.outs[0] ?? '', /^weekly report /)
  })
})

test('gh and the repository of a directory, read for real: a failure is a status, a remote is its owner/name, none is nothing', () => {
  harness((_config, deps) => {
    assert.notEqual(realGh(['--no-such-flag']).status, 0)
    const dir = join(deps.cwd, 'clone')
    mkdirSync(dir)
    assert.equal(realRepositoryAt(dir), undefined)
    spawnSync('git', ['init', '--quiet', dir], { env: { ...process.env, ...gitEnv } })
    assert.equal(realRepositoryAt(dir), undefined)
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/tool.git'], { env: { ...process.env, ...gitEnv } })
    assert.equal(realRepositoryAt(dir), 'acme/tool')
  })
})

test('a checkout\'s script is run for real with --json: its answer is read whatever its status, a missing script is a failure with no figures', () => {
  harness((_config, deps) => {
    const dir = join(deps.cwd, 'tooling')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'prompts.ts'), '')
    writeFileSync(join(dir, 'prompts.js'), 'console.log(JSON.stringify({ args: process.argv.slice(2) })); process.exit(1)\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { prompts: 'node prompts.js', rules: 'node prompts.js' } }))
    const failing = realCheck(dir, 'prompts')
    assert.equal(failing.status, 1)
    assert.deepEqual(JSON.parse(failing.stdout), { args: ['--json'] })
    // The package's own `rules` script is never run: the directory holds no scripts/rules.ts.
    const missing = realCheck(dir, 'rules')
    assert.equal(missing.status, 1)
    assert.equal(missing.stdout, '')
    assert.match(missing.stderr, /^no scripts\/rules\.ts in it/)
  })
})

test('report: the checkout\'s figures reach the report through the dependency, run in the working directory', () => {
  harness((config, deps) => {
    const asked: string[] = []
    const check = (checkout: string, script: string) => {
      asked.push(`${script}@${checkout}`)
      return { status: 0, stdout: script === 'prompts' ? JSON.stringify({ budgets: { a: { tokens: 1, budget: 2 } }, duplicates: { count: 0, ceiling: 0 } }) : JSON.stringify({ plugins: [{ plugin: 'a', rules: 1, byCode: 1, byEval: 0, left: 0 }] }), stderr: '' }
    }
    assert.equal(run(['report', '--config', config, '--week', '2026-11-08', '--tool', 'acme/tool'], { ...deps, check, gh: () => ({ status: 1, stdout: '', stderr: 'offline' }) }), 0)
    assert.deepEqual(asked, [`prompts@${deps.cwd}`, `rules@${deps.cwd}`])
    assert.ok(deps.outs.includes('prompt budgets: all 1 plugin within their budget (a 1/2)'))
    assert.ok(deps.outs.includes('duplicates: 0 sentences said more than once, ceiling 0: within'))
    assert.ok(deps.outs.includes('rules held by prose alone: 0 of 1 (held by code 1, named by an eval 0)'))
  })
})

/** A transcript of two turns: a cold start, then a turn 70 minutes later with two calls. */
const CALL_LINES = [
  { type: 'user', timestamp: '2026-11-17T10:00:00.000Z', promptId: 'p1', message: { content: 'never kept' } },
  { type: 'assistant', timestamp: '2026-11-17T10:00:02.000Z', requestId: 'req_1', message: { id: 'm1', model: 'claude-opus-5-5', content: [], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 30000 } } },
  { type: 'user', timestamp: '2026-11-17T11:10:00.000Z', promptId: 'p2', message: { content: 'never kept' } },
  { type: 'assistant', timestamp: '2026-11-17T11:10:02.000Z', message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'never kept' } }], stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 31000, new_field: 7 } } },
  { type: 'assistant', timestamp: '2026-11-17T11:10:09.000Z', message: { id: 'm3', model: 'claude-opus-5-5', content: [], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 31000, cache_creation_input_tokens: 200 } } },
].map(l => JSON.stringify(l)).join('\n')
const turnEndLine = (extra: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, ts: '2026-11-17T11:10:10.000Z', event: 'turn_end', session: S, turn: 'host-turn', title: 'Agent: x', role: 'agent', ...extra })

test('append: a turn_end of the session\'s own loop is followed by the api_call lines of its turn, raw; a subagent\'s, one the transcript does not hold, one with no turn are as they came', () => {
  harness((config, deps, setStdin) => {
    mkdirSync(join(config, 'projects', '-w'), { recursive: true })
    writeFileSync(join(config, 'projects', '-w', `${S}.jsonl`), `${CALL_LINES}\n`)
    const child = turnEndLine({ agent: 'a1' })
    const early = turnEndLine({ ts: '2026-11-17T10:30:00.000Z' })
    const noCall = turnEndLine({ ts: '2026-11-17T11:10:40.000Z', duration_ms: 5_000 })
    for (const line of [child, early, noCall]) assert.equal(enrich(line, config), line)
    const ghost = turnEndLine({ session: '00000000-0000-0000-0000-000000000000' })
    assert.equal(enrich(ghost, config), ghost)
    const broken = '11111111-1111-1111-1111-111111111111'
    mkdirSync(join(config, 'projects', '-w', `${broken}.jsonl`), { recursive: true })
    const unreadable = turnEndLine({ session: broken })
    assert.equal(enrich(unreadable, config), unreadable)
    setStdin(`${turnEndLine({ duration_ms: 20_000 })}\n`)
    assert.equal(run(['append', '--config', config], deps), 0)
    const lines = readFileSync(join(config, 'telemetry', 'events', '2026-11-17.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    assert.deepEqual(lines.map(l => l['event']), ['turn_end', 'api_call', 'api_call'])
    const [, first, second] = lines
    assert.deepEqual([first?.['ts'], first?.['end'], first?.['message'], first?.['prompt'], first?.['stop_reason'], first?.['tools'], first?.['title'], first?.['role']], ['2026-11-17T11:10:02.000Z', '2026-11-17T11:10:02.000Z', 'm2', 'p2', 'tool_use', ['Bash'], 'Agent: x', 'agent'])
    assert.deepEqual(first?.['usage'], { input_tokens: 3, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 31000, new_field: 7 })
    assert.equal(second?.['message'], 'm3')
    assert.ok(!JSON.stringify(lines).includes('never kept'))
  })
})

test('backfill --calls: one api_call per call of the transcript beside the summary, none without the flag', () => {
  harness((config, deps) => {
    const path = join(config, `${S}.jsonl`)
    mkdirSync(config, { recursive: true })
    writeFileSync(path, `${CALL_LINES}\n`)
    assert.equal(run(['backfill', '--config', config, path], deps), 0)
    assert.deepEqual(deps.outs, ['backfill: 1 session(s) summarized'])
    assert.equal(run(['backfill', '--calls', '--config', config, path, '/x/notes.jsonl'], deps), 0)
    assert.equal(deps.outs.at(-1), 'backfill: 1 session(s) summarized, 3 API call(s) read back')
    const events = readFileSync(join(config, 'telemetry', 'events', '2026-11-17.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    assert.deepEqual(events.filter(e => e['event'] === 'api_call').map(e => [e['message'], e['request']]), [['m1', 'req_1'], ['m2', undefined], ['m3', undefined]])
    assert.equal(events.filter(e => e['event'] === 'session_summary').length, 2)
  })
})

/** The same two turns, as a subagent's transcript writes them: every entry a sidechain one, with its effort. */
const SUBAGENT_LINES = CALL_LINES.split('\n').map(l => JSON.stringify({ ...JSON.parse(l) as Record<string, unknown>, isSidechain: true, agentId: 'a1', effort: 'low' })).join('\n')
const closedLine = (extra: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, ts: '2026-11-17T11:10:10.000Z', event: 'agent_closed', session: S, kind: 'subagent', child: 'a1', run: 2, duration_ms: 20_000, reason: 'answer', role: 'agent', ...extra })

test('append: a subagent\'s agent_closed takes its type, task, model, effort and the token sums of the run that ended, from its transcript; one the transcript does not hold is as it came', () => {
  harness((config, deps, setStdin) => {
    const dir = join(config, 'projects', '-w', S, 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(config, 'projects', '-w', `${S}.jsonl`), `${CALL_LINES}\n`)
    writeFileSync(join(dir, 'agent-a1.jsonl'), `${SUBAGENT_LINES}\n`)
    writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'orchestrator:lens', description: 'Lens: correctness', pickedEffortModel: 'claude-opus-5-5' }))
    for (const line of [closedLine({ child: 'a9' }), closedLine({ kind: 'session', child: undefined, title: 'Agent: x' }), closedLine({ session: '00000000-0000-0000-0000-000000000000' })]) assert.equal(enrich(line, config), line)
    const first = JSON.parse(enrich(closedLine({ ts: '2026-11-17T10:00:03.000Z', run: 1, duration_ms: 5_000 }), config).split('\n')[0] ?? '') as Record<string, unknown>
    assert.deepEqual([first['calls'], first['totals']], [1, { in: 2, out: 9, cache_read: 0, cache_write: 30000 }])
    setStdin(`${closedLine()}\n`)
    assert.equal(run(['append', '--config', config], deps), 0)
    const lines = readFileSync(join(config, 'telemetry', 'events', '2026-11-17.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    assert.deepEqual(lines.map(l => l['event']), ['agent_closed', 'api_call', 'api_call'])
    const closed = lines[0] ?? {}
    assert.deepEqual(
      [closed['subagent_type'], closed['description'], closed['models'], closed['effort'], closed['calls'], closed['totals'], closed['role']],
      ['orchestrator:lens', 'Lens: correctness', ['claude-opus-5-5'], 'low', 2, { in: 6, out: 25, cache_read: 31000, cache_write: 31200 }, 'agent'],
    )
    assert.ok(!JSON.stringify(lines).includes('never kept'))
  })
})

test('append: a turn_end of the session\'s own loop carries the reasoning effort of its turn\'s last call, while the session runs; with none in the transcript it is as it came', () => {
  harness((config, deps, setStdin) => {
    mkdirSync(join(config, 'projects', '-w'), { recursive: true })
    // The turn's three calls: the first names an effort, the second another, the last none; the last one that names one is read.
    const efforts: Record<string, string> = { m1: 'low', m2: 'high' }
    const withEffort = CALL_LINES.split('\n').map(l => { const entry = JSON.parse(l) as { type: string; message?: { id?: string } }; const effort = efforts[entry.message?.id ?? '']; return JSON.stringify(entry.type === 'assistant' && effort !== undefined ? { ...entry, effort } : entry) }).join('\n')
    writeFileSync(join(config, 'projects', '-w', `${S}.jsonl`), `${withEffort}\n`)
    setStdin(`${turnEndLine()}\n`)
    assert.equal(run(['append', '--config', config], deps), 0)
    const lines = readFileSync(join(config, 'telemetry', 'events', '2026-11-17.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    assert.deepEqual(lines.map(l => [l['event'], l['effort']]), [['turn_end', 'high'], ['api_call', undefined], ['api_call', undefined]])
    assert.equal(lines[0]?.['turn'], 'host-turn')
    writeFileSync(join(config, 'projects', '-w', `${S}.jsonl`), `${CALL_LINES}\n`)
    assert.equal(JSON.parse(enrich(turnEndLine(), config).split('\n')[0] ?? '{}').effort, undefined)
  })
})

test('lastAnswer: the last hand-back inside the window, else the last text; an empty or non-string hand-back and one outside the window are not the answer', () => {
  const entry = (at: string, content: unknown[]): string => JSON.stringify({ type: 'assistant', timestamp: at, message: { content } })
  const handback = (message: unknown) => ({ type: 'tool_use', name: 'SubagentHandback', input: { message } })
  const text = (t: string) => ({ type: 'text', text: t })
  const from = Date.parse('2026-11-17T11:00:00.000Z')
  const to = Date.parse('2026-11-17T11:10:00.000Z')
  const body = (...lines: string[]): string => lines.join('\n')
  assert.equal(lastAnswer(body(entry('2026-11-17T11:01:00.000Z', [handback('first')]), entry('2026-11-17T11:02:00.000Z', [text('then text'), handback('second')])), from, to), 'second')
  assert.equal(lastAnswer(body(entry('2026-11-17T11:01:00.000Z', [text('the text'), handback('')]), entry('2026-11-17T11:02:00.000Z', [handback(7)])), from, to), 'the text')
  assert.equal(lastAnswer(body(entry('2026-11-17T11:01:00.000Z', [text('the text')]), entry('2026-11-17T12:00:00.000Z', [handback('too late')]), entry('2026-11-17T10:00:00.000Z', [handback('too early')])), from, to), 'the text')
  assert.equal(lastAnswer('', from, to), '')
})

test('append: a review reader that hands its report back counts the finding lines of the hand-back, not the line of text that follows it', () => {
  harness((config, deps, setStdin) => {
    const dir = join(config, 'projects', '-w', S, 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(config, 'projects', '-w', `${S}.jsonl`), `${CALL_LINES}\n`)
    // As the hosts write it: the findings in a SubagentHandback call's message, a short text beside it.
    const message = [
      'Read the diff.',
      '[important] plugins/github/hooks/register.ts:1338 — Nothing tests how `kept` is filled — never kept',
      '- [important] scripts/deploy.test.ts:~337 — one failing configuration is not proved — never kept',
      '[critical] scripts/deploy.ts:206-214 (`existsSync` filter) — both branches are untested — never kept',
      'important | test/test_dead_tcp.c:554 (guard at IP_Commands.c:245) | The test claims too much | never kept',
    ].join('\n')
    const answer = { type: 'assistant', isSidechain: true, timestamp: '2026-11-17T11:10:09.500Z', message: { id: 'm4', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Handed back.' }, { type: 'tool_use', id: 't1', name: 'SubagentHandback', input: { message } }], usage: { input_tokens: 1, output_tokens: 1 } } }
    writeFileSync(join(dir, 'agent-a1.jsonl'), `${SUBAGENT_LINES}\n${JSON.stringify(answer)}\n`)
    writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'orchestrator:lens', description: 'lens tests acme/thing#12 origin/main..0123456789ab' }))
    setStdin(`${closedLine()}\n`)
    assert.equal(run(['append', '--config', config], deps), 0)
    const day = readFileSync(join(config, 'telemetry', 'events', '2026-11-17.jsonl'), 'utf8')
    const closed = JSON.parse(day.split('\n')[0] ?? '{}') as Record<string, unknown>
    assert.deepEqual(closed['findings'], { critical: 1, important: 3, minor: 0 })
    assert.equal((closed['finding_ids'] as string[]).length, 4)
    assert.ok(!day.includes('never kept'))
  })
})

test('append: a subagent\'s run end is followed by one api_call per call of the run, raw, naming the child (`agent`) and stamped like the event', () => {
  harness((config, deps, setStdin) => {
    const dir = join(config, 'projects', '-w', S, 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(config, 'projects', '-w', `${S}.jsonl`), `${CALL_LINES}\n`)
    writeFileSync(join(dir, 'agent-a1.jsonl'), `${SUBAGENT_LINES}\n`)
    setStdin(`${closedLine({ title: 'Agent: x', parent: 'Orch: y' })}\n`)
    assert.equal(run(['append', '--config', config], deps), 0)
    const lines = readFileSync(join(config, 'telemetry', 'events', '2026-11-17.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    assert.deepEqual(lines.map(l => [l['event'], l['message'], l['agent']]), [['agent_closed', undefined, undefined], ['api_call', 'm2', 'a1'], ['api_call', 'm3', 'a1']])
    const call = lines[1] ?? {}
    assert.deepEqual([call['ts'], call['title'], call['role'], call['parent'], call['usage']], ['2026-11-17T11:10:02.000Z', 'Agent: x', 'agent', 'Orch: y', { input_tokens: 3, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 31000, new_field: 7 }])
  })
})

test('append: a review reader\'s run end names its lens, pull request and range from its description, and its findings by severity with their ids from its last answer', () => {
  harness((config, deps, setStdin) => {
    const dir = join(config, 'projects', '-w', S, 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(config, 'projects', '-w', `${S}.jsonl`), `${CALL_LINES}\n`)
    const answer = { type: 'assistant', isSidechain: true, timestamp: '2026-11-17T11:10:09.500Z', message: { id: 'm4', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '[important] src/a.ts:12 — the lock is lost — never kept\n[minor] b.md:3 — a typo — never kept\nnever kept' }], usage: { input_tokens: 1, output_tokens: 1 } } }
    writeFileSync(join(dir, 'agent-a1.jsonl'), `${SUBAGENT_LINES}\n${JSON.stringify(answer)}\n`)
    writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'orchestrator:lens', description: 'lens correctness acme/thing#12 origin/main..0123456789ab' }))
    setStdin(`${closedLine()}\n`)
    assert.equal(run(['append', '--config', config], deps), 0)
    const closed = JSON.parse(readFileSync(join(config, 'telemetry', 'events', '2026-11-17.jsonl'), 'utf8').split('\n')[0] ?? '{}') as Record<string, unknown>
    assert.deepEqual([closed['lens'], closed['target'], closed['range'], closed['findings']], ['correctness', { repo: 'acme/thing', pr: 12 }, 'origin/main..0123456789ab', { critical: 0, important: 1, minor: 1 }])
    assert.deepEqual(closed['finding_ids'], [findingId('correctness', 'src/a.ts', 12, 'the lock is lost'), findingId('correctness', 'b.md', 3, 'a typo')])
    assert.ok(!readFileSync(join(config, 'telemetry', 'events', '2026-11-17.jsonl'), 'utf8').includes('never kept'))
  })
})
