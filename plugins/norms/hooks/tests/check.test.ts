// hooks/tests/check.test.ts
// N1 (the <norms-scope> block appended to /norms:check's arguments) and N2
// (the <norms-context> block appended to each norms agent's prompt).
import { expect, test } from 'claude-code/testing'
import { classify, parseCheckArgs, applicable, classifyAll, contributingExcerpt, fenceFor, projectTypes } from '../scope.ts'
import { baseOf, register, resetCache } from '../check.ts'
import { branchPull, openPullAt } from '../record.ts'
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

// The github tool as `call` answers it, for a lookup in Owner/Repo.
const tool = (call: (input: any) => any) => ({ tool: { call: async (input: any) => call(input) } })

test('the pull request\'s base is read through the github tool, and anything unreadable is said, never taken for no pull request', async () => {
  const ask = async (answer: any) => baseOf(await branchPull(tool(() => answer), 'Owner/Repo', 'feature'))
  expect(await ask({ result: JSON.stringify([{ base: { ref: 'parent' } }]) })).toEqual({ base: 'parent' })
  expect(await ask({ result: '[]' })).toEqual({})
  expect(await ask({ deny: 'no github' })).toEqual({ why: 'no github' })
  expect(await ask({ result: 'gh.py exited 1', isError: true })).toEqual({ why: 'gh.py exited 1' })
  expect(await ask({ result: 'not json' })).toEqual({ why: 'the github plugin\'s pr-get answer is not a list of pull requests' })
  expect(await ask({ result: JSON.stringify([{ base: { ref: 'x; rm -rf /' } }]) })).toEqual({ why: 'the pull request\'s base is not a branch name' })
  expect(baseOf(await branchPull(tool(() => { throw new Error('absent') }), 'Owner/Repo', 'feature'))).toEqual({ why: 'the github plugin is absent or older than 0.12.0' })
})

// A detached checkout (a review session pinned at the head) has no branch for pr-get to ask about.
const PR_HEAD = HEAD
const pulls = (...rows: [string, string, number?][]) => JSON.stringify(rows.map(([sha, ref, number]) => ({ number, head: { sha }, base: { ref } })))

test('on a detached head the base comes from the open pull request whose head is HEAD, in the repository named', async () => {
  const calls: any[] = []
  const $ = tool((input: any) => { calls.push(input); return { result: pulls(['c'.repeat(40), 'main'], [PR_HEAD, 'home']) } })
  expect(baseOf(await openPullAt($, 'Owner/Repo', PR_HEAD))).toEqual({ base: 'home' })
  expect(calls).toEqual([{ tool: 'mcp__github__gh', command: 'pr-list', args: {}, repo: 'Owner/Repo' }])
  expect(baseOf(await openPullAt($, 'Owner/Repo', 'd'.repeat(40)))).toEqual({})
  expect(baseOf(await openPullAt(tool(() => ({ deny: 'no github' })), 'Owner/Repo', PR_HEAD))).toEqual({ why: 'no github' })
})

test('several open pull requests with the head are refused, naming them', async () => {
  const $ = tool(() => ({ result: pulls([PR_HEAD, 'main', 3], [PR_HEAD, 'home', 4]) }))
  expect(await openPullAt($, 'Owner/Repo', PR_HEAD)).toEqual({ why: `2 open pull requests have the head ${PR_HEAD.slice(0, 12)}: Owner/Repo#3, Owner/Repo#4` })
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

// The refusal reaches the person as the scope block, so the command does not compute a scope of its own.
const REFUSAL_TAIL = 'Run no step of the check: print the refused line to the user as it is, and stop.\n</norms-scope>'

test('/norms:check on a detached head with no pull request at HEAD refuses instead of taking the default branch', async () => {
  const { run, seen, argvs } = await detachedCheck('naming', () => ({ result: pulls(['c'.repeat(40), 'main']) }))
  await run
  expect(seen[0].args).toBe(`naming\n\n<norms-scope>\nrefused: detached HEAD (${HEAD.slice(0, 12)}) and no open pull request has it as its head: pass the base, /norms:check base=<branch>\n${REFUSAL_TAIL}`)
  expect(argvs.filter(a => a.includes('resolve_base.sh'))).toEqual([])
})

test('/norms:check on a detached head that several open pull requests have refuses, naming them', async () => {
  const { run, seen, argvs } = await detachedCheck('', () => ({ result: pulls([PR_HEAD, 'main', 3], [PR_HEAD, 'home', 4]) }))
  await run
  expect(seen[0].args).toContain(`refused: detached HEAD (${HEAD.slice(0, 12)}) and its pull request could not be read (2 open pull requests have the head ${HEAD.slice(0, 12)}: Owner/Repo#3, Owner/Repo#4)`)
  expect(argvs.filter(a => a.includes('resolve_base.sh'))).toEqual([])
})

test('/norms:check on a detached head with an explicit base asks the github tool nothing', async () => {
  const { run, seen, toolCalls } = await detachedCheck('base=home', () => { throw new Error('asked') })
  await run
  expect(seen[0].args).toContain(`base: ${BASE} (from base=home)`)
  expect(toolCalls).toEqual([])
})

async function branchCheck(answer: () => any) {
  resetCache()
  const hooks = mount(register)
  const { $, argvs, toolCalls } = fakeDollar({
    runs: { ...gitRuns(['src/auth.ts'], ['src/auth.ts'], {}, 'develop'), ...gitRuns(['src/auth.ts'], ['src/auth.ts']) },
    dirs: { '.': ['package.json'] },
    tool: answer,
  })
  const { next, seen } = nextOf()
  await hook(hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: '' }, next)
  return { $, args: String(seen[0].args), argvs, toolCalls }
}

test('/norms:check on a branch asks the branch\'s pull request in the repository named, whatever the pull request list holds', async () => {
  const { args, toolCalls } = await branchCheck(() => ({ result: JSON.stringify([{ base: { ref: 'develop' } }]) }))
  expect(args).toContain('base: ' + BASE + ' (from base=develop)')
  expect(toolCalls).toEqual([{ tool: 'mcp__github__gh', command: 'pr-get', args: { branch: 'feature' }, repo: 'Owner/Repo' }])
})

test('/norms:check on a branch whose pull request cannot be read refuses instead of taking the default branch', async () => {
  const { $, args, argvs } = await branchCheck(() => ({ deny: 'github: gh is not signed in' }))
  expect(args).toBe(`<norms-scope>\nrefused: the base of feature's pull request could not be read (github: gh is not signed in): pass the base, /norms:check base=<branch>\n${REFUSAL_TAIL}`)
  expect(argvs.filter(a => a.includes('resolve_base.sh'))).toEqual([])
  // Nothing is marked: the record follows a scope, and none was computed.
  expect(await $.state.get({ plugin: 'norms', key: 'scopeMark' })).toEqual({ value: undefined, version: 0 })
})

test('/norms:check on a branch with no pull request takes the default branch the resolver names', async () => {
  const { args, argvs } = await branchCheck(() => ({ result: '[]' }))
  expect(args).toContain(`base: ${BASE}\n`)
  expect(argvs).toContain('bash /plugin/scripts/resolve_base.sh')
})
