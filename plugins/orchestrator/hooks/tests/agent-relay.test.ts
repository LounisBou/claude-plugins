// hooks/tests/agent-relay.test.ts
// An agent's end of turn and its gate crossing, reported by the module to its
// orchestrator (relay.ts, wired in supervision.ts): the status line parsed, one message
// per distinct state, none twice, the orchestrator found in the launcher's chain and never
// in the turn's text, the gate sent once per crossing, nothing from a session that is no
// agent, and a send that fails logged without holding the turn.
import { expect, test } from 'claude-code/testing'
import { DECLARATIONS } from '../wait.ts'
import { parseStatus, relayText, gateText, noStatusText, NO_STATUS_KEY, hostStopOf, stopInTail, stopText, chainOwnerTty, RELAY_CAP, heldReport, readDeliveryFacts, keptCi, factsLine, falseClaims, type DeliveryFacts, type FactsRun, type KeptGate } from '../relay.ts'
import { VERDICT_LIMIT } from '../../core/verdict.ts'
import { register } from '../register.ts'
import { logLineOf, lockRun } from './fakes.ts'
import { capture, hooksOn, hostOf, type Captured, type HostParts } from '../../core/capture.ts'
import { fieldsOf, type Events, type Host, type Noun } from '../../core/host.ts'

const HOME = '/tmp/h'
const STATE = `${HOME}/.claude/claude-orchestrator`
const ROW = `${STATE}/store/sessions/s-one`
const WAIT = `${STATE}/store/waits/s-one`
const GATE = `${STATE}/store/gates/s-one`
const AGENT = 'Agent: belt-p3'
const ORCH = 'Orch: belt'
const REPLY = `reply with SendMessage to: ${AGENT}`

// --- the pure half ------------------------------------------------------------------------

test('the status line parses into the agent state, the text above it carried', () => {
  expect(parseStatus('Merge first or rebase?\n\nstatus: question — merge order')).toEqual({ kind: 'question', blocks: 'merge order', question: 'Merge first or rebase?' })
  expect(parseStatus('PR #12, head abc, 40/40.\n**status: done — PR #12**')).toEqual({ kind: 'delivered', blocks: 'PR #12', question: 'PR #12, head abc, 40/40.' })
  expect(parseStatus('status: blocked - the fixture is missing')).toEqual({ kind: 'blocked', blocks: 'the fixture is missing', question: '' })
  expect(parseStatus('status: done')).toEqual({ kind: 'delivered', blocks: '', question: '' })
  expect(parseStatus('waiting: operator — blocks: phase 3')).toBeNull()
  expect(parseStatus('status: doneish')).toBeNull()
  expect(parseStatus('I keep working.')).toBeNull()
})

test('the messages: a header, the reply address, then the text cut past the cap', () => {
  expect(relayText(AGENT, { kind: 'question', blocks: 'merge order', question: 'Merge first?' }, 'T'))
    .toBe(`[module] ${AGENT} asks — merge order\n${REPLY}\n\nMerge first?`)
  expect(relayText(AGENT, { kind: 'blocked', blocks: 'no fixture', question: '' }, 'T')).toBe(`[module] ${AGENT} is blocked — no fixture\n${REPLY}`)
  expect(relayText(AGENT, { kind: 'delivered', blocks: 'PR #12', question: 'head abc' }, 'T', '120,000 (12%)'))
    .toBe(`[module] ${AGENT} reports its delivery; verify on the artifact — context 120,000 (12%) — PR #12\n${REPLY}\n\nhead abc`)
  // A wait on background work carries its status line alone: the text above it is the agent's
  // acknowledgment, which the orchestrator acts on nowhere (measured: half the relayed text).
  expect(relayText(AGENT, { kind: 'waiting', blocks: '3 review lenses', question: 'Lenses running, I touch nothing.' }, 'T'))
    .toBe(`[module] ${AGENT} waits on its background work — 3 review lenses\n${REPLY}`)
  // A bare `status: waiting` names nothing: its text is the only word of what it watches.
  expect(relayText(AGENT, { kind: 'waiting', blocks: '', question: 'CI of #12 running.' }, 'T'))
    .toBe(`[module] ${AGENT} waits on its background work\n${REPLY}\n\nCI of #12 running.`)
  const long = relayText(AGENT, { kind: 'question', blocks: '', question: 'x'.repeat(RELAY_CAP + 5) }, 'T')
  expect(long).toContain(`[cut at ${RELAY_CAP} of ${RELAY_CAP + 5} characters]`)
  expect(gateText(AGENT, 312000, 31)).toBe(`[module] ${AGENT} context 312,000 (31%) — at the gate`)
  // Never an order.
  for (const text of [long, gateText(AGENT, 1, 1), relayText(AGENT, { kind: 'delivered', blocks: '', question: '' }, 'T')]) {
    expect(/\b(approve|merge it|undraft|stand down)\b/i.test(text)).toBe(false)
  }
})

// --- the facts of a delivery -------------------------------------------------------------

const SHA = 'abcdef0123456789abcdef0123456789abcdef01'
const OTHER = '9999999123456789abcdef0123456789abcdef01'
// The gate's answer at a head, as github's `pr-gate --json` gives it and ci-watch keeps it (only what the facts read).
const gateOf = (head: string, result: string) => JSON.stringify({ head, ci: { result, failed: [], running: 0, total: 7 } })
// The pull request as gh reads it: its number, head and URL, which names its repository.
const URL = 'https://github.com/owner/app/pull/12'
const viewOf = (head: string, url = URL) => JSON.stringify({ number: 12, headRefOid: head, url })
// Where ci-watch keeps the gate's last answer for owner/app#12 (core's ciGatePath).
const KEPT = `${STATE}/ci-gate/owner_app-pr12.json`
// A kept reading for owner/app#12 alone, or none.
const keptOf = (text: string | null): KeptGate => async (repo, pr) => (repo === 'owner/app' && pr === 12 ? text : null)
const FACTS: DeliveryFacts = { dirty: 0, unpushed: 0, head: SHA, pr: { number: 12, head: SHA, ci: 'green' }, claimed: { pr: 12, head: 'abcdef0' } }

test('the facts line says each fact, and a false claim of delivery plainly, first', () => {
  expect(factsLine(FACTS)).toBe('facts (read by the module): tree clean, 0 unpushed, head abcdef0 = #12\'s head, CI green at abcdef0')
  expect(falseClaims(FACTS)).toEqual([])
  const wrong: DeliveryFacts = { dirty: 2, unpushed: 1, head: SHA, pr: { number: 12, head: OTHER, ci: 'pending' }, claimed: { pr: 12, head: '9999999' } }
  expect(factsLine(wrong)).toBe('facts (read by the module): FALSE CLAIM of delivery (tree dirty; commits unpushed; local head is not the pull request\'s; named head 9999999 is not the local head) — '
    + 'tree dirty (2 paths), 1 unpushed, head abcdef0 ≠ #12\'s head 9999999, CI pending at 9999999')
  expect(falseClaims({ ...FACTS, pr: { number: 13, head: SHA, ci: 'none' } })).toEqual(['#12 named, #13 read'])
  expect(factsLine({ dirty: null, unpushed: null, head: SHA, pr: null, claimed: null })).toBe('facts (read by the module): tree unread, unpushed unread, head abcdef0, pull request unread')
})

test('the facts are read from git in the checkout, gh on the pull request the verdict line names, and the gate reading ci-watch kept', async () => {
  const calls: string[] = []
  const answers: Record<string, string> = {
    'git status --porcelain': ' M a.ts\n?? b.ts\n',
    'git rev-parse HEAD': `${SHA}\n`,
    'git rev-list --count HEAD --not --remotes': '0\n',
    'gh pr view 12 --json number,headRefOid,url': viewOf(SHA),
  }
  const run: FactsRun = async argv => {
    calls.push(argv.join(' '))
    const out = answers[argv.join(' ')]
    return out === undefined ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: out }
  }
  const facts = await readDeliveryFacts(run, `Done.\nowner/app#12 abcdef0 — gate green — blocking: none — report: /r.md\nstatus: done — PR`, keptOf(gateOf(SHA, 'SUCCESS')))
  expect(facts).toEqual({ dirty: 2, unpushed: 0, head: SHA, pr: { number: 12, head: SHA, ci: 'green' }, claimed: { pr: 12, head: 'abcdef0' } })
  // Four reads and no more: no process is run for CI.
  expect(calls.length).toBe(4)
  // No verdict line: gh reads the branch's pull request; a run that throws is unread.
  calls.length = 0
  const bare = await readDeliveryFacts(async argv => { if (argv[0] === 'gh') throw new Error('no gh'); return run(argv) }, 'status: done', keptOf(null))
  expect(bare.pr).toBeNull()
  expect(bare.claimed).toBeNull()
  expect(calls.includes('gh pr view --json number,headRefOid,url')).toBe(false)
  expect((await readDeliveryFacts(async () => ({ exitCode: 0, stdout: 'not json' }), 'status: done', keptOf(null))).pr).toBeNull()
})

// The facts line's CI is the github gate's reading (latest run of each check), never a reduction of
// the head's rollup: geonative-api#1868 at 4a41f0a held four failed `wip-check` runs of a draft
// guard beside the passing runs of the re-triggered workflow, and read « CI failing » where the
// gate read SUCCESS. The rollup below is that shape; gh is asked for none of it.
const REPORT = 'Done.\nowner/app#12 abcdef0 — gate green — blocking: none — report: /r.md\nstatus: done — PR'
const STALE_ROLLUP = [
  { workflowName: 'Application', name: 'wip-check / wip-check', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/a/actions/runs/44148519423/job/1' },
  { workflowName: 'Application', name: 'wip-check / wip-check', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/a/actions/runs/44148718394/job/2' },
  { workflowName: 'Application', name: 'build', conclusion: 'CANCELLED', detailsUrl: 'https://github.com/o/a/actions/runs/44148519423/job/3' },
]

const factsWith = async (kept: string | null | 'throws', report = REPORT) => {
  const asked: string[] = []
  const run: FactsRun = async a => {
    asked.push(a.join(' '))
    if (a[0] === 'gh') return { exitCode: 0, stdout: JSON.stringify({ number: 12, headRefOid: SHA, url: URL, statusCheckRollup: STALE_ROLLUP }) }
    return { exitCode: 0, stdout: a[1] === 'status' ? '' : a[1] === 'rev-parse' ? SHA : '0\n' }
  }
  const reader: KeptGate = kept === 'throws' ? async () => { throw new Error('EACCES: permission denied') } : keptOf(kept)
  return { facts: await readDeliveryFacts(run, report, reader), asked }
}

test("the facts line's CI is the gate's reading: an older failed or cancelled run of a re-triggered workflow does not make it failing", async () => {
  const { facts, asked } = await factsWith(gateOf(SHA, 'SUCCESS'))
  expect(facts.pr).toEqual({ number: 12, head: SHA, ci: 'green' })
  expect(factsLine(facts)).toContain(', CI green at abcdef0')
  expect(asked.filter(a => a.startsWith('gh'))).toEqual(['gh pr view 12 --json number,headRefOid,url'])
})

test("the gate's other results stay what the gate says: a failing latest run fails, a rerun going is pending, no CI is none", async () => {
  for (const [result, ci] of [['FAILURE', 'failing'], ['PENDING', 'pending'], ['NONE', 'none'], ['SUCCESS', 'green']] as const) {
    expect((await factsWith(gateOf(SHA, result))).facts.pr?.ci, result).toBe(ci)
  }
})

// No reading kept at the head says CI is unread, with the reason: never the head's rollup reduced again.
test('no reading kept, a reading of another head or one that cannot be read says CI unread with why, never a rollup reading', async () => {
  const unread = async (kept: Parameters<typeof factsWith>[0]) => (await factsWith(kept)).facts.pr
  expect(await unread(null)).toEqual({ number: 12, head: SHA, ci: 'unread', ciWhy: 'no gate reading at abcdef0 yet' })
  expect(await unread('throws')).toMatchObject({ ci: 'unread', ciWhy: 'the gate reading could not be read: EACCES: permission denied' })
  expect(await unread('not json')).toMatchObject({ ci: 'unread', ciWhy: 'the gate reading kept is no JSON' })
  expect(await unread('null')).toMatchObject({ ci: 'unread', ciWhy: 'the gate reading kept names no head' })
  expect(await unread(JSON.stringify({ ci: { result: 'SUCCESS' } }))).toMatchObject({ ci: 'unread', ciWhy: 'the gate reading kept names no head' })
  expect(await unread(JSON.stringify({ head: SHA, ci: {} }))).toMatchObject({ ci: 'unread', ciWhy: 'the gate reading kept has no CI result' })
  expect(await unread(JSON.stringify({ head: SHA, ci: { result: 'constructor' } }))).toMatchObject({ ci: 'unread', ciWhy: 'the gate reading kept has no CI result' })
  expect(await unread(gateOf(OTHER, 'SUCCESS'))).toMatchObject({ ci: 'unread', ciWhy: 'the last gate reading is of head 9999999, not abcdef0' })
  expect(factsLine((await factsWith(null)).facts)).toBe("facts (read by the module): tree clean, 0 unpushed, head abcdef0 = #12's head, CI unread (no gate reading at abcdef0 yet) at abcdef0")
  expect(keptCi(gateOf(SHA.toUpperCase(), 'SUCCESS'), SHA)).toEqual({ ci: 'green' })
})

// The gate is read from what ci-watch kept, for whichever pull request gh read: the verdict line's, or the branch's.
test('a report that names no pull request reads the kept reading of the branch\'s pull request', async () => {
  const { facts, asked } = await factsWith(gateOf(SHA, 'PENDING'), 'status: done')
  expect(facts.pr).toEqual({ number: 12, head: SHA, ci: 'pending' })
  expect(asked.filter(a => a.startsWith('gh'))).toEqual(['gh pr view --json number,headRefOid,url'])
})

// A pull request gh did not read has no head to hold the reading against: CI is unread, said beside it; a view
// with no URL names no repository to find the reading under.
test('a pull request gh failed to read, or one whose repository is unread, still gives the line a CI word', async () => {
  const ran = (view: { exitCode: number; stdout?: unknown }) => readDeliveryFacts(async argv => {
    if (argv[0] === 'gh') return view
    return { exitCode: 0, stdout: argv[1] === 'status' ? '' : argv[1] === 'rev-parse' ? SHA : '0\n' }
  }, REPORT, keptOf(gateOf(SHA, 'SUCCESS')))
  const noView = await ran({ exitCode: 1, stdout: '' })
  expect(noView.pr).toBeNull()
  expect(factsLine(noView)).toBe('facts (read by the module): tree clean, 0 unpushed, head abcdef0, pull request unread, CI unread (the pull request was not read)')
  // A view that is no pull request reads the same way.
  expect((await ran({ exitCode: 0, stdout: 'not json' })).ciWhy).toBe('the pull request was not read')
  const noUrl = await ran({ exitCode: 0, stdout: JSON.stringify({ number: 12, headRefOid: SHA }) })
  expect(noUrl.pr).toEqual({ number: 12, head: SHA, ci: 'unread', ciWhy: 'the pull request\'s repository was not read' })
})

// Seen 2026-11-17 (claude-plugins#473): the relay ran `pr-gate` itself at the turn's end, on the
// 4.3 s its 5 s bound left; the gate makes five or so GitHub reads and was cut. CI now comes from
// the reading ci-watch kept, and the relay runs no process for it.
test('a delivery says CI as the gate reading ci-watch kept has it, and runs no process for CI', async () => {
  const report = 'All green.\nowner/app#12 abcdef0 — gate green — blocking: none — report: /r.md\nstatus: done — PR #12'
  const repo = { 'git status --porcelain': '', 'git rev-parse HEAD': SHA, 'git rev-list --count': '0', 'gh pr view': viewOf(SHA) }
  const failing = fake({ repo, kept: gateOf(SHA, 'FAILURE') })
  await drive(mounted(), 'turn.complete', failing.dollar, turnEnd(report))
  expect(failing.sent[0]!.text.split('\n')[1]).toContain('CI failing at abcdef0')
  expect(failing.ran.filter(argv => argv.startsWith('python3') || argv.includes('pr-gate') || argv.includes('pr checks'))).toEqual([])
  const none = fake({ repo })
  await drive(mounted(), 'turn.complete', none.dollar, turnEnd(report))
  expect(none.sent).toHaveLength(1)
  expect(none.sent[0]!.text.split('\n')[1]).toBe("facts (read by the module): tree clean, 0 unpushed, head abcdef0 = #12's head, CI unread (no gate reading at abcdef0 yet) at abcdef0")
})

// The gate names its repository lowercased, gh its URL as GitHub spells it: one file either way.
test("the kept reading is found under the pull request's repository whatever its case", async () => {
  const report = 'All green.\nowner/app#12 abcdef0 — gate green — blocking: none — report: /r.md\nstatus: done — PR #12'
  const repo = { 'git status --porcelain': '', 'git rev-parse HEAD': SHA, 'git rev-list --count': '0', 'gh pr view': viewOf(SHA, 'https://github.com/Owner/App/pull/12') }
  const found = fake({ repo, kept: gateOf(SHA, 'PENDING') })
  await drive(mounted(), 'turn.complete', found.dollar, turnEnd(report))
  expect(found.sent[0]!.text.split('\n')[1]).toContain('CI pending at abcdef0')
})

test('a delivery reaches the orchestrator with its facts read on the repository, a false claim said', async () => {
  const report = 'All green.\nowner/app#12 abcdef0 — gate green — blocking: none — report: /r.md\nstatus: done — PR #12'
  const clean = fake({ repo: { 'git status --porcelain': '', 'git rev-parse HEAD': SHA, 'git rev-list --count': '0', 'gh pr view': viewOf(SHA) }, kept: gateOf(SHA, 'SUCCESS') })
  await drive(mounted(), 'turn.complete', clean.dollar, turnEnd(report))
  expect(clean.sent[0]!.text.split('\n')[1]).toBe('facts (read by the module): tree clean, 0 unpushed, head abcdef0 = #12\'s head, CI green at abcdef0')
  const dirty = fake({ repo: { 'git status --porcelain': ' M a.ts\n', 'git rev-parse HEAD': SHA, 'git rev-list --count': '0', 'gh pr view': viewOf(OTHER) }, kept: gateOf(OTHER, 'SUCCESS') })
  await drive(mounted(), 'turn.complete', dirty.dollar, turnEnd(report))
  expect(dirty.sent[0]!.text.split('\n')[1]).toContain('FALSE CLAIM of delivery (tree dirty; local head is not the pull request\'s)')
  // A question carries no facts line: nothing is claimed delivered.
  const asks = fake({ repo: { 'git status --porcelain': ' M a.ts\n' } })
  await drive(mounted(), 'turn.complete', asks.dollar, turnEnd(QUESTION))
  expect(asks.sent[0]!.text.includes('facts')).toBe(false)
})

// Seen 2026-11-15 (review 395, row 259's delivery): the facts were read in the directory the
// module runs in (the host's configuration directory, head fbece9e, 1 dirty path), never the agent's checkout, and said
// FALSE CLAIM of two clean deliveries.
test("a delivery's facts are read in the agent's own checkout, not in the module's directory", async () => {
  const report = 'All green.\nowner/app#12 abcdef0 — gate green — blocking: none — report: /r.md\nstatus: done — PR #12'
  const clean = fake({
    checkout: '/w/takeoversense',
    kept: gateOf(SHA, 'SUCCESS'),
    repo: { 'git status --porcelain': '', 'git rev-parse HEAD': SHA, 'git rev-list --count': '0', 'gh pr view': viewOf(SHA) },
    elsewhere: { 'git status --porcelain': ' M settings.json\n', 'git rev-parse HEAD': OTHER, 'git rev-list --count': '0', 'gh pr view': viewOf(SHA) },
  })
  await drive(mounted(), 'turn.complete', clean.dollar, turnEnd(report))
  expect(clean.sent[0]!.text.split('\n')[1]).toBe('facts (read by the module): tree clean, 0 unpushed, head abcdef0 = #12\'s head, CI green at abcdef0')
  // A checkout the host names nowhere: no facts read elsewhere, said in the log.
  const unread = fake({ checkout: '', elsewhere: { 'git status --porcelain': ' M settings.json\n', 'git rev-parse HEAD': OTHER } })
  await drive(mounted(), 'turn.complete', unread.dollar, turnEnd(report))
  expect(unread.sent[0]!.text.includes('facts')).toBe(false)
  expect(unread.logged.some(line => line.includes('checkout is unread: its delivery goes without facts')), unread.logged.join(' | ')).toBe(true)
})

test('the owner is the chain naming the tty, the one written last when two do', () => {
  const entry = (tty: string) => JSON.stringify({ tab_id: 't', tty, owner: 'o' })
  const chains = [
    { name: 'ttys001.jsonl', mtimeMs: 10, text: entry('/dev/ttys005') },
    { name: 'ttys009.jsonl', mtimeMs: 20, text: entry('/dev/ttys005') },
    { name: 'ttys002.jsonl', mtimeMs: 30, text: entry('/dev/ttys006') },
  ]
  expect(chainOwnerTty(chains, '/dev/ttys005')).toBe('/dev/ttys009')
  expect(chainOwnerTty(chains, '/dev/ttys007')).toBeNull()
})

test('a chain whose owner is not live is not counted, however recently it was written', () => {
  const entry = (tty: string) => JSON.stringify({ tab_id: 't', tty, owner: 'o' })
  const chains = [
    { name: 'ttys001.jsonl', mtimeMs: 10, text: entry('/dev/ttys005') },
    { name: 'ttys020.jsonl', mtimeMs: 90, text: entry('/dev/ttys005') },
  ]
  const live = new Set(['/dev/ttys001'])
  expect(chainOwnerTty(chains, '/dev/ttys005', t => live.has(t))).toBe('/dev/ttys001')
  expect(chainOwnerTty(chains, '/dev/ttys005', () => false)).toBeNull()
  expect(chainOwnerTty(chains, '/dev/ttys005')).toBe('/dev/ttys020')
})

// --- the wiring over a faked $ ------------------------------------------------------------

// `walk` serves the process table of the agent's tab and of a headless run started from its
// shell, and writes no row, so the session under test is named by its own walk: `agent`,
// the agent's host process itself; `underneath`, the run — its id the one under test, the
// agent's record carrying another.
// `reportsTo`: the orchestrator the launch recorded. `alive`: the pids the process table lists,
// none read when absent. `registry`: the host's registry records of other sessions.
type Over = { kept?: string; repo?: Record<string, string>; elsewhere?: Record<string, string>; checkout?: string; name?: string; role?: string | null; chain?: boolean; send?: 'reject' | 'refuse'; gateTokens?: string; walk?: 'agent' | 'underneath'; reportsTo?: string; alive?: string[]; exiting?: string[]; registry?: { pid: string; sessionId: string; name: string; startedAt: number }[] }

// The tab and the run: the agent's host process (501) on ttys005, launched with its
// --name; its shell (850) and the run (900) on no tty. The module's shell is a child of
// its session's host process, on no tty either.
const UNDERNEATH: Record<string, { ppid: string; tty: string }> = {
  '501': { ppid: '400', tty: 'ttys005' },
  '850': { ppid: '501', tty: '??' },
  '900': { ppid: '850', tty: '??' },
}

function fake(over: Over = {}) {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const sent: { to: unknown; text: string }[] = []
  const logged: string[] = []
  const ran: string[] = []
  const usage = { context: { tokens: 120000, window: 1000000, percent: 12 } }
  const env: Record<string, string> = { HOME, ORCHESTRATOR_HOST_CLI: 'hostcli' }
  if (over.gateTokens) env['ORCHESTRATOR_CONTEXT_GATE_TOKENS'] = over.gateTokens
  // The gate's last answer ci-watch kept for owner/app#12, which the facts read CI from.
  if (over.kept !== undefined) files.set(KEPT, over.kept)
  if (over.reportsTo) env['ORCHESTRATOR_REPORTS_TO'] = over.reportsTo
  for (const r of over.registry ?? []) files.set(`${HOME}/.claude/sessions/${r.pid}.json`, JSON.stringify({ pid: Number(r.pid), sessionId: r.sessionId, name: r.name, startedAt: r.startedAt, kind: 'interactive', entrypoint: 'cli' }))
  const name = over.name ?? AGENT
  if (!over.walk) files.set(ROW, JSON.stringify({
    role: over.role ?? 'agent', name, pid: '501', tty: '/dev/ttys005', repo: null,
    context_percent: 12, context_tokens: 120000, window: 1000000, model: 'a-model', busy: false, updated_at: '2026-10-14T09:00:00.000Z',
  }) + '\n')
  if (over.walk) {
    files.set(`${HOME}/.claude/sessions/501.json`, JSON.stringify({ sessionId: over.walk === 'agent' ? 's-one' : 's-agent', kind: 'interactive', entrypoint: 'cli', name, status: 'busy' }))
    files.set(`${HOME}/.claude/sessions/900.json`, JSON.stringify({ sessionId: over.walk === 'agent' ? 's-run' : 's-one', kind: 'interactive', entrypoint: 'sdk-cli', name: 'probe-cwd-17', status: 'busy' }))
  }
  const seed = over.walk === 'underneath' ? '900 ??' : over.walk === 'agent' ? '501 ??' : '123 ttys005'
  // The orchestrator: its row on its own tty, and the launcher's chain naming the agent's.
  files.set(`${STATE}/store/sessions/s-orch`, JSON.stringify({
    role: 'orchestrator', name: ORCH, pid: '400', tty: '/dev/ttys001', repo: null,
    context_percent: 5, context_tokens: 50000, window: 1000000, model: 'a-model', busy: false, updated_at: '2026-10-14T09:00:00.000Z',
  }) + '\n')
  if (over.chain !== false) files.set(`${STATE}/chains/ttys001.jsonl`, JSON.stringify({ tab_id: 'tab-a', tty: '/dev/ttys005', owner: 'own' }) + '\n')
  const dollar = {
    session: {
      id: async () => 's-one',
      root: async () => over.checkout ?? '/w/agent',
      usage: async () => usage,
      model: async () => 'a-model',
      send: async (args: { to: unknown; text: string }) => {
        if (over.send === 'reject') throw new Error('the send was rejected')
        if (over.send === 'refuse') return { isDelivered: false, reason: 'nobody by that name' }
        sent.push(args)
        return { isDelivered: true }
      },
    },
    env: { get: async (n: string) => env[n] },
    plugin: { root: '/plugins/orch-root' },
    fs: {
      read: async (p: string) => {
        const text = files.get(p)
        if (text === undefined) throw new Error(`ENOENT: ${p}`)
        return text
      },
      write: async (p: string, text: string) => { files.set(p, text) },
      exists: async (p: string) => files.has(p),
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 0, mtimeMs: mtimes.get(p) ?? 0, isLink: false })),
      stat: async (p: string) => { throw new Error(`ENOENT: ${p}`) },
    },
    process: {
      run: async (argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }) => {
        const [verb = '', first = '', second = '', third = ''] = argv
        ran.push(argv.join(' '))
        const locked = lockRun(argv, files)
        if (locked) return locked
        const line = logLineOf(argv)
        if (line !== null) {
          logged.push(line)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (verb === 'mv' && files.has(second)) {
          files.set(third, files.get(second)!)
          files.delete(second)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'rm') {
          for (const p of argv.slice(2)) files.delete(p)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        // The walk: the session's own tty, and its host process on it by name.
        if (argv[0] === 'sh' && argv[2] === 'ps -o ppid=,tty= -p $$') return { exitCode: 0, stdout: `${seed}\n`, stderr: '' }
        const under = verb === 'ps' && first === '-p' ? UNDERNEATH[second] : undefined
        if (under) return { exitCode: 0, stdout: `${under.ppid} ${under.tty}\n`, stderr: '' }
        if (argv[0] === 'ps' && argv[1] === '-A' && (over.alive || over.exiting)) return { exitCode: 0, stdout: (over.alive ?? []).map(pid => `${pid}\n`).join('') + (over.exiting ?? []).map(pid => `${pid} ?Es ??\n`).join(''), stderr: '' }
        if (argv[0] === 'ps' && argv[1] === '-t') return { exitCode: 0, stdout: `  501 hostcli --name ${name}\n`, stderr: '' }
        // The agent's checkout, as git and gh answer for it: by the command's first three words.
        // A run outside it (`elsewhere`) reads the directory the module itself runs in.
        const repo = (over.elsewhere && init?.cwd !== (over.checkout ?? '/w/agent') ? over.elsewhere : over.repo)?.[argv.slice(0, 3).join(' ')]
        if (repo !== undefined) return { exitCode: 0, stdout: repo, stderr: '' }
        return { exitCode: 1, stdout: '', stderr: '' }
      },
    },
    ui: { toast: () => undefined, invalidate: () => undefined },
    command: { run: async () => undefined },
    prompt: { submit: async () => undefined },
  } satisfies HostParts
  return { dollar, files, mtimes, sent, logged, usage, ran }
}

// The module's hooks as it registers them, in their order.
function mounted(): Array<Captured<Host<Noun>>> {
  return capture<Host<Noun>>(register)
}

// The event through every hook on it, each handing the next its own event, over a host of these parts.
async function drive<K extends keyof Events>(hooks: ReadonlyArray<Captured<Host<Noun>>>, event: K, parts: HostParts, e: Events[K]): Promise<unknown> {
  const chain = hooksOn(hooks, event)
  const $ = hostOf(parts)
  const run = async (i: number, ev: Events[K]): Promise<unknown> => {
    const hook = chain[i]
    return hook === undefined ? ev : hook.handler($, ev, async (x: Events[K]) => run(i + 1, x))
  }
  return run(0, e)
}

// A measure event: the module reads the figures from the session, not from the event.
const MEASURED: Events['session.measure'] = { context: { window: 0 } }
const turnEnd = (answer: string, turnId = 't') => ({ answer, reason: 'answer', isAborted: false, turnId })
const UNREAD = 'facts (read by the module): tree unread, unpushed unread, head unread'
const QUESTION = 'Merge the fixture change first, or rebase on it?\n\nstatus: question — merge order'

test('each state is sent once to the orchestrator, a repeat sends nothing, a new question sends', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Still waiting on the merge order.\nstatus: question — merge order'))
  expect(fx.sent.length).toBe(1)
  expect(fx.sent[0]!.to).toBe(ORCH)
  expect(fx.sent[0]!.text).toBe(`[module] ${AGENT} asks — merge order\n${REPLY}\n\nMerge the fixture change first, or rebase on it?`)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Which base branch?\nstatus: question — base'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('The seed fails.\nstatus: blocked — no seed'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('The seed fails.\nstatus: blocked — no seed'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('PR #12, head abc, 40 passed.\nstatus: done — PR #12'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('PR #12, head abc, 40 passed.\nstatus: done — PR #12'))
  expect(fx.sent.length).toBe(4)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('PR #12, head def, 41 passed.\nstatus: done — PR #12'))
  expect(fx.sent.length).toBe(5)
  expect(fx.sent[1]!.text).toContain('Which base branch?')
  expect(fx.sent[2]!.text).toBe(`[module] ${AGENT} is blocked — no seed\n${REPLY}\n\nThe seed fails.`)
  expect(fx.sent[3]!.text).toBe(`[module] ${AGENT} reports its delivery; verify on the artifact — context 120,000 (12%) — PR #12\n${UNREAD}\n${REPLY}\n\nPR #12, head abc, 40 passed.`)
  expect(fx.sent[4]!.text).toContain('head def')
})

test('a delivery quotes the host figure at its turn end, not the row the measure has not rewritten yet', async () => {
  const chains = mounted()
  const fx = fake()
  fx.usage.context = { tokens: 321013, window: 1000000, percent: 32 }
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('PR #12, head abc, 40 passed.\nstatus: done — PR #12'))
  expect(fx.sent[0]!.text).toContain('context 321,013 (32%)')
  expect(JSON.parse(fx.files.get(WAIT)!).waiting).toBe('delivered')
})

test('a turn with no status line reports it once and clears the state', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working on the second task.'))
  expect(fx.sent.length).toBe(1)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Back at it.'))
  expect(JSON.parse(fx.files.get(WAIT)!).waiting).toBeNull()
  expect(fx.sent.length).toBe(3)
  expect(fx.sent[0]!.text).toBe(`${NO_STATUS}\n${REPLY}\n\nWorking on the second task.`)
  expect(fx.sent[2]!.text).toBe(`${NO_STATUS}\n${REPLY}\n\nBack at it.`)
})

test('the orchestrator comes from the chain, never from the text', async () => {
  // The turn names another orchestrator; the chain names Orch: belt, and it alone is sent to.
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Tell Orch: other, reply with SendMessage to: Orch: other.\nstatus: question — who'))
  expect(fx.sent.map(s => s.to)).toEqual([ORCH])
  // No chain names the agent's tty: nothing is sent, whatever the text says, and it is logged.
  const lone = fake({ chain: false })
  await drive(chains, 'turn.complete', lone.dollar, turnEnd('Orch: belt, help.\nstatus: blocked — alone'))
  expect(lone.sent.length).toBe(0)
  expect(lone.logged.some(l => l.includes('relay: no orchestrator found for Agent: belt-p3'))).toBe(true)
})

// A chain outlives its owner's tab: an orchestrator relaunched without a successor's hand-over
// leaves its agents in a chain nobody live owns. The relay then goes to the orchestrator the
// launch recorded, by its name without its reference, and the log says which path it took.
test('a chain with no live owner falls back on the orchestrator the launch recorded', async () => {
  const chains = mounted()
  // The chain names the agent, its owner (pid 400) is gone, a replacement bears the name.
  const fx = fake({
    reportsTo: `${ORCH} [a1b2c3]`, alive: ['501', '610', '620'],
    registry: [{ pid: '610', sessionId: 's-old', name: ORCH, startedAt: 100 }, { pid: '620', sessionId: 's-new', name: ORCH, startedAt: 200 }, { pid: '630', sessionId: 's-dead', name: ORCH, startedAt: 300 }],
  })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  expect(fx.sent.map(s => s.to)).toEqual([{ sessionId: 's-new' }])
  expect(fx.logged.some(l => l.includes(`relay: ${AGENT} on /dev/ttys005 goes to ${ORCH} (session s-new) by the launch record`))).toBe(true)
  // No chain names the agent at all: the launch record alone routes it.
  const lone = fake({ chain: false, reportsTo: `${ORCH} [a1b2c3]`, alive: ['501', '620'], registry: [{ pid: '620', sessionId: 's-new', name: ORCH, startedAt: 200 }] })
  await drive(chains, 'turn.complete', lone.dollar, turnEnd(QUESTION))
  expect(lone.sent.map(s => s.to)).toEqual([{ sessionId: 's-new' }])
  // Nobody live bears the recorded name: nothing is sent, and the log says why.
  const gone = fake({ chain: false, reportsTo: `${ORCH} [a1b2c3]`, alive: ['501'], registry: [{ pid: '620', sessionId: 's-new', name: ORCH, startedAt: 200 }] })
  await drive(chains, 'turn.complete', gone.dollar, turnEnd(QUESTION))
  expect(gone.sent.length).toBe(0)
  expect(gone.logged.some(l => l.includes(`relay: ${AGENT} was launched for ${ORCH} [a1b2c3], and no live session bears the name ${ORCH}`))).toBe(true)
})

test('a live launch record wins over a live chain owner, and the log names the record', async () => {
  const chains = mounted()
  const fx = fake({ reportsTo: 'Orch: other [zzz999]', alive: ['400', '501', '620'], registry: [{ pid: '620', sessionId: 's-other', name: 'Orch: other', startedAt: 200 }] })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  expect(fx.sent.map(s => s.to)).toEqual([{ sessionId: 's-other' }])
  expect(fx.logged.some(l => l.includes('relay: ' + AGENT + ' on /dev/ttys005 goes to Orch: other (session s-other) by the launch record'))).toBe(true)
})

test('no launch record: the chain routes the agent', async () => {
  const chains = mounted()
  const fx = fake({ alive: ['400', '501'] })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  expect(fx.sent.map(s => s.to)).toEqual([ORCH])
  expect(fx.logged.some(l => l.includes(`relay: ${AGENT} on /dev/ttys005 goes to ${ORCH} by the chain on /dev/ttys001`))).toBe(true)
})

test('a chain with no live owner and no launch record is orphaned, and the log says so', async () => {
  const chains = mounted()
  // The chain names the agent's tty, its owner (pid 400) is not listed, and no launch record is set.
  const fx = fake({ alive: ['501'] })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  expect(fx.sent.length).toBe(0)
  expect(fx.logged.some(l => l.includes('the chain on /dev/ttys001 names /dev/ttys005 and has no live owner: the entry is orphaned'))).toBe(true)
})

test('an orchestrator row met only as a temporary file is no orchestrator: the entry is orphaned', async () => {
  const chains = mounted()
  const fx = fake({ alive: ['400', '501'] })
  const orch = `${STATE}/store/sessions/s-orch`
  fx.files.set(`${orch}.tmp-1-abcdef`, fx.files.get(orch)!)
  fx.files.delete(orch)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  expect(fx.sent.length).toBe(0)
  expect(fx.logged.some(l => l.includes('the chain on /dev/ttys001 names /dev/ttys005 and has no live owner: the entry is orphaned'))).toBe(true)
})

test('a newer chain of a dead owner does not take the agent from its live orchestrator', async () => {
  const chains = mounted()
  const fx = fake({ alive: ['400', '501'] })
  // A stale chain on a recycled tty names the same agent tty and was written last.
  fx.files.set(`${STATE}/chains/ttys020.jsonl`, JSON.stringify({ tab_id: 'tab-z', tty: '/dev/ttys005', owner: 'gone' }) + '\n')
  fx.mtimes.set(`${STATE}/chains/ttys020.jsonl`, 9e12)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  expect(fx.sent.map(s => s.to)).toEqual([ORCH])
  expect(fx.logged.some(l => l.includes(`goes to ${ORCH} by the chain on /dev/ttys001`))).toBe(true)
})

test('a launch record whose session is dead falls through to the chain', async () => {
  const chains = mounted()
  const fx = fake({ reportsTo: 'Orch: other [zzz999]', alive: ['400', '501'], registry: [{ pid: '620', sessionId: 's-other', name: 'Orch: other', startedAt: 200 }] })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  expect(fx.sent.map(s => s.to)).toEqual([ORCH])
  expect(fx.logged.some(l => l.includes('no live session bears the name Orch: other'))).toBe(true)
})

test('a launch record naming an exiting host (?Es) falls through to the chain', async () => {
  const chains = mounted()
  const fx = fake({ reportsTo: 'Orch: other [zzz999]', alive: ['400', '501'], exiting: ['620'], registry: [{ pid: '620', sessionId: 's-other', name: 'Orch: other', startedAt: 200 }] })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  expect(fx.sent.map(s => s.to)).toEqual([ORCH])
})

test('a launch record naming an exiting host (?Es) relays nowhere when no chain names the agent', async () => {
  // Without a chain the chain does not win: the exiting host must not be picked by the pid alone.
  const chains = mounted()
  const fx = fake({ chain: false, reportsTo: 'Orch: other [zzz999]', alive: ['400', '501'], exiting: ['620'], registry: [{ pid: '620', sessionId: 's-other', name: 'Orch: other', startedAt: 200 }] })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  expect(fx.sent.length).toBe(0)
})

test('an empty chain with a live launch record is relayed, never « no orchestrator found »', async () => {
  const chains = mounted()
  const fx = fake({ chain: false, reportsTo: `${ORCH} [a1b2c3]`, alive: ['501', '620'], registry: [{ pid: '620', sessionId: 's-new', name: ORCH, startedAt: 200 }] })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  expect(fx.sent.map(s => s.to)).toEqual([{ sessionId: 's-new' }])
  expect(fx.logged.some(l => l.includes('no orchestrator found'))).toBe(false)
})

test('the gate crossing takes the same fallback', async () => {
  const chains = mounted()
  const fx = fake({ gateTokens: '200000', chain: false, reportsTo: `${ORCH} [a1b2c3]`, alive: ['501', '620'], registry: [{ pid: '620', sessionId: 's-new', name: ORCH, startedAt: 200 }] })
  fx.usage.context.tokens = 210000
  fx.usage.context.percent = 21
  await drive(chains, 'session.measure', fx.dollar, MEASURED)
  expect(fx.sent).toEqual([{ to: { sessionId: 's-new' }, text: `[module] ${AGENT} context 210,000 (21%) — at the gate` }])
})

for (const [name, role] of [['Coord: ops', 'coordinator'], ['Audit: method', 'auditor'], ['a session', null]] as const) {
  test(`a session that is no agent (${role}) sends nothing on a status line`, async () => {
    const chains = mounted()
    const fx = fake({ name, role })
    await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
    expect(fx.sent.length).toBe(0)
    expect(fx.files.has(WAIT)).toBe(false)
  })
}

for (const failure of ['reject', 'refuse'] as const) {
  test(`a send that fails (${failure}) is logged, never holds the turn's end, and is tried again`, async () => {
    const chains = mounted()
    const fx = fake({ send: failure })
    const e = turnEnd(QUESTION)
    expect(await drive(chains, 'turn.complete', fx.dollar, e)).toBe(e)
    expect(fx.logged.some(l => l.includes('| supervision |') && l.includes('relay:'))).toBe(true)
    expect(JSON.parse(fx.files.get(WAIT)!).relayed).toBeNull()
  })
}

test('the gate crossing is sent once per crossing, at the threshold the session runs under', async () => {
  const chains = mounted()
  const fx = fake({ gateTokens: '200000' })
  await drive(chains, 'session.measure', fx.dollar, MEASURED)
  expect(fx.sent.length).toBe(0)
  fx.usage.context.tokens = 210000
  fx.usage.context.percent = 21
  await drive(chains, 'session.measure', fx.dollar, MEASURED)
  fx.usage.context.tokens = 230000
  fx.usage.context.percent = 23
  await drive(chains, 'session.measure', fx.dollar, MEASURED)
  expect(fx.sent).toEqual([{ to: ORCH, text: `[module] ${AGENT} context 210,000 (21%) — at the gate` }])
  // Back under it (a compaction), then over again: a new crossing, a new message.
  fx.usage.context.tokens = 40000
  fx.usage.context.percent = 4
  await drive(chains, 'session.measure', fx.dollar, MEASURED)
  fx.usage.context.tokens = 205000
  fx.usage.context.percent = 20
  await drive(chains, 'session.measure', fx.dollar, MEASURED)
  expect(fx.sent.length).toBe(2)
  expect(fx.files.get(GATE)).toBe('reported\n')
})

test('the default gate holds when the session sets none, and a non-agent crossing it sends nothing', async () => {
  const chains = mounted()
  const fx = fake()
  fx.usage.context.tokens = 290000
  await drive(chains, 'session.measure', fx.dollar, MEASURED)
  expect(fx.sent.length).toBe(0)
  fx.usage.context.tokens = 300000
  await drive(chains, 'session.measure', fx.dollar, MEASURED)
  expect(fx.sent.length).toBe(1)
  const orch = fake({ name: 'Orch: other', role: 'orchestrator' })
  orch.usage.context.tokens = 900000
  await drive(chains, 'session.measure', orch.dollar, MEASURED)
  expect(orch.sent.length).toBe(0)
  expect(orch.files.has(GATE)).toBe(false)
})

test('a gate send that fails is logged and tried again on the next measure', async () => {
  const chains = mounted()
  const fx = fake({ send: 'refuse' })
  fx.usage.context.tokens = 400000
  await drive(chains, 'session.measure', fx.dollar, MEASURED)
  expect(fx.logged.some(l => l.includes('gate: not delivered to Orch: belt'))).toBe(true)
  // The agent itself was told; only its orchestrator's line is owed at the next measure.
  expect(fx.files.get(GATE)).toBe('told\n')
})

// --- a turn that ends without its status line ---------------------------------------------

const NO_STATUS = `[module] ${AGENT} ended a turn without its status line — context 120,000 (12%)`

test('the report of a turn without a status line: the name, the context when known', () => {
  expect(NO_STATUS_KEY).toBe('no-status')
  expect(noStatusText(AGENT, '120,000 (12%)')).toBe(NO_STATUS)
  expect(noStatusText(AGENT, null)).toBe(`[module] ${AGENT} ended a turn without its status line`)
})

const silent = (text: string) => `${NO_STATUS}\n${REPLY}\n\n${text}`

test('every turn without a status line is reported with its own text, a status turn between or not', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working on the second task.', 'turn-1'))
  expect(fx.sent).toEqual([{ to: ORCH, text: silent('Working on the second task.') }])
  expect(JSON.parse(fx.files.get(WAIT)!).relayed).toBe(`${NO_STATUS_KEY}:turn-1`)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Still working.', 'turn-2'))
  expect(fx.sent.length).toBe(2)
  expect(fx.sent[1]).toEqual({ to: ORCH, text: silent('Still working.') })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION, 'turn-3'))
  expect(fx.sent.length).toBe(3)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Back at it.', 'turn-4'))
  expect(fx.sent.length).toBe(4)
  expect(fx.sent[3]).toEqual({ to: ORCH, text: silent('Back at it.') })
})

test('a turn without a status line that ends on subagents or background work still running wakes no one', async () => {
  const chains = mounted()
  const fx = fake()
  const stop = (tasks: unknown[], crons: unknown[] = []) => drive(chains, 'classic.Stop', fx.dollar, { last_assistant_message: 'Lenses running.', background_tasks: tasks, session_crons: crons })
  await stop([{ type: 'local_agent', description: 'lens: tests', status: 'running' }])
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Lenses running.', 'turn-1'))
  await stop([{ type: 'local_bash', command: 'npm test', status: 'pending' }])
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Suite running.', 'turn-2'))
  await stop([], [{ schedule: '*/10 * * * *' }])
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Back in ten minutes.', 'turn-3'))
  expect(fx.sent).toEqual([])
  // Its work settled, the agent idle with no status line: the orchestrator is told.
  await stop([{ type: 'local_agent', description: 'lens: tests', status: 'completed' }])
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Lenses done.', 'turn-4'))
  expect(fx.sent).toEqual([{ to: ORCH, text: silent('Lenses done.') }])
  // A turn whose stop carried no task list at all is reported, as before.
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('No stop seen.', 'turn-5'))
  expect(fx.sent.length).toBe(2)
})

// --- a turn the host ended in its own words ---------------------------------------------

const LIMIT = "You've hit your weekly limit · resets Nov 20 at 8pm (Europe/Paris)"
const LIMIT_LINE = `[module] ${AGENT} stopped: `
  + `usage limit (resets Nov 20 at 8pm (Europe/Paris)) — « ${LIMIT} »`

test('the host\'s limit and error texts read as stops, the model\'s words as none', () => {
  expect(hostStopOf(LIMIT)).toEqual({ kind: 'limit', text: LIMIT })
  expect(hostStopOf("You've hit your monthly spend limit · raise it in the settings")?.kind).toBe('limit')
  expect(hostStopOf('Credit balance is too low')?.kind).toBe('limit')
  expect(hostStopOf('API Error: 500 Internal server error.')).toEqual({ kind: 'error', text: 'API Error: 500 Internal server error.' })
  expect(hostStopOf('Not logged in · Please run /login')?.kind).toBe('error')
  expect(hostStopOf('I hit an API error in the test, fixing it.\nstatus: done — PR #3')).toBeNull()
  expect(stopText(AGENT, { kind: 'limit', text: LIMIT })).toBe(LIMIT_LINE)
  expect(stopText(AGENT, { kind: 'error', text: 'API Error: Connection lost mid-response.' })).toBe(`[module] ${AGENT} stopped: API error — Connection lost mid-response.`)
  // The transcript's tail: the host's line last is a stop; a prompt after it, or the model's words, none.
  const synthetic = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: LIMIT }] } })
  const system = JSON.stringify({ type: 'system', subtype: 'turn_duration' })
  expect(stopInTail(`garbage\n${synthetic}\n${system}\n`)).toEqual({ kind: 'limit', text: LIMIT })
  expect(stopInTail(`${synthetic}\n${JSON.stringify({ type: 'user', message: { content: 'go on' } })}\n`)).toBeNull()
  expect(stopInTail(JSON.stringify({ type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'Working.' }] } }))).toBeNull()
  expect(stopInTail(JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { content: 'Something new broke' } }))).toEqual({ kind: 'error', text: 'Something new broke' })
})

test('an agent the host halted at its weekly limit is told to its orchestrator once, its background work running or not', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'classic.Stop', fx.dollar, { last_assistant_message: LIMIT, background_tasks: [{ type: 'local_agent', description: 'lens: tests', status: 'running' }], session_crons: [] })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(LIMIT, 'turn-1'))
  expect(fx.sent).toEqual([{ to: ORCH, text: LIMIT_LINE }])
  expect(JSON.parse(fx.files.get(WAIT)!).relayed).toBe('stop:turn-1')
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(LIMIT, 'turn-1'))
  expect(fx.sent.length).toBe(1)
})

test('a turn the host ended on an error, its text only in the transcript, is told as an API error', async () => {
  const chains = mounted()
  const fx = fake()
  const transcript = `${HOME}/.claude/projects/-w/s-one.jsonl`
  const line = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500 Internal server error.' }] } })
  const { list } = fx.dollar.fs
  const { run } = fx.dollar.process
  const parts = {
    ...fx.dollar,
    fs: { ...fx.dollar.fs, list: async (dir: string) => (dir === `${HOME}/.claude/projects` ? [{ name: '-w', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] : list(dir)), exists: async (p: string) => p === transcript || fx.files.has(p) },
    process: { run: async (argv: readonly string[]) => (argv[0] === 'tail' && argv[3] === transcript ? { exitCode: 0, stdout: `${line}\n`, stderr: '' } : run(argv)) },
  }
  await drive(chains, 'turn.complete', parts, { reason: 'error', isAborted: false, turnId: 'turn-9' })
  expect(fx.sent).toEqual([{ to: ORCH, text: `[module] ${AGENT} stopped: API error — 500 Internal server error.` }])
  // Interrupted by the person: his, nothing is read or sent.
  await drive(chains, 'turn.complete', parts, { reason: 'aborted', isAborted: true, turnId: 'turn-10' })
  expect(fx.sent.length).toBe(1)
})

test('the final report written without a status line still reaches the orchestrator after earlier silent turns', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Reading the diff.', 'turn-1'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Running the lenses.', 'turn-2'))
  const report = 'Review of the pull request: two findings, none blocking.\n- a.ts:12 stale comment\n- b.ts:40 missing test'
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(report, 'turn-3'))
  expect(fx.sent.length).toBe(3)
  expect(fx.sent[2]).toEqual({ to: ORCH, text: silent(report) })
})

test('the text of a turn without a status line is cut at the verdict limit, its head kept, the cut said', async () => {
  const chains = mounted()
  const fx = fake()
  const long = `${'a'.repeat(VERDICT_LIMIT)}${'z'.repeat(50)}`
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(long, 'turn-1'))
  expect(fx.sent).toEqual([{ to: ORCH, text: silent(`${'a'.repeat(VERDICT_LIMIT)} … (cut at ${VERDICT_LIMIT} of ${VERDICT_LIMIT + 50} characters: no report file named)`) }])
  expect(noStatusText(AGENT, null, 'x'.repeat(RELAY_CAP))).toBe(`[module] ${AGENT} ended a turn without its status line\n${REPLY}\n\n${'x'.repeat(RELAY_CAP)}`)
})

test('the same turn handled twice without a status line is sent once', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working.', 'turn-1'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working.', 'turn-1'))
  expect(fx.sent.length).toBe(1)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working.', 'turn-2'))
  expect(fx.sent.length).toBe(2)
})

test('a turn event that carries no turn id is still reported each time, never dropped', async () => {
  const chains = mounted()
  const fx = fake()
  const bare = (answer: string) => ({ answer, reason: 'answer', isAborted: false, durationMs: 1 })
  await drive(chains, 'turn.complete', fx.dollar, bare('First.'))
  await drive(chains, 'turn.complete', fx.dollar, bare('Second.'))
  expect(fx.sent.map(s => s.text)).toEqual([silent('First.'), silent('Second.')])
})

test('an orchestrator turn without a machine line sends nothing', async () => {
  const chains = mounted()
  const fx = fake({ name: 'Orch: other', role: 'orchestrator' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Reviewing the pull request.'))
  expect(fx.sent.length).toBe(0)
})

test('a refused report of a turn without a status line writes no key', async () => {
  const chains = mounted()
  const fx = fake({ send: 'refuse' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working.'))
  expect(fx.logged.some(l => l.includes('relay: not delivered'))).toBe(true)
  expect(fx.files.has(WAIT) ? JSON.parse(fx.files.get(WAIT)!).relayed ?? null : null).toBeNull()
})

test('a refused report of a turn without a status line is sent again when the turn is handled again', async () => {
  const chains = mounted()
  let refuse = true
  const fx = fake()
  const send = fx.dollar.session.send
  fx.dollar.session.send = async (args: { to: unknown; text: string }) => (refuse ? { isDelivered: false, reason: 'nobody by that name' } : send(args))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working.', 'turn-1'))
  expect(fx.sent.length).toBe(0)
  refuse = false
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working.', 'turn-1'))
  expect(fx.sent).toEqual([{ to: ORCH, text: silent('Working.') }])
})

// --- a run launched underneath the agent -------------------------------------------------

test("a run launched from the agent's shell sends no notice in its name, the agent still does", async () => {
  const chains = mounted()
  const run = fake({ walk: 'underneath' })
  await drive(chains, 'turn.complete', run.dollar, turnEnd('PR #12, head abc, 40 passed.\nstatus: done — PR #12'))
  await drive(chains, 'turn.complete', run.dollar, turnEnd('ok'))
  expect(run.sent).toEqual([])
  expect(run.files.has(WAIT)).toBe(false)
  const agent = fake({ walk: 'agent' })
  await drive(chains, 'turn.complete', agent.dollar, turnEnd('Working on the second task.'))
  expect(agent.sent).toEqual([{ to: ORCH, text: `${NO_STATUS}\n${REPLY}\n\nWorking on the second task.` }])
})

test("a run launched from the agent's shell writes no row and reports no gate in its name", async () => {
  const chains = mounted()
  const run = fake({ walk: 'underneath' })
  run.usage.context.tokens = 400000
  run.usage.context.percent = 40
  await drive(chains, 'session.measure', run.dollar, MEASURED)
  const row = JSON.parse(run.files.get(ROW)!)
  expect([row.role, row.name, row.pid, row.tty]).toEqual([null, null, undefined, undefined])
  expect(run.sent).toEqual([])
  expect(run.files.has(GATE)).toBe(false)
  const agent = fake({ walk: 'agent' })
  agent.usage.context.tokens = 400000
  agent.usage.context.percent = 40
  await drive(chains, 'session.measure', agent.dollar, MEASURED)
  expect(JSON.parse(agent.files.get(ROW)!).name).toBe(AGENT)
  expect(agent.sent).toEqual([{ to: ORCH, text: `[module] ${AGENT} context 400,000 (40%) — at the gate` }])
})

// --- the turn's text held to the verdict limit -----------------------------------------------

const REPORT_FILE = '/tmp/h/briefs/belt/report-p3.md'

test('a long delivery that names its report is relayed cut to the limit, its pointer and its status line kept', async () => {
  const chains = mounted()
  const fx = fake()
  const long = `${'d'.repeat(VERDICT_LIMIT * 2)}\nbelt#12 abc1234 — gate green — report: ${REPORT_FILE}\nstatus: done — PR 12`
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(long))
  expect(fx.sent.length).toBe(1)
  const body = fx.sent[0]!.text.split('\n\n').slice(1).join('\n\n')
  expect(body.endsWith(` … (cut: full report at ${REPORT_FILE})`)).toBe(true)
  expect(fx.sent[0]!.text.startsWith(`[module] ${AGENT} reports its delivery`)).toBe(true)
  expect(fx.sent[0]!.text).toContain('— PR 12\n')
  expect(body.length).toBeLessThanOrEqual(VERDICT_LIMIT + ` … (cut: full report at ${REPORT_FILE})`.length)
})

test('a long turn that names no report still goes up, cut and saying so', () => {
  const long = `${'q'.repeat(VERDICT_LIMIT + 100)}\nstatus: question — the base`
  const held = heldReport(long)
  expect(held.endsWith('no report file named)\nstatus: question — the base')).toBe(true)
  expect(parseStatus(held)).toEqual({ kind: 'question', blocks: 'the base', question: held.split('\n')[0] })
  const noStatus = heldReport('n'.repeat(VERDICT_LIMIT + 1))
  expect(noStatus).toBe(`${'n'.repeat(VERDICT_LIMIT)} … (cut at ${VERDICT_LIMIT} of ${VERDICT_LIMIT + 1} characters: no report file named)`)
})

test('a short turn is relayed untouched', () => {
  expect(heldReport(QUESTION)).toBe(QUESTION)
})

test("an orchestrator's long turn is never held to the agents' limit", async () => {
  const chains = mounted()
  const fx = fake({ name: ORCH, role: 'orchestrator' })
  fx.files.set(`${STATE}/coordinator.json`, JSON.stringify({ name: 'Coord: ops' }))
  DECLARATIONS.turnStarted()
  DECLARATIONS.declare({ kind: 'done', blocks: '' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('o'.repeat(VERDICT_LIMIT * 2)))
  const said = fx.sent.map(s => s.text).join('\n') + [...fx.files.values()].join('\n')
  expect(said).toContain('o'.repeat(VERDICT_LIMIT * 2))
})

const stopOf = (message: string, extra: object = {}) => ({ session_id: 's-one', transcript_path: '', last_assistant_message: message, ...extra })

test('an agent whose turn ends with no status line, its background work running or not, is not refused', async () => {
  const chains = mounted()
  const fx = fake()
  const running = [{ type: 'bash', command: 'npm test', status: 'running' }]
  expect(fieldsOf(await drive(chains, 'classic.Stop', fx.dollar, stopOf('Waiting on the suite.', { background_tasks: running })))?.['block']).toBeUndefined()
  expect(fieldsOf(await drive(chains, 'classic.Stop', fx.dollar, stopOf('Waiting on the suite.', { background_tasks: [] })))?.['block']).toBeUndefined()
})

test('a waiting status is reported once, however many turns repeat it, and again when it changes', async () => {
  const chains = mounted()
  const fx = fake()
  const waiting = (what: string, text = 'Lenses running.') => `${text}\nstatus: waiting — ${what}`
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(waiting('3 review lenses'), 'turn-1'))
  expect(fx.sent).toEqual([{ to: ORCH, text: `[module] ${AGENT} waits on its background work — 3 review lenses\n${REPLY}` }])
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(waiting('3 review lenses', 'Still running.'), 'turn-2'))
  expect(fx.sent.length).toBe(1)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(waiting('the suite'), 'turn-3'))
  expect(fx.sent.length).toBe(2)
  expect(JSON.parse(fx.files.get(WAIT)!).waiting).toBe('waiting')
})
