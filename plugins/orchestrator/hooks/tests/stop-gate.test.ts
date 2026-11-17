// hooks/tests/stop-gate.test.ts
// The stop gate's boundaries: the decision shapes (the summary-level wake decision, the deadline
// race), the ported checks
// (the wake walk, the once-per-tell CI read over ci-watch's precomputed logs), and the
// wiring over a faked $ — every field the classic.Stop event really carries pinned by a
// test that fails under the wrong spelling. The gate observes, never refuses: what it once held a
// stop for is its log line, and one escape in the journal; the texts are stop_gate.py's, verbatim
// where the data source did not change beneath them.
import { expect, test } from 'claude-code/testing'
import {
  wakeDecision, withDeadline, isDegradedPass,
  deferredIds, deferredRows, readHeads, writeHeads, headsPath, listing, ownAgents, hostStatusOf, openRows,
  projectCheckouts, watchedNumbers, parseCiWatchLog, watchNumberOf, pullRequestOf,
  checkWake as gateWake, checkWakeDone, checkCi, chainEntries, logTell, isSuccessorSpawn, processTable, ownWatches, ownBackground, hostTasks,
  noticeFrom, awaitingAny, NOTICE_TTL_MS, parseGoalsCheck, goalsPaths, restatedQuestions, questionBlocks,
  orchestrationOf, ownerOf, isOwnRecord, recordsWithOpenRows, URGENT_LINE, MACHINE_LINE, type DeclaredWait, type Heads,
} from '../stop-gate.ts'
import { register as registerGuards } from '../guards.ts'
import { askTurnStarted, askedInTurn, parseAsked, questionBlock } from '../question.ts'
import { register as registerWait, ASK_FIRST, Declarations, parseDeclaration } from '../wait.ts'
import { WAIT_TOOL } from '../../core/orchestration.ts'
import { journalled, logLineOf, blockOf } from './fakes.ts'
import { capture, hookOf, hostOf } from '../../core/capture.ts'
import { fieldsOf, type Events, type Hook, type Host, type Matcher, type Noun, type ProcessRunInit, type ToolSpec } from '../../core/host.ts'

// The host a hook under test is handed: every noun, those a fake does not set throwing.
type World = Host<Noun>
type StopEvent = Events['classic.Stop']
// The chain beneath a hook: it answers what it is handed.
type Pass = (x: unknown) => Promise<unknown>
const through: Pass = async x => x
// A decision's or an answer's fields, as a test reads them.
type Read = { readonly case?: unknown; readonly reason?: unknown; readonly warn?: unknown; readonly detail?: unknown; readonly block?: unknown; readonly result?: unknown; readonly isError?: unknown }
const fieldsIn = (value: unknown): Read => fieldsOf(value) ?? {}
import { machineLine } from '../../core/method.ts'
import { unnamedReport } from '../relay.ts'
import { VERDICT_LIMIT } from '../../core/verdict.ts'

// A question block in the decide shape, the text a turn's message may still carry around its wait.
const ASKED = ['**Question 1 of 1**', '_Subject_ : the report', '- **A** : yes', '- **B** : no'].join('\n')

// A question this session asked with `ask` (question.ts), open in the round.
const askedHere = (over: object = {}) => JSON.stringify({
  v: 2, id: 'q-a1b2c3-1', sender: { session: 'a1b2c3', name: 'Orch: belt', role: 'orchestrator', machine: 'box-1' },
  subject: 'the report', context: 'what is known', ask: 'Which one?', choices: [], recommended: null, why: null,
  blocks: 'the mode', status: 'open', at: '2026-11-14T10:00:00Z', answer: null, seq: 1, ...over,
})
const ASKED_HERE = askedHere()


// --- the decision shapes -----------------------------------------------------------------

test('a summary with nothing holding the stop passes', () => {
  expect(wakeDecision({ busyOwnAgents: [], blockingQuestion: null, openRows: [] })).toEqual({ decision: 'pass' })
})

// Program goal 9: a turn that declared no wait gets the decision of one whose last line says nothing.
test('a turn with no declare_wait and a `waiting:` line gets the same decision as one without the line', async () => {
  for (const line of ['waiting: operator — blocks: ligne 359', 'waiting: done', 'waiting: deferred — r-12', 'handed over']) {
    const outcomes = []
    for (const message of ['the report', `the report\n\n${line}`]) {
      const { handlers } = mounted(new Declarations())
      const { dollar } = fakeDollar({ records: ['{"id":"r-12","label":"the report row","state":"open"}\n'], round: { 'q-a1b2c3-1.json': ASKED_HERE } })
      const out = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: message }))
      outcomes.push({ passed: out.answer === out.passed, observed: out.observed })
    }
    expect(outcomes[1]).toEqual(outcomes[0])
  }
})

// --- a question asked with `ask` still open in the round --------------------------------------

test('a round that does not answer in time lets the stop go on', async () => {
  const { handlers } = mounted()
  for (const hang of ['list', 'read'] as const) {
    const fx = fakeDollar({ round: { 'q-a1b2c3-1.json': ASKED_HERE }, roundHang: hang, env: { ORCHESTRATOR_STOP_GATE_DEADLINE: '0.2' } })
    const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'Agent belt-p3 delivered; reviewing next.' }))
    expect(out.answer).toBe(out.passed)
    expect(out.observed).toBeUndefined()
  }
})

test('a question the operator answered from the pane, or a coordinator\'s turn, is never refused for it', async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({ round: { 'q-a1b2c3-1.json': askedHere({ status: 'answered', answer: { text: 'A', by: 'pane', at: '2026-11-14T10:05:00Z' } }) } })
  const report = `Recorded nothing.\n\n${ASKED}\nwaiting: operator — blocks: the next one`
  const passed = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: report }))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
  const coord = fakeDollar({ launchName: 'Coord: machine', round: { 'q-a1b2c3-1.json': ASKED_HERE } })
  const coordinator = await stop(handlers['classic.Stop'], coord.dollar, stopEvent({ last_assistant_message: 'the round is read.' }))
  expect(coordinator.answer).toBe(coordinator.passed)
  expect(coordinator.observed).toBeUndefined()
})

// --- a turn's end never restates an open question ------------------------------------------------

// The block `ask` handed its asker, as the model would copy it into a later turn's message.
const ASKED_BLOCK = questionBlock(parseAsked(ASKED_HERE)!, { i: 1, n: 1 })
const RESTATED_REASON = 'Already in the round (q-a1b2c3-1): name it by its subject, do not copy it.'

test('a block copied at a later turn, by its id line or by its question line, is told once', () => {
  const entry = { id: 'q-a1b2c3-1', ask: 'Which one?' }
  expect(restatedQuestions(`Still waiting.\n\n${ASKED_BLOCK}`, [entry])).toEqual(['q-a1b2c3-1'])
  expect(restatedQuestions('**Question 1 of 1** (q-a1b2c3-1)\nsomething else', [entry])).toEqual(['q-a1b2c3-1'])
  expect(restatedQuestions('_Question_ : Which one?', [entry])).toEqual(['q-a1b2c3-1'])
  // A longer question that starts like this one's, or a quote of the block, is judged by whole lines.
  expect(restatedQuestions('_Question_ : Which one? And why?', [entry])).toEqual([])
  expect(restatedQuestions('> **Question 1 of 1** (q-a1b2c3-1)', [entry])).toEqual(['q-a1b2c3-1'])
  expect(restatedQuestions('**Question 1 of 1** (q-a1b2c3-1) is the one I meant', [entry])).toEqual([])
  expect(restatedQuestions(ASKED_BLOCK, [entry, { id: 'q-other-1', ask: 'Another?' }])).toEqual(['q-a1b2c3-1'])
  // Another question's id is no copy of this one: the id is matched whole, in its parentheses.
  expect(restatedQuestions('**Question 1 of 1** (q-a1b2c3-12)', [entry])).toEqual([])
})

test('a mention of an open question by its subject, or by its id inside a sentence, is no copy', () => {
  const entry = { id: 'q-a1b2c3-1', ask: 'Which one?' }
  expect(restatedQuestions('The question on the report is still open.', [entry])).toEqual([])
  expect(restatedQuestions('q-a1b2c3-1 is still open, nothing to add.', [entry])).toEqual([])
  expect(restatedQuestions(ASKED_BLOCK, [])).toEqual([])
})

test('a stop whose message copies the block of a question asked in an earlier turn is told, and passes', async () => {
  const { handlers } = mounted()
  askTurnStarted()
  const { dollar } = fakeDollar({ round: { 'q-a1b2c3-1.json': ASKED_HERE } })
  const told = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: `Still waiting.\n\n${ASKED_BLOCK}` }))
  expect(told.observed).toBe(RESTATED_REASON)
})

test('the turn that asked the question may write its block once', async () => {
  const { handlers } = mounted()
  askTurnStarted()
  askedInTurn('q-a1b2c3-1')
  const { dollar } = fakeDollar({ round: { 'q-a1b2c3-1.json': ASKED_HERE } })
  const passed = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: `Asking.\n\n${ASKED_BLOCK}` }))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
  // The next turn's start empties the turn's questions: the same block is then a restatement.
  askTurnStarted()
  const later = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: ASKED_BLOCK }))
  expect(later.observed).toBe(RESTATED_REASON)
})

test('a question answered or withdrawn may be written again, as one by its subject only', async () => {
  const { handlers } = mounted()
  askTurnStarted()
  const closed = [
    askedHere({ status: 'answered', answer: { text: 'A', by: 'pane', at: '2026-11-14T10:05:00Z' } }),
    askedHere({ status: 'withdrawn' }),
  ]
  for (const text of closed) {
    const { dollar } = fakeDollar({ round: { 'q-a1b2c3-1.json': text } })
    const passed = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: ASKED_BLOCK }))
    expect(passed.observed).toBeUndefined()
  }
  const { dollar } = fakeDollar({ round: { 'q-a1b2c3-1.json': ASKED_HERE } })
  const bySubject = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: 'The question on the report is still open.' }))
  expect(bySubject.observed).toBeUndefined()
  // The same copy, the question being open, is told: the passes above are the question's state, not the text.
  const open = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: ASKED_BLOCK }))
  expect(open.observed).toBe(RESTATED_REASON)
  // A question another session asked is not this session's to be told of.
  const other = fakeDollar({ round: { 'q-ffffff-1.json': askedHere({ id: 'q-ffffff-1', sender: { session: 'ffffff', name: 'Orch: other', role: 'orchestrator', machine: 'box-1' } }) } })
  const elsewhere = await stop(handlers['classic.Stop'], other.dollar, stopEvent({ last_assistant_message: ASKED_BLOCK }))
  expect(elsewhere.observed).toBeUndefined()
})

// --- a message puts one question to the operator ---------------------------------------------------

const MANY_REASON = '3 questions in one message: present the first, the rest after his answer, one per message.'
const THREE = [1, 2, 3].map(i => `**Question ${i} of 3**\n_Subject_ : matter ${i}\n_Question_ : Which one?`).join('\n\n')

test('the question blocks of a message are the lines that open one, a quoted line not counted', () => {
  expect(questionBlocks(THREE)).toBe(3)
  expect(questionBlocks(ASKED)).toBe(1)
  expect(questionBlocks('Question 1 of 2 — merge it?\nQuestion 2 of 2 — tag it?')).toBe(2)
  expect(questionBlocks('### Question 1 of 2\n- **Question 2 of 2**\n3. Question 3 of 3')).toBe(3)
  expect(questionBlocks('No question here, only the word Question and « 1 of 3 » in a sentence.')).toBe(0)
  expect(questionBlocks('> **Question 1 of 1** (q-a1b2c3-1)\n\n**Question 1 of 1** (q-a1b2c3-2)')).toBe(1)
})

test('a message with three question blocks is told to present the first, the rest after his answer', async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({})
  const told = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: THREE }))
  expect(told.observed).toBe(MANY_REASON)
})

test('a message with one question block is not told, and a coordinator is left alone', async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({})
  const one = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: ASKED }))
  expect(one.observed ?? '').not.toContain('questions in one message')
  const coord = fakeDollar({ launchName: 'Coord: machine' })
  const single = await stop(handlers['classic.Stop'], coord.dollar, stopEvent({ last_assistant_message: THREE }))
  expect(single.observed).toBeUndefined()
})

test('a message copying an open question and asking one more is told as a restatement first', async () => {
  const { handlers } = mounted()
  askTurnStarted()
  const { dollar } = fakeDollar({ round: { 'q-a1b2c3-1.json': ASKED_HERE } })
  const told = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: `${ASKED_BLOCK}\n\n**Question 1 of 1** (q-new-1)` }))
  expect(told.observed).toBe(RESTATED_REASON)
})

test('an orchestrator ending on an operator wait that blocks nothing gets the blocks-nothing refusal, not the no-question one', async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({})
  const refused = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: 'the report\n\nwaiting: operator — blocks: nothing' }))
  expect(refused.observed).toContain('Your wait on the operator blocks nothing')
  expect(refused.observed).not.toBe(ASK_FIRST)
})

// Rule 241 of the rules review: the refusal says what the line is for, and no more.
test('the blocks-nothing refusal says what the operator wait is for in one clause', async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({})
  const refused = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: 'the report\n\nwaiting: operator — blocks: nothing' }))
  expect(refused.observed).toContain('Your wait on the operator blocks nothing: that wait is for a question he must answer.')
  expect(refused.observed).not.toContain('the coordinator would put it to him')
})

test('a busy own agent releases the stop — its idle notice will wake the orchestrator', () => {
  // Declared deviation from the brief's sketch, which expected 'block': stop_gate.py:363-364
  // returns the moment one of its own agents is busy, the shell wrapper's own header names
  // the busy agent first among the things that release the hold, and the design doc lists
  // it among the wake conditions. Inverting it here would refuse every stop an agent
  // survives — the opposite of the ported gate.
  expect(wakeDecision({ busyOwnAgents: ['Agent: belt-p3'], blockingQuestion: null, openRows: [] })).toEqual({ decision: 'pass' })
})

test('a blocking question declared on the last line releases the stop', () => {
  expect(wakeDecision({ busyOwnAgents: [], blockingQuestion: 'the operator', openRows: [] }).decision).toBe('pass')
})

test('an open dispatch row holds the stop and names the row', () => {
  const d = wakeDecision({ busyOwnAgents: [], blockingQuestion: null, openRows: ['r-12 (the report row)'] })
  expect(d.decision).toBe('block')
  expect((d as { reason: string }).reason).toBe('Not done: row r-12 (the report row) is open. Dispatch it, close it, or say what blocks it'
    + ' — or, if the operator deferred it, set its revisit date (dispatch-record.sh blocker <record> <id> "until <ISO UTC time>"), record his ruling with dispatch-record.sh defer <record> <id> --ruling "<his words, dated>" '
    + 'and declare a deferred wait.')
})

test('a CI read that exceeds its time bound degrades to pass-and-log', async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 250))
  const outcome = await withDeadline(slow, 10)
  expect(isDegradedPass(outcome) && outcome.decision).toBe('pass')
})

test('the read that wins the race is answered as itself, and the degraded pass is told apart', async () => {
  const outcome = await withDeadline(Promise.resolve('the launcher said'), 10)
  expect(outcome).toBe('the launcher said')
  expect(isDegradedPass(outcome)).toBe(false)
  expect(isDegradedPass(await withDeadline(new Promise(() => undefined), 10))).toBe(true)
})

test('work given a deadline is cancelled at the deadline, never left to write later', async () => {
  const wrote: string[] = []
  let seen: AbortSignal | null = null
  const outcome = await withDeadline(async (signal: AbortSignal) => {
    seen = signal
    await new Promise(resolve => setTimeout(resolve, 60))
    if (!signal.aborted) wrote.push('late')
    return 'finished'
  }, 10)
  expect(isDegradedPass(outcome)).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(seen!.aborted).toBe(true)
  expect(wrote).toEqual([])
  // Within its deadline the work is answered as itself, its signal never aborted.
  let kept: AbortSignal | null = null
  expect(await withDeadline(async (signal: AbortSignal) => { kept = signal; return 'in time' }, 50)).toBe('in time')
  expect(kept!.aborted).toBe(false)
  // A failure of the work is the work's own, not a degraded pass.
  await expect(withDeadline(async () => { throw new Error('the read broke') }, 50)).rejects.toThrow('the read broke')
})

// --- the ported parsers ------------------------------------------------------------------

test('the listing parses the launcher rows and drops the marks', () => {
  const rows = listing('w1/t1 | /dev/ttys001 | a title | Orch: belt | self\nw1/t2 | /dev/ttys002 | ⠋ Agent: belt | Agent: belt-p3 | hidden\nnot a row\n')
  expect(rows).toEqual([
    { tty: '/dev/ttys001', title: 'a title', name: 'Orch: belt' },
    { tty: '/dev/ttys002', title: '⠋ Agent: belt', name: 'Agent: belt-p3' },
  ])
})

test('a chain file with one corrupt line reads as empty', () => {
  // The launcher's chain_read empties the whole file on one bad line (its writes are
  // atomic, so a bad line means the file is not a chain), and the remains of a
  // non-atomic write must not anchor on a stranger's surviving entry.
  expect(chainEntries('{"tab_id":"T1","tty":"/dev/ttys002","owner":"17"}\nnot json\n{"tab_id":"T2","tty":"/dev/ttys003","owner":"17"}\n')).toEqual([])
  expect(chainEntries('{"tab_id":"T1","tty":"/dev/ttys002"}\n{"tty":"/dev/ttys003"}\n'))
    .toEqual([{ tab_id: 'T1', tty: '/dev/ttys002', owner: '', resident: false }])
})

test('own agents are the owner entries that still run one, residents apart', () => {
  const rows = listing('w1/t2 | /dev/ttys002 | ⠋ Agent: belt | Agent: belt-p3\nw1/t3 | /dev/ttys003 | ✳ Agent: idle | Agent: idle-p3\nw1/t4 | /dev/ttys004 | ✳ Agent: resident | Agent: resident-p3\nw1/t5 | /dev/ttys005 | a plain shell | (host default)\n')
  const entries = [
    { tab_id: 'T1', tty: '/dev/ttys002', owner: '17', resident: false },
    { tab_id: 'T2', tty: '/dev/ttys003', owner: '17', resident: false },
    { tab_id: 'T3', tty: '/dev/ttys004', owner: '17', resident: true },
    { tab_id: 'T4', tty: '/dev/ttys005', owner: '17', resident: false },
    { tab_id: 'T5', tty: '/dev/ttys006', owner: 'someone-else', resident: false },
  ]
  const { agents, resident } = ownAgents(rows, entries, '17')
  expect(agents).toEqual([
    { label: 'Agent: belt-p3', state: 'busy', tty: '/dev/ttys002' },
    { label: 'Agent: idle-p3', state: 'idle', tty: '/dev/ttys003' },
  ])
  expect(resident).toBe(true)
  // With no owner known, no entry is counted: a recycled tty's occupant would be.
  expect(ownAgents(rows, entries, '').agents).toEqual([])
  // The host's own status outranks the glyph, which lags a turn's start: a tab still
  // reading ✳ whose session the host records busy is busy.
  const busy = ownAgents(rows, entries, '17', new Map([['/dev/ttys003', 'busy' as const]]))
  expect(busy.agents.find(a => a.tty === '/dev/ttys003')?.state).toBe('busy')
})

test("the host's session record is read for its status alone", () => {
  expect(hostStatusOf('{"pid":77,"status":"busy","statusUpdatedAt":1}')).toBe('busy')
  expect(hostStatusOf('{"pid":77,"status":"idle"}')).toBe('idle')
  expect(hostStatusOf('{"pid":77,"status":"compacting"}')).toBeNull()
  expect(hostStatusOf('{"pid":77}')).toBeNull()
  expect(hostStatusOf('torn')).toBeNull()
})

test('a pull request is read from the branch and the answer, or not at all', () => {
  expect(pullRequestOf('feat/belt', '{"number":160,"state":"OPEN"}')).toEqual({ number: '160', state: 'OPEN' })
  expect(pullRequestOf(null, '{"number":160,"state":"OPEN"}')).toBeNull()
  expect(pullRequestOf('feat/belt', null)).toBeNull()
  expect(pullRequestOf('feat/belt', 'not json')).toBeNull()
})

test('open rows are the records still open, one per register path', () => {
  expect(openRows([
    '{"id":"r-12","label":"the report row","state":"open"}\n{"id":"r-13","state":"closed"}\n',
    'not json\n{"id":"r-14","state":"open"}\n',
  ])).toEqual(['r-12 (the report row)', 'r-14 (no label)'])
})

test('the checkouts of the project are the workspace rows under its name', () => {
  const out = '/tmp/h/work/repo/belt | feat/belt | abc1234 | clean | pushed\n/tmp/h/work/other/x | feat/x | def | clean | pushed\n/tmp/h/work/repo | main | fed | clean | pushed\n'
  expect(projectCheckouts('/tmp/h/work/repo', out)).toEqual(['/tmp/h/work/repo/belt'])
})

test('the watched numbers are the live ci-watch processes alone', () => {
  const ps = [
    '  501 hostcli',
    '  /bin/bash /plugins/orch-root/skills/orchestrator/scripts/ci-watch.sh 160',
    '  sh -c grep ci-watch.sh 12',
    '  zsh -x /plugins/orch-root/skills/orchestrator/scripts/ci-watch.sh 161',
    '  /bin/bash /plugins/orch-root/skills/orchestrator/scripts/ci-watch.sh --help',
  ].join('\n')
  expect(watchedNumbers(ps)).toEqual(new Set(['160', '161']))
})

test('a ci-watch log is read as the last bucket each check carries', () => {
  const text = 'build\tpending\t0\tu\r\nbuild\tpending\t9\tu\ntest\tfail\t30\tu\nnot a table line\n'
  expect(parseCiWatchLog(text)).toEqual({ build: 'pending', test: 'fail' })
  expect(parseCiWatchLog('')).toEqual({})
})

test('the pull request number is the log name, the base watches apart', () => {
  expect(watchNumberOf('here-pr160.log')).toBe('160')
  expect(watchNumberOf('owner_repo-pr12.log')).toBe('12')
  expect(watchNumberOf('here-pr160-base.log')).toBeNull()
  expect(watchNumberOf('notes.txt')).toBeNull()
})

// --- the heads record --------------------------------------------------------------------

test('a heads record reads and writes the same line', () => {
  const text = '160 1728000000000 pending build,test\n170 abc123 done\n'
  const heads = readHeads(text)
  expect(heads.get('160')).toEqual(['1728000000000', 'pending', new Set(['build', 'test'])])
  expect(heads.get('170')).toEqual(['abc123', 'done', new Set()])
  expect(writeHeads(heads)).toBe(text)
  // A two-field line, written by the previous shape, reads as done; a bad state is skipped.
  expect(readHeads('170 abc123\n').get('170')).toEqual(['abc123', 'done', new Set()])
  expect(readHeads('170 abc123 weird x\n').size).toBe(0)
  // A name carries whatever the forge allows, beyond latin-1: the record survives the
  // cycle as UTF-8 bytes (python's quote/unquote), a comma and a percent included.
  const wide = writeHeads(new Map([['160', ['t1', 'pending', new Set(['✓ lint', '🚀 deploy', 'a,b', '100%'])]]]))
  expect(readHeads(wide).get('160')![2]).toEqual(new Set(['✓ lint', '🚀 deploy', 'a,b', '100%']))
})

test('the heads path is per session and sanitised', () => {
  expect(headsPath('/tmp/h/state', 'a1b2c3')).toBe('/tmp/h/state/stop-gate/a1b2c3.mheads')
  expect(headsPath('/tmp/h/state', 'a/1 b')).toBe('/tmp/h/state/stop-gate/a_1_b.mheads')
})

// --- check 1 -----------------------------------------------------------------------------

// The declare_wait call a test stands for: the machine line its message ends on, declared as the
// turn would have declared it. The gate itself reads only the declaration (stop-gate.ts, checkWake).
function declaredBy(message: string): DeclaredWait | null {
  const line = machineLine(message)
  const matched = MACHINE_LINE.exec(line)
  if (matched?.[1]) return { kind: 'operator', blocks: matched[1].trim(), ...(URGENT_LINE.test(line) ? { urgent: true as const } : {}) }
  if (matched?.[2]) return { kind: 'done', blocks: '' }
  if (/^waiting:\s*operator\s*(?:\(urgent\)\s*)?(?:—|–|--|-)\s*blocks:$/i.test(line)) return { kind: 'operator', blocks: '' }
  const ids = deferredIds(line)
  return ids === null ? null : { kind: 'deferred', blocks: ids }
}
// The wake check over a turn that declared the machine line its message ends on, as declare_wait would.
const checkWake = ({ message, ...facts }: Parameters<typeof gateWake>[0] & { message?: string }) => gateWake({ declared: declaredBy(message ?? ''), ...facts })


const AGENT_BUSY = { label: 'Agent: belt-p3', state: 'busy' as const, tty: '/dev/ttys002' }
const AGENT_IDLE = { label: 'Agent: idle-p3', state: 'idle' as const, tty: '/dev/ttys003' }

test('an idle agent delivered of its pull request is flagged for the log before anything else, not refused', () => {
  const held = checkWake({
    agents: [AGENT_IDLE, AGENT_BUSY], resident: false,
    delivered: ['Agent: idle-p3 (pull request #160, MERGED)'], message: 'anything',
  })
  expect(held).toEqual({ warn: 'idle-delivered', detail: 'Agent: idle-p3 (pull request #160, MERGED)' })
})

test('a busy agent passes, the blocks line passes, the done line asks for the facts', () => {
  expect(checkWake({ agents: [AGENT_BUSY], resident: false, delivered: [], message: 'done?' })).toBeNull()
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'x\n`waiting: operator — blocks: the report`.' }))
    .toEqual({ blocks: 'the report' })
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting: done' })).toBe('read-what-is-left')
})

test('a wait its sender marked urgent passes the gate as the plain one does', () => {
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'x\nwaiting: operator (urgent) — blocks: the production fault' }))
    .toEqual({ blocks: 'the production fault' })
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'Waiting: Operator (URGENT) - blocks: x' }))
    .toEqual({ blocks: 'x' })
})

test('the done line passes with only a working copy left, the caller logging it', () => {
  expect(checkWakeDone({ agents: [], checkouts: ['/tmp/h/work/repo/belt'], deferred: [] })).toBeNull()
})

test('the done line holds the stop on its agents and on open rows, and no longer on working copies', () => {
  expect(checkWakeDone({ agents: [], checkouts: [], deferred: [] })).toBeNull()
  expect(checkWakeDone({
    agents: [AGENT_IDLE], checkouts: ['/tmp/h/work/repo/belt'], deferred: ['r-12 (the report row)'],
  })).toEqual({
    case: 'not-done',
    reason: 'Not done: Agent: idle-p3 is still there. Finish it, or say what blocks it. '
      + 'Not done: row r-12 (the report row) is open. Dispatch it, close it, or say what blocks it'
      + ' — or, if the operator deferred it, set its revisit date (dispatch-record.sh blocker <record> <id> "until <ISO UTC time>"), record his ruling with dispatch-record.sh defer <record> <id> --ruling "<his words, dated>" '
      + 'and declare a deferred wait.',
  })
})

test('the remaining cases: idle agents and nothing to wake are flagged for the log, the others refuse with their own text', () => {
  expect(checkWake({ agents: [AGENT_IDLE], resident: false, delivered: [], message: 'I stopped.' })).toEqual({
    warn: 'idle-agents', detail: 'Agent: idle-p3',
  })
  // A malformed machine line, and a question, declare no wait: the host's list of work in flight alone decides.
  expect(fieldsIn(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting: operater blocks x', tasks: [] })).case).toBe('nothing-will-wake')
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting operator blocks the order', tasks: ['sleep 90'] })).toBeNull()
  expect(fieldsIn(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting: your call?', tasks: [] })).case).toBe('nothing-will-wake')
  expect(checkWake({ agents: [], resident: true, delivered: [], message: 'stopped.' })).toBeNull()
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'stopped.' })).toEqual({ warn: 'nothing-will-wake', detail: '' })
})

test('the wake check decides on the declared wait alone: the same line written by the model releases nothing', () => {
  const none = { agents: [], resident: false, delivered: [], tasks: [] as string[] }
  const refused = { case: 'nothing-will-wake' as const }
  // Each kind is released by its declaration.
  expect(gateWake({ ...none, declared: { kind: 'operator', blocks: 'the report' } })).toEqual({ blocks: 'the report' })
  expect(gateWake({ ...none, declared: { kind: 'done', blocks: '' } })).toBe('read-what-is-left')
  expect(gateWake({ ...none, declared: { kind: 'deferred', blocks: '2 items' } })).toBe('read-what-is-left')
  // The model's own last line is no input of the check: with no declaration, nothing wakes it,
  // the predecessor's « handed over » included.
  expect(gateWake({ ...none })).toMatchObject(refused)
})

// --- check 2 -----------------------------------------------------------------------------

const CI_WATCH = '/plugins/orch-root/skills/orchestrator/scripts/ci-watch.sh'
const ciLog = (tell: string, checks: readonly { name: string; bucket: string }[]) => ({ number: '160', tell, checks })

test('a pending head is told once, again only for a failing set not yet told', () => {
  const run = (log: ReturnType<typeof ciLog>, reported: Heads, watched = new Set<string>(), ignored = new Set<string>()) =>
    checkCi({ logs: [log], reported, watched, ignored, watchCommand: CI_WATCH })
  const pending = ciLog('t1', [{ name: 'build', bucket: 'pending' }])
  const first = run(pending, readHeads(''))
  expect(first.lines.length).toBe(1)
  expect(first.lines[0]).toContain('#160')
  expect(first.lines[0]).toContain('1 checks pending (build)')
  expect(first.lines[0]).toContain(CI_WATCH + ' 160')
  // The next stop knows it was told: the same state says nothing.
  const told = run(pending, first.heads)
  expect(told.lines).toEqual([])
  // A failing set it has not been told refuses again and is recorded.
  const failing = ciLog('t1', [{ name: 'build', bucket: 'fail' }, { name: 'test', bucket: 'fail' }])
  const again = run(failing, told.heads)
  expect(again.lines.length).toBe(1)
  expect(again.lines[0]).toContain('2 failing (build, test)')
  // A moved tell starts over.
  const moved = run(ciLog('t2', [{ name: 'build', bucket: 'pending' }]), again.heads)
  expect(moved.lines.length).toBe(1)
})

test('a watched pull request is waited for, and nothing is recorded for it', () => {
  const outcome = checkCi({
    logs: [ciLog('t1', [{ name: 'build', bucket: 'pending' }])], reported: readHeads(''),
    watched: new Set(['160']), ignored: new Set(), watchCommand: CI_WATCH,
  })
  expect(outcome.lines).toEqual([])
  expect(outcome.heads.size).toBe(0)
})

test('a head with no checks read is unread, and ignored checks filter nothing else out', () => {
  const unread = checkCi({ logs: [ciLog('t1', [])], reported: readHeads(''), watched: new Set(), ignored: new Set(), watchCommand: CI_WATCH })
  expect(unread.lines).toEqual([])
  expect(unread.heads.size).toBe(0)
  const ignored = checkCi({
    logs: [ciLog('t1', [{ name: 'build', bucket: 'fail' }])], reported: readHeads(''),
    watched: new Set(), ignored: new Set(['build']), watchCommand: CI_WATCH,
  })
  expect(ignored.lines).toEqual([])
})

// --- the wiring --------------------------------------------------------------------------

const HOME = '/tmp/h'
const STATE = `${HOME}/.claude/claude-orchestrator`
const CHAIN = `${STATE}/chains/ttys001.jsonl`
const REGISTER = `${STATE}/records/a1b2c3`
const RECORD = '/tmp/h/rec/round.jsonl'
const HEADS = `${STATE}/stop-gate/a1b2c3.mheads`
const STAMP = `${STATE}/sweep.stamp`
const CIDIR = `${STATE}/ci-watch`
const PROJECTS = `${HOME}/.claude/projects`
const TRANSCRIPT = `${HOME}/elsewhere/s-stop.jsonl`
const LAUNCHER = '/plugins/orch-root/skills/iterm-agents/scripts/iterm-agent.sh'
const WORKSPACE = '/plugins/orch-root/skills/orchestrator/scripts/workspace.sh'
const GOALS_SH = '/plugins/orch-root/skills/orchestrator/scripts/goals.sh'
const GOALS_FILE = '/tmp/h/rec/goals.md'

const BUSY_ROW = 'w1/t2 | /dev/ttys002 | ⠋ Agent: belt | Agent: belt-p3'
const IDLE_ROW = 'w1/t3 | /dev/ttys003 | ✳ Agent: idle | Agent: idle-p3'
const OWNED = '{"tab_id":"T1","tty":"/dev/ttys002","owner":"17"}\n'

// The paths that hang off the state root: the shell gate kept them under one root and the
// override moves them as one. The module's own log is not among them — it stays in the
// config dir, which is exactly what the override test below pins.
function statePaths(root: string) {
  return {
    root,
    chain: `${root}/chains/ttys001.jsonl`,
    register: `${root}/records/a1b2c3`,
    heads: `${root}/stop-gate/a1b2c3.mheads`,
    stamp: `${root}/sweep.stamp`,
    ci: `${root}/ci-watch`,
    ignored: `${root}/ignored-checks`,
  }
}

type Setup = {
  transcript?: string
  noLaunchName?: boolean
  launchName?: string
  chain?: string
  listing?: string
  records?: string[]
  heads?: string | undefined
  ciLogs?: Record<string, { mtimeMs: number; text: string }>
  ps?: string
  agentCwd?: string
  agentBranch?: string
  prAnswer?: string
  workspace?: string
  top?: string
  env?: Record<string, string>
  hangListing?: boolean
  failCiList?: boolean
  stampMtimeMs?: number
  sweep?: { exitCode: number; stdout: string; stderr: string }
  hangSweep?: boolean
  sweepStartFail?: boolean
  origin?: string
  ignoredText?: string
  failIgnoredRead?: boolean
  failLogRead?: boolean
  hangHeadsWrite?: boolean
  hostRecord?: string
  agentRow?: string
  selfBin?: string
  goals?: { exitCode: number; stdout: string } | 'hang'
  goalsShown?: string
  round?: Record<string, string>
  roundHang?: 'list' | 'read'
  // The to-do list of the session (todo.ts), read from the module's todo directory.
  todos?: string
  // The owner file of the register's record, and further registered records beside it, each
  // with its text, its owner file and its goals.md reading.
  recordOwner?: string
  shared?: { path: string; text: string; owner?: string; goals?: { exitCode: number; stdout: string } }[]
}

function fakeDollar(setup: Setup): { dollar: World; written: string[]; ran: string[]; wrote: Record<string, string>; stamp: { atRun?: string | undefined }; inits: Record<string, ProcessRunInit | undefined> } {
  const inits: Record<string, ProcessRunInit | undefined> = {}
  const written: string[] = []
  const ran: string[] = []
  const wrote: Record<string, string> = {}
  const stamp: { atRun?: string | undefined } = {}
  const env: Readonly<Record<string, string>> = {
    HOME, ITERM_SESSION_ID: 'w0t0:2:17',
    ORCHESTRATOR_HOST_CLI: 'hostcli', ...(setup.env ?? {}),
  }
  // The fake serves whatever root the module resolves: the default config-dir root, or the
  // override's when the setup sets one.
  const S = statePaths(env['ORCHESTRATOR_STATE_DIR'] ?? STATE)
  const plugin = { name: 'orchestrator', root: '/plugins/orch-root' }
  const dollar = hostOf({
    // The launcher's scripts are found under the engine's $.plugin.root: the
    // environment above deliberately carries no CLAUDE_PLUGIN_ROOT, as live.
    plugin,
    session: { id: async () => 'a1b2c3' },
    env: { get: async (name: string) => env[name] },
    fs: {
      read: async (p: string) => {
        if (p === S.chain) return setup.chain ?? ''
        if (p === S.register) return [...(setup.records ? [RECORD] : []), ...(setup.shared ?? []).map(r => r.path)].map(r => `${r}\n`).join('')
        if (p === RECORD) return (setup.records ?? [])[0] ?? ''
        if (p === `${RECORD}.owner` && setup.recordOwner !== undefined) return `${setup.recordOwner}\n`
        for (const record of setup.shared ?? []) {
          if (p === record.path) return record.text
          if (p === `${record.path}.owner` && record.owner !== undefined) return `${record.owner}\n`
        }
        if (p === S.heads) return setup.heads ?? ''
        if (p === S.ignored) {
          if (setup.failIgnoredRead) throw new Error('EACCES: permission denied')
          if (setup.ignoredText !== undefined) return setup.ignoredText
          // Absent: the same answer a missing file gives.
          throw new Error(`ENOENT: ${p}`)
        }
        if (p === `${HOME}/.claude/sessions/77.json` && setup.hostRecord !== undefined) return setup.hostRecord
        if (p === `${S.root}/stop-gate/a1b2c3.goals` && setup.goalsShown !== undefined) return setup.goalsShown
        if (setup.roundHang === 'read' && (p.startsWith(`${S.root}/round/`))) return new Promise(() => undefined)
        const asked = p.startsWith(`${S.root}/round/`) ? setup.round?.[p.slice(S.root.length + 7)] : undefined
        if (asked !== undefined) return asked
        if (p.startsWith(`${S.root}/todo/`) && setup.todos !== undefined) return setup.todos
        if (p.startsWith(`${S.ci}/`)) {
          // The owner file is read before its log: the log's own read is the one that fails.
          if (setup.failLogRead && !p.endsWith('.session')) throw new Error('EIO: the log cannot be read')
          return setup.ciLogs?.[p.slice(S.ci.length + 1)]?.text ?? ''
        }
        throw new Error(`unread: ${p}`)
      },
      write: async (p: string, text: string) => {
        if (p === S.heads && setup.hangHeadsWrite) return new Promise(() => undefined)
        wrote[p] = text
      },
      stat: async (p: string) => {
        if (p === TRANSCRIPT && setup.transcript !== undefined) {
          return { kind: 'file', size: setup.transcript.length, mtimeMs: 0, isLink: false }
        }
        if (p === S.stamp && setup.stampMtimeMs !== undefined) {
          return { kind: 'file', size: 12, mtimeMs: setup.stampMtimeMs, isLink: false }
        }
        throw new Error('ENOENT')
      },
      list: async (p: string) => {
        if (p === S.ci) {
          if (setup.failCiList) throw new Error('the ci-watch directory cannot be read')
          return Object.entries(setup.ciLogs ?? {}).map(([name, log]) => (
            { name, kind: 'file', size: log.text.length, mtimeMs: log.mtimeMs, isLink: false }
          ))
        }
        if (p === PROJECTS) return []
        if (p === `${S.root}/round`) {
          if (setup.roundHang === 'list') return new Promise(() => undefined)
          return Object.entries(setup.round ?? {}).map(([name, text]) => ({ name, kind: 'file', size: text.length, mtimeMs: 0, isLink: false }))
        }
        return []
      },
      exists: async (p: string) => (p === GOALS_FILE && setup.goals !== undefined)
        || (setup.shared ?? []).some(record => record.goals !== undefined && p === `${record.path.replace(/\/[^/]*$/, '')}/goals.md`),
    },
    process: {
      run: async (argv: readonly string[], init?: ProcessRunInit) => {
        inits[argv.join(' ')] = init
        const line = logLineOf(argv)
        if (line !== null) {
          written.push(line)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        const block = blockOf(argv, () => setup.transcript ?? '')
        if (block !== null) return { exitCode: 0, stdout: block, stderr: '' }
        ran.push(argv.join(' '))
        if (argv[0] === 'sh') {
          return { exitCode: 0, stdout: '123 ttys001\n', stderr: '' }
        }
        if (argv[0] === 'ps' && argv[1] === '-t' && argv[2] === 'ttys001') {
          // The session's own process, as the listing prints it.
          const bin = setup.selfBin ?? 'hostcli'
          return { exitCode: 0, stdout: setup.noLaunchName ? `  501 ${bin}\n` : `  501 ${bin} --name ${setup.launchName ?? 'Orch: belt'}\n`, stderr: '' }
        }
        if (argv[0] === 'ps' && argv[1] === '-t' && argv[2] === 'ttys003') {
          // The idle agent's host process: its pid, then its working directory.
          return { exitCode: 0, stdout: setup.agentRow ?? '   77 hostcli\n', stderr: '' }
        }
        if (argv[0] === 'ps') return { exitCode: 0, stdout: setup.ps ?? '1 ??\n', stderr: '' }
        if (argv[0] === 'lsof') {
          return { exitCode: 0, stdout: `p77\nn${setup.agentCwd ?? '/tmp/h/work/belt'}\n`, stderr: '' }
        }
        if (argv[0] === 'git' && argv[3] === 'remote') {
          return setup.origin ? { exitCode: 0, stdout: `${setup.origin}\n`, stderr: '' } : { exitCode: 128, stdout: '', stderr: 'no origin' }
        }
        if (argv[0] === 'git' && argv[3] === 'symbolic-ref') {
          return setup.agentBranch ? { exitCode: 0, stdout: setup.agentBranch, stderr: '' } : { exitCode: 1, stdout: '', stderr: '' }
        }
        if (argv[0] === 'git' && argv[3] === 'rev-parse') {
          return argv[2] === '/tmp/h/work/repo' && setup.top
            ? { exitCode: 0, stdout: `${setup.top}\n`, stderr: '' }
            : { exitCode: 128, stdout: '', stderr: '' }
        }
        if (argv[0] === 'gh') {
          return setup.prAnswer ? { exitCode: 0, stdout: setup.prAnswer, stderr: '' } : { exitCode: 1, stdout: '', stderr: 'no answer' }
        }
        if (argv[0] === 'bash' && argv[1] === LAUNCHER) {
          if (setup.hangListing) return new Promise(() => undefined)
          return { exitCode: 0, stdout: setup.listing ?? '', stderr: '' }
        }
        if (argv[0] === 'bash' && argv[1] === WORKSPACE && argv[2] === 'sweep') {
          // The stamp as it stood when the sweep began: it must already be written.
          stamp.atRun = wrote[S.stamp]
          if (setup.sweepStartFail) return Promise.reject(new Error('spawn bash ENOENT'))
          if (setup.hangSweep) return new Promise(() => undefined)
          return { exitCode: setup.sweep?.exitCode ?? 0, stdout: setup.sweep?.stdout ?? '', stderr: setup.sweep?.stderr ?? '' }
        }
        if (argv[0] === 'bash' && argv[1] === WORKSPACE) return { exitCode: 0, stdout: setup.workspace ?? '', stderr: '' }
        if (argv[0] === 'bash' && argv[1] === GOALS_SH) {
          const sharedGoals = (setup.shared ?? []).find(record => `${record.path.replace(/\/[^/]*$/, '')}/goals.md` === argv[3])
          if (sharedGoals?.goals) return { exitCode: sharedGoals.goals.exitCode, stdout: sharedGoals.goals.stdout, stderr: '' }
          if (setup.goals === 'hang') return new Promise(() => undefined)
          return { exitCode: setup.goals?.exitCode ?? 2, stdout: setup.goals?.stdout ?? '', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  })
  return { dollar, written, ran, wrote, stamp, inits }
}

// `declarations`: given, the gate reads it as the host does and the caller declares; omitted, each stop
// declares the machine line its message ends on, as a turn that called declare_wait with it would.
type Guards = {
  'classic.Stop': Hook<World, Events['classic.Stop']>
  'prompt.submit': Hook<World, Events['prompt.submit']>
  // The guard on Bash, the last tool call it registers.
  'tool.call': Hook<World, Events['tool.call']>
  'tool.call:SendMessage': Hook<World, Events['tool.call']>
}
function mounted(declarations?: Declarations): { handlers: Guards; matchers: { 'classic.Stop': Matcher | undefined; 'tool.call:SendMessage': Matcher | undefined } } {
  const own = declarations ?? new Declarations()
  const hooks = capture<World>(on => registerGuards(on, own))
  const stopHook = hookOf(hooks, 'classic.Stop')
  const gate = stopHook.handler
  const handlers: Guards = {
    'classic.Stop': declarations !== undefined ? gate : async (dollar, e, next) => {
      own.turnStarted()
      const wait = declaredBy(String(e.last_assistant_message ?? ''))
      if (wait !== null) own.declare(wait)
      return gate(dollar, e, next)
    },
    'prompt.submit': hookOf(hooks, 'prompt.submit').handler,
    'tool.call': hookOf(hooks, 'tool.call', { tool: 'Bash' }).handler,
    'tool.call:SendMessage': hookOf(hooks, 'tool.call', { tool: 'SendMessage' }).handler,
  }
  return { handlers, matchers: { 'classic.Stop': stopHook.matcher, 'tool.call:SendMessage': hookOf(hooks, 'tool.call', { tool: 'SendMessage' }).matcher } }
}

const stopEvent = (over: Record<string, unknown> = {}): StopEvent => ({
  session_id: 'a1b2c3',
  transcript_path: TRANSCRIPT,
  cwd: '/tmp/h/work/repo',
  stop_hook_active: false,
  last_assistant_message: 'stopped.',
  ...over,
})

// A stop through the gate. The gate observes and never refuses: `observed` is what it once refused
// the stop for, read off its log line, and every such stop passes with one escape in the journal.
async function stop(handler: Guards['classic.Stop'], dollar: World, e: StopEvent) {
  return observing(dollar, async (seen, pass) => handler(seen, e, pass))
}

// Runs `through` over a $ whose log lines and journal are read, then checks the gate's observation.
async function observing(dollar: World, through: (dollar: World, pass: Pass) => Promise<unknown>) {
  let passed: unknown = null
  const lines: string[] = []
  const fx = journalled({ ...dollar, process: { ...dollar.process, run: async (argv: readonly string[], init?: ProcessRunInit) => {
    const line = logLineOf(argv)
    if (line !== null) lines.push(line)
    return init === undefined ? dollar.process.run(argv) : dollar.process.run(argv, init)
  } } })
  const answer = await through(fx.dollar, async (x: unknown) => { passed = x; return x })
  const mark = '| stop gate: let through: '
  const held = lines.find(line => line.includes(mark))
  const observed = held === undefined ? undefined : held.slice(held.indexOf(mark) + mark.length)
  if (observed !== undefined) {
    // The stop passes on: what the gate was handed (the wait's own handler may add to the event).
    expect(passed).not.toBeNull()
    expect(answer).toEqual(passed)
    expect(fx.journal()).toEqual(['escape orchestrator.stop-gate.held'])
  } else {
    expect(fx.journal()).toEqual([])
  }
  return { answer, passed, observed }
}

test('the stop gate mounts on classic.Stop with no matcher', () => {
  const { handlers, matchers } = mounted()
  expect(typeof handlers['classic.Stop']).toBe('function')
  expect(matchers['classic.Stop']).toBeUndefined()
})

test('a stop already refused this turn is left alone, nothing read', async () => {
  const { handlers } = mounted()
  const { dollar, ran } = fakeDollar({})
  const e = stopEvent({ stop_hook_active: true })
  const { answer, passed } = await stop(handlers['classic.Stop'], dollar, e)
  expect(passed).toBe(e)
  expect(answer).toBe(e)
  expect(ran.length).toBe(0)
})

test('a session that is no orchestrator stops untouched, the launcher never asked', async () => {
  const { handlers } = mounted()
  const { dollar, ran } = fakeDollar({ launchName: 'Agent: belt' })
  const e = stopEvent({})
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(ran.filter(l => l.includes('iterm-agent.sh')).length).toBe(0)
})

test('a busy own agent releases the stop, no pull request read for it', async () => {
  const { handlers } = mounted()
  const { dollar, ran } = fakeDollar({ listing: BUSY_ROW, chain: OWNED })
  const e = stopEvent({})
  const { answer, passed } = await stop(handlers['classic.Stop'], dollar, e)
  expect(passed).toBe(e)
  expect(answer).toBe(e)
  expect(ran.filter(l => l.startsWith('gh')).length).toBe(0)
})

// A stop that passes and adds exactly one `warn <what>` line to the log: the demoted cases' shape.
async function warnsNotRefuses(handlers: Guards, fx: { dollar: World; written: string[] }, event: StopEvent, what: string): Promise<void> {
  const before = fx.written.filter(l => l.includes(`| stop gate: warn ${what}`)).length
  const out = await stop(handlers['classic.Stop'], fx.dollar, event)
  expect(out.answer).toBe(out.passed)
  expect(out.observed).toBeUndefined()
  expect(fx.written.filter(l => l.includes(`| stop gate: warn ${what}`)).length).toBe(before + 1)
}

test('a stop with nothing to wake the orchestrator passes, the log naming nothing-will-wake', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({})
  const { dollar } = fx
  await warnsNotRefuses(handlers, fx, stopEvent({}), 'nothing-will-wake')
  // The same session declaring its block on the last line passes instead — the message
  // is read where the event carries it.
  const declared = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: ASKED + '\nwaiting: operator — blocks: the report' }))
  expect(declared.answer).toBe(declared.passed)
  expect(declared.observed).toBeUndefined()
})

// A dispatch row, open and ready unless changed, as the record holds it.
const readyRow = (id: number, label: string, more: Record<string, unknown> = {}) =>
  `${JSON.stringify({ id, state: 'open', label, blocker: 'none', ...more })}\n`
const OPEN_PR_LINE = (agent: string) => `${JSON.stringify({ v: 1, ledger: 'pr', repo: 'acme/app', pr: 9, status: 'working', agent, since: '2026-11-15T07:00:00Z', updated: '2026-11-15T07:00:00Z' })}\n`
const READY = 'Lignes prêtes sans agent : 12 TOKENDRIFT'

test('a stop that passes with a ready row nobody is on warns, the log naming it, and journals no escape', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ records: [readyRow(12, 'TOKENDRIFT: the context fills')] })
  await warnsNotRefuses(handlers, fx, stopEvent({}), `ready-rows ${READY}`)
})

test('a stop let through for another reason carries the ready rows in the same line', async () => {
  const { handlers } = mounted()
  const logs = { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } }
  const fx = fakeDollar({ records: [readyRow(12, 'TOKENDRIFT: the context fills')], ciLogs: logs })
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({}))
  expect(out.observed).toContain('#160')
  expect(out.observed).toContain(READY)
})

test('a ready row is not named while a live agent, an open pull request, a blocker or a deferral holds it', async () => {
  const { handlers } = mounted()
  const named = async (rows: string, setup: Record<string, unknown> = {}) => {
    const fx = fakeDollar({ records: [rows], ...setup })
    const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({}))
    expect(out.answer).toBe(out.passed)
    return fx.written.some(l => l.includes(`| stop gate: warn ready-rows ${READY}`))
  }
  const row = readyRow(12, 'TOKENDRIFT: the context fills')
  expect(await named(row)).toBe(true)
  expect(await named(row, { listing: 'w1/t2 | /dev/ttys002 | ⠋ Agent: tokendrift | Agent: tokendrift' })).toBe(false)
  expect(await named(row + OPEN_PR_LINE('Agent: tokendrift'))).toBe(false)
  expect(await named(readyRow(12, 'TOKENDRIFT: the context fills', { blocker: 'row 4 closed' }))).toBe(false)
  expect(await named(readyRow(12, 'TOKENDRIFT: the context fills', { deferred: 'later, 2026-11-15' }))).toBe(false)
})

test('an idle agent delivered of its merged pull request is not refused: the log names it', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({
    listing: IDLE_ROW,
    chain: '{"tab_id":"T1","tty":"/dev/ttys003","owner":"17"}\n',
    agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', prAnswer: '{"number":160,"state":"MERGED"}',
  })
  await warnsNotRefuses(handlers, fx, stopEvent({}), 'idle-delivered Agent: idle-p3 (pull request #160, MERGED)')
})

test('the transcript is read from the event, not by hunting the projects directory', async () => {
  // The rename lives outside the projects directory: only the event's transcript_path
  // reaches it, the fallback the prompt gate needs would not.
  const renamed = ['{"type":"assistant","message":{"role":"assistant","content":"an answer"}}', '{"type":"custom-title","customTitle":"Orch: round 3"}'].join('\n') + '\n'
  const { handlers } = mounted()
  const named = fakeDollar({ transcript: renamed, noLaunchName: true })
  await warnsNotRefuses(handlers, named, stopEvent({}), 'nothing-will-wake')
  const unnamed = fakeDollar({ noLaunchName: true })
  const quiet = await stop(handlers['classic.Stop'], unnamed.dollar, stopEvent({ transcript_path: '' }))
  expect(quiet.answer).toBe(quiet.passed)
  expect(quiet.observed).toBeUndefined()
  expect(unnamed.written.length).toBe(1)
})

test('the open rows are the session register\'s, read under the event\'s session id', async () => {
  const { handlers } = mounted()
  const open = fakeDollar({ records: ['{"id":"r-12","label":"the report row","state":"open"}\n'] })
  const held = await stop(handlers['classic.Stop'], open.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect(held.observed).toContain('row r-12 (the report row) is open')
  const none = fakeDollar({})
  const passed = await stop(handlers['classic.Stop'], none.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
})

test('a checkout left of the project no longer holds a done stop: the log carries a warning, read from the event\'s cwd', async () => {
  const { handlers } = mounted()
  const left = fakeDollar({
    top: '/tmp/h/work/repo',
    workspace: '/tmp/h/work/repo/belt | feat/belt | abc1234 | clean | pushed\n',
  })
  const held = await stop(handlers['classic.Stop'], left.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect(held.answer).toBe(held.passed)
  expect(held.observed).toBeUndefined()
  expect(left.written.some(l => l.endsWith('| stop gate: warn working-copies /tmp/h/work/repo/belt'))).toBe(true)
  const gone = fakeDollar({ top: '', workspace: '/tmp/h/work/repo/belt | feat/belt | abc1234 | clean | pushed\n' })
  const passed = await stop(handlers['classic.Stop'], gone.dollar, stopEvent({ last_assistant_message: 'waiting: done', cwd: '' }))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
})

test('a pending ci-watch log holds the stop once and records the telling', async () => {
  const { handlers } = mounted()
  const message = { last_assistant_message: ASKED + '\nwaiting: operator — blocks: the report' }
  const first = fakeDollar({ ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\ntest\tfail\t30\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } } })
  const held = await stop(handlers['classic.Stop'], first.dollar, stopEvent(message))
  expect(held.observed).toContain('#160')
  expect(held.observed).toContain('run_in_background')
  expect(first.wrote[HEADS]).toBe(`160 ${logTell('build\tpending\t9\tu\n')} pending test\n`)
  // Check 2 pays no network at the stop: no gh call on its path either.
  expect(first.ran.filter(l => l.startsWith('gh')).length).toBe(0)
  // Told once: the next stop passes and leaves the record as it is.
  const second = fakeDollar({
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\ntest\tfail\t30\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
    heads: first.wrote[HEADS],
  })
  const passed = await stop(handlers['classic.Stop'], second.dollar, stopEvent(message))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
})

test('a pull request waited on in the background is not told', async () => {
  const { handlers } = mounted()
  const { dollar, wrote } = fakeDollar({
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
    ps: `  900   1 /bin/bash ${CI_WATCH} 160\n`,
  })
  const outcome = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: ASKED + '\nwaiting: operator — blocks: the report' }))
  expect(outcome.answer).toBe(outcome.passed)
  expect(outcome.observed).toBeUndefined()
  // Nothing recorded for a watched pull request, so a watch that dies is still told once.
  expect(wrote[HEADS]).toBe('')
})

test('a pending watch another session armed is neither told nor recorded', async () => {
  const { handlers } = mounted()
  const { dollar, written, wrote } = fakeDollar({
    ciLogs: {
      'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' },
      'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'zz9999\n' },
    },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('#160'))).toBe(false)
  expect(wrote[HEADS]).toBe('')
})

test('a pending watch with no owner file is neither told nor recorded', async () => {
  const { handlers } = mounted()
  const { dollar, written, wrote } = fakeDollar({
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' } },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('#160'))).toBe(false)
  expect(wrote[HEADS]).toBe('')
})

test('a read that cannot answer in time lets the stop pass and says so', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({ hangListing: true, env: { ORCHESTRATOR_STOP_GATE_DEADLINE: '0.05' } })
  const e = stopEvent({})
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.length).toBe(1)
  expect(written[0]).toContain('| guards |')
  expect(written[0]).toContain('unread')
})

test('a directory that cannot be read lets the stop pass and says so', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({ failCiList: true })
  const e = stopEvent({ last_assistant_message: ASKED + '\nwaiting: operator — blocks: the report' })
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  // The blocks line the gate logs beside the unread one it stands down on.
  expect(written.length).toBe(2)
  expect(written[1]).toContain('| guards |')
  expect(written[1]).toContain('unread')
})

// --- the sweep -----------------------------------------------------------------------------

// A passing, scoped stop: the blocks line releases check 1 and no ci-watch log exists,
// so the stop reaches the sweep at its final exit.
const PASSING = { last_assistant_message: ASKED + '\nwaiting: operator — blocks: the report' }
// Fifteen minutes old: past the default interval, inside a longer override.
const OLD_STAMP = Date.now() - 15 * 60 * 1000
const sweepLine = (ran: readonly string[]) => ran.find(l => l.includes(' sweep --deadline'))

test('a sweep that ran within the interval is not run again', async () => {
  const { handlers } = mounted()
  const { dollar, ran, wrote, written } = fakeDollar({ stampMtimeMs: Date.now() })
  const { answer, passed } = await stop(handlers['classic.Stop'], dollar, stopEvent(PASSING))
  expect(answer).toBe(passed)
  expect(sweepLine(ran)).toBeUndefined()
  expect(wrote[STAMP]).toBeUndefined()
  expect(written.filter(l => l.includes('sweep')).length).toBe(0)
})

test('a due sweep runs once, writes the shared stamp first, and logs its deletions', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({
    stampMtimeMs: OLD_STAMP,
    sweep: { exitCode: 0, stdout: 'deleted /tmp/h/work/repo/belt\nkept /tmp/h/work/repo/pin: dirty\n', stderr: '' },
  })
  const { answer, passed } = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(PASSING))
  expect(answer).toBe(passed)
  // The shell gate's own stamp file, shared: epoch seconds and a newline, before the run.
  expect(Object.keys(fx.wrote)).toContain(STAMP)
  expect(fx.wrote[STAMP]).toMatch(/^\d{10}\n$/)
  expect(fx.stamp.atRun).toBe(fx.wrote[STAMP])
  expect(sweepLine(fx.ran)).toContain(`bash ${WORKSPACE} sweep --deadline`)
  expect(fx.written.some(l => l.includes('sweep deleted /tmp/h/work/repo/belt'))).toBe(true)
  expect(fx.written.some(l => l.includes('kept'))).toBe(false)
})

test('a sweep that overruns lets the stop answer on time, said once, the stamp already written', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({
    stampMtimeMs: OLD_STAMP, hangSweep: true, env: { ORCHESTRATOR_STOP_GATE_DEADLINE: '5' },
  })
  const e = stopEvent(PASSING)
  const started = Date.now()
  const { answer } = await stop(handlers['classic.Stop'], fx.dollar, e)
  expect(answer).toBe(e)
  expect(Date.now() - started).toBeLessThan(10000)
  expect(fx.written.filter(l => l.includes('did not finish within')).length).toBe(1)
  // The stamp was written before a run that never answers: the next stop will not retry it.
  expect(fx.stamp.atRun).toMatch(/^\d{10}\n$/)
})

test('no time left in the deadline skips the sweep silently', async () => {
  const { handlers } = mounted()
  const { dollar, ran, wrote, written } = fakeDollar({
    stampMtimeMs: OLD_STAMP, env: { ORCHESTRATOR_STOP_GATE_DEADLINE: '2' },
  })
  const { answer, passed } = await stop(handlers['classic.Stop'], dollar, stopEvent(PASSING))
  expect(answer).toBe(passed)
  expect(sweepLine(ran)).toBeUndefined()
  expect(wrote[STAMP]).toBeUndefined()
  expect(written.filter(l => l.includes('sweep')).length).toBe(0)
})

test('the interval is read from the environment, a longer one holding the sweep back', async () => {
  const { handlers } = mounted()
  const { dollar, ran, wrote } = fakeDollar({ stampMtimeMs: OLD_STAMP, env: { ORCHESTRATOR_SWEEP_INTERVAL: '1200' } })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(sweepLine(ran)).toBeUndefined()
  expect(wrote[STAMP]).toBeUndefined()
})

test('an observed stop sweeps as any stop that passes', async () => {
  const { handlers } = mounted()
  const { dollar, ran } = fakeDollar({ stampMtimeMs: OLD_STAMP })
  // A turn with no wait declared, and nothing the host lists in flight, is what the gate once refused.
  const observed = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: 'waiting: operater blocks x', background_tasks: [], session_crons: [] }))
  expect(observed.observed).toContain('Nothing will wake you')
  expect(sweepLine(ran)).toBeDefined()
})

test('a session outside the orchestration runs no sweep', async () => {
  const { handlers } = mounted()
  const { dollar, ran, wrote } = fakeDollar({ stampMtimeMs: OLD_STAMP, launchName: 'Agent: belt' })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(sweepLine(ran)).toBeUndefined()
  expect(wrote[STAMP]).toBeUndefined()
})

test('a stop the gate could not read through still sweeps — the shell gate\'s own finally', async () => {
  const { handlers } = mounted()
  const { dollar, ran, wrote } = fakeDollar({ stampMtimeMs: OLD_STAMP, failCiList: true })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(sweepLine(ran)).toBeDefined()
  expect(wrote[STAMP]).toMatch(/^\d{10}\n$/)
})

test('a sweep that fails is said with its first stderr line', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    stampMtimeMs: OLD_STAMP,
    sweep: { exitCode: 3, stdout: '', stderr: 'kept /tmp/h/work/repo/pin: no pull request\nand more\n' },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('sweep error exit 3: kept /tmp/h/work/repo/pin: no pull request'))).toBe(true)
  expect(written.some(l => l.includes('and more'))).toBe(false)
})

// --- fix round 2: the scope of the telling, the record's codec, the dropped lines ------

test('a failing check named beyond latin-1 is told once for its tell', async () => {
  const { handlers } = mounted()
  const message = { last_assistant_message: ASKED + '\nwaiting: operator — blocks: the report' }
  // One pending check beside the failing one: the record keeps the pending state and
  // the failing SET, and the next stop compares that set — where the codec shows.
  const log = 'build\tpending\t9\tu\n🚀 deploy\tfail\t30\tu\n'
  const first = fakeDollar({ ciLogs: { 'here-pr161.log': { mtimeMs: 1728000000000, text: log }, 'here-pr161.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } } })
  const held = await stop(handlers['classic.Stop'], first.dollar, stopEvent(message))
  expect(held.observed).toContain('🚀 deploy')
  // The record carries the name as its UTF-8 bytes; the next stop at the same tell
  // decodes the same set back and does not refuse again — the once-per-tell law.
  const second = fakeDollar({
    ciLogs: { 'here-pr161.log': { mtimeMs: 1728000000000, text: log }, 'here-pr161.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } }, heads: first.wrote[HEADS],
  })
  const passed = await stop(handlers['classic.Stop'], second.dollar, stopEvent(message))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
})

test("another session's watch never refuses this stop", async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    origin: 'git@github.com:me/belt.git',
    ciLogs: {
      'other_repo-pr99.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' },
      'other_repo-pr99.log.session': { mtimeMs: 1728000000000, text: 'zz9999\n' },
    },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.filter(l => l.includes('#99')).length).toBe(0)
})

test("this session's watches are told whatever repository they name", async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({
    origin: 'git@github.com:me/belt.git',
    ciLogs: {
      'far_repo-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' },
      'far_repo-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' },
      'here-pr161.log': { mtimeMs: 1728000000000, text: 'test\tfail\t30\tu\n' }, 'here-pr161.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' },
    },
  })
  const held = await stop(handlers['classic.Stop'], dollar, stopEvent(PASSING))
  expect(held.observed).toContain('#160')
  expect(held.observed).toContain('#161')
})

test('a stop without ITERM_SESSION_ID is told that no chain entry is counted', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({ env: { ITERM_SESSION_ID: '' } })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('ITERM_SESSION_ID is not set: no chain entry is counted'))).toBe(true)
})

test('ignored-checks says its malformed lines and still filters the well-formed ones', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    origin: 'git@github.com:me/belt.git',
    ignoredText: 'me/belt build\nno-slash-name\n',
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tfail\t30\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('ignored-checks malformed line: no-slash-name'))).toBe(true)
})

test('a repository that cannot be read filters nothing and is said', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    ignoredText: 'me/belt build\n',
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tfail\t30\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
  })
  const held = await stop(handlers['classic.Stop'], dollar, stopEvent(PASSING))
  expect(held.observed).toContain('1 failing (build)')
  expect(written.some(l => l.includes('ignored-checks repository unread'))).toBe(true)
})

test('an ignored-checks file that cannot be read is said, and filters nothing', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    failIgnoredRead: true,
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tfail\t30\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
  })
  const held = await stop(handlers['classic.Stop'], dollar, stopEvent(PASSING))
  expect(held.observed).toContain('1 failing (build)')
  expect(written.some(l => l.includes('ignored-checks unreadable'))).toBe(true)
})

test('a sweep that cannot start is said with its own failure', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({ stampMtimeMs: OLD_STAMP, sweepStartFail: true })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('sweep error spawn bash ENOENT'))).toBe(true)
  expect(written.some(l => l.includes('did not finish within'))).toBe(false)
})

test('a heads record that cannot be written lets the stop pass and is said', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    hangHeadsWrite: true, env: { ORCHESTRATOR_STOP_GATE_DEADLINE: '0.05' },
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('the reported heads unread: the write did not answer in time'))).toBe(true)
})

test('a ci-watch log that cannot be read lets the stop pass and is said', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    failLogRead: true,
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('the ci-watch log here-pr160.log unread: EIO: the log cannot be read'))).toBe(true)
})

test('a stop with no session id passes, said once', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({})
  const e = stopEvent({ ...PASSING, session_id: '' })
  const { answer, passed } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(passed)
  expect(written.filter(l => l.includes('no session id: the reported heads cannot be kept')).length).toBe(1)
})

// --- the state root's override ----------------------------------------------------------------

test('the state root follows ORCHESTRATOR_STATE_DIR, the module\'s own log staying in the config dir', async () => {
  // The writers that survive the shell gate — the launcher's dispatch tool, ci-watch —
  // honor the override before the config dir, the resolution the shell gate always had;
  // the module resolves the same root or check 2 reads no watch and the open rows vanish
  // (the reviewed boundary this wiring closes). Everything the root carries moves as one:
  // the registry, the ci-watch logs, the heads record, the sweep stamp. The module's own
  // log is config-dir-bound and moves with nothing. Without the override every test above
  // pins the config-dir root; this one pins the branch the override selects.
  const { handlers } = mounted()
  const OVER = '/tmp/h/over'
  const message = { last_assistant_message: ASKED + '\nwaiting: operator — blocks: the report' }
  const watched = fakeDollar({
    env: { ORCHESTRATOR_STATE_DIR: OVER },
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
  })
  const held = await stop(handlers['classic.Stop'], watched.dollar, stopEvent(message))
  expect(held.observed).toContain('#160')
  expect(watched.wrote[`${OVER}/stop-gate/a1b2c3.mheads`]).toBe(`160 ${logTell('build\tpending\t9\tu\n')} pending\n`)
  // The journal is the config dir's, as the module's log: every other write moves with the root.
  expect(Object.keys(watched.wrote).filter(p => !p.includes('/.claude/orchestrator/journal/')).every(p => p.startsWith(OVER))).toBe(true)
  // The observation's own three lines land in the module's log — the blocks line, the
  // ci-not-finished one, the let-through — which the config dir still holds.
  expect(watched.written.length).toBe(3)
  expect(watched.written.every(l => l.includes('| guards |'))).toBe(true)
  expect(watched.written.some(l => l.includes('check1 blocks the report'))).toBe(true)
  expect(watched.written.some(l => l.includes('ci-not-finished'))).toBe(true)
  // The open rows move with the root too: a registry under the override holds the stop.
  const deferred = fakeDollar({
    env: { ORCHESTRATOR_STATE_DIR: OVER },
    records: ['{"id":"r-12","label":"the report row","state":"open"}\n'],
  })
  const rows = await stop(handlers['classic.Stop'], deferred.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect(rows.observed).toContain('row r-12 (the report row) is open')
  // A due sweep's stamp is the shell gate's own file, written under the same root.
  const swept = fakeDollar({ env: { ORCHESTRATOR_STATE_DIR: OVER }, stampMtimeMs: OLD_STAMP })
  const passed = await stop(handlers['classic.Stop'], swept.dollar, stopEvent(message))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
  expect(swept.wrote[`${OVER}/sweep.stamp`]).toMatch(/^\d{10}\n$/)
  expect(swept.wrote[`${OVER}/stop-gate/a1b2c3.mheads`]).toBe('')
})

test("an agent whose tab still reads idle but whose session the host records busy releases the stop", async () => {
  // Live finding: a freshly spawned agent's tab reads ✳ through its first half-minute of
  // work, and the gate refused its orchestrator's stop on it. The host's own record of
  // the session (<config dir>/sessions/<pid>.json) says busy for the whole turn.
  const { handlers } = mounted()
  const chain = '{"tab_id":"T1","tty":"/dev/ttys003","owner":"17"}\n'
  const busy = fakeDollar({ listing: IDLE_ROW, chain, hostRecord: '{"pid":77,"status":"busy"}' })
  const released = await stop(handlers['classic.Stop'], busy.dollar, stopEvent({}))
  expect(released.answer).toBe(released.passed)
  expect(released.observed).toBeUndefined()
  // Recorded idle, or with no record at all, the glyph's idle stands and the log says so.
  const idle = fakeDollar({ listing: IDLE_ROW, chain, hostRecord: '{"pid":77,"status":"idle"}' })
  await warnsNotRefuses(handlers, idle, stopEvent({}), 'idle-agents Agent: idle-p3')
  const none = fakeDollar({ listing: IDLE_ROW, chain })
  await warnsNotRefuses(handlers, none, stopEvent({}), 'idle-agents Agent: idle-p3')
})

// --- fix round 3: the gh read, the identity rule, the succession, the block, the watch ----

const IDLE_OWNED = '{"tab_id":"T1","tty":"/dev/ttys003","owner":"17"}\n'

test("the idle agent's pull request is read with one --json argument, in the agent's checkout", async () => {
  // gh reads a second word after --json as a second positional and exits 1: every idle
  // agent read as having no pull request, and « Stand it down » never fired.
  const { handlers } = mounted()
  const fx = fakeDollar({
    listing: IDLE_ROW, chain: IDLE_OWNED,
    agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', prAnswer: '{"number":160,"state":"OPEN"}',
  })
  await stop(handlers['classic.Stop'], fx.dollar, stopEvent({}))
  const gh = 'gh pr view feat/belt --json number,state'
  expect(fx.ran).toContain(gh)
  expect(fx.inits[gh]?.cwd).toBe('/tmp/h/work/belt')
  expect(fx.inits[gh]?.timeoutMs).toBeGreaterThan(0)
})

test('the agent on a tty is found by its host record, or by the basename of an absolute host path', async () => {
  // HOST_CLI an absolute path and the agent typed as a bare name: the old pattern
  // matched only the exact path and found no agent process on the tty.
  const { handlers } = mounted()
  const pr = { agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', prAnswer: '{"number":160,"state":"MERGED"}' }
  const bare = fakeDollar({ ...pr, listing: IDLE_ROW, chain: IDLE_OWNED, agentRow: '   77 hostcli --resume x\n', selfBin: '/opt/homebrew/bin/hostcli', env: { ORCHESTRATOR_HOST_CLI: '/opt/homebrew/bin/hostcli' } })
  await warnsNotRefuses(handlers, bare, stopEvent({}), 'idle-delivered Agent: idle-p3 (pull request #160, MERGED)')
  const wrapped = fakeDollar({ ...pr, listing: IDLE_ROW, chain: IDLE_OWNED, agentRow: '   77 /usr/bin/node /x/cli.js\n', hostRecord: '{"pid":77,"sessionId":"s-a","status":"idle"}' })
  await warnsNotRefuses(handlers, wrapped, stopEvent({}), 'idle-delivered Agent: idle-p3 (pull request #160, MERGED)')
})

test("a declared block is honoured before « stand it down »: the idle agent may wait on that answer", async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({
    listing: IDLE_ROW, chain: IDLE_OWNED,
    agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', prAnswer: '{"number":160,"state":"OPEN"}',
  })
  const outcome = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: ASKED + '\nwaiting: operator — blocks: the choice of A or B' }))
  expect(outcome.answer).toBe(outcome.passed)
  expect(outcome.observed).toBeUndefined()
})

test('the predecessor of a succession may stop on its done once it handed over', async () => {
  const { handlers } = mounted()
  const open = { records: ['{"id":"r-12","label":"the report row","state":"open"}\n'] }
  // Before the hand-over, a done line is held on the rows still open.
  const before = fakeDollar(open)
  expect((await stop(handlers['classic.Stop'], before.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))).observed).toContain('row r-12')
  // The successor's spawn, run through Bash without error, is the hand-over.
  const spawn = { tool: 'Bash', tool_use_id: 't9', command: 'bash /plugins/orch-root/skills/iterm-agents/scripts/iterm-agent.sh spawn --successor --title "Orch: belt"' }
  await handlers['tool.call'](before.dollar, spawn, async () => ({ result: { stdout: 'spawned' } }))
  const after = fakeDollar(open)
  const done = await stop(handlers['classic.Stop'], after.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect(done.answer).toBe(done.passed)
  expect(done.observed).toBeUndefined()
})

test('a successor spawn that failed hands nothing over', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ records: ['{"id":"r-12","label":"the report row","state":"open"}\n'] })
  const spawn = { tool: 'Bash', tool_use_id: 't9', command: 'bash iterm-agent.sh spawn --successor' }
  await handlers['tool.call'](fx.dollar, spawn, async () => ({ isError: true, result: 'never started', text: 'Exit code 1' }))
  expect((await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))).observed).toContain('row r-12')
})

// Live, both sides of a succession were refused « Nothing will wake you » while each waited on
// the other: the predecessor for « takeover confirmed » after its successor's spawn, the
// successor for « handed over ». A peer's idle notice the session subscribed to wakes it as a
// busy agent's would, until that notice or a message from the peer arrives; and a session
// that handed over is never told nothing will wake it.
test('the predecessor that spawned its successor is never told nothing will wake it', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({})
  const spawn = { tool: 'Bash', tool_use_id: 't9', command: 'bash /plugins/orch-root/skills/iterm-agents/scripts/iterm-agent.sh spawn --successor --title "Orch: belt"' }
  await handlers['tool.call'](fx.dollar, spawn, async () => ({ result: { stdout: 'spawned' } }))
  const waiting = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'Successor spawned; waiting for its « takeover confirmed ».' }))
  expect(waiting.answer).toBe(waiting.passed)
  expect(waiting.observed).toBeUndefined()
})

const SUBSCRIBE = { tool: 'SendMessage', tool_use_id: 't7', to: 'Orch: belt [b7f1]', message: 'takeover confirmed', notify_when_idle: true }
const SENT = async () => ({ result: { delivered: true } })
const WAITING = { last_assistant_message: 'Takeover confirmed sent; waiting for « handed over ».' }

test("a peer's idle notice the session subscribed to will wake it, until the notice arrives", async () => {
  const { handlers, matchers } = mounted()
  expect(matchers['tool.call:SendMessage']).toEqual({ tool: 'SendMessage' })
  const fx = fakeDollar({})
  // Not subscribed: the log says nothing will wake it.
  await handlers['tool.call:SendMessage'](fx.dollar, { ...SUBSCRIBE, notify_when_idle: false }, SENT)
  await warnsNotRefuses(handlers, fx, stopEvent(WAITING), 'nothing-will-wake')
  await handlers['tool.call:SendMessage'](fx.dollar, SUBSCRIBE, SENT)
  const held = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(WAITING))
  expect(held.answer).toBe(held.passed)
  expect(held.observed).toBeUndefined()
  // A prompt from someone else leaves the subscription standing.
  await handlers['prompt.submit'](fx.dollar, { text: 'what is the state?', origin: { kind: 'composer' } }, through)
  const still = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(WAITING))
  expect(still.answer).toBe(still.passed)
  expect(still.observed).toBeUndefined()
  // The peer's message arrives: the wait is over, and the gate reads the session again.
  await handlers['prompt.submit'](fx.dollar, { text: 'Message from Orch: belt [b7f1]: handed over', origin: { kind: 'peer-send-message' } }, through)
  await warnsNotRefuses(handlers, fx, stopEvent(WAITING), 'nothing-will-wake')
})

test('a subscription a subagent made, or one whose send failed, wakes nothing', async () => {
  const { handlers } = mounted()
  const sub = fakeDollar({})
  await handlers['tool.call:SendMessage'](sub.dollar, { ...SUBSCRIBE, agentId: 'a-1' }, SENT)
  await warnsNotRefuses(handlers, sub, stopEvent(WAITING), 'nothing-will-wake')
  const failed = fakeDollar({})
  await handlers['tool.call:SendMessage'](failed.dollar, SUBSCRIBE, async () => ({ isError: true, result: 'no such peer' }))
  await warnsNotRefuses(handlers, failed, stopEvent(WAITING), 'nothing-will-wake')
})

test('a subscription past its time-to-live wakes nothing: a notice that never comes holds no gate open', () => {
  const peers = new Map([['Orch: belt', 1_000], ['Agent: x', 1_000 + NOTICE_TTL_MS]])
  expect(awaitingAny(peers, 1_000 + NOTICE_TTL_MS)).toBe(true)
  expect(awaitingAny(peers, 1_001 + NOTICE_TTL_MS)).toBe(true)
  expect([...peers.keys()]).toEqual(['Agent: x'])
  expect(awaitingAny(peers, 2_001 + 2 * NOTICE_TTL_MS)).toBe(false)
  expect(NOTICE_TTL_MS).toBe(2 * 60 * 60 * 1000)
})

test("a notice is the awaited peer's when it names it, by name or by reference", () => {
  expect(noticeFrom('Orch: belt [b7f1]', 'Orch: belt is idle', 'unclassified')).toBe(true)
  expect(noticeFrom('Orch: belt [b7f1]', 'session b7f1 exited', 'unclassified')).toBe(true)
  expect(noticeFrom('Orch: belt', 'handed over — Orch: belt', 'peer')).toBe(true)
  expect(noticeFrom('Orch: belt', 'handed over — Orch: belt', 'peer-send-message')).toBe(true)
  // The operator's own words, a stranger's message, a delivery receipt: not the notice.
  expect(noticeFrom('Orch: belt', 'is Orch: belt idle?', 'composer')).toBe(false)
  expect(noticeFrom('Orch: belt', 'Agent: x is idle', 'unclassified')).toBe(false)
  expect(noticeFrom('Orch: belt', 'Message delivered to Orch: belt', 'unclassified')).toBe(false)
})

test('the wake decision: an awaited notice wakes, and a handed-over session is never told nothing will', () => {
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting for it', awaiting: true })).toBeNull()
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting for it', handedOver: true })).toBeNull()
  // A delivered idle agent is still told: a subscription does not lift it.
  expect(fieldsIn(checkWake({ agents: [{ label: 'Agent: a', state: 'idle', tty: '/dev/ttys003' }], resident: false, delivered: ['Agent: a (pull request #1, MERGED)'], message: 'x', awaiting: true })).warn).toBe('idle-delivered')
})

test('a ci-watch this session started, still running, will wake it; a stranger\'s will not', async () => {
  const { handlers } = mounted()
  // The session's host is pid 501 on ttys001; its background shell 800 runs the watch.
  const own = fakeDollar({ ps: `  800   501 /bin/zsh -c bash ${CI_WATCH} 160\n  900   800 /bin/bash ${CI_WATCH} 160\n` })
  const released = await stop(handlers['classic.Stop'], own.dollar, stopEvent({}))
  expect(released.answer).toBe(released.passed)
  expect(released.observed).toBeUndefined()
  const stranger = fakeDollar({ ps: `  900   1 /bin/bash ${CI_WATCH} 160\n` })
  await warnsNotRefuses(handlers, stranger, stopEvent({}), 'nothing-will-wake')
})

test('a failing set is told once per watch, whatever the log\'s mtime does while the watch appends', async () => {
  const { handlers } = mounted()
  const message = { last_assistant_message: ASKED + '\nwaiting: operator — blocks: the report' }
  const at = (mtimeMs: number, text: string) => ({ 'here-pr160.log': { mtimeMs, text }, 'here-pr160.log.session': { mtimeMs, text: 'a1b2c3\n' } })
  const first = fakeDollar({ ciLogs: at(1, 'build\tpending\t9\tu\ntest\tfail\t30\tu\n') })
  expect((await stop(handlers['classic.Stop'], first.dollar, stopEvent(message))).observed).toContain('1 failing (test)')
  // Ten seconds on the watch appended a snapshot: a new mtime, the same failing set.
  const later = fakeDollar({ ciLogs: at(2, 'build\tpending\t9\tu\ntest\tfail\t30\tu\nbuild\tpending\t19\tu\n'), heads: first.wrote[HEADS] })
  const passed = await stop(handlers['classic.Stop'], later.dollar, stopEvent(message))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
  // A new watch (a new head) truncates the log: a new first line, told again.
  const fresh = fakeDollar({ ciLogs: at(3, 'build\tpending\t2\tv\ntest\tfail\t4\tv\n'), heads: later.wrote[HEADS] })
  expect((await stop(handlers['classic.Stop'], fresh.dollar, stopEvent(message))).observed).toContain('#160')
})

test('the successor spawn is the launcher\'s spawn with --successor alone', () => {
  expect(isSuccessorSpawn('bash /p/skills/iterm-agents/scripts/iterm-agent.sh spawn --successor --title "Orch: x"')).toBe(true)
  expect(isSuccessorSpawn('python3 -I /p/iterm_agent.py spawn --successor')).toBe(true)
  expect(isSuccessorSpawn('bash /p/iterm-agent.sh spawn --title "Agent: x"')).toBe(false)
  expect(isSuccessorSpawn('bash /p/iterm-agent.sh list # --successor')).toBe(false)
  expect(isSuccessorSpawn('grep -n successor notes.md')).toBe(false)
})

test('own watches are the ci-watches whose parents reach the host process', () => {
  const rows = processTable(`  501     1 hostcli\n  800   501 /bin/zsh -c x\n  900   800 /bin/bash ${CI_WATCH} 160\n  901     1 /bin/bash ${CI_WATCH} 161\n`)
  expect([...ownWatches(rows, '501')]).toEqual(['160'])
  expect([...ownWatches(rows, null)]).toEqual([])
})

test('the wake decision: handed over, a block before a delivered agent, a watch as a waker', () => {
  const idle = [{ label: 'Agent: a', state: 'idle' as const, tty: '/dev/ttys003' }]
  expect(checkWake({ agents: [], resident: false, delivered: [], message: '`handed over`.' })).toEqual({ warn: 'nothing-will-wake', detail: '' })
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting: done', handedOver: true })).toBeNull()
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting: done' })).toBe('read-what-is-left')
  expect(checkWake({ agents: idle, resident: false, delivered: ['Agent: a (pull request #1, MERGED)'], message: 'waiting: operator — blocks: x' })).toEqual({ blocks: 'x' })
  expect(fieldsIn(checkWake({ agents: idle, resident: false, delivered: ['Agent: a (pull request #1, MERGED)'], message: 'done', watching: true })).warn).toBe('idle-delivered')
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting on CI', watching: true })).toBeNull()
  // A bare question declares no wait: it wakes nothing.
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'You decide: A or B?' })).toEqual({ warn: 'nothing-will-wake', detail: '' })
})

// --- the spec's goals (goals.md beside a registered record) --------------------------------

// A build was declared done against its plan while the plan had moved three of the spec's
// five goals « after the build ». The done branch now reads goals.sh check over each goals.md
// beside a registered record, and refuses while a goal is open or the file does not hold.
const goalsAnswer = (over: Record<string, unknown> = {}) => JSON.stringify({
  ok: false, open: ['G3'], unplanned: ['G3'], faults: [], notes: [], rows: 5, met: 3, ruled_out: 1,
  table: '| id | status |\n| G3 | open |', ...over,
})
const OPEN_GOALS = { exitCode: 1, stdout: goalsAnswer() }
const ALL_MET = { exitCode: 0, stdout: goalsAnswer({ ok: true, open: [], unplanned: [], table: '| G1 | met |' }) }
const DONE = { last_assistant_message: 'All five goals hold.\nwaiting: done' }
const NO_ROWS = { records: [''] }

test('the done branch names open goals and faults in their own texts, after what is left and the rows', () => {
  const open = checkWakeDone({ agents: [], checkouts: [], deferred: [], goalsOpen: ['G3', 'G4'] })
  expect(open?.reason).toBe('Not done against the spec: G3, G4 open. Dispatch the work that meets it and record its evidence '
    + '(dispatch-record.sh goals <record> met <G> --evidence …), or put it to the operator when he has not ruled, '
    + 'with an operator wait that blocks on <G> — or, if he deferred it, record his ruling with '
    + 'dispatch-record.sh goals <record> defer <G> --ruling "<his words, dated>" and declare a deferred wait.')
  const faulty = checkWakeDone({ agents: [], checkouts: [], deferred: [], goalsFaults: ['G1 met without evidence on disk: x does not exist', '4 rows, the spec\'s Goals list 5'] })
  expect(faulty?.reason).toBe("goals.md is not a record of the spec: G1 met without evidence on disk: x does not exist; 4 rows, the spec's Goals list 5.")
  const all = checkWakeDone({ agents: [AGENT_IDLE], checkouts: ['/tmp/c'], deferred: ['r-1 (x)'], goalsOpen: ['G3'], goalsFaults: ['G4 ruled out without the operator\'s words'] })!
  const at = (needle: string) => all.reason.indexOf(needle)
  expect(at('/tmp/c')).toBe(-1)
  expect(at('Agent: idle-p3 is still there')).toBeGreaterThanOrEqual(0)
  expect(at('row r-1 (x) is open')).toBeGreaterThan(at('Agent: idle-p3 is still there'))
  expect(at('Not done against the spec: G3')).toBeGreaterThan(at('row r-1 (x) is open'))
  expect(at('goals.md is not a record')).toBeGreaterThan(at('Not done against the spec'))
  expect(checkWakeDone({ agents: [], checkouts: [], deferred: [], goalsOpen: [], goalsFaults: [] })).toBeNull()
})

test('goals.sh check --json is parsed, and anything else is no reading', () => {
  expect(parseGoalsCheck('/r/goals.md', goalsAnswer())?.open).toEqual(['G3'])
  expect(parseGoalsCheck('/r/goals.md', 'Traceback')).toBeNull()
  expect(parseGoalsCheck('/r/goals.md', '{"ok":false,"error":"cannot read"}')).toBeNull()
  expect(goalsPaths(['/a/rec.jsonl', '/a/other.jsonl', '/b/rec.jsonl', ''])).toEqual(['/a/goals.md', '/b/goals.md'])
})

test('a registered record whose goals.md holds an open goal refuses waiting: done, naming it', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ ...NO_ROWS, goals: OPEN_GOALS })
  const held = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(DONE))
  expect(held.observed).toContain('Not done against the spec: G3 open')
  expect(fx.ran).toContain(`bash ${GOALS_SH} check ${GOALS_FILE} --json`)
})

test('the same goals, all met, pass at once: the operator is not shown their table first', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ ...NO_ROWS, goals: ALL_MET })
  const passed = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(DONE))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
  expect(fx.wrote[`${STATE}/stop-gate/a1b2c3.goals`]).toBeUndefined()
})

test('a declared block passes with goals open, and the goals are never read', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ ...NO_ROWS, goals: OPEN_GOALS })
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: ASKED + '\nwaiting: operator — blocks: G3: plan it or rule it out' }))
  expect(out.answer).toBe(out.passed)
  expect(out.observed).toBeUndefined()
  expect(fx.ran.some(l => l.startsWith('python3'))).toBe(false)
})

test('a predecessor that handed over passes with goals open, the goals never read', async () => {
  const { handlers } = mounted()
  const last = fakeDollar({ ...NO_ROWS, goals: OPEN_GOALS })
  const over = await stop(handlers['classic.Stop'], last.dollar, stopEvent({ last_assistant_message: 'handed over' }))
  expect(over.answer).toBe(over.passed)
  expect(over.observed).toBeUndefined()
  expect(last.ran.some(l => l.startsWith('python3'))).toBe(false)
  const spawned = fakeDollar({ ...NO_ROWS, goals: OPEN_GOALS })
  const spawn = { tool: 'Bash', tool_use_id: 't9', command: 'bash /plugins/orch-root/skills/iterm-agents/scripts/iterm-agent.sh spawn --successor --title "Orch: belt"' }
  await handlers['tool.call'](spawned.dollar, spawn, async () => ({ result: { stdout: 'spawned' } }))
  const done = await stop(handlers['classic.Stop'], spawned.dollar, stopEvent(DONE))
  expect(done.answer).toBe(done.passed)
  expect(done.observed).toBeUndefined()
  expect(spawned.ran.some(l => l.startsWith('python3'))).toBe(false)
})

test('an agent session with open goals stops untouched, nothing read', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ ...NO_ROWS, goals: OPEN_GOALS, launchName: 'Agent: belt' })
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(DONE))
  expect(out.answer).toBe(out.passed)
  expect(out.observed).toBeUndefined()
  expect(fx.ran.some(l => l.startsWith('python3'))).toBe(false)
})

test('no record registered: the done passes and no goals check runs', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ goals: OPEN_GOALS })
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(DONE))
  expect(out.answer).toBe(out.passed)
  expect(out.observed).toBeUndefined()
  expect(fx.ran.some(l => l.startsWith('python3'))).toBe(false)
})

test('a legacy record with no goals.md passes and is said in one line', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar(NO_ROWS)
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(DONE))
  expect(out.answer).toBe(out.passed)
  expect(out.observed).toBeUndefined()
  expect(fx.written.filter(l => l.endsWith('| stop gate: /tmp/h/rec has no goals.md')).length).toBe(1)
  expect(fx.ran.some(l => l.startsWith('python3'))).toBe(false)
})

test('a goals check that hangs or exits 2 lets the stop pass, said, and still sweeps', async () => {
  const { handlers } = mounted()
  const broken = fakeDollar({ ...NO_ROWS, goals: { exitCode: 2, stdout: '{"ok":false,"error":"x"}' }, stampMtimeMs: Date.now() - 3600 * 1000 })
  const out = await stop(handlers['classic.Stop'], broken.dollar, stopEvent(DONE))
  expect(out.answer).toBe(out.passed)
  expect(out.observed).toBeUndefined()
  expect(broken.written.some(l => l.endsWith(`| stop gate: goals unread: ${GOALS_FILE}: it exited 2`))).toBe(true)
  expect(broken.ran.some(l => l.includes('workspace.sh sweep'))).toBe(true)
  const hung = fakeDollar({ ...NO_ROWS, goals: 'hang', env: { ORCHESTRATOR_STOP_GATE_DEADLINE: '0.2' } })
  const late = await stop(handlers['classic.Stop'], hung.dollar, stopEvent(DONE))
  expect(late.answer).toBe(late.passed)
  expect(late.observed).toBeUndefined()
  expect(hung.written.some(l => l.includes('goals unread') || l.includes('did not answer in time'))).toBe(true)
})

test('the stop re-fired this turn passes with goals open, nothing read', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ ...NO_ROWS, goals: OPEN_GOALS })
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ ...DONE, stop_hook_active: true }))
  expect(out.answer).toBe(out.passed)
  expect(out.observed).toBeUndefined()
  expect(fx.ran.length).toBe(0)
})

// --- what a turn truly waits on ------------------------------------------------------------

// An orchestrator whose turn waited on a monitor it had started, no agent busy, was refused
// every stop until its last line read `waiting: operator — blocks: …` or `waiting: done`:
// only a ci-watch counted as something running, so each monitor event woke a turn the gate
// sent back, and every one of them ended on a wait for the operator that asked him nothing.
const SNAPSHOT = '/bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && '
const shellOf = (command: string) => `${SNAPSHOT}eval '${command}' < /dev/null && pwd -P >| /tmp/x-cwd`
const MONITOR_PS = `  800   501 ${shellOf('tail -f deploy.log | grep --line-buffered done')}\n  801   800 tail -f deploy.log\n`

test('own background processes are the host shells under the host process, what each runs named', () => {
  const rows = processTable([
    '  501     1 hostcli',
    `  800   501 ${shellOf('sleep 300')}`,
    '  801   800 sleep 300',
    `  810   501 ${shellOf(`python3 - <<'"'"'EOF'"'"'\\012print(1)\\012EOF`)}`,
    `  820     1 ${shellOf('sleep 9')}`,
    '  830   501 caffeinate -i -t 300',
    '  840   501 ps -axo pid=,ppid=,command=',
    `  850   501 /bin/zsh -c x`,
    `  851   850 /bin/bash ${CI_WATCH} 160`,
  ].join('\n') + '\n')
  expect(ownBackground(rows, '501')).toEqual(['sleep 300', "python3 - <<'EOF' print(1) EOF", `ci-watch.sh 160`])
  expect(ownBackground(rows, null)).toEqual([])
})

test('a stop that ends on no machine line while a background process of the session runs passes', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ ps: MONITOR_PS })
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'Both deploys are running; the monitor will tell.' }))
  expect(out.answer).toBe(out.passed)
  expect(out.observed).toBeUndefined()
})

// The host's own list of the session's background work, carried on the stop, decides what will
// wake it; the process table only adds to it.
const SHELL_TASK = { id: 'b1', type: 'shell', status: 'running', description: 'deploy', command: 'bash deploy.sh' }
const NOTHING_PS = `  820     1 ${shellOf('sleep 9')}\n`

test('the host task list names each task by what it runs, and is null when the host gives none', () => {
  expect(hostTasks(undefined, [])).toBe(null)
  expect(hostTasks('x', undefined)).toBe(null)
  expect(hostTasks([], undefined)).toEqual([])
  expect(hostTasks([SHELL_TASK, { id: 'a', type: 'subagent', status: 'running', description: 'search' }, { id: 'm', type: 'monitor', status: 'running', description: '' }, null], [{ schedule: '0 9 * * *' }, {}]))
    .toEqual(['bash deploy.sh', 'search', 'monitor', 'a scheduled wake-up (0 9 * * *)', 'a scheduled wake-up'])
})

// The host's list carries a status per task and only promises a string: a task it lists as
// finished wakes nothing. A status not known to be terminal, or none, still counts — a wrong
// list must never refuse a real wait.
test('the host task list leaves out a completed, failed, killed or stopped task', () => {
  const settled = ['completed', 'failed', 'killed', 'stopped'].map(status => ({ ...SHELL_TASK, status, command: `bash ${status}.sh` }))
  expect(hostTasks(settled, [])).toEqual([])
  expect(hostTasks([...settled, { ...SHELL_TASK, status: 'pending' }, { id: 'a', type: 'subagent', description: 'search' }], []))
    .toEqual(['bash deploy.sh', 'search'])
})

// A predecessor waiting on its successor's confirmation: its successor's « takeover confirmed » wakes it.
const SUCCESSOR_SPAWN = { tool: 'Bash', tool_use_id: 't9', command: 'bash /plugins/orch-root/skills/iterm-agents/scripts/iterm-agent.sh spawn --successor --title "Orch: belt"' }


// The plain ending with nothing to wake it is refused on the same list; without one it is only logged.
const PLAIN = { last_assistant_message: 'Both reviews are dispatched.' }

test('a plain ending is refused when the host lists nothing in flight, the short form first', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ ps: NOTHING_PS })
  const held = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ ...PLAIN, background_tasks: [], session_crons: [] }))
  const reason = String(held.observed)
  expect(reason.startsWith('Nothing will wake you')).toBe(true)
  expect(reason).toContain('run_in_background')
  expect(reason).toContain('declare done')
  expect(held.observed).toBeDefined()
  expect(fx.written.some(l => l.endsWith('| stop gate: check1 nothing-will-wake'))).toBe(true)
})

test('a plain ending passes while the host lists work in flight, and is refused once it completed', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ ps: NOTHING_PS })
  const running = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ ...PLAIN, background_tasks: [SHELL_TASK] }))
  expect(running.answer).toBe(running.passed)
  expect(running.observed).toBeUndefined()
  const done = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ ...PLAIN, background_tasks: [] }))
  expect(String(done.observed)).toContain('Nothing will wake you')
})

test('a plain ending passes with a subscription not yet fired, or after the hand-over, the host listing nothing', async () => {
  const subscribed = mounted()
  const fx = fakeDollar({ ps: NOTHING_PS })
  await subscribed.handlers['tool.call:SendMessage'](fx.dollar, SUBSCRIBE, SENT)
  const waiting = await stop(subscribed.handlers['classic.Stop'], fx.dollar, stopEvent({ ...PLAIN, background_tasks: [] }))
  expect(waiting.answer).toBe(waiting.passed)
  expect(waiting.observed).toBeUndefined()
  const handed = mounted()
  const hx = fakeDollar({ ps: NOTHING_PS })
  await handed.handlers['tool.call'](hx.dollar, SUCCESSOR_SPAWN, async () => ({ result: { stdout: 'spawned' } }))
  const after = await stop(handed.handlers['classic.Stop'], hx.dollar, stopEvent({ ...PLAIN, background_tasks: [] }))
  expect(after.answer).toBe(after.passed)
  expect(after.observed).toBeUndefined()
})

// A question still open in the round blocks only the work that depends on its answer: the turns that
// advance the rest end on no wait, the answer waking the session, never asked again.
test('a plain ending passes while the session\'s question is open in the round, the host listing nothing', async () => {
  const { handlers } = mounted()
  for (const ending of [PLAIN]) {
    const open = fakeDollar({ ps: NOTHING_PS, round: { 'q-a1b2c3-1.json': ASKED_HERE } })
    const waiting = await stop(handlers['classic.Stop'], open.dollar, stopEvent({ ...ending, background_tasks: [], session_crons: [] }))
    expect(waiting.answer).toBe(waiting.passed)
  expect(waiting.observed).toBeUndefined()
    const answered = fakeDollar({ ps: NOTHING_PS, round: { 'q-a1b2c3-1.json': askedHere({ status: 'answered', answer: { text: 'A', by: 'pane', at: '2026-11-14T10:05:00Z' } }) } })
    const held = await stop(handlers['classic.Stop'], answered.dollar, stopEvent({ ...ending, background_tasks: [], session_crons: [] }))
    expect(held.observed).toBeDefined()
  }
})

// Only this session's question wakes it: another session's open in the same round holds the stop
// as none would.
test('another session\'s question open in the round wakes no plain ending of this session', async () => {
  const { handlers } = mounted()
  for (const ending of [PLAIN]) {
    const other = fakeDollar({ ps: NOTHING_PS, round: { 'q-d4e5f6-1.json': askedHere({ id: 'q-d4e5f6-1', sender: { session: 'd4e5f6', name: 'Orch: other', role: 'orchestrator', machine: 'box-1' } }) } })
    const held = await stop(handlers['classic.Stop'], other.dollar, stopEvent({ ...ending, background_tasks: [], session_crons: [] }))
    expect(held.observed).toBeDefined()
  }
})

test('an open question wakes a plain ending, and a line spelling no machine line is no refusal of its own', () => {
  const base = { agents: [], resident: false, delivered: [], tasks: [] as string[], questionOpen: true }
  expect(checkWake({ ...base, message: PLAIN.last_assistant_message })).toBe(null)
  expect(fieldsIn(checkWake({ ...base, questionOpen: false, message: PLAIN.last_assistant_message })).case).toBe('nothing-will-wake')
  expect(checkWake({ ...base, message: 'Done.\nwaiting operatr blocks the order' })).toBe(null)
})

test('nothing will wake, decided over the facts with the host list', () => {
  const base = { agents: [], resident: false, delivered: [], message: 'stopped.' }
  expect(fieldsIn(checkWake({ ...base, tasks: [] })).case).toBe('nothing-will-wake')
  expect(checkWake({ ...base, tasks: ['sleep 90'] })).toBeNull()
  expect(checkWake({ ...base, tasks: hostTasks([], [{ id: 'c1', schedule: '0 9 * * *' }]) })).toBeNull()
  expect(checkWake({ ...base, tasks: [], background: ['tail -f deploy.log'] })).toBeNull()
  expect(checkWake({ ...base, tasks: [], watching: true })).toBeNull()
  expect(checkWake({ ...base, tasks: [], awaiting: true })).toBeNull()
  expect(checkWake({ ...base, tasks: [], agents: [AGENT_BUSY] })).toBeNull()
  expect(checkWake({ ...base, tasks: [], resident: true })).toBeNull()
  expect(checkWake({ ...base, tasks: [], handedOver: true })).toBeNull()
  // No list from the host: only logged, as before.
  expect(checkWake({ ...base, tasks: null })).toEqual({ warn: 'nothing-will-wake', detail: '' })
})


test('a wait on the operator that blocks nothing is refused, the right line named', () => {
  const base = { agents: [], resident: false, delivered: [] }
  for (const blocks of ['nothing', 'Nothing.', 'none', 'NONE', 'nothing yet', 'nothing to ask', 'none for now', 'nothing.', 'n/a', 'N/A', '-', '']) {
    const held = fieldsIn(checkWake({ ...base, message: `Watching the deploys.\nwaiting: operator — blocks: ${blocks}` }))
    expect([blocks, held.case]).toEqual([blocks, 'blocks-nothing'])
    expect(held.reason).toContain('declare done')
  }
  const urgent = fieldsIn(checkWake({ ...base, message: 'waiting: operator (urgent) — blocks: nothing.' }))
  expect(urgent.case).toBe('blocks-nothing')
  const running = fieldsIn(checkWake({ ...base, message: 'waiting: operator — blocks: nothing', background: ['tail -f deploy.log'] }))
  expect(running.reason).toContain('tail -f deploy.log runs in the background: declare no wait')
  const busy = fieldsIn(checkWake({ ...base, agents: [AGENT_BUSY], message: 'waiting: operator — blocks: none' }))
  expect(busy.case).toBe('blocks-nothing')
  expect(busy.reason).toContain('An agent of yours is busy: declare no wait')
  // What blocks something is still the operator's wait.
  expect(checkWake({ ...base, message: 'waiting: operator — blocks: nothing else than the merge' })).toEqual({ blocks: 'nothing else than the merge' })
  expect(checkWake({ ...base, message: 'waiting: operator — blocks: nothing but G5' })).toEqual({ blocks: 'nothing but G5' })
  expect(checkWake({ ...base, message: 'waiting: operator — blocks: none, except row 3' })).toEqual({ blocks: 'none, except row 3' })
  expect(checkWake({ ...base, message: 'waiting: operator — blocks: nothing before geonative-api#12' })).toEqual({ blocks: 'nothing before geonative-api#12' })
})


test('nothing to wake with no list from the host is flagged for the log and carries no refusal text', () => {
  const nothing = fieldsIn(checkWake({ agents: [], resident: false, delivered: [], message: 'stopped.' }))
  expect(nothing).toEqual({ warn: 'nothing-will-wake', detail: '' })
  expect(nothing.reason).toBeUndefined()
})

// --- work the operator deferred: the ending « waiting: deferred — <n> items » ------------------

// The operator ruled G5 and G6 « later, when I am on mini-tech »: the session had nothing left
// to do, and the gate's only ending for open work was a question to him, which raised an alert
// for a question that did not exist. A ruling that defers work is recorded (dispatch-record.sh
// defer, goals … defer), and the ending that fits is its own machine line, never a question.
const DEFERRED_ROW = '{"id":5,"label":"the mini-tech row","state":"open","deferred":"2026-10-29: later"}\n'
const DEFERRED_GOALS = { exitCode: 1, stdout: goalsAnswer({ open: [], deferred: ['G5', 'G6'], unplanned: [], table: '| G5 | deferred |' }) }
const DEFER_END = { last_assistant_message: 'All that can move has moved.\nwaiting: deferred — row 5, G5, G6' }

test('the deferred line is read with its ids, whatever the dash and the markup', () => {
  expect(deferredIds('waiting: deferred — G5, G6')).toBe('G5, G6')
  expect(deferredIds(machineLine('**waiting: deferred - row 5, G5.**'))).toBe('row 5, G5')
  expect(deferredIds('waiting: deferred')).toBeNull()
  expect(deferredIds('waiting: done')).toBeNull()
  expect(deferredIds('waiting: operator — blocks: deferred G5')).toBeNull()
})

test('open rows that carry a ruling are the deferred ones, still open', () => {
  const texts = [DEFERRED_ROW + '{"id":6,"label":"live","state":"open"}\n{"id":7,"label":"old","state":"closed","deferred":"x"}\n']
  expect(openRows(texts)).toEqual(['5 (the mini-tech row)', '6 (live)'])
  expect(deferredRows(texts)).toEqual(['5 (the mini-tech row)'])
})

test('the gate reads the deferred line as one that needs the facts of what is left', () => {
  const base = { agents: [], resident: false, delivered: [] }
  expect(checkWake({ ...base, message: 'waiting: deferred — G5, G6' })).toBe('read-what-is-left')
  // A busy agent of its own still wakes it, as with done.
  expect(checkWake({ ...base, agents: [AGENT_BUSY], message: 'waiting: deferred — G5' })).toBeNull()
})

test('a deferred ending passes when every open row and goal is deferred, and nothing else is left', () => {
  const left = { agents: [], checkouts: [], deferred: ['5 (the mini-tech row)'], deferredRows: ['5 (the mini-tech row)'], goalsOpen: [], goalsDeferred: ['G5', 'G6'], ending: 'deferred' as const }
  expect(checkWakeDone(left)).toBeNull()
})

test('a deferred ending is refused while an open row or goal is not deferred, naming it', () => {
  const left = { agents: [], checkouts: [], deferred: ['5 (a)', '6 (live)'], deferredRows: ['5 (a)'], goalsOpen: ['G4'], goalsDeferred: ['G5'], ending: 'deferred' as const }
  const held = checkWakeDone(left)!
  expect(held.reason).toContain('row 6 (live) is open')
  expect(held.reason).not.toContain('row 5 (a)')
  expect(held.reason).toContain('Not done against the spec: G4 open')
  expect(held.reason).toContain('record his ruling with dispatch-record.sh defer')
  expect(held.reason).toContain('goals <record> defer <G>')
  expect(held.reason).toContain('declare a deferred wait')
})

test('a deferred ending with nothing deferred is refused: the done line fits', () => {
  const held = checkWakeDone({ agents: [], checkouts: [], deferred: [], ending: 'deferred' })!
  expect(held.reason).toContain('Nothing is deferred')
  expect(held.reason).toContain('declare done')
})

test('a done ending is refused on deferred work, which names the deferred line', () => {
  const held = checkWakeDone({ agents: [], checkouts: [], deferred: ['5 (a)'], deferredRows: ['5 (a)'], goalsDeferred: ['G5'] })!
  expect(held.reason).toBe('Not done: row 5 (a), G5 deferred by the operator, still open. Declare a deferred wait, not done.')
  // An open row that is not deferred keeps its own reason beside it.
  const both = checkWakeDone({ agents: [], checkouts: [], deferred: ['5 (a)', '6 (b)'], deferredRows: ['5 (a)'] })!
  expect(both.reason).toContain('row 6 (b) is open')
  expect(both.reason).toContain('row 5 (a) deferred by the operator')
})

test('a faulty goals file refuses the deferred ending too', () => {
  const held = checkWakeDone({ agents: [], checkouts: [], deferred: [], goalsDeferred: ['G5'], goalsFaults: ['G5 deferred without the operator\'s words'], ending: 'deferred' })!
  expect(held.reason).toBe("goals.md is not a record of the spec: G5 deferred without the operator's words.")
})

test('the goals reading carries the goals the operator deferred', () => {
  expect(parseGoalsCheck('/r/goals.md', DEFERRED_GOALS.stdout)?.deferred).toEqual(['G5', 'G6'])
  expect(parseGoalsCheck('/r/goals.md', goalsAnswer())?.deferred).toEqual([])
})

test('the deferred line passes at the stop when every open row and goal is deferred', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ records: [DEFERRED_ROW], goals: DEFERRED_GOALS })
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(DEFER_END))
  expect(out.answer).toBe(out.passed)
  expect(out.observed).toBeUndefined()
})

test('the deferred line is refused beside a row that is not deferred, and the done line beside a deferred one', async () => {
  const { handlers } = mounted()
  const live = fakeDollar({ records: [DEFERRED_ROW + '{"id":6,"label":"the live row","state":"open"}\n'], goals: DEFERRED_GOALS })
  const held = await stop(handlers['classic.Stop'], live.dollar, stopEvent(DEFER_END))
  expect(held.observed).toContain('row 6 (the live row) is open')
  const done = fakeDollar({ records: [DEFERRED_ROW], goals: DEFERRED_GOALS })
  const refused = await stop(handlers['classic.Stop'], done.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect(refused.observed).toContain('deferred by the operator')
  expect(refused.observed).toContain('Declare a deferred wait, not done')
})

// The ids after « waiting: deferred — » are compared with the deferred items: a line that names
// nothing of what is put off, or not all of it, is no record of what the session ended on.
test('a deferred ending passes only when its ids name every deferred item, rows by number, goals as G<n>', () => {
  const left = { agents: [], checkouts: [], deferred: ['5 (a)'], deferredRows: ['5 (a)'], goalsDeferred: ['G5', 'G6'], ending: 'deferred' as const }
  expect(checkWakeDone({ ...left, ids: '5, G5, G6' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: '5 G5 G6' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: 'row 5, g5, G6' })).toBeNull()
  const none = checkWakeDone({ ...left, ids: 'nothing' })!
  expect(none.case).toBe('not-done')
  expect(none.reason).toContain('missing row 5, G5, G6')
  expect(none.reason).toContain('unknown nothing')
  const part = checkWakeDone({ ...left, ids: '5, G5, G9' })!
  expect(part.reason).toContain('missing G6')
  expect(part.reason).not.toContain('missing row 5')
  expect(part.reason).toContain('unknown G9')
})

// The short form: the count of deferred rows, and of deferred goals when there are any.
test('the short deferred line passes when its counts are the records\' deferred rows and goals', () => {
  const left = { agents: [], checkouts: [], deferred: ['5 (a)', '7 (b)'], deferredRows: ['5 (a)', '7 (b)'], goalsDeferred: ['G5', 'G6', 'G8'], ending: 'deferred' as const }
  expect(checkWakeDone({ ...left, ids: '2 rows G3' })).toBeNull()
  expect(checkWakeDone({ ...left, goalsDeferred: [], ids: '2 rows' })).toBeNull()
  expect(checkWakeDone({ ...left, deferred: ['5 (a)'], deferredRows: ['5 (a)'], goalsDeferred: [], ids: '1 row' })).toBeNull()
})

test('the short deferred line with a wrong count is refused, the message giving the right line', () => {
  const left = { agents: [], checkouts: [], deferred: ['5 (a)', '7 (b)'], deferredRows: ['5 (a)', '7 (b)'], goalsDeferred: ['G5', 'G6'], ending: 'deferred' as const }
  const wrongRows = checkWakeDone({ ...left, ids: '3 rows G2' })!
  expect(wrongRows.case).toBe('not-done')
  expect(wrongRows.reason).toContain('the right count is 4 items.')
  expect(checkWakeDone({ ...left, ids: '2 rows' })!.reason).toContain('the right count is 4 items.')
  expect(checkWakeDone({ ...left, ids: '5, 7, G5, G6' })).toBeNull()
})

// The taught form: one count of the deferred items, rows and goals together.
test('the items line passes when its count is the deferred rows and goals together', () => {
  const left = { agents: [], checkouts: [], deferred: ['5 (a)', '7 (b)'], deferredRows: ['5 (a)', '7 (b)'], goalsDeferred: ['G5', 'G6'], ending: 'deferred' as const }
  expect(checkWakeDone({ ...left, ids: '4 items' })).toBeNull()
  expect(checkWakeDone({ ...left, deferred: ['5 (a)'], deferredRows: ['5 (a)'], goalsDeferred: ['G5'], ids: '2 items' })).toBeNull()
})

test('the items line with a wrong count is refused, the message giving the total', () => {
  const left = { agents: [], checkouts: [], deferred: ['5 (a)', '7 (b)'], deferredRows: ['5 (a)', '7 (b)'], goalsDeferred: ['G5', 'G6'], ending: 'deferred' as const }
  const wrong = checkWakeDone({ ...left, ids: '2 items' })!
  expect(wrong.case).toBe('not-done')
  expect(wrong.reason).toContain('A deferred wait must give the number of deferred rows and goals together')
  expect(wrong.reason).toContain('the right count is 4 items.')
  expect(checkWakeDone({ ...left, ids: '2 rows G2' })).toBeNull()
})

test('the deferred line that names nothing of what is deferred is refused at the stop', async () => {
  const { handlers } = mounted()
  const wrong = fakeDollar({ records: [DEFERRED_ROW], goals: DEFERRED_GOALS })
  const held = await stop(handlers['classic.Stop'], wrong.dollar, stopEvent({ last_assistant_message: 'Nothing left.\nwaiting: deferred — nothing' }))
  expect(held.observed).toContain('missing row 5, G5, G6')
  expect(held.observed).toContain('unknown nothing')
})

test('the items line passes at the stop when its count is the deferred rows and goals', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ records: [DEFERRED_ROW], goals: DEFERRED_GOALS })
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'All that can move has moved.\nwaiting: deferred — 3 items' }))
  expect(out.answer).toBe(out.passed)
  expect(out.observed).toBeUndefined()
})

test('the items line with a wrong count is refused at the stop, naming the total', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ records: [DEFERRED_ROW], goals: DEFERRED_GOALS })
  const held = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'All that can move has moved.\nwaiting: deferred — 2 items' }))
  expect(held.observed).toContain('the right count is 3 items.')
})

// A deferred line with no ids is no machine line and no longer has a refusal naming the form: it
// declares no wait.
test('waiting: deferred with no ids is no malformed machine line, at the gate and at the stop', async () => {
  const base = { agents: [], resident: false, delivered: [] }
  for (const message of ['waiting: deferred', 'Nothing left.\nwaiting: deferred —', '**waiting: deferred**']) {
    const held = fieldsIn(checkWake({ ...base, message }))
    expect([message, held]).toEqual([message, { warn: 'nothing-will-wake', detail: '' }])
  }
  const { handlers } = mounted()
  const fx = fakeDollar({ records: [DEFERRED_ROW], goals: DEFERRED_GOALS })
  const held = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'Nothing left.\nwaiting: deferred' }))
  expect(held.observed).not.toContain('Your last line is not the machine line')
})

// The message that sent a session to « waiting: operator » for goals the operator had deferred
// must name the deferred ending beside the others.
test('the lines that fit name the deferred ending', () => {
  const base = { agents: [], resident: false, delivered: [] }
  const NAMED = 'if the operator deferred it, his ruling recorded, declare a deferred wait'
  expect(fieldsIn(checkWake({ ...base, message: 'waiting: operator — blocks: nothing' })).reason).toContain(NAMED)
  // While something runs, what fits is no wait at all.
  expect(fieldsIn(checkWake({ ...base, message: 'waiting: operator — blocks: nothing', background: ['sleep 9'] })).reason).not.toContain(NAMED)
})

// Only goals are deferred, no row: the guards path hands the gate the goals the operator put off
// (goalsDeferred), or the deferred line is refused as « nothing is deferred » and the done line passes.
test('goals alone deferred, no open row: the deferred line passes and the done line is refused, through the stop', async () => {
  const { handlers } = mounted()
  const GOALS_ONLY = { last_assistant_message: 'Nothing left to move.\nwaiting: deferred — G5, G6' }
  const ended = fakeDollar({ ...NO_ROWS, goals: DEFERRED_GOALS })
  const passed = await stop(handlers['classic.Stop'], ended.dollar, stopEvent(GOALS_ONLY))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
  const done = fakeDollar({ ...NO_ROWS, goals: DEFERRED_GOALS })
  const refused = await stop(handlers['classic.Stop'], done.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect(refused.observed).toContain('G5, G6 deferred by the operator')
  expect(refused.observed).toContain('Declare a deferred wait, not done')
  const unnamed = fakeDollar({ ...NO_ROWS, goals: DEFERRED_GOALS })
  const short = await stop(handlers['classic.Stop'], unnamed.dollar, stopEvent({ last_assistant_message: 'waiting: deferred — G5' }))
  expect(short.observed).toContain('missing G6')
})

// Every window of a tmux server inherits the server's ITERM_SESSION_ID, so the owner of a
// chain entry cannot be read from it there: the pane names the session.
const TMUX_ENV = { ITERM_SESSION_ID: 'w0t0:2:17', TMUX: '/private/tmp/tmux-501/orch,4242,0' }
const TMUX_OWNED = '{"tab_id":"tmux:/private/tmp/tmux-501/orch:@1","tty":"/dev/ttys002","owner":"tmux:/private/tmp/tmux-501/orch:%3"}\n'

test('an entry owned by a tmux pane is counted for that pane only, not for a sibling sharing the server\'s ITERM_SESSION_ID', async () => {
  const { handlers } = mounted()
  const own = fakeDollar({ listing: BUSY_ROW, chain: TMUX_OWNED, env: { ...TMUX_ENV, TMUX_PANE: '%3' } })
  const mine = stopEvent({})
  expect((await stop(handlers['classic.Stop'], own.dollar, mine)).answer).toBe(mine)
  const sibling = fakeDollar({ listing: BUSY_ROW, chain: TMUX_OWNED, env: { ...TMUX_ENV, TMUX_PANE: '%4' } })
  await warnsNotRefuses(handlers, sibling, stopEvent({}), 'nothing-will-wake')
})

// --- a dispatch record belongs to one orchestration ------------------------------------------

// A record was read by every session that had touched it, and its open rows and goals.md were
// the session's to answer for whoever opened them. The owner file beside the record
// (`<record>.owner`, written by dispatch-record.sh) names the orchestration; the gate reads a
// record that is its session's own, or has no owner yet, and no other.
test('an orchestration is its name without the reference, in the house shape', () => {
  expect(orchestrationOf('Orch: Shipping')).toBe('Orch: Shipping')
  expect(orchestrationOf('Orch: Shipping [a1b2c3]')).toBe('Orch: Shipping')
  expect(orchestrationOf('Orch: belt')).toBe('Orch: belt')
  expect(orchestrationOf('  Orch:  belt  ')).toBe('Orch: belt')
  expect(orchestrationOf('Agent: belt')).toBeNull()
  expect(orchestrationOf(null)).toBeNull()
})

test('an orchestration reads the former « Orch : x » the current way, and only a name core reads as one', () => {
  expect(orchestrationOf('Orch : belt [a1b2c3]')).toBe('Orch: belt')
  expect(orchestrationOf('Orch:belt')).toBe('Orch: belt')
  expect(orchestrationOf('Orch: ' + 'a'.repeat(25))).toBe('Orch: ' + 'a'.repeat(25))
  expect(orchestrationOf('Orch: ' + 'a'.repeat(26))).toBeNull()
  expect(ownerOf('Orch : other\n')).toBe('Orch: other')
})

test('an owner file names its owner on its first line, and a blank file names nobody', () => {
  expect(ownerOf('Orch: other\n')).toBe('Orch: other')
  expect(ownerOf('Orch: other [a1b2c3]\nignored\n')).toBe('Orch: other')
  expect(ownerOf('\n  \n')).toBeNull()
  expect(ownerOf('')).toBeNull()
})

test('an owner line that is no orchestration name is the owner as written', () => {
  expect(ownerOf('o-1234\n')).toBe('o-1234')
})

test('a record is the session\'s own when it has no owner or the owner is the session\'s orchestration', () => {
  expect(isOwnRecord(null, 'Orch: belt')).toBe(true)
  expect(isOwnRecord('Orch: belt', 'Orch: belt')).toBe(true)
  expect(isOwnRecord('Orch: other', 'Orch: belt')).toBe(false)
  expect(isOwnRecord('Orch: belt', null)).toBe(false)
  expect(isOwnRecord(null, null)).toBe(true)
})

test('the records that hold an open row not deferred are the ones the refusal names', () => {
  const live = '{"id":1,"label":"a","state":"open"}\n'
  const putOff = '{"id":2,"label":"b","state":"open","deferred":"2026-11-03: later"}\n'
  const closed = '{"id":3,"label":"c","state":"closed"}\n'
  expect(recordsWithOpenRows(['/r/a.jsonl', '/r/b.jsonl', '/r/c.jsonl'], [live, putOff, closed])).toEqual(['/r/a.jsonl'])
})

test('the refusals name the record or the goals file they read, when they are given', () => {
  const rows = checkWakeDone({ agents: [], checkouts: [], deferred: ['5 (a)'], rowRecords: ['/r/dispatch.jsonl'] })!
  expect(rows.reason).toContain('Not done: row 5 (a) is open in /r/dispatch.jsonl. Dispatch it')
  const many = checkWakeDone({ agents: [], checkouts: [], deferred: ['5 (a)', '6 (b)'], rowRecords: ['/r/x.jsonl', '/s/y.jsonl'] })!
  expect(many.reason).toContain('Not done: rows 5 (a), 6 (b) are open in /r/x.jsonl, /s/y.jsonl. Dispatch them')
  const goals = checkWakeDone({ agents: [], checkouts: [], deferred: [], goalsOpen: ['G3'], goalsRecords: ['/r/goals.md'] })!
  expect(goals.reason).toContain('Not done against the spec: G3 open in /r/goals.md. Dispatch the work')
})

// The end-to-end path: a full stop event, two orchestrations sharing one record directory.
const FOREIGN_RECORD = '/tmp/h/other/dispatch-record.jsonl'
const FOREIGN_ROWS = '{"id":35,"label":"to implement by Orch: other","state":"open"}\n'
const FOREIGN_GOALS = { exitCode: 1, stdout: goalsAnswer({ open: ['G1', 'G2'] }) }

test('a session is never made to answer for the rows and goals of a record another orchestration owns', async () => {
  const { handlers } = mounted()
  // The session is « Orch: belt »; the record and the goals.md beside it belong to other.
  const foreign = fakeDollar({ ...NO_ROWS, shared: [{ path: FOREIGN_RECORD, text: FOREIGN_ROWS, owner: 'Orch: other', goals: FOREIGN_GOALS }] })
  const passed = await stop(handlers['classic.Stop'], foreign.dollar, stopEvent(DONE))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
  expect(foreign.ran.filter(line => line.startsWith('python3'))).toEqual([])
  expect(foreign.written.join('\n')).toContain(`stop gate: ${FOREIGN_RECORD} belongs to Orch: other: not read`)
})

test('the same record, owned by the session\'s own orchestration, is read and its refusals name its path', async () => {
  const { handlers } = mounted()
  const own = fakeDollar({ ...NO_ROWS, shared: [{ path: FOREIGN_RECORD, text: FOREIGN_ROWS, owner: 'Orch: belt', goals: FOREIGN_GOALS }] })
  const held = await stop(handlers['classic.Stop'], own.dollar, stopEvent(DONE))
  expect(held.observed).toContain(`row 35 (to implement by Orch: other) is open in ${FOREIGN_RECORD}.`)
  expect(held.observed).toContain('Not done against the spec: G1, G2 open in /tmp/h/other/goals.md.')
})

test('a record with no owner yet is read as before, beside a foreign one that is not', async () => {
  const { handlers } = mounted()
  const mixed = fakeDollar({
    ...NO_ROWS,
    shared: [
      { path: FOREIGN_RECORD, text: FOREIGN_ROWS, owner: 'Orch: other', goals: FOREIGN_GOALS },
      { path: '/tmp/h/mine/dispatch-record.jsonl', text: '{"id":2,"label":"mine","state":"open"}\n' },
    ],
  })
  const held = await stop(handlers['classic.Stop'], mixed.dollar, stopEvent(DONE))
  expect(held.observed).toContain('row 2 (mine) is open in /tmp/h/mine/dispatch-record.jsonl.')
  expect(held.observed).not.toContain('row 35')
  expect(held.observed).not.toContain('Not done against the spec')
})

test('an orchestrator whose name carries no subject owns no owned record, and answers for none of its rows', async () => {
  const { handlers } = mounted()
  const owned = fakeDollar({ ...NO_ROWS, launchName: 'Orch:', shared: [{ path: FOREIGN_RECORD, text: FOREIGN_ROWS, owner: 'Orch: belt', goals: FOREIGN_GOALS }] })
  const passed = await stop(handlers['classic.Stop'], owned.dollar, stopEvent(DONE))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
  expect(owned.written.join('\n')).toContain(`stop gate: ${FOREIGN_RECORD} belongs to Orch: belt: not read`)
})

test('the register\'s own record is held to its owner file too', async () => {
  const { handlers } = mounted()
  const ROW = '{"id":"r-12","label":"the report row","state":"open"}\n'
  const foreign = fakeDollar({ records: [ROW], recordOwner: 'Orch: other' })
  const passed = await stop(handlers['classic.Stop'], foreign.dollar, stopEvent(DONE))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
  const own = fakeDollar({ records: [ROW], recordOwner: 'Orch: belt [a1b2c3]' })
  expect((await stop(handlers['classic.Stop'], own.dollar, stopEvent(DONE))).observed).toContain('row r-12 (the report row) is open')
})

// --- the declared wait (hooks/wait.ts) ---------------------------------------------------------

// The declarations each wait mounting holds: the gate chained after it reads the same ones.
type Waits = {
  'session.start': Hook<World, Events['session.start']>
  'turn.start': Hook<World, Events['turn.start']>
  'tool.call': Hook<World, Events['tool.call']>
  'turn.complete': Hook<World, Events['turn.complete']>
}
// A property of a registered tool's input schema.
const propertyOf = (spec: ToolSpec | undefined, name: string) => fieldsOf(fieldsOf(spec?.inputSchema?.['properties'])?.[name])
const WAITS = new WeakMap<Waits, Declarations>()
function waitMounted(): Waits {
  const declarations = new Declarations()
  const hooks = capture<World>(on => registerWait(on, declarations))
  const handlers: Waits = {
    'session.start': hookOf(hooks, 'session.start', {}).handler,
    'turn.start': hookOf(hooks, 'turn.start', {}).handler,
    'tool.call': hookOf(hooks, 'tool.call', { tool: `mcp__orchestrator__${WAIT_TOOL}` }).handler,
    'turn.complete': hookOf(hooks, 'turn.complete', {}).handler,
  }
  WAITS.set(handlers, declarations)
  return handlers
}

// The stop as the gate reads it: the declarations of the wait module beside it, read directly.
async function chainedStop(wait: Waits, dollar: World, e: StopEvent) {
  const gate = mounted(WAITS.get(wait)).handlers['classic.Stop']
  return observing(dollar, async (seen, pass) => gate(seen, e, pass))
}

// A declaration through the tool, and its answer as it came.
const declare = async (wait: Waits, dollar: World, input: object) =>
  fieldsIn(await wait['tool.call'](dollar, { tool: `mcp__orchestrator__${WAIT_TOOL}`, ...input }, through))
const turnStarts = (wait: Waits, dollar: World) => wait['turn.start'](dollar, {}, through)
const NOTHING_RUNS = { background_tasks: [], session_crons: [] }

test('a declaration is validated: a known kind, and what it blocks where the kind needs it', () => {
  expect(parseDeclaration({ kind: 'operator', blocks: '  G3:\n the scope ' }, [{ id: 'q-1', blocks: 'x' }])).toEqual({ wait: { kind: 'operator', blocks: 'G3: the scope', asked: ['q-1'] } })
  expect(parseDeclaration({ kind: 'deferred', blocks: '2 items' })).toEqual({ wait: { kind: 'deferred', blocks: '2 items' } })
  expect(parseDeclaration({ kind: 'done', blocks: 'whatever' })).toEqual({ wait: { kind: 'done', blocks: '' } })
  expect(parseDeclaration({ kind: 'operator', blocks: 'G1', urgent: true }, [{ id: 'q-1', blocks: 'x' }])).toEqual({ wait: { kind: 'operator', blocks: 'G1', urgent: true, asked: ['q-1'] } })
  expect(parseDeclaration({ kind: 'operator', blocks: 'G1', urgent: false }, [{ id: 'q-1', blocks: 'x' }])).toEqual({ wait: { kind: 'operator', blocks: 'G1', asked: ['q-1'] } })
  for (const bad of [{}, { kind: 'later' }, { kind: 'operator' }, { kind: 'deferred', blocks: ' ' }, { kind: 'deferred', blocks: 3 }, { kind: 'deferred', blocks: 'x'.repeat(301) }, { kind: 'done', urgent: true }, { kind: 'operator', blocks: 'G1', urgent: 'yes' }]) {
    expect('error' in parseDeclaration(bad)).toBe(true)
  }
})

test('an operator question may declare the subject it asks consent on, in flat fields', () => {
  const asked = [{ id: 'q-1', blocks: 'x' }]
  const waiver = { kind: 'e2e-waiver', repo: 'acme/thing', pr: 12 }
  const flat = (s: { kind: string; repo: string; pr?: number; env?: string }) => ({
    consent_kind: s.kind, consent_repo: s.repo, ...(s.pr === undefined ? {} : { consent_pr: s.pr }), ...(s.env === undefined ? {} : { consent_env: s.env }),
  })
  expect(parseDeclaration({ kind: 'operator', blocks: 'G1', ...flat(waiver) }, asked)).toEqual({ wait: { kind: 'operator', blocks: 'G1', consent: waiver, asked: ['q-1'] } })
  for (const bad of [
    { kind: 'deferred', blocks: 'x', ...flat(waiver) }, { kind: 'operator', blocks: 'G1', ...flat({ kind: 'e2e-waiver', repo: 'acme/thing' }) },
    { kind: 'operator', blocks: 'G1', ...flat({ kind: 'merge', repo: 'acme/thing' }) },
    { kind: 'operator', blocks: 'G1', consent_repo: 'acme/thing' },
  ]) expect('error' in parseDeclaration(bad, asked)).toBe(true)
  const deploy = { kind: 'auto-deploy', repo: 'acme/infra', env: 'staging' }
  expect(parseDeclaration({ kind: 'operator', blocks: 'G1', ...flat(deploy) }, asked)).toEqual({ wait: { kind: 'operator', blocks: 'G1', consent: deploy, asked: ['q-1'] } })
  expect('error' in parseDeclaration({ kind: 'operator', blocks: 'G1', ...flat({ kind: 'auto-deploy', repo: 'acme/infra' }) }, asked)).toBe(true)
})

test('the declare_wait tool is registered at every start, and refused to a subagent and on a bad input', async () => {
  const wait = waitMounted()
  const tools: ToolSpec[] = []
  const { dollar } = fakeDollar({})
  dollar.tool = { ...dollar.tool, register: async spec => { tools.push(spec) } }
  await wait['session.start'](dollar, { cwd: '/tmp/h/work/repo' }, through)
  expect(tools.map(t => [t.name, t.isDeferred])).toEqual([[WAIT_TOOL, false]])
  // The consent an operator question asks names the environment of an auto-deploy.
  expect(propertyOf(tools[0], 'consent_env')).toEqual({ type: 'string', enum: ['dev', 'staging', 'prod'] })
  expect(propertyOf(tools[0], 'consent')).toBe(undefined)
  expect((await declare(wait, dollar, { kind: 'done', agentId: 'a-1' })).isError).toBe(true)
  expect((await declare(wait, dollar, { kind: 'soon' })).isError).toBe(true)
  // Neither is a declaration: the stop reads the message alone.
  const held = await chainedStop(wait, dollar, stopEvent({ last_assistant_message: 'stopped.', ...NOTHING_RUNS }))
  expect(String(held.observed)).toContain('Nothing will wake you')
})

test('with no wait declared, the last line the model wrote decides nothing, and the refusal teaches the call', async () => {
  const wait = waitMounted()
  const { dollar } = fakeDollar({})
  const held = await chainedStop(wait, dollar, stopEvent({ last_assistant_message: 'stopped.', ...NOTHING_RUNS }))
  expect(String(held.observed)).toContain('`declare_wait` tool')
  const done = await chainedStop(wait, dollar, stopEvent({ last_assistant_message: 'All of it shipped.\nwaiting: done', ...NOTHING_RUNS }))
  expect(String(done.observed)).toContain('Nothing will wake you')
  const asked = await chainedStop(wait, dollar, stopEvent({ last_assistant_message: `${ASKED}\nwaiting: operator — blocks: the report`, ...NOTHING_RUNS }))
  expect(String(asked.observed)).toContain('Nothing will wake you')
})

test('a declared operator wait releases the stop whatever the last line says', async () => {
  const wait = waitMounted()
  const fx = fakeDollar({ round: { 'q-a1b2c3-1.json': ASKED_HERE }, records: ['{"id":"r-12","label":"the report row","state":"open"}\n'] })
  expect((await declare(wait, fx.dollar, { kind: 'operator', blocks: 'G2: the scope' })).isError).toBeUndefined()
  // The model's own line says done, which the open row would refuse: the declaration decides.
  const passed = await chainedStop(wait, fx.dollar, stopEvent({ last_assistant_message: `${ASKED}\nwaiting: done`, ...NOTHING_RUNS }))
  expect(fieldsIn(passed.answer)?.block).toBeUndefined()
  expect(fx.written.some(l => l.endsWith('| stop gate: check1 blocks G2: the scope'))).toBe(true)
  // A declared operator wait that blocks nothing is refused as the line would be.
  await declare(wait, fx.dollar, { kind: 'operator', blocks: 'nothing' })
  const held = await chainedStop(wait, fx.dollar, stopEvent({ last_assistant_message: ASKED, ...NOTHING_RUNS }))
  expect(String(held.observed)).toContain('blocks nothing')
})


test('a declared done is held to the open rows, and passes once none is', async () => {
  const wait = waitMounted()
  // The declaration itself refuses a done while a row is open (wait.ts holdsRecord): the row here opens after it.
  const none = fakeDollar({})
  expect((await declare(wait, none.dollar, { kind: 'done' })).isError).toBeUndefined()
  const open = fakeDollar({ records: ['{"id":"r-12","label":"the report row","state":"open"}\n'] })
  expect(String((await declare(waitMounted(), open.dollar, { kind: 'done' })).result)).toContain('row r-12 (the report row) is open')
  const held = await chainedStop(wait, open.dollar, stopEvent({ last_assistant_message: 'Shipped.', ...NOTHING_RUNS }))
  expect(String(held.observed)).toContain('row r-12 (the report row) is open')
  const passed = await chainedStop(wait, none.dollar, stopEvent({ last_assistant_message: 'Shipped.', ...NOTHING_RUNS }))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
})

test('a declared deferred wait is refused when nothing is deferred, and passes on the right count', async () => {
  const wait = waitMounted()
  // The declaration itself refuses a deferred wait when nothing is deferred (wait.ts holdsRecord): the ruling here goes after it.
  const none = fakeDollar({})
  expect(String((await declare(waitMounted(), none.dollar, { kind: 'deferred', blocks: '1 items' })).result)).toContain('Nothing is deferred')
  const put = fakeDollar({ records: ['{"id":"r-12","label":"the report row","state":"open","deferred":"later, 2026-11-08"}\n'] })
  expect((await declare(wait, put.dollar, { kind: 'deferred', blocks: '1 items' })).isError).toBeUndefined()
  const held = await chainedStop(wait, none.dollar, stopEvent({ last_assistant_message: 'Put off.', ...NOTHING_RUNS }))
  expect(String(held.observed)).toContain('Nothing is deferred')
  const passed = await chainedStop(wait, put.dollar, stopEvent({ last_assistant_message: 'Put off.', ...NOTHING_RUNS }))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
})

test('a wait declared in an earlier turn is stale and never read', async () => {
  const wait = waitMounted()
  const { dollar } = fakeDollar({})
  await declare(wait, dollar, { kind: 'done' })
  await turnStarts(wait, dollar)
  const held = await chainedStop(wait, dollar, stopEvent({ last_assistant_message: 'stopped.', ...NOTHING_RUNS }))
  expect(String(held.observed)).toContain('Nothing will wake you')
  // A subagent's turn starting is not the session's: the declaration stands.
  await declare(wait, dollar, { kind: 'done' })
  await wait['turn.start'](dollar, { agentId: 'a-1' }, through)
  const passed = await chainedStop(wait, dollar, stopEvent({ last_assistant_message: 'stopped.', ...NOTHING_RUNS }))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
})

test('the turn\'s end passes the answer on unchanged: its readers read the declaration itself', async () => {
  const wait = waitMounted()
  const { dollar } = fakeDollar({ round: { 'q-a1b2c3-1.json': ASKED_HERE }, records: [
    '{"id":"r-1","label":"one","state":"open","deferred":"later, 2026-11-08"}\n{"id":"r-2","label":"two","state":"open","deferred":"later, 2026-11-08"}\n',
  ] })
  expect((await declare(wait, dollar, { kind: 'deferred', blocks: '2 items' })).isError).toBeUndefined()
  let seen = ''
  const shown = await wait['turn.complete'](dollar, { reason: 'answer', answer: 'Watching.' }, async x => { seen = String(x.answer); return { text: x.answer } })
  expect(seen).toBe('Watching.')
  expect(shown).toEqual({ text: 'Watching.' })
})

// --- an agent's report held to the verdict limit ---------------------------------------------

const REPORT = '/tmp/h/briefs/demo/report-p3.md'
const LONG = 'w'.repeat(VERDICT_LIMIT + 20)

test("an agent's turn over the verdict limit that names no report file is refused once, the way said", async () => {
  const { handlers } = mounted()
  const { dollar, ran } = fakeDollar({ launchName: 'Agent: belt-p3' })
  const refused = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: `${LONG}\nstatus: done — PR 12` }))
  expect(refused.observed).toBe(unnamedReport(LONG.length + '\nstatus: done — PR 12'.length))
  expect(ran.filter(l => l.includes('iterm-agent.sh')).length).toBe(0)
  const again = stopEvent({ stop_hook_active: true, last_assistant_message: LONG })
  expect((await stop(handlers['classic.Stop'], dollar, again)).answer).toBe(again)
})

test("an agent's turn that names its report, or stays under the limit, passes", async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({ launchName: 'Agent: belt-p3' })
  const named = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: `${LONG} — report: ${REPORT}\nstatus: done — PR 12` }))
  expect(named.answer).toBe(named.passed)
  expect(named.observed).toBeUndefined()
  const short = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: 'demo#12 abc1234 — gate green\nstatus: done — PR 12' }))
  expect(short.answer).toBe(short.passed)
  expect(short.observed).toBeUndefined()
})

test("a coordinator's long turn is never held to the agents' limit", async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({ launchName: 'Coord: machine' })
  const passed = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: LONG }))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
})

const message = (to: string, text: string) => ({ tool: 'SendMessage', to, message: text })
// The text a delivered message carried, as the fake delivery answers it.
const sentBy = (out: unknown) => fieldsOf(fieldsIn(out).result)?.['sent']
const delivered = async (e: Events['tool.call']) => ({ result: { sent: e['message'] } })

test("an agent's long message to its orchestrator is cut to the limit with the pointer to its report", async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({ launchName: 'Agent: belt-p3' })
  const out = await handlers['tool.call:SendMessage'](dollar, message('Orch: belt [a1b2c3]', `${LONG} report: ${REPORT}`), delivered)
  expect(sentBy(out)).toBe(`${'w'.repeat(VERDICT_LIMIT)} … (cut: full report at ${REPORT})`)
})

test("an agent's long message to its orchestrator that names no report goes whole with one escape, a short one goes whole with none", async () => {
  const { handlers } = mounted()
  const fx = journalled(fakeDollar({ launchName: 'Agent: belt-p3' }).dollar)
  const dollar = fx.dollar
  expect(sentBy(await handlers['tool.call:SendMessage'](dollar, message('Orch: belt', LONG), delivered))).toBe(LONG)
  expect(fx.journal()).toEqual(['escape orchestrator.message.report-unnamed'])
  const short = `demo#12 abc1234 — gate green — blocking: none — report: ${REPORT}`
  expect(sentBy(await handlers['tool.call:SendMessage'](dollar, message('Orch: belt', short), delivered))).toBe(short)
  expect(fx.journal().length).toBe(1)
})

test("the coordinator's and an orchestrator's long messages are never cut", async () => {
  const { handlers } = mounted()
  for (const launchName of ['Coord: machine', 'Orch: other']) {
    const { dollar } = fakeDollar({ launchName })
    const out = await handlers['tool.call:SendMessage'](dollar, message('Orch: belt', LONG), delivered)
    expect(sentBy(out)).toBe(LONG)
  }
})

// --- an operator wait waits on the questions asked with `ask` (hooks/wait.ts, hooks/guards.ts) ------------

test('an operator wait waits on the questions asked with ask: their blocks unless it names its own, none asked refused', () => {
  const asked = [{ id: 'q-1', blocks: 'the mode' }, { id: 'q-2', blocks: 'acme/app#1' }]
  expect(parseDeclaration({ kind: 'operator' }, asked)).toEqual({ wait: { kind: 'operator', blocks: 'the mode; acme/app#1', asked: ['q-1', 'q-2'] } })
  expect(parseDeclaration({ kind: 'operator', blocks: 'G1', urgent: true }, asked)).toEqual({ wait: { kind: 'operator', blocks: 'G1', urgent: true, asked: ['q-1', 'q-2'] } })
  expect(parseDeclaration({ kind: 'operator', blocks: 'G1', question: ASKED }, asked)).toEqual({ wait: { kind: 'operator', blocks: 'G1', asked: ['q-1', 'q-2'] } })
  const none = parseDeclaration({ kind: 'operator', blocks: 'G1' }, [])
  expect('error' in none && none.error).toBe(ASK_FIRST)
  expect('error' in parseDeclaration({ kind: 'tool' }, asked)).toBe(true)
})

test('a turn that asked with ask and declared its wait without question passes the stop, first stop and re-fired alike', async () => {
  const wait = waitMounted()
  const fx = fakeDollar({ round: { 'q-a1b2c3-1.json': ASKED_HERE } })
  const declared = await declare(wait, fx.dollar, { kind: 'operator' })
  expect(declared).toEqual({ result: 'Wait declared: waiting: operator — blocks: the mode. End the turn now.' })
  const first = await chainedStop(wait, fx.dollar, stopEvent({ last_assistant_message: 'J\'attends votre choix.', ...NOTHING_RUNS }))
  expect(first.answer).toBe(first.passed)
  expect(first.observed).toBeUndefined()
  const refired = await chainedStop(wait, fx.dollar, stopEvent({ last_assistant_message: 'J\'attends toujours.', stop_hook_active: true, ...NOTHING_RUNS }))
  expect(refired.answer).toBe(refired.passed)
  expect(refired.observed).toBeUndefined()
  expect(fx.written.some(l => l.includes('an operator wait with no question'))).toBe(false)
  // With no question asked here, the same call is refused, as before.
  const bare = fakeDollar({})
  expect((await declare(waitMounted(), bare.dollar, { kind: 'operator', blocks: 'the mode' })).isError).toBe(true)
})

// A stop re-fired after another gate held it: this gate, which only observes, steps aside before
// reading anything, an operator wait with no question included; nothing is sent, nothing journalled.
const UNASKED = 'the report\n\nwaiting: operator — blocks: the mode'

test('a re-fired stop whose operator wait holds no question passes untouched, nothing read, nothing sent', async () => {
  const { handlers } = mounted(new Declarations())
  const fx = fakeDollar({})
  const sent: string[] = []
  fx.dollar.session.send = async ({ text }: { to: unknown; text: string }) => { sent.push(text); return { isDelivered: true } }
  await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: UNASKED }))
  const ran = fx.ran.length
  for (let i = 0; i < 3; i++) {
    const refired = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: UNASKED, stop_hook_active: true }))
    expect(refired.answer).toBe(refired.passed)
    expect(refired.observed).toBeUndefined()
  }
  expect(fx.ran.length).toBe(ran)
  expect(sent).toEqual([])
})

test('a re-fired stop the gate used to step aside from still does when nothing asks the operator, or the session is no orchestrator', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({})
  const quiet = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'stopped.', stop_hook_active: true }))
  expect(quiet.answer).toBe(quiet.passed)
  expect(quiet.observed).toBeUndefined()
  const asked = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: `${ASKED}\nwaiting: operator — blocks: the mode`, stop_hook_active: true }))
  expect(asked.answer).toBe(asked.passed)
  expect(asked.observed).toBeUndefined()
  const coord = fakeDollar({ launchName: 'Coord: machine' })
  const relay = await stop(handlers['classic.Stop'], coord.dollar, stopEvent({ last_assistant_message: UNASKED, stop_hook_active: true }))
  expect(relay.answer).toBe(relay.passed)
  expect(relay.observed).toBeUndefined()
})

// --- the to-do list beside the record (todo.ts) -------------------------------------------------

const todoLine = (id: number, change: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, id, opened: '2026-11-14T15:00:00Z', label: `item ${id}`, state: 'open', verdict: '', words: `his words ${id}`, said_at: '2026-11-14T14:58:00Z', from: 'Coord: general', ...change,
}) + '\n'

test('a done ending is refused while a to-do is open, a deferred one while one he did not put off is, each named', () => {
  const held = checkWakeDone({ agents: [], checkouts: [], deferred: [], todos: ['3 (item 3)'] })!
  expect(held.case).toBe('not-done')
  expect(held.reason).toContain('to-do 3 (item 3) is open')
  expect(held.reason).toContain('todo done')
  const later = checkWakeDone({ agents: [], checkouts: [], deferred: [], todos: ['3 (item 3)'], ending: 'deferred' })!
  expect(later.reason).toContain('to-do 3 (item 3) is open')
  expect(checkWakeDone({ agents: [], checkouts: [], deferred: [] })).toBeNull()
})

test('a to-do he put off is deferred work: a done ending names the deferred line, the deferred ending counts it', () => {
  const left = { agents: [], checkouts: [], deferred: ['5 (a)'], deferredRows: ['5 (a)'], todosDeferred: ['3 (item 3)'] }
  expect(checkWakeDone(left)!.reason).toContain('to-do 3 (item 3)')
  expect(checkWakeDone(left)!.reason).toContain('deferred by the operator')
  expect(checkWakeDone({ ...left, ending: 'deferred', ids: '2 items' })).toBeNull()
  expect(checkWakeDone({ ...left, ending: 'deferred', ids: '5, T3' })).toBeNull()
  expect(checkWakeDone({ ...left, ending: 'deferred', ids: '1 items' })!.reason).toContain('the right count is 2 items')
  expect(checkWakeDone({ ...left, ending: 'deferred', ids: '5' })!.reason).toContain('missing to-do 3')
  expect(checkWakeDone({ ...left, deferred: [], deferredRows: [], ending: 'deferred', ids: '1 items' })).toBeNull()
})

test('the ids of a deferred ending accept the to-do form its refusal prints (to-do 3, todo 3, to-dos 3)', () => {
  const left = { agents: [], checkouts: [], deferred: ['5 (a)'], deferredRows: ['5 (a)'], todosDeferred: ['3 (item 3)'], ending: 'deferred' as const }
  expect(checkWakeDone({ ...left, ids: '5, to-do 3' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: 'row 5, to-do 3' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: '5, todo 3' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: '5, to-dos 3' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: '5, T3' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: '5' })!.reason).toContain('missing to-do 3')
  expect(checkWakeDone({ ...left, ids: '5, to-do 9' })!.reason).toContain('unknown to-do 9')
  expect(checkWakeDone({ ...left, ids: 'to-do 3, row 5' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: 'to-do 3, 5' })!.reason).toContain('unknown to-do 5')
})

test('the stop of an orchestrator ending on done is refused while its list holds an open item, and passes once it is closed', async () => {
  const { handlers } = mounted()
  const open = fakeDollar({ todos: todoLine(1) + todoLine(2, { state: 'closed', verdict: 'row 5' }) })
  const held = await stop(handlers['classic.Stop'], open.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect(held.observed).toContain('to-do 1 (item 1) is open')
  expect(held.observed).not.toContain('item 2')
  const closed = fakeDollar({ todos: todoLine(1, { state: 'closed', verdict: 'acme/app#230' }) })
  const passed = await stop(handlers['classic.Stop'], closed.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
})

test('the deferred line takes a to-do he put off, counted with the rows, and refuses one he did not', async () => {
  const { handlers } = mounted()
  const putOff = fakeDollar({ todos: todoLine(1, { deferred: 'after the release, 2026-11-14' }) })
  const passed = await stop(handlers['classic.Stop'], putOff.dollar, stopEvent({ last_assistant_message: 'waiting: deferred — 1 items' }))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
  const done = await stop(handlers['classic.Stop'], putOff.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect(done.observed).toContain('deferred by the operator')
  const live = fakeDollar({ todos: todoLine(1) })
  const refused = await stop(handlers['classic.Stop'], live.dollar, stopEvent({ last_assistant_message: 'waiting: deferred — 1 items' }))
  expect(refused.observed).toContain('to-do 1 (item 1) is open')
})

test('an auditor stopping with an open to-do and no declared wait is refused once, the item named; a declared wait or an empty list lets it go', async () => {
  const { handlers } = mounted()
  const audit = fakeDollar({ launchName: 'Audit: todo', todos: todoLine(1) })
  const held = await stop(handlers['classic.Stop'], audit.dollar, stopEvent({ last_assistant_message: 'The report is written.' }))
  expect(held.observed).toContain('to-do 1 (item 1) is open')
  // The refusal is made once: the host re-fires the stop with the marker set, and it passes.
  const again = await stop(handlers['classic.Stop'], audit.dollar, stopEvent({ last_assistant_message: 'The report is written.', stop_hook_active: true }))
  expect(again.answer).toBe(again.passed)
  expect(again.observed).toBeUndefined()
  const declared = await stop(handlers['classic.Stop'], audit.dollar, stopEvent({ last_assistant_message: 'Asked.\n\nwaiting: operator — blocks: the answer' }))
  expect(declared.answer).toBe(declared.passed)
  expect(declared.observed).toBeUndefined()
  const empty = fakeDollar({ launchName: 'Audit: todo' })
  const none = await stop(handlers['classic.Stop'], empty.dollar, stopEvent({ last_assistant_message: 'The report is written.' }))
  expect(none.answer).toBe(none.passed)
  expect(none.observed).toBeUndefined()
  const closed = fakeDollar({ launchName: 'Audit: todo', todos: todoLine(1, { state: 'closed', verdict: 'the report' }) })
  const finished = await stop(handlers['classic.Stop'], closed.dollar, stopEvent({ last_assistant_message: 'The report is written.' }))
  expect(finished.answer).toBe(finished.passed)
  expect(finished.observed).toBeUndefined()
})

test('a coordinator\'s stop is never held by its list: only its end command is', async () => {
  const { handlers } = mounted()
  const coord = fakeDollar({ launchName: 'Coord: machine', todos: todoLine(1) })
  const passed = await stop(handlers['classic.Stop'], coord.dollar, stopEvent({ last_assistant_message: 'Nothing more.' }))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
})

// --- the waits the module reads itself: no declaration for them ------------------------------

// His ruling of 2026-11-14 (« on n'est plus obligé de déclarer l'attente d'un outil »): a command,
// a monitor, a subagent or an awaited agent of the session is read by the gate, so `declare_wait`
// is for a question to the operator or the ending alone.
test('declare_wait takes no tool wait: what the module reads in flight passes with nothing declared', async () => {
  expect(parseDeclaration({ kind: 'tool', blocks: 'the deploy run' })).toEqual({ error: 'kind is one of operator, done, deferred' })
  const wait = waitMounted()
  const tools: ToolSpec[] = []
  const fx = fakeDollar({ ps: NOTHING_PS })
  fx.dollar.tool = { ...fx.dollar.tool, register: async spec => { tools.push(spec) } }
  await wait['session.start'](fx.dollar, { cwd: '/tmp/h/work/repo' }, through)
  expect(propertyOf(tools[0], 'kind')?.['enum']).toEqual(['operator', 'done', 'deferred'])
  expect(tools[0]?.description).not.toContain('`tool`')
  const SUBAGENT = { id: 'a', type: 'subagent', status: 'running', description: 'search' }
  const MONITOR = { id: 'm', type: 'monitor', status: 'running', description: 'the deploy log' }
  for (const task of [SHELL_TASK, SUBAGENT, MONITOR]) {
    const out = await chainedStop(wait, fx.dollar, stopEvent({ last_assistant_message: 'Deploy started.', background_tasks: [task], session_crons: [] }))
    expect(out.answer).toBe(out.passed)
  expect(out.observed).toBeUndefined()
  }
  expect(fx.written.some(l => l.includes('| stop gate: warn') || l.includes('| stop gate: check1'))).toBe(false)
})

test('no refusal teaches a tool wait: what runs, or a busy agent, wakes the session with no wait declared', () => {
  const base = { agents: [], resident: false, delivered: [] }
  const nothing = fieldsIn(checkWake({ ...base, message: 'stopped.', tasks: [] }))
  expect(nothing.case).toBe('nothing-will-wake')
  expect(nothing.reason).not.toContain('tool wait')
  expect(nothing.reason).toContain('its end wakes you, with no wait to declare')
  const running = fieldsIn(checkWake({ ...base, message: 'waiting: operator — blocks: nothing', background: ['tail -f deploy.log'] }))
  expect(running.case).toBe('blocks-nothing')
  expect(running.reason).not.toContain('tool wait')
  expect(running.reason).toContain('tail -f deploy.log runs in the background: declare no wait, its end wakes you.')
  const busy = fieldsIn(checkWake({ ...base, agents: [AGENT_BUSY], message: 'waiting: operator — blocks: none' }))
  expect(busy.reason).toContain('An agent of yours is busy: declare no wait, its idle notice wakes you.')
})

// The fresh-eye plan A, item 4 (2026-11-14): the executor lives until its pull request merges and
// receives the kept findings; the gate no longer flags it for its stand-down while that pull request is open.
test('an idle agent whose pull request is open is not dismissed: with something armed the stop passes, logged apart; once merged it is delivered', async () => {
  const { handlers } = mounted()
  const pr = { listing: IDLE_ROW, chain: IDLE_OWNED, agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n' }
  const open = fakeDollar({ ...pr, prAnswer: '{"number":160,"state":"OPEN"}' })
  const armed = { background_tasks: [{ command: 'bash ci-watch.sh 160', status: 'running' }], session_crons: [] }
  const out = await stop(handlers['classic.Stop'], open.dollar, stopEvent({ ...armed }))
  expect(out.answer).toBe(out.passed)
  expect(out.observed).toBeUndefined()
  expect(open.written.some(l => l.includes('idle-delivered') || l.includes('idle-agents') || l.includes('nothing-will-wake'))).toBe(false)
  expect(open.written.some(l => l.endsWith('| stop gate: warn awaiting-merge Agent: idle-p3'))).toBe(true)
  // Its done is still held through the handler: it is still there until the merge.
  const done = fakeDollar({ ...pr, prAnswer: '{"number":160,"state":"OPEN"}' })
  const held = await stop(handlers['classic.Stop'], done.dollar, stopEvent({ last_assistant_message: 'waiting: done', ...NOTHING_RUNS }))
  expect(String(held.observed)).toContain('Agent: idle-p3 is still there')
  const merged = fakeDollar({ ...pr, prAnswer: '{"number":160,"state":"MERGED"}' })
  await warnsNotRefuses(handlers, merged, stopEvent({}), 'idle-delivered Agent: idle-p3 (pull request #160, MERGED)')
})

test('an executor with its pull request open and nothing armed to wake the session is observed as nothing-will-wake', async () => {
  const { handlers } = mounted()
  const pr = { listing: IDLE_ROW, chain: IDLE_OWNED, agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', prAnswer: '{"number":160,"state":"OPEN"}' }
  const open = fakeDollar(pr)
  const out = await stop(handlers['classic.Stop'], open.dollar, stopEvent({ ...NOTHING_RUNS }))
  expect(String(out.observed)).toContain('Nothing will wake you')
  expect(open.written.some(l => l.includes('warn awaiting-merge'))).toBe(false)
})

test('an executor with its pull request open still holds a done, and another idle agent is still named', () => {
  const base = { agents: [AGENT_IDLE], resident: false, delivered: [], awaitingMerge: ['Agent: idle-p3'], tasks: ['bash ci-watch.sh 160'] }
  expect(checkWake({ ...base, message: 'Reviewing.' })).toEqual({ warn: 'awaiting-merge', detail: 'Agent: idle-p3' })
  // An open pull request wakes nothing: with no task of the host, no subscription, no watch and no open question, it is refused.
  expect(fieldsIn(checkWake({ ...base, tasks: [], message: 'Reviewing.' })).case).toBe('nothing-will-wake')
  expect(checkWake({ ...base, tasks: [], awaiting: true, message: 'Reviewing.' })).toBeNull()
  expect(checkWake({ ...base, tasks: [], watching: true, message: 'Reviewing.' })).toBeNull()
  expect(checkWake({ ...base, tasks: [], questionOpen: true, message: 'Reviewing.' })).toEqual({ warn: 'awaiting-merge', detail: 'Agent: idle-p3' })
  expect(checkWake({ ...base, tasks: null, message: 'Reviewing.' })).toEqual({ warn: 'awaiting-merge', detail: 'Agent: idle-p3' })
  const other = { label: 'Agent: other-p4', state: 'idle' as const, tty: '/dev/ttys004' }
  expect(checkWake({ ...base, agents: [AGENT_IDLE, other], message: 'Reviewing.' })).toEqual({ warn: 'idle-agents', detail: 'Agent: other-p4' })
  expect(checkWake({ ...base, message: 'waiting: done' })).toBe('read-what-is-left')
  expect(fieldsIn(checkWakeDone({ agents: [AGENT_IDLE], checkouts: [], deferred: [] })).reason).toContain('Agent: idle-p3 is still there')
})
