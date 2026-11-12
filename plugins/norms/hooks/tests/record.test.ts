// hooks/tests/record.test.ts
// The norms record: mcp__norms__check_done leaves one record through the
// github plugin's record tool, once /norms:check computed its scope.
import { expect, test } from 'claude-code/testing'
import { register as registerCheck, resetCache, SKILL_MATCHER } from '../check.ts'
import { register as registerRecord, repoOf, asMark } from '../record.ts'
import { register as registerGuards } from '../guards.ts'
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
    // The module's one session.end hook, which clears the mark, is the guards'.
    registerGuards(on)
  })
  return {
    scope: (d: any) => hook(hooks, 'command.run', { command: 'norms:check' }).handler(d, { args: '' }, nextOf().next),
    done: (d: any, input: any) => hook(hooks, 'tool.call', { tool: 'mcp__norms__check_done' }).handler(d, input),
    hooks,
  }
}

const recordCalls = (calls: any[]) => calls.filter(c => c.tool === 'mcp__github__record')

// Every session.end hook of a mount, run as the host runs them: the events each one hands
// to the hook beneath.
const endSession = async (hooks: any[], $: any) => {
  const handed: any[] = []
  for (const h of hooks.filter(h => h.event === 'session.end')) {
    const { next, seen } = nextOf()
    await h.handler($, { reason: 'exit' }, next)
    handed.push(...seen)
  }
  return handed
}

test('without a scope computed in this session, the record is refused and nothing is written', async () => {
  const calls: any[] = []
  const { $ } = setup({}, {}, calls)
  const out = await mounted().done($, { open: 0, fixed: 1, passed: 0 })
  expect(out.result).toContain('norms: run /norms:check first: the record follows its own scope')
  expect(out.isError).toBe(true)
  expect(calls).toEqual([])
})

test('no open finding records a pass with its detail', async () => {
  resetCache()
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
  resetCache()
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
  resetCache()
  const calls: any[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  // The scope's own call, at the command's start, reads the pull request's base.
  expect(calls).toEqual([{ tool: 'mcp__github__gh', command: 'pr-get', args: {} }])
  await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(calls[1]).toEqual({ tool: 'mcp__github__gh', command: 'pr-get', args: { format: 'pr-number' } })
})

test('a branch with no pull request leaves no record', async () => {
  resetCache()
  const calls: any[] = []
  const { $ } = setup({ pr: '\n' }, {}, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(out.result).toBe('record: none — the branch has no pull request')
  expect(recordCalls(calls)).toEqual([])
})

test('a dirty tree leaves no record, and is checked before the pull request is read', async () => {
  resetCache()
  const calls: any[] = []
  const { $ } = setup({}, { 'git status --porcelain -uno': { stdout: ' M src/a.ts\n' } }, calls)
  const m = mounted()
  await m.scope($)
  calls.length = 0
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(out.result).toBe('record: none — the tracked files have changes')
  expect(calls).toEqual([])
})

test('the github tool refusing is reported with its own text', async () => {
  resetCache()
  const { $ } = setup({ record: { deny: 'github: the checkout is at aaaaaaa, the pull request\'s head is bbbbbbb: a record is written at the head it read.' } })
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(out.result).toBe('record: none — github: the checkout is at aaaaaaa, the pull request\'s head is bbbbbbb: a record is written at the head it read.')
})

test('an error of the github tool is reported with its own text', async () => {
  resetCache()
  const { $ } = setup({ record: { result: 'record.py exited 2', isError: true } })
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(out.result).toBe('record: none — record.py exited 2')
})

test('a github plugin that is absent or older than 0.12.0 leaves no record and throws nothing', async () => {
  resetCache()
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
  resetCache()
  const calls: any[] = []
  const { $ } = setup({}, { 'git remote get-url origin': { exitCode: 2, stderr: 'no such remote' } }, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(out.result).toMatch(/^record: none — /)
  expect(recordCalls(calls)).toEqual([])
})

test('the head is read at the call: a commit made after the scope does not refuse the record', async () => {
  resetCache()
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
    if (key === `git diff --name-only ${HEAD} ${NEW_HEAD}`) return { exitCode: 0, stdout: 'src/a.ts\n', stderr: '' }
    return { exitCode: 1, stdout: '', stderr: 'unexpected run: ' + key }
  }
  const out = await m.done($, { open: 0, fixed: 1, passed: 0 })
  expect(argvs.filter(a => a === 'git rev-parse HEAD').length).toBe(afterScope + 1)
  expect(out.result).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls).length).toBe(1)
})

test('a commit after the scope that touches a file the check did not read refuses the record', async () => {
  resetCache()
  const calls: any[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  ;($ as any).process.run = async (argv: readonly string[]) => {
    const key = argv.join(' ')
    if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: NEW_HEAD + '\n', stderr: '' }
    if (key === 'git status --porcelain -uno') return { exitCode: 0, stdout: '', stderr: '' }
    if (key === `git diff --name-only ${HEAD} ${NEW_HEAD}`) return { exitCode: 0, stdout: 'src/a.ts\nsrc/unread.ts\n', stderr: '' }
    return { exitCode: 1, stdout: '', stderr: 'unexpected run: ' + key }
  }
  const out = await m.done($, { open: 0, fixed: 1, passed: 0 })
  expect(out.result).toBe('record: none — commits since the check touch files it did not read (src/unread.ts): run /norms:check again')
  expect(recordCalls(calls)).toEqual([])
})

test('counts that are not whole numbers are refused', async () => {
  resetCache()
  const calls: any[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  calls.length = 0
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

test('a registration that fails is logged with its error, not swallowed', async () => {
  const { $, logs } = fakeDollar({})
  ;($ as any).tool.register = async () => { throw new Error('refused by the host') }
  const { next, seen } = nextOf()
  await hook(mounted().hooks, 'session.start').handler($, { cwd: '/work' }, next)
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('mcp__norms__check_done')
  expect(logs[0]).toContain('refused by the host')
  expect(seen.length).toBe(1)
})

test('an automatic check records that its findings were passed automatically as non-blocking', async () => {
  resetCache()
  const calls: any[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 3, auto: true })
  expect(out.result).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls)).toEqual([
    { tool: 'mcp__github__record', pr: 12, repo: 'Owner/Repo', kind: 'norms', result: 'pass', detail: '0 fixed, 3 passed (non-blocking, automatic), 0 open' },
  ])
})

test('an automatic check with an open ERROR records a fail from open alone', async () => {
  resetCache()
  const calls: any[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  await m.done($, { open: 1, fixed: 0, passed: 5, auto: true })
  expect(recordCalls(calls)[0].result).toBe('fail')
  expect(recordCalls(calls)[0].detail).toBe('0 fixed, 5 passed (non-blocking, automatic), 1 open')
})

test('auto false or absent leaves the interactive record unchanged', async () => {
  resetCache()
  const calls: any[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  await m.done($, { open: 0, fixed: 1, passed: 2, auto: false })
  await m.done($, { open: 0, fixed: 1, passed: 2 })
  expect(recordCalls(calls).map(c => c.detail)).toEqual(['1 fixed, 2 passed, 0 open', '1 fixed, 2 passed, 0 open'])
})

const skillHook = (hooks: any[]) => {
  const found = hooks.find(h => h.event === 'tool.call' && h.matcher === SKILL_MATCHER)
  if (!found) throw new Error('no Skill tool.call hook')
  return found
}

test('a check run through the Skill tool marks its scope, so its record is written', async () => {
  resetCache()
  const calls: any[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  const { next, seen } = nextOf()
  await skillHook(m.hooks).handler($, { tool: 'Skill', skill: 'norms:check', args: 'report only' }, next)
  expect(seen[0].args).toContain('report only\n\n<norms-scope>')
  const out = await m.done($, { open: 0, fixed: 0, passed: 1 })
  expect(out.result).toBe('record: ' + WRITTEN)
})

test('the Skill hook matches the check alone, with or without its slash', () => {
  expect(SKILL_MATCHER.skill.test('norms:check')).toBe(true)
  expect(SKILL_MATCHER.skill.test('/norms:check')).toBe(true)
  expect(SKILL_MATCHER.skill.test('norms:learn')).toBe(false)
  expect(SKILL_MATCHER.skill.test('norms:checkout')).toBe(false)
})

test('a scope that fails on a Skill run passes the call on unchanged and marks nothing', async () => {
  resetCache()
  const calls: any[] = []
  const { $ } = setup({}, { 'git rev-parse HEAD': { exitCode: 128, stderr: 'fatal: not a git repository' } }, calls)
  const m = mounted()
  const h = skillHook(m.hooks)
  const e = { tool: 'Skill', skill: 'norms:check', args: '' }
  const { next, seen } = nextOf()
  await h.handler($, e, next).catch(() => h.net($, e, next))
  expect(seen[seen.length - 1]).toBe(e)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(out.isError).toBe(true)
})

const REFUSED = 'norms: run /norms:check first: the record follows its own scope'

// The git and github answers of a clean checkout at HEAD whose pull request is 12.
const recordRuns = () => ({
  ...gitRuns(['src/a.ts'], ['src/a.ts']),
  'git status --porcelain -uno': { stdout: '' },
  'git remote get-url origin': { stdout: 'git@github.com:Owner/Repo.git\n' },
})
const recordTool = (calls: any[] = []) => (input: any) => {
  calls.push(input)
  return input.tool === 'mcp__github__gh' ? { result: '12\n' } : { result: WRITTEN + '\n' }
}

test('the scope mark lives in $.state, so a module that restarted still records', async () => {
  resetCache()
  const first = setup()
  const m = mounted()
  await skillHook(m.hooks).handler(first.$, { tool: 'Skill', skill: 'norms:check', args: '' }, nextOf().next)
  const kept = first.state.get('norms/scopeMark') as any
  expect(kept.head).toBe(HEAD)
  expect(kept.files).toEqual(['src/a.ts'])

  // After a restart the module remembers nothing: the host's state carries the mark.
  const restarted = fakeDollar({ state: { 'norms/scopeMark': kept }, runs: recordRuns(), tool: recordTool() })
  const out = await mounted().done(restarted.$, { open: 0, fixed: 0, passed: 0 })
  expect(out.result).toBe('record: ' + WRITTEN)
})

test('a value in the state that is not a mark is no mark: check_done refuses', async () => {
  for (const value of [null, 'x', { head: 'main', at: 1, files: [] }, { head: HEAD, at: 1 }, { head: HEAD, at: 1, files: [3] }]) {
    expect(asMark(value)).toBeUndefined()
    const { $ } = fakeDollar({ state: { 'norms/scopeMark': value }, runs: recordRuns(), tool: recordTool() })
    const out = await mounted().done($, { open: 0, fixed: 0, passed: 0 })
    expect(out.result).toBe(REFUSED)
  }
})

test('a state that cannot be set keeps the mark in memory and writes one warn line', async () => {
  resetCache()
  const broken = fakeDollar({ stateFails: 'state is read-only', runs: recordRuns(), tool: recordTool() })
  const m = mounted()
  try {
    const { next, seen } = nextOf()
    await skillHook(m.hooks).handler(broken.$, { tool: 'Skill', skill: 'norms:check', args: '' }, next)
    // The scope block is still delivered.
    expect(seen[0].args).toContain('<norms-scope>')
    expect(broken.logs.length).toBe(1)
    expect(broken.logs[0]).toContain('state is read-only')
    expect((await m.done(broken.$, { open: 0, fixed: 0, passed: 0 })).result).toBe('record: ' + WRITTEN)

    // A later mark kept in the host's state drops the memory copy.
    await m.scope(setup().$)
    expect((await m.done(setup().$, { open: 0, fixed: 0, passed: 0 })).isError).toBe(true)
  } finally {
    // The memory copy of the mark is module state: a failure above must not leave it to the next test.
    await endSession(m.hooks, setup().$)
  }
})

test('at session.end the mark is cleared from the state, so check_done refuses again', async () => {
  resetCache()
  const calls: any[] = []
  const one = setup({}, {}, calls)
  const m = mounted()
  await m.scope(one.$)
  expect(one.state.has('norms/scopeMark')).toBe(true)
  calls.length = 0
  const handed = await endSession(m.hooks, one.$)
  expect(one.state.get('norms/scopeMark')).toBeNull()
  const out = await m.done(one.$, { open: 0, fixed: 0, passed: 0 })
  expect(out.result).toBe(REFUSED)
  expect(out.isError).toBe(true)
  expect(calls).toEqual([])
  // The event goes on to the hook beneath.
  expect(handed.length).toBe(1)
})

test('at session.end the memory copy of the mark is dropped even when the state refuses the clear', async () => {
  resetCache()
  const broken = fakeDollar({ stateFails: 'state is read-only', runs: recordRuns(), tool: recordTool() })
  const m = mounted()
  await skillHook(m.hooks).handler(broken.$, { tool: 'Skill', skill: 'norms:check', args: '' }, nextOf().next)
  // Kept in memory: the state refused it.
  expect(broken.logs.length).toBe(1)
  await endSession(m.hooks, broken.$)
  expect((await m.done(broken.$, { open: 0, fixed: 0, passed: 0 })).result).toBe(REFUSED)
})

test('a ui.log that returns a rejected promise has its rejection caught, and the mark is kept in memory', async () => {
  resetCache()
  const broken = fakeDollar({ stateFails: 'state is read-only', runs: recordRuns(), tool: recordTool() })
  // The promise the line returns, spied on: a catch attaches its handler through then.
  const handlers: unknown[] = []
  const sent = Promise.reject(new Error('the transcript is closed'))
  const attach = sent.then.bind(sent)
  Object.defineProperty(sent, 'then', {
    value: (ok: any, fail: any) => {
      handlers.push(fail)
      return attach(ok, fail)
    },
  })
  ;(broken.$ as any).ui.log = () => sent
  const m = mounted()
  try {
    await skillHook(m.hooks).handler(broken.$, { tool: 'Skill', skill: 'norms:check', args: '' }, nextOf().next)
    // A rejection with no handler is reported by the runtime on a later tick.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handlers.filter(h => typeof h === 'function').length).toBe(1)
    expect((await m.done(broken.$, { open: 0, fixed: 0, passed: 0 })).result).toBe('record: ' + WRITTEN)
  } finally {
    await endSession(m.hooks, setup().$)
  }
})

// ── a review checkout: the session's directory moved out of it, or a detached head ──

// The git answers of setup(), as runs in `dir` rather than in the session's directory.
const runsIn = (dir: string, runs: FakeSetup['runs'] = {}): FakeSetup['runs'] => Object.fromEntries(Object.entries({
  ...gitRuns(['src/a.ts'], ['src/a.ts']),
  'git status --porcelain -uno': { stdout: '' },
  'git remote get-url origin': { stdout: 'git@github.com:Owner/Repo.git\n' },
  'git rev-parse --show-toplevel': { stdout: dir + '\n' },
  ...runs,
}).map(([argv, answer]) => [`(${dir}) ${argv}`, answer]))

test('a check run after a shell cd out of the repository reads the project root\'s, marks its scope and records', async () => {
  resetCache()
  const calls: any[] = []
  const root = '/work/repo'
  const { $ } = fakeDollar({
    runs: runsIn(root),
    root,
    tool: (input: any) => {
      calls.push(input)
      return input.tool === 'mcp__github__gh' ? { result: '12\n' } : { result: WRITTEN + '\n' }
    },
  })
  const m = mounted()
  const { next, seen } = nextOf()
  await skillHook(m.hooks).handler($, { tool: 'Skill', skill: 'norms:check', args: 'report only' }, next)
  expect(seen[0].args).toContain('<norms-scope>')
  expect(seen[0].args).toContain(`head: ${HEAD}`)
  const out = await m.done($, { open: 0, fixed: 0, passed: 1 })
  expect(out.result).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls).map(c => c.pr)).toEqual([12])
})

test('a review checkout on a detached head records at the open pull request whose head it is', async () => {
  resetCache()
  const calls: any[] = []
  const pulls = JSON.stringify([
    { number: 7, head: { sha: NEW_HEAD }, base: { ref: 'main' } },
    { number: 12, head: { sha: HEAD }, base: { ref: 'main' } },
  ])
  const { $ } = fakeDollar({
    runs: {
      ...gitRuns(['src/a.ts'], ['src/a.ts'], {}, 'main'),
      'git rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n' },
      'git status --porcelain -uno': { stdout: '' },
      'git remote get-url origin': { stdout: 'git@github.com:Owner/Repo.git\n' },
    },
    tool: (input: any) => {
      calls.push(input)
      if (input.tool === 'mcp__github__record') return { result: WRITTEN + '\n' }
      // The github plugin asks the branch `HEAD` for its pull request: there is none.
      return { result: input.command === 'pr-list' ? pulls : '' }
    },
  })
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 1 })
  expect(out.result).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls).map(c => c.pr)).toEqual([12])
})

test('a detached head that no open pull request has as its head leaves no record', async () => {
  resetCache()
  const calls: any[] = []
  const { $ } = fakeDollar({
    runs: {
      ...gitRuns(['src/a.ts'], ['src/a.ts'], {}, 'main'),
      'git rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n' },
      'git status --porcelain -uno': { stdout: '' },
      'git remote get-url origin': { stdout: 'git@github.com:Owner/Repo.git\n' },
    },
    tool: (input: any) => {
      calls.push(input)
      return { result: input.command === 'pr-list' ? JSON.stringify([{ number: 7, head: { sha: NEW_HEAD }, base: { ref: 'main' } }]) : '' }
    },
  })
  const m = mounted()
  const { next } = nextOf()
  await m.hooks.find(h => h.event === 'command.run')!.handler($, { args: 'base=main' }, next)
  const out = await m.done($, { open: 0, fixed: 0, passed: 1 })
  expect(out.result).toBe('record: none — the branch has no pull request')
  expect(recordCalls(calls)).toEqual([])
})
