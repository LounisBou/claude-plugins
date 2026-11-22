// hooks/tests/review-rounds.test.ts
// A review verdict is a review round: the dispatch-record row that names the pull request has its
// `rounds` raised by one, or the verdict's answer says that no row matched. A missing row, an unknown
// repository or a failed write never blocks the verdict.
import { expect, test } from 'claude-code/testing'
import { register as registerReview } from '../review.ts'
import { owedOf, settleOwed } from '../review-close.ts'
import { logLineOf, lockRun } from './fakes.ts'
import { capture, hooksOn, hostOf } from '../../core/capture.ts'
import type { Events, Host, Noun, ProcessRunInit } from '../../core/host.ts'

type World = Host<Noun>
// What the review tool answers: its text, and whether it is an error.
type Out = { readonly result: string; readonly isError?: boolean }

const HOME = '/tmp/rounds-home'
const STATE = `${HOME}/.claude/claude-orchestrator`
const RECORD = '/briefs/app/dispatch-record.jsonl'
const ORCH = 'Orch: app'
const HEAD = '0123456789abcdef0123456789abcdef01234567'
const WRITTEN = 'github: review recorded'
const LEDGER = JSON.stringify({ v: 1, ledger: 'pr', repo: 'acme/app', pr: 12, status: 'working', agent: 'Agent: x', since: '2026-11-14T09:00:00Z', updated: '2026-11-14T09:30:00Z' })

const line = (row: Record<string, unknown>) => JSON.stringify({ class: 'feat', tier: 'standard', rounds: 0, state: 'open', verdict: '', ...row })
const NAMING = [line({ id: 1, label: 'acme/app#11', state: 'closed', rounds: 1, verdict: 'approved' }), line({ id: 2, label: 'acme/app#12' }), LEDGER].join('\n') + '\n'

type Over = { rows?: string; origin?: string | null; readOnly?: boolean; answer?: unknown }

function fake(over: Over = {}) {
  const files = new Map<string, string>([
    [`${STATE}/store/sessions/s-orch`, JSON.stringify({ role: 'orchestrator', name: `${ORCH} [a1b2c3]`, updated_at: '2026-11-14T10:00:00.000Z' })],
    [`${STATE}/records/s-orch`, `${RECORD}\n`],
    [`${RECORD}.owner`, `${ORCH}\n`],
    [RECORD, over.rows ?? NAMING],
  ])
  const logged: string[] = []
  const calls: Record<string, unknown>[] = []
  const origin = over.origin === undefined ? 'git@github.com:acme/app.git' : over.origin
  const dollar = hostOf({
    plugin: { root: '/plugins/orch' },
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    session: { id: async () => 's-orch' },
    clock: { sleep: async () => undefined },
    tool: { call: async (input: { tool: string } & Record<string, unknown>) => { calls.push(input); return over.answer ?? { result: WRITTEN } } },
    fs: {
      read: async (p: string) => { if (!files.has(p)) throw new Error(`ENOENT: ${p}`); return files.get(p)! },
      write: async (p: string, text: string) => { if (over.readOnly && p.includes('dispatch-record')) throw new Error('disk full'); files.set(p, text) },
      exists: async (p: string) => files.has(p),
      stat: async (p: string) => { if (!files.has(p)) throw new Error(`ENOENT: ${p}`); return { kind: 'file' as const, size: 1, mtimeMs: 1 } },
    },
    process: {
      run: async (argv: readonly string[]) => {
        const log = logLineOf(argv)
        if (log !== null) { logged.push(log); return { exitCode: 0, stdout: '', stderr: '' } }
        if (argv[0] === 'git') {
          if (argv[1] === 'remote') return origin === null ? { exitCode: 1, stdout: '', stderr: 'no origin' } : { exitCode: 0, stdout: `${origin}\n`, stderr: '' }
          return { exitCode: 0, stdout: `${HEAD}\n`, stderr: '' }
        }
        const lock = lockRun(argv, files)
        if (lock !== null) return lock
        if (argv[0] === 'mv') { files.set(argv[3]!, files.get(argv[2]!)!); files.delete(argv[2]!) }
        if (argv[0] === 'rm') for (const p of argv.slice(2)) files.delete(p)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  })
  return { dollar, files, logged, calls }
}

function handler(): (dollar: World, e: Events['tool.call']) => Promise<Out> {
  const found = hooksOn(capture<World>(registerReview), 'tool.call').filter(h => h.matcher !== undefined).at(-1)!
  return async (dollar, e) => await found.handler(dollar, e, async () => undefined) as Out
}

const rowsOf = (files: Map<string, string>) => (files.get(RECORD) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
const roundsOf = (files: Map<string, string>) => Object.fromEntries(rowsOf(files).filter(r => r.id !== undefined).map(r => [r.id, r.rounds]))

const VERDICT = { pr: 12, repo: 'acme/app', dir: '/work/app', verdict: 'pass', detail: 'read' }

for (const [verdict, extra] of [
  ['pass', {}],
  ['fail', { kept: [{ point: 'a.ts' }] }],
  ['accepted', { set_asides: [{ point: 'a.ts', reason: 'naming only' }] }],
] as const) {
  test(`a ${verdict} verdict raises the rounds of the row that names the pull request, and says which`, async () => {
    const fx = fake()
    const out = await handler()(fx.dollar, { ...VERDICT, verdict, ...extra })
    expect(roundsOf(fx.files)).toEqual({ 1: 1, 2: 1 })
    expect(out).toEqual({ result: `${WRITTEN} · row 2 round 1` })
    // The row's other fields and the ledger line stay as they were.
    expect(rowsOf(fx.files)[1]).toEqual({ id: 2, class: 'feat', tier: 'standard', rounds: 1, state: 'open', verdict: '', label: 'acme/app#12' })
    expect(rowsOf(fx.files)[2]).toEqual(JSON.parse(LEDGER))
  })
}

// The field answer, measured on the orchestrator's own transcript: a path line, a gate line of 300
// to 600 characters, the count, the row and a warning. It is the path line and ONE line now.
test('a verdict that names its row answers the path line and one line: the gate\'s verdict, the row, the round', async () => {
  const detail = 'set aside: a.ts — naming only'
  const gate = `/cfg/records/acme/app/${HEAD}/review.json\ngithub: acme/app#12 Ready at 0123456: review accepted by the orchestrator (${detail}), no norms check needed (check plan, 2026-11-15: a small fix), no E2E needed (check plan, 2026-11-15: hook logic covered) and green CI hold at its head.`
  const fx = fake({ answer: { result: gate } })
  const base = fx.dollar.process.run
  fx.dollar.process.run = async (argv: readonly string[], init?: object) => (String(argv[1] ?? '').endsWith('/dispatch-record.sh')
    ? { exitCode: 0, stdout: 'row 2: accepted — 1 point(s) set aside — findings: /b/review-12.md\n', stderr: '' }
    : base(argv, init))
  const out = await handler()(fx.dollar, { ...VERDICT, verdict: 'accepted', set_asides: [{ point: 'a.ts', reason: 'naming only' }], detail: '', record: RECORD, row: 2, findings: '/b/review-12.md' })
  expect(out.result).toBe(`/cfg/records/acme/app/${HEAD}/review.json\nReady at 0123456 · row 2: accepted, round 1`)
  expect(out.result.length).toBeLessThan(gate.length / 2)
  expect(rowsOf(fx.files)[1]?.rounds).toBe(1)
})

test('a second verdict on the pull request counts a second round', async () => {
  const fx = fake()
  await handler()(fx.dollar, { ...VERDICT, verdict: 'fail', kept: [{ point: 'a.ts' }] })
  await handler()(fx.dollar, VERDICT)
  expect(roundsOf(fx.files)).toEqual({ 1: 1, 2: 2 })
})

test('a row whose label names the pull request by the bare repository name is the row; another repository\'s same number is not', async () => {
  const fx = fake({ rows: [line({ id: 1, label: 'other#12' }), line({ id: 2, label: 'build app#12 (the fix)' })].join('\n') + '\n' })
  const out = await handler()(fx.dollar, VERDICT)
  expect(roundsOf(fx.files)).toEqual({ 1: 0, 2: 1 })
  expect(out.result).toContain('row 2')
})

test('no row naming the pull request: the verdict stands, nothing is raised, and the answer says that no row matched', async () => {
  const fx = fake({ rows: [line({ id: 1, label: 'acme/app#13' }), line({ id: 2, label: 'a label naming none' })].join('\n') + '\n' })
  const before = fx.files.get(RECORD)
  const out = await handler()(fx.dollar, VERDICT)
  expect(out).toEqual({ result: `${WRITTEN}\nrounds: no dispatch-record row names acme/app#12, none raised: open its row with a label naming acme/app#12` })
  expect(out.isError).toBeUndefined()
  expect(fx.files.get(RECORD)).toBe(before)
  expect(fx.calls.length).toBe(1)
})

test('no record at all: the same line, and the verdict stands', async () => {
  const fx = fake()
  fx.files.delete(`${STATE}/records/s-orch`)
  expect(await handler()(fx.dollar, VERDICT)).toEqual({ result: `${WRITTEN}\nrounds: no dispatch-record row names acme/app#12, none raised: open its row with a label naming acme/app#12` })
})

test('a closed row whose verdict names the pull request is counted when no open row does', async () => {
  const fx = fake({ rows: line({ id: 1, label: 'wave', state: 'closed', verdict: 'approved acme/app#12', rounds: 1 }) + '\n' })
  const out = await handler()(fx.dollar, VERDICT)
  expect(roundsOf(fx.files)).toEqual({ 1: 2 })
  expect(out.result).toContain('row 1')
})

test('an open row is preferred to a closed one; two open rows are not guessed between', async () => {
  const fx = fake({ rows: [line({ id: 1, label: 'acme/app#12', state: 'closed', verdict: 'approved' }), line({ id: 2, label: 'acme/app#12' })].join('\n') + '\n' })
  await handler()(fx.dollar, VERDICT)
  expect(roundsOf(fx.files)).toEqual({ 1: 0, 2: 1 })
  const two = fake({ rows: [line({ id: 1, label: 'acme/app#12' }), line({ id: 2, label: 'acme/app#12 again' })].join('\n') + '\n' })
  const out = await handler()(two.dollar, VERDICT)
  expect(roundsOf(two.files)).toEqual({ 1: 0, 2: 0 })
  expect(out.result).toBe(`${WRITTEN}\nrounds: none raised, rows 1, 2 all name acme/app#12`)
})

test('a row `dispatch-record.sh review` recorded at this head is counted by the verdict: the verdict is the one writer of the round', async () => {
  const fx = fake({ rows: line({ id: 2, label: 'acme/app#12', rounds: 0, review: { head: HEAD, norms: '', at: 't' } }) + '\n' })
  const out = await handler()(fx.dollar, VERDICT)
  expect(roundsOf(fx.files)).toEqual({ 2: 1 })
  expect(out.result).toBe(`${WRITTEN} · row 2 round 1`)
})

test('the repository omitted is read from the checkout\'s origin, and unknown it is said', async () => {
  const { repo: _repo, ...bare } = VERDICT
  const fx = fake()
  expect((await handler()(fx.dollar, bare)).result).toContain('row 2 round 1')
  expect(roundsOf(fx.files)).toEqual({ 1: 1, 2: 1 })
  const none = fake({ origin: null })
  const out = await handler()(none.dollar, bare)
  expect(out).toEqual({ result: `${WRITTEN}\nrounds: none raised, the repository of the pull request is not known: give repo` })
  expect(roundsOf(none.files)).toEqual({ 1: 1, 2: 0 })
})

test('with no dir the checkout is the session\'s own cwd, and with neither the repository is said unknown', async () => {
  const { repo: _repo, dir: _dir, ...bare } = VERDICT
  const seen: (string | undefined)[] = []
  const fx = fake()
  const run = fx.dollar.process.run
  fx.dollar.process.run = async (argv: readonly string[], init?: { cwd?: string }) => { if (argv[0] === 'git') seen.push(init?.cwd); return run(argv, init) }
  await handler()(fx.dollar, { ...bare, cwd: '/work/session' })
  expect(seen).toEqual(['/work/session'])
  expect(roundsOf(fx.files)).toEqual({ 1: 1, 2: 1 })
  const none = fake()
  expect((await handler()(none.dollar, bare)).result).toContain('the repository of the pull request is not known')
  expect(roundsOf(none.files)).toEqual({ 1: 1, 2: 0 })
})

test('a record that cannot be written is said in the answer and the log, and the verdict stands', async () => {
  const fx = fake({ readOnly: true })
  const out = await handler()(fx.dollar, VERDICT)
  expect(out.isError).toBeUndefined()
  expect(out.result.startsWith(`${WRITTEN}\nrounds: none raised, `)).toBe(true)
  expect(out.result).toContain('disk full')
  expect(fx.logged.length).toBe(1)
  expect(fx.logged[0]).toContain('| review |')
})

test('github\'s refusal counts no round, and a check plan counts none either', async () => {
  const refused = fake({ answer: { deny: 'github: a pass does not override a failed review.' } })
  expect((await handler()(refused.dollar, VERDICT)).isError).toBe(true)
  expect(roundsOf(refused.files)).toEqual({ 1: 1, 2: 0 })
  const planned = fake()
  const out = await handler()(planned.dollar, { pr: 12, repo: 'acme/app', plan: { review: 'one-pass: a typo' } })
  expect(out).toEqual({ result: WRITTEN })
  expect(roundsOf(planned.files)).toEqual({ 1: 1, 2: 0 })
})

// The row the call names (`record` + `row`) is the row whose round is raised, whatever the labels say.
const NAMED = { record: RECORD, findings: '' }

test('a verdict that names its row raises that row, not the other row whose label or verdict names the pull request', async () => {
  const rows = [
    line({ id: 42, label: 'the fix of the round count' }),
    line({ id: 46, label: 'wave 16', verdict: 'rebased onto acme/app#12' }),
    line({ id: 47, label: 'acme/app#12' }),
  ].join('\n') + '\n'
  const fx = fake({ rows })
  const out = await handler()(fx.dollar, { ...VERDICT, ...NAMED, row: 42 })
  expect(roundsOf(fx.files)).toEqual({ 42: 1, 46: 0, 47: 0 })
  expect(out.result).toContain('row 42 round 1')
})

test('a verdict that names a row whose label names no pull request raises it, with no "none raised" line', async () => {
  const fx = fake({ rows: line({ id: 5, label: 'a label naming none' }) + '\n' })
  const out = await handler()(fx.dollar, { ...VERDICT, ...NAMED, row: 5 })
  expect(roundsOf(fx.files)).toEqual({ 5: 1 })
  expect(out.result).toContain('row 5 round 1')
  expect(out.result).not.toContain('none raised')
})

test('a verdict that names a row the record does not hold falls to the row that names the pull request', async () => {
  const fx = fake()
  const out = await handler()(fx.dollar, { ...VERDICT, ...NAMED, row: 99 })
  expect(roundsOf(fx.files)).toEqual({ 1: 1, 2: 1 })
  expect(out.result).toContain('row 2 round 1')
})

test('with no row named, the repository of a label is read whatever its case, and a prefix or another repository is no match', async () => {
  const rows = [
    line({ id: 1, label: 'acme/app#123' }),
    line({ id: 2, label: 'acme/application#12' }),
    line({ id: 3, label: 'other/app#12' }),
    line({ id: 4, label: 'Acme/App#12' }),
  ].join('\n') + '\n'
  const fx = fake({ rows })
  const out = await handler()(fx.dollar, VERDICT)
  expect(roundsOf(fx.files)).toEqual({ 1: 0, 2: 0, 3: 0, 4: 1 })
  expect(out.result).toContain('row 4')
})

test('a named row whose write fails says so and raises no other row', async () => {
  const fx = fake({ readOnly: true, rows: [line({ id: 1, label: 'acme/app#12' }), line({ id: 2, label: 'a label naming none' })].join('\n') + '\n' })
  const out = await handler()(fx.dollar, { ...VERDICT, ...NAMED, row: 2 })
  expect(roundsOf(fx.files)).toEqual({ 1: 0, 2: 0 })
  expect(out.result).toContain('rounds: none raised, ')
  expect(out.result).toContain('disk full')
  expect(fx.logged.length).toBe(1)
})

// The review session of acme/app#12 as the launcher leaves it: its session row, its launch script naming its brief, the brief.
const REVIEW_BRIEF = [
  '# app — review: the delivery', '', 'You are the REVIEW agent for this round. You read; you never implement.', '',
  `4. The delivery: pull request 12 (the implementer's report, \`/b/report.md\`), branch \`fix/x\`, head \`${HEAD.slice(0, 8)}\`, base \`origin/main\``,
].join('\n')

// Mutation: `closeLine` (review.ts) takes no cost from the count when the verdict names no row; this test falls.
test('a verdict that names no row owes the review session\'s close with its cost on the row the round counted', async () => {
  owedOf('s-orch').forEach(settleOwed)
  const fx = fake()
  fx.files.set(`${STATE}/store/sessions/s-rev`, JSON.stringify({ role: 'agent', name: 'Agent: review 12 r1 [a1b2c3]', tty: '/dev/ttys007', updated_at: '2026-11-14T10:00:00.000Z' }) + '\n')
  fx.files.set(`${STATE}/prompts/launch-Agent--review-12-r1-1795386718957.sh`, '#!/bin/sh\ncd /w && export ORCHESTRATOR_BRIEF=/briefs/review.md && exec claude\n')
  fx.files.set('/briefs/review.md', REVIEW_BRIEF)
  fx.dollar.fs.list = async (dir: string) => [...fx.files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
    .map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 0, isLink: false }))
  const out = await handler()(fx.dollar, VERDICT)
  expect(out.result).toContain('row 2 round 1')
  expect(out.result.split('\n').at(-1)).toBe('review session of acme/app#12 0123456: Agent: review 12 r1 is closed by the module once its turn ends.')
  expect(owedOf('s-orch').map(one => one.cost)).toEqual([{ record: RECORD, row: 2 }])
  owedOf('s-orch').forEach(settleOwed)
})
