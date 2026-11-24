import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Found, NounEvents, TestOn } from 'claude-code/testing'
import { COMMANDS, READS, NEVER_GRANTED, NET_REFUSAL, WATCH_MS, bashNetRefusal, ciTransitions, selfReviewRefusal, writeNetRefusal } from './register.js'
import { touchesRecords } from './ready.js'
import { mergeOrder, parseStackPlan, walkedHead } from './stack.js'
import { SCRIPTED } from '../core/pr-record.ts'
import { PLAN_NEEDS, REVIEW_ROUNDS } from '../core/readiness.ts'
import { dialogOf, fieldsOf, listOf, type ProcessRunResult } from '../core/host.ts'

// A run of the engine: its argv, and the request it reads on stdin.
type GhRun = { readonly argv: readonly string[]; readonly command: string; readonly args: Readonly<Record<string, unknown>>; readonly repo: unknown; readonly full: unknown }
type Write = { readonly path: string; readonly text: string }
type Verdict = { decision: string; reason?: string; rule?: unknown }
// What the engine answers a run: a reply, or a refusal of the run itself.
type RunReply = ProcessRunResult | { readonly deny: string }
type Replier = RunReply | ((e: NounEvents['process.run']) => RunReply)

function runOf(e: NounEvents['process.run']): GhRun {
  const request = fieldsOf(JSON.parse(e.init?.stdin ?? '{}')) ?? {}
  return { argv: e.argv, command: String(request['command'] ?? ''), args: fieldsOf(request['args']) ?? {}, repo: request['repo'], full: request['full'] }
}

test('session.start registers the gh tool and the three commands', async ($, on) => {
  const registered: string[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', (_$, e) => {
    registered.push('tool:' + e.name)
    if (e.name === 'gh') expect(e.inputSchema).toMatchObject({ properties: { command: { enum: COMMANDS } } })
    expect(e.isDeferred).toBe(false)
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    registered.push('cmd:' + e.name)
    return { value: undefined }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  expect(registered).toContain('tool:gh')
  expect(registered).toContain('cmd:checks')
  expect(registered).toContain('cmd:threads')
  expect(registered).toContain('cmd:prs')
})

test('the record tool\'s plan schema names the needs core\'s readiness contract gives each check', async ($, on) => {
  const schemas: Record<string, unknown> = {}
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', (_$, e) => {
    schemas[e.name] = e.inputSchema
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const planOf = fieldsOf(fieldsOf(fieldsOf(schemas['record'])?.['properties'])?.['plan'])
  const plan = fieldsOf(planOf?.['properties']) ?? {}
  expect(Object.keys(plan)).toEqual(Object.keys(PLAN_NEEDS))
  for (const [check, needs] of Object.entries(PLAN_NEEDS)) expect(fieldsOf(plan[check])?.['description']).toBe(needs.join(', '))
})

test('the record tool\'s plan schema says a required review takes its rounds, up to core\'s cap', async ($, on) => {
  const schemas: Record<string, unknown> = {}
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', (_$, e) => {
    schemas[e.name] = e.inputSchema
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  expect(String(fieldsOf(fieldsOf(fieldsOf(schemas['record'])?.['properties'])?.['plan'])?.['description'])).toContain('"required: max <n>", its rounds from 1 to ' + REVIEW_ROUNDS.cap)
})

test('a command name another plugin owns passes through to next', async ($, on) => {
  const runs: NounEvents['process.run'][] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', (_$, e) => {
    if (e.name === 'checks') throw new Error('name taken')
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    runs.push(e)
    return { exitCode: 0, stdout: '', stderr: '' }
  })
  on('command.run', { command: 'checks' }, () => ({ text: 'other plugin answer' }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.command.run({ command: 'checks', args: '' })
  expect(out.text).toBe('other plugin answer')
  expect(runs.length).toBe(0)
})

// The code of each refusal event the module journaled in the test running: one per guard it observed and let the call through.
const JOURNAL = '/github/journal/'
const journaled: string[] = []
// Set by a test whose host refuses every write of the journal.
let journalRefused = false
// A session whose configuration directory is /cfg, where the journal lies; a test that names its own environment does not call it.
const cfg = (on: TestOn) => on('env.get', (_$, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/cfg' : undefined }))

// A session id no other test uses: the marks and the grants the module keeps
// by session never carry from one test to the next.
let sessions = 0
const freshSession = () => 'session-' + ++sessions

// The head the stubbed pr-gate answers, ready: CI green and, under the records root stubAutoMerge
// serves, a passed review, norms check and E2E, so it carries the Ready label the gate puts.
const HEAD = '0123456789abcdef0123456789abcdef01234567'
const readyGate = (repo: string, pr: number) => JSON.stringify({
  repo, pr, state: 'open', draft: true, head: HEAD, labels: ['Ready'], ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1 },
})
const RECORDS_ROOT = '/cfg/' + 'pr-records'
function recordFiles(repo: string, pr: number, head = HEAD): Record<string, string> {
  return Object.fromEntries(['review', 'norms', 'e2e'].map((kind) => [
    RECORDS_ROOT + '/' + repo + '/' + head + '/' + kind + '.20261101T100000Z.p-' + kind + '.json',
    JSON.stringify({ v: 1, repo, pr, head, kind, result: 'pass', producer: 'p-' + kind, detail: '', session: '', at: '2026-11-01T10:00:00Z' }),
  ]))
}

// reply: a fixed { exitCode, stdout, stderr } value, or a function (e) => value
// for sequenced replies. Registered once per test — never register a second
// process.run stub afterwards; pass a function instead.
async function stubMod(
  on: TestOn,
  runs: GhRun[],
  writes: Write[],
  reply: Replier = { exitCode: 0, stdout: 'ok', stderr: '' },
  verdict: Verdict | ((e: NounEvents['tool.check']) => Verdict) = { decision: 'allow' },
  gate: (repo: string, pr: number) => string = readyGate,
) {
  const session = freshSession()
  journaled.length = 0
  journalRefused = false
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: session }))
  on('session.cwd', () => ({ value: '/work' }))
  // The dialog a $.ui.ask raises is itself checked: it must not meet the verdict meant for the gh call.
  on('tool.check', (_$, e) => (e.tool === 'AskUserQuestion' ? { decision: 'allow' } : typeof verdict === 'function' ? verdict(e) : verdict))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('fs.write', (_$, e) => {
    if (String(e.path).includes(JOURNAL)) {
      if (journalRefused) return { deny: 'EACCES: permission denied' }
      journaled.push(String(fieldsOf(fieldsOf(JSON.parse(e.text))?.['source'])?.['code']))
      return { value: undefined }
    }
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    // The journal's event moves into place: no act of the session.
    if (e.argv[0] === 'mv' && String(e.argv[3]).includes(JOURNAL)) return { value: { exitCode: 0, stdout: '', stderr: '' } }
    // Each run is recorded as the request gh.py reads on stdin, plus its argv.
    const request = runOf(e)
    runs.push(request)
    if (request.command === 'pr-gate') {
      return { value: { exitCode: 0, stdout: gate(typeof request.repo === 'string' ? request.repo : 'acme/thing', Number(request.args['pr'])), stderr: '' } }
    }
    return { value: typeof reply === 'function' ? reply(e) : reply }
  })
}

// The engine runs of the act itself: the pr-gate read the ready guard makes
// before a merge or an undraft goes ahead left out.
const acts = (runs: GhRun[]) => runs.filter((r) => r.command !== 'pr-gate')


async function startSession($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

test('the gh tool hands the request to gh.py on stdin, body bytes intact', async ($, on) => {
  const runs: GhRun[] = []
  const writes: Write[] = []
  await stubMod(on, runs, writes)
  await startSession($)

  const out = await $.tool.call({
    tool: 'mcp__github__gh',
    command: 'pr-comment',
    args: { pr: 12, body: 'hi **bold**\r\nsecond `line`' },
    repo: 'acme/thing',
  })

  expect(out).toEqual({ result: 'ok' })
  expect(writes.length).toBe(0)
  expect(runs.length).toBe(1)
  expect(runs[0]?.argv[0]).toBe('python3')
  expect(runs[0]?.argv[1]?.endsWith('/engine/gh.py')).toBe(true)
  expect(runs[0]?.argv.slice(2)).toEqual(['--stdin-json'])
  expect(runs[0]?.command).toBe('pr-comment')
  expect(runs[0]?.args).toEqual({ pr: 12, body: 'hi **bold**\r\nsecond `line`' })
  expect(runs[0]?.repo).toBe('acme/thing')
})

test('a non-zero gh.py exit returns isError with stderr', async ($, on) => {
  const runs: GhRun[] = []
  const writes: Write[] = []
  await stubMod(on, runs, writes, { exitCode: 4, stdout: '', stderr: 'error: not found' })
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-status', args: { pr: 99 } })
  expect(out.isError).toBe(true)
  expect(out.result).toBe('error: not found')
})

test('a call that breaks the tool\'s schema is refused with what is wrong, and nothing runs', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [])
  await startSession($)

  for (const [call, names] of [
    [{ command: 5 }, '"command"'],
    [{ command: '' }, '"command"'],
    [{ command: 'pr-status', args: 'pr=12' }, '"args"'],
    [{ command: 'pr-status', args: [12] }, '"args"'],
    [{ command: 'pr-status', args: { pr: 12 }, repo: 12 }, '"repo"'],
  ] as [Record<string, unknown>, string][]) {
    const out = await $.tool.call({ tool: 'mcp__github__gh', ...call })
    expect(out.isError, JSON.stringify(call)).toBe(true)
    expect(String(out.result), JSON.stringify(call)).toContain('github: ' + names)
  }
  expect(runs).toEqual([])
})

test('a line gh.py prints on stderr after a success follows the tool output', async ($, on) => {
  const runs: GhRun[] = []
  const writes: Write[] = []
  await stubMod(on, runs, writes, { exitCode: 0, stdout: '{"number": 12}\n', stderr: 'error: label not-ready on pull request 12 failed: boom\n' })
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-create', args: { title: 'T', draft: true } })
  expect(out).toEqual({ result: '{"number": 12}\nerror: label not-ready on pull request 12 failed: boom' })
})

test('a rejected process.run surfaces as isError, not a skipped hook', async ($, on) => {
  const runs: GhRun[] = []
  const writes: Write[] = []
  await stubMod(on, runs, writes, { deny: 'python3: not found' })
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'auth-check' })
  expect(out.isError).toBe(true)
})

test('a usage error from the engine comes back as isError', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], { exitCode: 1, stdout: '', stderr: 'error: missing argument "pr" for pr-status\n' })
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-status', args: {} })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('missing argument "pr"')
})

test('/checks reports the current branch PR CI status', async ($, on) => {
  const runs: GhRun[] = []
  const writes: Write[] = []
  // Sequenced reply: pr-get first, then pr-checks.
  let call = 0
  await stubMod(on, runs, writes, () =>
    (call += 1) === 1
      ? { exitCode: 0, stdout: '12\n', stderr: '' }
      : { exitCode: 0, stdout: '{"result": "SUCCESS"}', stderr: '' },
  )
  await startSession($)

  const out = await $.command.run({ command: 'checks', args: '' })
  expect(out.text).toBe('#12 CI: SUCCESS')
  expect(runs[0]?.command).toBe('pr-get')
  expect(runs[1]?.command).toBe('pr-checks')
  expect(runs[1]?.args['pr']).toBe('12')
})

test('/checks without a PR on the branch says so, in one call', async ($, on) => {
  const runs: GhRun[] = []
  const writes: Write[] = []
  await stubMod(on, runs, writes, { exitCode: 0, stdout: '\n', stderr: '' })
  await startSession($)

  const out = await $.command.run({ command: 'checks', args: '' })
  expect(out.text).toBe('no open PR for this branch')
  expect(runs.length).toBe(1)
})

test('/threads with an explicit PR skips the lookup', async ($, on) => {
  const runs: GhRun[] = []
  const writes: Write[] = []
  await stubMod(on, runs, writes, { exitCode: 0, stdout: '| thread | line |', stderr: '' })
  await startSession($)

  const out = await $.command.run({ command: 'threads', args: ' 12 ' })
  expect(out.text).toBe('| thread | line |')
  expect(runs.length).toBe(1)
  expect(runs[0]?.command).toBe('pr-threads')
})

test('command failures surface the engine error, not a generic diagnostics line', async ($, on) => {
  const runs: GhRun[] = []
  const writes: Write[] = []
  await stubMod(on, runs, writes, { exitCode: 4, stdout: '', stderr: 'error: no PR 999' })
  await startSession($)

  const checks = await $.command.run({ command: 'checks', args: '999' })
  expect(checks.text).toBe('error: no PR 999')
  const threads = await $.command.run({ command: 'threads', args: '999' })
  expect(threads.text).toBe('error: no PR 999')
  const prs = await $.command.run({ command: 'prs', args: '' })
  expect(prs.text).toBe('error: no PR 999')
})

// What pr-panel answers: a row a PR, its CI and comment count read in the same query.
const panelRow = (number: number, over: Record<string, unknown> = {}) => ({
  number, title: 'PR ' + number, url: 'https://github.com/acme/thing/pull/' + number, draft: false,
  comments: 0, ci: 'SUCCESS', failed: [], ...over,
})
const PR_LIST = JSON.stringify([
  panelRow(12, { title: 'fix: related PRs' }),
  panelRow(11, { title: 'feat: minimize nodes', draft: true }),
])

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })

// A process.run reply chosen by subcommand, so parallel runs need no order.
function byCommand(replies: Record<string, (e: NounEvents['process.run']) => RunReply>) {
  return (e: NounEvents['process.run']): RunReply => {
    const { command } = runOf(e)
    const reply = replies[command]
    return reply ? reply(e) : { exitCode: 3, stdout: '', stderr: 'error: unexpected ' + command }
  }
}

test('/prs reads the open PRs in one query and opens the pane', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], byCommand({
    'pr-panel': () => ok(PR_LIST),
  }))
  const opened: unknown[] = []
  on('ui.open', (_$, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  await startSession($)

  const out = await $.command.run({ command: 'prs', args: '' })
  expect(out).toEqual({})
  expect(opened).toEqual([{ id: 'github-prs', title: 'PRs', closeOnEscape: true }])
  // One engine run, whatever the number of PRs: no list, no per-PR checks or record.
  expect(runs.map((r) => r.command)).toEqual(['pr-panel'])
})

// The colour of the Text a row's Box holds.
const colourOf = (box: Found | undefined) => fieldsOf(fieldsOf(listOf(box?.children)[0])?.['props'])?.['color']

const PANE_EVENT = {
  plugin: 'github',
  component: 'Pane',
  requestId: 'github-prs',
  surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: {
    title: 'PRs',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('the pane renders one row per PR with CI, comments and a refresh button', async ($, on) => {
  await stubMod(on, [], [], byCommand({
    'pr-panel': () => ok(JSON.stringify([
      panelRow(12, { title: 'fix: related PRs', comments: 3, ci: 'FAILURE', failed: ['lint'] }),
      panelRow(11, { title: 'feat: minimize nodes', draft: true, ci: 'FAILURE', failed: ['lint'] }),
    ])),
  }))
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT })
  expect(await ui.find({ type: 'Link', props: { href: 'https://github.com/acme/thing/pull/12' } })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'room-12', text: /fix: related PRs 💬3$/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'label-12', text: 'CI:FAILURE' })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'room-11', text: /minimize nodes ○ draft$/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'label-11', text: 'CI:FAILURE' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
  await ui.unmount()
})

test('the pane leaves the title uncoloured and colours only the CI label by state', async ($, on) => {
  await stubMod(on, [], [], byCommand({
    'pr-panel': () => ok(JSON.stringify([
      panelRow(12, { title: 'fix: related PRs', ci: 'FAILURE' }),
      panelRow(11, { title: 'feat: minimize nodes', ci: 'PENDING' }),
    ])),
  }))
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT })
  expect(colourOf(await ui.find({ type: 'Box', key: 'room-12' }))).toBeUndefined()
  expect(colourOf(await ui.find({ type: 'Box', key: 'room-11' }))).toBeUndefined()
  expect(colourOf(await ui.find({ type: 'Box', key: 'label-12' }))).toBe('error')
  expect(colourOf(await ui.find({ type: 'Box', key: 'label-11' }))).toBe('warning')
  await ui.unmount()
})

test('the pane colours a SUCCESS label green and an unknown one inactive', async ($, on) => {
  await stubMod(on, [], [], byCommand({
    'pr-panel': () => ok(JSON.stringify([panelRow(100, { ci: '?' }), panelRow(99)])),
  }))
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT })
  expect(colourOf(await ui.find({ type: 'Box', key: 'label-99' }))).toBe('success')
  expect(colourOf(await ui.find({ type: 'Box', key: 'label-100' }))).toBe('inactive')
  await ui.unmount()
})

test('the pane clips a long title so the CI label shows at a narrow width', async ($, on) => {
  const long = 'a very long pull request title that would push the label out of a narrow pane'
  await stubMod(on, [], [], byCommand({
    'pr-panel': () => ok(JSON.stringify([panelRow(12, { title: long, draft: true, comments: 3, ci: 'FAILURE' })])),
  }))
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT, props: { ...PANE_EVENT.props, bodyColumns: 40 } })
  const title = await ui.find({ type: 'Box', key: 'room-12' })
  const text = String(title?.text)
  expect(text.endsWith('…') || text.includes('… ○ draft')).toBe(true)
  expect(text).toContain('○ draft')
  expect(text).toContain('💬3')
  expect(text.length).toBeLessThanOrEqual(40 - 'CI:FAILURE'.length - 6)
  expect(await ui.find({ type: 'Box', key: 'label-12', text: 'CI:FAILURE' })).toBeDefined()
  await ui.unmount()
})

test('the pane lists every PR the query answers, each with its own CI state', async ($, on) => {
  const many = [100, 99, 94, 93, 92, 91, 90].map((n) => panelRow(n, { ci: n === 100 ? '?' : n === 90 ? 'PENDING' : 'SUCCESS' }))
  const runs: GhRun[] = []
  await stubMod(on, runs, [], byCommand({ 'pr-panel': () => ok(JSON.stringify(many)) }))
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT })
  expect(await ui.find({ type: 'Box', key: 'label-100', text: 'CI:?' })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'label-94', text: 'CI:SUCCESS' })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'label-90', text: 'CI:PENDING' })).toBeDefined()
  expect(runs.length).toBe(1)
  await ui.unmount()
})

test('the pane with no open PRs says so and Refresh re-collects', async ($, on) => {
  const runs: GhRun[] = []
  let lists = 0
  await stubMod(on, runs, [], byCommand({
    'pr-panel': () => ok((lists += 1) === 1 ? '[]' : PR_LIST),
  }))
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT })
  expect(await ui.find({ type: 'Text', text: /No open PRs/ })).toBeDefined()

  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /fix: related PRs/ })).toBeDefined()
  expect(runs.filter((r) => r.command === 'pr-panel').length).toBe(2)
  await ui.unmount()
})

test('a failed Refresh keeps the last rows and shows the error', async ($, on) => {
  let lists = 0
  await stubMod(on, [], [], byCommand({
    'pr-panel': () => (lists += 1) === 1 ? ok(PR_LIST) : { exitCode: 5, stdout: '', stderr: 'error: rate limited\n' },
  }))
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /fix: related PRs/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'error: rate limited' })).toBeDefined()
  expect(await ui.find({ type: 'Button', props: { label: 'Refresh' } })).toBeDefined()
  await ui.unmount()
})

test('/checks names the failed checks and accepts #12', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], ok(JSON.stringify({ result: 'FAILURE', failed_checks: ['lint', 'test'] })))
  await startSession($)

  const out = await $.command.run({ command: 'checks', args: '#12' })
  expect(out.text).toBe('#12 CI: FAILURE (lint, test)')
  expect(runs[0]?.args['pr']).toBe('12')
})

test('every read-only command is a real subcommand', () => {
  for (const name of READS) expect(COMMANDS).toContain(name)
})

// answer: the label the stubbed dialog returns, or undefined for a dialog
// nobody can answer (a -p run).
function stubAsk(on: TestOn, asked: string[], answer: string | undefined) {
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = dialogOf(e).question
    asked.push(question)
    if (answer === undefined) return { deny: 'no one to ask' }
    return { result: { questions: e['questions'], answers: { [question]: answer } } }
  })
}

test('a deny verdict refuses the call without running gh.py', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], undefined, { decision: 'deny', reason: 'denied by mcp__github__gh', rule: 'mcp__github__gh' })
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-list' })
  expect(JSON.stringify(out)).toContain('denied by mcp__github__gh')
  expect(out.result).toBeUndefined()
  expect(runs.length).toBe(0)
})

test('a read the model makes is not asked as the full object, which only the module asks', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [])
  await startSession($)

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-list' })
  expect(runs.length).toBe(1)
  expect(runs[0]?.full).toBeUndefined()
  // A request the tool sends cannot carry it either: the tool's own input is the only thing it forwards.
  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-list', full: true })
  expect(runs[1]?.full).toBeUndefined()
})

test('an ask with no rule lets a read through without a dialog', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Deny')
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-list' })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
  expect(runs.length).toBe(1)
})

test('an ask puts a write to the person, and Allow runs it', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Allow')
  stubAutoMerge(on, {}, {})
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out).toEqual({ result: 'ok' })
  expect(asked[0]).toContain('pr-merge')
  expect(acts(runs).length).toBe(1)
})

test('an ask on a write refused by the person runs nothing', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Deny')
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'comment-delete', args: { comment_id: 5 } })
  expect(JSON.stringify(out)).toContain('refused gh comment-delete')
  expect(runs.length).toBe(0)
})

test('an ask from an explicit rule asks even for a read', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask', rule: 'mcp__github__gh' })
  stubAsk(on, asked, 'Allow')
  await startSession($)

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-list' })
  expect(asked.length).toBe(1)
  expect(runs.length).toBe(1)
})

test('a write that needs permission is refused when nobody can be asked', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, [], undefined)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'x' } })
  expect(JSON.stringify(out)).toContain('nobody could be asked')
  expect(runs.length).toBe(0)
})

test('a write no session grant covers is refused when nobody can be asked', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, [], undefined)
  stubAutoMerge(on, {}, {})
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(JSON.stringify(out)).toContain('nobody could be asked')
  expect(acts(runs).length).toBe(0)
})

test('a truncated engine output says so', async ($, on) => {
  await stubMod(on, [], [], { exitCode: 0, stdout: 'diff', stderr: '', isStdoutTruncated: true })
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-diff', args: { pr: 1 } })
  expect(out).toEqual({ result: 'diff\n[output cut at 4 MiB]' })
})

// ---- an observation the journal cannot keep ----

// The four sections every pull request description ends with, each empty.
const NONE = '**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none'
// A write to the E2E exemptions: observed (github.exemption.write) and let through.
const EXEMPTION_WRITE = { tool: 'Write', file_path: '/home/x/.claude/plugins/data/github/e2e-exempt/o/r.json', content: '{}' } as const
const writeLetThrough = (on: TestOn) => on('tool.call', { tool: 'Write' }, () => ({ result: 'written' }))

test('a journal that cannot be written costs one log line and the call goes as it is', async ($, on) => {
  const runs: GhRun[] = []
  const logs: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  writeLetThrough(on)
  on('env.get', () => ({ value: undefined }))
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  await startSession($)

  const out = await $.tool.call(EXEMPTION_WRITE)
  expect(out).toEqual({ result: 'written' })
  expect(journaled).toEqual([])
  expect(logs.filter((line) => line.includes('github.exemption.write could not be journaled')).length).toBe(1)
})

test('a journal write the host refuses costs one log line naming why, and the call goes as it is', async ($, on) => {
  const runs: GhRun[] = []
  const logs: string[] = []
  cfg(on)
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  writeLetThrough(on)
  journalRefused = true
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  await startSession($)

  const out = await $.tool.call(EXEMPTION_WRITE)
  expect(out).toEqual({ result: 'written' })
  expect(journaled).toEqual([])
  expect(logs.filter((line) => line.includes('github.exemption.write could not be journaled') && line.includes('EACCES')).length).toBe(1)
})

test('a log that fails too leaves the call going', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  writeLetThrough(on)
  on('env.get', () => ({ value: undefined }))
  on('ui.log', () => {
    throw new Error('no log')
  })
  await startSession($)

  const out = await $.tool.call(EXEMPTION_WRITE)
  expect(out).toEqual({ result: 'written' })
})

test('a deny verdict wins over the rules and over a second send', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'deny', reason: 'denied by rule', rule: 'mcp__github__gh' })
  stubAsk(on, asked, 'Send as it is')
  await startSession($)

  const call = { tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Done; thanks' } } as const
  await $.tool.call(call)
  const out = await $.tool.call(call)
  expect(JSON.stringify(out)).toContain('denied by rule')
  expect(asked.length).toBe(0)
  expect(runs.length).toBe(0)
})

test('pr-create is sent as a draft when the call does not say', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [])
  await startSession($)

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-create', args: { title: 'fix: x', body: 'Text\n\n' + NONE } })
  expect(runs[0]?.args['draft']).toBe(true)
})


test('a pr-create out of draft and a pr-ready outside auto-merge go through under an allow rule, never asked', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Allow')
  stubAutoMerge(on, {}, {})
  await startSession($)

  const create = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-create', args: { title: 'fix: x', body: 'Text\n\n' + NONE, draft: false } })
  expect(create).toEqual({ result: 'ok' })
  expect(journaled).toEqual([])
  const ready = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
  expect(ready).toEqual({ result: 'ok' })
  expect(journaled).toEqual([])
  expect(asked.length).toBe(0)
  expect(acts(runs).map((r) => r.command)).toEqual(['pr-create', 'pr-ready'])
})

test('a pr-merge is asked even when a rule allows, and Deny runs nothing', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, {}, {})
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('Merge a pull request')
  expect(JSON.stringify(out)).toContain('refused gh pr-merge')
  expect(acts(runs).length).toBe(0)
})

test('a pr-merge on a repository in auto-merge is not asked under an allow rule', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
  expect(acts(runs).length).toBe(1)
})

test('a title-only pr-update under an allow rule is not asked', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-update', args: { pr: 1, title: 'fix: x' } })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
})

test('a reserved approval refused by the person runs nothing', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, [], 'Deny')
  stubAutoMerge(on, {}, {})
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(JSON.stringify(out)).toContain('refused gh pr-merge')
  expect(acts(runs).length).toBe(0)
})

// ---- repositories in auto-merge ----

// env: the variables $.env.get answers. files: the files $.fs reads, by path,
// a null text being a file that exists but cannot be read. logs: $.ui.log lines.
// looked: the paths $.fs.exists was asked about. The records of acme/thing and acme/other #1 are
// served beside them, so the ready guard finds a ready pull request.
function stubAutoMerge(on: TestOn, env: Record<string, string>, given: Record<string, string | null>, logs: string[] = [], looked: string[] = [], more: Record<string, string> = {}) {
  const records = { ...recordFiles('acme/thing', 1), ...recordFiles('acme/other', 1), ...more }
  const files: Record<string, string | null> = { ...records, ...given }
  on('env.get', (_$, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' && !('CLAUDE_CONFIG_DIR' in env) ? '/cfg' : env[e.name] }))
  on('fs.list', (_$, e) => {
    const below = Object.keys(records).filter((path) => path.startsWith(e.path + '/'))
    return below.length > 0
      ? { value: below.map((path) => ({ name: path.slice(e.path.length + 1), kind: 'file', size: 1, isLink: false })) }
      : { deny: 'ENOENT ' + e.path }
  })
  on('fs.exists', (_$, e) => {
    if (!e.path.startsWith(RECORDS_ROOT)) looked.push(e.path)
    return { value: e.path in files }
  })
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    return typeof text === 'string' ? { value: text } : { deny: 'EACCES ' + e.path }
  })
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
}

const DATA = { CLAUDE_PLUGIN_DATA: '/data/github' }
const LISTED = { '/data/github/auto-merge.json': '{"repositories": ["Acme/Thing"]}' }

test('a pr-ready on a repository in auto-merge is not asked', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
  expect(acts(runs).length).toBe(1)
  expect(runs.filter((r) => r.command === 'pr-gate').length).toBe(1)
})


test('a pr-ready on a repository not in auto-merge is asked', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Allow')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/other' })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(1)
  expect(acts(runs).length).toBe(1)
})


test('with no auto-merge file a pr-ready is asked, and nothing is logged', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  const logs: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Allow')
  stubAutoMerge(on, DATA, {}, logs)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(1)
  expect(acts(runs).length).toBe(1)
  expect(logs).toEqual([])
})


for (const [what, text] of [['unreadable', null], ['without a list', '{"repositories": "acme/thing"}'], ['not JSON', 'not json']] as const) {
  test('an auto-merge file ' + what + ' reads as no repository in auto-merge: leaving draft is asked, with one log line naming it', async ($, on) => {
    const runs: GhRun[] = []
    const asked: string[] = []
    const logs: string[] = []
    await stubMod(on, runs, [], undefined, { decision: 'ask' })
    stubAsk(on, asked, 'Allow')
    stubAutoMerge(on, DATA, { '/data/github/auto-merge.json': text }, logs)
    await startSession($)

    const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
    expect(out).toEqual({ result: 'ok' })
    expect(asked.length).toBe(1)
    expect(acts(runs).length).toBe(1)
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain('/data/github/auto-merge.json')
  })
}


test('a description replaced on a repository in auto-merge is not asked, a pull request opened out of draft is not asked either', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-update', args: { pr: 1, body: 'New text\n\n' + NONE }, repo: 'acme/thing' })
  expect(journaled).toEqual([])
  const create = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-create', args: { title: 'fix: x', body: 'Text\n\n' + NONE, draft: false }, repo: 'acme/thing' })
  expect(create).toEqual({ result: 'ok' })
  expect(journaled).toEqual([])
  expect(asked.length).toBe(0)
  expect(runs.map((r) => r.command)).toEqual(['pr-update', 'pr-create'])
})


test('a pull request opened or taken out of draft on a repository not in auto-merge goes through, a description replaced is not asked', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-update', args: { pr: 1, body: 'New text\n\n' + NONE }, repo: 'acme/other' })
  expect(asked.length).toBe(0)
  expect(runs.length).toBe(1)
  expect(journaled).toEqual([])
  const create = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-create', args: { title: 'fix: x', body: 'Text\n\n' + NONE, draft: false }, repo: 'acme/other' })
  const ready = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/other' })
  expect(create).toEqual({ result: 'ok' })
  expect(ready).toEqual({ result: 'ok' })
  expect(journaled).toEqual([])
  expect(asked.length).toBe(0)
  expect(acts(runs).map((r) => r.command)).toEqual(['pr-update', 'pr-create', 'pr-ready'])
})

test('a description replaced is refused under a deny rule', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'deny', reason: 'denied by rule', rule: 'mcp__github__gh' })
  stubAsk(on, asked, 'Allow')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-update', args: { pr: 1, body: 'New text\n\n' + NONE }, repo: 'acme/other' })
  expect(JSON.stringify(out)).toContain('denied by rule')
  expect(asked.length).toBe(0)
  expect(runs.length).toBe(0)
})

test('a description replaced under an ask from a rule is still asked', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask', rule: 'mcp__github__gh' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-update', args: { pr: 1, body: 'New text\n\n' + NONE }, repo: 'acme/other' })
  expect(asked.length).toBe(1)
  expect(runs.length).toBe(0)
})


const SOME_WRITES: [string, any][] = [
  ['pr-comment', { pr: 1, body: 'Thanks.' }],
  ['pr-merge', { pr: 1 }],
  ['comment-delete', { id: 5 }],
]

for (const [command, args] of SOME_WRITES) {
  test('a ' + command + ' with an ask and no rule on a repository in auto-merge is not asked', async ($, on) => {
    const runs: GhRun[] = []
    const asked: string[] = []
    await stubMod(on, runs, [], undefined, { decision: 'ask' })
    stubAsk(on, asked, 'Deny')
    stubAutoMerge(on, DATA, LISTED)
    await startSession($)

    const out = await $.tool.call({ tool: 'mcp__github__gh', command, args, repo: 'acme/thing' })
    expect(out).toEqual({ result: 'ok' })
    expect(asked.length).toBe(0)
    expect(acts(runs).length).toBe(1)
    if (command === 'pr-merge') expect(runs.filter((r) => r.command === 'pr-gate').length).toBe(1)
  })

  test('a ' + command + ' with an ask and no rule on a repository not in auto-merge is asked', async ($, on) => {
    const runs: GhRun[] = []
    const asked: string[] = []
    await stubMod(on, runs, [], undefined, { decision: 'ask' })
    stubAsk(on, asked, 'Deny')
    stubAutoMerge(on, DATA, LISTED)
    await startSession($)

    await $.tool.call({ tool: 'mcp__github__gh', command, args, repo: 'acme/other' })
    expect(asked.length).toBe(1)
    expect(acts(runs).length).toBe(0)
  })

  test('a ' + command + ' with an ask from a rule on a repository in auto-merge is still asked', async ($, on) => {
    const runs: GhRun[] = []
    const asked: string[] = []
    await stubMod(on, runs, [], undefined, { decision: 'ask', rule: 'mcp__github__gh' })
    stubAsk(on, asked, 'Deny')
    stubAutoMerge(on, DATA, LISTED)
    await startSession($)

    await $.tool.call({ tool: 'mcp__github__gh', command, args, repo: 'acme/thing' })
    expect(asked.length).toBe(1)
    expect(acts(runs).length).toBe(0)
  })

  test('a ' + command + ' denied by a rule on a repository in auto-merge is refused', async ($, on) => {
    const runs: GhRun[] = []
    const asked: string[] = []
    await stubMod(on, runs, [], undefined, { decision: 'deny', reason: 'denied by rule', rule: 'mcp__github__gh' })
    stubAsk(on, asked, 'Allow')
    stubAutoMerge(on, DATA, LISTED)
    await startSession($)

    const out = await $.tool.call({ tool: 'mcp__github__gh', command, args, repo: 'acme/thing' })
    expect(JSON.stringify(out)).toContain('denied by rule')
    expect(asked.length).toBe(0)
    expect(runs.length).toBe(0)
  })
}

test('a read on a repository in auto-merge does not read the auto-merge file', async ($, on) => {
  const runs: GhRun[] = []
  const reads: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, [], 'Deny')
  stubAutoMerge(on, DATA, LISTED, [], reads)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-list', repo: 'acme/thing' })
  expect(out).toEqual({ result: 'ok' })
  expect(reads).toEqual([])
})

test('a write reads the auto-merge file once', async ($, on) => {
  const runs: GhRun[] = []
  const reads: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, [], 'Deny')
  stubAutoMerge(on, DATA, LISTED, [], reads)
  await startSession($)

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
  expect(reads.filter((path) => path.endsWith('/auto-merge.json')).length).toBe(1)
})


test('a pr-ready on a repository in auto-merge still follows the permission rules', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'deny', reason: 'denied by rule', rule: 'mcp__github__gh' })
  stubAsk(on, asked, 'Allow')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
  expect(JSON.stringify(out)).toContain('denied by rule')
  expect(runs.length).toBe(0)
})

test('without a repo in the call, the checkout\'s origin names the repository', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  const reply = (e: NounEvents['process.run']): RunReply => e.argv[0] === 'git'
    ? { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n', stderr: '' }
    : { exitCode: 0, stdout: 'ok', stderr: '' }
  await stubMod(on, runs, [], reply, { decision: 'ask' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 } })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
  expect(acts(runs).map((r) => r.argv[0])).toEqual(['git', 'python3'])
})

test('GH_REPO names the repository before the origin, as it does for the engine', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  const reply = (e: NounEvents['process.run']): RunReply => e.argv[0] === 'git'
    ? { exitCode: 0, stdout: 'https://github.com/acme/thing.git\n', stderr: '' }
    : { exitCode: 0, stdout: 'ok', stderr: '' }
  await stubMod(on, runs, [], reply, { decision: 'ask' })
  stubAsk(on, asked, 'Allow')
  stubAutoMerge(on, { ...DATA, GH_REPO: 'acme/other' }, LISTED)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 } })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(1)
  expect(acts(runs).map((r) => r.argv[0])).toEqual(['python3'])
})

test('a repo in the call names the repository before one in its args', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Allow')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  const other = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1, repo: 'acme/thing' }, repo: 'acme/other' })
  expect(other).toEqual({ result: 'ok' })
  expect(asked.length).toBe(1)
  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1, repo: 'acme/thing' } })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(1)
})

test('an empty repo in the call hides the one in its args, as the engine\'s last --repo= does', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  const reply = (e: NounEvents['process.run']): RunReply => e.argv[0] === 'git'
    ? { exitCode: 0, stdout: 'git@github.com:acme/other.git\n', stderr: '' }
    : { exitCode: 0, stdout: 'ok', stderr: '' }
  await stubMod(on, runs, [], reply, { decision: 'ask' })
  stubAsk(on, asked, 'Allow')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1, repo: 'acme/thing' }, repo: '' })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(1)
  expect(acts(runs).map((r) => r.argv[0])).toEqual(['git', 'python3'])
})

test('a repo in the args alone names the repository', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1, repo: 'acme/thing' } })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
  expect(acts(runs).map((r) => r.argv[0])).toEqual(['python3'])
})

test('an https origin of a listed repository, in another case, is not asked', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  const reply = (e: NounEvents['process.run']): RunReply => e.argv[0] === 'git'
    ? { exitCode: 0, stdout: 'https://github.com/ACME/Thing.git\n', stderr: '' }
    : { exitCode: 0, stdout: 'ok', stderr: '' }
  await stubMod(on, runs, [], reply, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 } })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
})

test('an origin git cannot give is no repository in auto-merge', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  const reply = (e: NounEvents['process.run']): RunReply => e.argv[0] === 'git'
    ? { exitCode: 2, stdout: 'https://github.com/acme/thing.git\n', stderr: 'error: No such remote' }
    : { exitCode: 0, stdout: 'ok', stderr: '' }
  await stubMod(on, runs, [], reply, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 } })
  expect(out.deny).toBe('github: readiness of the origin repository#1 unverified: no repository or pull request named')
  expect(asked.length).toBe(0)
  expect(runs.map((r) => r.argv[0])).toEqual(['git'])
})

test('a git run that throws is no repository in auto-merge', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  const reply = (e: NounEvents['process.run']): RunReply => {
    if (e.argv[0] === 'git') throw new Error('spawn git ENOENT')
    return { exitCode: 0, stdout: 'ok', stderr: '' }
  }
  await stubMod(on, runs, [], reply, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 } })
  expect(out.deny).toBe('github: readiness of the origin repository#1 unverified: no repository or pull request named')
  expect(asked.length).toBe(0)
  expect(runs.map((r) => r.argv[0])).toEqual(['git'])
})


test('an auto-merge list that is not made of strings reads as none: leaving draft is asked, with one log line', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  const logs: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Allow')
  stubAutoMerge(on, DATA, { '/data/github/auto-merge.json': '{"repositories": [1]}' }, logs)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(1)
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('/data/github/auto-merge.json')
})

test('without CLAUDE_PLUGIN_DATA the list is read from the plugin\'s data directory under HOME', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, { HOME: '/home/x' }, {
    '/home/x/.claude/plugins/data/github-lounisbou/auto-merge.json': '{"repositories": ["acme/thing"]}',
  })
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
})

// ---- « Allow for this session » ----

test('« Allow for this session » runs the call and every later one of that command on that repository', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Allow for this session')
  await startSession($)

  const reply = (n: number, repo?: string) => $.tool.call({ tool: 'mcp__github__gh', command: 'thread-reply', args: { thread_id: 'T' + n, body: 'Fixed' }, ...(repo ? { repo } : {}) })
  await reply(1, 'acme/thing')
  await reply(2, 'Acme/Thing')
  expect(asked.length).toBe(1)
  expect(runs.length).toBe(2)
})

test('a grant covers neither another command nor another repository', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  let first = true
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = dialogOf(e).question
    asked.push(question)
    const answer = first ? 'Allow for this session' : 'Deny'
    first = false
    return { result: { questions: e['questions'], answers: { [question]: answer } } }
  })
  await startSession($)

  await $.tool.call({ tool: 'mcp__github__gh', command: 'thread-reply', args: { thread_id: 'T1', body: 'Fixed' }, repo: 'acme/thing' })
  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Fixed' }, repo: 'acme/thing' })
  await $.tool.call({ tool: 'mcp__github__gh', command: 'thread-reply', args: { thread_id: 'T2', body: 'Fixed' }, repo: 'acme/other' })
  await $.tool.call({ tool: 'mcp__github__gh', command: 'thread-reply', args: { thread_id: 'T3', body: 'Fixed' } })
  expect(asked.length).toBe(4)
  expect(runs.length).toBe(1)
})

test('a merge and a deletion are never offered for the session', async ($, on) => {
  const runs: GhRun[] = []
  const options: (readonly string[])[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = dialogOf(e)
    options.push(q.labels)
    return { result: { questions: e['questions'], answers: { [q.question]: 'Allow' } } }
  })
  stubAutoMerge(on, {}, {})
  await startSession($)

  for (const command of NEVER_GRANTED) {
    await $.tool.call({ tool: 'mcp__github__gh', command, args: command === 'pr-merge' ? { pr: 1 } : { comment_id: 1 }, repo: 'acme/thing' })
  }
  expect(options).toEqual([['Allow', 'Deny'], ['Allow', 'Deny']])
  expect(acts(runs).length).toBe(2)
})

test('an explicit ask rule is never answered by a grant', async ($, on) => {
  const runs: GhRun[] = []
  const options: (readonly string[])[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask', rule: 'mcp__github__gh' })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = dialogOf(e)
    options.push(q.labels)
    return { result: { questions: e['questions'], answers: { [q.question]: 'Allow' } } }
  })
  await startSession($)

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Fixed' } })
  expect(options).toEqual([['Allow', 'Deny']])
})

test('a grant passes a text that breaks a rule, observed, and never a deny verdict', async ($, on) => {
  const runs: GhRun[] = []
  let verdict: Verdict = { decision: 'ask' }
  const session = freshSession()
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: session }))
  on('session.cwd', () => ({ value: '/work' }))
  on('tool.check', (_$, e) => (e.tool === 'AskUserQuestion' || e.tool === 'Read' ? { decision: 'allow' } : verdict))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  cfg(on)
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    // The journal's event moves into place: no act of the session.
    if (e.argv[0] === 'mv') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    runs.push(JSON.parse(e.init?.stdin ?? '{}'))
    return { value: { exitCode: 0, stdout: 'ok', stderr: '' } }
  })
  stubAsk(on, [], 'Allow for this session')
  await startSession($)

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Fixed' } })
  expect(runs.length).toBe(1)
  const bad = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Fixed; thanks' } })
  expect(bad).toEqual({ result: 'ok' })
  expect(runs.length).toBe(2)
  verdict = { decision: 'deny', reason: 'now denied', rule: 'mcp__github__gh' }
  const denied = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Fixed' } })
  expect(JSON.stringify(denied)).toContain('now denied')
  expect(runs.length).toBe(2)
})

test('a grant is not given when the person picks plain Allow, nor by text typed under Other', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  const answers = ['Allow', 'yes, allow it for the whole session', 'Deny']
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = dialogOf(e).question
    asked.push(question)
    return { result: { questions: e['questions'], answers: { [question]: answers[asked.length - 1] } } }
  })
  await startSession($)

  for (const n of [1, 2, 3]) await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: n, body: 'Fixed' } })
  expect(asked.length).toBe(3)
  expect(runs.length).toBe(1)
})

test('a grant on the origin repository holds for its directory and its session only', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  let session = freshSession()
  let cwd = '/work'
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: session }))
  on('session.cwd', () => ({ value: cwd }))
  on('tool.check', (_$, e) => ({ decision: e.tool === 'AskUserQuestion' || e.tool === 'Read' ? 'allow' : 'ask' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    runs.push(JSON.parse(e.init?.stdin ?? '{}'))
    return { value: { exitCode: 0, stdout: 'ok', stderr: '' } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = dialogOf(e).question
    asked.push(question)
    return { result: { questions: e['questions'], answers: { [question]: asked.length === 1 ? 'Allow for this session' : 'Deny' } } }
  })
  await startSession($)

  const reply = () => $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Fixed' } })
  await reply()
  await reply()
  cwd = '/elsewhere'
  await reply()
  cwd = '/work'
  session = freshSession()
  await reply()
  expect(asked.length).toBe(3)
  expect(runs.length).toBe(2)
})

// ---- the pane's watch ----

const row = (number: number, ci: string, failed: string[] = []) =>
  ({ number, title: 't', url: 'u', draft: false, comments: 0, ci, failed })

test('a CI toast comes only when a PR read twice reaches an end', () => {
  expect(ciTransitions([], [row(1, 'FAILURE')])).toEqual([])
  expect(ciTransitions([row(1, 'PENDING')], [row(1, 'FAILURE', ['lint'])])).toEqual(['#1 CI: FAILURE (lint)'])
  expect(ciTransitions([row(1, 'FAILURE')], [row(1, 'SUCCESS')])).toEqual(['#1 CI: SUCCESS'])
  expect(ciTransitions([row(1, 'SUCCESS')], [row(1, 'SUCCESS')])).toEqual([])
  expect(ciTransitions([row(1, 'SUCCESS')], [row(1, 'PENDING')])).toEqual([])
  expect(ciTransitions([row(1, '?')], [row(1, 'SUCCESS')])).toEqual([])
  expect(ciTransitions([row(1, '–')], [row(1, 'FAILURE')])).toEqual([])
})

// The pane as `$.ui.panes()` lists it: shown, behind another tab, or closed.
type PaneState = 'shown' | 'hidden' | 'closed'
const PANES = {
  shown: [{ id: 'github-prs', title: 'PRs', isShown: true, isFocused: false, isPlaced: true }],
  hidden: [{ id: 'github-prs', title: 'PRs', isShown: false, isFocused: false, isPlaced: true }],
  closed: [],
} as const

function stubPane(on: TestOn, runs: GhRun[], ci: () => string, pane: () => PaneState = () => 'shown') {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: PANES[pane()] }))
  return stubMod(on, runs, [], byCommand({
    'pr-panel': () => ok(JSON.stringify([
      panelRow(12, { title: 'fix: related PRs', ci: ci(), failed: ci() === 'FAILURE' ? ['lint'] : [] }),
      panelRow(11, { title: 'feat: minimize nodes', draft: true, ci: ci(), failed: ci() === 'FAILURE' ? ['lint'] : [] }),
    ])),
    'pr-comment': () => ok('posted'),
  }))
}

const reads = (runs: GhRun[]) => runs.filter((r) => r.command === 'pr-panel').length

test('the open pane is read again every five minutes, never sooner, and toasts a CI that ended', async ($, on) => {
  const clock = mock.clock(on)
  const runs: GhRun[] = []
  const toasts: string[] = []
  let ci = 'PENDING'
  await stubPane(on, runs, () => ci)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'prs', args: '' })
  expect(reads(runs)).toBe(1)

  ci = 'FAILURE'
  await clock.advance(5 * 60_000 - 1)
  expect(reads(runs)).toBe(1)
  await clock.advance(1)
  expect(reads(runs)).toBe(2)
  expect(toasts).toEqual(['#12 CI: FAILURE (lint)', '#11 CI: FAILURE (lint)'])
  // The refresh is one engine run, not a list and a run or two for each PR.
  expect(runs.map((r) => r.command)).toEqual(['pr-panel', 'pr-panel'])

  const ui = await $.ui.mount({ ...PANE_EVENT })
  expect(await ui.find({ type: 'Box', key: 'room-12', text: /fix: related PRs/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'label-12', text: 'CI:FAILURE' })).toBeDefined()
  await ui.unmount()
  // Drawing a pane whose rows were just read reads nothing.
  expect(reads(runs)).toBe(2)
})

test('a read made a little after its tick does not make the next tick skip', async ($, on) => {
  const clock = mock.clock(on)
  const runs: GhRun[] = []
  await stubPane(on, runs, () => 'SUCCESS')
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  await clock.advance(WATCH_MS)
  expect(reads(runs)).toBe(2)
  // A write read the rows again 5 s after the tick: the next tick finds them 295 s old, and reads.
  await clock.advance(5_000)
  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 12, body: 'Fixed' } })
  await clock.settle()
  expect(reads(runs)).toBe(3)
  await clock.advance(WATCH_MS - 5_000)
  expect(reads(runs)).toBe(4)
})

test('a pane that is open but undrawn, or missing from the host\'s list, is not read on the watch', async ($, on) => {
  const clock = mock.clock(on)
  const runs: GhRun[] = []
  let panes: unknown = PANES.shown
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: panes }))
  await stubMod(on, runs, [], byCommand({ 'pr-panel': () => ok(PR_LIST) }))
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  panes = [{ ...PANES.shown[0], isPlaced: false }]
  await clock.advance(WATCH_MS)
  panes = PANES.closed
  await clock.advance(WATCH_MS)
  expect(reads(runs)).toBe(1)
})

test('a host that cannot list its panes reads the watched pane as shown', async ($, on) => {
  const clock = mock.clock(on)
  const runs: GhRun[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ deny: 'no panes' }))
  await stubMod(on, runs, [], byCommand({ 'pr-panel': () => ok(PR_LIST) }))
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  await clock.advance(WATCH_MS)
  expect(reads(runs)).toBe(2)
})

test('an answer of pr-panel that is not a list of rows is an error line, the rows kept', async ($, on) => {
  let call = 0
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await stubMod(on, [], [], byCommand({
    'pr-panel': () => ok((call += 1) === 1 ? PR_LIST : JSON.stringify([{ number: 1, title: 't', url: 'u', draft: false, comments: 'many', ci: 'SUCCESS', failed: [] }])),
  }))
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /fix: related PRs/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /without its comment count or CI state/ })).toBeDefined()
  await ui.unmount()
})

test('a pane that is not shown is never read on the watch, and read once when it shows again', async ($, on) => {
  const clock = mock.clock(on)
  const runs: GhRun[] = []
  let pane: PaneState = 'shown'
  await stubPane(on, runs, () => 'SUCCESS', () => pane)
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })
  expect(reads(runs)).toBe(1)

  pane = 'hidden'
  await clock.advance(5 * 60_000)
  await clock.advance(5 * 60_000)
  await clock.advance(5 * 60_000)
  expect(reads(runs)).toBe(1)

  // It shows again: it is drawn, its rows are older than the interval, one read follows.
  pane = 'shown'
  const ui = await $.ui.mount({ ...PANE_EVENT })
  await clock.settle()
  expect(reads(runs)).toBe(2)
  // Drawn again at once: the rows are fresh, no second read.
  await ui.redraw()
  await clock.settle()
  expect(reads(runs)).toBe(2)
  await ui.unmount()
})

test('a pane shown again within the interval keeps its rows, with no read', async ($, on) => {
  const clock = mock.clock(on)
  const runs: GhRun[] = []
  await stubPane(on, runs, () => 'SUCCESS')
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  await clock.advance(60_000)
  const ui = await $.ui.mount({ ...PANE_EVENT })
  await clock.settle()
  expect(reads(runs)).toBe(1)
  await ui.unmount()
})

// The kit's $ cannot raise ui.close (the person's close mark): a plugin beside the module closes the panes.
test('closing the pane stops the watch, closing another pane does not', {
  plugins: [{
    name: 'closer',
    register(on: TestOn) {
      on('command.run', { command: 'close-pane' }, async ($, e) => {
        await $.ui.close({ id: e.args })
        return { text: 'closed' }
      })
    },
  }],
}, async ($, on) => {
  const clock = mock.clock(on)
  const runs: GhRun[] = []
  await stubPane(on, runs, () => 'SUCCESS')
  on('ui.close', () => ({ value: undefined }))
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })
  expect(reads(runs)).toBe(1)
  await $.command.run({ command: 'close-pane', args: 'another-pane' })
  await clock.advance(WATCH_MS)
  expect(reads(runs)).toBe(2)
  await $.command.run({ command: 'close-pane', args: 'github-prs' })
  await clock.advance(WATCH_MS)
  expect(reads(runs)).toBe(2)
  // Opened again, the pane is watched again.
  await $.command.run({ command: 'prs', args: '' })
  await clock.advance(WATCH_MS)
  expect(reads(runs)).toBe(4)
})

test('a write through the tool reads the shown pane again, a read does not', async ($, on) => {
  const clock = mock.clock(on)
  const runs: GhRun[] = []
  await stubPane(on, runs, () => 'SUCCESS')
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-list' })
  expect(reads(runs)).toBe(1)
  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 12, body: 'Fixed' } })
  await clock.settle()
  expect(reads(runs)).toBe(2)
})

test('a write while the pane is not shown reads nothing until it shows again', async ($, on) => {
  const clock = mock.clock(on)
  const runs: GhRun[] = []
  let pane: PaneState = 'hidden'
  await stubPane(on, runs, () => 'SUCCESS', () => pane)
  await startSession($)
  await $.command.run({ command: 'prs', args: '' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 12, body: 'Fixed' } })
  await clock.settle()
  expect(reads(runs)).toBe(1)

  // Shown a minute later, well inside the interval: the write made the rows stale, one read follows.
  await clock.advance(60_000)
  pane = 'shown'
  const ui = await $.ui.mount({ ...PANE_EVENT })
  await clock.settle()
  expect(reads(runs)).toBe(2)
  await ui.unmount()
})

test('no pane open, a write reads nothing more', async ($, on) => {
  const runs: GhRun[] = []
  await stubPane(on, runs, () => 'SUCCESS')
  await startSession($)

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 12, body: 'Fixed' } })
  expect(runs.map((r) => r.command)).toEqual(['pr-comment'])
})

// ---- /github:install and /github:doctor ----

test('/github:doctor runs install.sh and names its exit code, with no model turn', async ($, on) => {
  const runs: (readonly string[])[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 12, stdout: '', stderr: 'github: no token\ngithub: not ready.\n' } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  for (const command of ['github:doctor', 'github:install']) {
    const out = await $.command.run({ command, args: '' })
    expect(out.text).toBe('github: no token\ngithub: not ready.\n\nExit code 12: no GitHub token: run /github:install.')
  }
  expect(runs[0]?.[0]).toBe('bash')
  expect(runs[0]?.[1]?.endsWith('/install.sh')).toBe(true)
  // doctor only checks; install may install gh and start the sign-in.
  expect(runs[0]?.slice(2)).toEqual(['--check'])
  expect(runs[1]?.slice(2)).toEqual([])
})

test('/github:doctor falls back to the markdown command when the script cannot run', async ($, on) => {
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', () => ({ deny: 'no process' }))
  on('command.run', { command: 'github:doctor' }, () => ({ text: 'markdown ran' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.command.run({ command: 'github:doctor', args: '' })
  expect(out.text).toBe('markdown ran')
})

// ---- texts authored with no read of the writing rules ----

test('a fresh session commits, opens a pull request and comments with no read of the writing rules', async ($, on) => {
  const runs: GhRun[] = []
  const bash: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    bash.push(String(e['command']))
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  await startSession($)

  const commit = await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix: x"' })
  expect(commit.deny).toBeUndefined()
  expect(bash).toEqual(['git commit -m "fix: x"'])
  const comment = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Thanks.' } })
  expect(comment).toEqual({ result: 'ok' })
  expect(runs.length).toBe(1)
})

test('a failed guard refuses, from the call alone, what it still refuses and lets the rest through', () => {
  for (const command of ['gh pr merge 5', 'gh pr ready 5', 'echo [] > ~/.claude/plugins/data/github/auto-merge.json', 'cat ~/.claude/plugins/data/github/auto-deploy.json']) {
    expect(bashNetRefusal(command)).toBe(NET_REFUSAL)
  }
  for (const command of ['git status', 'gh pr create --title t', 'gh pr create --draft --title t', 'gh pr ready 5 --undo', 'npm test', 'cat ~/.claude/plugins/data/github/pr-records/1.json']) {
    expect(bashNetRefusal(command)).toBe(null)
  }
  expect(writeNetRefusal('/h/.claude/plugins/data/github/auto-merge.json')).toBe(NET_REFUSAL)
  expect(writeNetRefusal('/h/.claude/plugins/data/github/pr-records/1.json')).toBe(null)
  expect(writeNetRefusal('/work/src/app.ts')).toBe(null)
})

test('a review of a head this session pushed is refused; another kind, or another head, is not', () => {
  const head = 'a'.repeat(40)
  const pushed = new Set([head])
  expect(String(selfReviewRefusal('review', head, pushed))).toContain('a review is made by another session')
  expect(selfReviewRefusal('review', 'b'.repeat(40), pushed)).toBe(null)
  expect(selfReviewRefusal('e2e', head, pushed)).toBe(null)
  expect(selfReviewRefusal('norms', head, pushed)).toBe(null)
})

test('/github:protect checks the default branch, applies the protection only on « apply », and requires the CI check on « ci »', async ($, on) => {
  const asked: string[] = []
  on('env.get', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n', stderr: '' } }
    const sent = String(e.init?.stdin ?? '')
    const request = runOf(e)
    if (sent.includes('"command"')) asked.push(request.command + (request.args['require-ci'] ? ' --require-ci' : ''))
    return { value: { exitCode: 0, stdout: 'protected main\n', stderr: '' } }
  })
  expect((await $.command.run({ command: 'github:protect', args: '' })).text).toBe('protected main')
  await $.command.run({ command: 'github:protect', args: 'apply' })
  await $.command.run({ command: 'github:protect', args: 'apply ci' })
  expect(asked).toEqual(['protect-check', 'protect-apply', 'protect-apply --require-ci'])
})

test('/github:protect says what failed', async ($, on) => {
  on('env.get', () => ({ value: undefined }))
  on('process.run', (_$, e) => (e.argv[0] === 'git'
    ? { value: { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n', stderr: '' } }
    : { value: { exitCode: 3, stdout: '', stderr: 'Resource not accessible by integration' } }))
  expect(String((await $.command.run({ command: 'github:protect', args: '' })).text)).toBe('github: protect-check failed: Resource not accessible by integration')
})

test('the records guard reads the words as the shell does', () => {
  expect(touchesRecords('python3 /x/engine/rec""ord.py --kind review')).toBe(true)
  expect(touchesRecords("cat ~/.claude/pr-rec'ords'/a/b/c.json")).toBe(true)
  expect(touchesRecords('python3 scripts/report.py')).toBe(false)
})


test('a failed guard lets a write naming the E2E exemption files through (observed), and refuses a deletion in them', () => {
  expect(writeNetRefusal('/home/x/.claude/plugins/data/github-lounisbou/e2e-exempt/o/r.json')).toBe(null)
  expect(bashNetRefusal('echo {} > "$CLAUDE_PLUGIN_DATA/e2e-exempt/o/r.json"')).toBe(null)
  expect(bashNetRefusal('rm -r "$CLAUDE_PLUGIN_DATA/e2e-exempt/o"')).toBe(NET_REFUSAL)
  expect(bashNetRefusal('rm -r "$CLAUDE_PLUGIN_DATA/e2e-exempt"')).toBe(NET_REFUSAL)
  expect(bashNetRefusal('find "$CLAUDE_PLUGIN_DATA/e2e-exempt" -delete')).toBe(NET_REFUSAL)
  expect(bashNetRefusal('mv "$CLAUDE_PLUGIN_DATA/e2e-exempt/o/r.json" /tmp')).toBe(NET_REFUSAL)
  expect(bashNetRefusal('cat "$CLAUDE_PLUGIN_DATA/e2e-exempt/o/r.json"')).toBe(null)
})

test('a failed guard lets a write naming the check plan files through (observed), and refuses a deletion in them', () => {
  expect(writeNetRefusal('/home/x/.claude/plugins/data/github-lounisbou/check-plans/o/r/1.json')).toBe(null)
  expect(bashNetRefusal('rm -r "$CLAUDE_PLUGIN_DATA/check-plans/o"')).toBe(NET_REFUSAL)
})

test('a failed guard refuses a deletion in the records, and lets a read or another write through', () => {
  expect(bashNetRefusal('rm ~/.claude/pr-records/o/r/x.json')).toBe(NET_REFUSAL)
  expect(bashNetRefusal('find ~/.claude/pr-records -delete')).toBe(NET_REFUSAL)
  expect(bashNetRefusal('mv -t /tmp ~/.claude/pr-records/o/r/x.json')).toBe(NET_REFUSAL)
  expect(bashNetRefusal('ls {1..9}{1..9}{1..9}{1..9}; rm ~/.claude/pr-records/x')).toBe(NET_REFUSAL)
  expect(bashNetRefusal('ls {1..9}{1..9}{1..9}{1..9}; mv ~/.claude/pr-records/x /tmp')).toBe(NET_REFUSAL)
  expect(bashNetRefusal('echo x > ~/.claude/pr-records/o/r/x.json')).toBe(null)
  expect(bashNetRefusal('cat ~/.claude/pr-records/o/r/x.json')).toBe(null)
})
// ---- a merge of a stack ----

// pr-merge asked for the stack answers this plan, merging nothing; any other call answers ok.
const stackPlan = (order: 'bottom-up' | 'top-down', prs: number[]) => JSON.stringify({
  stack: { order, why: 'a test says so', base: 'main', members: prs.map((pr, depth) => ({ pr, depth, head: 'feat/' + pr, base: depth === 0 ? 'main' : 'feat/' + prs[depth - 1] })) },
})
const stackReply = (plan: string, fails: (run: GhRun) => string | undefined = () => undefined): Replier => (e) => {
  const run = runOf(e)
  if (run.command === 'pr-merge' && run.args['stack'] === true) return { exitCode: 0, stdout: plan, stderr: '' }
  const failure = fails(run)
  return failure === undefined ? { exitCode: 0, stdout: '{"merged":true}', stderr: '' } : { exitCode: 1, stdout: '', stderr: failure }
}
// What the walk did, in order: each merge by its pull request, each retarget with its base.
const walked = (runs: GhRun[]) => runs
  .filter((r) => (r.command === 'pr-merge' && r.args['stack'] !== true) || r.command === 'pr-update')
  .map((r) => r.command === 'pr-merge' ? 'merge ' + String(r.args['pr']) : 'retarget ' + String(r.args['pr']) + ' to ' + String(r.args['base']))
// Each pull request of the stack has a head of its own, and its records at it.
const headOf = (pr: number) => HEAD.slice(0, -1) + String(pr)
const stackGate = (repo: string, pr: number) => readyGate(repo, pr).replace(HEAD, headOf(pr))
const stackRecords = Object.assign({}, ...[1, 2, 3].map((pr) => recordFiles('acme/thing', pr, headOf(pr)))) as Record<string, string>
const failingGate = (pr: number) => (repo: string, n: number) => n === pr
  ? JSON.stringify({ repo, pr: n, state: 'open', draft: false, head: headOf(n), labels: ['Not Ready'], ci: { result: 'FAILURE', failed: ['lint'], running: 0, skipped: [], total: 1 } })
  : stackGate(repo, n)

test('a stack that runs CI on every pull request merges bottom-up, each next retargeted to the base first', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], stackReply(stackPlan('bottom-up', [1, 2, 3])), undefined, stackGate)
  stubAutoMerge(on, DATA, LISTED, [], [], stackRecords)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 2 }, repo: 'acme/thing' })
  expect(out.deny).toBeUndefined()
  expect(walked(runs)).toEqual(['merge 1', 'retarget 2 to main', 'merge 2', 'retarget 3 to main', 'merge 3'])
  expect(String(out.result)).toContain('merged bottom-up')
  expect(String(out.result)).toContain('acme/thing#3')
})

test('a stack whose stacked pull requests run no CI merges top-down, the bottom last, with no retarget', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], stackReply(stackPlan('top-down', [1, 2, 3])), undefined, stackGate)
  stubAutoMerge(on, DATA, LISTED, [], [], stackRecords)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out.deny).toBeUndefined()
  expect(walked(runs)).toEqual(['merge 3', 'merge 2', 'merge 1'])
})

test('every member meets the ready gate: a red one stops the walk, naming it and the ones merged', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], stackReply(stackPlan('bottom-up', [1, 2, 3])), undefined, failingGate(2))
  stubAutoMerge(on, DATA, LISTED, [], [], stackRecords)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('stopped at acme/thing#2')
  expect(String(out.result)).toContain('merged so far: acme/thing#1')
  expect(String(out.result)).toContain('acme/thing#2 stays retargeted to main')
  expect(walked(runs)).toEqual(['merge 1', 'retarget 2 to main'])
})

test('a red first member of the walk stops it before any merge, as a deny', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], stackReply(stackPlan('top-down', [1, 2])), undefined, failingGate(2))
  stubAutoMerge(on, DATA, LISTED, [], [], stackRecords)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out.deny).toContain('stopped at acme/thing#2')
  expect(out.deny).toContain('merged so far: none')
  expect(walked(runs)).toEqual([])
})

test('a deny rule on one member of the stack stops the walk before any merge', async ($, on) => {
  const runs: GhRun[] = []
  const denyThree = (e: NounEvents['tool.check']): Verdict => {
    const args = fieldsOf(fieldsOf(e.input)?.['args']) ?? {}
    return args['pr'] === 3 ? { decision: 'deny', reason: 'denied by a rule on pr 3', rule: 'mcp__github__gh' } : { decision: 'allow' }
  }
  await stubMod(on, runs, [], stackReply(stackPlan('bottom-up', [1, 2, 3])), denyThree, stackGate)
  stubAutoMerge(on, DATA, LISTED, [], [], stackRecords)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out.deny).toContain('stopped at acme/thing#3: denied by a rule on pr 3')
  expect(walked(runs)).toEqual([])
})

test('a retarget the engine refuses stops the walk at that member', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], stackReply(stackPlan('bottom-up', [1, 2]), (run) => run.command === 'pr-update' ? 'error: Not Found' : undefined), undefined, stackGate)
  stubAutoMerge(on, DATA, LISTED, [], [], stackRecords)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('stopped at acme/thing#2: it could not be retargeted to main')
  expect(String(out.result)).toContain('merged so far: acme/thing#1')
})

test('a merge the engine fails stops the walk; each member is pinned to the head its own gate checked, not to the head of the named one', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], stackReply(stackPlan('top-down', [1, 2, 3]), (run) => run.command === 'pr-merge' && run.args['pr'] === 2 ? 'error: Head branch was modified' : undefined), undefined, stackGate)
  stubAutoMerge(on, DATA, LISTED, [], [], stackRecords)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 3, sha: HEAD.slice(0, 7), method: 'squash' }, repo: 'acme/thing' })
  expect(String(out.result)).toContain('stopped at acme/thing#2: error: Head branch was modified')
  expect(String(out.result)).toContain('merged so far: acme/thing#3')
  const merges = runs.filter((r) => r.command === 'pr-merge' && r.args['stack'] !== true)
  expect(merges.map((r) => r.args['method'])).toEqual(['squash', 'squash'])
  expect(merges.every((r) => r.args['sha'] === headOf(Number(r.args['pr'])))).toBe(true)
})

test('outside auto-merge each merge of the stack is asked once, the named one included; a retarget an allow rule covers is not asked', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], stackReply(stackPlan('bottom-up', [1, 2])), { decision: 'allow' }, stackGate)
  stubAsk(on, asked, 'Allow')
  stubAutoMerge(on, {}, {}, [], [], stackRecords)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out.deny).toBeUndefined()
  expect(asked.length).toBe(2)
  expect(walked(runs)).toEqual(['merge 1', 'retarget 2 to main', 'merge 2'])
})

test('a deny rule on the retarget of a member stops the walk before any merge', async ($, on) => {
  const runs: GhRun[] = []
  const denyUpdate = (e: NounEvents['tool.check']): Verdict => (fieldsOf(e.input)?.['command'] === 'pr-update' ? { decision: 'deny', reason: 'no retargets', rule: 'mcp__github__gh' } : { decision: 'allow' })
  await stubMod(on, runs, [], stackReply(stackPlan('bottom-up', [1, 2])), denyUpdate, stackGate)
  stubAutoMerge(on, DATA, LISTED, [], [], stackRecords)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out.deny).toContain('stopped at acme/thing#2: no retargets')
  expect(walked(runs)).toEqual([])
})

test('a stack the engine answers that cannot be read is an error, and what the engine said reading the stack is kept', async ($, on) => {
  const runs: GhRun[] = []
  await stubMod(on, runs, [], stackReply('{"stack":{"order":"sideways","base":"main","members":[]}}'), undefined, stackGate)
  stubAutoMerge(on, DATA, LISTED, [], [], stackRecords)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('cannot read, and merged nothing')
  expect(walked(runs)).toEqual([])
})

test('what the engine said on stderr reading the stack reaches the answer of the walk', async ($, on) => {
  const runs: GhRun[] = []
  const reply = (e: NounEvents['process.run']): ProcessRunResult => {
    const run = runOf(e)
    return run.command === 'pr-merge' && run.args['stack'] === true
      ? { exitCode: 0, stdout: stackPlan('top-down', [1, 2]), stderr: 'error: cannot read whether feat/a is a stacked base: boom' }
      : { exitCode: 0, stdout: '{"merged":true}', stderr: '' }
  }
  await stubMod(on, runs, [], reply, undefined, stackGate)
  stubAutoMerge(on, DATA, LISTED, [], [], stackRecords)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(String(out.result)).toContain('cannot read whether feat/a is a stacked base: boom')
})

test('parseStackPlan reads what the engine answers for a stack, and nothing else', () => {
  expect(parseStackPlan(stackPlan('top-down', [4, 5]))).toEqual({ order: 'top-down', why: 'a test says so', base: 'main', members: [{ pr: 4, depth: 0, head: 'feat/4', base: 'main' }, { pr: 5, depth: 1, head: 'feat/5', base: 'feat/4' }] })
  for (const text of ['{"merged":true}', 'ok', '', '{"stack":{"order":"sideways","base":"main","members":[]}}', stackPlan('bottom-up', [1]),
    '{"stack":{"order":"bottom-up","base":"main","members":[{"pr":1,"depth":0,"head":"a","base":"main"},{"pr":"2","depth":1,"head":"b","base":"a"}]}}',
    '{"stack":{"order":"bottom-up","base":"main","members":[{"pr":1,"depth":0},{"pr":2,"depth":1}]}}']) {
    expect(parseStackPlan(text)).toBeUndefined()
  }
})

test('the order of a merge: the bottom first bottom-up, the bottom last top-down, siblings by number', () => {
  const members = [9, 7, 8, 10].map((pr) => ({ pr, depth: pr === 7 ? 0 : pr === 10 ? 2 : 1, head: 'h', base: 'b' }))
  expect(mergeOrder({ order: 'bottom-up', why: '', base: 'main', members })).toEqual([7, 8, 9, 10])
  expect(mergeOrder({ order: 'top-down', why: '', base: 'main', members })).toEqual([10, 8, 9, 7])
})

// ---- a top-down walk whose heads the merges above moved, through the real gate ----

const sha40 = (n: number) => String(n).repeat(40).slice(0, 40)
// The light CI's run at a head, and the other records, as the gate reads them under the records root.
function stackedRecords(prs: number[], headOfPr: (pr: number) => string): Record<string, string> {
  return Object.assign({}, ...prs.map((pr) => {
    const head = headOfPr(pr)
    const files = recordFiles('acme/thing', pr, head)
    files[RECORDS_ROOT + '/acme/thing/' + head + '/tests.20261101T100000Z.' + SCRIPTED.producer + '.json'] = JSON.stringify({
      v: 1, repo: 'acme/thing', pr, head, kind: SCRIPTED.kind, result: 'pass', producer: SCRIPTED.producer, detail: 'npm test', session: '', at: '2026-11-01T10:00:00Z',
    })
    return files
  })) as Record<string, string>
}
const LIGHT_CI_FILE = { '/cfg/light-ci/acme-thing.json': '{"command": ["npm", "test"]}' }

// Three stacked pull requests, 3 on 2 on 1, no CI on the stacked ones: the gate reads each at the head it holds now, and the
// merge of 3 into 2's branch moves 2's head to a merge commit of 2's gated head and 3's, as the merge of 2 moves 1's.
function movingStack(foreign = false) {
  const start = (pr: number) => sha40(pr)
  const moved = new Map<number, string>()
  const headNow = (pr: number) => moved.get(pr) ?? start(pr)
  const gate = (repo: string, pr: number) => JSON.stringify({
    repo, pr, state: 'open', draft: false, head: headNow(pr), labels: ['Ready'], stacked: pr !== 1, base: pr === 1 ? 'main' : 'feat/' + (pr - 1),
    ci: pr === 1 ? { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1 } : { result: 'PENDING', failed: [], running: 0, skipped: [], total: 0 },
  })
  const commits = (pr: number) => JSON.stringify([{ sha: moved.get(pr) ?? '', parents: [{ sha: start(pr) }, { sha: foreign && pr === 2 ? sha40(9) : moved.get(pr + 1) ?? start(pr + 1) }] }])
  const reply: Replier = (e) => {
    const run = runOf(e)
    if (run.command === 'pr-merge' && run.args['stack'] === true) return { exitCode: 0, stdout: stackPlan('top-down', [1, 2, 3]), stderr: '' }
    if (run.command === 'pr-commits') return { exitCode: 0, stdout: commits(Number(run.args['pr'])), stderr: '' }
    if (run.command === 'pr-merge') {
      const below = Number(run.args['pr']) - 1
      if (below >= 1) moved.set(below, sha40(below + 4))
    }
    return { exitCode: 0, stdout: '{"merged":true}', stderr: '' }
  }
  return { gate, reply, records: stackedRecords([1, 2, 3], start), start }
}

test('a top-down walk gets past a member whose head the merge above moved, with the light CI configured', async ($, on) => {
  const runs: GhRun[] = []
  const world = movingStack()
  await stubMod(on, runs, [], world.reply, undefined, world.gate)
  stubAutoMerge(on, DATA, { ...LISTED, ...LIGHT_CI_FILE }, [], [], world.records)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out.deny).toBeUndefined()
  expect(out.isError).toBeUndefined()
  expect(walked(runs)).toEqual(['merge 3', 'merge 2', 'merge 1'])
  // Each member merged at the head its gate read when its turn came.
  const shas = runs.filter((r) => r.command === 'pr-merge' && r.args['stack'] !== true).map((r) => r.args['sha'])
  expect(shas).toEqual([sha40(3), sha40(6), sha40(5)])
})

test('a head the walk did not move alone is refused for the light CI, the members above merged', async ($, on) => {
  const runs: GhRun[] = []
  const world = movingStack(true)
  await stubMod(on, runs, [], world.reply, undefined, world.gate)
  stubAutoMerge(on, DATA, { ...LISTED, ...LIGHT_CI_FILE }, [], [], world.records)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('stopped at acme/thing#2')
  expect(String(out.result)).toContain('tests: no record at')
  expect(String(out.result)).toContain('merged so far: acme/thing#3')
  expect(walked(runs)).toEqual(['merge 3'])
})

test('a top-down walk is refused before any merge when a member is not ready at the head it holds', async ($, on) => {
  const runs: GhRun[] = []
  const world = movingStack()
  // 2 has no light CI record at its head: nothing is merged, 3 above it included.
  const records = Object.fromEntries(Object.entries(world.records).filter(([path]) => !(path.includes(sha40(2)) && path.includes('/tests.'))))
  await stubMod(on, runs, [], world.reply, undefined, world.gate)
  stubAutoMerge(on, DATA, { ...LISTED, ...LIGHT_CI_FILE }, [], [], records)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out.deny).toContain('stopped at acme/thing#2')
  expect(walked(runs)).toEqual([])
})

test('the head the caller pinned for the named pull request is the one merged: a head that moved since is refused', async ($, on) => {
  const runs: GhRun[] = []
  let flipped = false
  const gate = (repo: string, pr: number) => stackGate(repo, pr).replace(headOf(1), flipped && pr === 1 ? sha40(8) : headOf(1))
  const reply: Replier = (e) => {
    const run = runOf(e)
    if (run.command === 'pr-merge' && run.args['stack'] === true) {
      flipped = true
      return { exitCode: 0, stdout: stackPlan('bottom-up', [1, 2]), stderr: '' }
    }
    return { exitCode: 0, stdout: '{"merged":true}', stderr: '' }
  }
  await stubMod(on, runs, [], reply, undefined, gate)
  stubAutoMerge(on, DATA, LISTED, [], [], stackRecords)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1, sha: headOf(1) }, repo: 'acme/thing' })
  expect(String(out.deny ?? out.result)).toContain('the head moved: ' + headOf(1) + ' given')
  expect(walked(runs)).toEqual([])
})

test('an explicit ask rule on the retarget is asked, and the walk stops when it is refused', async ($, on) => {
  const runs: GhRun[] = []
  const asked: string[] = []
  const askUpdate = (e: NounEvents['tool.check']): Verdict => (fieldsOf(e.input)?.['command'] === 'pr-update' ? { decision: 'ask', rule: 'mcp__github__gh' } : { decision: 'allow' })
  await stubMod(on, runs, [], stackReply(stackPlan('bottom-up', [1, 2])), askUpdate, stackGate)
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED, [], [], stackRecords)
  await startSession($)

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 }, repo: 'acme/thing' })
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('pr-update')
  expect(String(out.result)).toContain('stopped at acme/thing#2: the user refused gh pr-update')
  expect(walked(runs)).toEqual(['merge 1'])
})

test('walkedHead reads the head as the one gated plus the merges, from the commits, and nothing else', () => {
  const commit = (sha: string, first: string, second: string) => ({ sha, parents: [{ sha: first }, { sha: second }] })
  const commits = [commit('c3', 'c2', 'u2'), commit('c2', 'c1', 'u1'), { sha: 'c1', parents: [{ sha: 'c0' }] }]
  expect(walkedHead(commits, 'c3', 'c1', ['u1', 'u2'])).toBe(true)
  expect(walkedHead(commits, 'c2', 'c1', ['u1'])).toBe(true)
  expect(walkedHead(commits, 'c3', 'c1', ['u2', 'u1'])).toBe(false)
  expect(walkedHead(commits, 'c3', 'c0', ['u1', 'u2'])).toBe(false)
  expect(walkedHead(commits, 'c3', 'c1', ['u1'])).toBe(false)
  expect(walkedHead(commits, 'c9', 'c1', ['u1'])).toBe(false)
  expect(walkedHead(commits, 'c1', 'c1', [])).toBe(false)
  expect(walkedHead({}, 'c3', 'c1', ['u1', 'u2'])).toBe(false)
  expect(walkedHead([{ sha: 'c3', parents: [{ sha: 'c2' }, { sha: 'u2' }, { sha: 'x' }] }], 'c3', 'c2', ['u2'])).toBe(false)
})
