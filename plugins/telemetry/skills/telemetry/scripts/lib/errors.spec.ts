// The grouping of failed calls: what is one group and what is two, the plugins' own first, the
// message's variable parts normalised, and the cursor that moves one reading to the next.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURSOR_FILE, errors, failureOf, group, normalise, pluginScript, render } from './errors.ts'
import { eventsDir } from './store.ts'

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
  assert.equal(many.at(-1), '… 5 more group(s), 5 call(s)')
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
