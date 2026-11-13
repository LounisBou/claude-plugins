// The export against a real git repository made in a scratch directory: unset, it pushes nothing;
// a planted secret refuses it; otherwise the first push creates main and the next adds to it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addressForms, exportStore, logsRepo, machineName, safeOutput, type Git } from './export.ts'
import { append, eventsDir } from './store.ts'

const S = '60ed5626-9879-4041-892a-5db0ff0bad69'
const event = (ts: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, ts, event: 'turn_end', session: S, ...extra })
const SECRET = ['sk-', 'ant-', 'api03-', 'q7Lm2Xp9Rz4Kw8Nv3Tb6Hc1Yd5Fs0Gj'].join('')
const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }

const git: Git = (args, cwd) => {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, ...ENV, HOME: cwd ?? tmpdir() } })
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

function scratch(work: (root: string, remote: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'telemetry-export-'))
  try {
    const remote = join(root, 'logs.git')
    assert.equal(git(['init', '--quiet', '--bare', remote], root).status, 0)
    work(root, remote)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('unset: the events stay local and the export says so in one line', () => {
  scratch(root => {
    const result = exportStore({ stateDir: join(root, 'state'), secrets: new Map(), repo: undefined, machine: 'm', git })
    assert.equal(result.code, 0)
    assert.equal(result.lines.length, 1)
    assert.match(result.lines[0] ?? '', /CLAUDE_LOGS_REPO is not set; the events stay local in .*, nothing pushed/)
  })
})

test('a planted secret refuses the export, naming file, line and pattern but never the value', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    appendFileSync(join(eventsDir(state), '2026-11-13.jsonl'), `${event('2026-11-13T10:00:01Z', { note: SECRET })}\n`)
    const result = exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'm', git })
    assert.equal(result.code, 1)
    assert.deepEqual(result.lines, ['export refused: 1 secret(s) found in the store, nothing pushed', '  2026-11-13.jsonl:2: anthropic-key'])
    assert.ok(!result.lines.join('\n').includes(SECRET))
    assert.notEqual(git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], remote).status, 0)
  })
})

test('the first export creates main; a second adds the new day; a third has nothing to push', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const run = () => exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git })
    assert.deepEqual(run().lines, ['export: no event recorded yet, nothing pushed'])
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    assert.deepEqual(run(), { lines: ['export: 1 day file(s) of box pushed to the logs repository'], code: 0 })
    assert.equal(git(['show', 'main:machines/box/2026-11-13.jsonl'], remote).stdout, `${event('2026-11-13T10:00:00Z')}\n`)
    append(eventsDir(state), event('2026-11-14T10:00:00Z'), new Map())
    assert.equal(run().code, 0)
    assert.equal(git(['rev-list', '--count', 'main'], remote).stdout.trim(), '2')
    assert.deepEqual(run().lines, ['export: the logs repository already holds every event, nothing pushed'])
  })
})

test('a reused clone pushes to the repository named now', () => {
  scratch((root, first) => {
    const state = join(root, 'state')
    const second = join(root, 'second.git')
    assert.equal(git(['init', '--quiet', '--bare', second], root).status, 0)
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    assert.equal(exportStore({ stateDir: state, secrets: new Map(), repo: first, machine: 'box', git }).code, 0)
    append(eventsDir(state), event('2026-11-14T10:00:00Z'), new Map())
    assert.deepEqual(exportStore({ stateDir: state, secrets: new Map(), repo: second, machine: 'box', git }).code, 0)
    assert.equal(git(['show', 'main:machines/box/2026-11-14.jsonl'], second).stdout, `${event('2026-11-14T10:00:00Z')}\n`)
    assert.equal(git(['rev-list', '--count', 'main'], first).stdout.trim(), '1')
  })
})

test('a day file an ignore rule of the clone or the machine matches is pushed all the same', () => {
  scratch((root, remote) => {
    // The repository's own rule: a committed .gitignore ignoring every day file.
    const seed = join(root, 'seed')
    assert.equal(git(['clone', '--quiet', remote, seed], root).status, 0)
    writeFileSync(join(seed, '.gitignore'), '*.jsonl\n')
    assert.equal(git(['add', '.gitignore'], seed).status, 0)
    assert.equal(git(['commit', '--quiet', '-m', 'ignore'], seed).status, 0)
    assert.equal(git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], seed).status, 0)
    // The machine's rule: an excludes file ignoring the second day.
    const excludes = join(root, 'excludes')
    writeFileSync(excludes, '2026-11-14.jsonl\n')
    const ignoring: Git = (args, cwd) => git(['-c', `core.excludesFile=${excludes}`, ...args], cwd)
    const state = join(root, 'state')
    const run = () => exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git: ignoring })
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    assert.deepEqual(run(), { lines: ['export: 1 day file(s) of box pushed to the logs repository'], code: 0 })
    assert.equal(git(['show', 'main:machines/box/2026-11-13.jsonl'], remote).stdout, `${event('2026-11-13T10:00:00Z')}\n`)
    append(eventsDir(state), event('2026-11-14T10:00:00Z'), new Map())
    assert.deepEqual(run(), { lines: ['export: 2 day file(s) of box pushed to the logs repository'], code: 0 })
    assert.equal(git(['show', 'main:machines/box/2026-11-14.jsonl'], remote).stdout, `${event('2026-11-14T10:00:00Z')}\n`)
  })
})

/** Makes `remote` refuse every push (`exit 1`), or accept them again. */
function refusePushes(remote: string, refuse: boolean): void {
  writeFileSync(join(remote, 'hooks', 'pre-receive'), `#!/bin/sh\nexit ${refuse ? 1 : 0}\n`, { mode: 0o755 })
}

test('a refused push exits non-zero and claims nothing', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    refusePushes(remote, true)
    const result = exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git })
    assert.equal(result.code, 1)
    assert.match(result.lines[0] ?? '', /^export failed at push \(git exit \d+\): /)
    assert.notEqual(git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], remote).status, 0)
  })
})

test('a commit whose push was refused is pushed by the next export, which says so', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const run = () => exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git })
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    refusePushes(remote, true)
    assert.equal(run().code, 1)
    refusePushes(remote, false)
    assert.deepEqual(run(), { lines: ['export: 1 day file(s) of box pushed to the logs repository'], code: 0 })
    assert.equal(git(['show', 'main:machines/box/2026-11-13.jsonl'], remote).stdout, `${event('2026-11-13T10:00:00Z')}\n`)
    assert.deepEqual(run().lines, ['export: the logs repository already holds every event, nothing pushed'])
  })
})

test('a git error naming the address without its credentials prints no part of it', () => {
  scratch(root => {
    const state = join(root, 'state')
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    const user = ['some', 'one'].join('')
    const repo = `https://${user}:${SECRET}@forge.example/me/logs.git`
    const refusing: Git = () => ({ status: 128, stdout: '', stderr: "remote: Repository not found.\nfatal: repository 'https://forge.example/me/logs/' not found\nfatal: unable to access 'https://forge.example/me/logs.git/': 403" })
    const result = exportStore({ stateDir: state, secrets: new Map(), repo, machine: 'm', git: refusing })
    assert.equal(result.code, 1)
    const printed = result.lines.join('\n')
    for (const part of ['forge.example', 'me/logs', user, SECRET]) assert.ok(!printed.includes(part), printed)
    assert.match(printed, /repository '<logs repository>\/' not found/)
  })
  assert.deepEqual(addressForms('git@forge.example:me/logs.git'), ['git@forge.example:me/logs.git', 'git@forge.example:me/logs', 'me/logs.git', 'me/logs'])
})

test('a failing clone is reported with the repository\'s address hidden', () => {
  scratch(root => {
    const state = join(root, 'state')
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    const missing = join(root, 'nowhere', 'logs.git')
    const result = exportStore({ stateDir: state, secrets: new Map(), repo: missing, machine: 'm', git })
    assert.equal(result.code, 1)
    assert.match(result.lines[0] ?? '', /^export failed at clone \(git exit \d+\): /)
    assert.ok(!result.lines.join('\n').includes(missing))
  })
})

test('the repository is the environment\'s, else the env file\'s; machine names; safe output', () => {
  assert.equal(logsRepo({ CLAUDE_LOGS_REPO: 'a' }, new Map([['CLAUDE_LOGS_REPO', 'b']])), 'a')
  assert.equal(logsRepo({}, new Map([['CLAUDE_LOGS_REPO', 'b']])), 'b')
  assert.equal(logsRepo({ CLAUDE_LOGS_REPO: '' }, new Map()), undefined)
  assert.equal(machineName('Mac-Studio.local'), 'Mac-Studio')
  assert.equal(machineName('my box'), 'my-box')
  assert.equal(machineName('...'), 'machine')
  assert.equal(safeOutput(`fatal: ${'https://forge.example/me/logs.git'} denied ${SECRET}`, 'https://forge.example/me/logs.git', new Map()), 'fatal: <logs repository> denied [REDACTED:anthropic-key]')
})
