// hooks/tests/guards.test.ts
// N4: the walkthrough guards, each false-positive case they were narrowed for,
// and the releases (the user's own words, an interrupted turn, another command).
import { expect, test } from 'claude-code/testing'
import { editDecision, pushDecision, commitDecision, register, resetGuards, guardState } from '../guards.ts'
import { mount, hook, nextOf, fakeDollar } from './fakes.ts'

test('under /norms:check, an edit is refused on the command turn and after pass or discuss', () => {
  expect(editDecision('check', '/norms:check', 'src/a.ts')).toContain('no code change')
  expect(editDecision('check', '2', 'src/a.ts')).toContain('mark it passed')
  expect(editDecision('check', 'Pass.', 'src/a.ts')).toContain('mark it passed')
  expect(editDecision('check', '3', 'src/a.ts')).toContain('re-present')
  expect(editDecision('check', '?', 'src/a.ts')).toContain('re-present')
})

test('under /norms:check, fix and every other answer of the user\'s own let the edit through', () => {
  for (const words of ['1', 'fix', 'yes', 'do it', '**fix**', 'rename it to account instead, then apply']) {
    expect(editDecision('check', words, 'src/a.ts')).toBeNull()
  }
})

test('outside a norms command nothing is refused', () => {
  expect(editDecision(undefined, '2', 'src/a.ts')).toBeNull()
  expect(pushDecision(undefined, 'ok', 'git push')).toBeNull()
  expect(commitDecision(undefined, 'ok', 'git commit -m "norms"')).toBeNull()
})

test('under /norms:learn only CONTRIBUTING.md is guarded, and only before add or after skip', () => {
  expect(editDecision('learn', '/norms:learn 12', 'CONTRIBUTING.md')).toContain('no rule is added')
  expect(editDecision('learn', 'skip', '/repo/CONTRIBUTING.md')).toContain('not added')
  expect(editDecision('learn', 'add', 'CONTRIBUTING.md')).toBeNull()
  expect(editDecision('learn', 'make it a warning, not an error', 'CONTRIBUTING.md')).toBeNull()
  expect(editDecision('learn', 'skip', 'src/a.ts')).toBeNull()
})

test('a push is refused unless the user\'s own words ask for it', () => {
  expect(pushDecision('check', 'fix', 'git push origin feature')).toContain('never push')
  expect(pushDecision('check', 'fix', 'git -C /repo push')).toContain('never push')
  expect(pushDecision('learn', 'add', 'git add x && git push')).toContain('never push')
  expect(pushDecision('check', 'fix it and push', 'git push')).toBeNull()
  expect(pushDecision('check', 'fix', 'git log --grep=push')).toBeNull()
  expect(pushDecision('check', 'fix', 'git stash push -m wip')).toBeNull()
})

test('a commit message naming the check or its tooling is refused, unless the user used that word', () => {
  expect(commitDecision('check', 'fix', 'git commit -m "fix: apply norms check finding"')).toContain('"norms"')
  expect(commitDecision('check', 'fix', 'git commit -m "refactor: per norms-variable-naming"')).toContain('norms-variable-naming')
  expect(commitDecision('check', 'fix', 'git commit -m "fix: as Claude suggested"')).toContain('Claude')
  expect(commitDecision('check', 'fix', 'git commit -m "chore: tick the TODO list"')).toContain('TODO list')
  expect(commitDecision('check', 'fix', 'git commit -m "refactor(auth): rename usr to user"')).toBeNull()
  // The word "agent" is a real domain word: never refused.
  expect(commitDecision('check', 'fix', 'git commit -m "fix(agent): retry the user agent header"')).toBeNull()
  // A path staged before the commit is not the message.
  expect(commitDecision('check', 'fix', 'git add src/norms/a.ts && git commit -m "fix: guard"')).toBeNull()
  // The user's own words release it.
  expect(commitDecision('check', 'fix, and say claude in the message', 'git commit -m "fix: as claude"')).toBeNull()
  // /norms:learn prescribes a message with "norms" in it.
  expect(commitDecision('learn', 'add', 'git commit -m "docs(contributing): update project code norms"')).toBeNull()
})

test('the hooks follow the session: command, the user\'s words, an interrupt, another command', async () => {
  resetGuards()
  const hooks = mount(register)
  const { $ } = fakeDollar({})
  const run = (e: any) => hook(hooks, 'command.run').handler($, e, nextOf().next)
  const say = (text: string, kind = 'composer') => hook(hooks, 'prompt.submit').handler($, { text, origin: { kind } }, nextOf().next)
  const edit = async (file_path: string, agentId?: string) => {
    const { next, seen } = nextOf()
    const out = await hook(hooks, 'tool.call', { tool: 'Edit' }).handler($, { tool: 'Edit', file_path, agentId }, next)
    return seen.length ? 'ran' : out.deny
  }

  await run({ command: 'norms:check', args: '' })
  expect(guardState().mode).toBe('check')
  expect(await edit('src/a.ts')).toContain('no code change')
  // A subagent's edit is not the walkthrough's.
  expect(await edit('src/a.ts', 'agent-1')).toBe('ran')
  await say('2')
  expect(await edit('src/a.ts')).toContain('mark it passed')
  // A notification is not the user's word.
  await say('fix', 'task-notification')
  expect(await edit('src/a.ts')).toContain('mark it passed')
  await say('fix')
  expect(await edit('src/a.ts')).toBe('ran')

  await say('2')
  await hook(hooks, 'turn.complete').handler($, { isAborted: true }, nextOf().next)
  expect(guardState().mode).toBeUndefined()
  expect(await edit('src/a.ts')).toBe('ran')

  await run({ command: 'norms:check', args: '' })
  await run({ command: 'commit', args: '' })
  expect(guardState().mode).toBeUndefined()

  await run({ command: 'norms:learn', args: '12' })
  await hook(hooks, 'session.end').handler($, { reason: 'clear' }, nextOf().next)
  expect(guardState().mode).toBeUndefined()
})

test('the Bash guard refuses a push and a leaking commit, and passes the rest', async () => {
  resetGuards()
  const hooks = mount(register)
  const { $ } = fakeDollar({})
  await hook(hooks, 'command.run').handler($, { command: 'norms:check', args: '' }, nextOf().next)
  await hook(hooks, 'prompt.submit').handler($, { text: 'fix', origin: { kind: 'composer' } }, nextOf().next)
  const bash = async (command: string) => {
    const { next, seen } = nextOf()
    const out = await hook(hooks, 'tool.call', { tool: 'Bash' }).handler($, { tool: 'Bash', command }, next)
    return seen.length ? 'ran' : out.deny
  }
  expect(await bash('git push')).toContain('never push')
  expect(await bash('git commit -m "fix: norms finding"')).toContain('"norms"')
  expect(await bash('npm test')).toBe('ran')
  expect(await bash('git commit -m "fix(auth): rename usr"')).toBe('ran')
})

test('a guard that fails lets the call through', async () => {
  const hooks = mount(register)
  const { $ } = fakeDollar({})
  const e = { tool: 'Edit', file_path: 'a' }
  const { next, seen } = nextOf()
  await hook(hooks, 'tool.call', { tool: 'Edit' }).net!($, e, next)
  expect(seen).toEqual([e])
})
