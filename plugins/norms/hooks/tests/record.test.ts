// hooks/tests/record.test.ts
// The norms record: mcp__norms__check_done leaves one record through the
// github plugin's record tool, at the head of the repository the check read.
import { expect, test } from 'claude-code/testing'
import { register as registerCheck, resetCache, SKILL_MATCHER } from '../check.ts'
import { register as registerRecord, repoOf, asMark, markedDir, repositoryDir } from '../record.ts'
import { register as registerGuards } from '../guards.ts'
import { REPORT_REQUEST, agentText, reportOf } from '../findings.ts'
import { mount, hook, nextOf, fakeDollar, gitRuns, HEAD, type FakeSetup, type World, type Call, type Hook, hooksOn } from './fakes.ts'
import { fieldsOf, listOf } from '../../core/host.ts'
import { hostOf } from '../../core/capture.ts'

const NEW_HEAD = 'c'.repeat(40)
const WRITTEN = '/home/u/.claude/pr-records/o/r/' + HEAD + '/norms.20261102T100000Z.norms.json'

// The open pull requests the github tool answers: by default 12, of the branch, at HEAD, onto main.
type Github = { pulls?: unknown[]; record?: unknown }
const PR_12 = { number: 12, head: { sha: HEAD }, base: { ref: 'main' } }

// The resolver's answers with the pull request's base passed, and without (a branch with none).
const resolverRuns = (): FakeSetup['runs'] => ({ ...gitRuns(['src/a.ts'], ['src/a.ts']), ...gitRuns(['src/a.ts'], ['src/a.ts'], {}, 'main') })

function setup(github: Github = {}, runs: FakeSetup['runs'] = {}, calls: Call[] = [], env: Record<string, string> = {}) {
  return fakeDollar({
    env,
    runs: {
      ...resolverRuns(),
      'git status --porcelain -uno': { stdout: '' },
      ...runs,
    },
    tool: (input: Call) => {
      calls.push(input)
      if (input.tool === 'mcp__github__gh') return { result: JSON.stringify(github.pulls ?? [PR_12]) }
      if (input.tool === 'mcp__github__record') return github.record ?? { result: WRITTEN + '\n' }
      throw new Error('unexpected tool ' + input.tool)
    },
  })
}

// An agent's answer: prose, then its findings block.
const block = (findings: unknown[]) => 'Reviewed.\n```json\n' + JSON.stringify({ findings }) + '\n```'
const finding = (severity: string, n = 0) => ({ severity, file: 'src/a.ts', summary: `finding ${n}` })

// The findings the figures of a check_done account for: one per finding counted. An automatic
// check's passed findings are WARNINGs, the others ERRORs.
function accounted(input: Readonly<Record<string, unknown>>): unknown[] {
  const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0)
  const blocking = n(input['open']) + n(input['fixed']) + n(input['setAside'])
  return [
    ...Array.from({ length: blocking }, (_, i) => finding('error', i)),
    ...Array.from({ length: n(input['passed']) }, (_, i) => finding(input['auto'] === true ? 'warning' : 'error', blocking + i)),
  ]
}

function mounted() {
  const hooks = mount(on => {
    registerCheck(on)
    registerRecord(on)
    // The module's one session.end hook, which clears the mark, is the guards'.
    registerGuards(on)
  })
  // An agent's answer through the Agent tool's hook, as the host hands it back.
  const agent = (d: World, name: string, answer: unknown) =>
    hook(hooks, 'tool.call', { tool: 'Agent' }).handler(d, { tool: 'Agent', subagent_type: name }, async () => answer)
  const raw = (d: World, input: Readonly<Record<string, unknown>>) => hook(hooks, 'tool.call', { tool: 'mcp__norms__check_done' }).handler(d, input, nextOf().next)
  return {
    scope: (d: World) => hook(hooks, 'command.run', { command: 'norms:check' }).handler(d, { command: 'norms:check', args: '' }, nextOf().next),
    agent,
    raw,
    // The figures given account for the findings the agents reported: the way these tests state them.
    done: async (d: World, input: Readonly<Record<string, unknown>>) => {
      await agent(d, 'norms:norms-diff-scope', { result: block(accounted(input)) })
      return raw(d, input)
    },
    hooks,
  }
}

const recordCalls = (calls: Call[]) => calls.filter(c => c.tool === 'mcp__github__record')

// Every session.end hook of a mount, run as the host runs them: the events each one hands
// to the hook beneath.
const endSession = async (hooks: Hook[], $: World) => {
  const handed: unknown[] = []
  for (const h of hooksOn(hooks, 'session.end')) {
    const { next, seen } = nextOf()
    await h.handler($, { sessionId: 'sess-1' }, next)
    handed.push(...seen)
  }
  return handed
}

test('without a scope computed in this session, the record is written for the session\'s repository', async () => {
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const out = await mounted().done($, { open: 0, fixed: 0, passed: 2 })
  expect(fieldsOf(out)?.['result']).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls).map(c => [c['pr'], c['repo'], c['result'], c['detail'], c['dir']])).toEqual([[12, 'Owner/Repo', 'pass', '0 fixed, 2 passed, 0 open', '/repo']])
})

test('no open finding records a pass with its detail', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 5 })
  expect(fieldsOf(out)?.['result']).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls)).toEqual([
    { tool: 'mcp__github__record', pr: 12, repo: 'Owner/Repo', kind: 'norms', result: 'pass', detail: '0 fixed, 5 passed, 0 open', dir: '/repo' },
  ])
})

test('the record names the checkout the check read, whatever the session\'s directory is by then', async () => {
  resetCache()
  const checked = setup()
  const m = mounted()
  await m.scope(checked.$)
  const mark = checked.state.get('norms/scopeMark')
  const calls: Call[] = []
  const { $ } = fakeDollar({
    cwd: '/other',
    state: { 'norms/scopeMark': mark },
    runs: { ...runsIn('/repo'), 'git remote get-url origin': { stdout: 'git@github.com:Owner/Other.git\n' } },
    tool: recordTool(calls),
  })
  await m.done($, { open: 0, fixed: 0, passed: 1 })
  expect(recordCalls(calls).map(c => c['dir'])).toEqual(['/repo'])
})

test('open findings record a fail', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 2, fixed: 0, passed: 1 })
  expect(fieldsOf(out)?.['result']).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls)[0]?.['result']).toBe('fail')
  expect(recordCalls(calls)[0]?.['detail']).toBe('0 fixed, 1 passed, 2 open')
})

test('findings set aside with their reason leave nothing open: a pass that keeps the reason', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 1, setAside: 2, reason: 'a rule\nthe codebase  widely violates' })
  expect(fieldsOf(out)?.['result']).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls)[0]?.['result']).toBe('pass')
  expect(recordCalls(calls)[0]?.['detail']).toBe('0 fixed, 1 passed, 2 set aside (a rule the codebase widely violates), 0 open')
})

test('findings set aside without a reason are refused, and a finding left open still fails', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  calls.length = 0
  for (const input of [{ open: 0, fixed: 0, passed: 0, setAside: 1 }, { open: 0, fixed: 0, passed: 0, setAside: 1, reason: '  ' }, { open: 0, fixed: 0, passed: 0, setAside: -1, reason: 'x' }]) {
    expect(fieldsOf((await m.done($, input)))?.['isError']).toBe(true)
  }
  expect(calls).toEqual([])
  await m.done($, { open: 1, fixed: 0, passed: 0, setAside: 1, reason: 'not critical' })
  expect(recordCalls(calls)[0]?.['result']).toBe('fail')
  expect(recordCalls(calls)[0]?.['detail']).toBe('0 fixed, 0 passed, 1 set aside (not critical), 1 open')
})

test('the pull request is read through the github tool', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  // The scope's own call, at the command's start, reads the pull request's base: of the branch,
  // in the repository named, never the session's directory's.
  const ofBranch = { tool: 'mcp__github__gh', command: 'pr-get', args: { branch: 'feature', format: 'raw' }, repo: 'Owner/Repo' }
  expect(calls).toEqual([ofBranch])
  await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(calls[1]).toEqual(ofBranch)
})

test('a branch with no pull request leaves no record', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({ pulls: [] }, {}, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(fieldsOf(out)?.['result']).toBe('record: none — the branch has no pull request')
  expect(recordCalls(calls)).toEqual([])
})

test('a dirty tree leaves no record, and is checked before the pull request is read', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, { 'git status --porcelain -uno': { stdout: ' M src/a.ts\n' } }, calls)
  const m = mounted()
  await m.scope($)
  calls.length = 0
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(fieldsOf(out)?.['result']).toBe('record: none — the tracked files have changes')
  expect(calls).toEqual([])
})

test('the github tool refusing is reported with its own text', async () => {
  resetCache()
  const { $ } = setup({ record: { deny: 'github: the checkout is at aaaaaaa, the pull request\'s head is bbbbbbb: a record is written at the head it read.' } })
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(fieldsOf(out)?.['result']).toBe('record: none — github: the checkout is at aaaaaaa, the pull request\'s head is bbbbbbb: a record is written at the head it read.')
})

test('an error of the github tool is reported with its own text', async () => {
  resetCache()
  const { $ } = setup({ record: { result: 'record.py exited 2', isError: true } })
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(fieldsOf(out)?.['result']).toBe('record: none — record.py exited 2')
})

test('a github plugin that is absent or older than 0.12.0 leaves no record and throws nothing', async () => {
  resetCache()
  const { $ } = fakeDollar({
    runs: {
      ...resolverRuns(),
      'git status --porcelain -uno': { stdout: '' },
      'git remote get-url origin': { stdout: 'https://github.com/o/r.git\n' },
    },
    tool: (input: Call) => {
      if (input.tool === 'mcp__github__gh') return { result: JSON.stringify([PR_12]) }
      throw new Error('unknown tool ' + input.tool)
    },
  })
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(fieldsOf(out)?.['result']).toContain('record: none — the github plugin is absent or older than 0.12.0')
})

test('an unreadable remote leaves no record', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, { 'git remote get-url origin': { exitCode: 2, stderr: 'no such remote' } }, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(fieldsOf(out)?.['result']).toMatch(/^record: none — /)
  expect(recordCalls(calls)).toEqual([])
})

test('the head is read at the call: a commit made after the scope does not refuse the record', async () => {
  resetCache()
  const calls: Call[] = []
  const { $, argvs } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  const afterScope = argvs.filter(a => a === 'git rev-parse HEAD').length
  const ranAtScope = argvs.length
  // The fix commit of check.md 7.4 lands between the scope and the record.
  ;($).process.run = async (argv: readonly string[]) => {
    const key = argv.join(' ')
    argvs.push(key)
    if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: NEW_HEAD + '\n', stderr: '' }
    if (key === 'git status --porcelain -uno') return { exitCode: 0, stdout: '', stderr: '' }
    if (key === 'git remote get-url origin') return { exitCode: 0, stdout: 'https://github.com/o/r.git\n', stderr: '' }
    if (key === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'feature\n', stderr: '' }
    return { exitCode: 1, stdout: '', stderr: 'unexpected run: ' + key }
  }
  const out = await m.done($, { open: 0, fixed: 1, passed: 0 })
  expect(argvs.filter(a => a === 'git rev-parse HEAD').length).toBe(afterScope + 1)
  // The files the commits touched are not consulted: the record is written at the head of the call.
  expect(argvs.slice(ranAtScope).filter(a => a.startsWith('git diff'))).toEqual([])
  expect(fieldsOf(out)?.['result']).toBe('record: ' + WRITTEN)
  // The finding said fixed has its commit: it counts as fixed.
  expect(recordCalls(calls).map(c => [c['result'], c['detail']])).toEqual([['pass', '1 fixed, 0 passed, 0 open']])
})

test('a finding said fixed with no commit since the check is open: the record fails and says so', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  await m.done($, { open: 0, fixed: 2, passed: 1 })
  expect(recordCalls(calls).map(c => [c['result'], c['detail']])).toEqual([['fail', '0 fixed, 1 passed, 2 open (2 said fixed with no commit since the check)']])
})

test('without a scope, findings said fixed are recorded as given: no head to compare them with', async () => {
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  await mounted().done($, { open: 0, fixed: 1, passed: 0 })
  expect(recordCalls(calls).map(c => [c['result'], c['detail']])).toEqual([['pass', '1 fixed, 0 passed, 0 open']])
})

test('counts that are not whole numbers are refused', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  calls.length = 0
  const out = await m.done($, { open: -1, fixed: 'x', passed: 0 })
  expect(fieldsOf(out)?.['isError']).toBe(true)
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
  const registered: unknown[] = []
  const { $ } = fakeDollar({})
  ;($).tool.register = async (spec: unknown) => { registered.push(spec) }
  const m = mounted()
  const start = hook(m.hooks, 'session.start')
  const { next, seen } = nextOf()
  await start.handler($, { cwd: '/work' }, next)
  const spec = registered.find(s => fieldsOf(s)?.['name'] === 'check_done')
  expect(fieldsOf(spec)?.['isDeferred']).toBe(false)
  expect(fieldsOf(fieldsOf(spec)?.['inputSchema'])?.['required']).toEqual(['open', 'fixed', 'passed'])
  expect(seen.length).toBe(1)

  ;($).tool.register = async () => { throw new Error('refused') }
  const second = nextOf()
  await start.handler($, { cwd: '/work' }, second.next)
  expect(second.seen.length).toBe(1)
})

test('a registration that fails is logged with its error, not swallowed', async () => {
  const { $, logs } = fakeDollar({})
  ;($).tool.register = async () => { throw new Error('refused by the host') }
  const { next, seen } = nextOf()
  await hook(mounted().hooks, 'session.start').handler($, { cwd: '/work' }, next)
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('mcp__norms__check_done')
  expect(logs[0]).toContain('refused by the host')
  expect(seen.length).toBe(1)
})

test('an automatic check records that its findings were passed automatically as non-blocking', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 3, auto: true })
  expect(fieldsOf(out)?.['result']).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls)).toEqual([
    { tool: 'mcp__github__record', pr: 12, repo: 'Owner/Repo', kind: 'norms', result: 'pass', detail: '0 fixed, 3 passed (non-blocking, automatic), 0 open', dir: '/repo' },
  ])
})

test('an automatic check with an open ERROR records a fail from open alone', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  await m.done($, { open: 1, fixed: 0, passed: 5, auto: true })
  expect(recordCalls(calls)[0]?.['result']).toBe('fail')
  expect(recordCalls(calls)[0]?.['detail']).toBe('0 fixed, 5 passed (non-blocking, automatic), 1 open')
})

test('auto false or absent leaves the interactive record unchanged', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  await m.done($, { open: 0, fixed: 0, passed: 3, auto: false })
  await m.done($, { open: 0, fixed: 0, passed: 3 })
  expect(recordCalls(calls).map(c => c['detail'])).toEqual(['0 fixed, 3 passed, 0 open', '0 fixed, 3 passed, 0 open'])
})

const skillHook = (hooks: Hook[]) => {
  const found = hooksOn(hooks, 'tool.call').find(h => h.matcher === SKILL_MATCHER)
  if (!found) throw new Error('no Skill tool.call hook')
  return found
}

test('a check run through the Skill tool marks its scope, so its record is written', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  const { next, seen } = nextOf()
  await skillHook(m.hooks).handler($, { tool: 'Skill', skill: 'norms:check', args: 'report only' }, next)
  expect(fieldsOf(seen[0])?.['args']).toContain('report only\n\n<norms-scope>')
  const out = await m.done($, { open: 0, fixed: 0, passed: 1 })
  expect(fieldsOf(out)?.['result']).toBe('record: ' + WRITTEN)
})

test('the Skill hook matches the check alone, with or without its slash', () => {
  expect(SKILL_MATCHER.skill.test('norms:check')).toBe(true)
  expect(SKILL_MATCHER.skill.test('/norms:check')).toBe(true)
  expect(SKILL_MATCHER.skill.test('norms:learn')).toBe(false)
  expect(SKILL_MATCHER.skill.test('norms:checkout')).toBe(false)
})

test('a scope that fails on a Skill run hands the call a refusal block and marks nothing', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, { 'git rev-parse HEAD': { exitCode: 128, stderr: 'fatal: not a git repository' } }, calls)
  const m = mounted()
  const h = skillHook(m.hooks)
  const e = { tool: 'Skill', skill: 'norms:check', args: '' }
  const { next, seen } = nextOf()
  await h.handler($, e, next).catch((err: Error) => h.net?.($, e, Object.assign(next, { error: { message: err.message } })))
  expect(String(fieldsOf(seen[seen.length - 1])?.['args'])).toMatch(/^<norms-scope>\nrefused: the scope could not be computed \(.*not a git repository.*\)\n/)
  expect(await markedDir($)).toBeUndefined()
  const out = await m.done($, { open: 0, fixed: 0, passed: 0 })
  expect(String(fieldsOf(out)?.['result'])).toMatch(/^record: none — /)
  expect(recordCalls(calls)).toEqual([])
})

// The git and github answers of a clean checkout at HEAD whose pull request is 12.
const recordRuns = () => ({
  ...resolverRuns(),
  'git status --porcelain -uno': { stdout: '' },
})
const recordTool = (calls: Call[] = []) => (input: Call) => {
  calls.push(input)
  return input.tool === 'mcp__github__gh' ? { result: JSON.stringify([PR_12]) } : { result: WRITTEN + '\n' }
}

test('the scope mark lives in $.state, so a module that restarted still records', async () => {
  resetCache()
  const first = setup()
  const m = mounted()
  await skillHook(m.hooks).handler(first.$, { tool: 'Skill', skill: 'norms:check', args: '' }, nextOf().next)
  const kept = first.state.get('norms/scopeMark')
  expect(fieldsOf(kept)?.['head']).toBe(HEAD)
  expect(fieldsOf(kept)?.['dir']).toBe('/repo')

  // After a restart the module remembers nothing: the host's state carries the mark.
  const restarted = fakeDollar({ state: { 'norms/scopeMark': kept }, runs: recordRuns(), tool: recordTool() })
  const out = await mounted().done(restarted.$, { open: 0, fixed: 0, passed: 0 })
  expect(fieldsOf(out)?.['result']).toBe('record: ' + WRITTEN)
})

test('a value in the state that is not a mark is no mark: check_done reads the session\'s repository', async () => {
  for (const value of [null, 'x', { head: 'main' }, { head: HEAD, dir: 'relative' }]) {
    expect(asMark(value)).toBeUndefined()
    const { $ } = fakeDollar({ state: { 'norms/scopeMark': value }, runs: recordRuns(), tool: recordTool() })
    expect(await markedDir($)).toBeUndefined()
    const out = await mounted().done($, { open: 0, fixed: 0, passed: 0 })
    expect(fieldsOf(out)?.['result']).toBe('record: ' + WRITTEN)
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
    expect(fieldsOf(seen[0])?.['args']).toContain('<norms-scope>')
    expect(broken.logs.length).toBe(1)
    expect(broken.logs[0]).toContain('state is read-only')
    expect(fieldsOf((await m.done(broken.$, { open: 0, fixed: 0, passed: 0 })))?.['result']).toBe('record: ' + WRITTEN)

    // The memory copy is the mark: it names the repository the check read.
    expect(await markedDir(broken.$)).toBe('/repo')
    // A later mark kept in the host's state drops the memory copy.
    await m.scope(setup().$)
    expect(await markedDir(broken.$)).toBeUndefined()
  } finally {
    // The memory copy of the mark is module state: a failure above must not leave it to the next test.
    await endSession(m.hooks, setup().$)
  }
})

test('at session.end the mark is cleared from the state: no repository is marked any more', async () => {
  resetCache()
  const calls: Call[] = []
  const one = setup({}, {}, calls)
  const m = mounted()
  await m.scope(one.$)
  expect(one.state.has('norms/scopeMark')).toBe(true)
  expect(await markedDir(one.$)).toBe('/repo')
  calls.length = 0
  const handed = await endSession(m.hooks, one.$)
  expect(one.state.get('norms/scopeMark')).toBeNull()
  expect(await markedDir(one.$)).toBeUndefined()
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
  expect(await markedDir(broken.$)).toBe('/repo')
  await endSession(m.hooks, broken.$)
  expect(await markedDir(broken.$)).toBeUndefined()
})

test('a ui.log that returns a rejected promise has its rejection caught, and the mark is kept in memory', async () => {
  resetCache()
  const broken = fakeDollar({ stateFails: 'state is read-only', runs: recordRuns(), tool: recordTool() })
  // The promise the line returns, spied on: a catch attaches its handler through then.
  const handlers: unknown[] = []
  const sent = Promise.reject(new Error('the transcript is closed'))
  const attach = sent.then.bind(sent)
  Object.defineProperty(sent, 'then', {
    value: (ok: (value: unknown) => unknown, fail: (reason: unknown) => unknown) => {
      handlers.push(fail)
      return attach(ok, fail)
    },
  })
  ;(broken.$).ui.log = () => sent
  const m = mounted()
  try {
    await skillHook(m.hooks).handler(broken.$, { tool: 'Skill', skill: 'norms:check', args: '' }, nextOf().next)
    // A rejection with no handler is reported by the runtime on a later tick.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handlers.filter(h => typeof h === 'function').length).toBe(1)
    expect(fieldsOf((await m.done(broken.$, { open: 0, fixed: 0, passed: 0 })))?.['result']).toBe('record: ' + WRITTEN)
  } finally {
    await endSession(m.hooks, setup().$)
  }
})

// ── a review checkout: the session's directory moved out of it, or a detached head ──

// The git answers of setup(), as runs in `dir` rather than in the session's directory.
const runsIn = (dir: string, runs: FakeSetup['runs'] = {}): NonNullable<FakeSetup['runs']> => Object.fromEntries(Object.entries({
  ...resolverRuns(),
  'git status --porcelain -uno': { stdout: '' },
  'git rev-parse --show-toplevel': { stdout: dir + '\n' },
  ...runs,
}).map(([argv, answer]) => [`(${dir}) ${argv}`, answer]))

test('a check run after a shell cd out of the repository reads the project root\'s, marks its scope and records', async () => {
  resetCache()
  const calls: Call[] = []
  const root = '/work/repo'
  const { $ } = fakeDollar({
    runs: runsIn(root),
    root,
    tool: recordTool(calls),
  })
  const m = mounted()
  const { next, seen } = nextOf()
  await skillHook(m.hooks).handler($, { tool: 'Skill', skill: 'norms:check', args: 'report only' }, next)
  expect(fieldsOf(seen[0])?.['args']).toContain('<norms-scope>')
  expect(fieldsOf(seen[0])?.['args']).toContain(`head: ${HEAD}`)
  const out = await m.done($, { open: 0, fixed: 0, passed: 1 })
  expect(fieldsOf(out)?.['result']).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls).map(c => c['pr'])).toEqual([12])
})

test('a review checkout on a detached head records at the open pull request whose head it is', async () => {
  resetCache()
  const calls: Call[] = []
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
    tool: (input: Call) => {
      calls.push(input)
      if (input.tool === 'mcp__github__record') return { result: WRITTEN + '\n' }
      // The github plugin asks the branch `HEAD` for its pull request: there is none.
      return { result: input['command'] === 'pr-list' ? pulls : '' }
    },
  })
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 1 })
  expect(fieldsOf(out)?.['result']).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls).map(c => c['pr'])).toEqual([12])
})

test('a detached head that no open pull request has as its head leaves no record', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = fakeDollar({
    runs: {
      ...gitRuns(['src/a.ts'], ['src/a.ts'], {}, 'main'),
      'git rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n' },
      'git status --porcelain -uno': { stdout: '' },
      'git remote get-url origin': { stdout: 'git@github.com:Owner/Repo.git\n' },
    },
    tool: (input: Call) => {
      calls.push(input)
      return { result: input['command'] === 'pr-list' ? JSON.stringify([{ number: 7, head: { sha: NEW_HEAD }, base: { ref: 'main' } }]) : '' }
    },
  })
  const m = mounted()
  const { next } = nextOf()
  await hook(m.hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: 'base=main' }, next)
  const out = await m.done($, { open: 0, fixed: 0, passed: 1 })
  expect(fieldsOf(out)?.['result']).toBe('record: none — the branch has no pull request')
  expect(recordCalls(calls)).toEqual([])
})

test('a check_done after a shell cd into another repository records the repository the check read', async () => {
  resetCache()
  const checked = setup()
  const m = mounted()
  await m.scope(checked.$)
  const mark = checked.state.get('norms/scopeMark')
  expect(fieldsOf(mark)?.['dir']).toBe('/repo')
  const calls: Call[] = []
  const { $, argvs } = fakeDollar({
    cwd: '/other',
    state: { 'norms/scopeMark': mark },
    runs: {
      ...runsIn('/repo'),
      // The session's directory is now another repository, with its own pull request.
      'git rev-parse --show-toplevel': { stdout: '/other\n' },
      'git status --porcelain -uno': { stdout: '' },
      'git remote get-url origin': { stdout: 'git@github.com:Owner/Other.git\n' },
    },
    tool: recordTool(calls),
  })
  const out = await m.done($, { open: 0, fixed: 0, passed: 1 })
  expect(fieldsOf(out)?.['result']).toBe('record: ' + WRITTEN)
  expect(recordCalls(calls).map(c => [c['repo'], c['pr']])).toEqual([['Owner/Repo', 12]])
  expect(calls[0]).toEqual({ tool: 'mcp__github__gh', command: 'pr-get', args: { branch: 'feature', format: 'raw' }, repo: 'Owner/Repo' })
  expect(argvs.filter(a => !a.startsWith('(/repo) '))).toEqual([])
})

test('a branch with no pull request does not take the open pull request at its head: that lookup is a detached head\'s', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = fakeDollar({
    runs: { ...resolverRuns(), 'git status --porcelain -uno': { stdout: '' } },
    tool: (input: Call) => {
      calls.push(input)
      if (input.tool === 'mcp__github__record') return { result: WRITTEN + '\n' }
      return { result: input['command'] === 'pr-list' ? JSON.stringify([PR_12]) : '[]' }
    },
  })
  const m = mounted()
  await m.scope($)
  const out = await m.done($, { open: 0, fixed: 0, passed: 1 })
  expect(fieldsOf(out)?.['result']).toBe('record: none — the branch has no pull request')
  expect(calls.map(c => c['command'] ?? c.tool)).toEqual(['pr-get', 'pr-get'])
})

// A detached review checkout at HEAD, whose pull request list the github tool answers with `pulls`.
function detached(pulls: (input: Call) => any, calls: Call[] = []) {
  return fakeDollar({
    state: { 'norms/scopeMark': { head: HEAD, dir: '/repo' } },
    runs: {
      ...gitRuns(['src/a.ts'], ['src/a.ts']),
      'git rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n' },
      'git status --porcelain -uno': { stdout: '' },
    },
    tool: (input: Call) => {
      calls.push(input)
      return input.tool === 'mcp__github__record' ? { result: WRITTEN + '\n' } : pulls(input)
    },
  })
}

test('a detached head that several open pull requests have leaves no record, naming them', async () => {
  const calls: Call[] = []
  const both = [PR_12, { number: 13, head: { sha: HEAD }, base: { ref: 'home' } }]
  const { $ } = detached(() => ({ result: JSON.stringify(both) }), calls)
  const out = await mounted().done($, { open: 0, fixed: 0, passed: 1 })
  expect(fieldsOf(out)?.['result']).toBe(`record: none — 2 open pull requests have the head ${HEAD.slice(0, 12)}: Owner/Repo#12, Owner/Repo#13`)
  expect(recordCalls(calls)).toEqual([])
})

test('a detached head whose pull request list the github tool refuses leaves no record, with the refusal', async () => {
  const calls: Call[] = []
  const { $ } = detached(() => ({ deny: 'github: gh is not signed in' }), calls)
  const out = await mounted().done($, { open: 0, fixed: 0, passed: 1 })
  expect(fieldsOf(out)?.['result']).toBe('record: none — github: gh is not signed in')
  expect(calls).toEqual([{ tool: 'mcp__github__gh', command: 'pr-list', args: { format: 'raw' }, repo: 'Owner/Repo' }])
})

test('a host that cannot say where the repository is leaves the session\'s directory to git', async () => {
  expect(await repositoryDir(hostOf({ process: { run: async () => { throw new Error('no process') } } }))).toBeUndefined()
  const outside = { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }
  expect(await repositoryDir(hostOf({ process: { run: async () => outside }, session: { root: async () => { throw new Error('no root') } } }))).toBeUndefined()
})

test('in a session the orchestrator spawned, the answer ends on the verdict line naming the record', async () => {
  resetCache()
  const { $ } = setup({}, {}, [], { ORCHESTRATOR_SPAWNED: '1' })
  const m = mounted()
  await m.scope($)
  const passing = await m.done($, { open: 0, fixed: 0, passed: 5 })
  expect(fieldsOf(passing)?.['result']).toBe(`record: ${WRITTEN}\nRepo#12 ${HEAD.slice(0, 7)} — norms pass: 0 fixed, 5 passed, 0 open — blocking: none — report: ${WRITTEN}`)
  const failing = await m.done($, { open: 2, fixed: 0, passed: 0 })
  expect(String(fieldsOf(failing)?.['result']).split('\n').at(-1)).toBe(`Repo#12 ${HEAD.slice(0, 7)} — norms fail: 0 fixed, 0 passed, 2 open — blocking: 2 open finding(s), in the check's report — report: ${WRITTEN}`)
})

test('outside a session the orchestrator spawned, the answer is the record line alone', async () => {
  resetCache()
  const { $ } = setup({}, {}, [], { ORCHESTRATOR_SPAWNED: '' })
  const m = mounted()
  await m.scope($)
  expect(fieldsOf((await m.done($, { open: 0, fixed: 0, passed: 5 })))?.['result']).toBe('record: ' + WRITTEN)
})

// The pass is computed from the findings the agents reported.

const NAMING = 'norms:norms-variable-naming'
const SCOPE_AGENT = 'norms:norms-diff-scope'
const reply = (findings: unknown[]) => ({ result: block(findings) })

test('a check that left findings unaccounted for records nothing: open 0 is no pass the model can give', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  await m.agent($, NAMING, reply([finding('error', 1), finding('error', 2)]))
  await m.agent($, SCOPE_AGENT, reply([finding('warning', 3)]))
  calls.length = 0
  const lie = await m.raw($, { open: 0, fixed: 0, passed: 0 })
  expect(fieldsOf(lie)?.['isError']).toBe(true)
  expect(fieldsOf(lie)?.['result']).toContain('the agents reported 3 finding(s) and open + fixed + passed + setAside add up to 0')
  expect(calls).toEqual([])
  // Too many accounted for is as wrong.
  expect(fieldsOf((await m.raw($, { open: 0, fixed: 2, passed: 2 })))?.['isError']).toBe(true)
  expect(calls).toEqual([])
})

test('the figures that account for every finding record the pass or the fail they make', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  await m.agent($, NAMING, reply([finding('error', 1), finding('error', 2)]))
  await m.agent($, SCOPE_AGENT, reply([finding('warning', 3)]))
  await m.raw($, { open: 0, fixed: 0, passed: 3 })
  await m.raw($, { open: 1, fixed: 0, passed: 2 })
  await m.raw($, { open: 0, fixed: 0, passed: 2, setAside: 1, reason: 'not critical' })
  expect(recordCalls(calls).map(c => c['result'])).toEqual(['pass', 'fail', 'pass'])
})

test('a check whose agents reported nothing at all records nothing', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  calls.length = 0
  const out = await m.raw($, { open: 0, fixed: 0, passed: 0 })
  expect(out).toEqual({ result: 'norms: no norms agent has reported its findings since /norms:check began: run the check\'s agents first', isError: true })
  expect(calls).toEqual([])
})

test('an agent whose answer holds no readable findings block leaves the count unknown, until it runs again', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  await m.agent($, NAMING, reply([]))
  await m.agent($, SCOPE_AGENT, { result: 'COMPLIANT: all good, and no block' })
  const out = await m.raw($, { open: 0, fixed: 0, passed: 0 })
  expect(fieldsOf(out)?.['isError']).toBe(true)
  expect(fieldsOf(out)?.['result']).toContain(`${SCOPE_AGENT} returned no readable findings block`)
  expect(recordCalls(calls)).toEqual([])
  await m.agent($, SCOPE_AGENT, reply([]))
  await m.raw($, { open: 0, fixed: 0, passed: 0 })
  expect(recordCalls(calls).length).toBe(1)
})

test('an agent that fails, runs in the background or is refused leaves its findings unknown; the answer reaches the session as it came', async () => {
  resetCache()
  const { $ } = setup()
  const m = mounted()
  await m.scope($)
  const answers = [
    { isError: true, result: 'the agent failed' },
    { deny: 'refused' },
    { result: { status: 'async_launched', agentId: 'a1' } },
  ]
  for (const answer of answers) {
    await m.agent($, NAMING, reply([]))
    expect(await m.agent($, NAMING, answer)).toBe(answer)
    expect(fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 0 })))?.['result']).toContain(`${NAMING} returned no readable findings block`)
  }
  // An agent whose call throws is answered with the error, and runs once.
  let runs = 0
  const thrown = await hook(m.hooks, 'tool.call', { tool: 'Agent' }).handler($, { tool: 'Agent', subagent_type: NAMING }, async () => { runs++; throw new Error('boom') })
  expect(thrown).toEqual({ result: 'boom', isError: true })
  expect(runs).toBe(1)
  expect(fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 0 })))?.['result']).toContain('returned no readable findings block')
})

// ── an agent the host ran in the background ──
// The shapes of the review session of geonative-api#1878 (2026-11-18): each norms agent was
// launched in the background, the Agent call answered with core's launch record, and the agent
// handed its report back by calling SubagentHandback in its own loop, its id as `agentId`, its
// report as `message`; core answered whether the report reached the session.

const PATTERN = 'norms:norms-pattern-conformity'
const PATTERN_ID = 'aa6b9ab1d01edda59'
const launch = (agentId: string, description: string) => ({
  ref: 1,
  result: { isAsync: true, status: 'async_launched', agentId, description, resolvedModel: 'claude-sonnet-5-5' },
})
const DELIVERED = { ref: 1, result: { success: true, message: 'Report delivered to your caller.' }, text: '{"success":true,"message":"Report delivered to your caller."}' }
const NOT_SENT = { ref: 1, result: { success: false, message: 'Nothing was sent: an earlier report of yours was already delivered.' }, text: 'Nothing was sent.' }
// The pattern agent's hand-back, its prose cut short; its block as it came.
const PATTERN_REPORT = [
  'The changed code follows the established patterns, with one warning and three infos. I changed nothing.',
  '',
  '### WARNING [project] [api-platform] Processors delegate persistence to the wrapped PersistProcessor, `src/Admin/Api/State/SmsDispatchProcessor.php:67-71,98`',
  '- **Suggestion**: Inject `PersistProcessor $persister` and call `$this->persister->process(...)` for both writes.',
  '',
  '```json',
  '{"findings": [',
  '{"severity": "warning", "file": "src/Admin/Api/State/SmsDispatchProcessor.php", "summary": "[project] [api-platform] Processor persists and flushes the entity manager itself"},',
  '{"severity": "info", "file": "src/Admin/Api/State/SmsDispatchProcessor.php", "summary": "[project] [commits-and-comments] Class docblock is a ~14-line design explanation"},',
  '{"severity": "info", "file": "src/Admin/Api/Validator/SmsDispatch/HasOneRecipient.php", "summary": "[project] [code-rules] New CLASS_CONSTRAINT getTargets() has no unit test"},',
  '{"severity": "info", "file": "src/Admin/Api/State/SmsDispatchProcessor.php", "summary": "[project] [commits-and-comments] Inline literals \'application/problem+json\' / \'about:blank\'"}',
  ']}',
  '```',
].join('\n')
// The first run's diff-scope hand-back: a report without a block.
const BLOCKLESS_REPORT = 'COMPLIANT: All changes are minimal and related to the branch purpose.\nFiles changed: 17 (all relevant).'

function background(m: ReturnType<typeof mounted>) {
  return {
    handBack: (d: World, agentId: string, message: string, answer: unknown = DELIVERED) =>
      hook(m.hooks, 'tool.call', { tool: 'SubagentHandback' }).handler(d, { tool: 'SubagentHandback', agentId, message }, async () => answer),
    // Every turn.complete hook of the module, as the host runs them at the end of the agent's turn.
    ended: async (d: World, agentId: string, answer: string, reason = 'answer') => {
      for (const h of hooksOn(m.hooks, 'turn.complete')) await h.handler(d, { agentId, reason, answer, turnId: 't' }, nextOf().next)
    },
  }
}

test('an agent run in the background is read from its SubagentHandback call: its findings are the record\'s', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  const b = background(m)
  await m.scope($)
  const launched = launch(PATTERN_ID, 'Norms: pattern conformity')
  expect(await m.agent($, PATTERN, launched)).toBe(launched)
  // Still running: its findings are not known yet.
  expect(fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 0 })))?.['isError']).toBe(true)
  const answer = await b.handBack($, PATTERN_ID, PATTERN_REPORT)
  expect(answer).toBe(DELIVERED)
  // Its turn ends after the hand-back, on a last answer that holds no block: the report stands.
  await b.ended($, PATTERN_ID, 'Report handed back.')
  const lie = await m.raw($, { open: 0, fixed: 0, passed: 0 })
  expect(fieldsOf(lie)?.['result']).toContain('the agents reported 4 finding(s)')
  await m.raw($, { open: 0, fixed: 0, passed: 4 })
  expect(recordCalls(calls).map(c => c['result'])).toEqual(['pass'])
})

// The host delivers a background agent's report through its hand-back alone: the last answer of a
// turn that ended without one never reaches the session, so it is no report.
test('an agent run in the background that ends its turn without a hand-back leaves its findings unknown', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  const b = background(m)
  await m.scope($)
  await m.agent($, PATTERN, launch(PATTERN_ID, 'Norms: pattern conformity'))
  await b.ended($, PATTERN_ID, PATTERN_REPORT)
  expect(fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 4 })))?.['result']).toContain(`${PATTERN} returned no readable findings block`)
  expect(recordCalls(calls)).toEqual([])
})

test('a hand-back without a block stays unknown through the end of its turn, whose answer holds one', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  const b = background(m)
  await m.scope($)
  await m.agent($, SCOPE_AGENT, launch('a7bdad4b3b46ee92f', 'Norms: diff scope'))
  await b.handBack($, 'a7bdad4b3b46ee92f', BLOCKLESS_REPORT)
  await b.ended($, 'a7bdad4b3b46ee92f', block([]))
  expect(fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 0 })))?.['result']).toContain(`${SCOPE_AGENT} returned no readable findings block`)
  expect(recordCalls(calls)).toEqual([])
})

test('a background agent that hands back no block, fails, or whose hand-back reached no one leaves its findings unknown', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  const b = background(m)
  await m.scope($)
  const unknown = async () => fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 0 })))?.['result']
  await m.agent($, SCOPE_AGENT, launch('a7bdad4b3b46ee92f', 'Norms: diff scope'))
  await b.handBack($, 'a7bdad4b3b46ee92f', BLOCKLESS_REPORT)
  await b.ended($, 'a7bdad4b3b46ee92f', '')
  expect(await unknown()).toContain(`${SCOPE_AGENT} returned no readable findings block`)
  // A turn that ends in error is no report.
  await m.agent($, SCOPE_AGENT, launch('a2', 'Norms: diff scope'))
  await b.ended($, 'a2', block([]), 'error')
  expect(await unknown()).toContain(`${SCOPE_AGENT} returned no readable findings block`)
  // A hand-back core did not deliver is not read.
  await m.agent($, SCOPE_AGENT, launch('a3', 'Norms: diff scope'))
  await b.handBack($, 'a3', block([]), NOT_SENT)
  expect(await unknown()).toContain(`${SCOPE_AGENT} returned no readable findings block`)
  expect(recordCalls(calls)).toEqual([])
})

test('a hand-back of an agent the check did not launch, or one a later run replaced, fills no report', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  const b = background(m)
  await m.scope($)
  await m.agent($, PATTERN, launch('old', 'Norms: pattern conformity'))
  await m.agent($, PATTERN, launch(PATTERN_ID, 'Norms: pattern conformity'))
  // The first run's late hand-back, and one of an agent of no check, are not the check's.
  await b.handBack($, 'old', block([]))
  await b.handBack($, 'stranger', block([]))
  expect(fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 0 })))?.['result']).toContain(`${PATTERN} returned no readable findings block`)
  await b.handBack($, PATTERN_ID, PATTERN_REPORT)
  await m.raw($, { open: 0, fixed: 0, passed: 4 })
  expect(recordCalls(calls).length).toBe(1)
})

test('a new scope forgets the agents running in the background', async () => {
  resetCache()
  const { $ } = setup()
  const m = mounted()
  const b = background(m)
  await m.scope($)
  await m.agent($, PATTERN, launch(PATTERN_ID, 'Norms: pattern conformity'))
  await m.scope($)
  await b.handBack($, PATTERN_ID, PATTERN_REPORT)
  expect(fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 4 })))?.['result']).toContain('no norms agent has reported')
})

test('the norms agents of a check run in the background together, each read from its own hand-back', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  const b = background(m)
  await m.scope($)
  await m.agent($, PATTERN, launch(PATTERN_ID, 'Norms: pattern conformity'))
  await m.agent($, SCOPE_AGENT, launch('a708d9f1fe0e312e8', 'Norms: diff scope'))
  await b.handBack($, 'a708d9f1fe0e312e8', block([finding('error', 9)]))
  expect(fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 1 })))?.['result']).toContain(`${PATTERN} returned no readable findings block`)
  await b.handBack($, PATTERN_ID, PATTERN_REPORT)
  await m.raw($, { open: 0, fixed: 0, passed: 5 })
  expect(recordCalls(calls).length).toBe(1)
})

test('a report read stays through a later turn of its agent; an agent asked again for its block is read from it', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  const b = background(m)
  await m.scope($)
  await m.agent($, PATTERN, launch(PATTERN_ID, 'Norms: pattern conformity'))
  await b.handBack($, PATTERN_ID, PATTERN_REPORT)
  await b.ended($, PATTERN_ID, '')
  // Asked a question afterwards, it answers without a block: its report stands.
  await b.ended($, PATTERN_ID, 'The warning is about the double flush.')
  // The diff-scope agent hands back no block; asked again, core refuses its second hand-back, which carries the block.
  await m.agent($, SCOPE_AGENT, launch('a7bdad4b3b46ee92f', 'Norms: diff scope'))
  await b.handBack($, 'a7bdad4b3b46ee92f', BLOCKLESS_REPORT)
  await b.ended($, 'a7bdad4b3b46ee92f', '')
  expect(fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 4 })))?.['result']).toContain(`${SCOPE_AGENT} returned no readable findings block`)
  await b.handBack($, 'a7bdad4b3b46ee92f', block([]), NOT_SENT)
  await m.raw($, { open: 0, fixed: 0, passed: 4 })
  expect(recordCalls(calls).length).toBe(1)
})

test('a later run in the foreground replaces a background one, and a failed launch is no background run', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  const b = background(m)
  await m.scope($)
  await m.agent($, PATTERN, launch('old', 'Norms: pattern conformity'))
  await m.agent($, PATTERN, reply([]))
  await b.handBack($, 'old', PATTERN_REPORT)
  // A launch record that comes back as an error names no run to read.
  await m.agent($, SCOPE_AGENT, { ...launch('failed', 'Norms: diff scope'), isError: true })
  await b.handBack($, 'failed', block([]))
  expect(fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 0 })))?.['result']).toContain(`${SCOPE_AGENT} returned no readable findings block`)
  await m.agent($, SCOPE_AGENT, reply([]))
  await m.raw($, { open: 0, fixed: 0, passed: 0 })
  expect(recordCalls(calls).length).toBe(1)
})

test('an agent of another plugin is not a norms agent: its answer is passed on unread', async () => {
  resetCache()
  const { $ } = setup()
  const m = mounted()
  await m.scope($)
  const answer = reply([finding('error')])
  expect(await m.agent($, 'general-purpose', answer)).toBe(answer)
  expect(fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 0 })))?.['result']).toContain('no norms agent has reported')
})

test('an agent that runs again replaces its report, and a new scope forgets every report', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  await m.agent($, NAMING, reply([finding('error')]))
  await m.agent($, NAMING, reply([]))
  await m.raw($, { open: 0, fixed: 0, passed: 0 })
  expect(recordCalls(calls).length).toBe(1)
  await m.scope($)
  expect(fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 0 })))?.['result']).toContain('no norms agent has reported')
  expect(recordCalls(calls).length).toBe(1)
})

test('the end of the session forgets the reports', async () => {
  resetCache()
  const { $, state } = setup()
  const m = mounted()
  await m.scope($)
  await m.agent($, NAMING, reply([]))
  await endSession(m.hooks, $)
  // A mark again, with no scope computed: only the reports tell whether the agents ran.
  state.set('norms/scopeMark', { head: HEAD })
  expect(fieldsOf((await m.raw($, { open: 0, fixed: 0, passed: 0 })))?.['result']).toContain('no norms agent has reported')
})

test('an automatic check\'s figures are the findings\' own: the ones the model gives are not read', async () => {
  resetCache()
  const calls: Call[] = []
  const { $ } = setup({}, {}, calls)
  const m = mounted()
  await m.scope($)
  await m.agent($, NAMING, reply([finding('error', 1), finding('info', 2), finding('warning', 3)]))
  // Nothing open, the ERROR said passed, then said fixed, then figures that add up to nothing.
  await m.raw($, { open: 0, fixed: 0, passed: 3, auto: true })
  await m.raw($, { open: 0, fixed: 1, passed: 2, auto: true })
  await m.raw($, { open: 0, fixed: 0, passed: 0, auto: true })
  expect(recordCalls(calls).map(c => [c['result'], c['detail']])).toEqual(Array.from({ length: 3 }, () => ['fail', '0 fixed, 2 passed (non-blocking, automatic), 1 open']))
  // An ERROR the brief sets aside, with its reason, is not open; no more is set aside than there are ERRORs.
  await m.raw($, { open: 0, fixed: 0, passed: 2, setAside: 4, reason: 'not critical', auto: true })
  expect(recordCalls(calls).at(-1)?.['detail']).toBe('0 fixed, 2 passed (non-blocking, automatic), 1 set aside (not critical), 0 open')
  expect(recordCalls(calls).at(-1)?.['result']).toBe('pass')
  // An interactive walkthrough lets the user pass an ERROR: the choice is theirs.
  await m.raw($, { open: 0, fixed: 0, passed: 3 })
  expect(recordCalls(calls).at(-1)?.['result']).toBe('pass')
})

test('the agents\' prompts end with the request for the findings block', async () => {
  resetCache()
  const { $ } = fakeDollar({ runs: gitRuns(['src/a.ts'], [], { 'src/a.ts': '+a\n' }), dirs: { '.': [] } })
  const hooks = mount(registerCheck)
  const { next, seen } = nextOf()
  await hook(hooks, 'agent.spawn').handler($, { subagentType: 'norms:norms-magic-values', prompt: 'p', fork: false }, next)
  expect(String(fieldsOf(seen[0])?.['prompt']).endsWith(REPORT_REQUEST)).toBe(true)
})

test('a findings block is read from the last fenced json block, case aside, and nothing else is a report', () => {
  expect(reportOf('x\n```json\n{"findings":[{"severity":"ERROR","file":"a","summary":"s"}]}\n```\ntail')).toEqual([{ severity: 'error', file: 'a', summary: 's' }])
  const two = '```json\n{"findings":[{"severity":"error"}]}\n```\n```json\n{"findings":[]}\n```'
  expect(reportOf(two)).toEqual([])
  for (const text of ['no block', '```json\nnot json\n```', '```json\n{"findings": 3}\n```', '```json\n{"findings":[{"severity":"critical"}]}\n```', '```json\nnull\n```']) {
    expect(reportOf(text), text).toBeNull()
  }
})

test('an agent\'s text is its completed record\'s content or hand-back report, never a launch', () => {
  expect(agentText({ result: 'plain' })).toBe('plain')
  expect(agentText({ text: 'plain' })).toBe('plain')
  expect(agentText({ result: [{ text: 'a' }, 'b', { other: 1 }] })).toBe('a\nb\n')
  expect(agentText('direct')).toBe('direct')
  expect(agentText(undefined)).toBe('')
  const done = { status: 'completed', content: [{ text: 'one' }, { text: 'two' }] }
  expect(agentText({ result: done })).toBe('one\ntwo')
  expect(agentText({ result: { ...done, handback: 'send', handbackReport: { text: 'delivered' } } })).toBe('delivered')
  expect(agentText({ result: { ...done, handback: 'withheld' } })).toBe('')
  expect(agentText({ result: { status: 'async_launched', agentId: 'a' } })).toBe('')
})
