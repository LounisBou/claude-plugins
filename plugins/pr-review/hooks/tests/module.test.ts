// hooks/tests/module.test.ts
// The tools, the commands and the preflight, wired to the engine.
import { expect, test } from 'claude-code/testing'
import type { Engine, NounEvents, Reply, TestOn } from 'claude-code/testing'
import { act, isTransient, LOOP_SCHEMA, verdict } from '../loop.ts'
import { loop } from '../state.ts'
import { REPORT_REQUEST, reportOf } from '../report.ts'
import { INSTALL_TIMEOUT_MS, PASSED_NOTE } from '../commands.ts'
import { observedAs, watchJournal } from './journal.ts'
import { fieldsOf, listOf, type Events, type ToolSpec } from '../../core/host.ts'

const composer = { kind: 'composer' } as const
const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

// ── session.start ────────────────────────────────────────────────────────────

test('session.start lists both tools with their schemas from the start', async ($, on) => {
  const registered: ToolSpec[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', (_$, e) => {
    registered.push(e)
    return { value: { tool: 'mcp__pr-review__' + e.name } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(registered.map((t) => t.name)).toEqual(['open_comments', 'loop'])
  expect(registered.every((t) => t.isDeferred === false)).toBe(true)
  expect(fieldsOf(fieldsOf(registered[1]?.inputSchema?.['properties'])?.['action'])?.['enum']).toContain('begin_pass')
})

test('one tool failing to register leaves the other listed', async ($, on) => {
  const registered: string[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', (_$, e) => {
    if (e.name === 'open_comments') throw new Error('refused')
    registered.push(e.name)
    return { value: { tool: 'mcp__pr-review__' + e.name } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(registered).toEqual(['loop'])
})

// ── the preflight, once ──────────────────────────────────────────────────────

test('a skill reads that the preflight passed, and the preflight runs once per session', async ($, on) => {
  const runs: (readonly string[])[] = []
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    return { value: ok }
  })
  on('skill.prompt', () => ({ text: 'SKILL TEXT' }))
  const first = await $.skill.prompt({ skill: 'pr-review:process-comments', text: '' })
  const second = await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  expect(first.text).toBe(PASSED_NOTE + 'SKILL TEXT')
  expect(second.text).toBe(PASSED_NOTE + 'SKILL TEXT')
  expect(runs.length).toBe(1)
  expect(runs[0]?.[1]?.endsWith('/scripts/preflight.sh')).toBe(true)
})

test('a failed preflight replaces the skill with its output and the stop', async ($, on) => {
  on('process.run', () => ({ value: { ...ok, exitCode: 10, stderr: 'error: required plugin not installed or not enabled: github@lounisbou\nfix:   /plugin install github@lounisbou' } }))
  on('skill.prompt', () => ({ text: 'SKILL TEXT' }))
  const out = await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  expect(out.text).toContain('stops here')
  expect(out.text).toContain('github@lounisbou')
  expect(out.text).toContain('exit 10')
  expect(out.text).not.toContain('SKILL TEXT')
})

test('a preflight that cannot run leaves the skill text as it was', async ($, on) => {
  on('process.run', () => ({ deny: 'bash: not found' }))
  on('skill.prompt', () => ({ text: 'SKILL TEXT' }))
  const out = await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  expect(out.text).toBe('SKILL TEXT')
})

test("another plugin's skill is left alone", async ($, on) => {
  const runs: unknown[] = []
  on('process.run', (_$, e) => {
    runs.push(e)
    return { value: ok }
  })
  on('skill.prompt', () => ({ text: 'OTHER' }))
  const out = await $.skill.prompt({ skill: 'github:github-curl', text: '' })
  expect(out.text).toBe('OTHER')
  expect(runs.length).toBe(0)
})

// ── doctor and install ───────────────────────────────────────────────────────

test('doctor answers with install.sh --check output and the remedy for its exit code, no turn', async ($, on) => {
  const runs: NounEvents['process.run'][] = []
  on('process.run', (_$, e) => {
    runs.push(e)
    return { value: { ...ok, exitCode: 12, stderr: 'error: no GitHub token available\nfix:   /pr-review:install' } }
  })
  on('command.run', () => ({ text: 'MARKDOWN RAN' }))
  const out = await $.command.run({ command: 'pr-review:doctor', args: '' })
  expect(out.text).toContain('no GitHub token available')
  expect(out.text).toContain('exit 12: no GitHub token: run /pr-review:install')
  expect(runs[0]?.argv[1]?.endsWith('/install.sh')).toBe(true)
  // doctor changes nothing: the login step is skipped.
  expect(runs[0]?.argv[2]).toBe('--check')
})

test('install runs the login step and waits for the browser', async ($, on) => {
  const runs: NounEvents['process.run'][] = []
  on('process.run', (_$, e) => {
    runs.push(e)
    return { value: { ...ok, stdout: 'pr-review: all dependencies satisfied.' } }
  })
  on('command.run', () => ({ text: 'MARKDOWN RAN' }))
  const out = await $.command.run({ command: 'pr-review:install', args: '' })
  expect(out.text).toContain('all dependencies satisfied')
  expect(out.text).toContain('exit 0: everything satisfied')
  expect(runs[0]?.argv.length).toBe(2)
  expect(runs[0]?.argv[1]?.endsWith('/install.sh')).toBe(true)
  expect(runs[0]?.init?.timeoutMs).toBe(INSTALL_TIMEOUT_MS)
})

test('a passing install does not stand for a skill preflight, which still checks the repository', async ($, on) => {
  const runs: (readonly string[])[] = []
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    return { value: ok }
  })
  on('command.run', () => ({ text: 'MARKDOWN RAN' }))
  on('skill.prompt', () => ({ text: 'SKILL TEXT' }))
  await $.command.run({ command: 'pr-review:install', args: '' })
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  expect(runs.length).toBe(2)
  expect(runs[1]?.[1]?.endsWith('/scripts/preflight.sh')).toBe(true)
  expect(runs[1]?.length).toBe(2)
})

test('a doctor that cannot run install.sh falls back to the markdown command', async ($, on) => {
  on('process.run', () => ({ deny: 'bash: not found' }))
  on('command.run', () => ({ text: 'MARKDOWN RAN' }))
  const out = await $.command.run({ command: 'pr-review:doctor', args: '' })
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

// A call of the github tool, as the fake reads it.
type GhCall = { command: unknown; args: unknown }

function github(on: TestOn, calls: GhCall[], listed = true) {
  on('tool.list', () => ({ value: listed ? [{ name: 'mcp__github__gh' }] : [] }))
  on('tool.call', { tool: 'mcp__github__gh' }, (_$, e) => {
    calls.push({ command: e['command'], args: e['args'] })
    return { result: JSON.stringify(FIXTURES[String(e['command'])] ?? null) }
  })
}

test('open_comments reads through the github tool and hands the bundle to triage.py', async ($, on) => {
  const calls: GhCall[] = []
  const runs: { argv: readonly string[]; stdin: string | undefined }[] = []
  github(on, calls)
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { ...ok, stdout: '{"pr": 7}' } }
  })
  const out = await $.tool.call({ tool: 'mcp__pr-review__open_comments' })
  expect(out.result).toBe('{"pr": 7}')
  expect(calls.map((c) => c.command).sort()).toEqual(
    ['comments-resolved-batch', 'comments-resolved-batch', 'pr-get', 'pr-issue-comments', 'pr-reviews', 'pr-threads'],
  )
  expect(calls.find((c) => c.command === 'pr-threads')?.args).toEqual({ pr: 7, format: 'open-threads' })
  // These three answer a few lines by default; the triage parses their objects.
  for (const command of ['pr-get', 'pr-issue-comments', 'pr-reviews']) {
    expect(fieldsOf(calls.find((c) => c.command === command)?.args)?.['format']).toBe('raw')
  }
  expect(calls.filter((c) => c.command === 'comments-resolved-batch').map((c) => fieldsOf(c.args)?.['nodes'])).toEqual([['IC_1'], ['PRR_1']])
  expect(runs[0]?.argv.slice(-1)).toEqual(['--stdin'])
  expect(runs[0]?.argv[1]?.endsWith('/skills/process-comments/scripts/triage.py')).toBe(true)
  const bundle = JSON.parse(String(runs[0]?.stdin))
  expect(Object.keys(bundle).sort()).toEqual(['issue_comments', 'issue_resolved', 'pr', 'reviews', 'reviews_resolved', 'threads'])
})

test('open_comments with a PR number reads that PR', async ($, on) => {
  const calls: GhCall[] = []
  github(on, calls)
  on('process.run', () => ({ value: { ...ok, stdout: '{}' } }))
  await $.tool.call({ tool: 'mcp__pr-review__open_comments', pr: 9 })
  expect(calls[0]).toEqual({ command: 'pr-status', args: { pr: 9, json: true } })
})

test('open_comments without the github tool points to the Bash route', async ($, on) => {
  const calls: GhCall[] = []
  github(on, calls, false)
  const out = await $.tool.call({ tool: 'mcp__pr-review__open_comments' })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('Bash route')
  expect(calls.length).toBe(0)
})

test("open_comments reports the github tool's refusal as an error", async ($, on) => {
  on('tool.list', () => ({ value: [{ name: 'mcp__github__gh' }] }))
  on('tool.call', { tool: 'mcp__github__gh' }, () => ({ deny: 'refused by a permission rule' }))
  const out = await $.tool.call({ tool: 'mcp__pr-review__open_comments' })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('refused')
})

// ── the loop ─────────────────────────────────────────────────────────────────

test('the loop counts passes, sorts findings into new and seen, and ends clean', () => {
  act({ action: 'start', test_command: 'npm test' })
  expect(act({ action: 'begin_pass' })['pass']).toBe(1)
  loop.reports.push(null)
  expect(act({ action: 'findings', keys: ['a.ts::x', 'b.ts::y'] })['new']).toEqual(['a.ts::x', 'b.ts::y'])
  act({ action: 'fixed', key: 'a.ts::x', sha: 'abc', description: 'fix x' })
  expect(act({ action: 'begin_pass' })['pass']).toBe(2)
  loop.reports.push([{ severity: 'important', file: 'c.ts', summary: 'z' }])
  const second = act({ action: 'findings', keys: ['b.ts::y', 'c.ts::z'] })
  expect(second['seen']).toEqual(['b.ts::y'])
  expect(second['new']).toEqual(['c.ts::z'])
  act({ action: 'reverted', sha: 'abc' })
  act({ action: 'begin_pass' })
  loop.reports.push([])
  const clean = act({ action: 'findings', keys: [] })
  expect(clean['exit']).toBe('clean')
  expect(clean['fixes']).toEqual([])
  expect(clean['reverted']).toEqual([{ sha: 'abc', key: 'a.ts::x' }])
})

test('a pass with only suggestions ends the loop clean, one with an Important finding goes on', () => {
  act({ action: 'start' })
  act({ action: 'begin_pass' })
  loop.reports.push([{ severity: 'suggestion', file: 'a.ts', summary: 'x' }, { severity: 'important', file: 'b.ts', summary: 'y' }])
  const goes = act({ action: 'findings', keys: ['a.ts::x', 'b.ts::y'] })
  expect(goes['exit']).toBeUndefined()
  expect(loop.isActive).toBe(true)
  act({ action: 'begin_pass' })
  loop.reports.push([{ severity: 'suggestion', file: 'a.ts', summary: 'x' }])
  const done = act({ action: 'findings', keys: ['a.ts::x'] })
  expect(done['exit']).toBe('clean')
  expect(loop.isActive).toBe(false)
})

test('a pass whose agents left no block does not end clean on the suggestions it names', () => {
  act({ action: 'start' })
  act({ action: 'begin_pass' })
  loop.reports.push(null)
  const out = act({ action: 'findings', keys: ['a.ts::x'] })
  expect(out['exit']).toBeUndefined()
  expect(loop.isActive).toBe(true)
})

test('a clean exit is computed: refused without an agent or against their findings, never given to a silent agent', () => {
  act({ action: 'start' })
  act({ action: 'begin_pass' })
  expect(String((act({ action: 'findings', keys: [] }))['error'])).toContain('no review agent ran')
  loop.reports.push([{ severity: 'suggestion', file: 'a.ts', summary: 'x' }])
  expect(String((act({ action: 'findings', keys: [] }))['error'])).toContain('reported 1 finding(s)')
  expect(loop.isActive).toBe(true)
  // An unreadable block is no refusal and no clean exit: the pass is accepted with its severity unknown.
  loop.reports.splice(0, 1, [], null)
  const silent = act({ action: 'findings', keys: [] })
  expect(silent['error']).toBeUndefined()
  expect(silent['exit']).toBeUndefined()
  expect(loop.isActive).toBe(true)
  expect(loop.lastBlocking).toBeUndefined()
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
  const early = act({ action: 'findings', keys: [] })
  expect(early['error']).toContain('call begin_pass')
  expect(early['exit']).toBeUndefined()
  expect(act({ action: 'begin_pass' })['pass']).toBe(1)
})

test('the loop ends after pass 3', () => {
  act({ action: 'start' })
  for (let i = 1; i <= 3; i++) {
    expect(act({ action: 'begin_pass' })['pass']).toBe(i)
    loop.reports.push(null)
    act({ action: 'findings', keys: ['k' + i] })
  }
  const sixth = act({ action: 'begin_pass' })
  expect(sixth['exit']).toBe('max_passes')
  expect(sixth['passes']).toBe(3)
})

test('a loop started in a session the orchestrator spawned, with no plan readable, runs the cap\'s three passes', async ($, on) => {
  spawnedEnv(on, '1')
  const started = await loopCall($, { action: 'start' })
  expect(String(started.result)).toContain('"max_passes": 3')
})

test('a loop started outside such a session keeps its three passes', async ($, on) => {
  spawnedEnv(on, '')
  const started = await loopCall($, { action: 'start' })
  expect(String(started.result)).toContain('"max_passes": 3')
})

const planAnswer = (review: unknown) => ({ result: JSON.stringify({ v: 1, repo: 'lounisbou/claude-review', pr: 12, review, at: '2026-11-14T09:00:00Z' }) })

test('a loop started in a session the orchestrator spawned runs the rounds its pull request\'s check plan gives', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, ghCalls: [], plan: planAnswer({ need: 'required', reason: '', max: 2 }) }
  wireRecord(on, stubs)
  spawnedEnv(on, '1')
  const started = await loopCall($, { action: 'start' })
  expect(String(started.result)).toContain('"max_passes": 2')
  expect(stubs.ghCalls?.find((c) => fieldsOf(c)?.['command'] === 'pr-plan')).toEqual({ command: 'pr-plan', args: { pr: 12 }, repo: 'LounisBou/claude-review' })
})

for (const need of ['one-pass', 'none']) {
  test('with a stored ' + need + ' plan, a loop the orchestrator spawned runs one pass', async ($, on) => {
    wireRecord(on, { records: [], prCalls: 0, plan: planAnswer({ need, reason: 'a typo' }) })
    spawnedEnv(on, '1')
    expect(String((await loopCall($, { action: 'start' })).result)).toContain('"max_passes": 1')
  })
}

for (const [label, plan] of [
  ['a plan silent on the review', planAnswer({ need: 'required', reason: '' })],
  ['a review given a word no plan holds', planAnswer({ need: 'maybe', reason: 'a typo' })],
  ['no plan', { result: 'no check plan for LounisBou/claude-review#12' }],
  ['a github without pr-plan', { deny: 'unknown command pr-plan' }],
] as const) {
  test('with ' + label + ', a loop the orchestrator spawned runs the cap\'s three passes', async ($, on) => {
    wireRecord(on, { records: [], prCalls: 0, plan })
    spawnedEnv(on, '1')
    expect(String((await loopCall($, { action: 'start' })).result)).toContain('"max_passes": 3')
  })
}

test('a plan of three rounds runs three passes', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, ghCalls: [], plan: planAnswer({ need: 'required', reason: '', max: 3 }) }
  wireRecord(on, stubs)
  spawnedEnv(on, '1')
  expect(String((await loopCall($, { action: 'start' })).result)).toContain('"max_passes": 3')
})

for (const rounds of [2, 1]) {
  test(`a plan of ${rounds} round(s) ends the loop at the pass after ${rounds}, below the cap, and writes no record`, async ($, on) => {
    const stubs: Stubs = { records: [], prCalls: 0, plan: planAnswer({ need: 'required', reason: '', max: rounds }) }
    wireRecord(on, stubs)
    spawnedEnv(on, '1')
    const out = await runToMaxPasses($, 2, rounds)
    expect(String(out.result)).toContain('"exit": "max_passes"')
    expect(String(out.result)).toContain(`"passes": ${rounds}`)
    expect(stubs.records).toEqual([])
    expect(String(out.result)).not.toContain('record:')
  })
}

test('outside a session the orchestrator spawned, the loop reads no check plan', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, ghCalls: [], plan: planAnswer({ need: 'required', reason: '', max: 2 }) }
  wireRecord(on, stubs)
  spawnedEnv(on, '')
  expect(String((await loopCall($, { action: 'start' })).result)).toContain('"max_passes": 3')
  expect(stubs.ghCalls).toEqual([])
})

test('a stop mid-loop goes through, and the journal keeps no line for it', async ($, on) => {
  on('classic.Stop', () => ({}))
  const journal = watchJournal(on)
  on('process.run', () => ({ value: ok }))
  on('skill.prompt', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ran' }))
  await $.skill.prompt({ skill: 'pr-review:auto-fix-loop', text: '' })
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'start' })
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'begin_pass' })
  await $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review' + REPORT_REQUEST })
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'findings', keys: ['a::b', 'c::d'] })
  const held = await $.classic.Stop({ stop_hook_active: false })
  expect(held['block']).toBeUndefined()
  expect(journal()).toEqual([])
  const again = await $.classic.Stop({ stop_hook_active: true })
  expect(again['block']).toBeUndefined()
  expect(journal()).toEqual([])
})

test('a clean loop stops with no line in the journal', async ($, on) => {
  on('classic.Stop', () => ({}))
  const journal = watchJournal(on)
  on('tool.call', { tool: 'Agent' }, () => ({ result: '```json\n{"findings": []}\n```' }))
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'start' })
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'begin_pass' })
  await $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review' + REPORT_REQUEST })
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'findings', keys: [] })
  const out = await $.classic.Stop({ stop_hook_active: false })
  expect(out['block']).toBeUndefined()
  expect(journal()).toEqual([])
})

test("the user's own prompt releases the loop's watch on a stop", async ($, on) => {
  on('classic.Stop', () => ({}))
  const journal = watchJournal(on)
  on('prompt.submit', (_$, e) => e)
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'start' })
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'begin_pass' })
  await $.prompt.submit({ text: 'stop, I need the terminal', wait: false, origin: composer })
  const out = await $.classic.Stop({ stop_hook_active: false })
  expect(out['block']).toBeUndefined()
  expect(journal()).toEqual([])
})

test('an interrupted turn releases the loop', async ($, on) => {
  on('classic.Stop', () => ({}))
  const journal = watchJournal(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'start' })
  await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'begin_pass' })
  await $.turn.complete({ reason: 'aborted', answer: '', isAborted: true, turnId: 't', durationMs: 1 })
  const out = await $.classic.Stop({ stop_hook_active: false })
  expect(out['block']).toBeUndefined()
  expect(journal()).toEqual([])
})

// ── the review record at the loop's exit ─────────────────────────────────────

const WRITTEN = '/data/records/o/n/' + 'a'.repeat(40) + '/review.json'
const REVIEWED_HEAD = 'a'.repeat(40)

type Stubs = { top?: string; cwds?: string[]; topFails?: boolean; records: Readonly<Record<string, unknown>>[]; prCalls: number; head?: string; remote?: string; dirty?: string; pr?: string; branch?: string; pulls?: unknown; ghCalls?: unknown[]; listed?: string[]; recordAnswer?: unknown; recordThrows?: boolean; recordFirst?: unknown[]; prFirst?: unknown[]; recordCalls?: number; plan?: unknown; sleeps?: string[]; prompts?: string[]; launches?: unknown[]; agent?: (e: Events['tool.call']) => unknown }

// A review agent's answer: its findings block, or none when `findings` is undefined.
const agentAnswer = (findings?: { severity: string }[]) =>
  'The review.\n' + (findings === undefined ? '' : '```json\n' + JSON.stringify({ findings: findings.map((f, i) => ({ file: 'f' + i, summary: 's', ...f })) }) + '\n```\n')

const review = ($: Engine, findings?: { severity: string }[]): Promise<Reply> =>
  $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review the diff' + REPORT_REQUEST, answer: agentAnswer(findings) })

function wireRecord(on: TestOn, stubs: Stubs) {
  on('tool.call', { tool: 'Agent' }, (_$, e) => {
    stubs.prompts?.push(String(e['prompt']))
    return stubs.agent ? stubs.agent(e) : { result: e['answer'] }
  })
  on('tool.list', () => ({ value: (stubs.listed ?? ['mcp__github__gh', 'mcp__github__record']).map((name) => ({ name })) }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'git') stubs.cwds?.push(e.argv.slice(1).join(' ') + ' @ ' + String(e.init?.cwd))
    if (e.argv.join(' ') === 'git rev-parse --show-toplevel') {
      return { value: stubs.topFails ? { ...ok, exitCode: 128, stderr: 'fatal: not a git repository' } : { ...ok, stdout: (stubs.top ?? '/clone/repo') + '\n' } }
    }
    if (e.argv[0] === 'sleep') stubs.sleeps?.push(String(e.argv[1]))
    if (e.argv[1] === 'status') return { value: { ...ok, stdout: stubs.dirty ?? '' } }
    if (e.argv[1] === 'remote') return { value: { ...ok, stdout: 'git@github.com:' + (stubs.remote ?? 'LounisBou/claude-review') + '.git\n' } }
    if (e.argv.join(' ') === 'git rev-parse --abbrev-ref HEAD') return { value: { ...ok, stdout: (stubs.branch ?? 'feature') + '\n' } }
    if (e.argv.join(' ') === 'git rev-parse HEAD') return { value: { ...ok, stdout: (stubs.head ?? REVIEWED_HEAD) + '\n' } }
    return { value: ok }
  })
  // pr-get answers the branch's pull request number; pr-list, the open pull requests as JSON.
  on('tool.call', { tool: 'mcp__github__gh' }, (_$, e) => {
    stubs.prCalls += 1
    stubs.ghCalls?.push({ command: e['command'], args: e['args'], repo: e['repo'] })
    if (e['command'] === 'pr-plan' && stubs.plan !== undefined) return stubs.plan
    if (e['command'] === 'pr-list') return typeof stubs.pulls === 'string' || stubs.pulls === undefined ? { result: stubs.pulls ?? '[]' } : stubs.pulls
    return stubs.prFirst?.shift() ?? { result: stubs.pr ?? '12\n' }
  })
  on('tool.call', { tool: 'mcp__github__record' }, (_$, e) => {
    if (stubs.recordThrows) throw new Error('boom')
    stubs.recordCalls = (stubs.recordCalls ?? 0) + 1
    const first = stubs.recordFirst?.shift()
    if (first !== undefined) return first
    stubs.records.push({ pr: e['pr'], repo: e['repo'], kind: e['kind'], result: e['result'], detail: e['detail'], dir: e['dir'] })
    return stubs.recordAnswer ?? { result: WRITTEN }
  })
}

const loopCall = ($: Engine, args: Record<string, unknown>): Promise<Reply> =>
  $.tool.call({ tool: 'mcp__pr-review__loop', ...args })

// Each pass, one agent reports three findings, `blocking` of them Important; none reported without it.
async function runToMaxPasses($: Engine, blocking?: number, passes = 3): Promise<Reply> {
  await loopCall($, { action: 'start' })
  for (let i = 1; i <= passes; i++) {
    await loopCall($, { action: 'begin_pass' })
    await review($, blocking === undefined ? undefined : [0, 1, 2].map((n) => ({ severity: n < blocking ? 'important' : 'suggestion' })))
    await loopCall($, { action: 'findings', keys: ['a' + i, 'b' + i, 'c' + i] })
  }
  return loopCall($, { action: 'begin_pass' })
}

// A reviewer's loop that ends clean: the one that writes a review record.
async function cleanLoop($: Engine): Promise<Reply> {
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  return loopCall($, { action: 'findings', keys: [] })
}

test('a clean exit writes a passing review record and says where', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  const out = await cleanLoop($)
  expect(stubs.records).toEqual([
    { pr: 12, repo: 'LounisBou/claude-review', kind: 'review', result: 'pass', detail: 'clean at pass 1, 1 review agents reporting no finding', dir: '/clone/repo' },
  ])
  expect(String(out.result)).toContain('record: ' + WRITTEN)
  expect(String(out.result)).toContain('"exit": "clean"')
})

test('the record names the checkout the loop started in, and git reads that one', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, cwds: [] }
  wireRecord(on, stubs)
  await cleanLoop($)
  expect(stubs.records.map((r) => fieldsOf(r)?.['dir'])).toEqual(['/clone/repo'])
  // Every git call after the start (the reviewed head, status, remote, branch) ran in it.
  const after = stubs.cwds!.slice(1)
  expect(after.map((c) => c.split(' @ ')[0])).toEqual(['rev-parse HEAD', 'status --porcelain -uno', 'remote get-url origin', 'rev-parse --abbrev-ref HEAD'])
  expect(after.filter((c) => !c.endsWith(' @ /clone/repo'))).toEqual([])
})

test('a detached head reads its commit in the checkout the loop started in', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, cwds: [], branch: 'HEAD', pulls: JSON.stringify([{ number: 12, head: { sha: REVIEWED_HEAD } }]) }
  wireRecord(on, stubs)
  await cleanLoop($)
  expect(stubs.records.map((r) => fieldsOf(r)?.['dir'])).toEqual(['/clone/repo'])
  expect(stubs.cwds!.slice(1).map((c) => c.split(' @ ')[0])).toContain('rev-parse HEAD')
  expect(stubs.cwds!.slice(1).filter((c) => !c.endsWith(' @ /clone/repo'))).toEqual([])
})

test('a loop that started outside a git checkout leaves no record and says why', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, topFails: true }
  wireRecord(on, stubs)
  const out = await cleanLoop($)
  expect(stubs.records).toEqual([])
  expect(String(out.result)).toContain('record: none — the loop started outside a git checkout (fatal: not a git repository)')
})

test('a fix loop writes no review record: a pass with only suggestions left ends it clean, none is written', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($, [{ severity: 'suggestion' }, { severity: 'suggestion' }])
  const out = await loopCall($, { action: 'findings', keys: ['a.ts::naming', 'b.ts::order'] })
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(String(out.result)).toContain('"passes": 1')
  expect(String(out.result)).not.toContain('record:')
  expect(stubs.records).toEqual([])
  expect(stubs.recordCalls).toBeUndefined()
})

test('a fix loop writes no review record at the pass limit either, whatever its readers reported', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  for (const blocking of [2, undefined]) {
    const out = await runToMaxPasses($, blocking)
    expect(String(out.result)).toContain('"exit": "max_passes"')
    expect(String(out.result)).not.toContain('record:')
  }
  expect(stubs.records).toEqual([])
  expect(stubs.recordCalls).toBeUndefined()
})

test('outside a pass, no reader prompt is refused or modified, and none is in a pass', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, prompts: [], launches: [] }
  stubs.agent = (e) => {
    stubs.launches?.push(e['run_in_background'])
    return { result: e['answer'] }
  }
  wireRecord(on, stubs)
  const outside = { tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review the diff', run_in_background: true, answer: agentAnswer([]) }
  const before = await $.tool.call(outside)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await $.tool.call({ ...outside, prompt: 'review the diff' + REPORT_REQUEST, answer: agentAnswer([{ severity: 'important' }]) })
  await loopCall($, { action: 'findings', keys: ['a::b'] })
  const after = await $.tool.call(outside)
  expect([before.deny, after.deny]).toEqual([undefined, undefined])
  expect(stubs.prompts).toEqual(['review the diff', 'review the diff' + REPORT_REQUEST, 'review the diff'])
  expect(stubs.launches).toEqual([true, true, true])
})

test('only the last pass decides the blocking count: earlier Critical findings do not hold the loop', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  let last: Reply | undefined
  for (let i = 1; i <= 3; i++) {
    await loopCall($, { action: 'begin_pass' })
    await review($, [{ severity: i === 3 ? 'suggestion' : 'critical' }])
    last = await loopCall($, { action: 'findings', keys: ['k' + i] })
  }
  expect(String(last?.result)).toContain('"exit": "clean"')
  expect(String(last?.result)).toContain('"passes": 3')
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
  on('prompt.submit', (_$, e) => e)
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
  const out = await $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review' + REPORT_REQUEST })
  expect(out.isError).toBe(true)
  expect(runs).toBe(1)
  const answer = await loopCall($, { action: 'findings', keys: [] })
  expect(answer.isError).toBeUndefined()
  expect(String(answer.result)).not.toContain('"exit": "clean"')
  expect(String((await loopCall($, { action: 'status' })).result)).toContain('"exit": null')
})

test('a reviewer\'s loop ends at its first findings, fixes nothing, and records them as the verdict', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($, [{ severity: 'important' }, { severity: 'suggestion' }])
  const out = await loopCall($, { action: 'findings', keys: ['a.ts::null deref', 'b.ts::naming'] })
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(fieldsOf(stubs.records[0])?.['result']).toBe('fail')
  expect(fieldsOf(stubs.records[0])?.['detail']).toBe('reviewed: 2 findings, 1 Critical or Important: a.ts::null deref; b.ts::naming')
})

test('a reviewer\'s loop with only suggestions passes, and a clean one passes as clean', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($, [{ severity: 'suggestion' }])
  await loopCall($, { action: 'findings', keys: ['b.ts::naming'] })
  expect(stubs.records[0]).toEqual({ pr: 12, repo: 'LounisBou/claude-review', kind: 'review', result: 'pass', detail: 'reviewed: 1 findings, none Critical or Important', dir: '/clone/repo' })
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  await loopCall($, { action: 'findings', keys: [] })
  expect(fieldsOf(stubs.records[1])?.['result']).toBe('pass')
})

test('a reviewer\'s loop whose agent gave no block records fail, severity unknown', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  await loopCall($, { action: 'findings', keys: ['a::b'] })
  expect(fieldsOf(stubs.records[0])?.['detail']).toBe('reviewed: 1 findings, severity unknown: no findings block from code-reviewer')
})

test('a reviewer\'s agent whose block is unreadable is a fail verdict, not a refusal, even with no key to report', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  await review($)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(out.isError).toBeUndefined()
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(stubs.records.map((r) => [fieldsOf(r)?.['result'], fieldsOf(r)?.['detail']])).toEqual([['fail', 'reviewed: 0 findings, severity unknown: no findings block from code-reviewer']])
})

test('a fix loop\'s agent whose block is unreadable is no refusal and no clean exit: the loop goes on, with no record', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(out.isError).toBeUndefined()
  expect(String(out.result)).not.toContain('"exit"')
  expect(String(out.result)).toContain('call begin_pass: the loop goes on')
  expect(String(out.result)).toContain('"unread": "severity unknown: no findings block from code-reviewer"')
  const next = await loopCall($, { action: 'begin_pass' })
  expect(String(next.result)).toContain('"pass": 2')
  expect(stubs.records).toEqual([])
})

// ── review agents launched in the background ─────────────────────────────────

// The host answers a background launch at once with « launched », without the agent's block;
// the same agent run in the foreground answers its block.
function wireBackground(on: TestOn, stubs: Stubs, findings?: { severity: string }[]) {
  stubs.agent = (e) => {
    stubs.launches?.push(e['run_in_background'])
    return { result: e['run_in_background'] ? 'Async agent launched successfully.' : agentAnswer(findings) }
  }
  wireRecord(on, stubs)
}

const backgroundReview = ($: Engine): Promise<Reply> =>
  $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review the diff' + REPORT_REQUEST, run_in_background: true })

// A background reader of a pass: the host answers its launch with core's record, and the agent
// hands its report back by calling SubagentHandback in its own loop; core says whether it arrived.
function wireHandback(on: TestOn, stubs: Stubs, answer: unknown = { result: { success: true } }) {
  stubs.agent = (e) => (e['run_in_background'] ? coreLaunch(String(e['description'])) : { result: agentAnswer([]) })
  wireRecord(on, stubs)
  on('tool.call', { tool: 'SubagentHandback' }, () => answer)
}

const launchReader = ($: Engine, id: string, type = 'code-reviewer'): Promise<Reply> =>
  $.tool.call({ tool: 'Agent', subagent_type: type, prompt: 'review the diff' + REPORT_REQUEST, run_in_background: true, description: id })

const handBack = ($: Engine, id: string, message: unknown): Promise<Reply> =>
  $.tool.call({ tool: 'SubagentHandback', agentId: id, message })

test('a background reader whose hand-back carries a clean block passes the pass', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1')
  await handBack($, 'a1', PASS2_REPORT)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(out.isError).toBeUndefined()
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(stubs.records.map((r) => fieldsOf(r)?.['result'])).toEqual(['pass'])
})

test('a background reader whose hand-back carries no block is a fail verdict, no refusal', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1')
  await handBack($, 'a1', 'No findings')
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(out.isError).toBeUndefined()
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(stubs.records.map((r) => [fieldsOf(r)?.['result'], fieldsOf(r)?.['detail']])).toEqual([['fail', 'reviewed: 0 findings, severity unknown: no findings block from code-reviewer']])
})

test('the verdict waits for every launched reader: findings before a hand-back ends nothing and is no error', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1')
  await launchReader($, 'a2')
  await handBack($, 'a1', PASS2_REPORT)
  const early = await loopCall($, { action: 'findings', keys: [] })
  expect(early.isError).toBeUndefined()
  expect(String(early.result)).toContain('"pending": 1')
  expect(String(early.result)).not.toContain('"exit"')
  expect(stubs.records).toEqual([])
  await handBack($, 'a2', agentAnswer([{ severity: 'important' }]))
  const out = await loopCall($, { action: 'findings', keys: ['f0::s'] })
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(stubs.records.map((r) => fieldsOf(r)?.['result'])).toEqual(['fail'])
})

test('a hand-back that reached no one, or came from no reader of the pass, fills no place', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs, { result: { success: false } })
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1')
  await handBack($, 'a1', PASS2_REPORT)
  await handBack($, 'other', PASS2_REPORT)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"pending": 1')
})

test('a hand-back that comes before its launch is registered is kept for it', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await handBack($, 'a1', PASS2_REPORT)
  await launchReader($, 'a1')
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
})

test('a pending answer counts the readers still awaited and names them', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1')
  await launchReader($, 'a2', 'orchestrator:lens')
  const out = await loopCall($, { action: 'findings', keys: [] })
  const answer = fieldsOf(JSON.parse(String(out.result)))
  expect(answer?.['pending']).toBe(2)
  expect(answer?.['awaited']).toEqual(['code-reviewer', 'orchestrator:lens'])
})

test('a hand-back of a foreign id, with no id, or whose message is no string fills no place', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1')
  await handBack($, 'zzz', PASS2_REPORT)
  await handBack($, '', PASS2_REPORT)
  await $.tool.call({ tool: 'SubagentHandback', message: PASS2_REPORT })
  await handBack($, 'a1', 42)
  await handBack($, 'a1', undefined)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(fieldsOf(JSON.parse(String(out.result)))?.['pending']).toBe(1)
})

test('several background readers handed back in a crossed order each fill their own place', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1', 'code-reviewer')
  await launchReader($, 'a2', 'pr-review-toolkit:silent-failure-hunter')
  await launchReader($, 'a3', 'orchestrator:lens')
  await handBack($, 'a3', 'No findings')
  await handBack($, 'a1', agentAnswer([{ severity: 'important' }]))
  await handBack($, 'a2', PASS2_REPORT)
  const out = await loopCall($, { action: 'findings', keys: ['f0::s'] })
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(stubs.records.map((r) => [fieldsOf(r)?.['result'], fieldsOf(r)?.['detail']])).toEqual([['fail', 'reviewed: 1 findings, severity unknown: no findings block from orchestrator:lens']])
})

test('several background readers all clean, handed back in a crossed order, pass the pass', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1')
  await launchReader($, 'a2', 'orchestrator:lens')
  await launchReader($, 'a3', 'pr-review-toolkit:silent-failure-hunter')
  await handBack($, 'a2', PASS2_REPORT)
  await handBack($, 'a3', PASS2_REPORT)
  await handBack($, 'a1', PASS2_REPORT)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(stubs.records.map((r) => fieldsOf(r)?.['detail'])).toEqual(['clean at pass 1, 3 review agents reporting no finding'])
})

test('a hand-back kept for a launch is forgotten by the next pass', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await handBack($, 'a1', PASS2_REPORT)
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1')
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(fieldsOf(JSON.parse(String(out.result)))?.['pending']).toBe(1)
})

test('a hand-back kept for a launch is forgotten by a new loop, and so is a reader awaited', () => {
  act({ action: 'start' })
  act({ action: 'begin_pass' })
  loop.awaiting.set('a1', 0)
  loop.early.set('a2', [])
  act({ action: 'start' })
  expect(loop.awaiting.size).toBe(0)
  expect(loop.early.size).toBe(0)
})

test('a second pass forgets the hand-backs kept for a launch', () => {
  act({ action: 'start' })
  act({ action: 'begin_pass' })
  loop.early.set('a2', [])
  act({ action: 'begin_pass' })
  expect(loop.early.size).toBe(0)
})

test('a hand-back after the loop was released fills no place', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  on('prompt.submit', (_$, e) => e)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1')
  await $.prompt.submit({ text: 'stop, I need the terminal', wait: false, origin: composer })
  await handBack($, 'a1', PASS2_REPORT)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).not.toContain('"exit": "clean"')
  expect(String(out.result)).toContain('"unread"')
})

test('a hand-back after the pass was accepted fills no place of the next pass', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1')
  await handBack($, 'a1', agentAnswer([{ severity: 'important' }]))
  await loopCall($, { action: 'findings', keys: ['f0::s'] })
  await handBack($, 'a2', PASS2_REPORT)
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a2')
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(fieldsOf(JSON.parse(String(out.result)))?.['pending']).toBe(1)
})

test('a late hand-back of an earlier pass fills no place of the next one', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1')
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a2')
  await handBack($, 'a1', PASS2_REPORT)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"pending": 1')
})

test('a released loop is not held by a reader still awaited', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  on('prompt.submit', (_$, e) => e)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1')
  await $.prompt.submit({ text: 'stop, I need the terminal', wait: false, origin: composer })
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).not.toContain('"pending"')
})

test('a fix loop\'s background reader hand-back with a clean block ends the loop clean', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireHandback(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await launchReader($, 'a1')
  await handBack($, 'a1', PASS2_REPORT)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(stubs.records).toEqual([])
})

test('a second pass forgets the readers the last pass still awaited', () => {
  act({ action: 'start' })
  act({ action: 'begin_pass' })
  loop.awaiting.set('a1', 0)
  act({ action: 'begin_pass' })
  expect(loop.awaiting.size).toBe(0)
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
  stubs.agent = (e) => {
    calls += 1
    return calls === 1 ? { deny: "a hook changed this call's input" } : { result: e['answer'] }
  }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  const refused = await review($, [])
  expect(refused.deny).toBeDefined()
  await review($, [])
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(fieldsOf(stubs.records[0])?.['detail']).toBe('clean at pass 1, 1 review agents reporting no finding')
})

// ── the auto-mode classifier refuses a rewritten call ──

const CLASSIFIER_REFUSAL = "The server-side auto mode classifier gave no verdict for Agent: a hook changed this call's input after auto mode reviewed it, so the review does not cover what would run."

test('a refusal other than the rewrite refusal is the agent\'s answer: silent, and the pass is not clean', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  let calls = 0
  stubs.agent = (e) => {
    calls += 1
    return calls === 1 ? { deny: 'blocked by policy' } : { result: e['answer'] }
  }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  await review($, [])
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(out.isError).toBeUndefined()
  expect(String(out.result)).not.toContain('"exit": "clean"')
})

test('a call the classifier refused because the hook rewrote it did not run: the reissued call counts once', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  let calls = 0
  stubs.agent = (e) => {
    calls += 1
    return calls === 1 ? { result: CLASSIFIER_REFUSAL, isError: true } : { result: e['answer'] }
  }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  await review($, [])
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
  expect(fieldsOf(stubs.records[0])?.['detail']).toBe('clean at pass 1, 1 review agents reporting no finding')
})

test('a review call issued twice with the same input reaches the agent unchanged both times', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, prompts: [] }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  await $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review the diff' + REPORT_REQUEST, run_in_background: false, answer: agentAnswer([]) })
  expect(stubs.prompts).toEqual(['review the diff' + REPORT_REQUEST, 'review the diff' + REPORT_REQUEST])
})

// ── the hook never changes a reader's input: auto mode refuses a call a hook rewrote ──

const READER_FIELDS = ['subagent_type', 'description', 'prompt', 'run_in_background'] as const
const readerFieldsOf = (e: Readonly<Record<string, unknown>>) => Object.fromEntries(READER_FIELDS.map((k) => [k, e[k]]))

test('a reader call that carries the request goes through with its input unchanged', async ($, on) => {
  const seen: unknown[] = []
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = (e) => {
    seen.push(readerFieldsOf(e))
    return e['run_in_background'] ? coreLaunch('a0000000000000041') : { result: agentAnswer([]) }
  }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  const issued = [
    { subagent_type: 'code-reviewer', description: 'Review', prompt: 'review the diff' + REPORT_REQUEST, run_in_background: true },
    { subagent_type: 'orchestrator:lens', description: 'Lens', prompt: 'lens' + REPORT_REQUEST.replace(/\s+/g, ' '), run_in_background: false },
  ]
  for (const call of issued) {
    const out = await $.tool.call({ tool: 'Agent', ...call })
    expect(out.deny).toBeUndefined()
  }
  expect(seen).toEqual(issued)
})

test('a reader call without the request runs, and the journal keeps one line for it', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, prompts: [] }
  wireRecord(on, stubs)
  const journal = watchJournal(on)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  const ran = await $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review the diff', answer: agentAnswer([]) })
  expect(ran.deny).toBeUndefined()
  expect(stubs.prompts).toEqual(['review the diff'])
  expect(journal()).toMatchObject([observedAs('pr-review.reader.no-request')])
  await review($, [])
  expect(journal().length).toBe(1)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(String(out.result)).toContain('"exit": "clean"')
})

test('begin_pass hands the session the request its readers\' prompts end with', async () => {
  act({ action: 'start' })
  const pass = act({ action: 'begin_pass' })
  expect(pass['report_request']).toBe(REPORT_REQUEST.trim())
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

// The full refusal of the reissued call's first form, as core answered it.
const coreRefusal = {
  ref: 1,
  result: 'Error: ' + CLASSIFIER_REFUSAL + ' The hook produced this input: {"description":"Review PR 42 whole range"}',
  text: CLASSIFIER_REFUSAL,
  isError: true,
}

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
  expect(silent.isError).toBeUndefined()
  expect(String(silent.result)).not.toContain('"exit": "clean"')
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
  expect(silent.isError).toBeUndefined()
  expect(String(silent.result)).not.toContain('"exit": "clean"')
})

test('a hand-back whose report was withheld is no report', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  stubs.agent = () => coreCompleted('The report was withheld.', { handback: 'withheld', handbackReport: { text: PASS2_REPORT } })
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($)
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(out.isError).toBeUndefined()
  expect(String(out.result)).not.toContain('"exit": "clean"')
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
  expect(stubs.records.map((r) => [fieldsOf(r)?.['repo'], fieldsOf(r)?.['pr']])).toEqual([[REPO, 12]])
})

test('a detached review checkout records at the open pull request whose head it is', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, ghCalls: [], branch: 'HEAD', pulls: JSON.stringify([openPull(7, 'c'.repeat(40)), openPull(34)]) }
  wireRecord(on, stubs)
  await cleanLoop($)
  expect(stubs.ghCalls).toEqual([{ command: 'pr-list', args: { format: 'raw' }, repo: REPO }])
  expect(stubs.records.map((r) => fieldsOf(r)?.['pr'])).toEqual([34])
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
  expect(stubs.ghCalls?.map((c) => fieldsOf(c)?.['command'])).toEqual(['pr-get'])
})

// ── a transient github failure keeps the record owed ──

const UNAVAILABLE = { result: 'Service Unavailable (HTTP 503)', isError: true }

async function reviewedLoop($: Engine): Promise<Reply> {
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($, [{ severity: 'important' }])
  return loopCall($, { action: 'findings', keys: ['a::b'] })
}

test('a 503 on the record write, then a success, writes the record in the same call', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, recordFirst: [UNAVAILABLE], sleeps: [] }
  wireRecord(on, stubs)
  const out = await reviewedLoop($)
  expect(stubs.recordCalls).toBe(2)
  expect(stubs.sleeps).toEqual(['0.5'])
  expect(stubs.records.length).toBe(1)
  expect(String(out.result)).toContain('record: ' + WRITTEN)
  expect(String(out.result)).not.toContain('record: none')
})

test('a 503 on the pull request read, then a success, writes the record in the same call', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, prFirst: [UNAVAILABLE, { deny: 'github: connection reset by peer' }], sleeps: [] }
  wireRecord(on, stubs)
  const out = await reviewedLoop($)
  expect(stubs.sleeps).toEqual(['0.5', '1'])
  expect(stubs.records.map((r) => fieldsOf(r)?.['pr'])).toEqual([12])
  expect(String(out.result)).toContain('record: ' + WRITTEN)
})

test('a persistent 503 settles no record: the answer says it is owed, and a later findings writes it', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, recordFirst: [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE], sleeps: [] }
  wireRecord(on, stubs)
  const out = await reviewedLoop($)
  expect(stubs.recordCalls).toBe(4)
  expect(stubs.sleeps).toEqual(['0.5', '1', '2'])
  expect(stubs.records).toEqual([])
  expect(String(out.result)).toContain('record: none — Service Unavailable (HTTP 503); the record is still owed, the verdict is kept: call findings or status again to write it')
  expect(String(out.result)).toContain('"exit": "reviewed"')
  // GitHub is back: the same verdict is written, nothing is read again.
  const later = await loopCall($, { action: 'findings', keys: ['other::finding'] })
  expect(stubs.records).toEqual([{ pr: 12, repo: 'LounisBou/claude-review', kind: 'review', result: 'fail', detail: 'reviewed: 1 findings, 1 Critical or Important: a::b', dir: '/clone/repo' }])
  expect(String(later.result)).toContain('record: ' + WRITTEN)
  expect(String(later.result)).toContain('"exit": "reviewed"')
  expect(String(later.result)).toContain('"seen": [\n    "a::b"\n  ]')
  await loopCall($, { action: 'status' })
  await loopCall($, { action: 'findings', keys: [] })
  expect(stubs.records.length).toBe(1)
})

test('a status call also writes the record owed', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, recordFirst: [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE], sleeps: [] }
  wireRecord(on, stubs)
  await reviewedLoop($)
  const status = await loopCall($, { action: 'status' })
  expect(stubs.records.length).toBe(1)
  expect(String(status.result)).toContain('"exit": "reviewed"')
  expect(String(status.result)).toContain('record: ' + WRITTEN)
})

test('a record still owed that GitHub keeps refusing stays owed', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, recordFirst: Array(8).fill(UNAVAILABLE), sleeps: [] }
  wireRecord(on, stubs)
  await reviewedLoop($)
  const again = await loopCall($, { action: 'status' })
  expect(String(again.result)).toContain('the record is still owed')
  expect(stubs.records).toEqual([])
})

test('a 4xx is no transient failure: asked once, the record is none, and not owed', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, recordFirst: [{ result: 'Not Found (HTTP 404)', isError: true }], sleeps: [] }
  wireRecord(on, stubs)
  const out = await reviewedLoop($)
  expect(stubs.recordCalls).toBe(1)
  expect(stubs.sleeps).toEqual([])
  expect(String(out.result)).toContain('record: none — Not Found (HTTP 404)')
  expect(String(out.result)).not.toContain('owed')
  await loopCall($, { action: 'status' })
  await loopCall($, { action: 'findings', keys: ['x::y'] })
  expect(stubs.recordCalls).toBe(1)
})

test('a repository whose name says timeout is recorded once, and never owed', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, remote: 'LounisBou/timeout-tools', recordAnswer: { result: '/data/records/LounisBou/timeout-tools/review.json' }, sleeps: [] }
  wireRecord(on, stubs)
  const out = await reviewedLoop($)
  expect(String(out.result)).toContain('record: /data/records/LounisBou/timeout-tools/review.json')
  expect(String(out.result)).not.toContain('owed')
  await loopCall($, { action: 'status' })
  await loopCall($, { action: 'findings', keys: ['x::y'] })
  expect(stubs.recordCalls).toBe(1)
  expect(stubs.sleeps).toEqual([])
})

test('a record owed is not written at another head than the one reviewed, and is no longer owed', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, recordFirst: [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE], sleeps: [] }
  wireRecord(on, stubs)
  await reviewedLoop($)
  stubs.head = 'b'.repeat(40)
  const moved = await loopCall($, { action: 'status' })
  expect(stubs.records).toEqual([])
  expect(stubs.recordCalls).toBe(4)
  expect(String(moved.result)).toContain(`record: none — the checkout is at ${'b'.repeat(12)}, the review read ${'a'.repeat(12)}`)
  expect(String(moved.result)).not.toContain('owed')
  // Not owed any more: even at the reviewed head again, nothing is written.
  delete stubs.head
  await loopCall($, { action: 'status' })
  expect(stubs.recordCalls).toBe(4)
  expect(stubs.records).toEqual([])
})

test('a record write that never answers is still owed at the next call', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, recordFirst: [new Promise<never>(() => {})], sleeps: [] }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($, [{ severity: 'important' }])
  void loopCall($, { action: 'findings', keys: ['a::b'] })
  for (let i = 0; i < 100 && stubs.recordCalls !== 1; i++) await new Promise((r) => setTimeout(r, 5))
  expect(stubs.recordCalls).toBe(1)
  const later = await loopCall($, { action: 'status' })
  expect(stubs.records.length).toBe(1)
  expect(String(later.result)).toContain('record: ' + WRITTEN)
})

test('what GitHub says is transient or not', () => {
  for (const text of ['Service Unavailable (HTTP 503)', 'Bad Gateway (HTTP 502)', '504 Gateway Time-out', 'request timed out', '<urlopen error [Errno 54] Connection reset by peer>', 'connect ETIMEDOUT', 'Internal Server Error (HTTP 500)']) {
    expect([text, isTransient(text)]).toEqual([text, true])
  }
  for (const text of ['Not Found (HTTP 404)', 'Bad credentials (HTTP 401)', 'gh is not signed in', 'github: the checkout is at abc1234, the pull request\'s head is def5678', 'record.py: bad head 5031234']) {
    expect([text, isTransient(text)]).toEqual([text, false])
  }
})

// ── a pass's verdict needs its readers ──

test('a fix loop\'s findings with no reader in the pass ask for the readers, and its exit records nothing', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  for (let i = 1; i <= 3; i++) {
    await loopCall($, { action: 'begin_pass' })
    const out = await loopCall($, { action: 'findings', keys: ['k' + i] })
    expect(out.isError).toBe(true)
    expect(String(out.result)).toContain('no review agent ran in this pass')
  }
  const status = await loopCall($, { action: 'status' })
  expect(String(status.result)).toContain('"seen": []')
  const last = await loopCall($, { action: 'begin_pass' })
  expect(String(last.result)).toContain('"exit": "max_passes"')
  expect(String(last.result)).not.toContain('record:')
  expect(stubs.records).toEqual([])
})

// A reader that ends on prose with no findings block, shortened and anonymised.
const HUNTER = 'pr-review-toolkit:silent-failure-hunter'
const PROSE_NONE = 'No findings\n\nI read the whole diff `aaaa111..bbbb222` (src and tests). '
  + 'The points below are what I checked and why none of them is a finding.\n\n'
  + '- **Failed day:** the transaction rolls the day back and rethrows, so nothing is swallowed.'

test('a fix loop\'s clean exit is never given to a reader without its block: no refusal, the loop goes on', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start' })
  await loopCall($, { action: 'begin_pass' })
  await review($, [])
  await $.tool.call({ tool: 'Agent', subagent_type: HUNTER, prompt: 'hunt' + REPORT_REQUEST, answer: PROSE_NONE })
  const out = await loopCall($, { action: 'findings', keys: [] })
  expect(out.isError).toBeUndefined()
  expect(String(out.result)).not.toContain('"exit"')
  expect(stubs.records).toEqual([])
})

test('a reviewer\'s four readers, one of them ending on prose, record fail and name that reader', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  const answers: [string, string][] = [
    ['pr-review-toolkit:code-reviewer', agentAnswer([])],
    [HUNTER, PROSE_NONE],
    ['pr-review-toolkit:comment-analyzer', agentAnswer([{ severity: 'suggestion' }])],
    ['pr-review-toolkit:pr-test-analyzer', agentAnswer([{ severity: 'suggestion' }, { severity: 'suggestion' }])],
  ]
  for (const [type, answer] of answers) await $.tool.call({ tool: 'Agent', subagent_type: type, prompt: 'review the diff' + REPORT_REQUEST, answer })
  const out = await loopCall($, { action: 'findings', keys: ['f0::a', 'f0::b', 'f1::c'] })
  expect(out.isError).toBeUndefined()
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(stubs.records.map((r) => [fieldsOf(r)?.['result'], fieldsOf(r)?.['detail']])).toEqual([['fail', `reviewed: 3 findings, severity unknown: no findings block from ${HUNTER}`]])
})

// ── only the review step's readers belong to a pass ──

test('a norms agent launched during an open pass is not counted, and keeps its call', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, prompts: [], launches: [] }
  stubs.agent = (e) => {
    stubs.launches?.push(e['run_in_background'])
    return e['subagent_type'] === 'norms:norms-diff-scope' ? coreLaunch('a0000000000000031') : { result: e['answer'] }
  }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', prompt: 'review the diff' + REPORT_REQUEST, run_in_background: true, answer: agentAnswer([{ severity: 'suggestion' }]) })
  await $.tool.call({ tool: 'Agent', subagent_type: 'norms:norms-diff-scope', prompt: 'norms', run_in_background: true })
  const out = await loopCall($, { action: 'findings', keys: ['f0::s'] })
  expect(String(out.result)).toContain('"exit": "reviewed"')
  expect(stubs.prompts).toEqual(['review the diff' + REPORT_REQUEST, 'norms'])
  expect(stubs.launches).toEqual([true, true])
  expect(stubs.records.map((r) => [fieldsOf(r)?.['result'], fieldsOf(r)?.['detail']])).toEqual([['pass', 'reviewed: 1 findings, none Critical or Important']])
})

test('every agent of a pass is a reader but a norms one: a lens and a call with no type are counted', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0, prompts: [] }
  wireRecord(on, stubs)
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await $.tool.call({ tool: 'Agent', subagent_type: 'orchestrator:lens', prompt: 'lens' + REPORT_REQUEST, answer: agentAnswer([{ severity: 'important' }]) })
  await $.tool.call({ tool: 'Agent', prompt: 'plain' + REPORT_REQUEST, answer: 'prose' })
  await $.tool.call({ tool: 'Agent', subagent_type: 'norms:norms-variable-naming', prompt: 'norms', answer: 'prose' })
  await loopCall($, { action: 'findings', keys: ['f0::s'] })
  expect(stubs.prompts).toEqual(['lens' + REPORT_REQUEST, 'plain' + REPORT_REQUEST, 'norms'])
  expect(stubs.records.map((r) => [fieldsOf(r)?.['result'], fieldsOf(r)?.['detail']])).toEqual([['fail', 'reviewed: 1 findings, severity unknown: no findings block from general-purpose']])
})

// ── what a pass's readers leave behind ──

// The readers of a pass as the loop holds them: two whose block was not read.
function fillPass(): void {
  loop.reports.push(null, null)
  loop.readers.push('code-reviewer', 'orchestrator:lens')
}

const passState = () => ({ reports: loop.reports, readers: loop.readers })
const EMPTY_PASS = { reports: [], readers: [] }

test('a second pass starts with none of the last pass\'s readers', () => {
  act({ action: 'start' })
  act({ action: 'begin_pass' })
  fillPass()
  act({ action: 'begin_pass' })
  expect(passState()).toEqual(EMPTY_PASS)
})

test('a new loop starts with none of the last loop\'s readers', () => {
  act({ action: 'start' })
  act({ action: 'begin_pass' })
  fillPass()
  act({ action: 'start' })
  expect(passState()).toEqual(EMPTY_PASS)
})

test('a severity unknown with no silent reader to name says so, never an empty list', () => {
  Object.assign(loop, { pass: 5, reports: [], readers: [], lastFindings: 2, lastBlocking: undefined })
  expect(verdict('reviewed')?.detail).toBe('reviewed: 2 findings, severity unknown: no review agent\'s findings block was read')
  // The fix loop's exits have no verdict: its session wrote the code, and records no review of it.
  expect(verdict('max_passes')).toBeNull()
  expect(verdict('clean')?.result).toBe('pass')
})

test('the block request overrides a reviewer prompt that allows prose « no findings »', () => {
  expect(REPORT_REQUEST).toContain('The block is due even then, in place of any prose such as "no findings" an earlier line allows.')
})

// The verdict line an orchestrator's agent sends up, last in the answer that ends the loop.
const spawnedEnv = (on: TestOn, value: string) => on('env.get', (_$, e) => ({ value: e.name === 'ORCHESTRATOR_SPAWNED' ? value : undefined }))

test('in a session the orchestrator spawned, the loop ends on the verdict line naming the record', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  spawnedEnv(on, '1')
  const out = await cleanLoop($)
  const last = String(out.result).split('\n').at(-1)
  expect(last).toBe(`claude-review#12 ${REVIEWED_HEAD.slice(0, 7)} — review pass (clean) — blocking: none — report: ${WRITTEN}`)
})

test('the verdict line names the files of the blocking findings left', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  spawnedEnv(on, '1')
  await loopCall($, { action: 'start', review_only: true })
  await loopCall($, { action: 'begin_pass' })
  await review($, [{ severity: 'important' }, { severity: 'important' }, { severity: 'suggestion' }])
  const out = await loopCall($, { action: 'findings', keys: ['a', 'b', 'c'] })
  expect(String(out.result).split('\n').at(-1)).toBe(`claude-review#12 ${REVIEWED_HEAD.slice(0, 7)} — review fail (reviewed) — blocking: f0, f1 — report: ${WRITTEN}`)
})

test('a fix loop in a session the orchestrator spawned ends on no verdict line: it writes no record', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  spawnedEnv(on, '1')
  const out = await runToMaxPasses($, 2)
  expect(String(out.result)).toContain('"exit": "max_passes"')
  expect(String(out.result)).not.toContain('claude-review#12')
  expect(stubs.records).toEqual([])
})

test('outside a session the orchestrator spawned, the loop ends on its record line', async ($, on) => {
  const stubs: Stubs = { records: [], prCalls: 0 }
  wireRecord(on, stubs)
  spawnedEnv(on, '')
  const out = await cleanLoop($)
  expect(String(out.result).split('\n').at(-1)).toBe('record: ' + WRITTEN)
})
