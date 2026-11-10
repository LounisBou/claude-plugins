// hooks/tests/check.test.ts
// N1 (the <norms-scope> block appended to /norms:check's arguments) and N2
// (the <norms-context> block appended to each norms agent's prompt).
import { expect, test } from 'claude-code/testing'
import { classify, parseCheckArgs, applicable, classifyAll, contributingExcerpt, fenceFor, projectTypes } from '../scope.ts'
import { pullRequestBase, register, resetCache } from '../check.ts'
import { mount, hook, nextOf, fakeDollar, gitRuns, BASE, HEAD } from './fakes.ts'

test('files are classified by check.md Step 2', () => {
  expect(classify('src/auth.ts')).toBe('source')
  expect(classify('src/auth.test.ts')).toBe('test')
  expect(classify('pkg/auth_test.go')).toBe('test')
  expect(classify('tests/run-tests.sh')).toBe('test')
  expect(classify('app/test/helper.rb')).toBe('test')
  expect(classify('config/app.yml')).toBe('config')
  expect(classify('.env.local')).toBe('config')
  expect(classify('.gitignore')).toBe('config')
  expect(classify('README.md')).toBe('other')
  expect(classify('LICENSE')).toBe('other')
})

test('the project type comes from the root indicator files', () => {
  expect(projectTypes(['package.json', 'src'])).toEqual(['JavaScript/TypeScript'])
  expect(projectTypes(['pyproject.toml', 'requirements.txt'])).toEqual(['Python'])
  expect(projectTypes(['App.sln'])).toEqual(['C#/.NET'])
  expect(projectTypes(['README.md'])).toEqual([])
})

test('a word list of shortcuts selects agents; a sentence leaves them to the model', () => {
  expect(parseCheckArgs('naming tests')).toEqual({ base: undefined, agents: ['norms-variable-naming', 'norms-test-structure'], paths: [] })
  expect(parseCheckArgs('')).toEqual({ base: undefined, agents: 'all', paths: [] })
  expect(parseCheckArgs('all base=develop')).toEqual({ base: 'develop', agents: 'all', paths: [] })
  expect(parseCheckArgs('use also ../project1/src as pattern reference')).toEqual({ base: undefined, agents: 'free-text', paths: ['../project1/src'] })
  expect(parseCheckArgs('check patterns against ~/dev/api/src')).toEqual({ base: undefined, agents: 'all', paths: ['~/dev/api/src'] })
})

test('a config-only change runs the diff-scope agent alone, plus coverage where tests exist', () => {
  const r = applicable(classifyAll(['app.json']), true)
  expect(r.run).toEqual(['norms-diff-scope', 'norms-test-coverage'])
  expect(r.skipped.map(([a]) => a)).toContain('norms-variable-naming')
})

test('a fence outgrows every backtick run in the text', () => {
  expect(fenceFor('no ticks')).toBe('```')
  expect(fenceFor('a ```` b')).toBe('`````')
})

const CONTRIBUTING = [
  '# Norms', '', '## [naming]', '### Full words', '- no usr', '',
  '## [code-hygiene]', '- no magic', '', '## [type-strictness]', '- readonly', '',
  '## [test-conventions]', '- given when then', '',
].join('\n')

test('each agent gets only the CONTRIBUTING.md sections its instructions name', () => {
  expect(contributingExcerpt('norms-variable-naming', CONTRIBUTING).headings).toEqual(['[naming]'])
  expect(contributingExcerpt('norms-test-structure', CONTRIBUTING).text).toContain('given when then')
  expect(contributingExcerpt('norms-pattern-conformity', CONTRIBUTING).headings).toEqual(['[type-strictness]'])
  expect(contributingExcerpt('norms-diff-scope', CONTRIBUTING).text).toContain('no magic')
})

test('/norms:check gets the precomputed scope appended, with the resolver\'s base', async () => {
  resetCache()
  const hooks = mount(register)
  const { $, argvs } = fakeDollar({
    runs: gitRuns(['src/auth.ts', 'src/auth.test.ts', 'package.json'], ['src/auth.ts', 'src/auth.test.ts'], {}, 'develop'),
    files: { 'CONTRIBUTING.md': '' },
    dirs: { '.': ['package.json', 'src', 'CONTRIBUTING.md'], '../lib': [] },
  })
  const { next, seen } = nextOf()
  await hook(hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: 'base=develop use ../lib and ../gone as pattern reference' }, next)
  const args: string = seen[0].args
  expect(args.startsWith('base=develop use ../lib and ../gone as pattern reference\n\n<norms-scope>')).toBe(true)
  expect(args).toContain(`base: ${BASE} (from base=develop)`)
  expect(args).toContain('project type: JavaScript/TypeScript')
  expect(args).toContain('project norms: CONTRIBUTING.md found')
  expect(args).toContain('  source: src/auth.ts')
  expect(args).toContain('  test: src/auth.test.ts')
  expect(args).toContain('  config: package.json')
  expect(args).toContain('requested agents: named inside free text')
  expect(args).toContain('external references (validated): ../lib')
  expect(args).toContain('external references not found (tell the user): ../gone')
  expect(argvs).toContain('bash /plugin/scripts/resolve_base.sh develop')
})

test('a scope that cannot be computed passes the command on unchanged', async () => {
  resetCache()
  const hooks = mount(register)
  const { $ } = fakeDollar({ runs: { 'bash /plugin/scripts/resolve_base.sh': { exitCode: 1, stderr: 'error: base branch' } } })
  const h = hook(hooks, 'command.run', { command: 'norms:check' })
  const e = { command: 'norms:check', args: 'naming' }
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

test('a norms agent gets the diff of its own files and its own sections at spawn', async () => {
  resetCache()
  const hooks = mount(register)
  const { $ } = fakeDollar({
    runs: gitRuns(['src/auth.ts', 'tests/auth.test.ts'], ['tests/auth.test.ts'], { 'src/auth.ts': '+const usr = 1\n' }),
    files: { 'CONTRIBUTING.md': CONTRIBUTING },
    dirs: { '.': [] },
  })
  const { next, seen } = nextOf()
  await hook(hooks, 'agent.spawn').handler($, { subagentType: 'norms:norms-variable-naming', prompt: 'Check naming.', fork: false }, next)
  const prompt: string = seen[0].prompt
  expect(prompt.startsWith('Check naming.\n\n<norms-context>')).toBe(true)
  expect(prompt).toContain(`base: ${BASE}`)
  expect(prompt).toContain(`head: ${HEAD}`)
  expect(prompt).toContain('files for this agent: src/auth.ts')
  expect(prompt).toContain('+const usr = 1')
  expect(prompt).toContain('### Full words')
  expect(prompt.includes('no magic')).toBe(false)
})

test('another plugin\'s agent is left alone', async () => {
  resetCache()
  const hooks = mount(register)
  const { $, argvs } = fakeDollar({})
  const { next, seen } = nextOf()
  const e = { subagentType: 'general-purpose', prompt: 'x', fork: false }
  await hook(hooks, 'agent.spawn').handler($, e, next)
  expect(seen).toEqual([e])
  expect(argvs).toEqual([])
})

test('a diff past the inline limit goes to a file under the git dir', async () => {
  resetCache()
  const hooks = mount(register)
  const big = '+x\n'.repeat(20_000)
  const { $, written } = fakeDollar({
    runs: gitRuns(['src/a.ts'], [], { 'src/a.ts': big }),
    dirs: { '.': [] },
  })
  const { next, seen } = nextOf()
  await hook(hooks, 'agent.spawn').handler($, { subagentType: 'norms:norms-diff-scope', prompt: 'p', fork: false }, next)
  const path = `/repo/.git/norms/${HEAD.slice(0, 12)}-norms-diff-scope.diff`
  expect(written[path]).toBe(big)
  expect(seen[0].prompt).toContain(`read it from ${path}`)
  expect(seen[0].prompt).toContain('CONTRIBUTING.md: absent')
  expect(seen[0].prompt.includes('+x\n+x')).toBe(false)
})

test('agents spawned after /norms:check reuse its base instead of resolving again', async () => {
  resetCache()
  const hooks = mount(register)
  const { $, argvs } = fakeDollar({
    runs: gitRuns(['src/a.ts'], [], { 'src/a.ts': '+a\n' }, 'develop'),
    dirs: { '.': [] },
  })
  await hook(hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: 'base=develop' }, nextOf().next)
  const { next, seen } = nextOf()
  await hook(hooks, 'agent.spawn').handler($, { subagentType: 'norms:norms-magic-values', prompt: 'p', fork: false }, next)
  expect(argvs.filter(a => a.includes('resolve_base.sh')).length).toBe(1)
  expect(seen[0].prompt).toContain('+a')
})

test('mode=auto in the arguments selects the automatic mode', () => {
  expect(parseCheckArgs('mode=auto').auto).toBe(true)
  expect(parseCheckArgs('naming mode=auto base=develop')).toEqual({ base: 'develop', agents: ['norms-variable-naming'], paths: [], auto: true })
  expect(parseCheckArgs('base=develop').auto).toBeFalsy()
  expect(parseCheckArgs('mode=interactive').auto).toBeFalsy()
})

async function scopeArgs(args: string, env: Record<string, string> = {}): Promise<string> {
  resetCache()
  const hooks = mount(register)
  const { $ } = fakeDollar({
    runs: gitRuns(['src/auth.ts'], ['src/auth.ts'], {}, 'develop'),
    dirs: { '.': ['package.json'] },
    env,
  })
  const { next, seen } = nextOf()
  await hook(hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: `base=develop ${args}` }, next)
  return seen[0].args
}

test('a non-empty launcher variable runs the check in automatic mode', async () => {
  expect(await scopeArgs('', { ORCHESTRATOR_SPAWNED: '1' })).toContain('mode: automatic')
})

test('mode=auto runs the check in automatic mode without the launcher variable', async () => {
  expect(await scopeArgs('mode=auto')).toContain('mode: automatic')
})

test('neither the argument nor a non-empty launcher variable leaves the check interactive', async () => {
  expect(await scopeArgs('')).not.toContain('mode:')
  expect(await scopeArgs('', { ORCHESTRATOR_SPAWNED: '' })).not.toContain('mode:')
})

test('the pull request\'s base is read through the github tool, and anything unreadable is no base', async () => {
  const ask = (answer: any) => pullRequestBase({ tool: { call: async () => answer } })
  expect(await ask({ result: JSON.stringify([{ base: { ref: 'parent' } }]) })).toBe('parent')
  expect(await ask({ result: '[]' })).toBe(undefined)
  expect(await ask({ deny: 'no github' })).toBe(undefined)
  expect(await ask({ result: 'not json' })).toBe(undefined)
  expect(await ask({ result: JSON.stringify([{ base: { ref: 'x; rm -rf /' } }]) })).toBe(undefined)
  expect(await pullRequestBase({ tool: { call: async () => { throw new Error('absent') } } })).toBe(undefined)
})

// A detached checkout (a review session pinned at the head) has no branch for pr-get to ask about.
const PR_HEAD = HEAD
const pulls = (...rows: [string, string][]) => JSON.stringify(rows.map(([sha, ref]) => ({ head: { sha }, base: { ref } })))

test('on a detached head the base comes from the open pull request whose head is HEAD', async () => {
  const calls: any[] = []
  const $ = { tool: { call: async (input: any) => { calls.push(input); return { result: pulls(['c'.repeat(40), 'main'], [PR_HEAD, 'home']) } } } }
  expect(await pullRequestBase($, PR_HEAD)).toBe('home')
  expect(calls).toEqual([{ tool: 'mcp__github__gh', command: 'pr-list', args: {} }])
  expect(await pullRequestBase($, 'd'.repeat(40))).toBe(undefined)
  expect(await pullRequestBase({ tool: { call: async () => ({ deny: 'no github' }) } }, PR_HEAD)).toBe(undefined)
})

async function detachedCheck(args: string, tool: (input: any) => any) {
  resetCache()
  const hooks = mount(register)
  const { $, argvs, toolCalls } = fakeDollar({
    runs: {
      ...gitRuns(['src/auth.ts'], ['src/auth.ts'], {}, 'home'),
      'git rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n' },
    },
    dirs: { '.': ['package.json'] },
    tool,
  })
  const { next, seen } = nextOf()
  const run = hook(hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args }, next)
  return { run, seen, argvs, toolCalls }
}

test('/norms:check on a detached head resolves the base of the pull request at HEAD', async () => {
  const { run, seen, argvs, toolCalls } = await detachedCheck('', () => ({ result: pulls([PR_HEAD, 'home']) }))
  await run
  expect(seen[0].args).toContain(`base: ${BASE} (from base=home)`)
  expect(argvs).toContain('bash /plugin/scripts/resolve_base.sh home')
  expect(toolCalls.map(c => c.command)).toEqual(['pr-list'])
})

test('/norms:check on a detached head with no pull request at HEAD refuses instead of taking the default branch', async () => {
  const { run, seen, argvs } = await detachedCheck('', () => ({ result: pulls(['c'.repeat(40), 'main']) }))
  const refusal = await run.then(() => '', (e: Error) => e.message)
  expect(refusal).toContain('detached HEAD')
  expect(refusal).toContain('base=<branch>')
  expect(seen).toEqual([])
  expect(argvs.filter(a => a.includes('resolve_base.sh'))).toEqual([])
})

test('/norms:check on a detached head with an explicit base asks the github tool nothing', async () => {
  const { run, seen, toolCalls } = await detachedCheck('base=home', () => { throw new Error('asked') })
  await run
  expect(seen[0].args).toContain(`base: ${BASE} (from base=home)`)
  expect(toolCalls).toEqual([])
})

test('/norms:check on a branch still asks the current branch\'s pull request, whatever the pull request list holds', async () => {
  resetCache()
  const hooks = mount(register)
  const { $, toolCalls } = fakeDollar({
    runs: gitRuns(['src/auth.ts'], ['src/auth.ts'], {}, 'develop'),
    dirs: { '.': ['package.json'] },
    tool: () => ({ result: JSON.stringify([{ base: { ref: 'develop' } }]) }),
  })
  const { next, seen } = nextOf()
  await hook(hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: '' }, next)
  expect(seen[0].args).toContain('base: ' + BASE + ' (from base=develop)')
  expect(toolCalls).toEqual([{ tool: 'mcp__github__gh', command: 'pr-get', args: {} }])
})
