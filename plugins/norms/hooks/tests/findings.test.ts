// hooks/tests/findings.test.ts
// What the module's journal keeps of a check: one event per finding its agents reported, written
// by check_done once the pull request is read, and the pull request on every event written while
// the check stands. An event holds where and how severe, never what was said.
import { expect, test } from 'claude-code/testing'
import { parseLearningEvent } from '../../core/learning.ts'
import { register as registerCheck, resetCache } from '../check.ts'
import { register as registerGuards, resetGuards } from '../guards.ts'
import { register as registerRecord } from '../record.ts'
import { fakeDollar, gitRuns, hook, HEAD, mount, nextOf, type FakeSetup } from './fakes.ts'
import { observedAs, watchJournal } from './journal.ts'

const PR_12 = { number: 12, head: { sha: HEAD }, base: { ref: 'main' } }
const SUBJECT = { repo: 'owner/repo', pr: 12, head: HEAD }

function setup(pulls: unknown[] = [PR_12], runs: FakeSetup['runs'] = {}) {
  const calls: any[] = []
  const fake = fakeDollar({
    runs: { ...gitRuns(['src/a.ts'], ['src/a.ts']), ...gitRuns(['src/a.ts'], ['src/a.ts'], {}, 'main'), 'git status --porcelain -uno': { stdout: '' }, ...runs },
    tool: (input: any) => {
      calls.push(input)
      if (input.tool === 'mcp__github__gh') return { result: JSON.stringify(pulls) }
      return { result: '/home/u/.claude/pr-records/o/r/' + HEAD + '/norms.json\n' }
    },
  })
  return { ...fake, calls, journal: watchJournal(fake.$) }
}

function mounted() {
  resetCache()
  resetGuards()
  const hooks = mount(on => {
    registerCheck(on)
    registerRecord(on)
    registerGuards(on)
  })
  return {
    hooks,
    // The check as the person types it: the guards' walkthrough begins, then the scope is computed.
    scope: async ($: any, args = '') => {
      for (const h of hooks.filter(h => h.event === 'command.run' && h.matcher?.['command'] === 'norms:check')) await h.handler($, { command: 'norms:check', args }, nextOf().next)
    },
    agent: ($: any, name: string, findings: unknown[]) =>
      hook(hooks, 'tool.call', { tool: 'Agent' }).handler($, { tool: 'Agent', subagent_type: name }, async () => ({ result: 'Read.\n```json\n' + JSON.stringify({ findings }) + '\n```' })),
    done: ($: any, input: any) => hook(hooks, 'tool.call', { tool: 'mcp__norms__check_done' }).handler($, input),
    edit: ($: any) => hook(hooks, 'tool.call', { tool: 'Edit' }).handler($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }, nextOf().next),
  }
}

const SECRET = 'the token hunter2 is hard-coded'

test('check_done leaves one event per finding: the agent and the severity as its code, the file as its path, the pull request as its subject', async () => {
  const { $, journal } = setup()
  const m = mounted()
  await m.scope($)
  await m.agent($, 'norms:norms-magic-values', [{ severity: 'error', file: 'src/a.ts', summary: SECRET }, { severity: 'warning', file: '/repo/tests/a.test.ts:12', summary: SECRET }])
  await m.agent($, 'norms:norms-documentation', [{ severity: 'info', file: 'not a path', summary: SECRET }])
  await m.done($, { open: 1, fixed: 0, passed: 2 })
  const events = journal()
  expect(events.map(e => parseLearningEvent(e))).toEqual(events)
  expect(events.map(e => [e.kind, e.trust, e.source.code, e.context.paths, e.context.languages])).toEqual([
    ['finding', 'review', 'norms.magic-values.error', ['src/a.ts'], ['typescript']],
    ['finding', 'review', 'norms.magic-values.warning', ['tests/a.test.ts'], ['typescript']],
    // A file that is no path of the repository is left out; the finding is kept.
    ['finding', 'review', 'norms.documentation.info', [], []],
  ])
  expect(events.map(e => e.subject)).toEqual([SUBJECT, SUBJECT, SUBJECT])
  expect(events.every(e => e.context.session === 'sess-1')).toBe(true)
  expect(JSON.stringify(events)).not.toMatch(/hunter2|hard-coded|"\/repo/)
})

test('the findings of one check are written once, and a new check writes its own', async () => {
  const { $, journal } = setup()
  const m = mounted()
  await m.scope($)
  await m.agent($, 'norms:norms-magic-values', [{ severity: 'warning', file: 'src/a.ts', summary: 's' }])
  await m.done($, { open: 0, fixed: 0, passed: 1 })
  await m.done($, { open: 0, fixed: 0, passed: 1 })
  expect(journal().length).toBe(1)
  await m.scope($)
  await m.agent($, 'norms:norms-magic-values', [{ severity: 'warning', file: 'src/a.ts', summary: 's' }])
  await m.done($, { open: 0, fixed: 0, passed: 1 })
  expect(journal().length).toBe(2)
})

test('a check with no finding, or on a branch with no pull request, writes no finding', async () => {
  const clean = setup()
  const m = mounted()
  await m.scope(clean.$)
  await m.agent(clean.$, 'norms:norms-magic-values', [])
  await m.done(clean.$, { open: 0, fixed: 0, passed: 0 })
  expect(clean.journal()).toEqual([])
  const lonely = setup([])
  await m.scope(lonely.$)
  await m.agent(lonely.$, 'norms:norms-magic-values', [{ severity: 'error', file: 'src/a.ts', summary: 's' }])
  expect((await m.done(lonely.$, { open: 1, fixed: 0, passed: 0 })).result).toBe('record: none — the branch has no pull request')
  expect(lonely.journal()).toEqual([])
})

test('a journal that cannot be written changes nothing of the record: one line in the log', async () => {
  const { $, calls, logs } = setup()
  const m = mounted()
  await m.scope($)
  await m.agent($, 'norms:norms-magic-values', [{ severity: 'error', file: 'src/a.ts', summary: 's' }])
  const write = $.fs.write
  $.fs.write = async (path: string, text: string) => {
    if (path.includes('/journal/')) throw new Error('disk full')
    return write(path, text)
  }
  const out = await m.done($, { open: 1, fixed: 0, passed: 0 })
  expect(String(out.result).startsWith('record: /home/u/.claude/pr-records/')).toBe(true)
  expect(calls.filter(c => c.tool === 'mcp__github__record').map(c => c.result)).toEqual(['fail'])
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('norms: the journal could not be written or pruned: disk full')
})

test('an observed guard names the pull request the check reads: the scope\'s own lookup found it', async () => {
  const { $, journal, calls } = setup()
  const m = mounted()
  await m.scope($)
  const lookups = calls.length
  await m.edit($)
  const [event] = journal()
  expect(parseLearningEvent(event)).toEqual(event)
  expect(event).toMatchObject(observedAs('norms.edit.ungranted'))
  expect(event.subject).toEqual(SUBJECT)
  // The subject costs the guard no call of its own.
  expect(calls.length).toBe(lookups)
})

test('a check given its base reads no pull request at its start: the guard\'s event names the repository and the head, and check_done the pull request', async () => {
  const { $, journal } = setup()
  const m = mounted()
  await m.scope($, 'base=main')
  await m.edit($)
  expect(journal().map(e => e.subject)).toEqual([{ ...SUBJECT, pr: null }])
  await m.agent($, 'norms:norms-magic-values', [{ severity: 'error', file: 'src/a.ts', summary: 's' }])
  await m.done($, { open: 1, fixed: 0, passed: 0 })
  expect(journal().at(-1).subject).toEqual(SUBJECT)
})

test('the end of the session forgets the pull request: a later event names none', async () => {
  const { $, journal } = setup()
  const m = mounted()
  await m.scope($)
  for (const h of m.hooks.filter(h => h.event === 'session.end')) await h.handler($, { reason: 'exit' }, nextOf().next)
  const guards = mount(registerGuards)
  await hook(guards, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: '' }, nextOf().next)
  await hook(guards, 'tool.call', { tool: 'Edit' }).handler($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }, nextOf().next)
  expect(journal().map(e => e.subject)).toEqual([{ repo: null, pr: null, head: null }])
})
