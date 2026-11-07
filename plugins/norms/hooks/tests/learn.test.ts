// hooks/tests/learn.test.ts
// N3: /norms:learn's usage answered with no turn, the resolved threads fetched
// through the github plugin's tool, and the existing rule headings listed.
import { expect, test } from 'claude-code/testing'
import { parsePrNumbers, existingRules, USAGE, MAX_PRS } from '../learn.ts'
import { register } from '../learn.ts'
import { mount, hook, nextOf, fakeDollar } from './fakes.ts'

const matcher = { command: 'norms:learn' }

test('PR numbers are read with or without a hash, once each', () => {
  expect(parsePrNumbers('1383 #1375, 1383')).toEqual([1383, 1375])
  expect(parsePrNumbers('the last one')).toEqual([])
})

test('existing rules are listed per section, code blocks ignored', () => {
  const text = ['## [naming]', '### Full words', '```', '### not a rule', '```', '## [code-hygiene]'].join('\n')
  expect(existingRules(text)).toEqual([['[naming]', ['Full words']], ['[code-hygiene]', []]])
})

test('no PR number answers the usage at once, with no turn', async () => {
  const hooks = mount(register)
  const { $, toolCalls } = fakeDollar({})
  const { next, seen } = nextOf()
  const out = await hook(hooks, 'command.run', matcher).handler($, { command: 'norms:learn', args: '' }, next)
  expect(out).toEqual({ text: USAGE })
  expect(seen).toEqual([])
  expect(toolCalls).toEqual([])
})

test('the resolved threads and existing rules are appended to the arguments', async () => {
  const hooks = mount(register)
  const { $, toolCalls } = fakeDollar({
    files: { 'CONTRIBUTING.md': '## [naming]\n### Full words\n- no usr\n' },
    tool: input => ({ result: '[{"path":"a.ts"},{"path":"b.ts"}]', text: `[{"path":"a.ts","pr":${input.args.pr}},{"path":"b.ts"}]` }),
  })
  const { next, seen } = nextOf()
  await hook(hooks, 'command.run', matcher).handler($, { command: 'norms:learn', args: '12 #13' }, next)
  expect(toolCalls).toEqual([
    { tool: 'mcp__github__gh', command: 'pr-threads', args: { pr: 12, format: 'resolved-threads' } },
    { tool: 'mcp__github__gh', command: 'pr-threads', args: { pr: 13, format: 'resolved-threads' } },
  ])
  const args: string = seen[0].args
  expect(args.startsWith('12 #13\n\n<norms-learn>')).toBe(true)
  expect(args).toContain('Found 4 resolved threads across 2 PRs.')
  expect(args).toContain('## PR #13 (2 resolved threads)')
  expect(args).toContain('"pr":12')
  expect(args).toContain('- [naming]: Full words')
})

test('a refused or failed tool call falls back to the markdown flow', async () => {
  const hooks = mount(register)
  const h = hook(hooks, 'command.run', matcher)
  const { $ } = fakeDollar({ tool: () => ({ deny: 'refused' }) })
  const e = { command: 'norms:learn', args: '12' }
  const { next, seen } = nextOf()
  let failed = false
  try {
    await h.handler($, e, next)
  } catch {
    failed = true
  }
  expect(failed).toBe(true)
  await h.net!($, e, next)
  expect(seen).toEqual([e])
})

test('more PRs than the cap are left to the markdown flow', async () => {
  const hooks = mount(register)
  const { $, toolCalls } = fakeDollar({ tool: () => ({ result: '[]', text: '[]' }) })
  const args = Array.from({ length: MAX_PRS + 1 }, (_, i) => String(i + 1)).join(' ')
  const { next, seen } = nextOf()
  await hook(hooks, 'command.run', matcher).handler($, { command: 'norms:learn', args }, next)
  expect(toolCalls).toEqual([])
  expect(seen[0].args).toBe(args)
})
