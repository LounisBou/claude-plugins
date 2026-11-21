// The grouping of failed calls: what is one group and what is two, the plugins' own first, the
// message's variable parts normalised, and the cursor that moves one reading to the next.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURSOR_FILE, baseName, concerns, cursorFileOf, errors, failureOf, group, learn, normalise, pluginScript, promptGroups, readDay, render } from './errors.ts'
import { toolEvents } from '../../../../hooks/collect.ts'
import { append, eventsDir } from './store.ts'

const S = '60ed5626-9879-4041-892a-5db0ff0bad69'
const T = '11111111-2222-4333-8444-555555555555'
const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const call = (ts: string, more: Record<string, unknown>): string => JSON.stringify({ v: 1, ts, event: 'tool_call', session: S, tool: 'mcp__github__gh', mcp_server: 'github', mcp_tool: 'gh', ...more })
const refusal = (ts: string, message: string, more: Record<string, unknown> = {}): string =>
  call(ts, { outcome: 'refused', decided_by: 'plugin:github', command: 'pr-merge', error_message: message, ...more })
const parsed = (...lines: string[]) => lines.flatMap(line => failureOf(line) ?? [])

function scratch(work: (r: { stateDir: string; day: (name: string, lines: string[]) => void; add: (name: string, lines: string[]) => void }) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'telemetry-errors-'))
  const stateDir = join(root, 'telemetry')
  mkdirSync(eventsDir(stateDir), { recursive: true })
  try {
    work({
      stateDir,
      day: (name, lines) => writeFileSync(join(eventsDir(stateDir), `${name}.jsonl`), `${lines.join('\n')}\n`),
      add: (name, lines) => appendFileSync(join(eventsDir(stateDir), `${name}.jsonl`), `${lines.join('\n')}\n`),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('normalise: a repository and pull request, a sha, a path, a time and any number are placeholders', () => {
  assert.equal(normalise('cannot merge geonativefr/beltv5_fw_legacy#25 at 0123abcd4567'), 'cannot merge <repo>#<n> at <sha>')
  assert.equal(normalise('head 6a69939af7f8a8af404fad1d2b315ae599e3342b is behind'), 'head <sha> is behind')
  assert.equal(normalise('no such file /Users/me/dev/x.ts and ~/.claude/y and ./z/w'), 'no such file <path> and <path> and <path>')
  assert.equal(normalise('at 2026-11-20T10:15:30Z session 60ed5626-9879-4041-892a-5db0ff0bad69 failed 3 times'), 'at <time> session <id> failed <n> times')
  assert.equal(normalise('see https://github.com/a/b/pull/3 now'), 'see <url> now')
  assert.equal(normalise('deadbeef is a word of letters only'), 'deadbeef is a word of letters only')
  assert.equal(normalise('  many \n  blanks  '), 'many blanks')
})

test('group: two messages that differ only by a pull request number and a sha are one group; two different messages stay apart', () => {
  const failures = parsed(
    refusal('2026-11-20T10:00:00Z', 'github: PR a/b#12 head 0123abcd4567 is not ready'),
    refusal('2026-11-20T11:00:00Z', 'github: PR a/b#99 head fedcba987654 is not ready', { session: T }),
    refusal('2026-11-20T11:30:00Z', 'github: the records are written by their tools'),
  )
  const groups = group(failures)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map(g => [g.count, g.sessions.size, g.normalised]), [
    [2, 2, 'github: PR <repo>#<n> head <sha> is not ready'],
    [1, 1, 'github: the records are written by their tools'],
  ])
  assert.equal(groups[0]?.example, 'github: PR a/b#12 head 0123abcd4567 is not ready')
  assert.deepEqual([groups[0]?.first, groups[0]?.last], [Date.parse('2026-11-20T10:00:00Z'), Date.parse('2026-11-20T11:00:00Z')])
})

test('group: the same message by another decider, another command or another outcome is another group', () => {
  const groups = group(parsed(
    refusal('2026-11-20T10:00:00Z', 'x'),
    refusal('2026-11-20T10:01:00Z', 'x', { command: 'pr-ready' }),
    refusal('2026-11-20T10:02:00Z', 'x', { decided_by: 'plugin:norms' }),
    call('2026-11-20T10:03:00Z', { outcome: 'error', error_message: 'x' }),
  ))
  assert.equal(groups.length, 4)
})

test('failureOf: only error and refused tool calls; a plugin\'s own failure is told from the rest', () => {
  assert.equal(failureOf(call('2026-11-20T10:00:00Z', { outcome: 'ok' })), undefined)
  assert.equal(failureOf('not json "tool_call" "outcome":"error"'), undefined)
  assert.equal(failureOf(JSON.stringify({ v: 1, ts: '2026-11-20T10:00:00Z', event: 'question', session: S, outcome: 'error' })), undefined)
  const plain = (more: Record<string, unknown>) => failureOf(JSON.stringify({ v: 1, ts: '2026-11-20T10:00:00Z', event: 'tool_call', session: S, ...more }))
  assert.equal(plain({ tool: 'Edit', outcome: 'error' })?.plugin, false)
  assert.equal(plain({ tool: 'Bash', outcome: 'refused', decided_by: 'hook' })?.plugin, false)
  assert.equal(plain({ tool: 'Bash', outcome: 'refused', decided_by: 'rule' })?.plugin, false)
  assert.equal(plain({ tool: 'Bash', outcome: 'refused', decided_by: 'plugin:github' })?.plugin, true)
  assert.equal(plain({ tool: 'mcp__orchestrator__review', mcp_server: 'orchestrator', outcome: 'error' })?.plugin, true)
  assert.equal(plain({ tool: 'mcp__context7__query-docs', mcp_server: 'context7', outcome: 'error' })?.plugin, false)
  assert.equal(plain({ tool: 'Bash', outcome: 'error', bash: { line: 'node /x/plugins/telemetry/skills/telemetry/scripts/telemetry.ts check' } })?.plugin, true)
  assert.equal(plain({ tool: 'Bash', outcome: 'error', bash: { line: 'node --test /x/plugins/unknown/a.ts' } })?.plugin, false)
  assert.equal(pluginScript('python3 ${CLAUDE_PLUGIN_ROOT}/scripts/x.py'), true)
  for (const path of ['/Users/me/.claude/plugins/cache/lounisbou/telemetry/0.5.0/skills/a.ts', '/Users/me/.claude/plugins/marketplaces/lounisbou/plugins/github/hooks/a.ts', '/Users/me/.claude/deploys/lounisbou/6a69939a/plugins/orchestrator/a.sh']) assert.equal(pluginScript(`node ${path}`), true, path)
  assert.equal(pluginScript('node /Users/me/.claude/plugins/cache/other/unknown/1.0/a.ts'), false)
  const P = '/Users/me/dev/claude-plugins/plugins/github'
  for (const line of [`grep foo ${P}/a.ts`, `cat ${P}/README.md`, `cd ${P} && ls`, `git -C ${P} diff`, `ls ${P}/hooks | head`, `node --test /tmp/x.spec.ts ${P}/a.ts`]) assert.equal(pluginScript(line), false, line)
  for (const line of [`node --experimental-strip-types --no-warnings ${P}/a.ts check`, `cd /tmp && bash ${P}/run.sh`, `FOO=1 ${P}/run.sh x`, `echo ok; python3 -u ${P}/x.py`, `npm test && node ${P}/b.ts`]) assert.equal(pluginScript(line), true, line)
  assert.equal(plain({ tool: 'mcp__github__gh', mcp_server: 'github', outcome: 'refused', decided_by: 'user' })?.plugin, false)
  assert.equal(plain({ tool: 'mcp__github__gh', mcp_server: 'github', outcome: 'refused', decided_by: 'plugin' })?.plugin, true)
  assert.equal(plain({ tool: 'mcp__github__gh', mcp_server: 'github', outcome: 'error' })?.by, 'github')
})

test('render: the plugins\' groups first, then the others, counted; a quiet store says so in one line', () => {
  const lines = render(parsed(
    call('2026-11-20T09:00:00Z', { tool: 'Edit', mcp_server: undefined, outcome: 'error', error_message: 'File has not been read yet' }),
    refusal('2026-11-20T10:00:00Z', 'github: PR a/b#12 is not ready'),
    refusal('2026-11-20T10:05:00Z', 'github: PR a/b#13 is not ready'),
  ), NOW - 3_600_000)
  assert.equal(lines[0], 'errors since 2026-11-20T11:00Z: 3 failed call(s)')
  assert.match(lines[1] ?? '', /^plugin \(2 call\(s\), 1 group\(s\)\):$/)
  assert.match(lines[2] ?? '', /^2× refused plugin:github pr-merge: github: PR <repo>#<n> is not ready \[11-20 10:00Z → 11-20 10:05Z, 1 session\(s\)\] — e\.g\. "github: PR a\/b#12 is not ready"$/)
  assert.match(lines[3] ?? '', /^other \(1 call\(s\), 1 group\(s\)\):$/)
  assert.match(lines[4] ?? '', /^1× error Edit: File has not been read yet /)
  assert.deepEqual(render([], NOW), ['errors since 2026-11-20T12:00Z: 0 failed call(s)'])
  const many = render(parsed(...Array.from({ length: 20 }, (_, i) => refusal('2026-11-20T10:00:00Z', `distinct message ${'x'.repeat(i + 1)}`))), NOW)
  assert.equal(many.length, 1 + 1 + 15 + 1)
  assert.equal(many.at(-1), '… 5 more group(s), 5 call(s) (the cursor passed them: --since 2026-11-20T12:00:00Z lists them)')
})

test('errors: a group with no message (an older event) still prints, as (no message)', () => {
  scratch(({ stateDir, day }) => {
    day('2026-11-20', [call('2026-11-20T10:00:00Z', { outcome: 'refused', decided_by: 'plugin:github', command: 'pr-merge' })])
    assert.match(errors({ stateDir, now: NOW, since: Date.parse('2026-11-20T00:00:00Z') })[2] ?? '', /^1× refused plugin:github pr-merge: \(no message\) /)
  })
})

test('errors: the cursor advances — a second reading holds only what was added since; a half-written line waits', () => {
  scratch(({ stateDir, day, add }) => {
    day('2026-11-20', [refusal('2026-11-20T10:00:00Z', 'first')])
    const first = errors({ stateDir, now: NOW })
    assert.equal(first[0], 'errors since 2026-11-19T12:00Z: 1 failed call(s)')
    assert.deepEqual(errors({ stateDir, now: NOW + 1000 }), ['errors since 2026-11-20T12:00Z: 0 failed call(s)'])
    add('2026-11-20', [refusal('2026-11-20T12:30:00Z', 'second')])
    appendFileSync(join(eventsDir(stateDir), '2026-11-20.jsonl'), refusal('2026-11-20T12:40:00Z', 'third').slice(0, 30))
    const next = errors({ stateDir, now: NOW + 2000 })
    assert.equal(next.length, 3)
    assert.match(next[2] ?? '', /: second /)
    appendFileSync(join(eventsDir(stateDir), '2026-11-20.jsonl'), `${refusal('2026-11-20T12:40:00Z', 'third').slice(30)}\n`)
    assert.match(errors({ stateDir, now: NOW + 3000 })[2] ?? '', /: third /)
    day('2026-11-21', [refusal('2026-11-21T01:00:00Z', 'new day')])
    assert.match(errors({ stateDir, now: NOW + 4000 })[2] ?? '', /: new day /)
    assert.equal((JSON.parse(readFileSync(join(stateDir, CURSOR_FILE), 'utf8')) as { offsets: Record<string, number> }).offsets['2026-11-21.jsonl'] !== undefined, true)
  })
})

test('errors: the first reading looks back a day, files before it are passed; --since reads from a time and leaves the cursor', () => {
  scratch(({ stateDir, day }) => {
    day('2026-11-17', [refusal('2026-11-17T10:00:00Z', 'too old')])
    day('2026-11-19', [refusal('2026-11-19T10:00:00Z', 'before the window'), refusal('2026-11-19T13:00:00Z', 'inside the window')])
    const since = errors({ stateDir, now: NOW, since: Date.parse('2026-11-17T00:00:00Z') })
    assert.equal(since[0], 'errors since 2026-11-17T00:00Z: 3 failed call(s)')
    assert.throws(() => readFileSync(join(stateDir, CURSOR_FILE)))
    const first = errors({ stateDir, now: NOW })
    assert.equal(first[0], 'errors since 2026-11-19T12:00Z: 1 failed call(s)')
    assert.match(first[2] ?? '', /: inside the window /)
    assert.deepEqual(errors({ stateDir, now: NOW }), ['errors since 2026-11-20T12:00Z: 0 failed call(s)'])
    assert.equal(errors({ stateDir, now: NOW, since: Date.parse('2026-11-17T00:00:00Z') })[0], 'errors since 2026-11-17T00:00Z: 3 failed call(s)')
  })
})

test('errors: a cursor that is no JSON, or a file shorter than its offset, reads from the start', () => {
  scratch(({ stateDir, day }) => {
    day('2026-11-20', [refusal('2026-11-20T10:00:00Z', 'kept')])
    writeFileSync(join(stateDir, CURSOR_FILE), 'not json')
    assert.equal(errors({ stateDir, now: NOW })[0], 'errors since 2026-11-19T12:00Z: 1 failed call(s)')
    writeFileSync(join(stateDir, CURSOR_FILE), JSON.stringify({ v: 1, offsets: { '2026-11-20.jsonl': 999_999 } }))
    assert.equal(errors({ stateDir, now: NOW })[0], 'errors since 2026-11-19T12:00Z: 1 failed call(s)')
  })
})

// Two orchestrations on one machine, each with its own session and an agent that reports to it. A session is
// told by its events: the failure of its first turn has no title yet, and is the session's all the same.
const BILLING = 'Orch: billing'
const FIRMWARE = 'Orch: firmware'
const BS = 'b0000000-0000-4000-8000-000000000001'
const BA = 'b0000000-0000-4000-8000-000000000002'
const FS = 'f0000000-0000-4000-8000-000000000001'
const FA = 'f0000000-0000-4000-8000-000000000002'
const NS = '99999999-0000-4000-8000-000000000001'
const AG = 'c0000000-0000-4000-8000-000000000001'
const RN = 'c0000000-0000-4000-8000-000000000002'
const failed = (session: string, ts: string, message: string, more: Record<string, unknown> = {}): string =>
  call(ts, { tool: 'Edit', mcp_server: undefined, outcome: 'error', error_message: message, session, ...more })
const titled = (session: string, ts: string, title: string, parent?: string): string => call(ts, { tool: 'Edit', mcp_server: undefined, outcome: 'ok', session, title, ...(parent === undefined ? {} : { parent }) })
const pluginError = (ts: string, message: string, more: Record<string, unknown> = {}): string => refusal(ts, message, more)
const messages = (lines: string[]): string[] => lines.filter(l => /^\d+× /.test(l)).map(l => /: (.*?) \[/.exec(l)?.[1] ?? l).sort()
const scoped = (orchestration: string, plugins = false) => ({ orchestration, plugins })

test('baseName: a reference and the former shape are dropped, so a successor shares its predecessors\' name', () => {
  assert.equal(baseName('Orch: billing [a1b2c3]'), 'Orch: billing')
  assert.equal(baseName('Orch : billing'), 'Orch: billing')
  assert.equal(baseName(' Orch: billing '), 'Orch: billing')
  assert.equal(baseName('Orch: build [2]'), 'Orch: build')
  assert.equal(baseName('Orch: build [ZZ9] '), 'Orch: build')
  assert.equal(cursorFileOf(undefined), CURSOR_FILE)
  assert.equal(cursorFileOf('Orch: Claude plugins [21cd55]'), 'errors-Orch%3A%20Claude%20plugins.json')
  assert.notEqual(cursorFileOf('Orch: Billing'), cursorFileOf('Orch: billing'))
  assert.notEqual(cursorFileOf('Orch: a-b'), cursorFileOf('Orch: a b'))
})

test('learn and concerns: a session is the orchestration\'s by its title or its parent under any reference; a failure is dropped only when its session is known as another\'s', () => {
  const known = new Map<string, boolean>()
  const scope = scoped(BILLING)
  const f = (session: string) => parsed(failed(session, '2026-11-20T10:00:00Z', 'x'))[0]!
  for (const line of [titled(BS, '2026-11-20T09:00:00Z', BILLING), titled(BA, '2026-11-20T09:00:00Z', 'Agent: x', 'Orch: billing [a1b2c3]'), titled(FS, '2026-11-20T09:00:00Z', FIRMWARE), titled(FA, '2026-11-20T09:00:00Z', 'Agent: y', 'Orch: firmware [a1b2c3]'), failed(NS, '2026-11-20T09:00:00Z', 'no name')]) learn(known, line, scope)
  assert.deepEqual([BS, BA, FS, FA].map(session => concerns(f(session), scope, known)), [true, true, false, false])
  assert.equal(concerns(f(NS), scope, known), true, 'a session no event has named is never dropped')
  // An agent launched without a parent keeps its own title: named as no orchestration, so unknown and shown.
  learn(known, titled(AG, '2026-11-20T09:00:00Z', 'Agent: review fw_legacy#31'), scope)
  assert.equal(known.has(AG), false)
  assert.equal(concerns(f(AG), scope, known), true)
  // A host title before the rename to `Orch: billing` decides nothing; the rename does.
  learn(known, titled(RN, '2026-11-20T09:00:00Z', 'Fix the telemetry errors'), scope)
  assert.equal(concerns(f(RN), scope, known), true)
  learn(known, titled(RN, '2026-11-20T09:10:00Z', BILLING), scope)
  assert.equal(known.get(RN), true)
  // A session named as another orchestration is its verdict for good, whatever it is titled after.
  learn(known, titled(FS, '2026-11-20T09:30:00Z', BILLING), scope)
  assert.equal(known.get(FS), false)
  learn(known, titled(BS, '2026-11-20T09:30:00Z', 'Agent: renamed', 'Orch: other [a1b2c3]'), scope)
  assert.equal(concerns(f(BS), scope, known), true, 'a session once known as the orchestration\'s stays its own')
  assert.equal(concerns(parsed(pluginError('2026-11-20T10:00:00Z', 'p', { session: FS }))[0]!, scope, known), false)
  assert.equal(concerns(parsed(pluginError('2026-11-20T10:00:00Z', 'p', { session: FS }))[0]!, scoped(BILLING, true), known), true)
})

test('errors: each orchestration\'s reading holds the failures of its own sessions, the first turn\'s untitled ones too, and an unscoped reading holds all', () => {
  scratch(({ stateDir, day }) => {
    day('2026-11-20', [
      failed(BS, '2026-11-20T09:59:00Z', 'billing first turn'), failed(FS, '2026-11-20T09:59:30Z', 'firmware first turn'),
      titled(BS, '2026-11-20T10:00:00Z', BILLING), titled(BA, '2026-11-20T10:00:00Z', 'Agent: x', 'Orch: billing [a1b2c3]'),
      titled(FS, '2026-11-20T10:00:00Z', FIRMWARE), titled(FA, '2026-11-20T10:00:00Z', 'Agent: y', 'Orch: firmware [a1b2c3]'),
      failed(BS, '2026-11-20T10:01:00Z', 'billing own', { title: BILLING }), failed(BA, '2026-11-20T10:02:00Z', 'billing agent', { title: 'Agent: x', parent: 'Orch: billing [a1b2c3]' }),
      failed(FS, '2026-11-20T10:03:00Z', 'firmware own', { title: FIRMWARE }), failed(FA, '2026-11-20T10:04:00Z', 'firmware agent'),
      failed(NS, '2026-11-20T10:05:00Z', 'nobody'),
      titled(AG, '2026-11-20T09:58:00Z', 'Agent: review fw_legacy#31'), failed(AG, '2026-11-20T10:06:00Z', 'agent without parent'),
      failed(RN, '2026-11-20T09:57:00Z', 'renamed first turn'), titled(RN, '2026-11-20T09:57:30Z', 'Fix the telemetry errors'), titled(RN, '2026-11-20T09:58:30Z', BILLING),
    ])
    const read = (orchestration: string) => messages(errors({ stateDir, now: NOW, since: 0, scope: scoped(orchestration) }))
    assert.deepEqual(read(BILLING), ['agent without parent', 'billing agent', 'billing first turn', 'billing own', 'nobody', 'renamed first turn'])
    assert.deepEqual(read(FIRMWARE), ['agent without parent', 'firmware agent', 'firmware first turn', 'firmware own', 'nobody'])
    assert.equal(messages(errors({ stateDir, now: NOW, since: 0 })).length, 9)
    assert.deepEqual(read('Orch: other'), ['agent without parent', 'nobody'])
  })
})

test('errors: what a reading learnt of a session is kept, so an untitled failure of a later reading is decided by it', () => {
  scratch(({ stateDir, day, add }) => {
    day('2026-11-20', [titled(BS, '2026-11-20T10:00:00Z', BILLING), titled(FS, '2026-11-20T10:00:00Z', FIRMWARE)])
    assert.deepEqual(messages(errors({ stateDir, now: NOW, scope: scoped(BILLING) })), [])
    add('2026-11-20', [failed(BS, '2026-11-20T12:10:00Z', 'billing later'), failed(FS, '2026-11-20T12:11:00Z', 'firmware later'), failed(NS, '2026-11-20T12:12:00Z', 'unknown later')])
    assert.deepEqual(messages(errors({ stateDir, now: NOW + 1000, scope: scoped(BILLING) })), ['billing later', 'unknown later'])
  })
})

test('errors: with plugins, the plugins\' errors of every session join the orchestration\'s own, and only those', () => {
  scratch(({ stateDir, day }) => {
    day('2026-11-20', [
      titled(BS, '2026-11-20T09:00:00Z', BILLING), titled(FS, '2026-11-20T09:00:00Z', FIRMWARE), titled(FA, '2026-11-20T09:00:00Z', 'Agent: y', 'Orch: firmware [a1b2c3]'),
      failed(BS, '2026-11-20T10:00:00Z', 'billing own'), failed(FS, '2026-11-20T10:02:00Z', 'firmware own'),
      pluginError('2026-11-20T10:03:00Z', 'plugin a', { session: FS }), pluginError('2026-11-20T10:04:00Z', 'plugin b', { session: FA }), pluginError('2026-11-20T10:05:00Z', 'plugin mine', { session: BS }),
    ])
    const since = Date.parse('2026-11-20T00:00:00Z')
    const read = (orchestration: string, plugins: boolean) => errors({ stateDir, now: NOW, since, scope: scoped(orchestration, plugins) })
    assert.deepEqual(messages(read(BILLING, false)), ['billing own', 'plugin mine'])
    const withPlugins = read(BILLING, true)
    assert.deepEqual(messages(withPlugins), ['billing own', 'plugin a', 'plugin b', 'plugin mine'])
    assert.match(withPlugins[1] ?? '', /^plugin \(3 call\(s\), 3 group\(s\)\):$/)
    // The other orchestration's reader, flagged the same way, sees the plugin errors of both.
    assert.deepEqual(messages(read(FIRMWARE, true)), ['firmware own', 'plugin a', 'plugin b', 'plugin mine'])
  })
})

test('errors: two readers\' cursors are their own — one reading never swallows what the other has not read, and a successor reads where its predecessor stopped', () => {
  scratch(({ stateDir, day, add }) => {
    day('2026-11-20', [titled(BS, '2026-11-20T09:00:00Z', BILLING), titled(FS, '2026-11-20T09:00:00Z', FIRMWARE), failed(BS, '2026-11-20T10:00:00Z', 'billing one'), failed(FS, '2026-11-20T10:01:00Z', 'firmware one')])
    const read = (orchestration: string, now: number) => messages(errors({ stateDir, now, scope: scoped(orchestration) }))
    assert.deepEqual(read(BILLING, NOW), ['billing one'])
    add('2026-11-20', [failed(FS, '2026-11-20T12:10:00Z', 'firmware two'), failed(BS, '2026-11-20T12:11:00Z', 'billing two')])
    assert.deepEqual(read(FIRMWARE, NOW + 1000), ['firmware one', 'firmware two'])
    assert.deepEqual(read(BILLING, NOW + 1000), ['billing two'])
    assert.deepEqual(read('Orch: billing [ffffff]', NOW + 2000), [])
    assert.deepEqual(read(FIRMWARE, NOW + 2000), [])
    assert.equal(messages(errors({ stateDir, now: NOW + 3000 })).length, 4, 'the unscoped cursor is a third one: it reads the machine from the first reading')
    assert.deepEqual(readdirSync(stateDir).filter(n => n.endsWith('.json')).sort(), ['errors-Orch%3A%20billing.json', 'errors-Orch%3A%20firmware.json', 'errors.json'])
  })
})

test('errors: the permission prompts and their answers follow their session, the untitled ones too', () => {
  scratch(({ stateDir, day }) => {
    day('2026-11-20', [
      ask('2026-11-20T09:00:00Z', 'a', 'mine', { session: BS }), call('2026-11-20T09:00:05Z', { tool: 'Write', tool_use_id: 'a', outcome: 'ok', ask_ms: 5000, session: BS }),
      titled(BS, '2026-11-20T10:00:00Z', BILLING), titled(FS, '2026-11-20T10:00:00Z', FIRMWARE),
      ask('2026-11-20T10:01:00Z', 'b', 'theirs', { session: FS }),
    ])
    const since = Date.parse('2026-11-20T00:00:00Z')
    const billing = errors({ stateDir, now: NOW, since, scope: scoped(BILLING, true) })
    assert.equal(billing.filter(l => l.startsWith('permission prompts')).length, 1)
    assert.match(billing.join('\n'), /1× asked Write: mine \(allowed 1, denied 0, unanswered 0, up to 5 s\)/)
    assert.doesNotMatch(billing.join('\n'), /theirs/)
    assert.match(errors({ stateDir, now: NOW, since, scope: scoped(FIRMWARE, true) }).join('\n'), /1× asked Write: theirs \(allowed 0, denied 0, unanswered 1\)/)
  })
})

test('append: a long unspaced error finishes inside the writer\'s timeout and lets no secret through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-long-'))
  try {
    const secret = ['gh', 'p_', 'q7Lm2Xp9Rz4Kw8Nv3Tb6Hc1Yd5Fs0Gjabcd'].join('')
    const text = `${secret}${'-a'.repeat(50_000)}`
    const events = toolEvents(Date.parse('2026-11-20T10:00:00Z'), S, { tool: 'Bash', tool_use_id: 'toolu_01', command: 'x' }, { isError: true, text }, undefined, 1)
    const started = Date.now()
    append(join(dir, 'events'), events.map(e => JSON.stringify(e)).join('\n'), new Map())
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`)
    const stored = readFileSync(join(dir, 'events', '2026-11-20.jsonl'), 'utf8')
    assert.equal(stored.includes(secret), false)
    assert.match(stored, /\[REDACTED:github-token\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readDay: a day file removed since it was listed is skipped, the offset kept', () => {
  scratch(({ stateDir }) => {
    assert.equal(readDay(eventsDir(stateDir), '2026-11-19.jsonl', 42, () => assert.fail('nothing to read')), 42)
    assert.throws(() => readDay(eventsDir(stateDir), '.', 0, () => undefined))
  })
})

const ask = (ts: string, id: string, reason: string | undefined, more: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, ts, event: 'permission_ask', session: S, tool: 'Write', tool_use_id: id, ...(reason === undefined ? {} : { ask_reason: reason }), ...more })
const REASON = (path: string): string => `Claude requested permissions to write to ${path}, which is a sensitive file.`

test('prompts: the same reason on other paths is one line with its count and sessions; the answers come from the calls of the same id', () => {
  const items = parsed(
    ask('2026-11-20T10:00:00Z', 'a', REASON('/Users/me/a/.env')),
    ask('2026-11-20T10:05:00Z', 'b', REASON('/Users/me/b/.env'), { session: T }),
    ask('2026-11-20T10:09:00Z', 'c', REASON('/Users/me/c/.env')),
    ask('2026-11-20T10:10:00Z', 'd', undefined, { tool: 'Bash' }),
    call('2026-11-20T10:00:09Z', { tool: 'Write', tool_use_id: 'a', outcome: 'ok', ask_ms: 9000 }),
    call('2026-11-20T10:05:30Z', { tool: 'Write', tool_use_id: 'b', outcome: 'refused', decided_by: 'user', ask_ms: 30000, error_message: 'The user doesn\'t want to proceed' }),
  )
  const [sensitive, bare] = promptGroups(items)
  assert.deepEqual([sensitive?.count, sensitive?.sessions.size, sensitive?.allowed, sensitive?.denied, sensitive?.waitMs, sensitive?.normalised], [3, 2, 1, 1, 30000, 'Claude requested permissions to write to <path> which is a sensitive file.'])
  assert.deepEqual([bare?.tool, bare?.normalised, bare?.count], ['Bash', '(no reason)', 1])
  const lines = render(items, NOW - 3_600_000)
  assert.equal(lines[0], 'errors since 2026-11-20T11:00Z: 1 failed call(s)')
  assert.ok(lines.includes('permission prompts (4 shown, 2 group(s)):'))
  assert.match(lines.find(l => l.startsWith('3× asked Write')) ?? '', /^3× asked Write: Claude requested permissions to write to <path> which is a sensitive file\. \(allowed 1, denied 1, unanswered 1, up to 30 s\) \[11-20 10:00Z → 11-20 10:09Z, 2 session\(s\)\] — e\.g\. /)
})

test('prompts: a store with prompts only prints them; one without any prints none; an ended call that was never prompted is not one', () => {
  assert.deepEqual(render(parsed(ask('2026-11-20T10:00:00Z', 'a', 'why')), NOW).slice(1), ['permission prompts (1 shown, 1 group(s)):', '1× asked Write: why (allowed 0, denied 0, unanswered 1) [11-20 10:00Z, 1 session(s)] — e.g. "why"'])
  assert.deepEqual(render(parsed(call('2026-11-20T10:00:00Z', { outcome: 'ok' })), NOW), ['errors since 2026-11-20T12:00Z: 0 failed call(s)'])
})

test('errors: the prompts of a day file are read from the cursor like the failures', () => {
  scratch(({ stateDir, day }) => {
    day('2026-11-20', [ask('2026-11-20T10:00:00Z', 'a', 'why'), call('2026-11-20T10:00:05Z', { tool: 'Write', tool_use_id: 'a', outcome: 'ok', ask_ms: 5000 })])
    const first = errors({ stateDir, now: NOW })
    assert.match(first[2] ?? '', /^1× asked Write: why \(allowed 1, denied 0, unanswered 0, up to 5 s\)/)
    assert.deepEqual(errors({ stateDir, now: NOW + 1000 }), ['errors since 2026-11-20T12:00Z: 0 failed call(s)'])
  })
})

test('prompts: a tool that failed after the operator allowed it counts as allowed; an answer read in a later pass does not reach its prompt', () => {
  const failed = parsed(
    ask('2026-11-20T10:00:00Z', 'a', 'why'),
    call('2026-11-20T10:00:04Z', { tool: 'Write', tool_use_id: 'a', outcome: 'error', ask_ms: 4000, error_message: 'File has not been read yet' }),
  )
  assert.deepEqual(promptGroups(failed).map(g => [g.allowed, g.denied, g.waitMs]), [[1, 0, 4000]])
  scratch(({ stateDir, day, add }) => {
    day('2026-11-20', [ask('2026-11-20T10:00:00Z', 'a', 'why')])
    assert.match(errors({ stateDir, now: NOW })[2] ?? '', /\(allowed 0, denied 0, unanswered 1\)/)
    add('2026-11-20', [call('2026-11-20T10:00:09Z', { tool: 'Write', tool_use_id: 'a', outcome: 'ok', ask_ms: 9000 })])
    assert.deepEqual(errors({ stateDir, now: NOW + 1000 }), ['errors since 2026-11-20T12:00Z: 0 failed call(s)'])
  })
})
