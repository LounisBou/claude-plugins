// hooks/tests/validate.test.ts
// N5: the lexical checks of norms:validate, with exact line numbers, appended
// to the skill's prompt.
import { expect, test } from 'claude-code/testing'
import { lintContributing, register } from '../validate.ts'
import { mount, hook, nextOf, fakeDollar } from './fakes.ts'

const DOC = [
  '# Project norms', //  1
  '', //                  2
  '## [naming]', //       3
  '- Name things properly', // 4
  '- ', //                5
  '* Use full words', //  6
  '', //                  7
  '## [code-hygiene]', // 8
  '', //                  9
  '## [test-conventions]', // 10
  '- Given/When/Then as well as one assert, etc.', // 11
].join('\n')

test('empty bullets, empty sections, vague words, mixed markers and no example are found with their lines', () => {
  const f = lintContributing(DOC)
  const at = (check: number) => f.filter(x => x.check === check).map(x => x.line)
  expect(at(2)).toEqual([5, 8])
  expect(at(3)).toEqual([4, 11, 11])
  expect(f.filter(x => x.check === 3).map(x => x.detail.split('"')[1])).toEqual(['properly', 'well', 'etc.'])
  expect(f.some(x => x.check === 5)).toBe(true)
  expect(f.find(x => x.check === 6)?.detail).toContain('"*" on lines 6')
  expect(f.find(x => x.check === 6 && x.detail.includes('header'))).toBeUndefined()
})

test('words inside code blocks and longer words are not flagged; a code block passes check 5', () => {
  const f = lintContributing(['# N', '## [naming]', '- Use goods_count', '```', 'properly()', '```'].join('\n'))
  expect(f).toEqual([])
})

test('a file with no top-level header is flagged', () => {
  expect(lintContributing('## [naming]\n- x\n```\n```').map(x => x.detail)).toEqual(['No top-level `#` header.'])
})

test('the scan is appended to the skill prompt; no CONTRIBUTING.md leaves it as it was', async () => {
  const hooks = mount(register)
  const h = hook(hooks, 'skill.prompt', { skill: 'norms:validate' })
  const { next } = nextOf(e => ({ text: e.text }))

  const withFile = fakeDollar({ files: { 'CONTRIBUTING.md': DOC } })
  const out = await h.handler(withFile.$, { skill: 'norms:validate', text: 'SKILL' }, next)
  expect(out.text.startsWith('SKILL\n\n<norms-validate-scan>')).toBe(true)
  expect(out.text).toContain('| 2 | ERROR | 5 | [naming] | Empty bullet')
  expect(out.text).toContain('(11 lines)')

  const without = fakeDollar({})
  expect(await h.handler(without.$, { skill: 'norms:validate', text: 'SKILL' }, next)).toEqual({ text: 'SKILL' })
})
