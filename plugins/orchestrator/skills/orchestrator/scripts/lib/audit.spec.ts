import { strict as assert } from 'node:assert'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { auditRun, fullHead, pointerOf, scriptJournal, stamp, writeAudit, writeEscape } from './audit.ts'
import { parseJournalEvent } from '../../../../core/learning.ts'

let dir = ''
test.beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'audit-'))) })
test.afterEach(() => rmSync(dir, { recursive: true, force: true }))

const NOW = new Date('2026-11-14T10:15:00.500Z')
const FACT = { step: 'implement', edge: 'start', record: null, row: 1, result: null } as const

test('a file is named under the configuration directory, else the home directory, else by its last two segments', () => {
  const env = { CLAUDE_CONFIG_DIR: join(dir, 'cfg'), HOME: join(dir, 'home') }
  assert.equal(pointerOf(join(dir, 'cfg', 'claude-orchestrator', 'briefs', 'p', 'r.jsonl'), env), 'claude-orchestrator/briefs/p/r.jsonl')
  assert.equal(pointerOf(join(dir, 'home', 'work', 'r.jsonl'), env), 'work/r.jsonl')
  assert.equal(pointerOf('/elsewhere/deep/p/r.jsonl', env), 'p/r.jsonl')
  assert.equal(pointerOf('/elsewhere/a b/r.jsonl', env), null)
})

test('a head is kept whole or not at all', () => {
  assert.equal(fullHead('A'.repeat(40)), 'a'.repeat(40))
  assert.equal(fullHead('abc1234'), null)
  assert.equal(fullHead(undefined), null)
  assert.equal(stamp(NOW), '2026-11-14T10:15:00Z')
})

test('an event is written with the session that ran it, or without it when the contract does not take its id', () => {
  const events: Record<string, unknown>[] = []
  const journal = (event: object) => { events.push(event as Record<string, unknown>) }
  writeAudit(journal, auditRun({ CLAUDE_CODE_SESSION_ID: 'abc-1' }, NOW), 'step', 'orchestrator.dispatch.open', FACT)
  writeAudit(journal, auditRun({ CLAUDE_CODE_SESSION_ID: 'two words' }, NOW), 'step', 'orchestrator.dispatch.open', FACT)
  writeEscape(journal, auditRun({ CLAUDE_CODE_SESSION_ID: 'two words' }, NOW), 'orchestrator.dispatch.escaped', [])
  writeAudit(journal, auditRun({}, NOW), 'step', 'orchestrator.dispatch.open', { ...FACT, row: 0 })
  writeAudit(undefined, auditRun({}, NOW), 'step', 'orchestrator.dispatch.open', FACT)
  writeEscape(undefined, auditRun({}, NOW), 'orchestrator.dispatch.escaped', [])
  assert.deepEqual(events.map(e => (e['context'] as { session: unknown }).session), ['abc-1', null, null])
  for (const event of events) assert.ok(parseJournalEvent(event))
})

test('the journal of a script is the orchestrator\'s, under the configuration directory', () => {
  const env = { CLAUDE_CONFIG_DIR: join(dir, 'cfg') }
  const warned: string[] = []
  writeAudit(scriptJournal(env, () => NOW, line => warned.push(line)), auditRun(env, NOW), 'step', 'orchestrator.dispatch.open', FACT)
  const journal = join(dir, 'cfg', 'orchestrator', 'journal')
  const [name] = readdirSync(journal)
  assert.ok(parseJournalEvent(JSON.parse(readFileSync(join(journal, name ?? ''), 'utf8'))))
  assert.deepEqual(warned, [])
})

test('ORCHESTRATOR_JOURNAL_DIR, when set, is the journal a script writes, and the configuration directory gets none', () => {
  const env = { CLAUDE_CONFIG_DIR: join(dir, 'cfg'), ORCHESTRATOR_JOURNAL_DIR: join(dir, 'suite-journal') }
  writeAudit(scriptJournal(env, () => NOW, () => {}), auditRun(env, NOW), 'step', 'orchestrator.dispatch.open', FACT)
  assert.equal(readdirSync(join(dir, 'suite-journal')).length, 1)
  assert.deepEqual(readdirSync(dir).sort(), ['suite-journal'])
})
