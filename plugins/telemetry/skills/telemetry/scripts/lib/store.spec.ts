// The store: validated, redacted, appended per UTC day; the scan finds what slipped past.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentSpawned, LINE_MAX, TEXT_MAX, toolEvents } from '../../../../hooks/collect.ts'
import { append, check, dayFiles, parseEvent, scan } from './store.ts'

const S = '60ed5626-9879-4041-892a-5db0ff0bad69'
const event = (ts: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, ts, event: 'tool_call', session: S, ...extra })
const SECRET = ['gh', 'p_', 'q7Lm2Xp9Rz4Kw8Nv3Tb6Hc1Yd5Fs0Gjabcd'].join('')

function withDir(work: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-store-'))
  try {
    work(join(dir, 'events'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('parseEvent: refuses what is no version 1 event', () => {
  assert.equal(parseEvent('nope'), 'not JSON')
  assert.equal(parseEvent('[1]'), 'not an object')
  assert.equal(parseEvent('{"v":2}'), 'not version 1')
  assert.equal(parseEvent('{"v":1,"event":"other"}'), 'unknown event')
  assert.equal(parseEvent('{"v":1,"event":"tool_call","ts":"yesterday"}'), 'bad ts')
  assert.equal(parseEvent(`{"v":1,"event":"tool_call","ts":"2026-11-13T00:00:00Z","session":"s"}`), 'bad session')
  assert.equal(typeof parseEvent(event('2026-11-13T00:00:00Z')), 'object')
})

test('append: one file per UTC day, redacted before it is written, invalid lines refused', () => {
  withDir(dir => {
    const lines = [
      event('2026-11-13T23:59:59.999Z', { bash: { line: `git push https://${SECRET}@forge.example/x.git` } }),
      event('2026-11-14T00:00:00.000Z', { bash: { line: 'echo $API_PASS' }, note: 'value-of-the-env-file' }),
      'garbage',
      '',
    ].join('\n')
    const result = append(dir, lines, new Map([['API_PASS', 'value-of-the-env-file']]))
    assert.deepEqual(result, { written: 2, refused: ['not JSON'] })
    assert.deepEqual(dayFiles(dir), ['2026-11-13.jsonl', '2026-11-14.jsonl'])
    const first = readFileSync(join(dir, '2026-11-13.jsonl'), 'utf8')
    assert.ok(!first.includes(SECRET))
    assert.ok(first.includes('https://[REDACTED:url-credentials]forge.example'))
    assert.ok(readFileSync(join(dir, '2026-11-14.jsonl'), 'utf8').includes('"note":"[REDACTED:env]"'))
    append(dir, event('2026-11-13T10:00:00Z'), new Map())
    assert.equal(readFileSync(join(dir, '2026-11-13.jsonl'), 'utf8').split('\n').length, 3)
    assert.ok(!existsSync(join(dir, '2026-11-13.jsonl.lock')))
    assert.deepEqual(check(dir, new Map([['API_PASS', 'value-of-the-env-file']])), [])
  })
})

test('check: a secret planted in a day file is found, named by file, line and pattern', () => {
  withDir(dir => {
    append(dir, event('2026-11-13T10:00:00Z'), new Map())
    appendFileSync(join(dir, '2026-11-13.jsonl'), `${event('2026-11-13T10:00:01Z', { bash: { line: `curl -H 'Authorization: Bearer ${SECRET}'` } })}\nnot json\n`)
    writeFileSync(join(dir, 'notes.txt'), SECRET)
    assert.deepEqual(check(dir, new Map()), [
      { file: '2026-11-13.jsonl', line: 2, pattern: 'github-token' },
      { file: '2026-11-13.jsonl', line: 2, pattern: 'authorization' },
      { file: '2026-11-13.jsonl', line: 3, pattern: 'invalid (not JSON)' },
    ])
  })
})

test('append: a secret straddling a length limit is redacted whole before the cut, nothing of it left', () => {
  withDir(dir => {
    const value = 'zq9-env-secret-value'
    const secrets = new Map([['SERVICE_PASS', value]])
    const at = Date.parse('2026-11-13T10:00:00Z')
    const bash = (command: string) => toolEvents(at, S, { tool: 'Bash', command, tool_use_id: 'toolu_01A' }, {}, undefined, 1)
    const events = [
      ...bash(`echo ${'x'.repeat(LINE_MAX - 16)} ${value}`),
      ...bash(`echo ${'x'.repeat(LINE_MAX - 16)} ${SECRET}`),
      ...bash(`dispatch-record.ts close /r/record.jsonl 68 --verdict '${'v'.repeat(TEXT_MAX - 12)} ${value}'`),
      agentSpawned(at, S, { description: `${'d'.repeat(TEXT_MAX - 12)} ${SECRET}` }, { agentId: 'a1' }),
    ]
    assert.deepEqual(append(dir, events.map(e => JSON.stringify(e)).join('\n'), secrets).refused, [])
    const stored = readFileSync(join(dir, '2026-11-13.jsonl'), 'utf8')
    // Each secret starts ten characters before its limit: a cut first would keep that much of it.
    assert.ok(!stored.includes(value.slice(0, 4)), stored)
    assert.ok(!stored.includes(SECRET.slice(0, 4)), stored)
    assert.ok(stored.includes('"verdict":"vvvv'))
    assert.deepEqual(check(dir, secrets), [])
  })
})

test('check: what the redaction already marked passes, an identifier mark and a three-word Authorization', () => {
  withDir(dir => {
    const header = ['Authorization: Digest ', 'one two ', 'three'].join('')
    const lines = [event('2026-11-13T10:00:00Z', { agent: 'not an id!' }), event('2026-11-13T10:00:01Z', { bash: { line: `curl -H "${header}" https://api.example.com` } })]
    assert.deepEqual(append(dir, lines.join('\n'), new Map()).refused, [])
    const stored = readFileSync(join(dir, '2026-11-13.jsonl'), 'utf8')
    assert.ok(stored.includes('"agent":"[REDACTED:identifier]"'), stored)
    assert.ok(stored.includes('Authorization: [REDACTED:authorization]\\" https'), stored)
    assert.ok(!/one|two|three/.test(stored), stored)
    assert.deepEqual(check(dir, new Map()), [])
  })
})

test('append: a secret assignment whose mark the cut drops is redacted again, so the line scans clean', () => {
  withDir(dir => {
    // The mark starts two characters before the limit: the cut drops it whole and leaves `PASSWORD=…`.
    const line = `${'x'.repeat(LINE_MAX - 12)} ${['PASS', 'WORD='].join('')}zq9-cut-value`
    assert.deepEqual(append(dir, event('2026-11-13T10:00:00Z', { bash: { line } }), new Map()).refused, [])
    const stored = readFileSync(join(dir, '2026-11-13.jsonl'), 'utf8')
    assert.ok(!stored.includes('zq9'), stored)
    assert.deepEqual(check(dir, new Map()), [])
  })
})

test('append: a password option after a line continuation is redacted, and the stored day passes check', () => {
  withDir(dir => {
    const secret = ['zq9', 'cont', 'value'].join('-')
    const lines = [
      event('2026-11-13T10:00:00Z', { bash: { line: `mysql -u me \\\n  -p${secret} app` } }),
      event('2026-11-13T10:00:01Z', { bash: { line: 'find /var/lib/mysql -perm 600 -print -prune' } }),
    ]
    assert.deepEqual(append(dir, lines.join('\n'), new Map()).refused, [])
    const stored = readFileSync(join(dir, '2026-11-13.jsonl'), 'utf8')
    assert.ok(!stored.includes('zq9'), stored)
    assert.ok(stored.includes('-print -prune'), stored)
    assert.deepEqual(check(dir, new Map()), [])
  })
})

test('check: a token planted in a nested identifier field, or a top-level one, is found', () => {
  withDir(dir => {
    append(dir, event('2026-11-13T10:00:00Z'), new Map())
    appendFileSync(join(dir, '2026-11-13.jsonl'), `${event('2026-11-13T10:00:01Z', { bash: { agent: SECRET, tool_use_id: SECRET } })}\n${event('2026-11-13T10:00:02Z', { tool_use_id: SECRET })}\n`)
    assert.deepEqual(check(dir, new Map()), [
      { file: '2026-11-13.jsonl', line: 2, pattern: 'github-token' },
      { file: '2026-11-13.jsonl', line: 3, pattern: 'github-token' },
    ])
  })
})

test('scan: an invalid line holding a secret names the secret\'s pattern; an identifier out of shape is found', () => {
  assert.deepEqual(scan('f', `oops ${SECRET}`, new Map()), [{ file: 'f', line: 1, pattern: 'github-token' }])
  assert.deepEqual(scan('f', event('2026-11-13T10:00:00Z', { tool_use_id: 'has spaces' }), new Map()), [{ file: 'f', line: 1, pattern: 'identifier' }])
  assert.deepEqual(dayFiles('/nonexistent/telemetry'), [])
})
