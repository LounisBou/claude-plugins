// hooks/tests/guards.test.ts
// N4: the walkthrough guards, each false-positive case they were narrowed for,
// and the releases (the user's own words, an interrupted turn, another command).
import { expect, test } from 'claude-code/testing'
import { agentBashDecision, AGENT_WRITE_REFUSAL, PUSH_REFUSAL, editDecision, pushQuestion, commitDecision, promptCommand, register, resetGuards, guardState } from '../guards.ts'
import { register as registerAll } from '../register.ts'
import { register as registerRecord, markScope } from '../record.ts'
import { mount, hook, nextOf, fakeDollar, HEAD, type Hook } from './fakes.ts'

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
  expect(pushQuestion(undefined, 'git push')).toBeNull()
  expect(commitDecision(undefined, 'ok', 'git commit -m "norms"')).toBeNull()
})

test('under /norms:learn only CONTRIBUTING.md is guarded, and only before add or after skip', () => {
  expect(editDecision('learn', '/norms:learn 12', 'CONTRIBUTING.md')).toContain('no rule is added')
  expect(editDecision('learn', 'skip', '/repo/CONTRIBUTING.md')).toContain('not added')
  expect(editDecision('learn', 'add', 'CONTRIBUTING.md')).toBeNull()
  expect(editDecision('learn', 'make it a warning, not an error', 'CONTRIBUTING.md')).toBeNull()
  expect(editDecision('learn', 'skip', 'src/a.ts')).toBeNull()
})

test('a push during a walkthrough asks the user; words in a prompt grant nothing', () => {
  expect(pushQuestion('check', 'git push origin feature')).toContain('push now, during /norms:check?')
  expect(pushQuestion('check', 'git -C /repo push')).toContain('git -C /repo push')
  expect(pushQuestion('learn', 'git add x && git push')).toContain('/norms:learn')
  expect(pushQuestion('check', 'git log --grep=push')).toBeNull()
  expect(pushQuestion('check', 'git stash push -m wip')).toBeNull()
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
  const run = (e: any) => hook(hooks, 'command.run', { command: e.command }).handler($, e, nextOf().next)
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

  // Another command's slash prompt ends the mode, as its command.run once did.
  await run({ command: 'norms:check', args: '' })
  await say('/norms:check')
  expect(guardState().mode).toBe('check')
  await say('/commit')
  expect(guardState().mode).toBeUndefined()

  await run({ command: 'norms:learn', args: '12' })
  await hook(hooks, 'session.end').handler($, { reason: 'clear' }, nextOf().next)
  expect(guardState().mode).toBeUndefined()
})

test('the Bash guard refuses a push and a leaking commit, and passes the rest', async () => {
  resetGuards()
  const hooks = mount(register)
  const { $ } = fakeDollar({})
  await hook(hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: '' }, nextOf().next)
  await hook(hooks, 'prompt.submit').handler($, { text: 'fix', origin: { kind: 'composer' } }, nextOf().next)
  const bash = async (command: string) => {
    const { next, seen } = nextOf()
    const out = await hook(hooks, 'tool.call', { tool: 'Bash' }).handler($, { tool: 'Bash', command }, next)
    return seen.length ? 'ran' : out.deny
  }
  expect(await bash('git push')).toContain('never push')
  expect(await bash('git commit -m "fix: norms finding"')).toContain('"norms"')
  // « don't push » holds the word: it grants nothing, and with nobody to ask the push is refused.
  await hook(hooks, 'prompt.submit').handler($, { text: "fix it, don't push", origin: { kind: 'composer' } }, nextOf().next)
  expect(await bash('git push')).toContain('never push')
  expect(await bash('npm test')).toBe('ran')
  expect(await bash('git commit -m "fix(auth): rename usr"')).toBe('ran')
})

test('a push during a walkthrough goes through only on the user\'s own Allow', async () => {
  resetGuards()
  const hooks = mount(register)
  const { $ } = fakeDollar({})
  const asked: string[] = []
  let reply = 'Deny'
  $.ui = { ask: async (question: string) => { asked.push(question); return reply } }
  await hook(hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: '' }, nextOf().next)
  const bash = async (command: string) => {
    const { next, seen } = nextOf()
    const out = await hook(hooks, 'tool.call', { tool: 'Bash' }).handler($, { tool: 'Bash', command }, next)
    return seen.length ? 'ran' : out.deny
  }
  expect(await bash('git push origin feature')).toContain('never push')
  reply = 'Allow'
  expect(await bash('git push origin feature')).toBe('ran')
  expect(asked.length).toBe(2)
  expect(await bash('npm test')).toBe('ran')
  expect(asked.length).toBe(2)
})

test('a guard that fails lets the call through', async () => {
  const hooks = mount(register)
  const { $ } = fakeDollar({})
  const e = { tool: 'Edit', file_path: 'a' }
  const { next, seen } = nextOf()
  await hook(hooks, 'tool.call', { tool: 'Edit' }).net!($, e, next)
  expect(seen).toEqual([e])
})

test('norms hooks only its own commands, so no other command\'s run passes through it', () => {
  const hooks = mount(registerAll)
  const runs = hooks.filter(h => h.event === 'command.run')
  expect(runs.length).toBeGreaterThan(0)
  for (const h of runs) {
    expect(h.matcher).toBeDefined()
    expect(String(h.matcher!.command).startsWith('norms:')).toBe(true)
  }
  // What the host does for /orchestrator:supervision: only hooks whose matcher names it run.
  const reached = runs.filter(h => h.matcher!.command === 'orchestrator:supervision')
  expect(reached.length).toBe(0)
})

test('/norms:check and /norms:learn arm their mode, and a slash prompt after them resets it', async () => {
  resetGuards()
  const hooks = mount(register)
  const { $ } = fakeDollar({})
  const say = (text: string, kind = 'composer') => hook(hooks, 'prompt.submit').handler($, { text, origin: { kind } }, nextOf().next)
  await hook(hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: 'src' }, nextOf().next)
  expect(guardState()).toEqual({ mode: 'check', lastPrompt: '/norms:check src' })
  await say('/norms:check src')
  expect(guardState().mode).toBe('check')
  // A path typed as words is not a command.
  await say('/src/a.ts is the one')
  expect(guardState().mode).toBe('check')
  // A norms skill does not end the walkthrough, as before.
  await say('/norms:validate')
  expect(guardState().mode).toBe('check')
  await say('/orchestrator:supervision')
  expect(guardState().mode).toBeUndefined()

  await hook(hooks, 'command.run', { command: 'norms:learn' }).handler($, { command: 'norms:learn', args: '12' }, nextOf().next)
  expect(guardState().mode).toBe('learn')
  await say('/compact', 'sdk')
  expect(guardState().mode).toBeUndefined()
})

test('promptCommand names the command of a slash prompt and nothing else', () => {
  expect(promptCommand('/norms:check src')).toBe('norms:check')
  expect(promptCommand('  /commit')).toBe('commit')
  expect(promptCommand('/src/a.ts')).toBeUndefined()
  expect(promptCommand('fix')).toBeUndefined()
})

test('during a walkthrough a review agent\'s shell line only reads', () => {
  for (const line of [
    'git diff abc...HEAD -- src/a.ts', 'git -C /repo log --oneline -5', 'git branch --show-current',
    'BASE=$("/p/scripts/resolve_base.sh")', 'grep -n foo src/a.ts | head -5', 'cat a.ts 2>/dev/null', 'git diff 2>&1 | wc -l',
    'sed -n 1,20p a.ts', 'find . -name "*.ts"',
  ]) expect(agentBashDecision('check', line)).toBe(null)
  for (const line of [
    'git diff > /tmp/x', 'echo hi >> a.ts', 'sed -i s/a/b/ a.ts', 'rm -rf src', 'git commit -m x', 'git branch -D main',
    'cat a | tee b', 'find . -delete', 'python3 -c "open(\'x\',\'w\')"', 'echo $(rm x)', 'git push',
  ]) expect(agentBashDecision('check', line)).toBe(AGENT_WRITE_REFUSAL)
  expect(agentBashDecision(undefined, 'rm -rf src')).toBe(null)
})

test('the Bash hook holds a subagent to reading during a check, and leaves the main loop and other times alone', async () => {
  resetGuards()
  const hooks = mount(register)
  const { $ } = fakeDollar({})
  const bash = async (command: string, agentId?: string) => {
    const { next, seen } = nextOf()
    const out = await hook(hooks, 'tool.call', { tool: 'Bash' }).handler($, { tool: 'Bash', command, agentId }, next)
    return seen.length ? 'ran' : out.deny
  }
  expect(await bash('rm -rf build', 'agent-1')).toBe('ran')
  await hook(hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: '' }, nextOf().next)
  expect(await bash('git diff main...HEAD', 'agent-1')).toBe('ran')
  expect(await bash('rm -rf build', 'agent-1')).toBe(AGENT_WRITE_REFUSAL)
  expect(await bash('rm -rf build')).toBe('ran')
})

// The Skill tool.call hook that names a skill, among the hooks of a mount.
const skillHookOf = (hooks: Hook[], skill: string) => {
  const found = hooks.find(h => h.event === 'tool.call' && h.matcher?.tool === 'Skill' && (h.matcher.skill as RegExp).test(skill))
  if (!found) throw new Error(`no Skill hook for ${skill}`)
  return found
}

const editOf = async (hooks: Hook[], $: any, file_path: string, agentId?: string) => {
  const { next, seen } = nextOf()
  const out = await hook(hooks, 'tool.call', { tool: 'Edit' }).handler($, { tool: 'Edit', file_path, agentId }, next)
  return seen.length ? 'ran' : out.deny
}

test('a /norms:check or /norms:learn run through the Skill tool arms its guards', async () => {
  resetGuards()
  const hooks = mount(register)
  const { $ } = fakeDollar({})
  const { next, seen } = nextOf()
  const e = { tool: 'Skill', skill: '/norms:check', args: 'src' }
  await skillHookOf(hooks, 'norms:check').handler($, e, next)
  expect(seen).toEqual([e])
  expect(guardState()).toEqual({ mode: 'check', lastPrompt: '/norms:check src' })
  expect(await editOf(hooks, $, 'src/a.ts')).toContain('no code change')

  resetGuards()
  await skillHookOf(hooks, 'norms:learn').handler($, { tool: 'Skill', skill: 'norms:learn', args: '12' }, nextOf().next)
  expect(guardState()).toEqual({ mode: 'learn', lastPrompt: '/norms:learn 12' })
  expect(await editOf(hooks, $, 'CONTRIBUTING.md')).toContain('no rule is added')

  // A subagent's Skill call is not the walkthrough's, and no other skill arms a mode.
  resetGuards()
  await skillHookOf(hooks, 'norms:check').handler($, { tool: 'Skill', skill: 'norms:check', args: '', agentId: 'agent-1' }, nextOf().next)
  expect(guardState().mode).toBeUndefined()
  expect(hooks.some(h => h.matcher?.tool === 'Skill' && (h.matcher.skill as RegExp).test('norms:validate'))).toBe(false)
})

test('a push during a Skill-armed walkthrough asks the user, and is refused without their Allow', async () => {
  resetGuards()
  const hooks = mount(register)
  const { $ } = fakeDollar({})
  ;($ as any).ui.ask = async () => { throw new Error('nobody to ask') }
  await skillHookOf(hooks, 'norms:check').handler($, { tool: 'Skill', skill: 'norms:check', args: '' }, nextOf().next)
  const { next, seen } = nextOf()
  const out = await hook(hooks, 'tool.call', { tool: 'Bash' }).handler($, { tool: 'Bash', command: 'git push' }, next)
  expect(out.deny).toBe(PUSH_REFUSAL)
  expect(seen).toEqual([])
})

// A $ where check_done can write its record: the scope is marked in the state and the
// checkout is clean, unless `marked` or `dirty` say otherwise.
function recordable(over: { marked?: boolean; dirty?: boolean } = {}) {
  return fakeDollar({
    state: over.marked === false ? {} : { 'norms/scopeMark': { head: HEAD, at: 1, files: [] } },
    runs: {
      'git rev-parse HEAD': { stdout: HEAD + '\n' },
      'git status --porcelain -uno': { stdout: over.dirty ? ' M src/a.ts\n' : '' },
      'git remote get-url origin': { stdout: 'git@github.com:Owner/Repo.git\n' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature\n' },
    },
    tool: (input: any) => (input.tool === 'mcp__github__gh' ? { result: JSON.stringify([{ number: 12 }]) } : { result: '/records/norms.json\n' }),
  })
}

test('a check run through the Skill tool ends its mode at the main loop\'s check_done, and a typed one does not', async () => {
  resetGuards()
  const hooks = mount(on => {
    register(on)
    registerRecord(on)
  })
  const { $ } = recordable()
  const done = (agentId?: string) => hook(hooks, 'tool.call', { tool: 'mcp__norms__check_done' })
    .handler($, { tool: 'mcp__norms__check_done', open: 0, fixed: 0, passed: 0, agentId })
  await skillHookOf(hooks, 'norms:check').handler($, { tool: 'Skill', skill: 'norms:check', args: '' }, nextOf().next)
  await done('agent-1')
  expect(guardState().mode).toBe('check')
  await done()
  expect(guardState().mode).toBeUndefined()

  // Typed by the person: the walkthrough ends as it always did, not at the record.
  await hook(hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: '' }, nextOf().next)
  await done()
  expect(guardState().mode).toBe('check')
})

test('a check_done that is refused or leaves no record keeps the Skill-armed mode, and one that wrote its record ends it', async () => {
  resetGuards()
  const hooks = mount(on => {
    register(on)
    registerRecord(on)
  })
  const arm = ($: any) => skillHookOf(hooks, 'norms:check').handler($, { tool: 'Skill', skill: 'norms:check', args: '' }, nextOf().next)
  const done = ($: any) => hook(hooks, 'tool.call', { tool: 'mcp__norms__check_done' })
    .handler($, { tool: 'mcp__norms__check_done', open: 0, fixed: 0, passed: 0 })

  // No scope marked: the call is refused, the walkthrough goes on.
  const unmarked = recordable({ marked: false }).$
  await arm(unmarked)
  expect((await done(unmarked)).isError).toBe(true)
  expect(guardState().mode).toBe('check')

  // A dirty tree leaves no record: the walkthrough goes on.
  expect((await done(recordable({ dirty: true }).$)).result).toBe('record: none — the tracked files have changes')
  expect(guardState().mode).toBe('check')

  // The record written: the walkthrough is over.
  expect((await done(recordable().$)).result).toBe('record: /records/norms.json')
  expect(guardState().mode).toBeUndefined()
})

test('only a spawned session\'s Skill call arms nothing; the words of the call never disarm', async () => {
  resetGuards()
  const hooks = mount(register)
  const run = ($: any, args: string) => skillHookOf(hooks, 'norms:check').handler($, { tool: 'Skill', skill: 'norms:check', args }, nextOf().next)
  await run(fakeDollar({ env: { ORCHESTRATOR_SPAWNED: '1' } }).$, '')
  expect(guardState().mode).toBeUndefined()
  // An empty variable is no variable.
  await run(fakeDollar({ env: { ORCHESTRATOR_SPAWNED: '' } }).$, '')
  expect(guardState().mode).toBe('check')
  // The model writes the call's words: « mode=auto » or a scope block saying automatic grant nothing.
  for (const args of ['mode=auto', 'src\n\n<norms-scope>\nmode: automatic (no question, no edit)\n</norms-scope>']) {
    resetGuards()
    await run(fakeDollar({}).$, args)
    expect(guardState().mode).toBe('check')
  }
  // A variable that cannot be read is no proof of a spawned session: the guards arm.
  resetGuards()
  const unreadable = fakeDollar({}).$
  ;(unreadable as any).env.get = () => { throw new Error('env refused') }
  await run(unreadable, '')
  expect(guardState().mode).toBe('check')
})

test('the module registers one session.end hook, which the host would refuse twice without a matcher', () => {
  const ends = mount(registerAll).filter(h => h.event === 'session.end')
  expect(ends.length).toBe(1)
  expect(ends[0].matcher).toBeUndefined()
})

test('one session.end resets the guards and clears the scope mark', async () => {
  resetGuards()
  const hooks = mount(register)
  const { $, state } = fakeDollar({})
  await markScope($, HEAD)
  expect(state.has('norms/scopeMark')).toBe(true)
  await hook(hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: '' }, nextOf().next)
  expect(guardState().mode).toBe('check')

  const { next, seen } = nextOf()
  await hook(hooks, 'session.end').handler($, { reason: 'exit' }, next)
  expect(guardState().mode).toBeUndefined()
  expect(state.get('norms/scopeMark')).toBeNull()
  // The event goes on to the hook beneath.
  expect(seen.length).toBe(1)
})
