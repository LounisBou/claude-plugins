// The sweep over a scratch store: a session whose events stopped with no end gets its transcript's
// summary, once; a settled round question gets its event, once, with its asker and its letter and
// none of its words; a dispatch the orchestrator's journal holds gets its event, once; and the
// day's sweep is taken by one caller.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eventsDir } from './store.ts'
import { claimSweep, IDLE_MS, journalDispatches, questionEvent, settledQuestions, sweep, sweepDue } from './sweep.ts'
import { auditEvent, journalFileOf } from '../../../../core/learning.ts'

const S = '60ed5626-9879-4041-892a-5db0ff0bad69'
const OTHER = '11111111-2222-4333-8444-555555555555'
const FIXTURE = fileURLToPath(new URL(`../../../../tests/fixtures/${S}.jsonl`, import.meta.url))
const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const event = (ts: string, kind: string, session: string, more: object = {}): string => JSON.stringify({ v: 1, ts, event: kind, session, ...more })

function scratch(work: (r: { config: string; stateDir: string; module: string; day: (name: string, lines: string[]) => void; stored: () => Record<string, unknown>[]; run: (now?: number) => ReturnType<typeof sweep> }) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'telemetry-sweep-'))
  const config = join(root, 'config')
  const stateDir = join(config, 'telemetry')
  const module = join(config, 'claude-orchestrator')
  mkdirSync(eventsDir(stateDir), { recursive: true })
  mkdirSync(join(config, 'projects', '-w'), { recursive: true })
  cpSync(FIXTURE, join(config, 'projects', '-w', `${S}.jsonl`))
  try {
    work({
      config, stateDir, module,
      day: (name, lines) => writeFileSync(join(eventsDir(stateDir), `${name}.jsonl`), `${lines.join('\n')}\n`),
      stored: () => readdirSync(eventsDir(stateDir)).sort().flatMap(name => readFileSync(join(eventsDir(stateDir), name), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)),
      run: (now = NOW) => sweep({ config, stateDir, secrets: new Map(), now }),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('a session whose events stopped a day ago with no end is summarized from its transcript, once', () => {
  scratch(r => {
    r.day('2026-11-13', [event('2026-11-13T20:00:00.000Z', 'session_start', S, { spawned: true }), event('2026-11-13T20:30:00.000Z', 'turn_end', S)])
    assert.deepEqual(r.run(), { sessions: 1, questions: 0, dispatches: 0, refused: [] })
    const summary = r.stored().find(e => e['event'] === 'session_summary')
    assert.deepEqual([summary?.['session'], summary?.['source'], summary?.['title'], summary?.['role']], [S, 'sweep', 'Orch: billing', 'orchestrator'])
    // Written at the later of the transcript's end and the last event, so it closes them all.
    assert.equal(Date.parse(String(summary?.['ts'])) >= Date.parse('2026-11-13T20:30:00.000Z'), true)
    assert.deepEqual(r.run(), { sessions: 0, questions: 0, dispatches: 0, refused: [] })
    assert.equal(r.stored().filter(e => e['event'] === 'session_summary').length, 1)
    assert.deepEqual(check(eventsDir(r.stateDir), new Map()), [])
  })
})

test('a session that ended, one still fresh, one without a transcript and one out of the window are left alone', () => {
  scratch(r => {
    r.day('2026-11-01', [event('2026-11-01T10:00:00.000Z', 'turn_end', S)])
    assert.equal(r.run().sessions, 0)
    r.day('2026-11-13', [event('2026-11-13T20:00:00.000Z', 'turn_end', S), event('2026-11-13T20:40:00.000Z', 'session_end', S), event('2026-11-13T20:00:00.000Z', 'turn_end', OTHER)])
    assert.equal(r.run().sessions, 0)
    r.day('2026-11-13', [event('2026-11-13T20:00:00.000Z', 'turn_end', S)])
    assert.equal(r.run(Date.parse('2026-11-13T20:00:00.000Z') + IDLE_MS - 1).sessions, 0)
  })
})

test('a session that ended and then ran again with no second end is summarized', () => {
  scratch(r => {
    r.day('2026-11-13', [event('2026-11-13T19:00:00.000Z', 'session_end', S), event('2026-11-13T20:30:00.000Z', 'turn_end', S)])
    assert.equal(r.run().sessions, 1)
  })
})

test('a transcript that moved within the day keeps its session open, whatever the events say', () => {
  scratch(r => {
    r.day('2026-11-13', [event('2026-11-13T20:00:00.000Z', 'turn_end', S)])
    const path = join(r.config, 'projects', '-w', `${S}.jsonl`)
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify({ type: 'user', timestamp: '2026-11-15T11:00:00.000Z', message: { content: 'x' } })}\n`)
    assert.equal(r.run().sessions, 0)
  })
})

const CHOICES = [{ letter: 'A', text: 'Ship it now' }, { letter: 'B', text: 'Wait for the review' }]
const asked = (id: string, more: object = {}): object => ({
  v: 2, id, sender: { session: S, name: 'Orch: billing [a1b2c3]', role: 'orchestrator', machine: 'here' }, subject: 'the secret subject', context: 'secret context',
  ask: 'A secret question?', choices: CHOICES, recommended: 'B', why: 'because', blocks: 'the release', status: 'answered', at: '2026-11-14T10:00:00.000Z',
  answer: { text: 'A', by: 'pane', at: '2026-11-14T10:05:00.000Z', settler: 'Coord: c' }, seq: 2, ...more,
})

test('a settled round question is recorded once: its id, its asker, the letter, no word of its text', () => {
  scratch(r => {
    mkdirSync(join(r.module, 'round', 'archive'), { recursive: true })
    writeFileSync(join(r.module, 'round', 'q-1.json'), JSON.stringify(asked('q-60ed5626-987-mhz1abcd-0f3k')))
    writeFileSync(join(r.module, 'round', 'q-open.json'), JSON.stringify(asked('q-open', { status: 'open', answer: null })))
    writeFileSync(join(r.module, 'round', 'broken.json'), '{')
    writeFileSync(join(r.module, 'round', 'archive', 'relayed.json'), JSON.stringify({
      id: `${S}-0badf00d`, from: 'Orch: other', session: OTHER, kind: 'operator', since: '2026-11-14T08:00:00.000Z', blocks: 'x', question: 'secret words', choices: CHOICES,
      recommendation: 'A', status: 'withdrawn', at: '2026-11-14T08:00:01.000Z', answer: { text: 'superseded', by: 'sender', at: '2026-11-14T09:00:00.000Z' },
    }))
    writeFileSync(join(r.module, 'round', 'archive', 'old.json'), JSON.stringify(asked('q-old', { answer: { text: 'B', by: 'tab', at: '2026-11-01T10:00:00.000Z' } })))
    assert.deepEqual(r.run(), { sessions: 0, questions: 2, dispatches: 0, refused: [] })
    const answered = r.stored().find(e => e['status'] === 'answered')
    const withdrawn = r.stored().find(e => e['status'] === 'withdrawn')
    assert.deepEqual(answered, {
      v: 1, ts: '2026-11-14T10:05:00.000Z', event: 'question', session: S, title: 'Orch: billing [a1b2c3]', role: 'orchestrator', source: 'round_file',
      id: 'q-60ed5626-987-mhz1abcd-0f3k', kind: 'operator', status: 'answered', by: 'pane', count: 1, options: [2], recommended: 'B', chosen: ['A'], wait_ms: 300_000,
    })
    assert.deepEqual([withdrawn?.['session'], withdrawn?.['title'], withdrawn?.['id'], withdrawn?.['chosen'], withdrawn?.['status'], withdrawn?.['by']], [OTHER, 'Orch: other', `${S}-0badf00d`, ['-'], 'withdrawn', 'sender'])
    assert.equal(/secret|Ship it|superseded/.test(JSON.stringify(r.stored())), false)
    assert.deepEqual(r.run(), { sessions: 0, questions: 0, dispatches: 0, refused: [] })
    assert.equal(r.stored().length, 2)
    assert.deepEqual(check(eventsDir(r.stateDir), new Map()), [])
  })
})

test('a question answered in other words is `other`; one whose asker has no session id of the host\'s shape is refused, not written', () => {
  scratch(r => {
    mkdirSync(join(r.module, 'round'), { recursive: true })
    writeFileSync(join(r.module, 'round', 'a.json'), JSON.stringify(asked('q-a', { answer: { text: 'neither, do a third thing', by: 'coordinator', at: '2026-11-14T10:05:00.000Z' }, urgent: true })))
    writeFileSync(join(r.module, 'round', 'b.json'), JSON.stringify(asked('q-b', { sender: { session: 'remote session', name: 'Orch: far' } })))
    assert.deepEqual(r.run(), { sessions: 0, questions: 1, dispatches: 0, refused: ['bad session'] })
    assert.deepEqual([r.stored()[0]?.['chosen'], r.stored()[0]?.['urgent']], [['other'], true])
    assert.equal(questionEvent({ ...settledQuestions(r.module)[0]!, answer: null }), undefined)
  })
})

test('the round is read under the data root the orchestrator\'s directory places, never one left there', () => {
  scratch(r => {
    const data = join(r.config, '..', 'shared')
    mkdirSync(join(data, 'round'), { recursive: true })
    mkdirSync(join(r.module, 'round'), { recursive: true })
    writeFileSync(join(r.module, 'data-root.json'), JSON.stringify({ version: 1, dir: data }))
    writeFileSync(join(data, 'round', 'a.json'), JSON.stringify(asked('q-a')))
    writeFileSync(join(r.module, 'round', 'b.json'), JSON.stringify(asked('q-b')))
    assert.equal(r.run().questions, 1)
    assert.deepEqual(r.stored().map(event => event['id']), ['q-a'])
  })
})

test('a dispatch the orchestrator\'s journal holds is recorded once, with its row and pair; another kind, an old one and one with no session are not', () => {
  scratch(r => {
    const journal = join(r.config, 'orchestrator', 'journal')
    mkdirSync(journal, { recursive: true })
    const put = (at: string, random: string, kind: 'dispatch' | 'step', session: string | null): void => {
      const base = { at, random, source: { plugin: 'orchestrator', code: 'orchestrator.dispatch.close' }, trust: 'computed' as const, subject: { head: 'a'.repeat(40) }, context: { session } }
      const event = kind === 'dispatch'
        ? auditEvent({ ...base, kind, fact: { sub: 'close', record: 'claude-orchestrator/briefs/p/dispatch.jsonl', row: 4, class: 'feature', tier: null, model: 'opus', effort: 'high', verdict: 'merged' } })
        : auditEvent({ ...base, kind, fact: { step: 'implement', edge: 'start', record: null, row: 4, result: null } })
      assert.ok(event)
      writeFileSync(join(journal, journalFileOf(event.id)), JSON.stringify(event))
    }
    put('2026-11-14T09:00:00Z', '0000000a', 'dispatch', S)
    put('2026-11-14T09:00:01Z', '0000000b', 'step', S)
    put('2026-11-14T09:00:02Z', '0000000c', 'dispatch', null)
    put('2026-11-01T09:00:00Z', '0000000d', 'dispatch', S)
    put('2026-11-14T09:00:03Z', '0000000e', 'dispatch', 'orch-1')
    writeFileSync(join(journal, '20261114T090004Z-0000000f.json'), '{')
    writeFileSync(join(journal, 'folded.json'), '{}')
    assert.deepEqual(r.run(), { sessions: 0, questions: 0, dispatches: 1, refused: ['bad session'] })
    assert.deepEqual(r.stored(), [{
      v: 1, ts: '2026-11-14T09:00:00.000Z', event: 'dispatch', session: S, source: 'journal', id: '20261114T090000Z-0000000a',
      sub: 'close', record: 'dispatch.jsonl', row: '4', class: 'feature', model: 'opus', effort: 'high', head: 'aaaaaaaaaaaa', verdict: 'merged',
    }])
    assert.deepEqual(r.run(), { sessions: 0, questions: 0, dispatches: 0, refused: ['bad session'] })
    assert.equal(r.stored().length, 1)
    assert.deepEqual(journalDispatches(join(r.config, 'none'), '2026-11-01'), [])
    assert.deepEqual(sweep({ config: r.config, stateDir: r.stateDir, secrets: new Map(), now: NOW, journalDir: join(r.config, 'none') }).dispatches, 0)
  })
})

test('a count of github\'s reconciler its journal holds is recorded once as a reconcile event; one with no session is not', () => {
  scratch(r => {
    const journal = join(r.config, 'github', 'journal')
    mkdirSync(journal, { recursive: true })
    const put = (at: string, random: string, session: string | null): void => {
      const event = auditEvent({ at, random, source: { plugin: 'github', code: 'github.reconcile.counts' }, trust: 'computed', context: { session }, kind: 'reconcile', fact: { ticks: 3, listings: 2, gates: 1, moves: 1 } })
      assert.ok(event)
      writeFileSync(join(journal, journalFileOf(event.id)), JSON.stringify(event))
    }
    put('2026-11-14T09:00:00Z', '0000000a', S)
    put('2026-11-14T09:03:00Z', '0000000b', null)
    put('2026-11-01T09:00:00Z', '0000000c', S)
    assert.deepEqual(r.run(), { sessions: 0, questions: 0, dispatches: 0, reconciles: 1, refused: [] })
    assert.deepEqual(r.stored(), [{
      v: 1, ts: '2026-11-14T09:00:00.000Z', event: 'reconcile', session: S, source: 'journal', id: '20261114T090000Z-0000000a', ticks: 3, listings: 2, gates: 1, moves: 1,
    }])
    assert.deepEqual(r.run(), { sessions: 0, questions: 0, dispatches: 0, refused: [] })
    assert.equal(r.stored().length, 1)
  })
})

test('no round directory, no store: a sweep that finds nothing writes nothing', () => {
  scratch(r => {
    assert.deepEqual(sweep({ config: join(r.config, 'none'), stateDir: join(r.config, 'none', 'telemetry'), secrets: new Map(), now: NOW }), { sessions: 0, questions: 0, dispatches: 0, refused: [] })
    assert.deepEqual(settledQuestions(join(r.config, 'none')), [])
  })
})

test('the day\'s sweep is taken once; the next day it is due again; a state file that is no state is no claim', () => {
  scratch(r => {
    assert.equal(sweepDue(r.stateDir, NOW), true)
    assert.equal(claimSweep(r.stateDir, NOW), true)
    assert.equal(sweepDue(r.stateDir, NOW), false)
    assert.equal(claimSweep(r.stateDir, NOW + 1000), false)
    assert.equal(claimSweep(r.stateDir, NOW + IDLE_MS), true)
    writeFileSync(join(r.stateDir, 'sweep.json'), 'not json')
    assert.equal(sweepDue(r.stateDir, NOW), true)
    writeFileSync(join(r.stateDir, 'sweep.json'), '{"swept_day":7}')
    assert.equal(sweepDue(r.stateDir, NOW), true)
  })
})
