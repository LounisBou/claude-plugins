import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { isHeld, report, rulesOf, run } from './rules.ts'

describe('unenforced rules', () => {
  it('reads an imperative line as a rule, fenced or not, with its terms in backticks', () => {
    const rules = rulesOf('SKILL.md', 'Intro.\n- **Never** run `git push --force`.\n```\nNEVER touch `ROADMAP.md`\n```\nThe rest.')
    assert.deepEqual(rules.map(r => [r.line, r.terms]), [[2, ['git push --force']], [4, ['ROADMAP.md']]])
    assert.deepEqual(rulesOf('x.md', 'Nevertheless, a line.'), [])
  })

  it('holds a rule whose term the corpus names, never one that names no term', () => {
    const [named, bare] = rulesOf('x.md', 'Never run `rm -rf`.\nNever guess.')
    assert.equal(isHeld(named!, 'if (cmd === "rm -rf") deny()'), true)
    assert.equal(isHeld(named!, 'nothing here'), false)
    assert.equal(isHeld(bare!, 'Never guess.'), false)
  })

  it('reports each plugin: held by code, named by an eval, left to prose', () => {
    const root = mkdtempSync(join(tmpdir(), 'rules-'))
    const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
    put('plugins/p/skills/s/SKILL.md', 'Never run `rm -rf`.\nAlways keep `CHANGELOG`.\nOnly ask once.')
    put('plugins/p/hooks/guard.ts', "const NO = 'rm -rf'")
    put('plugins/p/evals/e.json', '{"expect": "CHANGELOG"}')
    assert.deepEqual(report(root).map(r => [r.plugin, r.rules, r.byCode, r.byEval, r.left.length]), [['p', 3, 1, 1, 1]])
    const out: string[] = []
    assert.equal(run(root, [], { out: l => { out.push(l) }, err: () => {}, env: {} }), 0)
    assert.equal(out.at(-1), 'plugins/p/skills/s/SKILL.md:3: Only ask once.')
  })
})
