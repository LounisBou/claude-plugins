// hooks/tests/unattended.test.ts
// The pull requests nobody attends, over a faked $: the machine file's open pull requests against the
// session's own ledger lines (a pull request no line of its record names is nobody's), the agents the
// launcher lists running; the lines of the pull requests merged or closed read apart; the line the turn end leaves for the next
// prompt's context and the session's row; and the one refusal of a done or a deferred wait.
import { expect, test } from 'claude-code/testing'
import { readUnattended, register as registerUnattended, unattendedRefusal } from '../unattended.ts'
import { readOr, safe } from '../unattended.ts'
import { register as registerWait, Declarations } from '../wait.ts'
import { WAIT_TOOL } from '../../core/orchestration.ts'
import { logLineOf, lockRun, prQueryRun } from './fakes.ts'
import type { Reply } from 'claude-code/testing'
import { capture, hookOf, hooksOn, hostOf } from '../../core/capture.ts'
import type { Events, Host, Noun, On } from '../../core/host.ts'

const HOME = '/tmp/unattended-home'
const MODULE = `${HOME}/.claude/claude-orchestrator`
const RECORD = '/briefs/app/dispatch-record.jsonl'
const OTHER_RECORD = '/briefs/web/dispatch-record.jsonl'
const NOW = Date.parse('2026-11-14T11:00:00Z')

const line = (pr: number, status: string, detail: Record<string, string>, updated = '2026-11-14T10:50:00Z') =>
  JSON.stringify({ v: 1, ledger: 'pr', repo: 'acme/app', pr, status, ...detail, since: '2026-11-14T09:00:00Z', updated })

// A row measured now: a live session on the clock a hook reads (the turn end) as on the fixed one of a reading.
const row = (role: string, name: string, repo: string | null = 'acme/app', extra: Record<string, unknown> = {}) =>
  JSON.stringify({ role, name, repo, context_percent: 1, context_tokens: 1, window: 100, model: 'm', busy: false, updated_at: new Date().toISOString(), ...extra })

// `extra`: lines of the session's own record beside the ones it has (pull requests 7, 8, 5, 6 and 9).
type Answers = { forge?: Record<string, string | null>; launcher?: string | null; ps?: string | null | undefined; extra?: string[] }

// Pull request 11, an agent that does not run on it, last set well before.
const ELEVEN = line(11, 'working', { agent: 'Agent: eleven' }, '2026-11-11T08:00:00Z')

function world(answers: Answers = {}) {
  const files = new Map<string, string>([
    [`${MODULE}/store/sessions/s-orch`, row('orchestrator', 'Orch: app')],
    [`${MODULE}/records/s-orch`, `${RECORD}\n`],
    [`${RECORD}.owner`, 'Orch: app\n'],
    [RECORD, [
      JSON.stringify({ id: 1, state: 'open', label: 'a row' }),
      line(7, 'working', { agent: 'Agent: seven' }),
      line(8, 'waiting', { on: 'la CI' }, '2026-11-14T10:00:00Z'),
      line(5, 'working', { agent: 'Agent: five' }),
      line(6, 'parked', { ruling: 'plus tard, 2026-11-14' }),
      line(9, 'working', { agent: 'Agent: nine' }),
      ...(answers.extra ?? []),
    ].join('\n') + '\n'],
    [`${MODULE}/store/sessions/s-other`, row('orchestrator', 'Orch: web')],
    [`${MODULE}/records/s-other`, `${OTHER_RECORD}\n`],
    [OTHER_RECORD, line(10, 'working', { agent: 'Agent: ten' }) + '\n'],
  ])
  const logs: string[] = []
  const runs: string[][] = []
  const forge = answers.forge ?? { 'acme/app': JSON.stringify([7, 8, 6, 9, 10].map(n => ({ number: n, createdAt: `2026-11-1${n % 10}T08:00:00Z` }))) }
  const dollar = hostOf({
    plugin: { root: '/plugins/orch' },
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    session: { id: async () => 's-orch' },
    clock: { sleep: async () => undefined },
    fs: {
      read: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)! },
      write: async (p: string, text: string) => { files.set(p, text) },
      stat: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return { kind: 'file', size: files.get(p)!.length, mtimeMs: NOW } },
      exists: async (p: string) => files.has(p),
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 1, isLink: false })),
    },
    process: {
      run: async (argv: readonly string[]) => {
        const log = logLineOf(argv)
        if (log !== null) { logs.push(log); return { exitCode: 0, stdout: '', stderr: '' } }
        const lock = lockRun(argv, files)
        if (lock !== null) return lock
        runs.push([...argv])
        const [verb, , from = '', to = ''] = argv
        if (verb === 'mv') { files.set(to, files.get(from)!); files.delete(from); return { exitCode: 0, stdout: '', stderr: '' } }
        if (argv[0] === 'rm') { for (const p of argv.slice(2)) files.delete(p); return { exitCode: 0, stdout: '', stderr: '' } }
        const asked = prQueryRun(argv, repo => forge[repo] ?? null)
        if (asked !== null) return asked
        if (argv[0] === 'ps') {
          return answers.ps === undefined || answers.ps === null ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: answers.ps, stderr: '' }
        }
        if (argv[0] === 'bash' && argv[2] === 'list') {
          const listed = answers.launcher === undefined ? 'w1/t1 | /dev/ttys001 | ✳ Agent: seven | Agent: seven\nw1/t2 | /dev/ttys002 | zsh | Agent: five' : answers.launcher
          return listed === null ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: listed, stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    ui: { invalidate: () => undefined },
  })
  return { dollar, files, logs, runs }
}

test('an open pull request of the record with no live agent or a stale wait is unattended; a parked one, one whose agent runs, or one no line of the record names is not', async () => {
  const { dollar } = world()
  const reading = await readUnattended(dollar, 's-orch', NOW)
  expect(reading?.list.map(u => u.pr)).toEqual([8, 9])
  expect(reading?.unread).toEqual([])
  expect(reading?.line).toBe('En anomalie : acme/app#8 (sans agent depuis 2026-11-14T10:00Z), acme/app#9 (sans agent depuis 2026-11-14T10:50Z)')
})

// The forge's list of the world's pull requests, each with the labels given (Not Ready unless said).
const labelled = (labels: Record<number, string[]>, numbers: number[] = [7, 8, 6, 9, 10]) =>
  ({ 'acme/app': JSON.stringify(numbers.map(n => ({ number: n, createdAt: `2026-11-1${n % 10}T08:00:00Z`, labels: (labels[n] ?? ['Not Ready']).map(name => ({ name })) }))) })

test('a pull request no agent holds is told apart: Ready and On Hold wait on the operator, only Not Ready with no agent and no wait is in anomaly', async () => {
  const { dollar } = world({ forge: labelled({ 8: ['On Hold'], 9: ['Ready'], 11: ['Not Ready'] }, [7, 8, 6, 9, 10, 11]), extra: [ELEVEN] })
  const reading = await readUnattended(dollar, 's-orch', NOW)
  expect(reading?.list.map(u => [u.pr, u.waits?.why])).toEqual([[8, 'hold'], [9, 'ready'], [11, undefined]])
  expect(reading?.line).toBe([
    'Attend ton geste : acme/app#8 (en pause), acme/app#9 (Ready)',
    'En anomalie : acme/app#11 (sans agent depuis 2026-11-11T08:00Z)',
  ].join('\n'))
})

test('a pull request the forge reads in conflict is in anomaly « en conflit », Ready or not; mergeable and unknown are left as they were', async () => {
  const listed = (state: Record<number, string>) => ({ 'acme/app': JSON.stringify([8, 9, 11].map(n => ({ number: n, createdAt: '2026-11-11T08:00:00Z', labels: [{ name: 'Ready' }], mergeable: state[n] }))) })
  const { dollar } = world({ forge: listed({ 8: 'CONFLICTING', 9: 'MERGEABLE', 11: 'UNKNOWN' }), extra: [ELEVEN] })
  const reading = await readUnattended(dollar, 's-orch', NOW)
  expect(reading?.line).toBe([
    'Attend ton geste : acme/app#9 (Ready), acme/app#11 (Ready)',
    'En anomalie : acme/app#8 (en conflit)',
  ].join('\n'))
})

test('a line that waits on the operator is told so, even set a moment ago; one that waits on the CI is attended while fresh', async () => {
  const { dollar, files } = world({ forge: labelled({}, [8, 9]) })
  files.set(RECORD, [line(8, 'waiting', { on: 'le merge de l\'opérateur' }, '2026-11-14T10:59:00Z'), line(9, 'waiting', { on: 'la CI' }, '2026-11-14T10:59:00Z')].join('\n') + '\n')
  const reading = await readUnattended(dollar, 's-orch', NOW)
  expect(reading?.line).toBe("Attend ton geste : acme/app#8 (attend le merge de l'opérateur depuis 2026-11-14T09:00Z)")
})

test('the turn end says both lines, publishes the kind of each pull request, and declare_wait refuses a done only for an anomaly', async () => {
  const handlers = mounted()
  const waitsOnly = world({ forge: labelled({ 8: ['On Hold'], 9: ['Ready'] }) })
  await handlers['turn.complete'](waitsOnly.dollar, { reason: 'answer' })
  const published = JSON.parse(waitsOnly.files.get(`${MODULE}/store/sessions/s-orch`) ?? '{}').unattended
  expect(published.prs.map((u: { pr: number; waits?: { why: string } }) => [u.pr, u.waits?.why])).toEqual([[8, 'hold'], [9, 'ready']])
  expect(published.line).toBe('Attend ton geste : acme/app#8 (en pause), acme/app#9 (Ready)')
  expect((await handlers['prompt.submit'](waitsOnly.dollar, { text: 'go' })).context).toEqual([published.line])
  // Rows closed, only what rests on the operator left: nothing alarms, the done is taken.
  const declare = declaring(new Declarations())
  waitsOnly.files.set(RECORD, (waitsOnly.files.get(RECORD) ?? '').replace('"state":"open"', '"state":"closed"'))
  expect((await declare(waitsOnly.dollar, { kind: 'done' })).isError).toBe(undefined)
  // The same with one pull request in anomaly: the refusal names it alone.
  const withAnomaly = world({ forge: labelled({ 8: ['On Hold'], 9: ['Ready'] }, [7, 8, 6, 9, 10, 11]), extra: [ELEVEN] })
  withAnomaly.files.set(RECORD, (withAnomaly.files.get(RECORD) ?? '').replace('"state":"open"', '"state":"closed"'))
  const refused = await declare(withAnomaly.dollar, { kind: 'done' })
  expect(refused.isError).toBe(true)
  expect(refused.result).toContain('Not done: En anomalie : acme/app#11')
  expect(refused.result).not.toContain('Attend ton geste')
  expect(refused.result).not.toContain('acme/app#9')
})

test('only the pull requests its own record has a line for are its: one another orchestrator records, or none does, is nobody\'s here', async () => {
  // 10 is recorded by a live orchestrator, 12 by none; both are open and Ready, neither is drawn.
  const forge = labelled({ 10: ['Ready'], 12: ['Ready'] }, [7, 8, 6, 9, 10, 12])
  const { dollar, files } = world({ forge })
  expect((await readUnattended(dollar, 's-orch', NOW))?.list.map(u => u.pr)).toEqual([8, 9])
  // The other orchestrator gone, its line stale: still not this one's.
  files.set(`${MODULE}/store/sessions/s-other`, row('orchestrator', 'Orch: web', 'acme/app', { updated_at: '2026-11-14T08:00:00Z' }))
  files.set(OTHER_RECORD, line(10, 'working', { agent: 'Agent: ten' }) + '\n')
  expect((await readUnattended(dollar, 's-orch', NOW))?.list.map(u => u.pr)).toEqual([8, 9])
  // A record with lines for 4 and 5, the file listing 4, 5 and 6 open: 4 and 5 only.
  const own = world({ forge: labelled({}, [4, 5, 6]) })
  own.files.set(RECORD, [line(4, 'working', { agent: 'Agent: four' }), line(5, 'working', { agent: 'Agent: five' })].join('\n') + '\n')
  const reading = await readUnattended(own.dollar, 's-orch', NOW)
  expect(reading?.list.map(u => u.pr)).toEqual([4, 5])
  expect(reading?.line).toBe('En anomalie : acme/app#4 (sans agent depuis 2026-11-14T10:50Z), acme/app#5 (sans agent depuis 2026-11-14T10:50Z)')
})

test('only the repositories of the session\'s dispatch record are read, never its checkout\'s own', async () => {
  const { dollar, files, runs } = world({ forge: { 'acme/app': '[]', 'acme/home': JSON.stringify([{ number: 45, createdAt: '2026-11-13T08:00:00Z' }]) } })
  files.set(`${MODULE}/store/sessions/s-orch`, row('orchestrator', 'Orch: app', 'acme/home'))
  const reading = await readUnattended(dollar, 's-orch', NOW)
  const queries = runs.filter(argv => argv[0] === 'gh').map(argv => String(argv[4]))
  expect(queries.length).toBe(1)
  expect(queries[0]).toContain('repository(owner:"acme",name:"app")')
  expect(queries[0]).not.toContain('"home"')
  expect(reading?.line).toBe(null)
  // A record with no pull request line asks the forge nothing.
  const empty = world({ forge: { 'acme/home': JSON.stringify([{ number: 45, createdAt: '2026-11-13T08:00:00Z' }]) } })
  empty.files.set(`${MODULE}/store/sessions/s-orch`, row('orchestrator', 'Orch: app', 'acme/home'))
  empty.files.set(RECORD, JSON.stringify({ id: 1, state: 'open', label: 'a row' }) + '\n')
  expect((await readUnattended(empty.dollar, 's-orch', NOW))?.list).toEqual([])
  expect(empty.runs.filter(argv => argv[0] === 'gh')).toEqual([])
})

test('the line of a pull request the file reads merged or closed has ended: read apart, left for the tick to tell and archive', async () => {
  const { dollar, files } = world()
  const reading = await readUnattended(dollar, 's-orch', NOW)
  expect(reading?.ended.map(e => [e.line.pr, e.state, e.path])).toEqual([[5, 'MERGED', RECORD]])
  expect(reading?.kept.map(l => l.pr)).toEqual([7, 8, 6, 9])
  expect(files.has('/briefs/app/dispatch-record.archive.jsonl')).toBe(false)
})

test('a repository the forge did not list is said unknown, never « none », and nothing of it is archived', async () => {
  const { dollar, files, logs } = world({ forge: { 'acme/app': null } })
  const reading = await readUnattended(dollar, 's-orch', NOW)
  expect(reading?.list).toEqual([])
  expect(reading?.line).toBe('En anomalie : inconnues pour acme/app (forge illisible)')
  expect(files.has('/briefs/app/dispatch-record.archive.jsonl')).toBe(false)
  expect(logs.some(l => l.includes('refresh failed, the file kept: gh exited 1: HTTP 502'))).toBe(true)
})

test('a file whose last refresh failed says its repositories unknown, even after an earlier good read', async () => {
  const forge: Record<string, string | null> = { 'acme/app': JSON.stringify([{ number: 8 }]) }
  const { dollar } = world({ forge })
  expect((await readUnattended(dollar, 's-orch', NOW))?.unread).toEqual([])
  forge['acme/app'] = null
  const reading = await readUnattended(dollar, 's-orch', NOW + 60_000)
  expect(reading?.unread).toEqual(['acme/app'])
  expect(reading?.list).toEqual([])
})

test('a launcher listing that cannot be read takes every agent a line names for running', async () => {
  const { dollar } = world({ launcher: null })
  expect((await readUnattended(dollar, 's-orch', NOW))?.list.map(u => u.pr)).toEqual([8])
  const { dollar: other } = world({ launcher: '' })
  expect((await readUnattended(other, 's-orch', NOW))?.list.map(u => u.pr)).toEqual([7, 8, 9])
})

// The record's rows beside its ledger lines: one ready with nobody on it, and one each held by what the method says.
const readyRecord = (rows: object[]) => `${rows.map(r => JSON.stringify(r)).join('\n')}\n${line(7, 'working', { agent: 'Agent: seven' })}\n`
const ROW = (id: number, label: string, more: Record<string, unknown> = {}) => ({ id, state: 'open', label, blocker: 'none', ...more })
const READY_ROWS = [
  ROW(21, 'IDLEWORK: nobody on it'),
  ROW(22, 'FIVEWORK: its agent runs'),
  ROW(23, 'LATERWORK: waits', { blocker: 'row 4 closed' }),
  ROW(24, 'PUTOFF: deferred', { deferred: 'later, 2026-11-14' }),
  ROW(25, 'SEVEN: its pull request is open'),
  ROW(26, 'DONEWORK: closed', { state: 'closed' }),
]

test('an open row with blocker none, no live agent and no open pull request is ready: named, and the others are not', async () => {
  const { dollar, files } = world()
  files.set(RECORD, readyRecord(READY_ROWS))
  const reading = await readUnattended(dollar, 's-orch', NOW)
  expect(reading?.ready).toEqual([{ id: 21, keyword: 'IDLEWORK' }, { id: 22, keyword: 'FIVEWORK' }])
  expect(reading?.readyLine).toBe('Lignes prêtes sans agent : 21 IDLEWORK, 22 FIVEWORK')
  // The agent of the second row is running: the launcher's listing says it so.
  const { dollar: running, files: again } = world({ launcher: 'w1/t1 | /dev/ttys001 | ✳ Agent: fivework | Agent: fivework' })
  again.set(RECORD, readyRecord(READY_ROWS))
  expect((await readUnattended(running, 's-orch', NOW))?.readyLine).toBe('Lignes prêtes sans agent : 21 IDLEWORK')
})

test('a row whose until time has passed is ready, one before it is not; a measure is never ready', async () => {
  const { dollar, files } = world()
  files.set(RECORD, readyRecord([
    ROW(31, 'WAKEUP: at ten', { blocker: 'until 2026-11-14T10:00:00Z' }),
    ROW(32, 'LATEWAKE: at noon', { blocker: 'until 2026-11-14T12:00:00Z' }),
    ROW(33, 'SPEED: p95', { blocker: 'measure p95 under 300 ms' }),
  ]))
  expect((await readUnattended(dollar, 's-orch', NOW))?.ready).toEqual([{ id: 31, keyword: 'WAKEUP' }])
  expect((await readUnattended(dollar, 's-orch', Date.parse('2026-11-14T12:00:00Z')))?.ready).toEqual([{ id: 31, keyword: 'WAKEUP' }, { id: 32, keyword: 'LATEWAKE' }])
})

test('an open pull request in the ledger holds its row, with no agent running; the launcher is asked once, and only when a row may be ready', async () => {
  // Line 7 names Agent: seven; the listing shows nobody running, so the pull request alone holds row 25.
  const { dollar, files, runs } = world({ launcher: 'w1/t1 | /dev/ttys001 | zsh | zsh' })
  files.set(RECORD, readyRecord([READY_ROWS[4]!]))
  expect((await readUnattended(dollar, 's-orch', NOW))?.ready).toEqual([])
  expect(runs.filter(r => r[0] === 'bash' && r[2] === 'list').length).toBe(1)
  // No line names an agent and no row is ready: the launcher is never asked.
  const { dollar: quiet, files: none, runs: asked } = world()
  none.set(RECORD, `${JSON.stringify(READY_ROWS[2])}\n`)
  expect((await readUnattended(quiet, 's-orch', NOW))?.readyLine).toBe(null)
  expect(asked.filter(r => r[0] === 'bash' && r[2] === 'list')).toEqual([])
})

test('a launcher listing that cannot be read names no row ready, and a record with no ready row leaves no line', async () => {
  const { dollar, files, logs } = world({ launcher: null })
  files.set(RECORD, readyRecord(READY_ROWS))
  const reading = await readUnattended(dollar, 's-orch', NOW)
  expect(reading?.ready).toEqual([])
  expect(reading?.readyLine).toBe(null)
  expect(logs.some(l => l.includes('the launcher\'s listing unread'))).toBe(true)
  const { dollar: none } = world()
  expect((await readUnattended(none, 's-orch', NOW))?.readyLine).toBe(null)
})

test('the turn end leaves the ready rows beside the unattended pull requests for the next prompt, once', async () => {
  const { dollar, files } = world()
  // Beside the ready row, the record's line of pull request 8: its wait is stale, no agent is on it.
  files.set(RECORD, `${readyRecord(READY_ROWS.slice(0, 1))}${line(8, 'waiting', { on: 'la CI' }, '2026-11-14T10:00:00Z')}\n`)
  const handlers = mounted()
  await handlers['turn.complete'](dollar, { reason: 'answer' })
  const first = await handlers['prompt.submit'](dollar, { text: 'go', context: ['before'] })
  expect(first.context?.[0]).toBe('before')
  expect(first.context?.[1]).toContain('En anomalie : acme/app#8')
  expect(first.context?.slice(2)).toEqual(['Lignes prêtes sans agent : 21 IDLEWORK'])
  expect((await handlers['prompt.submit'](dollar, { text: 'go' })).context).toBe(undefined)
  // Nothing ready, nothing unattended: no line at all.
  const { dollar: quiet } = world({ forge: { 'acme/app': JSON.stringify([{ number: 7 }, { number: 6 }]) } })
  await handlers['turn.complete'](quiet, { reason: 'answer' })
  expect((await handlers['prompt.submit'](quiet, { text: 'go' })).context).toBe(undefined)
})

test('a change of one of the two lines says that line alone at the next prompt', async () => {
  const handlers = mounted()
  const first = world({ forge: labelled({ 9: ['Ready'] }, [7, 8, 6, 9, 10, 11]), extra: [ELEVEN] })
  await handlers['turn.complete'](first.dollar, { reason: 'answer' })
  const said = (await handlers['prompt.submit'](first.dollar, { text: 'go' })).context
  expect(said).toEqual(['Attend ton geste : acme/app#9 (Ready)', 'En anomalie : acme/app#8 (sans agent depuis 2026-11-14T10:00Z), acme/app#11 (sans agent depuis 2026-11-11T08:00Z)'])
  // A new Ready pull request: the anomaly line, unchanged, is not told again.
  const next = world({ forge: labelled({ 9: ['Ready'], 12: ['Ready'] }, [7, 8, 6, 9, 10, 11, 12]), extra: [ELEVEN, line(12, 'working', { agent: 'Agent: twelve' })] })
  await handlers['turn.complete'](next.dollar, { reason: 'answer' })
  const then = (await handlers['prompt.submit'](next.dollar, { text: 'go' })).context
  expect(then).toEqual(['Attend ton geste : acme/app#9 (Ready), acme/app#12 (Ready)'])
})

test('a session that is no orchestrator reads nothing', async () => {
  const { dollar, files, runs } = world()
  files.set(`${MODULE}/store/sessions/s-orch`, row('agent', 'Agent: seven'))
  expect(await readUnattended(dollar, 's-orch', NOW)).toBe(null)
  expect(runs).toEqual([])
})

// What a hook answered, as a test reads it.
const answered = (x: unknown): Reply => x as Reply
const through = async <E>(e: E): Promise<E> => e

function mounted() {
  const hooks = capture(registerUnattended)
  const hook = <K extends keyof Events>(event: K) => {
    const found = hooksOn(hooks, event)[0]
    if (found === undefined) throw new Error(`no hook ${event}`)
    return found
  }
  return {
    'turn.complete': (dollar: Host<Noun>, e: Events['turn.complete']) => hook('turn.complete').handler(dollar, e, through),
    'prompt.submit': async (dollar: Host<Noun>, e: Events['prompt.submit']) => answered(await hook('prompt.submit').handler(dollar, e, through)),
  }
}

// declare_wait's hook over these declarations: the tool's input called with no hook beneath.
function declaring(declarations: Declarations) {
  const hooks = capture((on: On<Host<Noun>>) => registerWait(on, declarations))
  const hook = hookOf(hooks, 'tool.call', { tool: `mcp__orchestrator__${WAIT_TOOL}` })
  return async (dollar: Host<Noun>, input: Readonly<Record<string, unknown>>) =>
    answered(await hook.handler(dollar, { tool: `mcp__orchestrator__${WAIT_TOOL}`, ...input }, async () => { throw new Error('declare_wait calls nothing beneath') }))
}

test('the turn end leaves the line for the next prompt\'s context, once, and on the session\'s row', async () => {
  const { dollar, files } = world()
  const handlers = mounted()
  await handlers['turn.complete'](dollar, { reason: 'answer', answer: 'x' })
  const published = JSON.parse(files.get(`${MODULE}/store/sessions/s-orch`) ?? '{}').unattended
  expect(published.prs.map((u: { pr: number }) => u.pr)).toEqual([8, 9])
  expect(published.line).toContain('En anomalie : acme/app#8')
  const first = await handlers['prompt.submit'](dollar, { text: 'go', context: ['before'] })
  expect(first.context).toEqual(['before', published.line])
  const second = await handlers['prompt.submit'](dollar, { text: 'go' })
  expect(second.context).toBe(undefined)
})

test('a line already said at the previous turn end is not said again, until it changes or goes away', async () => {
  const { dollar } = world()
  const handlers = mounted()
  const said = async (target: Host<Noun>) => {
    await handlers['turn.complete'](target, { reason: 'answer' })
    return (await handlers['prompt.submit'](target, { text: 'go' })).context
  }
  expect((await said(dollar))?.[0]).toContain('En anomalie : acme/app#8')
  // The same reading at the next wakes: nothing is added to the prompt.
  expect(await said(dollar)).toBe(undefined)
  expect(await said(dollar)).toBe(undefined)
  // One more pull request left unattended: the line is said again, whole.
  const { dollar: more } = world({ forge: { 'acme/app': JSON.stringify([7, 8, 6, 9, 10, 11].map(n => ({ number: n, createdAt: '2026-11-11T08:00:00Z' }))) }, extra: [ELEVEN] })
  expect((await said(more))?.[0]).toContain('acme/app#11')
  // Nothing unattended any more, then the same line back: said again, it is news.
  const { dollar: quiet } = world({ forge: { 'acme/app': JSON.stringify([{ number: 7 }, { number: 6 }]) } })
  expect(await said(quiet)).toBe(undefined)
  expect((await said(dollar))?.[0]).toContain('En anomalie : acme/app#8')
})

test('a changed line is said without the lines that did not change: the ready rows alone when the pull requests are as they were', async () => {
  const { dollar, files } = world()
  const handlers = mounted()
  const turn = async () => {
    await handlers['turn.complete'](dollar, { reason: 'answer' })
    return (await handlers['prompt.submit'](dollar, { text: 'go' })).context
  }
  expect((await turn())?.length).toBe(1)
  files.set(RECORD, `${files.get(RECORD)}${JSON.stringify(READY_ROWS[0])}\n`)
  expect(await turn()).toEqual(['Lignes prêtes sans agent : 21 IDLEWORK'])
})

test('a line no prompt has said yet is kept across turn ends, while it still holds, beside what changed since', async () => {
  const { dollar, files } = world()
  const handlers = mounted()
  await handlers['turn.complete'](dollar, { reason: 'answer' })
  // Nothing was said between: a ready row appears, and the unattended line still waits for its prompt.
  files.set(RECORD, `${files.get(RECORD)}${JSON.stringify(READY_ROWS[0])}\n`)
  await handlers['turn.complete'](dollar, { reason: 'answer' })
  const said = (await handlers['prompt.submit'](dollar, { text: 'go' })).context
  expect(said?.length).toBe(2)
  expect(said?.[0]).toContain('En anomalie : acme/app#8')
  expect(said?.[1]).toBe('Lignes prêtes sans agent : 21 IDLEWORK')
  // A line that stopped holding before its prompt is not said.
  const { dollar: quiet } = world({ forge: { 'acme/app': JSON.stringify([{ number: 7 }, { number: 6 }]) } })
  await handlers['turn.complete'](dollar, { reason: 'answer' })
  await handlers['turn.complete'](quiet, { reason: 'answer' })
  expect((await handlers['prompt.submit'](quiet, { text: 'go' })).context).toBe(undefined)
})

test('a line owed by a turn end whose prompt has not come yet is dropped by the quiet turn end that follows', async () => {
  const handlers = mounted()
  const { dollar: owing } = world()
  const { dollar: quiet } = world({ forge: { 'acme/app': JSON.stringify([{ number: 7 }, { number: 6 }]) } })
  // The memory is shared by the file's tests: a prompt empties whatever an earlier one left owed.
  await handlers['prompt.submit'](owing, { text: 'first' })
  // A turn end leaves its line owed, no prompt is submitted, then a quiet turn end: the line stopped holding.
  await handlers['turn.complete'](owing, { reason: 'answer' })
  await handlers['turn.complete'](quiet, { reason: 'answer' })
  expect((await handlers['prompt.submit'](quiet, { text: 'go' })).context).toBe(undefined)
})

test('a turn end with nothing unattended leaves no line', async () => {
  const { dollar } = world({ forge: { 'acme/app': JSON.stringify([{ number: 7 }, { number: 6 }]) } })
  const handlers = mounted()
  await handlers['turn.complete'](dollar, { reason: 'answer' })
  expect((await handlers['prompt.submit'](dollar, { text: 'go' })).context).toBe(undefined)
  // A subagent's turn end reads nothing.
  const { dollar: quiet, runs } = world()
  await handlers['turn.complete'](quiet, { agentId: 'a-1' })
  expect(runs).toEqual([])
})

test('declare_wait refuses done and deferred while a pull request is unattended, naming it, and takes every other kind', async () => {
  const declarations = new Declarations()
  const declare = declaring(declarations)
  const { dollar } = world()
  const done = await declare(dollar, { kind: 'done' })
  expect(done.isError).toBe(true)
  expect(done.result).toContain('Not done: En anomalie : acme/app#8')
  expect(done.result).toContain('acme/app#9')
  expect(declarations.current()).toBe(null)
  expect((await declare(dollar, { kind: 'deferred', blocks: '1 items' })).isError).toBe(true)
  // An operator wait waits on a question the session asked with `ask` (question.ts).
  await dollar.fs.write(`${MODULE}/round/q-s-orch-1.json`, JSON.stringify({
    v: 2, id: 'q-s-orch-1', sender: { session: 's-orch', name: 'Orch: app', role: 'orchestrator', machine: 'box-1' },
    subject: 'the merge', context: 'what is known', ask: 'Merge it?', choices: [], recommended: null, why: null,
    blocks: 'the merge', status: 'open', at: '2026-11-14T10:00:00Z', answer: null, seq: 1,
  }))
  const asked = await declare(dollar, { kind: 'operator', blocks: 'the merge' })
  expect(asked.isError).toBe(undefined)
  expect(declarations.current()?.kind).toBe('operator')
  // The record's own row closed: an open one holds a done by itself (wait.ts holdsRecord).
  const closed = (files: Map<string, string>) => files.set(RECORD, (files.get(RECORD) ?? '').replace('"state":"open"', '"state":"closed"'))
  const { dollar: clear, files: clearFiles } = world({ forge: { 'acme/app': JSON.stringify([{ number: 7 }]) } })
  closed(clearFiles)
  expect((await declare(clear, { kind: 'done' })).isError).toBe(undefined)
  expect(declarations.current()?.kind).toBe('done')
  // A forge that cannot be read holds nothing: the refusal is for a pull request known unattended.
  const { dollar: unread, files: unreadFiles } = world({ forge: { 'acme/app': null } })
  closed(unreadFiles)
  expect((await declare(unread, { kind: 'done' })).isError).toBe(undefined)
  expect(unattendedRefusal('En anomalie : x#1 (sans agent depuis ?)')).toContain('dispatch-record.sh pr <record>')
})

test('declare_wait takes a done from a session that handed over: the unattended pull requests are its successor\'s', async () => {
  const declarations = new Declarations()
  const declare = declaring(declarations)
  const { dollar } = world()
  expect((await declare(dollar, { kind: 'done' })).isError).toBe(true)
  declarations.handOver('another-session')
  expect((await declare(dollar, { kind: 'done' })).isError).toBe(true)
  declarations.handOver('s-orch')
  expect((await declare(dollar, { kind: 'done' })).isError).toBe(undefined)
  expect(declarations.current()?.kind).toBe('done')
})

test('the helpers every reader of a registered record shares: a session id made a file name, a read that gives "" for a file that is not there', async () => {
  expect(safe('a b/c:d.e-f_g')).toBe('a_b_c_d.e-f_g')
  const $ = hostOf({ fs: { read: async (p: string) => { if (p !== '/there') throw new Error('ENOENT'); return 'text' } } })
  expect(await readOr($, '/there')).toBe('text')
  expect(await readOr($, '/gone')).toBe('')
})
