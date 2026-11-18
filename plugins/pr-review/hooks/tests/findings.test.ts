// hooks/tests/findings.test.ts
// What the module's journal keeps of a review: one event per Critical or Important finding of each
// pass the loop accepts, written as the pass ends, so the findings outlive the session; and the pull
// request on every event written once the module read it. An event holds where and how severe,
// never what was said.
import { expect, test } from 'claude-code/testing'
import type { Engine, Reply, TestOn } from 'claude-code/testing'
import { parseLearningEvent } from '../../core/learning.ts'
import { REPORT_REQUEST } from '../report.ts'
import { watchJournal } from './journal.ts'

const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const HEAD = 'a'.repeat(40)
const SUBJECT = { repo: 'lounisbou/claude-review', pr: 12, head: HEAD }
const SECRET = 'the token hunter2 is logged'

type Seen = { gh: string[]; records: unknown[] }

// A checkout of LounisBou/claude-review on a branch whose pull request is 12, and the github tools.
function wire(on: TestOn): Seen {
  const seen: Seen = { gh: [], records: [] }
  on('tool.call', { tool: 'Agent' }, (_$, e) => ({ result: e['answer'] }))
  on('tool.list', () => ({ value: [{ name: 'mcp__github__gh' }, { name: 'mcp__github__record' }] }))
  on('classic.Stop', () => ({}))
  on('process.run', (_$, e) => {
    const line = e.argv.join(' ')
    if (line === 'git rev-parse --show-toplevel') return { value: { ...ok, stdout: '/clone/repo\n' } }
    if (line === 'git remote get-url origin') return { value: { ...ok, stdout: 'git@github.com:LounisBou/claude-review.git\n' } }
    if (line === 'git rev-parse --abbrev-ref HEAD') return { value: { ...ok, stdout: 'feature\n' } }
    if (line === 'git rev-parse HEAD') return { value: { ...ok, stdout: HEAD + '\n' } }
    return { value: ok }
  })
  on('tool.call', { tool: 'mcp__github__gh' }, (_$, e) => {
    seen.gh.push(String(e['command']))
    return { result: '12\n' }
  })
  on('tool.call', { tool: 'mcp__github__record' }, (_$, e) => {
    seen.records.push(e['result'])
    return { result: '/data/records/review.json' }
  })
  return seen
}

const loopCall = ($: Engine, args: Record<string, unknown>): Promise<Reply> => $.tool.call({ tool: 'mcp__pr-review__loop', ...args })

const review = ($: Engine, findings: { severity: string; file: string }[]): Promise<Reply> =>
  $.tool.call({
    tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review the diff' + REPORT_REQUEST,
    answer: 'The review.\n```json\n' + JSON.stringify({ findings: findings.map((f) => ({ ...f, summary: SECRET })) }) + '\n```\n',
  })

const FOUND = [
  { severity: 'critical', file: 'src/a.ts' },
  { severity: 'important', file: '/clone/repo/tests/a.test.ts:12' },
  { severity: 'suggestion', file: 'docs/a.md' },
]

async function pass($: Engine, findings: { severity: string; file: string }[], keys: string[]): Promise<Reply> {
  await loopCall($, { action: 'begin_pass' })
  await review($, findings)
  return loopCall($, { action: 'findings', keys })
}

test('a pass the loop goes on from leaves its Critical and Important findings, each with its file and the pull request', async ($, on) => {
  const seen = wire(on)
  const journal = watchJournal(on)
  await loopCall($, { action: 'start' })
  const out = await pass($, FOUND, ['a', 'b', 'c'])
  expect(String(out.result)).toContain('"new"')
  const events = journal()
  expect(events.map((e) => parseLearningEvent(e))).toEqual(events)
  expect(events.map((e) => [e.kind, e.trust, e.source.code, e.evidence, e.context.paths])).toEqual([
    ['finding', 'review', 'pr-review.finding', [{ type: 'finding', severity: 'critical', file: 'src/a.ts' }], ['src/a.ts']],
    ['finding', 'review', 'pr-review.finding', [{ type: 'finding', severity: 'important', file: 'tests/a.test.ts' }], ['tests/a.test.ts']],
  ])
  expect(events.map((e) => e.subject)).toEqual([SUBJECT, SUBJECT])
  expect(events.every((e) => e.context.session === 'sess-1')).toBe(true)
  expect(JSON.stringify(events)).not.toMatch(/hunter2|logged|\/clone/)
  // The pull request is asked once per loop: the next pass reads it from what the first one noted.
  expect(seen.gh).toEqual(['pr-get'])
  await pass($, FOUND.slice(0, 1), ['a'])
  expect(seen.gh).toEqual(['pr-get'])
  expect(journal().length).toBe(3)
  // A stop in the middle of the loop leaves no line of its own.
  await $.classic.Stop({ stop_hook_active: false })
  expect(journal().length).toBe(3)
})

test('the pass that ends the loop takes the pull request the record read: no call of its own', async ($, on) => {
  const seen = wire(on)
  const journal = watchJournal(on)
  await loopCall($, { action: 'start', review_only: true })
  const out = await pass($, FOUND, ['a', 'b', 'c'])
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(seen.records).toEqual(['fail'])
  expect(seen.gh).toEqual(['pr-get'])
  expect(journal().map((e) => [e.source.code, e.subject])).toEqual([['pr-review.finding', SUBJECT], ['pr-review.finding', SUBJECT]])
})

test('a pass with no Critical or Important finding writes nothing', async ($, on) => {
  wire(on)
  const journal = watchJournal(on)
  await loopCall($, { action: 'start' })
  await pass($, FOUND.slice(2), ['c'])
  expect(journal()).toEqual([])
})

test('a finding whose file is no path of the repository is kept, without its path', async ($, on) => {
  wire(on)
  const journal = watchJournal(on)
  await loopCall($, { action: 'start' })
  await pass($, [{ severity: 'critical', file: 'the whole diff' }, { severity: 'important', file: '/elsewhere/b.ts' }], ['a', 'b'])
  expect(journal().map((e) => [e.evidence, e.context.paths])).toEqual([[[], []], [[], []]])
})

test('a journal that cannot be written changes nothing of the loop: its answer, its record, one line in the log', async ($, on) => {
  const seen = wire(on)
  const logged: string[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/op' : undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', () => ({ deny: 'disk full' }))
  on('ui.log', (_$, e) => { logged.push(String(e.text)); return { value: undefined } })
  await loopCall($, { action: 'start', review_only: true })
  const out = await pass($, FOUND, ['a', 'b', 'c'])
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(String(out.result)).toContain('record: /data/records/review.json')
  expect(seen.records).toEqual(['fail'])
  expect(logged.length).toBe(1)
  expect(logged[0]).toContain('pr-review: the journal could not be written or pruned')
  expect(logged[0]).toContain('disk full')
})
