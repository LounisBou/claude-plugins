// The export against a real git repository made in a scratch directory: unset, it pushes nothing;
// a planted secret refuses it; otherwise the first push creates main and the next adds to it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withLock } from '../../../../core/store.ts'
import { EVENT_SCHEMA, type KindSpec } from '../../../../hooks/schema.ts'
import { addressForms, exportExclusive, exportStore, logsRepo, machineName, MAX_RUN_BYTES, MAX_TRANSCRIPT_AGE_DAYS, MAX_TRANSCRIPT_BYTES, safeOutput, type Git } from './export.ts'
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

test('the export pushes the index with the day files: the schema pages and the day\'s manifest', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    append(eventsDir(state), `${event('2026-11-13T10:00:00Z')}\n${JSON.stringify({ v: 1, ts: '2026-11-13T10:00:01Z', event: 'session_end', session: S, role: 'reviewer', models: ['claude-opus-5-5'] })}`, new Map())
    const file = join(root, `${S}.jsonl`)
    writeFileSync(file, '{"type":"user","message":"hello"}\n')
    const transcript = (session: string): string | undefined => (session === S ? file : undefined)
    assert.equal(exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git, transcript }).code, 0)
    const files = git(['ls-tree', '-r', '--name-only', 'main'], remote).stdout.trim().split('\n')
    for (const kind of Object.keys(EVENT_SCHEMA)) assert.ok(files.includes(`index/schema/${kind}.md`), kind)
    for (const file of ['index/README.md', 'index/schema.json', 'index/schema/manifest.md', 'machines/box/2026-11-13.jsonl', 'index/box/2026-11-13.json']) assert.ok(files.includes(file), file)
    const manifest = JSON.parse(git(['show', 'main:index/box/2026-11-13.json'], remote).stdout) as { sessions: { session: string; role: string; models: string[]; transcript: string }[] }
    assert.deepEqual(manifest.sessions.map(({ session, role, models, transcript: path }) => ({ session, role, models, path })), [
      { session: S, role: 'reviewer', models: ['claude-opus-5-5'], path: `machines/box/transcripts/${S}.jsonl` },
    ])
  })
})

const PLUGINS = 'LounisBou/claude-plugins'
type Slice = { sessions: { session: string; project: string }[]; events: Record<string, number>; day: string; machine: string }
const projectIndex = (remote: string, path: string): Slice => JSON.parse(git(['show', `main:${path}`], remote).stdout) as Slice

test('the index holds a view per project: index/projects/<owner-name>/<machine>/<day>.json, only that project\'s sessions', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const at = (second: number): string => `2026-11-13T10:00:${String(second).padStart(2, '0')}Z`
    const lineOf = (session: string, extra: Record<string, unknown>, second: number): string => JSON.stringify({ v: 1, ts: at(second), session, ...extra })
    append(eventsDir(state), [
      lineOf(S, { event: 'session_start', project: PLUGINS }, 0),
      lineOf(OTHER, { event: 'session_start', project: 'acme/tool' }, 1),
      lineOf(S, { event: 'turn_end' }, 2),
      lineOf('80ed5626-9879-4041-892a-5db0ff0bad69', { event: 'turn_end' }, 3),
      lineOf(OTHER, { event: 'turn_end' }, 4),
    ].join('\n'), new Map())
    assert.equal(exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git }).code, 0)
    const ours = projectIndex(remote, 'index/projects/lounisbou-claude-plugins/box/2026-11-13.json')
    assert.deepEqual(ours.sessions.map(({ session, project }) => ({ session, project })), [{ session: S, project: PLUGINS }])
    assert.deepEqual(ours.events, { session_start: 1, turn_end: 1 })
    assert.equal(ours.day, '2026-11-13')
    assert.equal(ours.machine, 'box')
    assert.deepEqual(projectIndex(remote, 'index/projects/acme-tool/box/2026-11-13.json').sessions.map(entry => entry.session), [OTHER])
    // The machine's whole index still lists every session, those of no project included.
    assert.equal(projectIndex(remote, 'index/box/2026-11-13.json').sessions.length, 3)
    const files = git(['ls-tree', '-r', '--name-only', 'main', '--', 'index/projects'], remote).stdout.trim().split('\n')
    assert.deepEqual(files, ['index/projects/acme-tool/box/2026-11-13.json', 'index/projects/lounisbou-claude-plugins/box/2026-11-13.json'])
    assert.match(git(['show', 'main:index/README.md'], remote).stdout, /index\/projects\/<owner-name>\/<machine>\/<day>\.json/)
  })
})

test('a session that crosses UTC midnight stays in its project\'s view on the later day, though only its start names the project', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    append(eventsDir(state), [
      JSON.stringify({ v: 1, ts: '2026-11-13T23:59:00Z', event: 'session_start', session: S, project: PLUGINS }),
      JSON.stringify({ v: 1, ts: '2026-11-14T00:01:00Z', event: 'turn_end', session: S }),
    ].join('\n'), new Map())
    assert.equal(exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git }).code, 0)
    const files = git(['ls-tree', '-r', '--name-only', 'main', '--', 'index/projects'], remote).stdout.trim().split('\n')
    assert.deepEqual(files, ['index/projects/lounisbou-claude-plugins/box/2026-11-13.json', 'index/projects/lounisbou-claude-plugins/box/2026-11-14.json'])
    const later = projectIndex(remote, 'index/projects/lounisbou-claude-plugins/box/2026-11-14.json')
    assert.deepEqual(later.sessions.map(entry => entry.session), [S])
    assert.deepEqual(later.events, { turn_end: 1 })
  })
})

test('the project views of a machine are made again: a project no day names any longer leaves nothing stale; another machine\'s are kept', () => {
  scratch((root, remote) => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    const start = (project: string): string => JSON.stringify({ v: 1, ts: '2026-11-13T10:00:00Z', event: 'session_start', session: S, project })
    append(eventsDir(first), start('acme/old'), new Map())
    append(eventsDir(second), start('acme/old'), new Map())
    assert.equal(exportStore({ stateDir: first, secrets: new Map(), repo: remote, machine: 'one', git }).code, 0)
    assert.equal(exportStore({ stateDir: second, secrets: new Map(), repo: remote, machine: 'two', git }).code, 0)
    rmSync(eventsDir(first), { recursive: true })
    append(eventsDir(first), start('acme/new'), new Map())
    assert.equal(exportStore({ stateDir: first, secrets: new Map(), repo: remote, machine: 'one', git }).code, 0)
    const files = git(['ls-tree', '-r', '--name-only', 'main', '--', 'index/projects'], remote).stdout.trim().split('\n')
    assert.deepEqual(files, ['index/projects/acme-new/one/2026-11-13.json', 'index/projects/acme-old/two/2026-11-13.json'])
  })
})

test('two spellings of one repository\'s case share one project directory, the project field keeping its case', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    append(eventsDir(state), ['LounisBou/x', 'lounisbou/x'].map((project, i) => JSON.stringify({ v: 1, ts: `2026-11-13T10:00:0${i}Z`, event: 'session_start', session: i === 0 ? S : OTHER, project })).join('\n'), new Map())
    assert.equal(exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git }).code, 0)
    const files = git(['ls-tree', '-r', '--name-only', 'main', '--', 'index/projects'], remote).stdout.trim().split('\n')
    assert.deepEqual(files, ['index/projects/lounisbou-x/box/2026-11-13.json'])
    assert.deepEqual(projectIndex(remote, files[0] ?? '').sessions.map(entry => entry.project).sort(), ['LounisBou/x', 'lounisbou/x'])
  })
})

test('a project name that is no safe directory name is made one', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    append(eventsDir(state), ['..', 'a b/../c'].map((project, i) => JSON.stringify({ v: 1, ts: `2026-11-13T10:00:0${i}Z`, event: 'session_start', session: i === 0 ? S : OTHER, project })).join('\n'), new Map())
    assert.equal(exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git }).code, 0)
    const files = git(['ls-tree', '-r', '--name-only', 'main', '--', 'index/projects'], remote).stdout.trim().split('\n')
    assert.deepEqual(files, ['index/projects/_/box/2026-11-13.json', 'index/projects/a-b-..-c/box/2026-11-13.json'])
  })
})

const ENV_VALUE = 'a-long-enough-value'
const OTHER = '70ed5626-9879-4041-892a-5db0ff0bad69'

/** A transcript file in `root` holding a prompt, a value of ~/.env, a token and a line that is no JSON. */
function plantTranscript(root: string, session: string): string {
  const file = join(root, `${session}.jsonl`)
  writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { content: 'a prompt that is kept' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `the password is ${ENV_VALUE} and the key ${SECRET}` }] } }),
    `not json, but ${ENV_VALUE} all the same`,
  ].join('\n') + '\n')
  return file
}

// The operator's order of 2026-11-14 turns around the former « a transcript never reaches the
// repository »: raw transcripts are in the logs repository, redacted, and indexed.
test('a transcript is pushed beside the day files, redacted: no value of ~/.env, no token, the prompt kept', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const secrets = new Map([['SERVICE_PASS', ENV_VALUE]])
    const file = plantTranscript(root, S)
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), secrets)
    const result = exportStore({ stateDir: state, secrets, repo: remote, machine: 'box', git, transcript: session => (session === S ? file : undefined) })
    assert.deepEqual(result, { lines: ['export: 1 day file(s) and 1 transcript(s) of box pushed to the logs repository'], code: 0 })
    const pushed = git(['show', `main:machines/box/transcripts/${S}.jsonl`], remote).stdout
    const lines = pushed.trim().split('\n')
    assert.equal(lines.length, 3)
    assert.match(lines[0] ?? '', /a prompt that is kept/)
    assert.match(lines[1] ?? '', /\[REDACTED:env\]/)
    assert.match(lines[1] ?? '', /\[REDACTED:anthropic-key\]/)
    assert.equal(lines[2], '[REDACTED:not-json]')
    assert.doesNotThrow(() => JSON.parse(lines[1] ?? ''))
    for (const value of [ENV_VALUE, SECRET]) assert.equal(git(['grep', '-c', value, 'main'], remote).status, 1, value)
  })
})

/** Whether `main` of `remote` holds `text` anywhere, read as a fixed string. */
const holds = (remote: string, text: string): boolean => git(['grep', '-F', '-c', '-e', text, 'main'], remote).status === 0

// Invented values of ~/.env that a raw text would not match once JSON wrote them: a quote, a backslash, non-ASCII.
const AWKWARD = ['say "cheese" now', 'back\\slash\\value', 'clé-secrète-élevée']

test('a line that is no JSON is never pushed as text: a mark when it is complete, held back while the host writes it', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const secrets = new Map(AWKWARD.map((value, i) => [`AWKWARD_${i}`, value]))
    const escaped = AWKWARD.map(value => JSON.stringify(value).slice(1, -1))
    const cut = (AWKWARD[2] ?? '').slice(0, 9)
    const file = join(root, `${S}.jsonl`)
    writeFileSync(file, [
      JSON.stringify({ type: 'user', message: 'a prompt that is kept' }),
      // Complete, but cut inside a string: it parses to nothing and holds each value as written and as JSON writes it.
      `{"type":"assistant","message":"${[...AWKWARD, ...escaped].join(' | ')}`,
      JSON.stringify({ type: 'user', message: 'the last complete line' }),
      // The host is writing this one: it stops inside a value, no newline after it.
      `{"type":"assistant","message":"the key is ${cut}`,
    ].join('\n'))
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), secrets)
    const run = () => exportStore({ stateDir: state, secrets, repo: remote, machine: 'box', git, transcript: () => file })
    assert.equal(run().code, 0)
    const pushed = git(['show', `main:machines/box/transcripts/${S}.jsonl`], remote).stdout
    assert.equal(pushed, [
      JSON.stringify({ type: 'user', message: 'a prompt that is kept' }),
      '[REDACTED:not-json]',
      JSON.stringify({ type: 'user', message: 'the last complete line' }),
      '',
    ].join('\n'))
    for (const text of [...AWKWARD, ...escaped, cut, (AWKWARD[0] ?? '').slice(0, 8)]) assert.equal(holds(remote, text), false, text)
    // Once the host ends the line, the next export pushes it, its value masked.
    appendFileSync(file, `${(AWKWARD[2] ?? '').slice(9)}"}\n`)
    assert.equal(run().code, 0)
    const done = git(['show', `main:machines/box/transcripts/${S}.jsonl`], remote).stdout.split('\n')
    assert.equal(done[3], JSON.stringify({ type: 'assistant', message: 'the key is [REDACTED:env]' }))
    for (const text of [...AWKWARD, cut]) assert.equal(holds(remote, text), false, text)
  })
})

test('no field of a transcript line is held to the shape of an event identifier: its secrets are masked, nothing else changes', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const secrets = new Map([['SERVICE_PASS', ENV_VALUE]])
    // The names of an event's identifiers, holding what a transcript puts under them: none is a uuid, a timestamp or a word.
    const planted = { type: 'system', session: 'a label, no uuid', event: 'Some Event 2', ts: 'yesterday at noon', turn: `turn one: ${ENV_VALUE}`, nested: { session: 'another label' } }
    const file = join(root, `${S}.jsonl`)
    writeFileSync(file, `${JSON.stringify(planted)}\n`)
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), secrets)
    assert.equal(exportStore({ stateDir: state, secrets, repo: remote, machine: 'box', git, transcript: () => file }).code, 0)
    const pushed = git(['show', `main:machines/box/transcripts/${S}.jsonl`], remote).stdout
    assert.deepEqual(JSON.parse(pushed), { ...planted, turn: 'turn one: [REDACTED:env]' })
  })
})

test('a value of ~/.env used as a key of a transcript line is masked in the copy pushed, at any depth', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const secrets = new Map([['SERVICE_PASS', ENV_VALUE]])
    const file = join(root, `${S}.jsonl`)
    writeFileSync(file, `${JSON.stringify({ type: 'system', [ENV_VALUE]: 'a', nested: { [ENV_VALUE]: [{ [ENV_VALUE]: 1 }] } })}\n`)
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), secrets)
    assert.equal(exportStore({ stateDir: state, secrets, repo: remote, machine: 'box', git, transcript: () => file }).code, 0)
    const pushed = git(['show', `main:machines/box/transcripts/${S}.jsonl`], remote).stdout
    assert.deepEqual(JSON.parse(pushed), { type: 'system', '[REDACTED:env]': 'a', nested: { '[REDACTED:env]': [{ '[REDACTED:env]': 1 }] } })
    assert.equal(holds(remote, ENV_VALUE), false)
  })
})

test('the manifest points at the copy in the repository; a session with no transcript here points at none', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const file = plantTranscript(root, S)
    append(eventsDir(state), `${event('2026-11-13T10:00:00Z')}\n${event('2026-11-13T10:00:01Z', { session: OTHER })}`, new Map())
    assert.equal(exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git, transcript: session => (session === S ? file : undefined) }).code, 0)
    const manifest = JSON.parse(git(['show', 'main:index/box/2026-11-13.json'], remote).stdout) as { sessions: { session: string; transcript: string | null }[] }
    assert.deepEqual(manifest.sessions.map(({ session, transcript }) => ({ session, transcript })).sort((a, b) => a.session.localeCompare(b.session)), [
      { session: S, transcript: `machines/box/transcripts/${S}.jsonl` },
      { session: OTHER, transcript: null },
    ])
    const files = git(['ls-tree', '-r', '--name-only', 'main'], remote).stdout.trim().split('\n')
    assert.deepEqual(files.filter(f => f.includes('/transcripts/')), [`machines/box/transcripts/${S}.jsonl`])
  })
})

test('only the transcripts of the sessions the day files name are asked for and pushed', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    const asked: string[] = []
    const stranger = plantTranscript(root, OTHER)
    const transcript = (session: string): string | undefined => {
      asked.push(session)
      return session === OTHER ? stranger : undefined
    }
    assert.equal(exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git, transcript }).code, 0)
    assert.deepEqual([...new Set(asked)], [S])
    assert.equal(git(['ls-tree', '-r', '--name-only', 'main'], remote).stdout.includes('/transcripts/'), false)
  })
})

test('a transcript that grew is pushed again; one unchanged is not', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const file = join(root, `${S}.jsonl`)
    writeFileSync(file, '{"type":"user","message":"first"}\n')
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    const run = () => exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git, transcript: () => file })
    assert.equal(run().code, 0)
    assert.deepEqual(run().lines, ['export: the logs repository already holds every event, nothing pushed'])
    appendFileSync(file, '{"type":"user","message":"second"}\n')
    assert.equal(run().code, 0)
    assert.equal(git(['show', `main:machines/box/transcripts/${S}.jsonl`], remote).stdout, '{"type":"user","message":"first"}\n{"type":"user","message":"second"}\n')
    assert.equal(git(['rev-list', '--count', 'main'], remote).stdout.trim(), '2')
  })
})

const THIRD = '50ed5626-9879-4041-892a-5db0ff0bad69'
const FOURTH = '80ed5626-9879-4041-892a-5db0ff0bad69'

test('a transcript that cannot be read or redacted is skipped and named; the export goes on, the day files go', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const directory = join(root, 'a-directory')
    mkdirSync(directory)
    // A line nested deep enough to overflow the stack of the redaction.
    const deep = join(root, `${FOURTH}.jsonl`)
    writeFileSync(deep, `${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}\n`)
    const files: Record<string, string> = { [S]: plantTranscript(root, S), [OTHER]: directory, [THIRD]: join(root, 'gone.jsonl'), [FOURTH]: deep }
    append(eventsDir(state), [S, OTHER, THIRD, FOURTH].map((session, i) => event(`2026-11-13T10:00:0${i}Z`, { session })).join('\n'), new Map())
    const result = exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git, transcript: session => files[session] })
    assert.deepEqual(result, {
      lines: [
        'export: 1 day file(s) and 1 transcript(s) of box pushed to the logs repository',
        `export: transcript ${THIRD} skipped (ENOENT)`,
        `export: transcript ${OTHER} skipped (EISDIR)`,
        `export: transcript ${FOURTH} skipped (redaction failed: RangeError)`,
      ],
      code: 0,
    })
    assert.equal(git(['show', 'main:machines/box/2026-11-13.jsonl'], remote).stdout.trim().split('\n').length, 4)
    const manifest = JSON.parse(git(['show', 'main:index/box/2026-11-13.json'], remote).stdout) as { sessions: { session: string; transcript: string | null }[] }
    assert.deepEqual(Object.fromEntries(manifest.sessions.map(({ session, transcript }) => [session, transcript])), {
      [S]: `machines/box/transcripts/${S}.jsonl`, [OTHER]: null, [THIRD]: null, [FOURTH]: null,
    })
    const pushed = git(['ls-tree', '-r', '--name-only', 'main'], remote).stdout.trim().split('\n')
    assert.deepEqual(pushed.filter(file => file.includes('/transcripts/')), [`machines/box/transcripts/${S}.jsonl`])
  })
})

/** One transcript file in `root` per session, each holding the one line it is given; the files by session. */
function plantFiles(root: string, lines: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(lines).map(([session, line]) => {
    const file = join(root, `${session}.jsonl`)
    writeFileSync(file, `${line}\n`)
    return [session, file]
  }))
}

const prompt = (message: string): string => JSON.stringify({ type: 'user', message })
const daily = (sessions: readonly string[]): string => sessions.map((session, i) => event(`2026-11-13T10:00:0${i}Z`, { session })).join('\n')
const transcriptsOf = (remote: string): string[] => git(['ls-tree', '-r', '--name-only', 'main'], remote).stdout.trim().split('\n').filter(file => file.includes('/transcripts/'))

test('a transcript over the size cap is left out and named, whether its source or its redacted copy is over; the others go', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const secrets = new Map([['SERVICE_PASS', 'abcdefgh']])
    // OTHER fits as it is, then masking lengthens it past the cap: eight characters become fourteen.
    const lines = { [THIRD]: prompt('small'), [S]: prompt('x'.repeat(400)), [OTHER]: prompt(Array(10).fill('abcdefgh').join(' ')) }
    const files = plantFiles(root, lines)
    append(eventsDir(state), daily([S, OTHER, THIRD]), secrets)
    const result = exportStore({ stateDir: state, secrets, repo: remote, machine: 'box', git, transcript: session => files[session], limits: { transcriptBytes: 150 } })
    assert.equal(result.code, 0)
    assert.deepEqual(result.lines.slice(0, 2), ['export: 1 day file(s) and 1 transcript(s) of box pushed to the logs repository', `export: transcript ${S} skipped (too large: ${Buffer.byteLength(lines[S] ?? '') + 1} bytes, over 150)`])
    assert.match(result.lines[2] ?? '', new RegExp(`^export: transcript ${OTHER} skipped \\(too large once redacted: \\d+ bytes, over 150\\)$`))
    assert.equal(result.lines.length, 3)
    assert.deepEqual(transcriptsOf(remote), [`machines/box/transcripts/${THIRD}.jsonl`])
    assert.ok(MAX_TRANSCRIPT_BYTES * 2 < 100_000_000, 'well under the 100 MB GitHub refuses')
  })
})

test('a transcript last written over 90 days ago is left out and counted, the one a repository holds already stays, the others go', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const files = plantFiles(root, { [THIRD]: prompt(THIRD), [S]: prompt(S), [OTHER]: prompt(OTHER) })
    const written = (session: string, daysAgo: number): void => {
      const at = new Date(Date.now() - daysAgo * 86_400_000)
      utimesSync(files[session] ?? '', at, at)
    }
    const manifest = () => (JSON.parse(git(['show', 'main:index/box/2026-11-13.json'], remote).stdout) as { sessions: { session: string; transcript: string | null }[] }).sessions
    let now = Date.now()
    const run = () => exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git, transcript: session => files[session], now: () => now })
    append(eventsDir(state), daily([S, OTHER, THIRD]), new Map())
    written(S, 89)
    written(OTHER, 91)
    written(THIRD, 400)
    assert.deepEqual(run(), {
      lines: ['export: 1 day file(s) and 1 transcript(s) of box pushed to the logs repository', `export: 2 transcript(s) last written over ${MAX_TRANSCRIPT_AGE_DAYS} days ago left out`],
      code: 0,
    })
    assert.deepEqual(transcriptsOf(remote), [`machines/box/transcripts/${S}.jsonl`])
    assert.deepEqual(manifest().map(entry => [entry.session, entry.transcript !== null]).sort(), [[OTHER, false], [S, true], [THIRD, false]].sort())
    // The pushed one grows old with its file unchanged: the repository holds it still, and the manifest keeps pointing at it.
    now += 10 * 86_400_000
    assert.deepEqual(run().lines, ['export: the logs repository already holds every event, nothing pushed', `export: 2 transcript(s) last written over ${MAX_TRANSCRIPT_AGE_DAYS} days ago left out`])
    assert.deepEqual(transcriptsOf(remote), [`machines/box/transcripts/${S}.jsonl`])
    assert.equal(manifest().find(entry => entry.session === S)?.transcript, `machines/box/transcripts/${S}.jsonl`)
  })
})

test('a run takes transcripts up to its bound; the rest wait and are said, the pushed ones are not redone', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const files = plantFiles(root, { [THIRD]: prompt(THIRD), [S]: prompt(S), [OTHER]: prompt(OTHER) })
    const size = statSync(files[S] ?? '').size
    append(eventsDir(state), daily([S, OTHER, THIRD]), new Map())
    const run = (runBytes: number) => exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git, transcript: session => files[session], limits: { runBytes } })
    const manifest = () => (JSON.parse(git(['show', 'main:index/box/2026-11-13.json'], remote).stdout) as { sessions: { session: string; transcript: string | null }[] }).sessions
    assert.deepEqual(run(2 * size), {
      lines: ['export: 1 day file(s) and 2 transcript(s) of box pushed to the logs repository', `export: 1 transcript(s) left for the next export (${size} bytes; a run takes up to ${2 * size})`],
      code: 0,
    })
    assert.deepEqual(transcriptsOf(remote), [`machines/box/transcripts/${THIRD}.jsonl`, `machines/box/transcripts/${S}.jsonl`])
    assert.equal(manifest().find(entry => entry.session === OTHER)?.transcript, null)
    // Room for one: were the two pushed read again they would take it, and the one left would wait again.
    assert.deepEqual(run(size), { lines: ['export: 1 day file(s) and 1 transcript(s) of box pushed to the logs repository'], code: 0 })
    assert.equal(transcriptsOf(remote).length, 3)
    assert.equal(manifest().find(entry => entry.session === OTHER)?.transcript, `machines/box/transcripts/${OTHER}.jsonl`)
    assert.deepEqual(run(size).lines, ['export: the logs repository already holds every event, nothing pushed'])
    assert.ok(MAX_TRANSCRIPT_BYTES < MAX_RUN_BYTES)
  })
})

test('a transcript is exported again where the repository lacks its copy, and after a push that was refused', () => {
  scratch((root, first) => {
    const state = join(root, 'state')
    const second = join(root, 'second.git')
    assert.equal(git(['init', '--quiet', '--bare', second], root).status, 0)
    const files = plantFiles(root, { [S]: prompt('kept') })
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    const run = (repo: string) => exportStore({ stateDir: state, secrets: new Map(), repo, machine: 'box', git, transcript: session => files[session] })
    refusePushes(first, true)
    assert.equal(run(first).code, 1)
    refusePushes(first, false)
    assert.deepEqual(run(first).lines, ['export: 1 day file(s) and 1 transcript(s) of box pushed to the logs repository'])
    assert.deepEqual(run(first).lines, ['export: the logs repository already holds every event, nothing pushed'])
    // The same files, another repository with a history of its own: what the first one holds is no proof for this one.
    const seed = join(root, 'seed')
    assert.equal(git(['clone', '--quiet', second, seed], root).status, 0)
    writeFileSync(join(seed, 'README.md'), 'another repository\n')
    assert.equal(git(['add', 'README.md'], seed).status, 0)
    assert.equal(git(['commit', '--quiet', '-m', 'seed'], seed).status, 0)
    assert.equal(git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], seed).status, 0)
    assert.deepEqual(run(second).lines, ['export: 1 day file(s) and 1 transcript(s) of box pushed to the logs repository'])
    assert.deepEqual(transcriptsOf(second), [`machines/box/transcripts/${S}.jsonl`])
  })
})

test('the index is held to the same scan: a secret it would carry refuses the export, nothing pushed', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    const leaky: KindSpec = { summary: `A kind whose page holds ${SECRET}.`, writers: ['nobody'], fields: [] }
    const result = exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git, kinds: { ...EVENT_SCHEMA, leaky } })
    assert.equal(result.code, 1)
    assert.match(result.lines[0] ?? '', /^export refused: the index would carry \d+ secret\(s\), nothing pushed$/)
    assert.ok(result.lines.includes('  index/schema/leaky.md: anthropic-key'))
    assert.ok(!result.lines.join('\n').includes(SECRET))
    assert.notEqual(git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], remote).status, 0)
  })
})

test('an unchanged day is not pushed again: the index is the same text each run', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    const run = () => exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git })
    assert.equal(run().code, 0)
    assert.deepEqual(run().lines, ['export: the logs repository already holds every event, nothing pushed'])
    assert.equal(git(['rev-list', '--count', 'main'], remote).stdout.trim(), '1')
  })
})

test('a kind added to the declared list joins the pushed index, and one removed leaves it', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    const audit: KindSpec = { summary: 'An audit finding.', writers: ['the audit writer'], fields: [{ name: 'severity', type: 'string', description: 'How bad.' }] }
    const run = (kinds: Record<string, KindSpec>) => exportStore({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git, kinds })
    assert.equal(run({ ...EVENT_SCHEMA, audit_finding: audit }).code, 0)
    assert.match(git(['show', 'main:index/schema/audit_finding.md'], remote).stdout, /`severity`/)
    assert.equal(run(EVENT_SCHEMA).code, 0)
    assert.notEqual(git(['cat-file', '-e', 'main:index/schema/audit_finding.md'], remote).status, 0)
  })
})

test('an export that finds the lock held, past its wait, says so and pushes nothing', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    const options = { stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git }
    const held = withLock(join(state, 'export'), () => exportExclusive(options, { waitMs: 0 }))
    assert.deepEqual(held, { lines: ['export: another export is running, nothing pushed'], code: 1, busy: true })
    assert.notEqual(git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], remote).status, 0)
    const free = exportExclusive(options, { waitMs: 0 })
    assert.deepEqual(free, { lines: ['export: 1 day file(s) of box pushed to the logs repository'], code: 0, busy: false })
  })
})

test('a lock left by a holder that died is taken over after its stale age, not before', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    const options = { stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git }
    writeFileSync(join(state, 'export.lock'), '99999\n')
    assert.equal(exportExclusive(options, { waitMs: 0 }).busy, true)
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(join(state, 'export.lock'), old, old)
    assert.equal(exportExclusive(options, { waitMs: 0 }).code, 0)
  })
})

/** Sets the age of `lock` to `ageMs`: a holder that last showed life that long ago. */
function ageLock(lock: string, ageMs: number): void {
  const at = new Date(Date.now() - ageMs)
  utimesSync(lock, at, at)
}

test('the export keeps its lock alive while it works: a rival cannot take it over between two transcripts', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    const files = plantFiles(root, { [THIRD]: prompt('one'), [S]: prompt('two'), [OTHER]: prompt('three') })
    append(eventsDir(state), daily([S, OTHER, THIRD]), new Map())
    const lock = join(state, 'export.lock')
    const options = { stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git }
    let copying = false
    let copied = 0
    let rival: { busy: boolean } | undefined
    const transcript = (session: string): string | undefined => {
      if (!copying) return files[session]
      copied++
      // The first takes an hour, say: when the second is reached that time has passed.
      if (copied === 1) ageLock(lock, 3_600_000)
      // A rival export arrives, and waits no time for the lock.
      if (copied === 2) rival = exportExclusive(options, { waitMs: 0 })
      return files[session]
    }
    const watching: Git = (args, cwd) => {
      if (args[0] === 'ls-tree') copying = true
      return git(args, cwd)
    }
    assert.equal(exportExclusive({ ...options, git: watching, transcript }, { waitMs: 0 }).code, 0)
    assert.equal(rival?.busy, true)
  })
})

test('the export keeps its lock alive across its git commands, a push of minutes included', () => {
  scratch((root, remote) => {
    const state = join(root, 'state')
    append(eventsDir(state), event('2026-11-13T10:00:00Z'), new Map())
    const lock = join(state, 'export.lock')
    const ages: Record<string, number> = {}
    const watching: Git = (args, cwd) => {
      // What each command finds of the lock, after the one before took its hour.
      ages[args[0] ?? ''] = Date.now() - statSync(lock).mtimeMs
      ageLock(lock, 3_600_000)
      return git(args, cwd)
    }
    assert.equal(exportExclusive({ stateDir: state, secrets: new Map(), repo: remote, machine: 'box', git: watching }, { waitMs: 0 }).code, 0)
    for (const command of ['clone', 'fetch', 'add', 'commit', 'push']) assert.ok((ages[command] ?? Infinity) < 60_000, `${command}: the lock was ${ages[command]} ms old`)
  })
})
