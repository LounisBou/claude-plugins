import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { parseScenarios, run, simulate, table } from './context.ts'

describe('context simulator', () => {
  it('reads the scenarios, and refuses one that lists nothing', () => {
    assert.deepEqual(parseScenarios({ scenarios: { a: ['x.md'] } }), { a: ['x.md'] })
    assert.throws(() => parseScenarios({ scenarios: { a: [] } }), /"a" lists no paths/)
    assert.throws(() => parseScenarios({}), /expected/)
  })

  it('sums each scenario in the budgets\' estimate, and names a missing file', () => {
    const files: Record<string, string> = { 'a.md': 'x'.repeat(40), 'b.md': 'y'.repeat(8) }
    const out = simulate({ one: ['a.md', 'b.md'], two: ['a.md', 'gone.md'] }, path => files[path])
    assert.deepEqual(out.tokens, { one: 12, two: 10 })
    assert.deepEqual(out.missing, ['two: gone.md'])
  })

  it('shows the difference against a base, a scenario new there as new', () => {
    assert.deepEqual(table({ a: 12, b: 5, c: 3 }, { a: 10, b: 5 }).slice(2), ['| a | 12 | 10 | +2 |', '| b | 5 | 5 | 0 |', '| c | 3 | — | new |'])
    assert.deepEqual(table({ a: 1 }), ['| scenario | tokens |', '|---|---:|', '| a | 1 |'])
  })

  it('fails on a scenario naming a file that does not exist, and prints the table otherwise', () => {
    const root = mkdtempSync(join(tmpdir(), 'ctx-'))
    const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
    put('plugins/p/SKILL.md', 'z'.repeat(400))
    put('ci/scenarios.json', JSON.stringify({ scenarios: { s: ['p/SKILL.md'] } }))
    const out: string[] = []
    assert.equal(run(root, [], { out: l => { out.push(l) }, err: () => {}, env: {} }), 0)
    assert.deepEqual(out, ['| scenario | tokens |', '|---|---:|', '| s | 100 |'])
    put('ci/scenarios.json', JSON.stringify({ scenarios: { s: ['p/none.md'] } }))
    const err: string[] = []
    assert.equal(run(root, [], { out: () => {}, err: l => { err.push(l) }, env: {} }), 1)
    assert.match(err[0] ?? '', /no such prompt file, s: p\/none\.md/)
  })
})
