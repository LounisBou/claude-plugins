// hooks/tests/review.test.ts
// The orchestrator's review verdict: from an orchestrator session the tool calls github's record
// tool with a review record, pass, fail or accepted with the points it sets aside; from any other
// session, or with an input that lacks the pull request, the verdict or an acceptance's set-asides,
// it calls nothing.
import { expect, test } from 'claude-code/testing'
import { register } from '../register.ts'
import { NOT_ORCHESTRATOR, answerLines, findingsOf, register as registerReview, rowWords, wordsOf } from '../review.ts'
import { PLAN_NEEDS, REVIEW_ROUNDS } from '../../core/readiness.ts'
import { logLineOf } from './fakes.ts'
import { answerText } from '../audit-events.ts'
import { capture, hooksOn, hostOf } from '../../core/capture.ts'
import { fieldsOf, type Events, type Host, type Noun, type ProcessRunInit, type ToolSpec } from '../../core/host.ts'

type World = Host<Noun>
// What the review tool answers: its text, and whether it is an error.
type Out = { readonly result: string; readonly isError?: boolean }
// A value down a path of records, as a schema is read.
const at = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((o, k) => fieldsOf(o)?.[k], value)

const HOME = '/tmp/h'
const ROW = `${HOME}/.claude/claude-orchestrator/store/sessions/s-one`
const WRITTEN = '/cfg/records/x/review.json\ngithub: Ready'

function fake(name: string, answer: unknown = { result: 'written' }) {
  const calls: Record<string, unknown>[] = []
  const logged: string[] = []
  const files: Record<string, string> = {
    [ROW]: JSON.stringify({ role: null, name, pid: '501', updated_at: '2026-11-13T19:00:00.000Z' }) + '\n',
  }
  const dollar = hostOf({
    session: { id: async () => 's-one' },
    env: { get: async (key: string) => ({ HOME } as Record<string, string>)[key] },
    plugin: { root: '/plugins/orch-root' },
    fs: {
      read: async (p: string) => { const text = files[p]; if (text !== undefined) return text; throw new Error(`ENOENT: ${p}`) },
    },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf([...argv])
        if (line !== null) logged.push(line)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    tool: { call: async (input: Record<string, unknown>) => { calls.push(input); return answer } },
  })
  return { dollar, calls, logged }
}

// The handler registered for the review tool, its matcher read.
function handler(): (dollar: World, e: Events['tool.call']) => Promise<Out> {
  const found = hooksOn(capture<World>(register), 'tool.call').filter(h => h.matcher?.['tool'] === 'mcp__orchestrator__review').at(-1)!
  return async (dollar, e) => await found.handler(dollar, e, async () => undefined) as Out
}

// The review module's session-start hook, and the tool specs it registers through `dollar`.
async function registeredSpecs(dollar: World): Promise<ToolSpec[]> {
  const registered: ToolSpec[] = []
  const started = hooksOn(capture<World>(registerReview), 'session.start').at(-1)!
  await started.handler({ ...dollar, tool: { ...dollar.tool, register: async (tool: ToolSpec) => { registered.push(tool) } } }, { cwd: '/w' }, async () => undefined)
  return registered
}

const ACCEPTED = {
  pr: 128, repo: 'acme/thing', dir: '/work/thing', verdict: 'accepted',
  set_asides: [{ point: 'a.ts:3', reason: 'naming only' }, { point: 'b.ts', reason: 'out of the phase\'s scope' }],
}

test('an orchestrator\'s acceptance is written through github\'s record tool, each point set aside with its reason', async () => {
  const fx = fake('Orch: belt [a1b2c3]', { result: WRITTEN })
  const out = await handler()(fx.dollar, ACCEPTED)
  expect(fx.calls).toEqual([{
    tool: 'mcp__github__record', pr: 128, repo: 'acme/thing', dir: '/work/thing', kind: 'review', result: 'accepted',
    detail: 'set aside: a.ts:3 — naming only; b.ts — out of the phase\'s scope',
  }])
  // The verdict is a review round: the answer also says that no dispatch-record row named the pull request.
  expect(out).toEqual({ result: `${WRITTEN}\nrounds: no dispatch-record row names acme/thing#128, none raised: open its row with a label naming acme/thing#128` })
})

// github's gate line repeats what the orchestrator just wrote: the tool's answer says the verdict
// of the gate, « Ready at <head> » or what is missing, after the record's path line the audit reads.
test('the gate\'s verdict is said in a few words: Ready at its head, or what is missing, never the review\'s own words', async () => {
  const detail = 'set aside: a.ts:3 — naming only; b.ts — out of the phase\'s scope'
  const echoed = `/cfg/records/x/review.json\ngithub: acme/thing#128 Ready at 0123456: review accepted by the orchestrator (${detail}), no norms check needed (check plan: a small fix), passed E2E and green CI hold at its head.`
  const fx = fake('Orch: belt [a1b2c3]', { result: echoed })
  expect((await handler()(fx.dollar, ACCEPTED)).result.split('\n').slice(0, 2)).toEqual(['/cfg/records/x/review.json', 'Ready at 0123456'])
  const failed = fake('Orch: belt', { result: 'github: acme/thing#128 not Ready yet at 0123456. Missing: review: fail at 0123456 by orchestrator, two to fix, e2e: no record at 0123456, CI still running' })
  expect((await handler()(failed.dollar, { pr: 128, verdict: 'fail', detail: 'two to fix' })).result.split('\n')[0])
    .toBe('Not Ready at 0123456. Missing: review: fail at 0123456, e2e: no record at 0123456, CI still running')
  const accepted = fake('Orch: belt', { result: `github: acme/thing#128 not Ready yet at 0123456. review accepted by the orchestrator (${detail}). Missing: e2e: no record at 0123456` })
  expect((await handler()(accepted.dollar, ACCEPTED)).result).toBe('Not Ready at 0123456. Missing: e2e: no record at 0123456\nrounds: no dispatch-record row names acme/thing#128, none raised: open its row with a label naming acme/thing#128')
  const again = fake('Orch: belt', { result: 'github: acme/thing#128 back to draft, then Ready at 0123456: a clean review, passed E2E and green CI hold at its head.' })
  expect((await handler()(again.dollar, { pr: 128, verdict: 'pass' })).result.split('\n')[0]).toBe('back to draft, then Ready at 0123456')
})

test('a github line of another shape is left whole, its echo of the detail named; a refusal comes back whole', async () => {
  const other = '/cfg/records/x/review.json\ngithub: acme/thing#128: no review record carried to 0123456: two to fix by orchestrator, two to fix'
  const fx = fake('Orch: belt', { result: other })
  expect((await handler()(fx.dollar, { pr: 128, verdict: 'fail', detail: 'two to fix' })).result.split('\n').slice(0, 2))
    .toEqual(['/cfg/records/x/review.json', 'github: acme/thing#128: no review record carried to 0123456: two to fix by orchestrator, the detail sent'])
  const refused = fake('Orch: belt', { deny: 'github: refused, two to fix by orchestrator, two to fix' })
  expect(await handler()(refused.dollar, { pr: 128, verdict: 'fail', detail: 'two to fix' }))
    .toEqual({ result: 'github: refused, two to fix by orchestrator, two to fix', isError: true })
})

test('the gate lines in every shape: back to Not Ready, a Ready with no colon, and with several github lines the last one carries the row', async () => {
  const back = fake('Orch: belt', { result: 'github: acme/thing#128 back to Not Ready at 0123456. Missing: CI failing: build' })
  expect((await handler()(back.dollar, { pr: 128, verdict: 'pass' })).result.split('\n')[0]).toBe('back to Not Ready at 0123456. Missing: CI failing: build')
  // What the gate carried from an earlier head, or the operator waived, rides the Ready it rests on.
  const carried = fake('Orch: belt', { result: 'github: acme/thing#128 Ready at 0123456: a clean review, passed E2E and green CI hold at its head (E2E carried from 89abcde, norms waived by the operator (2026-11-15: small)).' })
  expect((await handler()(carried.dollar, { pr: 128, verdict: 'pass' })).result.split('\n')[0])
    .toBe('Ready at 0123456 (E2E carried from 89abcde, norms waived by the operator (2026-11-15: small))')
  const bare = fake('Orch: belt', { result: 'github: acme/thing#128 Ready at 0123456' })
  expect((await handler()(bare.dollar, { pr: 128, verdict: 'pass' })).result.split('\n')[0]).toBe('Ready at 0123456')
  const two = fake('Orch: belt', { result: '/cfg/records/x/review.json\ngithub: acme/thing#128 out of draft to run CI, still Not Ready\ngithub: acme/thing#128 Ready at 0123456: a clean review.' })
  expect((await handler()(two.dollar, { pr: 128, verdict: 'pass' })).result.split('\n').slice(0, 3))
    .toEqual(['/cfg/records/x/review.json', 'github: acme/thing#128 out of draft to run CI, still Not Ready', 'Ready at 0123456'])
})

test('the answer with no github line, a row line of another shape, and a count that raised none: each said whole', async () => {
  const none = fake('Orch: belt', { result: '/cfg/records/x/review.json' })
  const named = { pr: 128, repo: 'acme/thing', verdict: 'pass' }
  const rows = rowWords('rounds: row 4 of /b/record.jsonl raised to 2', 'row 4: fail — x — findings: none')
  expect(rows).toEqual({ piece: 'row 4: fail, round 2', extra: [] })
  expect(rowWords('rounds: row 3 of /b/r.jsonl raised to 1', 'row 4: fail — x')).toEqual({ piece: 'row 3 round 1 · row 4: fail', extra: [] })
  expect(rowWords('rounds: row 4 of /b/r.jsonl raised to 1', 'something else\nWARNING: x')).toEqual({ piece: 'row 4 round 1', extra: ['something else\nWARNING: x'] })
  expect(rowWords('rounds: none raised, the repository is not known', 'row 4: pass — clean')).toEqual({ piece: 'row 4: pass', extra: ['rounds: none raised, the repository is not known'] })
  expect(answerLines('/cfg/records/x/review.json', 'rounds: row 4 of /b/r.jsonl raised to 1', null)).toBe('/cfg/records/x/review.json\nrow 4 round 1')
  expect((await handler()(none.dollar, named)).result).toBe('/cfg/records/x/review.json\nrounds: no dispatch-record row names acme/thing#128, none raised: open its row with a label naming acme/thing#128')
})

test('a github line of another shape names the detail where it echoes it, in each of the two places, and a detail never sent changes nothing', async () => {
  const parens = fake('Orch: belt', { result: 'github: acme/thing#128 custom: orchestrator (two to fix) and by orchestrator, two to fix' })
  expect((await handler()(parens.dollar, { pr: 128, verdict: 'fail', detail: 'two to fix' })).result.split('\n')[0])
    .toBe('github: acme/thing#128 custom: orchestrator (the detail sent) and by orchestrator, the detail sent')
  // Only the echo is named: the same words elsewhere stay, and with no detail sent nothing is touched.
  const elsewhere = fake('Orch: belt', { result: 'github: acme/thing#128 custom: Ready is not Ready, orchestrator (other)' })
  expect((await handler()(elsewhere.dollar, { pr: 128, verdict: 'pass', detail: 'Ready' })).result.split('\n')[0]).toBe('github: acme/thing#128 custom: Ready is not Ready, orchestrator (other)')
  const bare = fake('Orch: belt', { result: 'github: acme/thing#128 custom: orchestrator (two to fix)' })
  expect((await handler()(bare.dollar, { pr: 128, verdict: 'pass' })).result.split('\n')[0]).toBe('github: acme/thing#128 custom: orchestrator (two to fix)')
})

for (const verdict of ['pass', 'fail']) {
  test(`an orchestrator's ${verdict} is written as a review record with its line`, async () => {
    const fx = fake('Orch: belt')
    await handler()(fx.dollar, { pr: 128, verdict, detail: 'read at 0123456' })
    expect(fx.calls).toEqual([{ tool: 'mcp__github__record', pr: 128, kind: 'review', result: verdict, detail: 'read at 0123456' }])
  })
}

test('github\'s refusal comes back as the tool\'s error', async () => {
  const fx = fake('Orch: belt', { deny: 'github: the latest review at 0123456 failed: a pass does not override it.' })
  expect(await handler()(fx.dollar, { pr: 128, verdict: 'pass' }))
    .toEqual({ result: 'github: the latest review at 0123456 failed: a pass does not override it.', isError: true })
})

for (const name of ['Agent: review record', 'Coord: general', 'Audit: method']) {
  test(`a session named ${name} is refused and calls nothing`, async () => {
    const fx = fake(name)
    expect(await handler()(fx.dollar, ACCEPTED)).toEqual({ result: NOT_ORCHESTRATOR, isError: true })
    expect(fx.calls).toEqual([])
  })
}

for (const [label, change] of [
  ['no pull request', { pr: 0 }], ['no verdict', { verdict: '' }], ['another verdict', { verdict: 'waived' }],
  ['no point set aside', { set_asides: [] }], ['a point without its reason', { set_asides: [{ point: 'a.ts', reason: ' ' }] }],
  ['set-asides on a pass', { verdict: 'pass' }],
] as const) {
  test(`a verdict with ${label} is refused and calls nothing`, async () => {
    const fx = fake('Orch: belt')
    const out = await handler()(fx.dollar, { ...ACCEPTED, ...change })
    expect(out.isError).toBe(true)
    expect(fx.calls).toEqual([])
  })
}

test('a subagent of the orchestrator records no verdict', async () => {
  const fx = fake('Orch: belt')
  expect((await handler()(fx.dollar, { ...ACCEPTED, agentId: 'a1' })).isError).toBe(true)
  expect(fx.calls).toEqual([])
})

// ---- the check plan, in place of the verdict ----

const PLAN = { e2e: 'none: docs only', norms: 'required', review: 'one-pass: a typo' }
const PLANNED = { pr: 164, repo: 'acme/thing', plan: PLAN }

test('an orchestrator\'s check plan is written through github\'s record tool', async () => {
  const fx = fake('Orch: belt [a1b2c3]', { result: 'github: check plan of acme/thing#164' })
  const out = await handler()(fx.dollar, PLANNED)
  expect(fx.calls).toEqual([{ tool: 'mcp__github__record', pr: 164, repo: 'acme/thing', plan: PLAN }])
  expect(out).toEqual({ result: 'github: check plan of acme/thing#164' })
})

for (const name of ['Agent: md-s10', 'Coord: general', 'Audit: method']) {
  test(`a session named ${name} writes no check plan`, async () => {
    const fx = fake(name)
    expect(await handler()(fx.dollar, PLANNED)).toEqual({ result: NOT_ORCHESTRATOR, isError: true })
    expect(fx.calls).toEqual([])
  })
}

for (const [label, change] of [['no plan object', { plan: 'none' }], ['a verdict beside it', { verdict: 'pass' }]] as const) {
  test(`a check plan with ${label} is refused and calls nothing`, async () => {
    const fx = fake('Orch: belt')
    expect((await handler()(fx.dollar, { ...PLANNED, ...change })).isError).toBe(true)
    expect(fx.calls).toEqual([])
  })
}

test('a subagent of the orchestrator writes no check plan', async () => {
  const fx = fake('Orch: belt')
  expect((await handler()(fx.dollar, { ...PLANNED, agentId: 'a1' })).isError).toBe(true)
  expect(fx.calls).toEqual([])
})

test('the plan\'s schema names the needs core\'s readiness contract gives each check', async () => {
  const registered = await registeredSpecs(fake('Orch: belt').dollar)
  const plan = at(registered.find((t) => t.name === 'review'), 'inputSchema', 'properties', 'plan', 'properties')
  for (const check of Object.keys(PLAN_NEEDS) as Array<keyof typeof PLAN_NEEDS>) expect(at(plan, check, 'description')).toBe(PLAN_NEEDS[check].join(', '))
})

test('the plan\'s schema says a required review takes its rounds, up to core\'s cap, and the tool passes them to github', async () => {
  const registered = await registeredSpecs(fake('Orch: belt').dollar)
  const description = at(registered.find((t) => t.name === 'review'), 'inputSchema', 'properties', 'plan', 'description')
  expect(description).toContain('"required: max <n>"')
  expect(description).toContain('1 to ' + REVIEW_ROUNDS.cap)
  const planned = fake('Orch: belt [a1b2c3]', { result: 'github: check plan of acme/thing#164' })
  await handler()(planned.dollar, { pr: 164, repo: 'acme/thing', plan: { review: 'required: max 2' } })
  expect(planned.calls).toEqual([{ tool: 'mcp__github__record', pr: 164, repo: 'acme/thing', plan: { review: 'required: max 2' } }])
})

// ---- each finding's decision: kept for the correction round, or set aside with its reason ----

test('a fail keeps the findings the correction round fixes, and may set others aside with their reasons, written in its line', async () => {
  const fx = fake('Orch: belt')
  const out = await handler()(fx.dollar, {
    pr: 128, verdict: 'fail', detail: 'two to fix',
    kept: [{ point: 'a.ts:3 the guard fails open', file: 'a.ts', line: 3, severity: 'critical' }, { point: 'b.ts: no test' }],
    set_asides: [{ point: 'c.ts naming', reason: 'naming only', severity: 'minor' }],
  })
  expect(out).toEqual({ result: 'written\nrounds: none raised, the repository of the pull request is not known: give repo' })
  expect(fx.calls).toEqual([{ tool: 'mcp__github__record', pr: 128, kind: 'review', result: 'fail', detail: 'two to fix; set aside: c.ts naming — naming only' }])
})

test('the findings of a verdict, each with the orchestrator\'s decision, its file, line and severity when given', () => {
  expect(findingsOf({ verdict: 'accepted', set_asides: [{ point: 'x', reason: 'y', file: 'src/x.ts', line: 4, severity: 'important' }] }))
    .toEqual([{ decision: 'set-aside', file: 'src/x.ts', line: 4, severity: 'important' }])
  expect(findingsOf({ verdict: 'fail', kept: [{ point: 'x' }] })).toEqual([{ decision: 'kept', file: null, line: null, severity: null }])
  expect(findingsOf({ verdict: 'pass' })).toEqual([])
})

for (const [label, change] of [
  ['kept findings on a pass', { verdict: 'pass', kept: [{ point: 'a.ts' }] }],
  ['kept findings on an acceptance', { kept: [{ point: 'a.ts' }] }],
  ['a kept finding without its point', { verdict: 'fail', kept: [{ point: ' ' }] }],
  ['kept findings that are no list', { verdict: 'fail', kept: 'a.ts' }],
  ['a severity of no scale', { verdict: 'fail', kept: [{ point: 'a.ts', severity: 'blocker' }] }],
  ['a line that is no line', { verdict: 'fail', kept: [{ point: 'a.ts', line: 0 }] }],
  ['a file that is no string', { verdict: 'fail', kept: [{ point: 'a.ts', file: 3 }] }],
  ['a fail\'s point set aside without its reason', { verdict: 'fail', set_asides: [{ point: 'a.ts', reason: '' }] }],
] as const) {
  test(`a verdict with ${label} is refused and calls nothing`, async () => {
    const fx = fake('Orch: belt')
    const out = await handler()(fx.dollar, { ...ACCEPTED, ...change })
    expect(out.isError).toBe(true)
    expect(fx.calls).toEqual([])
  })
}

// ---- level 1 of the review: the verdict, a few words and the findings index, in the dispatch record's row ----

// A fake whose runs answer git's head and dispatch-record's line, each run kept with its init.
function rowFake(record: { exitCode: number; stdout: string; stderr: string } = { exitCode: 0, stdout: 'row 4: fail — two to fix — findings: /b/review-128.md\n', stderr: '' }) {
  const fx = fake('Orch: belt', { result: WRITTEN })
  const runs: { argv: string[]; init: ProcessRunInit | undefined }[] = []
  // Once the gate's record is written, four of the five keys the record script reads are set, and
  // ORCHESTRATOR_JOURNAL_DIR is not; before it, the session's check reads HOME alone.
  const vars: Record<string, string> = { HOME, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: '/cfg', ORCHESTRATOR_STATE_DIR: '/state' }
  let written = false
  const call = fx.dollar.tool.call
  fx.dollar.tool.call = async (input: { tool: string } & Record<string, unknown>) => { written = true; return call(input) }
  fx.dollar.env.get = async (key: string) => (written ? vars[key] : key === 'HOME' ? HOME : undefined)
  fx.dollar.process.run = async (argv: readonly string[], init?: ProcessRunInit) => {
    runs.push({ argv: [...argv], init })
    if (argv[0] === 'git') return { exitCode: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' }
    if (String(argv[1] ?? '').endsWith('/dispatch-record.sh')) return record
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { ...fx, runs }
}

// The round the verdict counts (review-rounds.ts) says its line before level 1: no row names it here.
const ROUNDS = 'rounds: no dispatch-record row names acme/thing#128, none raised: open its row with a label naming acme/thing#128'
const FAILED = { pr: 128, repo: 'acme/thing', dir: '/work/thing', verdict: 'fail', detail: 'two to fix', kept: [{ point: 'a.ts:3', file: 'a.ts', line: 3 }] }

test('given its record and row, the verdict writes the gate\'s record, then level 1 into the row, in one call', async () => {
  const fx = rowFake()
  const out = await handler()(fx.dollar, { ...FAILED, record: '/b/record.jsonl', row: 4, findings: '/b/review-128.md' })
  expect(fx.calls.length).toBe(1)
  const head = fx.runs.find((r) => r.argv[1] === 'rev-parse')
  const record = fx.runs.find((r) => r.argv[2] === 'verdict')!
  expect(head).toEqual({ argv: ['git', 'rev-parse', 'HEAD'], init: { cwd: '/work/thing', timeoutMs: 10000 } })
  expect(record.argv).toEqual([
    'bash', '/plugins/orch-root/skills/orchestrator/scripts/dispatch-record.sh', 'verdict', '/b/record.jsonl', '4',
    '--head', '0123456789abcdef0123456789abcdef01234567', '--result', 'fail', '--words', 'two to fix', '--findings', '/b/review-128.md', '--reviewed',
  ])
  expect(record.init).toEqual({
    env: { CLAUDE_CODE_SESSION_ID: 's-one', HOME, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: '/cfg', ORCHESTRATOR_STATE_DIR: '/state' },
    timeoutMs: 10000,
  })
  // The row's line is said in the gate's line, once: the verdict it took, never its words or its findings path.
  expect(out).toEqual({ result: `${WRITTEN} · row 4: fail\n${ROUNDS}` })
})

test('an acceptance\'s few words count its set-asides, never their words', async () => {
  const fx = rowFake({ exitCode: 0, stdout: 'row 4: accepted — 2 point(s) set aside — findings: none\n', stderr: '' })
  await handler()(fx.dollar, { ...ACCEPTED, record: '/b/record.jsonl', row: 4 })
  const argv = fx.runs.find((r) => r.argv[2] === 'verdict')!.argv
  expect(argv.slice(argv.indexOf('--result'))).toEqual(['--result', 'accepted', '--words', '2 point(s) set aside', '--reviewed'])
})

test('a row the record refuses is a warning on the verdict\'s success, never an error, so the audit keeps the verdict', async () => {
  const fx = rowFake({ exitCode: 1, stdout: '', stderr: 'ERROR: verdict: no row with id 4 in /b/record.jsonl\n' })
  const out = await handler()(fx.dollar, { ...FAILED, record: '/b/record.jsonl', row: 4 })
  expect(out).toEqual({ result: `${WRITTEN}\n${ROUNDS}\nWARNING: the gate's record is written, the row is not: write it with dispatch-record.sh verdict, never this tool again: ERROR: verdict: no row with id 4 in /b/record.jsonl` })
  expect(answerText(out)?.split('\n')[0]).toBe('/cfg/records/x/review.json')
})

test('without a record, the verdict touches no row', async () => {
  const fx = rowFake()
  await handler()(fx.dollar, FAILED)
  expect(fx.runs.filter((r) => r.argv[1] === 'rev-parse' || r.argv[2] === 'verdict')).toEqual([])
})

test('a refused gate record writes no row', async () => {
  const fx = rowFake()
  fx.dollar.tool.call = async () => ({ deny: 'github: no.' })
  await handler()(fx.dollar, { ...FAILED, record: '/b/record.jsonl', row: 4 })
  expect(fx.runs.filter((r) => r.argv[1] === 'rev-parse' || r.argv[2] === 'verdict')).toEqual([])
})

for (const [label, change] of [
  ['a record without its row', { record: '/b/record.jsonl' }],
  ['a row without its record', { row: 4 }],
  ['a relative record', { record: 'b/record.jsonl', row: 4 }],
  ['a row that is no id', { record: '/b/record.jsonl', row: 0 }],
  ['a relative findings index', { record: '/b/record.jsonl', row: 4, findings: 'review.md' }],
] as const) {
  test(`a verdict with ${label} is refused and calls nothing`, async () => {
    const fx = rowFake()
    const out = await handler()(fx.dollar, { ...FAILED, ...change })
    expect(out.isError).toBe(true)
    expect(fx.calls).toEqual([])
  })
}

test('a check plan names no row', async () => {
  const fx = rowFake()
  expect((await handler()(fx.dollar, { ...PLANNED, record: '/b/record.jsonl', row: 4 })).isError).toBe(true)
  expect(fx.calls).toEqual([])
})

test('a verdict\'s few words: its line\'s first, cut to 120, or what it decided counted', () => {
  expect(wordsOf({ verdict: 'pass' })).toBe('clean')
  expect(wordsOf({ verdict: 'fail', kept: [{ point: 'a' }, { point: 'b' }] })).toBe('2 kept')
  expect(wordsOf({ verdict: 'pass', detail: 'read at 0123456\nmore' })).toBe('read at 0123456')
  expect(wordsOf({ verdict: 'accepted', detail: 'ignored', set_asides: [{ point: 'a', reason: 'r' }] })).toBe('1 point(s) set aside')
  expect(wordsOf({ verdict: 'fail', detail: 'x'.repeat(200) })).toBe('x'.repeat(120))
})

test('a head that cannot be read writes no row, a warning on the verdict\'s success', async () => {
  const fx = rowFake()
  const run = fx.dollar.process.run
  fx.dollar.process.run = async (argv: readonly string[], init?: ProcessRunInit) =>
    argv[0] === 'git' ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } : run(argv, init)
  const out = await handler()(fx.dollar, { ...FAILED, record: '/b/record.jsonl', row: 4 })
  expect(out).toEqual({ result: `${WRITTEN}\n${ROUNDS}\nWARNING: the gate's record is written, the row is not: write it with dispatch-record.sh verdict, never this tool again: no head read in /work/thing: fatal: not a git repository` })
  expect(fx.runs.filter((r) => r.argv[2] === 'verdict')).toEqual([])
})

test('a row run that throws is a warning on the verdict\'s success', async () => {
  const fx = rowFake()
  fx.dollar.process.run = async (argv: readonly string[]) => {
    if (argv[0] === 'git') return { exitCode: 0, stdout: '0123456\n', stderr: '' }
    throw new Error('timed out after 10000 ms')
  }
  expect(await handler()(fx.dollar, { ...FAILED, record: '/b/record.jsonl', row: 4 }))
    .toEqual({ result: `${WRITTEN}\n${ROUNDS}\nWARNING: the gate's record is written, the row is not: write it with dispatch-record.sh verdict, never this tool again: timed out after 10000 ms` })
})

test('a warning of a row written comes back with its line', async () => {
  const fx = rowFake({ exitCode: 0, stdout: 'row 4: fail — two to fix — findings: none\n', stderr: 'WARNING: verdict: row 4 has no review recorded: recording the verdict anyway\n' })
  expect(await handler()(fx.dollar, { ...FAILED, record: '/b/record.jsonl', row: 4 }))
    .toEqual({ result: `${WRITTEN} · row 4: fail\n${ROUNDS}\nWARNING: verdict: row 4 has no review recorded: recording the verdict anyway` })
})

// An index with two important findings and one minor, as the review session writes it.
const INDEX = '1. [important] a.ts:3 — a guard reads no file — 1.md\n2. [minor] b.ts:9 — naming — 2.md\n3. [important] c.ts:1 — no test falls — 3.md\n'

test('an acceptance over an index with important findings sets each aside on its own, with its own reason, or is refused', async () => {
  const withIndex = (setAsides: unknown[]) => {
    const fx = rowFake({ exitCode: 0, stdout: 'row 4: accepted — 2 point(s) set aside — findings: /b/review-128.md\n', stderr: '' })
    const read = fx.dollar.fs.read
    fx.dollar.fs.read = async (p: string) => (p === '/b/review-128.md' ? INDEX : read(p))
    return { fx, input: { ...ACCEPTED, set_asides: setAsides, record: '/b/record.jsonl', row: 4, findings: '/b/review-128.md' } }
  }
  // One blanket point for the whole index is refused, and nothing is written.
  const blanket = withIndex([{ point: 'the index', reason: 'non-blocking' }])
  const refused = await handler()(blanket.fx.dollar, blanket.input)
  expect(refused.isError).toBe(true)
  expect(refused.result).toContain('2 important finding(s)')
  expect(blanket.fx.calls).toEqual([])
  // Two important points with the same reason are refused too.
  const same = withIndex([{ point: 'a.ts:3', severity: 'important', reason: 'later' }, { point: 'c.ts:1', severity: 'important', reason: 'later' }])
  expect((await handler()(same.fx.dollar, same.input)).isError).toBe(true)
  // Each important finding set aside with its own reason against the design is written.
  const each = withIndex([
    { point: 'a.ts:3', severity: 'important', reason: 'the design reads that file elsewhere' },
    { point: 'c.ts:1', severity: 'important', reason: 'covered by the phase 2 test' },
  ])
  const out = await handler()(each.fx.dollar, each.input)
  expect(out.isError).toBe(undefined)
  expect(each.fx.calls.length).toBe(1)
})

test('an acceptance over an index with no important finding, or an index that cannot be read, is written as before', async () => {
  const fx = rowFake({ exitCode: 0, stdout: 'row 4: accepted — 2 point(s) set aside — findings: /b/r.md\n', stderr: '' })
  const read = fx.dollar.fs.read
  fx.dollar.fs.read = async (p: string) => (p === '/b/r.md' ? '1. [minor] b.ts:9 — naming — 1.md\n' : read(p))
  await handler()(fx.dollar, { ...ACCEPTED, record: '/b/record.jsonl', row: 4, findings: '/b/r.md' })
  expect(fx.calls.length).toBe(1)
  const gone = rowFake({ exitCode: 0, stdout: 'row 4: accepted — 2 point(s) set aside — findings: /b/x.md\n', stderr: '' })
  await handler()(gone.dollar, { ...ACCEPTED, record: '/b/record.jsonl', row: 4, findings: '/b/x.md' })
  expect(gone.calls.length).toBe(1)
})
