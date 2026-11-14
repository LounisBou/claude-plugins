// The health command's reader and report: the journals under a configuration directory, summarized
// over the contract's window, with no model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eventId, journalDir, type LearningEvent } from '../../../core/learning.ts'
import { HEALTH_USAGE, readJournals, render, run, summarize } from './health.ts'

const NOW = Date.parse('2026-11-14T10:00:00Z')
const DAY = 86_400_000
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString().replace('.000Z', 'Z')

function event(plugin: string, daysAgo: number, change: Partial<LearningEvent> = {}, random = '0a1b2c3d'): LearningEvent {
  const at = iso(daysAgo)
  return {
    v: 1, id: eventId(at, random) ?? '', at, kind: 'refusal', source: { plugin, code: `${plugin}.ready.missing-review` },
    subject: { repo: null, pr: null, head: null },
    context: { role: null, mode: null, paths: [], languages: [], session: null },
    evidence: [], trust: 'computed', ...change,
  }
}

function write(config: string, plugin: string, e: LearningEvent): void {
  const dir = journalDir(config, plugin)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${e.id}.json`), JSON.stringify(e))
}

function scratch(work: (config: string) => void): void {
  const config = mkdtempSync(join(tmpdir(), 'learning-health-'))
  try {
    work(config)
  } finally {
    rmSync(config, { recursive: true, force: true })
  }
}

test('readJournals reads each plugin\'s own journal and counts what is not an event of the contract', () => {
  scratch(config => {
    write(config, 'github', event('github', 1))
    write(config, 'norms', event('norms', 2))
    mkdirSync(journalDir(config, 'pr-review'), { recursive: true })
    writeFileSync(join(journalDir(config, 'norms'), 'broken.json'), '{ not json')
    writeFileSync(join(journalDir(config, 'norms'), 'foreign.json'), JSON.stringify({ ...event('norms', 3), command: 'git push' }))
    writeFileSync(join(journalDir(config, 'norms'), 'notes.txt'), 'not an event file')
    mkdirSync(join(config, 'projects'), { recursive: true })
    mkdirSync(join(config, 'Not A Plugin', 'journal'), { recursive: true })
    const journals = readJournals(config)
    assert.deepEqual(journals.map(j => [j.plugin, j.events.length, j.unreadable]), [['github', 1, 0], ['norms', 1, 2], ['pr-review', 0, 0]])
  })
})

test('readJournals reads a configuration directory with no journal, or none at all', () => {
  scratch(config => {
    assert.deepEqual(readJournals(config), [])
    assert.deepEqual(readJournals(join(config, 'absent')), [])
  })
})

test('summarize counts the window\'s events by kind, refusals by code and findings by severity', () => {
  const journals = [
    { plugin: 'github', unreadable: 0, events: [
      event('github', 1), event('github', 2, {}, '00000001'),
      event('github', 3, { source: { plugin: 'github', code: 'github.ready.missing-e2e' } }, '00000002'),
      event('github', 40, {}, '00000003'),
    ] },
    { plugin: 'pr-review', unreadable: 1, events: [
      event('pr-review', 1, { kind: 'finding', source: { plugin: 'pr-review', code: 'pr-review.finding' }, evidence: [{ type: 'finding', severity: 'critical', file: 'a.ts' }] }),
      event('pr-review', 2, { kind: 'finding', source: { plugin: 'pr-review', code: 'pr-review.finding' }, evidence: [{ type: 'finding', severity: 'important', file: 'a.ts' }, { type: 'finding', severity: 'important', file: 'b.ts' }] }, '00000001'),
      event('pr-review', 2, { kind: 'answer', source: { plugin: 'pr-review', code: 'pr-review.push-ask' }, trust: 'operator' }, '00000002'),
      event('pr-review', 2, { kind: 'escape', source: { plugin: 'pr-review', code: 'pr-review.escape' } }, '00000003'),
    ] },
  ]
  const s = summarize(journals, NOW)
  assert.equal(s.plugins, 2)
  assert.equal(s.events, 7)
  assert.equal(s.older, 1)
  assert.equal(s.unreadable, 1)
  assert.deepEqual(s.kinds, { refusal: 3, finding: 2, answer: 1, escape: 1 })
  assert.deepEqual(s.refusals, [['github.ready.missing-review', 2], ['github.ready.missing-e2e', 1]])
  assert.deepEqual(s.findings, { critical: 1, important: 2 })
})

test('summarize puts the edge of the window inside it, and keeps refusal codes in order of count then name', () => {
  const at = (days: number, code: string, random: string) => event('github', days, { source: { plugin: 'github', code } }, random)
  const s = summarize([{ plugin: 'github', unreadable: 0, events: [at(30, 'github.b.x', '00000001'), at(31, 'github.c.x', '00000002'), at(1, 'github.a.x', '00000003')] }], NOW)
  assert.equal(s.events, 2)
  assert.equal(s.older, 1)
  assert.deepEqual(s.refusals, [['github.a.x', 1], ['github.b.x', 1]])
})

test('render says what the window holds, and what it does not read yet', () => {
  const s = summarize([{ plugin: 'github', unreadable: 0, events: [event('github', 1)] }], NOW)
  const text = render(s)
  assert.match(text, /30 days/)
  assert.match(text, /github\.ready\.missing-review +1/)
  assert.match(text, /findings: 0 critical, 0 important/)
  assert.match(text, /not read yet/i)
})

test('render says plainly that no journal exists, and that unreadable files exist', () => {
  assert.match(render(summarize([], NOW)), /no journal/i)
  assert.match(render(summarize([{ plugin: 'norms', unreadable: 2, events: [] }], NOW)), /2 files? .*not .*contract/i)
})

test('run prints the report of the configuration directory, and refuses a call without one', () => {
  scratch(config => {
    write(config, 'github', event('github', 1))
    const outs: string[] = []
    const errs: string[] = []
    const deps = { out: (l: string) => outs.push(l), err: (l: string) => errs.push(l), now: () => NOW }
    assert.equal(run(['--config', config], deps), 0)
    assert.match(outs.join('\n'), /github\.ready\.missing-review +1/)
    assert.equal(run([], deps), 2)
    assert.equal(run(['--config'], deps), 2)
    assert.equal(run(['--config', config, 'extra'], deps), 2)
    assert.deepEqual(errs, [HEALTH_USAGE, HEALTH_USAGE, HEALTH_USAGE])
  })
})
