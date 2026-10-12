// hooks/tests/module.test.ts
// The tools, the Stop gate, the commands and the preflight, wired to the engine.
import { expect, test } from 'claude-code/testing'
import { act } from '../loop.ts'
import { PASSED_NOTE } from '../commands.ts'

const composer = { kind: 'composer' } as const
const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

// ── session.start ────────────────────────────────────────────────────────────

test('session.start lists both tools with their schemas from the start', async ($, on) => {
  const registered: any[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', (_$: any, e: any) => {
    registered.push(e)
    return { value: { tool: 'mcp__pr-review__' + e.name } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  expect(registered.map((t) => t.name)).toEqual(['open_comments', 'loop'])
  expect(registered.every((t) => t.isDeferred === false)).toBe(true)
  expect(registered[1].inputSchema.properties.action.enum).toContain('begin_pass')
})

test('one tool failing to register leaves the other listed', async ($, on) => {
  const registered: string[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', (_$: any, e: any) => {
    if (e.name === 'open_comments') throw new Error('refused')
    registered.push(e.name)
    return { value: { tool: 'mcp__pr-review__' + e.name } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  expect(registered).toEqual(['loop'])
})

// ── the preflight, once ──────────────────────────────────────────────────────

test('a skill reads that the preflight passed, and the preflight runs once per session', async ($, on) => {
  const runs: string[][] = []
  on('process.run', (_$: any, e: any) => {
    runs.push(e.argv)
    return { value: ok }
  })
  on('skill.prompt', () => ({ text: 'SKILL TEXT' }))
  const first: any = await $.skill.prompt({ skill: 'pr-review:process-comments', text: '' })
  const second: any = await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  expect(first.text).toBe(PASSED_NOTE + 'SKILL TEXT')
  expect(second.text).toBe(PASSED_NOTE + 'SKILL TEXT')
  expect(runs.length).toBe(1)
  expect(runs[0][1].endsWith('/scripts/preflight.sh')).toBe(true)
})

test('a failed preflight replaces the skill with its output and the stop', async ($, on) => {
  on('process.run', () => ({ value: { ...ok, exitCode: 10, stderr: 'error: required plugin not installed or not enabled: github@lounisbou\nfix:   /plugin install github@lounisbou' } }))
  on('skill.prompt', () => ({ text: 'SKILL TEXT' }))
  const out: any = await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  expect(out.text).toContain('stops here')
  expect(out.text).toContain('github@lounisbou')
  expect(out.text).toContain('exit 10')
  expect(out.text).not.toContain('SKILL TEXT')
})

test('a preflight that cannot run leaves the skill text as it was', async ($, on) => {
  on('process.run', () => ({ deny: 'bash: not found' }))
  on('skill.prompt', () => ({ text: 'SKILL TEXT' }))
  const out: any = await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  expect(out.text).toBe('SKILL TEXT')
})

test("another plugin's skill is left alone", async ($, on) => {
  const runs: unknown[] = []
  on('process.run', (_$: any, e: any) => {
    runs.push(e)
    return { value: ok }
  })
  on('skill.prompt', () => ({ text: 'OTHER' }))
  const out: any = await $.skill.prompt({ skill: 'github:github-curl', text: '' })
  expect(out.text).toBe('OTHER')
  expect(runs.length).toBe(0)
})

// ── doctor and install ───────────────────────────────────────────────────────

test('doctor answers with install.sh output and the remedy for its exit code, no turn', async ($, on) => {
  const runs: string[][] = []
  on('process.run', (_$: any, e: any) => {
    runs.push(e.argv)
    return { value: { ...ok, exitCode: 12, stderr: 'error: no GitHub token available\nfix:   gh auth login' } }
  })
  on('command.run', () => ({ text: 'MARKDOWN RAN' }))
  const out: any = await $.command.run({ command: 'pr-review:doctor', args: '' } as any)
  expect(out.text).toContain('no GitHub token available')
  expect(out.text).toContain('exit 12: no GitHub token: gh auth login')
  expect(runs[0][1].endsWith('/install.sh')).toBe(true)
})

test('install answers the same way on success', async ($, on) => {
  on('process.run', () => ({ value: { ...ok, stdout: 'pr-review: all dependencies satisfied.' } }))
  on('command.run', () => ({ text: 'MARKDOWN RAN' }))
  const out: any = await $.command.run({ command: 'pr-review:install', args: '' } as any)
  expect(out.text).toContain('all dependencies satisfied')
  expect(out.text).toContain('exit 0: everything satisfied')
})

test('a doctor that cannot run install.sh falls back to the markdown command', async ($, on) => {
  on('process.run', () => ({ deny: 'bash: not found' }))
  on('command.run', () => ({ text: 'MARKDOWN RAN' }))
  const out: any = await $.command.run({ command: 'pr-review:doctor', args: '' } as any)
  expect(out.text).toBe('MARKDOWN RAN')
})

// ── open_comments ────────────────────────────────────────────────────────────

const FIXTURES: Record<string, unknown> = {
  'pr-get': [{ number: 7, user: { login: 'author' }, title: 'T', html_url: 'u', body: 'b' }],
  'pr-issue-comments': [{ id: 1, node_id: 'IC_1', body: 'hi', user: { login: 'rev' } }],
  'pr-reviews': [{ node_id: 'PRR_1', body: 'body', user: { login: 'rev' } }],
  'pr-threads': [{ id: 'PRRT_1', path: 'a.ts', line: 3, comments: { nodes: [{ author: { login: 'rev' }, body: 'x' }] } }],
  'comments-resolved-batch': {},
}

function github(on: any, calls: any[], listed = true) {
  on('tool.list', () => ({ value: listed ? [{ name: 'mcp__github__gh' }] : [] }))
  on('tool.call', { tool: 'mcp__github__gh' }, (_$: any, e: any) => {
    calls.push({ command: e.command, args: e.args })
    return { result: JSON.stringify(FIXTURES[e.command] ?? null) }
  })
}

test('open_comments reads through the github tool and hands the bundle to triage.py', async ($, on) => {
  const calls: any[] = []
  const runs: any[] = []
  github(on, calls)
  on('process.run', (_$: any, e: any) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { ...ok, stdout: '{"pr": 7}' } }
  })
  const out: any = await $.tool.call({ tool: 'mcp__pr-review__open_comments' } as any)
  expect(out.result).toBe('{"pr": 7}')
  expect(calls.map((c) => c.command).sort()).toEqual(
    ['comments-resolved-batch', 'comments-resolved-batch', 'pr-get', 'pr-issue-comments', 'pr-reviews', 'pr-threads'],
  )
  expect(calls.find((c) => c.command === 'pr-threads').args).toEqual({ pr: 7, format: 'open-threads' })
  expect(calls.filter((c) => c.command === 'comments-resolved-batch').map((c) => c.args.nodes)).toEqual([['IC_1'], ['PRR_1']])
  expect(runs[0].argv.slice(-1)).toEqual(['--stdin'])
  expect(runs[0].argv[1].endsWith('/skills/process-comments/scripts/triage.py')).toBe(true)
  const bundle = JSON.parse(runs[0].stdin)
  expect(Object.keys(bundle).sort()).toEqual(['issue_comments', 'issue_resolved', 'pr', 'reviews', 'reviews_resolved', 'threads'])
})

test('open_comments with a PR number reads that PR', async ($, on) => {
  const calls: any[] = []
  github(on, calls)
  on('process.run', () => ({ value: { ...ok, stdout: '{}' } }))
  await $.tool.call({ tool: 'mcp__pr-review__open_comments', pr: 9 } as any)
  expect(calls[0]).toEqual({ command: 'pr-status', args: { pr: 9 } })
})

test('open_comments without the github tool points to the Bash route', async ($, on) => {
  const calls: any[] = []
  github(on, calls, false)
  const out: any = await $.tool.call({ tool: 'mcp__pr-review__open_comments' } as any)
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('Bash route')
  expect(calls.length).toBe(0)
})

test("open_comments reports the github tool's refusal as an error", async ($, on) => {
  on('tool.list', () => ({ value: [{ name: 'mcp__github__gh' }] }))
  on('tool.call', { tool: 'mcp__github__gh' }, () => ({ deny: 'refused by a permission rule' }))
  const out: any = await $.tool.call({ tool: 'mcp__pr-review__open_comments' } as any)
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('refused')
})

// ── the loop ─────────────────────────────────────────────────────────────────

test('the loop counts passes, sorts findings into new and seen, and ends clean', () => {
  act({ action: 'start', test_command: 'npm test' })
  expect(act({ action: 'begin_pass' }).pass).toBe(1)
  expect(act({ action: 'findings', keys: ['a.ts::x', 'b.ts::y'] }).new).toEqual(['a.ts::x', 'b.ts::y'])
  act({ action: 'fixed', key: 'a.ts::x', sha: 'abc', description: 'fix x' })
  expect(act({ action: 'begin_pass' }).pass).toBe(2)
  const second = act({ action: 'findings', keys: ['b.ts::y', 'c.ts::z'] })
  expect(second.seen).toEqual(['b.ts::y'])
  expect(second.new).toEqual(['c.ts::z'])
  act({ action: 'reverted', sha: 'abc' })
  const clean: any = act({ action: 'findings', keys: [] })
  expect(clean.exit).toBe('clean')
  expect(clean.fixes).toEqual([])
  expect(clean.reverted).toEqual([{ sha: 'abc', key: 'a.ts::x' }])
})

test('the loop ends after pass 5', () => {
  act({ action: 'start' })
  for (let i = 1; i <= 5; i++) {
    expect(act({ action: 'begin_pass' }).pass).toBe(i)
    act({ action: 'findings', keys: ['k' + i] })
  }
  const sixth: any = act({ action: 'begin_pass' })
  expect(sixth.exit).toBe('max_passes')
  expect(sixth.passes).toBe(5)
})

test('the Stop gate refuses a stop mid-loop once, naming the pass', async ($, on) => {
  on('classic.Stop', () => ({}))
  on('process.run', () => ({ value: ok }))
  on('skill.prompt', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ran' }))
  await $.skill.prompt({ skill: 'pr-review:auto-fix-loop', text: '' })
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'start' } as any)
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'begin_pass' } as any)
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'findings', keys: ['a::b', 'c::d'] } as any)
  const held: any = await $.classic.Stop({ stop_hook_active: false } as any)
  expect(held.block).toContain('pass 1/5')
  expect(held.block).toContain('2 finding(s)')
  const again: any = await $.classic.Stop({ stop_hook_active: true } as any)
  expect(again.block).toBeUndefined()
})

test('the Stop gate lets a clean loop stop', async ($, on) => {
  on('classic.Stop', () => ({}))
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'start' } as any)
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'begin_pass' } as any)
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'findings', keys: [] } as any)
  const out: any = await $.classic.Stop({ stop_hook_active: false } as any)
  expect(out.block).toBeUndefined()
})

test("the user's own prompt releases the loop's hold on a stop", async ($, on) => {
  on('classic.Stop', () => ({}))
  on('prompt.submit', (_$: any, e: any) => e)
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'start' } as any)
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'begin_pass' } as any)
  await $.prompt.submit({ text: 'stop, I need the terminal', wait: false, origin: composer })
  const out: any = await $.classic.Stop({ stop_hook_active: false } as any)
  expect(out.block).toBeUndefined()
})

test('an interrupted turn releases the loop', async ($, on) => {
  on('classic.Stop', () => ({}))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'start' } as any)
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'begin_pass' } as any)
  await $.turn.complete({ reason: 'aborted', answer: '', isAborted: true, turnId: 't', durationMs: 1 } as any)
  const out: any = await $.classic.Stop({ stop_hook_active: false } as any)
  expect(out.block).toBeUndefined()
})
