import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cutAt, reportPathOf, shorten, VERDICT_LIMIT, verdictLine } from './verdict.ts'

const PATH = '/Users/x/.claude/claude-orchestrator/briefs/demo/report-p3.md'

describe('the verdict line', () => {
  it('names the pull request by its repository, the head by seven characters, the blocking and the report', () => {
    const line = verdictLine({ repo: 'owner/claude-plugins', pr: 12, head: 'abcdef0123456789', verdict: 'review pass (clean)', blocking: [], report: PATH })
    assert.equal(line, `claude-plugins#12 abcdef0 — review pass (clean) — blocking: none — report: ${PATH}`)
    const failed = verdictLine({ repo: 'claude-plugins', pr: 3, head: 'abc', verdict: 'norms fail', blocking: ['a.ts:4', 'b.ts'], report: null })
    assert.equal(failed, 'claude-plugins#3 abc — norms fail — blocking: a.ts:4, b.ts — report: none')
  })

  it('stays under the limit with a long absolute report path', () => {
    const line = verdictLine({ repo: 'claude-plugins', pr: 1234, head: 'a'.repeat(40), verdict: 'gate green — fix reverted → tests fall: verified', blocking: [], report: PATH })
    assert.ok(line.length < VERDICT_LIMIT)
  })
})

describe('the report path', () => {
  it('is the absolute path after the last « report: »', () => {
    assert.equal(reportPathOf(`x — report: /a/first.md\ny — report: ${PATH}`), PATH)
    assert.equal(reportPathOf(`report: \`${PATH}\`.`), PATH)
    assert.equal(reportPathOf(`(report: ${PATH})`), PATH)
  })

  it('is none for a relative path, no path, or the word alone', () => {
    assert.equal(reportPathOf('report: docs/report.md'), null)
    assert.equal(reportPathOf('report: none'), null)
    assert.equal(reportPathOf('the report is long'), null)
  })
})

describe('a message held to the limit', () => {
  it('is whole at or under the limit', () => {
    const text = 'x'.repeat(VERDICT_LIMIT)
    assert.deepEqual(shorten(text), { kind: 'whole', text })
  })

  it('is cut at the limit with its pointer when it names its report', () => {
    const text = `${'y'.repeat(VERDICT_LIMIT + 50)} report: ${PATH}`
    const short = shorten(text)
    assert.equal(short.kind, 'cut')
    assert.equal(short.kind === 'cut' && short.path, PATH)
    assert.equal(short.kind === 'cut' && short.text, `${'y'.repeat(VERDICT_LIMIT)} … (cut: full report at ${PATH})`)
  })

  it('names no file: unnamed, with its length', () => {
    assert.deepEqual(shorten('z'.repeat(VERDICT_LIMIT + 1)), { kind: 'unnamed', length: VERDICT_LIMIT + 1 })
  })

  it('a cut with no file says so', () => {
    assert.equal(cutAt('abcdef', 3, null), 'abc … (cut at 3 of 6 characters: no report file named)')
  })
})
