// hooks/tests/audit.test.ts
// The audit trail the hooks module writes: each handler lets the chain decide, then writes what it
// answered into the orchestrator's journal — a guard's refusal by its code, a review verdict with
// the decision on each finding, a pull request opened or merged, a declared wait from the turn's
// end to the next turn's start — as events core's reader takes, holding no point, reason, title,
// body or command; a journal that cannot be written changes no answer.
import { expect, test } from 'claude-code/testing'
import { register, refusalCode, STOP_GATE_CODE } from '../audit.ts'
import { PULL_URL } from '../audit-events.ts'
import { guardFallback, killDecision } from '../guards.ts'
import { MODE_DIALOG_DENY } from '../mode-dialog.ts'
import { MODELS_DENY } from '../models-guard.ts'
import { QUESTION_BY_MESSAGE } from '../one-question.ts'
import { unnamedReport } from '../relay.ts'
import { NOT_ORCHESTRATOR } from '../review.ts'
import { Declarations } from '../wait.ts'
import { parseJournalEvent } from '../../core/learning.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/h'
const JOURNAL = `${HOME}/.claude/orchestrator/journal/`
const HEAD = 'a'.repeat(40)
const AT = '2026-11-14T10:15:00Z'
const ok = { exitCode: 0, stdout: '', stderr: '' }

function fake(options: { broken?: boolean; name?: string } = {}) {
  const files: Record<string, string> = {}
  const logged: string[] = []
  const order: string[] = []
  if (options.name) files[`${HOME}/.claude/claude-orchestrator/store/sessions/sess-1`] = JSON.stringify({ name: options.name, updated_at: AT })
  const dollar = {
    plugin: { root: '/plugins/orch-root' },
    env: { get: async (key: string) => ({ HOME } as Record<string, string>)[key] },
    session: { id: async () => 'sess-1' },
    clock: { sleep: async () => undefined },
    fs: {
      write: async (path: string, text: string) => { if (options.broken) throw new Error('disk full'); files[path] = text },
      read: async (path: string) => { if (path in files) return files[path]; throw new Error(`ENOENT: ${path}`) },
      list: async (dir: string) => Object.keys(files).filter(p => p.startsWith(`${dir}/`)).map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 0, isLink: false })),
      stat: async (path: string) => { throw new Error(`ENOENT: ${path}`) },
      exists: async (path: string) => path in files,
    },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf([...argv])
        if (line !== null) logged.push(line)
        else if (argv[0] === 'mv') { files[argv[3]!] = files[argv[2]!]!; delete files[argv[2]!]; order.push(argv[3]!) }
        else if (argv[0] === 'rm') for (const path of argv.slice(2)) delete files[path]
        return ok
      },
    },
  }
  // The journal's events in the order they were written: two of one second sort by their random part.
  const journal = () => order.filter(p => p.startsWith(JOURNAL) && p in files).map(p => JSON.parse(files[p]!))
  return { dollar, files, logged, journal }
}

// The handlers registered, by event, over a declarations memory the test drives.
function mounted() {
  const declarations = new Declarations()
  const handlers: Record<string, Function> = {}
  register(((...args: unknown[]) => {
    handlers[String(args[0])] = args[args.length - 1] as Function
    return { catch: () => undefined }
  }) as never, declarations, () => new Date('2026-11-14T10:15:00.400Z'))
  return { declarations, on: (event: string, dollar: unknown, e: object, answer: unknown = undefined) => handlers[event]!(dollar, e, async () => answer) }
}

const codes = (events: Record<string, any>[]) => events.map(e => [e.kind, e.source.code])

test('each refusal of the module\'s guards has its stable code; any other answer has none', () => {
  const cases: [unknown, string | null][] = [
    [killDecision('1', 'pkill -f agent'), 'orchestrator.kill.pattern'],
    [guardFallback(undefined, 'killall node', 'no environment'), 'orchestrator.kill.unread-mark'],
    [{ deny: QUESTION_BY_MESSAGE }, 'orchestrator.message.question-to-coordinator'],
    [{ deny: unnamedReport(5123) }, 'orchestrator.message.report-unnamed'],
    [{ deny: MODELS_DENY }, 'orchestrator.models.map-write'],
    [{ deny: MODE_DIALOG_DENY }, 'orchestrator.mode.dialog'],
    [{ deny: 'github: refused by another plugin' }, null],
    [{ result: 'fine' }, null],
    [undefined, null],
  ]
  for (const [answer, code] of cases) expect(refusalCode('Bash', answer)).toBe(code)
  expect(refusalCode('mcp__orchestrator__review', { result: NOT_ORCHESTRATOR, isError: true })).toBe('orchestrator.review.not-orchestrator')
  expect(refusalCode('mcp__orchestrator__review', { result: 'verdict is pass, fail or accepted', isError: true })).toBe(null)
})

test('a guard\'s refusal is written once, as a version 1 refusal, and the refusal is the answer still', async () => {
  const fx = fake({ name: 'Agent: belt' })
  const m = mounted()
  const refusal = killDecision('1', 'pkill -f agent')
  expect(await m.on('tool.call', fx.dollar, { tool: 'Bash', command: 'pkill -f agent' }, refusal)).toEqual(refusal)
  const [event] = fx.journal()
  expect(fx.journal().length).toBe(1)
  expect(event).toEqual({
    v: 1, id: event.id, at: AT, kind: 'refusal', source: { plugin: 'orchestrator', code: 'orchestrator.kill.pattern' },
    subject: { repo: null, pr: null, head: null }, context: { role: 'agent', mode: null, paths: [], languages: [], session: 'sess-1' },
    evidence: [{ type: 'refusal', code: 'orchestrator.kill.pattern' }], trust: 'computed',
  })
  expect(parseJournalEvent(event)).toEqual(event)
  expect(JSON.stringify(fx.journal()).includes('pkill')).toBe(false)
})

test('a held stop is the stop gate\'s refusal; a stop let through writes nothing', async () => {
  const fx = fake()
  const m = mounted()
  await m.on('classic.Stop', fx.dollar, {}, undefined)
  expect(fx.journal()).toEqual([])
  expect(await m.on('classic.Stop', fx.dollar, {}, { block: 'waiting on nothing' })).toEqual({ block: 'waiting on nothing' })
  expect(codes(fx.journal())).toEqual([['refusal', STOP_GATE_CODE]])
})

const WRITTEN = `${HOME}/.claude/pr-records/acme/thing/${HEAD}/review-1.json\ngithub: Not Ready`
const FAIL = {
  tool: 'mcp__orchestrator__review', pr: 12, repo: 'Acme/Thing', verdict: 'fail', detail: 'the secret detail',
  kept: [{ point: 'the secret point', file: 'src/a.ts', line: 3, severity: 'critical' }, { point: 'a point, no file' }],
  set_asides: [{ point: 'naming', reason: 'the secret reason', file: 'src/b c.ts', severity: 'minor' }],
}

test('a fail is the review with its counts and the decision on each finding, pointing at its record, never its words', async () => {
  const fx = fake({ name: 'Orch: belt' })
  const m = mounted()
  expect(await m.on('tool.call', fx.dollar, FAIL, { result: WRITTEN })).toEqual({ result: WRITTEN })
  const events = fx.journal()
  const subject = { repo: 'acme/thing', pr: 12, head: HEAD }
  const evidence = [{ type: 'record', path: `pr-records/acme/thing/${HEAD}/review-1.json` }]
  expect(events.map(e => [e.v, e.kind, e.fact, e.subject, e.evidence, e.context.role])).toEqual([
    [2, 'review', { verdict: 'fail', kept: 2, set_aside: 1 }, subject, evidence, 'orchestrator'],
    [2, 'decision', { decision: 'kept', severity: 'critical', file: 'src/a.ts', line: 3 }, subject, evidence, 'orchestrator'],
    [2, 'decision', { decision: 'kept', severity: null, file: null, line: null }, subject, evidence, 'orchestrator'],
    [2, 'decision', { decision: 'set-aside', severity: 'minor', file: null, line: null }, subject, evidence, 'orchestrator'],
  ])
  for (const event of events) expect(parseJournalEvent(event)).toEqual(event)
  expect(JSON.stringify(events).includes('secret')).toBe(false)
})

test('an acceptance over a failed review is the verdict overridden, the method\'s failure', async () => {
  const fx = fake()
  const m = mounted()
  await m.on('tool.call', fx.dollar, { tool: 'mcp__orchestrator__review', pr: 12, verdict: 'accepted', set_asides: [{ point: 'x', reason: 'y' }] }, { result: WRITTEN })
  expect(codes(fx.journal())).toEqual([['review', 'orchestrator.review.verdict'], ['decision', 'orchestrator.review.decision'], ['failure', 'orchestrator.review.overridden']])
  expect(fx.journal()[2].fact).toEqual({ failure: 'verdict-overridden', count: null, prs: [] })
})

test('a verdict refused, an error, or a check plan writes no review', async () => {
  const fx = fake()
  const m = mounted()
  await m.on('tool.call', fx.dollar, FAIL, { result: 'github: refused', isError: true })
  await m.on('tool.call', fx.dollar, FAIL, { deny: 'github: no' })
  await m.on('tool.call', fx.dollar, { tool: 'mcp__orchestrator__review', pr: 12, plan: { e2e: 'none' } }, { result: 'plan written' })
  expect(fx.journal()).toEqual([])
})

test('a pull request opened ends its implementation and is linked to the session; a fix naming others is the method\'s failure', async () => {
  const fx = fake()
  const m = mounted()
  const created = { result: '{"number": 181, "html_url": "https://github.com/Acme/widgets/pull/181"}' }
  const call = { tool: 'mcp__github__gh', command: 'pr-create', args: { title: 'fix(github): the gate reads the latest run', body: 'Fixes what widgets#180 broke; see widgets#181.' } }
  expect(await m.on('tool.call', fx.dollar, call, created)).toEqual(created)
  const subject = { repo: 'acme/widgets', pr: 181, head: null }
  expect(fx.journal().map(e => [e.kind, e.fact, e.subject])).toEqual([
    ['step', { step: 'implement', edge: 'end', record: null, row: null, result: null }, subject],
    ['link', { record: null, row: null, session: 'sess-1', goal: null, prs: [] }, subject],
    ['failure', { failure: 'fix-after-merge', count: null, prs: ['widgets#180'] }, subject],
  ])
  expect(JSON.stringify(fx.journal()).includes('latest run')).toBe(false)
})

test('a feature names no failure, a merge is the merge step, and a call that failed writes nothing', async () => {
  const fx = fake()
  const m = mounted()
  await m.on('tool.call', fx.dollar, { tool: 'mcp__github__gh', command: 'pr-create', args: { title: 'feat(x): y, after widgets#180' } },
    { result: 'https://github.com/o/n/pull/9' })
  await m.on('tool.call', fx.dollar, { tool: 'mcp__github__gh', command: 'pr-merge', repo: 'o/n', args: { pr: 9 } }, { result: '{"merged": true}' })
  await m.on('tool.call', fx.dollar, { tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 10 } }, { result: 'HTTP 405', isError: true })
  await m.on('tool.call', fx.dollar, { tool: 'mcp__github__gh', command: 'pr-list', args: {} }, { result: 'https://github.com/o/n/pull/9' })
  expect(fx.journal().map(e => [e.kind, e.fact.step ?? null, e.subject.pr])).toEqual([['step', 'implement', 9], ['link', null, 9], ['step', 'merge', 9]])
})

test('a declared wait starts when its turn ends and ends when the next starts, both halves sharing the start\'s id', async () => {
  const fx = fake({ name: 'Orch: belt' })
  const m = mounted()
  m.declarations.turnStarted()
  m.declarations.declare({ kind: 'operator', blocks: 'the merge', question: '**Question 1 of 1** secret', consent: { kind: 'e2e-waiver', repo: 'acme/thing', pr: 12 } })
  await m.on('turn.complete', fx.dollar, {}, { text: 'done' })
  await m.on('turn.complete', fx.dollar, { agentId: 'a1' }, { text: 'a subagent' })
  await m.on('turn.start', fx.dollar, { agentId: 'a1' })
  await m.on('turn.start', fx.dollar, {})
  const [start, end] = fx.journal()
  expect(fx.journal().length).toBe(2)
  expect([start.fact, end.fact]).toEqual([
    { wait: 'operator', edge: 'start', span: null, on: 'operator' },
    { wait: 'operator', edge: 'end', span: start.id, on: 'operator' },
  ])
  expect(start.subject).toEqual({ repo: 'acme/thing', pr: 12, head: null })
  expect(JSON.stringify(fx.journal()).includes('secret') || JSON.stringify(fx.journal()).includes('the merge')).toBe(false)
  for (const event of fx.journal()) expect(parseJournalEvent(event)).toEqual(event)
})

test('a turn that declared nothing starts no wait; the session\'s end ends the one pending', async () => {
  const fx = fake()
  const m = mounted()
  m.declarations.turnStarted()
  await m.on('turn.complete', fx.dollar, {}, {})
  expect(fx.journal()).toEqual([])
  m.declarations.declare({ kind: 'tool', blocks: 'ci-watch.sh 12' })
  await m.on('turn.complete', fx.dollar, {}, {})
  await m.on('session.end', fx.dollar, { sessionId: 'sess-1' })
  expect(fx.journal().map(e => [e.fact.wait, e.fact.edge, e.fact.on])).toEqual([['tool', 'start', 'tool'], ['tool', 'end', 'tool']])
})

test('a journal that cannot be written is one line in the log, and the answer stands', async () => {
  const fx = fake({ broken: true })
  const m = mounted()
  expect(await m.on('tool.call', fx.dollar, { tool: 'Bash' }, { deny: MODELS_DENY })).toEqual({ deny: MODELS_DENY })
  expect(fx.logged.length).toBe(1)
  expect(fx.logged[0]).toContain('| audit | the journal could not be written: disk full')
})

test('a call nothing in the module watches writes nothing and is answered as the chain answered', async () => {
  const fx = fake()
  const m = mounted()
  expect(await m.on('tool.call', fx.dollar, { tool: 'Read', file_path: '/x' }, { result: 'text' })).toEqual({ result: 'text' })
  expect(fx.journal()).toEqual([])
})

test('the pull request address every reader of an answer shares: the repository and the number of the first one', () => {
  expect(PULL_URL.exec('see https://github.com/Acme/app.x/pull/12 and https://github.com/a/b/pull/3')?.slice(1)).toEqual(['Acme/app.x', '12'])
  expect(PULL_URL.exec('https://github.com/a/b/pull/0')).toBe(null)
})
