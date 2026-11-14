import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { countShots, groupBy, keyOf, main, nextId, openLine, orchForm, order, parseId, parseRecord, sessionOrchestration, stateRoot, summaryLines, text, withoutCode, type Deps } from './dispatch-record.ts'
import type { Ran } from './lib/process.ts'
import { scriptJournal } from './lib/audit.ts'
import { parseJournalEvent } from '../../../core/learning.ts'

let dir = ''
// The real path: the script resolves its record's, and macOS's temporary directory is a link.
test.beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-record-'))) })
test.afterEach(() => rmSync(dir, { recursive: true, force: true }))

interface World {
  readonly out: string[]
  readonly err: string[]
  readonly calls: string[]
}

/** What the fake commands answer: goals.py, routing.py and gh. */
interface Answers {
  unplanned?: string
  body?: string | null
  cost?: (session: string) => Ran
  goals?: number
}

const ok = (stdout: string): Ran => ({ status: 0, stdout, stderr: '' })

function deps(env: Record<string, string> = {}, answers: Answers = {}): Deps & World {
  const out: string[] = []
  const err: string[] = []
  const calls: string[] = []
  return {
    out, err, calls,
    io: { out: t => out.push(t), err: t => err.push(t) },
    env: { ORCHESTRATOR_STATE_DIR: join(dir, 'state'), CLAUDE_CONFIG_DIR: join(dir, 'cfg'), ...env },
    now: () => new Date('2026-11-08T10:11:12.345Z'),
    goalsPy: '/p/goals.py',
    routingPy: '/p/routing.py',
    passThrough: async argv => { calls.push(argv.join(' ')); return answers.goals ?? 0 },
    run: async argv => {
      calls.push(argv.join(' '))
      if (argv[2] === 'unplanned') return ok(answers.unplanned ?? '')
      if (argv[2] === 'line') return ok('goals met=0/1\n')
      if (argv[0] === 'gh') return answers.body === null || answers.body === undefined ? { status: 1, stdout: '', stderr: '' } : ok(`${answers.body}\n`)
      const session = argv[argv.indexOf('--session') + 1] ?? ''
      return answers.cost?.(session) ?? ok('{"cost_usd": 0.5}')
    },
  }
}

async function cli(args: string[], d: Deps & World = deps()): Promise<string> {
  d.out.length = 0
  d.err.length = 0
  const code = await main(args, d)
  return `${code}|${d.out.join('')}|${d.err.join('')}`
}

const rec = (): string => join(dir, 'p', 'r.jsonl')
const rows = (): Record<string, unknown>[] => parseRecord(readFileSync(rec(), 'utf8'))

async function withGoals(): Promise<void> {
  mkdirSync(join(dir, 'p'), { recursive: true })
  writeFileSync(join(dir, 'p', 'goals.md'), '# Goals\n')
}

test('the jq readings: text, order, groups, ids', () => {
  assert.equal(text('a'), 'a')
  assert.equal(text(undefined), 'null')
  assert.equal(text({ a: 1 }), '{"a":1}')
  assert.deepEqual([3, 'b', null, true, false, 'a', 1, [], {}].sort(order), [null, false, true, 1, 3, 'a', 'b', [], {}])
  assert.deepEqual(groupBy([{ k: 'b' }, { k: 'a' }, { k: 'b' }], r => r.k).map(g => g.length), [1, 2])
  assert.equal(parseId('3'), 3)
  assert.equal(parseId('"3"'), undefined)
  assert.equal(parseId('x'), undefined)
  assert.equal(nextId([]), 1)
  assert.equal(nextId([{ id: 4 }, { id: 2 }]), 5)
  assert.throws(() => parseRecord('[1]\n'))
  assert.equal(keyOf({ model: 'm' }), 'pair=m/default')
  assert.equal(keyOf({ model: 'm', effort: 'high' }), 'pair=m/high')
  assert.equal(keyOf({ tier: null }), 'tier=')
  assert.equal(openLine({ id: 2, label: 'x', deferred: 'later' }), 'deferred=2 label=x ruling=later')
  assert.equal(stateRoot({ HOME: '/h' }), '/h/.claude/claude-orchestrator')
})

test('session names: the house shape is core\'s', () => {
  assert.equal(orchForm('  Orch: build [a1b2c3] '), 'Orch: build')
  assert.equal(orchForm('Orch:build'), 'Orch: build')
  // The former shape, an owner file written before the change: the same orchestration.
  assert.equal(orchForm('Orch : build [a1b2c3]'), 'Orch: build')
  assert.equal(orchForm('Agent: x'), 'Agent: x')
  assert.equal(orchForm('Orch: a subject far longer than twenty-five'), 'Orch: a subject far longer than twenty-five')
})

test('the session\'s orchestration: the newest host record of this session', () => {
  const sessions = join(dir, 'cfg', 'sessions')
  assert.equal(sessionOrchestration({ CLAUDE_CODE_SESSION_ID: 's1', CLAUDE_CONFIG_DIR: join(dir, 'cfg') }), '')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, '1.json'), '{"sessionId":"s1","name":"Orch: old","updatedAt":5}')
  writeFileSync(join(sessions, '2.json'), '{"sessionId":"s1","name":"Orch: new [r1]","updatedAt":9}')
  writeFileSync(join(sessions, '3.json'), '{"sessionId":"s1","name":"Orch: older","updatedAt":7}')
  writeFileSync(join(sessions, '4.json'), 'not json')
  writeFileSync(join(sessions, '5.json'), '{"sessionId":"s2","name":"Agent: a"}')
  mkdirSync(join(sessions, '6.json'))
  const env = { CLAUDE_CONFIG_DIR: join(dir, 'cfg') }
  assert.equal(sessionOrchestration({ ...env, CLAUDE_CODE_SESSION_ID: 's1' }), 'Orch: new')
  assert.equal(sessionOrchestration({ ...env, CLAUDE_CODE_SESSION_ID: 's2' }), '')
  assert.equal(sessionOrchestration(env), '')
  writeFileSync(join(sessions, '7.json'), '{"sessionId":"s1","name":"Orch: float","updatedAt":1.5}')
  assert.equal(sessionOrchestration({ ...env, CLAUDE_CODE_SESSION_ID: 's1' }), 'Orch: float')
})

test('Markdown code is no image', () => {
  assert.deepEqual(withoutCode('a `x` b\n```\ncode\n```\n~~~~\n~~~\nstill\n~~~~\nc ``unclosed\n\\`x` d'), ['a   b', 'c ``unclosed', '\\`x` d'])
  assert.deepEqual(withoutCode('``` lang ` x\nkept'), ['``` lang ` x', 'kept'])
  assert.equal(countShots('![a](x.png) ![b](y.png)\n<img src=1>\n`<img src=2>`\n```\n<IMG src=3>\n```\n<IMG\tsrc=4>'), 4)
})

test('the command line: a subcommand and a record, or a refusal', async () => {
  assert.match(await cli([]), /^1\|\|ERROR: usage: dispatch-record\.sh /)
  assert.equal(await cli(['open']), '1||ERROR: open: a record path is required\n')
  assert.match(await cli(['nope', rec()]), /^1\|\|ERROR: unknown subcommand: nope/)
  assert.equal(await cli(['round', rec()]), '1||ERROR: round: a row id is required\n')
  assert.equal(await cli(['round', rec(), '1']), `1||ERROR: round: no such record: ${rec()}\n`)
})

test('open: validated, refused without goals, warned on unplanned goals', async () => {
  const r = rec()
  assert.equal(await cli(['open', r, '--tier', 'deep']), '1||ERROR: open: --class is required\n')
  assert.equal(await cli(['open', r, '--class', 'c']), '1||ERROR: open: --tier or --model is required\n')
  assert.equal(await cli(['open', r, '--class', 'c', '--tier', 'huge']), '1||ERROR: open: unknown tier: huge (expected deep, standard or light)\n')
  assert.equal(await cli(['open', r, '--class', 'c', '--model', 'm', '--effort', 'x']), '1||ERROR: open: unknown effort: x (expected low, medium, high, xhigh or max)\n')
  assert.equal(await cli(['open', r, '--class', 'c', '--tier', 'deep', '--effort', 'low']), '1||ERROR: open: --effort needs --model\n')
  assert.equal(await cli(['open', r, '--class', 'c', '--tier', 'deep', '--explore']), '1||ERROR: open: --explore needs --model\n')
  assert.equal(await cli(['open', r, '--bogus']), '1||ERROR: open: unknown option --bogus\n')
  assert.match(await cli(['open', r, '--class', 'c', '--tier', 'deep']), /no goals\.md beside/)
  await withGoals()
  assert.equal(await cli(['open', r, '--class', 'c', '--tier', 'deep', '--label', 'one', '--cascade'], deps({}, { unplanned: 'G1\nG2\n' })),
    '0|1\n|WARNING: G1 is in no phase and not ruled out: plan it or put it to the operator\nWARNING: G2 is in no phase and not ruled out: plan it or put it to the operator\nWARNING: goals met=0/1\n')
  assert.equal(await cli(['open', r, '--class', 'c', '--model', 'm', '--effort', 'high', '--explore']), '0|2\n|')
  assert.deepEqual(rows(), [
    { id: 1, opened: '2026-11-08T10:11:12Z', class: 'c', tier: 'deep', label: 'one', rounds: 0, state: 'open', verdict: '', cascade: true },
    { id: 2, opened: '2026-11-08T10:11:12Z', class: 'c', tier: '', label: '', rounds: 0, state: 'open', verdict: '', cascade: false, model: 'm', effort: 'high', explore: true, cost_usd: 0, sessions: [], cost_incomplete: false },
  ])
  // The corrective class's former name, given on the command line, is written as the class it stands for.
  assert.equal(await cli(['open', r, '--class', 'n-bis', '--tier', 'light']), '0|3\n|')
  assert.equal(rows()[2]?.['class'], 'corrective')
  writeFileSync(r, 'not json\n')
  assert.equal(await cli(['open', r, '--class', 'c', '--tier', 'deep']), `1||ERROR: could not update ${r}\n`)
  assert.equal(await cli(['round', r, '1']), `1||ERROR: could not read ${r}\n`)
})

test('rounds, reviews, corrections, closes, deferrals', async () => {
  await withGoals()
  const r = rec()
  await cli(['open', r, '--class', 'c', '--tier', 'deep'])
  await cli(['open', r, '--class', 'c', '--tier', 'deep'])
  assert.equal(await cli(['round', r, '9']), `1||ERROR: round: no row with id 9 in ${r}\n`)
  assert.equal(await cli(['round', r, '1']), '0||')
  assert.equal(await cli(['review', r, '1']), '1||ERROR: review: --head is required\n')
  assert.equal(await cli(['review', r, '1', '--head', 'abc1234']), '0||')
  assert.match(await cli(['review', r, '1', '--head', 'abc1234', '--norms', 'maybe']), /unknown norms value: maybe/)
  assert.equal(await cli(['review', r, '1', '--head', 'abc1234', '--norms', 'tool']), '0||')
  assert.equal(await cli(['fixed', r, '1']), '1||ERROR: fixed: --head is required\n')
  assert.equal(await cli(['fixed', r, '1', '--head', 'def5678']), '0||')
  assert.equal(await cli(['fixed', r, '1', '--head', 'def5679']), '0||WARNING: fixed: row 1 already has its correction round at def5678: recording a second one anyway\n')
  assert.equal(await cli(['fixed', r, '2', '--head', 'def5678']), '0||WARNING: fixed: row 2 has no review recorded: the correction round should answer a review round, recording it anyway\n')
  assert.equal(await cli(['close', r, '1']), '1||ERROR: close: --verdict is required\n')
  assert.equal(await cli(['close', r, '1', '--verdict', 'ok']), '0||')
  assert.equal(await cli(['defer', r, '1', '--ruling', 'later']), '1||ERROR: defer: row 1 is not open\n')
  assert.match(await cli(['defer', r, '2', '--ruling', '  ']), /--ruling .* is required/)
  assert.equal(await cli(['defer', r, '2', '--ruling', 'later, 2026-11-03']), '0||')
  assert.equal(await cli(['escaped', r, '1']), '0||')
  const [one, two] = rows()
  assert.deepEqual([one?.['rounds'], one?.['state'], one?.['verdict'], one?.['escaped']], [5, 'closed', 'ok', true])
  assert.deepEqual(one?.['review'], { head: 'abc1234', norms: 'tool', at: '2026-11-08T10:11:12Z', fixed: { head: 'def5679', at: '2026-11-08T10:11:12Z' } })
  assert.deepEqual([two?.['rounds'], two?.['deferred']], [1, 'later, 2026-11-03'])
  assert.equal(await cli(['undefer', r, '2']), '0||')
  assert.equal(rows()[1]?.['deferred'], undefined)
})

test('surface and audit', async () => {
  await withGoals()
  const r = rec()
  await cli(['open', r, '--class', 'c', '--tier', 'deep'])
  assert.match(await cli(['surface', r, '1']), /give one of --ui <owner\/repo>#<n>/)
  assert.match(await cli(['surface', r, '1', '--ui', 'bad']), /got: bad/)
  assert.match(await cli(['surface', r, '1', '--ui']), /got: nothing/)
  assert.equal(await cli(['surface', r, '1', '--none', '--none']), '1||ERROR: surface: give one of --ui, --minor or --none\n')
  assert.equal(await cli(['surface', r, '1', '--bogus']), '1||ERROR: surface: unknown option --bogus\n')
  assert.match(await cli(['surface', r, '1', '--minor', '']), /--minor needs the reason/)
  assert.equal(await cli(['surface', r, '1', '--ui', 'o/r#12']), '0||')
  assert.equal(await cli(['audit', r, '1']), '1||ERROR: audit: --head is required\n')
  assert.match(await cli(['audit', r, '1', '--head', 'abc']), /too short/)
  assert.match(await cli(['audit', r, '1', '--head', 'abc1234', '--images', '0']), /got: 0/)
  assert.match(await cli(['audit', r, '1', '--head', 'abc1234']), /got: nothing/)
  assert.match(await cli(['audit', r, '1', '--head', 'abc1234', '--images', '2', '--defect', '']), /--defect needs the defect/)
  assert.equal(await cli(['audit', r, '1', '--bogus', 'x']), '1||ERROR: audit: unknown option --bogus\n')
  assert.equal(await cli(['audit', r, '1', '--head', 'abc1234', '--images', '2', '--defect', 'a', '--defect', 'b']), '0||')
  assert.deepEqual(rows()[0]?.['audit'], { head: 'abc1234', images: 2, defects: ['a', 'b'], at: '2026-11-08T10:11:12Z' })
  assert.deepEqual(rows()[0]?.['surface'], { kind: 'ui', pr: 'o/r#12', reason: '', at: '2026-11-08T10:11:12Z' })
})

test('ready: the surface, the audit, then the heads; no E2E line', async () => {
  await withGoals()
  const r = rec()
  const two = '![a](x.png)\n<img src=y>'
  for (let k = 0; k < 4; k++) await cli(['open', r, '--class', 'c', '--tier', 'deep'])
  assert.equal(await cli(['ready', r, '1']), '1||ERROR: ready: --head is required\n')
  assert.match(await cli(['ready', r, '1', '--head', 'abc1234']), /does not say whether its pull request changes a frontend surface/)
  await cli(['surface', r, '1', '--ui', 'o/r#12'])
  assert.match(await cli(['ready', r, '1', '--head', 'abc1234']), /could not read the description of o\/r#12/)
  const d = (body: string): Deps & World => deps({}, { body })
  assert.match(await cli(['ready', r, '1', '--head', 'abc1234'], d('`<img src=x>`')), /carries no screenshot: not ready/)
  assert.match(await cli(['ready', r, '1', '--head', 'abc1234'], d(two)), /no audit of the images on o\/r#12 is recorded/)
  await cli(['audit', r, '1', '--head', 'abc1234', '--images', '1'])
  assert.match(await cli(['ready', r, '1', '--head', 'fff9999'], d(two)), /audited at abc1234, head is fff9999/)
  assert.match(await cli(['ready', r, '1', '--head', 'abc1234'], d(two)), /the audit covers 1 image\(s\), the description of o\/r#12 carries 2/)
  await cli(['audit', r, '1', '--head', 'abc1234', '--images', '2', '--defect', 'icon off', '--defect', 'stray text'])
  assert.match(await cli(['ready', r, '1', '--head', 'abc1234'], d(two)), /recorded 2 defect\(s\): icon off; stray text\. Fix each one/)
  await cli(['audit', r, '1', '--head', 'abc1234', '--images', '2'])
  // The E2E line is the github gate's, not this pre-check's: none is asked, none is refused.
  assert.equal(await cli(['ready', r, '1', '--head', 'abc1234', '--e2e', 'E2E: none — x'], d(two)), '1||ERROR: ready: unknown option --e2e\n')
  assert.match(await cli(['ready', r, '1', '--head', 'abc1234'], d(two)),
    /^1\|\|.*ready: no review recorded on row 1: dispatch a review round and record it with `review`: not ready/s)
  await cli(['review', r, '1', '--head', 'abc1234', '--norms', 'tool'])
  assert.equal(await cli(['ready', r, '1', '--head', 'abc1234ffff'], d(two)),
    '0|ready: row 1 reviewed at abc1234ffff, norms check tool; 2 screenshot(s) on o/r#12, audited clean at abc1234\npr-readiness 12 ready on o/r\n|')
  assert.match(await cli(['ready', r, '1', '--head', '9999999'], d(two)), /last review read abc1234, head is 9999999: the head in front of you has not been read/)
  assert.match(await cli(['ready', r, '1', '--head', '99'], d(two)), /head 99 is too short/)

  // A minor row, a review then its correction.
  await cli(['surface', r, '2', '--minor', 'a tooltip'])
  await cli(['review', r, '2', '--head', 'aaaaaaa', '--norms', 'none'])
  assert.equal(await cli(['ready', r, '2', '--head', 'aaaaaaa']),
    '0|ready: row 2 reviewed at aaaaaaa, norms check none; frontend change ruled minor: a tooltip - tell the operator this reason with the ready\npr-readiness <n> ready on <owner/repo>\n|')
  assert.equal(await cli(['ready', r, '2', '--head', 'ccccccc']), '1||ERROR: ready: last review read aaaaaaa, head is ccccccc: the head in front of you has not been read\n')
  await cli(['fixed', r, '2', '--head', 'bbbbbbb'])
  assert.match(await cli(['ready', r, '2', '--head', 'bbbbbbb']), /^0\|ready: row 2 reviewed at aaaaaaa, corrected and verified at bbbbbbb, norms check none/)
  assert.equal(await cli(['ready', r, '2', '--head', 'ccccccc']), '1||ERROR: ready: last review read aaaaaaa, its correction bbbbbbb, head is ccccccc: the head in front of you has been neither read nor verified\n')

  // A row of no surface, with no E2E line: ready, and no E2E field written.
  await cli(['surface', r, '3', '--none'])
  await cli(['review', r, '3', '--head', 'abc1234', '--norms', 'tool'])
  assert.equal(await cli(['ready', r, '3', '--head', 'abc1234']), '0|ready: row 3 reviewed at abc1234, norms check tool; no frontend surface\npr-readiness <n> ready on <owner/repo>\n|')
  assert.equal(rows()[2]?.['e2e'], undefined)
  assert.match(await cli(['exempt', r, '--e2e', 'fine 2026-11-02']), /unknown subcommand: exempt/)
})

test('cost: measured, counted once, recounted when priced, named on a legacy row', async () => {
  await withGoals()
  const r = rec()
  await cli(['open', r, '--class', 'c', '--model', 'm'])
  const priced = deps({}, { cost: s => s === 'bad' ? { status: 3, stdout: '', stderr: '' } : s === 'junk' ? ok('nope') : s === 'text' ? ok('{"cost_usd":"1"}') : ok(JSON.stringify({ cost_usd: s.startsWith('u') ? null : 0.25 })) })
  assert.equal(await cli(['cost', r, '1'], priced), '1||ERROR: cost: --session is required\n')
  assert.equal(await cli(['cost', r, '1', '--session', 'a'], priced), '0|cost: row 1 +0.25 (session a)\n|')
  assert.ok(priced.calls.includes('python3 /p/routing.py cost --session a --alias m --json'))
  assert.match(await cli(['cost', r, '1', '--session', 'a'], priced), /^0\|\|WARNING: cost: session a is already counted on row 1/)
  assert.equal(await cli(['cost', r, '1', '--session', 'u1'], priced), '0|cost: row 1 +null (session u1)\n|WARNING: cost: session u1 has an unpriced model: row 1 is marked cost_incomplete\n')
  assert.equal(await cli(['cost', r, '1', '--session', 'bad'], priced), '1||ERROR: cost: could not measure session bad\n')
  assert.equal(await cli(['cost', r, '1', '--session', 'junk'], priced), `1||ERROR: could not update ${r}\n`)
  assert.equal(await cli(['cost', r, '1', '--session', 'text'], priced), `1||ERROR: could not update ${r}\n`)
  assert.match(await cli(['cost', r, '1', '--session', 'a', '--recount'], priced), /--recount is for a row written before the unpriced list/)
  assert.deepEqual([rows()[0]?.['cost_usd'], rows()[0]?.['sessions'], rows()[0]?.['unpriced'], rows()[0]?.['cost_incomplete']], [0.25, ['a', 'u1'], ['u1'], true])
  // Its model priced at last: the unpriced session is counted again, and the row is complete.
  const later = deps({}, { cost: () => ok('{"cost_usd": 0.5}') })
  await cli(['cost', r, '1', '--session', 'u1'], later)
  assert.deepEqual([rows()[0]?.['cost_usd'], rows()[0]?.['unpriced'], rows()[0]?.['cost_incomplete']], [0.75, [], false])

  // Rows written before the unpriced list: all unpriced when nothing is counted, else named.
  writeFileSync(r, '{"id":1,"class":"x","tier":"deep","rounds":0,"state":"open","cost_incomplete":true,"cost_usd":0,"sessions":["z","a"]}\n{"id":2,"class":"x","rounds":0,"state":"open","cost_incomplete":true,"cost_usd":0.5,"sessions":["z","a"]}\n')
  assert.equal(await cli(['cost', r, '1', '--session', 'z'], later), '0|cost: row 1 +0.5 (session z)\n|')
  assert.deepEqual([rows()[0]?.['unpriced'], rows()[0]?.['sessions']], [['a'], ['a', 'z']])
  assert.match(await cli(['cost', r, '2', '--session', 'z'], later), /already counted/)
  assert.equal(await cli(['cost', r, '2', '--session', 'a', '--recount'], later), '0|cost: row 2 +0.5 (session a)\n|')
  assert.deepEqual([rows()[1]?.['cost_usd'], rows()[1]?.['unpriced'], rows()[1]?.['cost_incomplete']], [1, [], false])
  assert.ok(later.calls.includes('python3 /p/routing.py cost --session a --json'))
  assert.equal(await cli(['cost', r, '1', '--bogus'], later), '1||ERROR: cost: unknown option --bogus\n')
})

test('summary: the statistics and the open rows, or one reading of them', async () => {
  const r = rec()
  assert.equal(await cli(['summary', r]), `0|dispatch-record: no record at ${r}\n|`)
  mkdirSync(join(dir, 'p'))
  const row = (o: Record<string, unknown>): string => JSON.stringify({ rounds: 0, state: 'closed', ...o })
  writeFileSync(r, [
    row({ id: 1, class: 'feat', model: 'm', explore: true, cost_usd: 0.1 }),
    row({ id: 2, class: 'feat', model: 'm', explore: true, cost_usd: 0.2 }),
    row({ id: 3, class: 'feat', model: 'm', explore: true, cost_usd: 0.3, cost_incomplete: true }),
    row({ id: 4, class: 'fix', tier: 'light', cascade: true, rounds: 3, escaped: true }),
    row({ id: 5, class: 'fix', tier: 'light', cascade: true, rounds: 2 }),
    row({ id: 6, class: 'fix', model: 'n', effort: 'low', explore: true, rounds: 2 }),
    row({ id: 7, class: 'docs', tier: 'deep', state: 'open', label: 'seven' }),
    row({ id: 8, class: 'docs', tier: 'deep', state: 'open', label: 'eight', deferred: 'later 2026-11-01' }),
    '',
  ].join('\n'))
  assert.deepEqual((await cli(['summary', r])).split('\n'), [
    '0|class=docs tier=deep dispatches=2 closed=0 rounds_avg=0',
    'class=feat pair=m/default dispatches=3 closed=3 rounds_avg=0 cost_avg=0.15',
    'class=fix pair=n/low dispatches=1 closed=1 rounds_avg=2',
    'class=fix tier=light dispatches=2 closed=2 rounds_avg=2.5',
    'signal=fix at n/low averages 2 rounds: the drop did not pay, revert it for this class',
    'signal=fix at light averages 2.5 rounds: the drop did not pay, revert it for this class',
    'escapes=fix at light: 1 of 1 approved rows had a defect found later',
    'signal=double-read fix at light: an approval missed a defect. Give the next round a SECOND reader with a different lens, and keep a finding only when both see it',
    'cascade=fix at light: 0 of 2 paid',
    'signal=stop cascading fix at light: 0 of 2 paid, the retries cost more than the tier saved',
    'frozen=fix',
    'promote=feat m/default',
    'open=7 label=seven',
    'deferred=8 label=eight ruling=later 2026-11-01',
    '|',
  ])
  assert.equal(await cli(['summary', r, '--open']), '0|open=7 label=seven\ndeferred=8 label=eight ruling=later 2026-11-01\n|')
  assert.equal(await cli(['summary', r, '--open', '--ids']), '0|open=1\ndeferred=1\nids: 7 8\n|')
  assert.equal(await cli(['summary', r, '--open', '--label', '8,1,9']), `0|deferred=8 label=eight ruling=later 2026-11-01\n|WARNING: summary: row 1 is not open in ${r}\nWARNING: summary: row 9 is not open in ${r}\n`)
  assert.match(await cli(['summary', r, '--ids']), /--ids and --label read the open rows: add --open/)
  assert.match(await cli(['summary', r, '--open', '--ids', '--label', '2']), /two readings/)
  assert.match(await cli(['summary', r, '--label', 'x']), /--label needs the row ids/)
  assert.match(await cli(['summary', r, '--bogus']), /unknown argument --bogus/)
  assert.deepEqual(summaryLines([]), [])
  // A row written under the corrective class's former name reads as the class it stands for.
  assert.deepEqual(summaryLines([{ id: 1, class: 'n-bis', tier: 'light', rounds: 1, state: 'closed' }, { id: 2, class: 'corrective', tier: 'light', rounds: 1, state: 'closed' }]),
    ['class=corrective tier=light dispatches=2 closed=2 rounds_avg=1'])
})

test('goals: handed to goals.py, the record registered from its first write', async () => {
  const sessions = join(dir, 'cfg', 'sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, '1.json'), '{"sessionId":"s1","name":"Orch: build","updatedAt":1}')
  const r = rec()
  const d = deps({ CLAUDE_CODE_SESSION_ID: 's1' }, { goals: 0 })
  assert.match(await cli(['goals', r], d), /a subcommand is required/)
  assert.match(await cli(['goals', r, 'bogus'], d), /unknown subcommand: bogus/)
  assert.equal(await cli(['goals', r, 'init', '--spec', 'none'], d), '0||')
  assert.ok(d.calls.includes(`python3 /p/goals.py init ${join(dir, 'p')}/goals.md --spec none`))
  assert.equal(readFileSync(`${r}.owner`, 'utf8'), 'Orch: build\n')
  assert.equal(readFileSync(join(dir, 'state', 'records', 's1'), 'utf8'), `${join(dir, 'p', 'r.jsonl')}\n`)
  assert.equal(await cli(['goals', r, 'status'], deps({ CLAUDE_CODE_SESSION_ID: 's1' }, { goals: 3 })), '3||')
  assert.equal(readFileSync(join(dir, 'state', 'records', 's1'), 'utf8'), `${join(dir, 'p', 'r.jsonl')}\n`)
})

test('the owner: claimed by the first write, refused to another orchestration, given back on a failed write', async () => {
  await withGoals()
  const sessions = join(dir, 'cfg', 'sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, '1.json'), '{"sessionId":"s1","name":"Orch: build [abc]","updatedAt":1}')
  writeFileSync(join(sessions, '2.json'), '{"sessionId":"s2","name":"Orch: other","updatedAt":1}')
  const r = rec()
  const s1 = (): Deps & World => deps({ CLAUDE_CODE_SESSION_ID: 's1' })
  // A failed first write gives its claim back.
  assert.match(await cli(['open', r, '--class', 'c'], s1()), /--tier or --model is required/)
  assert.equal(existsSync(`${r}.owner`), false)
  assert.equal(await cli(['open', r, '--class', 'c', '--tier', 'deep'], s1()), '0|1\n|')
  assert.equal(readFileSync(`${r}.owner`, 'utf8'), 'Orch: build\n')
  assert.equal(await cli(['round', r, '1'], deps({ CLAUDE_CODE_SESSION_ID: 's2' })),
    `1||ERROR: round: ${r} belongs to Orch: build, and this session is Orch: other: a record belongs to one orchestration, so open your own beside your briefs and hand Orch: build the work by message\n`)
  assert.match(await cli(['round', r, '1'], deps({ CLAUDE_CODE_SESSION_ID: 's3' })), /this session is no orchestration it can tell/)
  // Outside any session, the operator's shell writes.
  assert.equal(await cli(['round', r, '1']), '0||')
  // A read by another claims and registers nothing; a read by the owner registers.
  assert.equal(existsSync(join(dir, 'state', 'records', 's2')), false)
  await cli(['summary', r, '--open'], deps({ CLAUDE_CODE_SESSION_ID: 's2' }))
  assert.equal(existsSync(join(dir, 'state', 'records', 's2')), false)
  rmSync(join(dir, 'state'), { recursive: true })
  await cli(['summary', r, '--open'], s1())
  assert.equal(readFileSync(join(dir, 'state', 'records', 's1'), 'utf8'), `${r}\n`)
  // An empty owner file is claimed; the registry is never written twice for one record.
  writeFileSync(`${r}.owner`, '')
  assert.equal(await cli(['round', r, '1'], s1()), '0||')
  assert.equal(readFileSync(`${r}.owner`, 'utf8'), 'Orch: build\n')
  assert.equal(readFileSync(join(dir, 'state', 'records', 's1'), 'utf8'), `${r}\n`)
  // A record with no owner, written outside a session, is claimed by a session's next write.
  rmSync(`${r}.owner`)
  await cli(['round', r, '1'])
  assert.equal(existsSync(`${r}.owner`), false)
  mkdirSync(`${r}.owner`)
  assert.equal(await cli(['round', r, '1'], s1()), '0||')
  rmSync(`${r}.owner`, { recursive: true })
  // A registry that cannot be written never fails the command.
  writeFileSync(join(dir, 'state', 'records', 's1.lock'), '')
  writeFileSync(join(dir, 'blocked'), '')
  assert.equal(await cli(['round', r, '1'], deps({ CLAUDE_CODE_SESSION_ID: 's1', ORCHESTRATOR_STATE_DIR: join(dir, 'blocked') })), '0||')
})

// ----- the audit trail: each write leaves its fact in the journal, never its words -----

function journaled(env: Record<string, string> = {}, answers: Answers = {}): Deps & World & { events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = []
  return { ...deps({ CLAUDE_CODE_SESSION_ID: 'orch-1', ...env }, answers), journal: event => { events.push(event as unknown as Record<string, unknown>) }, events }
}

const factsOf = (events: readonly Record<string, unknown>[]) =>
  events.map(e => [e['kind'], (e['source'] as { code: string }).code, e['fact'] ?? e['evidence'], e['subject']])

test('a row\'s life is written to the journal: each step with its time, its record and its row', async () => {
  await withGoals()
  const d = journaled()
  const head = 'b'.repeat(40)
  assert.equal(await cli(['open', rec(), '--class', 'feature', '--tier', 'deep', '--label', 'A: the secret label (G1)'], d), '0|1\n|')
  await cli(['review', rec(), '1', '--head', head], d)
  await cli(['round', rec(), '1'], d)
  await cli(['fixed', rec(), '1', '--head', 'c'.repeat(7)], d)
  const record = 'p/r.jsonl'
  const none = { repo: null, pr: null, head: null }
  assert.deepEqual(factsOf(d.events), [
    ['step', 'orchestrator.dispatch.open', { step: 'implement', edge: 'start', record, row: 1, result: null }, none],
    ['step', 'orchestrator.dispatch.review', { step: 'review', edge: 'end', record, row: 1, result: null }, { ...none, head }],
    ['step', 'orchestrator.dispatch.round', { step: 'correction', edge: 'start', record, row: 1, result: null }, none],
    ['step', 'orchestrator.dispatch.fixed', { step: 'correction', edge: 'end', record, row: 1, result: null }, none],
  ])
  for (const event of d.events) {
    assert.equal(event['at'], '2026-11-08T10:11:12Z')
    assert.equal((event['context'] as { session: string }).session, 'orch-1')
    assert.ok(parseJournalEvent(event), JSON.stringify(event))
  }
  assert.ok(!JSON.stringify(d.events).includes('secret'))
})

test('a row is linked to the sessions that worked it, its pull request and the goals it met, by names alone', async () => {
  await withGoals()
  const d = journaled({}, { body: '![shot](https://x/y.png)' })
  await cli(['open', rec(), '--class', 'feature', '--tier', 'deep'], d)
  d.events.length = 0
  await cli(['cost', rec(), '1', '--session', 'agent-7'], d)
  await cli(['surface', rec(), '1', '--ui', 'acme/thing#12'], d)
  await cli(['close', rec(), '1', '--verdict', 'thing#12 merged 87586ec, the operator said « fine »'], d)
  await cli(['goals', rec(), 'met', 'G2', '--evidence', 'commit:abc1234', '--evidence', 'acme/thing#12'], d)
  const record = 'p/r.jsonl'
  const link = (fact: Record<string, unknown>) => ({ record, row: 1, session: null, goal: null, prs: [], ...fact })
  const none = { repo: null, pr: null, head: null }
  assert.deepEqual(factsOf(d.events), [
    ['link', 'orchestrator.dispatch.cost', link({ session: 'agent-7' }), none],
    ['link', 'orchestrator.dispatch.surface', link({}), { ...none, repo: 'acme/thing', pr: 12 }],
    ['link', 'orchestrator.dispatch.close', link({ prs: ['thing#12'] }), none],
    ['link', 'orchestrator.goals.met', link({ row: null, goal: 'G2', prs: ['acme/thing#12'] }), none],
  ])
  assert.ok(!JSON.stringify(d.events).includes('fine'))
})

test('an escape is the version 1 event the record points at; a refused write and a read leave nothing', async () => {
  await withGoals()
  const d = journaled()
  await cli(['open', rec(), '--class', 'feature', '--tier', 'deep'], d)
  d.events.length = 0
  await cli(['escaped', rec(), '1'], d)
  assert.deepEqual(factsOf(d.events), [['escape', 'orchestrator.dispatch.escaped', [{ type: 'record', path: 'p/r.jsonl' }], { repo: null, pr: null, head: null }]])
  assert.equal(d.events[0]?.['v'], 1)
  d.events.length = 0
  assert.match(await cli(['review', rec(), '9', '--head', 'abc1234'], d), /^1\|/)
  await cli(['summary', rec()], d)
  await cli(['goals', rec(), 'met', 'G1', '--evidence', 'x#1'], journaled({}, { goals: 1 }))
  assert.deepEqual(d.events, [])
})

test('the record is named under the configuration directory when it lies there', async () => {
  const d = journaled()
  const inCfg = join(dir, 'cfg', 'claude-orchestrator', 'briefs', 'proj', 'dispatch.jsonl')
  mkdirSync(dirname(inCfg), { recursive: true })
  writeFileSync(join(dirname(inCfg), 'goals.md'), '# Goals\n')
  await cli(['open', inCfg, '--class', 'feature', '--tier', 'deep'], d)
  assert.equal((d.events[0]?.['fact'] as { record: string }).record, 'claude-orchestrator/briefs/proj/dispatch.jsonl')
})

test('a journal that cannot be written is said, and the command stands', async () => {
  await withGoals()
  writeFileSync(join(dir, 'cfg-file'), 'not a directory')
  const d = deps({ CLAUDE_CONFIG_DIR: join(dir, 'cfg-file') })
  const journal = scriptJournal({ CLAUDE_CONFIG_DIR: join(dir, 'cfg-file') }, d.now, line => d.err.push(`${line}\n`))
  const out = await main(['open', rec(), '--class', 'feature', '--tier', 'deep'], { ...d, journal })
  assert.equal(out, 0)
  assert.equal(rows().length, 1)
  assert.match(d.err.join(''), /audit: the journal could not be written/)
})
