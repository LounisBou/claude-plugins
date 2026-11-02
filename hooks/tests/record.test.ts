// hooks/tests/record.test.ts
// The norms record: mcp__norms__check_done leaves one record through the
// github plugin's record tool, once /norms:check computed its scope.
import { expect, test } from 'claude-code/testing'
import { register as registerCheck, resetCache } from '../check.ts'
import { register as registerRecord, resetMark, repoOf } from '../record.ts'
import { mount, hook, nextOf, fakeDollar, gitRuns, HEAD, type FakeSetup } from './fakes.ts'

const NEW_HEAD = 'c'.repeat(40)
const WRITTEN = '/home/u/.claude/pr-records/o/r/' + HEAD + '/norms.20261102T100000Z.norms.json'

type Github = { pr?: string; record?: any }

function setup(github: Github = {}, runs: FakeSetup['runs'] = {}, calls: any[] = []) {
  return fakeDollar({
    runs: {
      ...gitRuns(['src/a.ts'], ['src/a.ts']),
      'git status --porcelain -uno': { stdout: '' },
      'git remote get-url origin': { stdout: 'git@github.com:Owner/Repo.git\n' },
      ...runs,
    },
    tool: (input: any) => {
      calls.push(input)
      if (input.tool === 'mcp__github__gh') return { result: github.pr ?? '12\n' }
      if (input.tool === 'mcp__github__record') return github.record ?? { result: WRITTEN + '\n' }
      throw new Error('unexpected tool ' + input.tool)
    },
  })
}

function mounted() {
  const hooks = mount(on => {
    registerCheck(on)
    registerRecord(on)
  })
  return {
    scope: (d: any) => hook(hooks, 'command.run', { command: 'norms:check' }).handler(d, { args: '' }, nextOf().next),
    done: (d: any, input: any) => hook(hooks, 'tool.call', { tool: 'mcp__norms__check_done' }).handler(d, input),
    hooks,
  }
}

const recordCalls = (calls: any[]) => calls.filter(c => c.tool === 'mcp__github__record')

test('without a scope computed in this session, the record is refused and nothing is written', async () => {
  resetMark()
  const calls: any[] = []
  const { $ } = setup({}, {}, calls)
  const out = await mounted().done($, { open: 0, fixed: 1, passed: 0 })
  expect(out.result).toContain('norms: run /norms:check first: the record follows its own scope')
  expect(out.isError).toBe(true)
  expect(calls).toEqual([])
})

test('no open finding records a pass with its detail', async () => {
  resetMark(); resetCache()
  const calls: any[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 3, passed: 2 })
  expect(out.result).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls)).toEqual([
    { tool: 'mcp__github__record', pr: 12, repo: 'Owner/Repo', kind: 'norms', result: 'pass', detail: '3 fixed, 2 passed, 0 open' },
  ])
})

test('open findings record a fail', async () => {
  resetMark(); resetCache()
  const calls: any[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 2, fixed: 1, passed: 0 })
  expect(out.result).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls)[0].result).toBe('fail')
  expect(recordCalls(calls)[0].detail).toBe('1 fixed, 0 passed, 2 open')
})

test('the pull request is read through the github tool', async () => {
  resetMark(); resetCache()
  const calls: any[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(calls[0]).toEqual({ tool: 'mcp__github__gh', command: 'pr-get', args: { format: 'pr-number' } })
})

test('a branch with no pull request leaves no record', async () => {
  resetMark(); resetCache()
  const calls: any[] = []
  const { $ } = setup({ pr: '\n' }, {}, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(out.result).toBe('record: none — the branch has no pull request')
  expect(recordCalls(calls)).toEqual([])
})

test('a dirty tree leaves no record, and is checked before the pull request is read', async () => {
  resetMark(); resetCache()
  const calls: any[] = []
  const { $ } = setup({}, { 'git status --porcelain -uno': { stdout: ' M src/a.ts\n' } }, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(out.result).toBe('record: none — the tracked files have changes')
  expect(calls).toEqual([])
})

test('the github tool refusing is reported with its own text', async () => {
  resetMark(); resetCache()
  const { $ } = setup({ record: { deny: 'github: the checkout is at aaaaaaa, the pull request\'s head is bbbbbbb: a record is written at the head it read.' } })
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(out.result).toBe('record: none — github: the checkout is at aaaaaaa, the pull request\'s head is bbbbbbb: a record is written at the head it read.')
})

test('an error of the github tool is reported with its own text', async () => {
  resetMark(); resetCache()
  const { $ } = setup({ record: { result: 'record.py exited 2', isError: true } })
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(out.result).toBe('record: none — record.py exited 2')
})

test('a github plugin that is absent or older than 0.12.0 leaves no record and throws nothing', async () => {
  resetMark(); resetCache()
  const { $ } = fakeDollar({
    runs: {
      ...gitRuns(['src/a.ts'], ['src/a.ts']),
      'git status --porcelain -uno': { stdout: '' },
      'git remote get-url origin': { stdout: 'https://github.com/o/r.git\n' },
    },
    tool: (input: any) => {
      if (input.tool === 'mcp__github__gh') return { result: '12' }
      throw new Error('unknown tool ' + input.tool)
    },
  })
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(out.result).toContain('record: none — the github plugin is absent or older than 0.12.0')
})

test('an unreadable remote leaves no record', async () => {
  resetMark(); resetCache()
  const calls: any[] = []
  const { $ } = setup({}, { 'git remote get-url origin': { exitCode: 2, stderr: 'no such remote' } }, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(out.result).toMatch(/^record: none — /)
  expect(recordCalls(calls)).toEqual([])
})

test('the head is read at the call: a commit made after the scope does not refuse the record', async () => {
  resetMark(); resetCache()
  const calls: any[] = []
  const { $, argvs } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  const afterScope = argvs.filter(a => a === 'git rev-parse HEAD').length
  // The fix commit of check.md 7.4 lands between the scope and the record.
  ;($ as any).process.run = async (argv: readonly string[]) => {
    const key = argv.join(' ')
    argvs.push(key)
    if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: NEW_HEAD + '\n', stderr: '' }
    if (key === 'git status --porcelain -uno') return { exitCode: 0, stdout: '', stderr: '' }
    if (key === 'git remote get-url origin') return { exitCode: 0, stdout: 'https://github.com/o/r.git\n', stderr: '' }
    return { exitCode: 1, stdout: '', stderr: 'unexpected run: ' + key }
  }
  const out = await m.done($, { open: 0, fixed: 1, passed: 0 })
  expect(argvs.filter(a => a === 'git rev-parse HEAD').length).toBe(afterScope + 1)
  expect(out.result).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls).length).toBe(1)
})

test('counts that are not whole numbers are refused', async () => {
  resetMark(); resetCache()
  const calls: any[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: -1, fixed: 'x', passed: 0 })
  expect(out.isError).toBe(true)
  expect(calls).toEqual([])
})

test('the remote url gives owner and name for ssh, https and ssh:// forms', () => {
  expect(repoOf('git@github.com:Owner/Repo.git')).toBe('Owner/Repo')
  expect(repoOf('https://github.com/Owner/Repo.git')).toBe('Owner/Repo')
  expect(repoOf('https://github.com/Owner/Repo')).toBe('Owner/Repo')
  expect(repoOf('ssh://git@github.com/Owner/Repo.git')).toBe('Owner/Repo')
  expect(repoOf('/local/path')).toBeUndefined()
})

test('session.start lists the tool from the start, and a registration that fails passes the event on', async () => {
  const registered: any[] = []
  const { $ } = fakeDollar({})
  ;($ as any).tool.register = async (spec: any) => { registered.push(spec) }
  const m = mounted()
  const start = hook(m.hooks, 'session.start')
  const { next, seen } = nextOf()
  await start.handler($, { cwd: '/work' }, next)
  const spec = registered.find(s => s.name === 'check_done')
  expect(spec.isDeferred).toBe(false)
  expect(spec.inputSchema.required).toEqual(['open', 'fixed', 'passed'])
  expect(seen.length).toBe(1)

  ;($ as any).tool.register = async () => { throw new Error('refused') }
  const second = nextOf()
  await start.handler($, { cwd: '/work' }, second.next)
  expect(second.seen.length).toBe(1)
})
