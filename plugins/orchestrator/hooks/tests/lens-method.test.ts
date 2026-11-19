// hooks/tests/lens-method.test.ts
// A lens's method: the angles that have a pr-review-toolkit agent read with its prompt, found
// through the host's install record; every other angle, and a machine without the agent, is generic.
import { expect, test } from 'claude-code/testing'
import { agentPaths, agentPrompt, lensMethod, methodAgent, methodWords, withMethod } from '../lens-method.ts'

const RECORD = JSON.stringify({ version: 2, plugins: { 'pr-review-toolkit@official': [{ installPath: '/a' }, { installPath: '/b' }], 'pr-review-toolkit@other': [{ installPath: '/c' }], 'pr-review@other': [{ installPath: '/d' }] } })

test('each toolkit angle has its agent, by the lens\'s dashed name; the others have none', () => {
  expect(methodAgent('correctness')).toBe('code-reviewer')
  expect(methodAgent('silent failures')).toBe('silent-failure-hunter')
  expect(methodAgent('Tests')).toBe('pr-test-analyzer')
  expect(methodAgent('types')).toBe('type-design-analyzer')
  expect(methodAgent('comments')).toBe('comment-analyzer')
  for (const lens of ['security', 'spec conformity', '', '!!']) expect(methodAgent(lens)).toBe(undefined)
})

test('the agent\'s prompt is read from the toolkit\'s installs, any marketplace, in the record\'s order', () => {
  expect(agentPaths(RECORD, 'code-reviewer')).toEqual(['/a/agents/code-reviewer.md', '/b/agents/code-reviewer.md', '/c/agents/code-reviewer.md'])
  expect(agentPaths('null', 'code-reviewer')).toEqual([])
  expect(agentPaths(undefined, 'code-reviewer')).toEqual([])
  expect(agentPaths('{', 'code-reviewer')).toEqual([])
  const read = (path: string) => (path === '/b/agents/pr-test-analyzer.md' ? '---\nname: x\n---\n\nAnalyze the tests.\n' : undefined)
  expect(lensMethod('tests', RECORD, read)).toEqual({ kind: 'toolkit', agent: 'pr-test-analyzer', prompt: 'Analyze the tests.' })
  expect(lensMethod('correctness', RECORD, read)).toEqual({ kind: 'generic', missing: 'code-reviewer' })
  expect(lensMethod('security', RECORD, read)).toEqual({ kind: 'generic' })
})

test('a file with no frontmatter is its prompt whole; one with only frontmatter has none', () => {
  expect(agentPrompt('Read it.\n')).toBe('Read it.')
  expect(agentPrompt('---\nname: x\n---\n')).toBe('')
})

test('the words the brief says, and a generic method leaving the prompt as it came', () => {
  expect(methodWords('tests', { kind: 'toolkit', agent: 'pr-test-analyzer', prompt: 'p' })).toBe('tests: pr-review-toolkit pr-test-analyzer')
  expect(methodWords('security', { kind: 'generic' })).toBe('security: generic')
  expect(methodWords('correctness', { kind: 'generic', missing: 'code-reviewer' })).toBe('correctness: generic, pr-review-toolkit code-reviewer not found')
  expect(withMethod('read', { kind: 'generic', missing: 'code-reviewer' })).toBe('read')
})
