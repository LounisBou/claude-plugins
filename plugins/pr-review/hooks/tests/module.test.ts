// hooks/tests/module.test.ts
// The tools, the Stop gate, the commands and the preflight, wired to the engine.
import { expect, test } from 'claude-code/testing'
import { act, LOOP_SCHEMA } from '../loop.ts'
import { loop } from '../state.ts'
import { REPORT_REQUEST, reportOf } from '../report.ts'
import { INSTALL_TIMEOUT_MS, PASSED_NOTE } from '../commands.ts'

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

test('doctor answers with install.sh --check output and the remedy for its exit code, no turn', async ($, on) => {
  const runs: any[] = []
  on('process.run', (_$: any, e: any) => {
    runs.push(e)
    return { value: { ...ok, exitCode: 12, stderr: 'error: no GitHub token available\nfix:   /pr-review:install' } }
  })
  on('command.run', () => ({ text: 'MARKDOWN RAN' }))
  const out: any = await $.command.run({ command: 'pr-review:doctor', args: '' } as any)
  expect(out.text).toContain('no GitHub token available')
  expect(out.text).toContain('exit 12: no GitHub token: run /pr-review:install')
  expect(runs[0].argv[1].endsWith('/install.sh')).toBe(true)
  // doctor changes nothing: the login step is skipped.
  expect(runs[0].argv[2]).toBe('--check')
})

test('install runs the login step and waits for the browser', async ($, on) => {
  const runs: any[] = []
  on('process.run', (_$: any, e: any) => {
    runs.push(e)
    return { value: { ...ok, stdout: 'pr-review: all dependencies satisfied.' } }
  })
  on('command.run', () => ({ text: 'MARKDOWN RAN' }))
  const out: any = await $.command.run({ command: 'pr-review:install', args: '' } as any)
  expect(out.text).toContain('all dependencies satisfied')
  expect(out.text).toContain('exit 0: everything satisfied')
  expect(runs[0].argv.length).toBe(2)
  expect(runs[0].argv[1].endsWith('/install.sh')).toBe(true)
  expect(runs[0].init?.timeoutMs).toBe(INSTALL_TIMEOUT_MS)
})

test('a passing install does not stand for a skill preflight, which still checks the repository', async ($, on) => {
  const runs: string[][] = []
  on('process.run', (_$: any, e: any) => {
    runs.push(e.argv)
    return { value: ok }
  })
  on('command.run', () => ({ text: 'MARKDOWN RAN' }))
  on('skill.prompt', () => ({ text: 'SKILL TEXT' }))
  await $.command.run({ command: 'pr-review:install', args: '' } as any)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  expect(runs.length).toBe(2)
  expect(runs[1][1].endsWith('/scripts/preflight.sh')).toBe(true)
  expect(runs[1].length).toBe(2)
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
  loop.reports.push(null)
  expect(act({ action: 'findings', keys: ['a.ts::x', 'b.ts::y'] }).new).toEqual(['a.ts::x', 'b.ts::y'])
  act({ action: 'fixed', key: 'a.ts::x', sha: 'abc', description: 'fix x' })
  expect(act({ action: 'begin_pass' }).pass).toBe(2)
  loop.reports.push([])
  const second = act({ action: 'findings', keys: ['b.ts::y', 'c.ts::z'] })
  expect(second.seen).toEqual(['b.ts::y'])
  expect(second.new).toEqual(['c.ts::z'])
  act({ action: 'reverted', sha: 'abc' })
  loop.reports.push([])
  const clean: any = act({ action: 'findings', keys: [] })
  expect(clean.exit).toBe('clean')
  expect(clean.fixes).toEqual([])
  expect(clean.reverted).toEqual([{ sha: 'abc', key: 'a.ts::x' }])
})

test('a clean exit is computed: refused without an agent, with a silent agent, or against their findings', () => {
  act({ action: 'start' })
  act({ action: 'begin_pass' })
  expect(String((act({ action: 'findings', keys: [] }) as any).error)).toContain('no review agent ran')
  loop.reports.push([], null)
  expect(String((act({ action: 'findings', keys: [] }) as any).error)).toContain('1 of 2 review agents ended without their findings block')
  loop.reports.splice(0, 2, [{ severity: 'suggestion', file: 'a.ts', summary: 'x' }])
  expect(String((act({ action: 'findings', keys: [] }) as any).error)).toContain('reported 1 finding(s)')
  expect(loop.isActive).toBe(true)
})

test('the findings block is read from the last fenced json block, its shape checked', () => {
  const block = (body: string) => 'notes\n```json\n' + body + '\n```\n'
  expect(reportOf(block('{"findings": []}'))).toEqual([])
  expect(reportOf(block('{"findings": [{"severity": "Critical", "file": "a.ts", "summary": "x"}]}'))).toEqual([{ severity: 'critical', file: 'a.ts', summary: 'x' }])
  expect(reportOf(block('{"findings": [{"severity": "high"}]}'))).toBe(null)
  expect(reportOf(block('{"other": []}'))).toBe(null)
  expect(reportOf(block('{'))).toBe(null)
  expect(reportOf('no block at all')).toBe(null)
  expect(reportOf(block('{"findings": [{"severity": "important"}]}') + block('{"findings": []}'))).toEqual([])
})

test('findings before any pass are refused, so a loop cannot end clean without a review', () => {
  act({ action: 'start' })
  const early: any = act({ action: 'findings', keys: [] })
  expect(early.error).toContain('call begin_pass')
  expect(early.exit).toBeUndefined()
  expect(act({ action: 'begin_pass' }).pass).toBe(1)
})

test('the loop ends after pass 5', () => {
  act({ action: 'start' })
  for (let i = 1; i <= 5; i++) {
    expect(act({ action: 'begin_pass' }).pass).toBe(i)
    loop.reports.push(null)
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
  await $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review' } as any)
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'findings', keys: ['a::b', 'c::d'] } as any)
  const held: any = await $.classic.Stop({ stop_hook_active: false } as any)
  expect(held.block).toContain('pass 1/5')
  expect(held.block).toContain('2 finding(s)')
  const again: any = await $.classic.Stop({ stop_hook_active: true } as any)
  expect(again.block).toBeUndefined()
})

test('the Stop gate lets a clean loop stop', async ($, on) => {
  on('classic.Stop', () => ({}))
  on('tool.call', { tool: 'Agent' }, () => ({ result: '```json\n{"findings": []}\n```' }))
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'start' } as any)
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'begin_pass' } as any)
  await $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review' } as any)
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

// ── the review record at the loop's exit ─────────────────────────────────────

const WRITTEN = '/data/records/o/n/' + 'a'.repeat(40) + '/review.json'
const REVIEWED_HEAD = 'a'.repeat(40)

type Stubs = { records: any[]; prCalls: number; dirty?: string; pr?: string; branch?: string; pulls?: unknown; ghCalls?: any[]; listed?: string[]; recordAnswer?: any; recordThrows?: boolean; prompts?: string[]; launches?: unknown[]; agent?: (e: any) => any }

// A review agent's answer: its findings block, or none when `findings` is undefined.
const agentAnswer = (findings?: { severity: string }[]) =>
  'The review.\n' + (findings === undefined ? '' : '```json\n' + JSON.stringify({ findings: findings.map((f, i) => ({ file: 'f' + i, summary: 's', ...f })) }) + '\n```\n')

const review = ($: any, findings?: { severity: string }[]): Promise<any> =>
  $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review the diff', answer: agentAnswer(findings) } as any)

function wireRecord(on: any, stubs: Stubs) {
  on('tool.call', { tool: 'Agent' }, (_$: any, e: any) => {
    stubs.prompts?.push(String(e.prompt))
    return stubs.agent ? stubs.agent(e) : { result: e.answer }
  })
  on('tool.list', () => ({ value: (stubs.listed ?? ['mcp__github__gh', 'mcp__github__record']).map((name) => ({ name })) }))
  on('process.run', (_$: any, e: any) => {
    if (e.argv[1] === 'status') return { value: { ...ok, stdout: stubs.dirty ?? '' } }
    if (e.argv[1] === 'remote') return { value: { ...ok, stdout: 'git@github.com:LounisBou/claude-review.git\n' } }
    if (e.argv.join(' ') === 'git rev-parse --abbrev-ref HEAD') return { value: { ...ok, stdout: (stubs.branch ?? 'feature') + '\n' } }
    if (e.argv.join(' ') === 'git rev-parse HEAD') return { value: { ...ok, stdout: REVIEWED_HEAD + '\n' } }
    return { value: ok }
  })
  // pr-get answers the branch's pull request number; pr-list, the open pull requests as JSON.
  on('tool.call', { tool: 'mcp__github__gh' }, (_$: any, e: any) => {
    stubs.prCalls += 1
    stubs.ghCalls?.push({ command: e.command, args: e.args, repo: e.repo })
    if (e.command === 'pr-list') return typeof stubs.pulls === 'string' || stubs.pulls === undefined ? { result: stubs.pulls ?? '[]' } : stubs.pulls
    return { result: stubs.pr ?? '12\n' }
  })
  on('tool.call', { tool: 'mcp__github__record' }, (_$: any, e: any) => {
    if (stubs.recordThrows) throw new Error('boom')
    stubs.records.push({ pr: e.pr, repo: e.repo, kind: e.kind, result: e.result, detail: e.detail })
    return stubs.recordAnswer ?? { result: WRITTEN }
  })
}

const loopCall = ($: any, args: Record<string, unknown>): Promise<any> =>
  $.tool.call({ tool: 'mcp__pr-review__loop', ...args } as any)

// Each pass, one agent reports three findings, `blocking` of them Important; none reported without it.
async function runToMaxPasses($: any, blocking?: number): Promise<any> {
  await loopCall($, { action: 'start' })
  for (let i = 1; i <= 5; i++) {
    await loopCall($, { action: 'begin_pass' })
    await review($, blocking === undefined ? undefined : [0, 1, 2].map((n) => ({ severity: n < blocking ? 'important' : 'suggestion' })))
    await loopCall($, { action: 'findings', keys: ['a' + i, 'b' + i, 'c' + i] })
  }
  return loopCall($, { action: 'begin_pass' })
}

async function cleanLoop($: any): Promise<any> {
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  return loopCall($, { action: 'findings', keys: [] })
}

test('a clean exit writes a passing review record and says where', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  const out = await cleanLoop($)
  expect(stubs.records).toEqual([
    { pr: 12, repo: 'LounisBou/claude-review', kind: 'review', result: 'pass', detail: 'clean at pass 1, 1 review agents reporting no finding' },
  ])
  expect(String(out.result)).toContain('record: ' + WRITTEN)
  expect(String(out.result)).toContain('"exit": "clean"')
})

test('max_passes with no blocking finding left writes pass, with the leftover count', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  const out = await runToMaxPasses($, 0)
  expect(String(out.result)).toContain('"exit": "max_passes"')
  expect(stubs.records.length).toBe(1)
  expect(stubs.records[0].result).toBe('pass')
  expect(stubs.records[0].detail).toBe('3 findings left after 5 passes, none Critical or Important')
})

test('max_passes with blocking findings left writes fail', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await runToMaxPasses($, 2)
  expect(stubs.records.length).toBe(1)
  expect(stubs.records[0].result).toBe('fail')
  expect(stubs.records[0].detail).toBe('3 findings left after 5 passes, 2 Critical or Important')
})

test('the model\'s own count is not read: an agent without its block leaves the severity unknown', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  for (let i = 1; i <= 5; i++) {
    await loopCall($, { action: 'begin_pass' })
    await review($)
    await loopCall($, { action: 'findings', keys: ['k' + i] })
  }
  await loopCall($, { action: 'begin_pass' })
  expect(stubs.records[0].result).toBe('fail')
  expect(stubs.records[0].detail).toBe('1 findings left after 5 passes, severity unknown: no findings block from code-reviewer')
})

test('a review agent is asked for its block during a pass only', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, prompts: [] }
  wireRecord(on, stubs)
  await review($, [])
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($, [{ severity: 'important' }])
  await loopCall($, { action: 'findings', keys: ['a::b'] })
  await review($, [])
  expect(stubs.prompts).toEqual(['review the diff', 'review the diff' + REPORT_REQUEST, 'review the diff'])
})

test('max_passes without a blocking count writes fail, severity unknown', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await runToMaxPasses($)
  expect(stubs.records.length).toBe(1)
  expect(stubs.records[0].result).toBe('fail')
  expect(stubs.records[0].detail).toBe('3 findings left after 5 passes, severity unknown: no findings block from code-reviewer')
})

test('only the last pass decides the blocking count', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  for (let i = 1; i <= 5; i++) {
    await loopCall($, { action: 'begin_pass' })
    await review($, [{ severity: i === 5 ? 'suggestion' : 'critical' }])
    await loopCall($, { action: 'findings', keys: ['k' + i] })
  }
  await loopCall($, { action: 'begin_pass' })
  expect(stubs.records[0].result).toBe('pass')
  expect(stubs.records[0].detail).toBe('1 findings left after 5 passes, none Critical or Important')
})

test('a branch with no pull request leaves no record and says why', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, pr: '\n' }
  wireRecord(on, stubs)
  const out = await cleanLoop($)
  expect(stubs.records.length).toBe(0)
  expect(String(out.result)).toContain('record: none — the branch has no pull request')
  expect(String(out.result)).toContain('"exit": "clean"')
})

test('tracked files with changes leave no record, and the pull request is not even read', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, dirty: ' M hooks/loop.ts\n' }
  wireRecord(on, stubs)
  const out = await cleanLoop($)
  expect(stubs.records.length).toBe(0)
  expect(stubs.prCalls).toBe(0)
  expect(String(out.result)).toContain('record: none — the tracked files have changes')
})

test("the github tool's refusal is shown verbatim and the loop's answer is unchanged", async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, recordAnswer: { deny: "github: the checkout is at abc1234, the pull request's head is def5678" } }
  wireRecord(on, stubs)
  const out = await cleanLoop($)
  expect(out.isError).toBeUndefined()
  expect(String(out.result)).toContain("record: none — github: the checkout is at abc1234, the pull request's head is def5678")
  expect(String(out.result)).toContain('"exit": "clean"')
})

test("the github tool's error text is shown verbatim", async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, recordAnswer: { result: 'record.py: bad head', isError: true } }
  wireRecord(on, stubs)
  const out = await cleanLoop($)
  expect(out.isError).toBeUndefined()
  expect(String(out.result)).toContain('record: none — record.py: bad head')
})

test('a github plugin without the record tool leaves no record and says so', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, listed: ['mcp__github__gh'] }
  wireRecord(on, stubs)
  const out = await cleanLoop($)
  expect(stubs.records.length).toBe(0)
  expect(String(out.result)).toContain('record: none — the github plugin 0.12.0 or later is not available')
})

test('a record call that throws never throws out of the handler', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, recordThrows: true }
  wireRecord(on, stubs)
  const out = await cleanLoop($)
  expect(out.isError).toBeUndefined()
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(String(out.result)).toContain('record: none —')
})

test('a released loop writes no record', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  on('prompt.submit', (_$: any, e: any) => e)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await $.prompt.submit({ text: 'stop, I need the terminal', wait: false, origin: composer })
  const out = await loopCall($, { action: 'status' })
  expect(String(out.result)).toContain('"exit": "released"')
  expect(stubs.records.length).toBe(0)
  expect(stubs.prCalls).toBe(0)
})

test('one record per loop: calls after the exit write nothing more', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await cleanLoop($)
  const again = await loopCall($, { action: 'begin_pass' })
  await loopCall($, { action: 'status' })
  await loopCall($, { action: 'findings', keys: [] })
  expect(stubs.records.length).toBe(1)
  expect(String(again.result)).not.toContain('record:')
})

test('a new loop writes its own record', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await cleanLoop($)
  await cleanLoop($)
  expect(stubs.records.length).toBe(2)
})

test('a review agent that fails runs once, and its pass cannot end clean', async ($, on) => {
  let runs = 0
  on('tool.call', { tool: 'Agent' }, () => {
    runs += 1
    throw new Error('agent crashed')
  })
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  const out: any = await $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review' } as any)
  expect(out.isError).toBe(true)
  expect(runs).toBe(1)
  const answer = await loopCall($, { action: 'findings', keys: [] })
  expect(String(answer.result)).toContain('1 of 1 review agents ended without their findings block')
})

test('a reviewer\'s loop ends at its first findings, fixes nothing, and records them as the verdict', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($, [{ severity: 'important' }, { severity: 'suggestion' }])
  const out = await loopCall($, { action: 'findings', keys: ['a.ts::null deref', 'b.ts::naming'] })
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(stubs.records[0].result).toBe('fail')
  expect(stubs.records[0].detail).toBe('reviewed: 2 findings, 1 Critical or Important: a.ts::null deref; b.ts::naming')
})

test('a reviewer\'s loop with only suggestions passes, and a clean one passes as clean', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($, [{ severity: 'suggestion' }])
  await loopCall($, { action: 'findings', keys: ['b.ts::naming'] })
  expect(stubs.records[0]).toEqual({ pr: 12, repo: 'LounisBou/claude-review', kind: 'review', result: 'pass', detail: 'reviewed: 1 findings, none Critical or Important' })
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  await loopCall($, { action: 'findings', keys: [] })
  expect(stubs.records[1].result).toBe('pass')
})

test('a reviewer\'s loop whose agent gave no block records fail, severity unknown', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  await loopCall($, { action: 'findings', keys: ['a::b'] })
  expect(stubs.records[0].detail).toBe('reviewed: 1 findings, severity unknown: no findings block from code-reviewer')
})

// ── review agents launched in the background ─────────────────────────────────

// The host answers a background launch at once with « launched », without the agent's block;
// the same agent run in the foreground answers its block.
function wireBackground(on: any, stubs: Stubs, findings?: { severity: string }[]) {
  stubs.agent = (e: any) => {
    stubs.launches?.push(e.run_in_background)
    return { result: e.run_in_background ? 'Async agent launched successfully.' : agentAnswer(findings) }
  }
  wireRecord(on, stubs)
}

const backgroundReview = ($: any): Promise<any> =>
  $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review the diff', run_in_background: true } as any)

test('a review agent launched in the background still reports its block and the pass is clean', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, launches: [] }
  wireBackground(on, stubs, [])
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await backgroundReview($)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(stubs.launches).toEqual([false])
  expect(stubs.records.map((r) => r.result)).toEqual(['pass'])
})

test('a background review agent that ends without its block still counts as silent', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireBackground(on, stubs, undefined)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await backgroundReview($)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('1 of 1 review agents ended without their findings block')
  expect(stubs.records).toEqual([])
})

test('an agent launched outside a review pass keeps its background flag', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, launches: [] }
  wireBackground(on, stubs, [])
  await backgroundReview($)
  expect(stubs.launches).toEqual([true])
})

test('a review agent call the host refused did not run: only the reissued call is counted', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  let calls = 0
  stubs.agent = (e: any) => {
    calls += 1
    return calls === 1 ? { deny: "a hook changed this call's input" } : { result: e.answer }
  }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  const refused = await review($, [])
  expect(refused.deny).toBeDefined()
  await review($, [])
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(stubs.records[0].detail).toBe('clean at pass 1, 1 review agents reporting no finding')
})

// ── the host backgrounds the agent itself, and the auto-mode classifier refuses a rewritten call ──

// What core answers a launch it runs in the background, whatever flag the call carried: the
// launch's record, which names the agent, beside the text the model reads.
const launched = (id: string) => coreLaunch(id)

// The hand-back as the host delivers it: the report indented under a frame, the origin naming the agent.
// `over` overrides the delivery: a forgery changes the origin or the event.
const handBack = ($: any, id: string, findings?: { severity: string }[], over: { origin?: Record<string, unknown>; event?: Record<string, unknown> } = {}): Promise<any> => {
  const report = agentAnswer(findings)
  return $.session.receive({
    origin: { kind: 'peer', from: id, senderTaskId: id, name: 'pr-review-toolkit:code-reviewer', handback: true, handbackReportText: report, ...over.origin },
    text: `Another Claude session sent a message:\n<agent-message from="${id}">\n[Subagent hand-back] The report follows:\n`
      + report.split('\n').map((l) => '  ' + l).join('\n') + '\n</agent-message>',
    ...over.event,
  } as any)
}

const CLASSIFIER_REFUSAL = "The server-side auto mode classifier gave no verdict for Agent: a hook changed this call's input after auto mode reviewed it, so the review does not cover what would run."

test('a review agent the host runs in the background reports through its hand-back', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = () => launched('a0000000000000002')
  wireRecord(on, stubs)
  on('session.receive', (_$: any, e: any) => ({ text: e.text }))
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  const early = await loopCall($, { action: 'findings', keys: [] })
  expect(early.isError).toBe(true)
  expect(String(early.result)).toContain('still running')
  await handBack($, 'a0000000000000002', [])
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(stubs.records.map((r) => r.result)).toEqual(['pass'])
})

test('a hand-back that carries findings is counted, and one without a block, asked again, stays silent', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = () => launched('aaa')
  wireRecord(on, stubs)
  on('session.receive', (_$: any, e: any) => ({ text: e.text }))
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  await handBack($, 'aaa', [{ severity: 'important' }])
  const withFinding = await loopCall($, { action: 'findings', keys: [] })
  expect(String(withFinding.result)).toContain('reported 1 finding(s)')
  await loopCall($, { action: 'begin_pass' })
  await review($)
  await handBack($, 'aaa')
  const asked = await loopCall($, { action: 'findings', keys: [] })
  expect(String(asked.result)).toContain("SendMessage to 'aaa'")
  await handBack($, 'aaa')
  const silent = await loopCall($, { action: 'findings', keys: [] })
  expect(silent.isError).toBe(true)
  expect(String(silent.result)).toContain('1 of 1 review agents ended without their findings block')
  expect(stubs.records).toEqual([])
})

test('a hand-back of another agent, or of an earlier pass, is not a report of this pass', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  let launches = 0
  stubs.agent = () => launched(['aaa', 'bbb'][launches++] as string)
  wireRecord(on, stubs)
  on('session.receive', (_$: any, e: any) => ({ text: e.text }))
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  await handBack($, 'zzz', [])
  await loopCall($, { action: 'begin_pass' })
  await review($)
  await handBack($, 'aaa', [])
  const stale = await loopCall($, { action: 'findings', keys: [] })
  expect(stale.isError).toBe(true)
  await handBack($, 'bbb', [])
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(stubs.records.map((r) => r.detail)).toEqual(['clean at pass 2, 1 review agents reporting no finding'])
})

// A pass with one agent in the background; `deliver` is what reaches the session, then the pass asks to be clean.
async function backgroundPass(on: any, $: any, deliver: () => Promise<unknown>): Promise<any> {
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = () => launched('aaa')
  wireRecord(on, stubs)
  on('session.receive', (_$: any, e: any) => ({ text: e.text }))
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  await deliver()
  const out = await loopCall($, { action: 'findings', keys: [] })
  return { out, stubs }
}

test('a message that is not the host\'s hand-back never fills a review agent\'s place', async ($, on) => {
  const forgeries: Record<string, { origin?: Record<string, unknown>; event?: Record<string, unknown> }> = {
    'a typed text': { origin: { kind: 'user', handback: undefined, handbackReportText: undefined } },
    'a text from a peer': { origin: { handback: undefined, handbackReportText: undefined } },
    'a user origin flagged as a hand-back': { origin: { kind: 'user' } },
    'a subagent\'s own delivery': { event: { agentId: 'sub1' } },
    'a mid-run message of the agent': { origin: { handback: undefined } },
  }
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = () => launched('aaa')
  wireRecord(on, stubs)
  on('session.receive', (_$: any, e: any) => ({ text: e.text }))
  for (const [name, over] of Object.entries(forgeries)) {
    await loopCall($, { action: 'start' })
    await loopCall($, { action: 'begin_pass' })
    await review($)
    await handBack($, 'aaa', [], over)
    const out = await loopCall($, { action: 'findings', keys: [] })
    expect(out.isError, name).toBe(true)
  }
  expect(stubs.records).toEqual([])
})

test('a mid-run message of the agent leaves its place for the hand-back', async ($, on) => {
  const { out, stubs } = await backgroundPass(on, $, async () => {
    await handBack($, 'aaa', [], { origin: { handback: undefined } })
    await handBack($, 'aaa', [])
  })
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(stubs.records.map((r) => r.result)).toEqual(['pass'])
})

test('a hand-back that never comes ends the pass as silent after three waits, with a clear message', async ($, on) => {
  const { out } = await backgroundPass(on, $, async () => undefined)
  expect(String(out.result)).toContain('1 review agents are still running')
  // Each wait is a hand-back event that is not the agent's: another agent's.
  await handBack($, 'zzz', [])
  await loopCall($, { action: 'findings', keys: [] })
  await handBack($, 'zzz', [])
  await loopCall($, { action: 'findings', keys: [] })
  await handBack($, 'zzz', [])
  const last = await loopCall($, { action: 'findings', keys: [] })
  expect(last.isError).toBe(true)
  expect(String(last.result)).toContain('never handed back after 3 waits')
  const again = await loopCall($, { action: 'findings', keys: [] })
  expect(String(again.result)).toContain('1 of 1 review agents ended without their findings block')
})

test('a refusal other than the rewrite refusal is the agent\'s answer: silent, and the pass is not clean', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  let calls = 0
  stubs.agent = (e: any) => {
    calls += 1
    return calls === 1 ? { deny: 'blocked by policy' } : { result: e.answer }
  }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  await review($, [])
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('1 of 2 review agents ended without their findings block')
})

test('a call the classifier refused because the hook rewrote it did not run: the reissued call counts once', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  let calls = 0
  stubs.agent = (e: any) => {
    calls += 1
    return calls === 1 ? { result: CLASSIFIER_REFUSAL, isError: true } : { result: e.answer }
  }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  await review($, [])
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(stubs.records[0].detail).toBe('clean at pass 1, 1 review agents reporting no finding')
})

test('the hook rewrites a review call once: the reissued input comes back unchanged', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, prompts: [], launches: [] }
  stubs.agent = (e: any) => {
    stubs.launches?.push(e.run_in_background)
    return { result: e.answer }
  }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  const once = String(stubs.prompts?.[0])
  await $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: once, run_in_background: false, answer: agentAnswer([]) } as any)
  expect(stubs.prompts?.[1]).toBe(once)
  expect(once.split(REPORT_REQUEST).length).toBe(2)
})

// ── the answers core gives to an Agent call ──

// What `next(e)` of an Agent call resolves to from core: the tool's record in `result`, an object,
// and the text the model reads in `text`. A background launch.
const PASS2_AGENT = 'a0000000000000001'
const coreLaunch = (id: string) => ({
  ref: 1,
  result: {
    isAsync: true,
    status: 'async_launched',
    agentId: id,
    description: 'Review PR 42 whole range',
    resolvedModel: 'claude-opus-5-5',
    prompt: 'Read-only review of owner/web#42' + REPORT_REQUEST,
    outputFile: `/tmp/session/tasks/${id}.output`,
    canReadOutputFile: true,
    canContinueAgent: true,
  },
  text: 'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\n'
    + `agentId: ${id} (internal ID - do not mention to user. Use SendMessage with to: '${id}', summary: '<5-10 word recap>' to continue this agent.)\n`
    + 'The agent is working in the background. You will be notified automatically when it completes.',
})

// The same agent run in the foreground: core's record of a completed agent, its report in `content`.
const coreCompleted = (report: string, over: Record<string, unknown> = {}) => ({
  ref: 1,
  result: {
    agentId: PASS2_AGENT,
    agentType: 'pr-review-toolkit:code-reviewer',
    status: 'completed',
    prompt: 'Read-only review of owner/web#42' + REPORT_REQUEST,
    content: [{ type: 'text', text: report }],
    totalToolUseCount: 12,
    totalDurationMs: 64134,
    totalTokens: 70682,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
    ...over,
  },
  text: report,
})

// The end of the reviewer's report of pass 2, as its hand-back carried it.
const PASS2_REPORT = 'I found no issue that needs fixing in owner/web#42 (`origin/main...0123abcd`, 18 commits, 12 files).\n\n'
  + '**Minor points below the reporting threshold (no action needed):**\n- `mt-[3px]` in `Position.vue` is a hard-coded pixel value.\n\n'
  + 'Findings:\nNo findings\nCritical and Important: 0\n\n```json\n{"findings": []}\n```'

// The hand-back as `session.receive` received it: the origin as the transcript recorded it.
const coreHandBack = ($: any, id: string, report: string): Promise<any> => $.session.receive({
  origin: {
    kind: 'peer',
    from: id,
    senderTaskId: id,
    name: 'pr-review-toolkit:code-reviewer',
    body: '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The report follows:\n'
      + report.split('\n').map((l) => '  ' + l).join('\n'),
    handback: true,
    handbackReportText: report,
  },
  text: `Another Claude session sent a message:\n<agent-message from="${id}">\n[Subagent hand-back] The report follows:\n`
    + report.split('\n').map((l) => '  ' + l).join('\n') + '\n</agent-message>',
} as any)

// The full refusal of the reissued call's first form, as core answered it.
const coreRefusal = {
  ref: 1,
  result: 'Error: ' + CLASSIFIER_REFUSAL + ' The hook produced this input: {"description":"Review PR 42 whole range"}',
  text: CLASSIFIER_REFUSAL,
  isError: true,
}

test('a refused call, a background launch from core, its hand-back: the pass is clean', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  let calls = 0
  stubs.agent = () => (++calls === 1 ? coreRefusal : coreLaunch(PASS2_AGENT))
  wireRecord(on, stubs)
  on('session.receive', (_$: any, e: any) => ({ text: e.text }))
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  await review($)
  const early = await loopCall($, { action: 'findings', keys: [] })
  expect(String(early.result)).toContain('1 review agents are still running')
  await coreHandBack($, PASS2_AGENT, PASS2_REPORT)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(stubs.records.map((r) => r.result)).toEqual(['pass'])
})

test('a hand-back from core with findings counts like a block in the answer', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = () => coreLaunch(PASS2_AGENT)
  wireRecord(on, stubs)
  on('session.receive', (_$: any, e: any) => ({ text: e.text }))
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  await coreHandBack($, PASS2_AGENT, agentAnswer([{ severity: 'important' }]))
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('reported 1 finding(s)')
})

test('a background launch from core whose hand-back has no block, asked again, is silent', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = () => coreLaunch(PASS2_AGENT)
  wireRecord(on, stubs)
  on('session.receive', (_$: any, e: any) => ({ text: e.text }))
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  await coreHandBack($, PASS2_AGENT, 'No findings')
  const asked = await loopCall($, { action: 'findings', keys: [] })
  expect(String(asked.result)).toContain(`SendMessage to '${PASS2_AGENT}'`)
  await coreHandBack($, PASS2_AGENT, 'No findings')
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('1 of 1 review agents ended without their findings block')
  expect(stubs.records).toEqual([])
})

test('only the record\'s own agent id is awaited: a launch text without the record names no agent', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = () => ({ result: coreLaunch(PASS2_AGENT).text })
  wireRecord(on, stubs)
  on('session.receive', (_$: any, e: any) => ({ text: e.text }))
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  await coreHandBack($, PASS2_AGENT, PASS2_REPORT)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('1 of 1 review agents ended without their findings block')
})

test('a foreground agent completed in core reports its block from its own content', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = () => coreCompleted(PASS2_REPORT)
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
})

test('a foreground agent completed in core with findings, or with no block, is not clean', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  let calls = 0
  stubs.agent = () => coreCompleted(++calls === 1 ? agentAnswer([{ severity: 'critical' }]) : 'No findings')
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  const found = await loopCall($, { action: 'findings', keys: [] })
  expect(String(found.result)).toContain('reported 1 finding(s)')
  await loopCall($, { action: 'begin_pass' })
  await review($)
  const silent = await loopCall($, { action: 'findings', keys: [] })
  expect(String(silent.result)).toContain('1 of 1 review agents ended without their findings block')
})

test('a foreground agent that reported through its hand-back tool is read from that report', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = () => coreCompleted('This agent\'s report was delivered to you as a message.', { handback: 'send', handbackReport: { text: PASS2_REPORT } })
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
})

test('a flagged hand-back is read from its report like a sent one', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = () => coreCompleted('This agent\'s report was delivered to you as a message.', { handback: 'flagged', handbackReport: { text: agentAnswer([{ severity: 'important' }]) } })
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('reported 1 finding(s)')
})

test('a sent hand-back with no report text falls to the content, and is silent when it has none', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  let calls = 0
  stubs.agent = () => (++calls === 1
    ? coreCompleted(agentAnswer([{ severity: 'critical' }]), { handback: 'send' })
    : coreCompleted('No findings', { handback: 'send', content: undefined }))
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  const found = await loopCall($, { action: 'findings', keys: [] })
  expect(String(found.result)).toContain('reported 1 finding(s)')
  await loopCall($, { action: 'begin_pass' })
  await review($)
  const silent = await loopCall($, { action: 'findings', keys: [] })
  expect(String(silent.result)).toContain('1 of 1 review agents ended without their findings block')
})

test('a hand-back whose report was withheld is no report', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = () => coreCompleted('The report was withheld.', { handback: 'withheld', handbackReport: { text: PASS2_REPORT } })
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('1 of 1 review agents ended without their findings block')
})

// ── the reader's own hand-back, as the host runs it in the reader's loop ──

// A reader the host ran in the background reports by calling SubagentHandback in its own loop:
// the call carries the reader's id as `agentId` and its report as `message`, and core answers
// whether the report reached the caller. The shapes are the ones the transcripts of 2026-11-11 hold.
const READER = 'a0000000000000003'
const delivered = { ref: 1, result: { success: true, message: 'Report delivered to your caller.' }, text: '{"success":true,"message":"Report delivered to your caller."}' }
const notSent = { ref: 1, result: { success: false, message: 'Nothing was sent: an earlier report of yours was already delivered (SubagentHandback delivers one report), so this one did not reach your caller. Stop now.' }, text: 'Nothing was sent.' }

function wireHandBack(on: any, answer: unknown = delivered) {
  on('tool.call', { tool: 'SubagentHandback' }, () => answer)
}

const readerHandBack = ($: any, id: string, report: string): Promise<any> =>
  $.tool.call({ tool: 'SubagentHandback', agentId: id, message: report } as any)

// A reviewer's loop whose one reader the classifier refused for the rewrite, then ran in the background.
async function backgroundReviewerPass(on: any, $: any, stubs: Stubs): Promise<void> {
  let calls = 0
  stubs.agent = () => (++calls === 1 ? coreRefusal : coreLaunch(READER))
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  await review($)
}

test('a background reader\'s report is read from its SubagentHandback call: the reviewer\'s verdict is computed', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandBack(on)
  await backgroundReviewerPass(on, $, stubs)
  await readerHandBack($, READER, agentAnswer([{ severity: 'suggestion' }]))
  const out = await loopCall($, { action: 'findings', keys: ['f0::s'] })
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(stubs.records.map((r) => r.detail)).toEqual(['reviewed: 1 findings, none Critical or Important'])
})

test('a hand-back of another loop, or one that reached no caller, fills no reader\'s place', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandBack(on, notSent)
  await backgroundReviewerPass(on, $, stubs)
  await readerHandBack($, READER, agentAnswer([]))
  await $.tool.call({ tool: 'SubagentHandback', message: agentAnswer([]) } as any)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('1 review agents are still running')
  expect(stubs.records).toEqual([])
})

test('a background reader that ends without a hand-back is read from its last answer', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  await backgroundReviewerPass(on, $, stubs)
  await $.turn.complete({ agentId: READER, reason: 'answer', answer: agentAnswer([{ severity: 'important' }]), turnId: 't', durationMs: 1 } as any)
  await loopCall($, { action: 'findings', keys: ['f0::s'] })
  expect(stubs.records.map((r) => r.detail)).toEqual(['reviewed: 1 findings, 1 Critical or Important: f0::s'])
})

test('findings with keys wait for the readers still running: no verdict before their reports', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandBack(on)
  await backgroundReviewerPass(on, $, stubs)
  const early = await loopCall($, { action: 'findings', keys: ['f0::s'] })
  expect(early.isError).toBe(true)
  expect(String(early.result)).toContain('1 review agents are still running')
  expect(stubs.records).toEqual([])
  await readerHandBack($, READER, agentAnswer([{ severity: 'critical' }]))
  await loopCall($, { action: 'findings', keys: ['f0::s'] })
  expect(stubs.records.map((r) => r.result)).toEqual(['fail'])
  expect(stubs.records[0].detail).toContain('1 Critical or Important')
})

test('a reviewer\'s pass where no reader ran asks for the readers and records nothing', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = () => coreRefusal
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  const out = await loopCall($, { action: 'findings', keys: ['a.ts::x', 'b.ts::y'] })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('no review agent ran in this pass')
  expect(String(out.result)).toContain('launch the review agents')
  expect(stubs.records).toEqual([])
  const status = await loopCall($, { action: 'status' })
  expect(String(status.result)).toContain('"exit": null')
})

test('the Stop gate lets the turn end while the pass\'s readers run in the background', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  on('classic.Stop', () => ({}))
  wireHandBack(on)
  await backgroundReviewerPass(on, $, stubs)
  const waiting: any = await $.classic.Stop({ stop_hook_active: false } as any)
  expect(waiting.block).toBeUndefined()
  await readerHandBack($, READER, agentAnswer([]))
  const held: any = await $.classic.Stop({ stop_hook_active: false } as any)
  expect(held.block).toContain('pass 1/5')
})

test('the findings action takes no severity count from the model', () => {
  expect(Object.keys(LOOP_SCHEMA.properties)).not.toContain('blocking')
})

// ── the pull request of the record, in the repository named ──

const REPO = 'LounisBou/claude-review'
const openPull = (number: number, sha = REVIEWED_HEAD) => ({ number, head: { sha }, base: { ref: 'main' } })

test('the record reads the branch\'s pull request in the repository named, not the session\'s directory\'s', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, ghCalls: [] }
  wireRecord(on, stubs)
  await cleanLoop($)
  expect(stubs.ghCalls).toEqual([{ command: 'pr-get', args: { branch: 'feature', format: 'pr-number' }, repo: REPO }])
  expect(stubs.records.map((r) => [r.repo, r.pr])).toEqual([[REPO, 12]])
})

test('a detached review checkout records at the open pull request whose head it is', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, ghCalls: [], branch: 'HEAD', pulls: JSON.stringify([openPull(7, 'c'.repeat(40)), openPull(34)]) }
  wireRecord(on, stubs)
  await cleanLoop($)
  expect(stubs.ghCalls).toEqual([{ command: 'pr-list', args: {}, repo: REPO }])
  expect(stubs.records.map((r) => r.pr)).toEqual([34])
})

test('a detached head that several open pull requests have leaves no record, naming them', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, branch: 'HEAD', pulls: JSON.stringify([openPull(34), openPull(35)]) }
  wireRecord(on, stubs)
  const out = await cleanLoop($)
  expect(String(out.result)).toContain(`record: none — 2 open pull requests have the head ${REVIEWED_HEAD.slice(0, 12)}: ${REPO}#34, ${REPO}#35`)
  expect(stubs.records).toEqual([])
})

test('a detached head that no open pull request has leaves no record and says so', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, branch: 'HEAD', pulls: JSON.stringify([openPull(7, 'c'.repeat(40))]) }
  wireRecord(on, stubs)
  const out = await cleanLoop($)
  expect(String(out.result)).toContain(`record: none — no open pull request has the head ${REVIEWED_HEAD.slice(0, 12)}`)
  expect(stubs.records).toEqual([])
})

test('a pull request list the github tool refuses leaves no record, with its refusal', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, branch: 'HEAD', pulls: { deny: 'github: gh is not signed in' } }
  wireRecord(on, stubs)
  const out = await cleanLoop($)
  expect(String(out.result)).toContain('record: none — github: gh is not signed in')
  expect(stubs.records).toEqual([])
})

test('a branch with no pull request does not take the one at its head: that lookup is a detached head\'s', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, ghCalls: [], pr: '\n', pulls: JSON.stringify([openPull(34)]) }
  wireRecord(on, stubs)
  const out = await cleanLoop($)
  expect(String(out.result)).toContain('record: none — the branch has no pull request')
  expect(stubs.ghCalls?.map((c) => c.command)).toEqual(['pr-get'])
})

// ── a pass's verdict needs its readers ──

test('a fix loop\'s findings with no reader in the pass ask for the readers, and its exit records nothing', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  for (let i = 1; i <= 5; i++) {
    await loopCall($, { action: 'begin_pass' })
    const out = await loopCall($, { action: 'findings', keys: ['k' + i] })
    expect(out.isError).toBe(true)
    expect(String(out.result)).toContain('no review agent ran in this pass')
  }
  const status = await loopCall($, { action: 'status' })
  expect(String(status.result)).toContain('"seen": []')
  const last = await loopCall($, { action: 'begin_pass' })
  expect(String(last.result)).toContain('"exit": "max_passes"')
  expect(String(last.result)).toContain('record: none — the last pass has no findings its review agents reported')
  expect(stubs.records).toEqual([])
})

test('quick findings calls with no hand-back between them are one wait: the reader\'s report still counts', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandBack(on)
  await backgroundReviewerPass(on, $, stubs)
  for (let i = 0; i < 5; i++) {
    const early = await loopCall($, { action: 'findings', keys: ['f0::s'] })
    expect(String(early.result)).toContain('1 review agents are still running')
  }
  await readerHandBack($, READER, agentAnswer([{ severity: 'suggestion' }]))
  const out = await loopCall($, { action: 'findings', keys: ['f0::s'] })
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(stubs.records.map((r) => r.detail)).toEqual(['reviewed: 1 findings, none Critical or Important'])
})

test('findings with keys give up on a reader after three waits between other hand-backs', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandBack(on)
  await backgroundReviewerPass(on, $, stubs)
  let out: any
  for (let i = 0; i <= 3; i++) {
    out = await loopCall($, { action: 'findings', keys: ['f0::s'] })
    await readerHandBack($, 'a0000000000000099', agentAnswer([]))
  }
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('never handed back after 3 waits')
  expect(stubs.records).toEqual([])
})

test('a delivered hand-back of a foreign reader, or of none, fills no reader\'s place', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandBack(on)
  await backgroundReviewerPass(on, $, stubs)
  await readerHandBack($, 'a0000000000000099', agentAnswer([]))
  await $.tool.call({ tool: 'SubagentHandback', message: agentAnswer([]) } as any)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('1 review agents are still running')
  expect(stubs.records).toEqual([])
})

test('a background reader whose turn ends otherwise than with an answer is silent: the severity is unknown', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  await backgroundReviewerPass(on, $, stubs)
  await $.turn.complete({ agentId: READER, reason: 'error', answer: agentAnswer([]), turnId: 't', durationMs: 1 } as any)
  await loopCall($, { action: 'findings', keys: ['f0::s'] })
  await $.turn.complete({ agentId: READER, reason: 'error', answer: agentAnswer([]), turnId: 't', durationMs: 1 } as any)
  await loopCall($, { action: 'findings', keys: ['f0::s'] })
  expect(stubs.records.map((r) => [r.result, r.detail])).toEqual([['fail', 'reviewed: 1 findings, severity unknown: no findings block from code-reviewer']])
})

// ── a reviewer's pass as the transcripts of 2026-11-12 hold it ──

// The sequence of a reviewer's loop at owner/api#44 and owner/plugins#23 (pr-review 0.9.14): each
// reader's Agent call refused once for the hook's rewrite, reissued and launched in the background
// (core's `async_launched` record, its `agentId`), then each reader's own SubagentHandback call,
// `{agentId, message}`, answered `{success: true}`; `findings` comes after the last hand-back.
// Every hand-back reached the session, and one reader's carried no ```json block: that reader,
// not the timing, made the severity unknown. Core delivers one report per agent: a second
// SubagentHandback of the same agent is answered `{success: false}`.
const HUNTER = 'pr-review-toolkit:silent-failure-hunter'

// The silent-failure-hunter's two hand-backs that carried no block, shortened and anonymised.
const PROSE_NONE = 'No findings\n\nI read the whole diff `aaaa111..bbbb222` (src and tests). '
  + 'The points below are what I checked and why none of them is a finding.\n\n'
  + '- **Failed day:** the transaction rolls the day back and rethrows, so nothing is swallowed.'
const PROSE_LINES = '[important] engine/fmt.py:54 — key (name, app.id) merges distinct checks — verified — add the suite id to the key.\n'
  + '[suggestion] engine/fmt.py:54 — a string id compared to an int raises TypeError — coerce via int().'

// One reviewer's pass up to its first `findings`: each reader refused once, then launched with its
// id, then its hand-back, delivered the first time only.
async function transcriptPass(on: any, $: any, stubs: Stubs, readers: [string, string, string][], keys: string[]): Promise<any> {
  const refused = new Set<string>()
  stubs.agent = (e: any) => {
    const id = readers.find(([type]) => type === e.subagent_type)?.[1] ?? ''
    if (!refused.has(id)) {
      refused.add(id)
      return coreRefusal
    }
    return coreLaunch(id)
  }
  wireRecord(on, stubs)
  const handed = new Set<string>()
  on('tool.call', { tool: 'SubagentHandback' }, (_$: any, e: any) => {
    const first = !handed.has(e.agentId)
    handed.add(e.agentId)
    return first ? delivered : notSent
  })
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  for (const [type] of readers) await $.tool.call({ tool: 'Agent', subagent_type: type, description: 'Review', prompt: 'review the diff' } as any)
  for (const [type] of readers) await $.tool.call({ tool: 'Agent', subagent_type: type, description: 'Review', prompt: 'review the diff' + REPORT_REQUEST } as any)
  for (const [, id, report] of readers) await readerHandBack($, id, report)
  return loopCall($, { action: 'findings', keys })
}

const PASS_4CB = (hunter: string): [string, string, string][] => [
  ['pr-review-toolkit:code-reviewer', 'a0000000000000011', agentAnswer([])],
  [HUNTER, 'a0000000000000012', hunter],
  ['pr-review-toolkit:comment-analyzer', 'a0000000000000013', agentAnswer([{ severity: 'suggestion' }])],
  ['pr-review-toolkit:pr-test-analyzer', 'a0000000000000014', agentAnswer([{ severity: 'suggestion' }, { severity: 'suggestion' }])],
]
const KEYS_4CB = ['f0::a', 'f0::b', 'f1::c']

test('four background readers that all hand back a block: the reviewer records pass from their blocks', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  const out = await transcriptPass(on, $, stubs, PASS_4CB(agentAnswer([])), KEYS_4CB)
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(stubs.records.map((r) => [r.result, r.detail])).toEqual([['pass', 'reviewed: 3 findings, none Critical or Important']])
})

test('a reader whose hand-back is prose is asked once for its block, its place kept, and no record is written', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  const out = await transcriptPass(on, $, stubs, PASS_4CB(PROSE_NONE), KEYS_4CB)
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain(`${HUNTER} (agentId a0000000000000012) handed back no findings block: SendMessage to 'a0000000000000012' asking only for its closing \`\`\`json findings block`)
  expect(stubs.records).toEqual([])
  const again = await loopCall($, { action: 'findings', keys: KEYS_4CB })
  expect(String(again.result)).toContain('1 review agents are still running')
})

test('a reader asked again whose block comes in its refused second hand-back: the verdict is computed', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  await transcriptPass(on, $, stubs, PASS_4CB(PROSE_NONE), KEYS_4CB)
  const second = await readerHandBack($, 'a0000000000000012', agentAnswer([]))
  expect(second.result.success).toBe(false)
  const out = await loopCall($, { action: 'findings', keys: KEYS_4CB })
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(stubs.records.map((r) => [r.result, r.detail])).toEqual([['pass', 'reviewed: 3 findings, none Critical or Important']])
})

test('a reader asked again that answers its block at the end of its turn: the verdict is computed', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  await transcriptPass(on, $, stubs, PASS_4CB(PROSE_NONE), KEYS_4CB)
  await $.turn.complete({ agentId: 'a0000000000000012', reason: 'answer', answer: agentAnswer([{ severity: 'important' }]), turnId: 't', durationMs: 1 } as any)
  await loopCall($, { action: 'findings', keys: KEYS_4CB })
  expect(stubs.records.map((r) => r.result)).toEqual(['fail'])
  expect(stubs.records[0].detail).toBe('reviewed: 4 findings, 1 Critical or Important: f0::a; f0::b; f1::c')
})

test('a reader asked again that still hands back prose « No findings » is named in the record', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  await transcriptPass(on, $, stubs, PASS_4CB(PROSE_NONE), KEYS_4CB)
  await readerHandBack($, 'a0000000000000012', 'No findings')
  await loopCall($, { action: 'findings', keys: KEYS_4CB })
  expect(stubs.records.map((r) => [r.result, r.detail])).toEqual([['fail', `reviewed: 3 findings, severity unknown: no findings block from ${HUNTER}`]])
})

test('a reader asked again whose findings stay lines without the block is named in the record', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  const readers: [string, string, string][] = [
    ['pr-review-toolkit:code-reviewer', 'a0000000000000021', agentAnswer([{ severity: 'important' }, { severity: 'suggestion' }])],
    ['pr-review-toolkit:pr-test-analyzer', 'a0000000000000022', agentAnswer([{ severity: 'important' }])],
    [HUNTER, 'a0000000000000023', PROSE_LINES],
  ]
  const keys = ['a::1', 'a::2', 'b::3', 'c::4', 'c::5']
  await transcriptPass(on, $, stubs, readers, keys)
  await readerHandBack($, 'a0000000000000023', PROSE_LINES)
  await loopCall($, { action: 'findings', keys })
  expect(stubs.records.map((r) => [r.result, r.detail])).toEqual([['fail', `reviewed: 5 findings, severity unknown: no findings block from ${HUNTER}`]])
})

test('a fix loop\'s clean exit refused for a reader without its block names that reader', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  await $.tool.call({ tool: 'Agent', subagent_type: HUNTER, prompt: 'hunt', answer: PROSE_NONE } as any)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain(`1 of 2 review agents ended without their findings block (${HUNTER})`)
})

// ── only the review step's readers belong to a pass ──

test('a norms agent launched during an open pass is neither counted nor awaited, and keeps its call', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, prompts: [], launches: [] }
  stubs.agent = (e: any) => {
    stubs.launches?.push(e.run_in_background)
    return e.subagent_type === 'norms:norms-diff-scope' ? coreLaunch('a0000000000000031') : { result: e.answer }
  }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($, [{ severity: 'suggestion' }])
  await $.tool.call({ tool: 'Agent', subagent_type: 'norms:norms-diff-scope', prompt: 'norms', run_in_background: true } as any)
  await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', prompt: 'other', answer: 'prose' } as any)
  const out = await loopCall($, { action: 'findings', keys: ['f0::s'] })
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(stubs.prompts).toEqual(['review the diff' + REPORT_REQUEST, 'norms', 'other'])
  expect(stubs.launches).toEqual([false, true, undefined])
  expect(stubs.records.map((r) => [r.result, r.detail])).toEqual([['pass', 'reviewed: 1 findings, none Critical or Important']])
})

test('the block request overrides a reviewer prompt that allows prose « no findings »', () => {
  expect(REPORT_REQUEST).toContain('The block is due even then, in place of any prose such as "no findings" an earlier line allows.')
})
