import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { countShots, groupBy, keyOf, main, nextId, openLine, order, parseId, parseRecord, stateRoot, summaryLines, text, withoutCode, type Deps } from './dispatch-record.ts'
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

/** What the fake commands answer: goals.ts, routing.py and gh. */
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
    goals: ['node', '/p/goals.ts'],
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
  // A review records the head it read and raises no round: `round` and the verdict tool count them.
  assert.equal(rows()[0]?.['rounds'], 1)
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
  assert.deepEqual([one?.['rounds'], one?.['state'], one?.['verdict'], one?.['escaped']], [3, 'closed', 'ok', true])
  assert.deepEqual(one?.['review'], { head: 'abc1234', norms: 'tool', at: '2026-11-08T10:11:12Z', fixed: { head: 'def5679', at: '2026-11-08T10:11:12Z' } })
  assert.deepEqual([two?.['rounds'], two?.['deferred']], [1, 'later, 2026-11-03'])
  assert.equal(await cli(['undefer', r, '2']), '0||')
  assert.equal(rows()[1]?.['deferred'], undefined)
})

test('blocker and note: set at open or later on an open row, checked against their forms, printed on the open line', async () => {
  await withGoals()
  const r = rec()
  assert.match(await cli(['open', r, '--class', 'c', '--tier', 'deep', '--blocker', 'after lunch']), /open: --blocker takes `none`, `PR <owner\/repo>#<n> merged`, `row <n> closed`, `release installed`, `until <ISO UTC time>` or `measure <what>`, got: after lunch/)
  assert.equal(await cli(['open', r, '--class', 'c', '--tier', 'deep', '--label', 'one', '--blocker', 'PR acme/app#12 merged']), '0|1\n|')
  assert.equal(await cli(['open', r, '--class', 'c', '--tier', 'deep', '--label', 'two']), '0|2\n|')
  assert.equal(rows()[0]?.['blocker'], 'PR acme/app#12 merged')
  // A row opened without one records none: it is not read as `none`.
  assert.equal(Object.hasOwn(rows()[1] ?? {}, 'blocker'), false)
  assert.equal(await cli(['blocker', r, '2', 'row 1 closed']), '0||')
  assert.equal(await cli(['blocker', r, '2', 'release installed']), '0||')
  assert.match(await cli(['blocker', r, '2', 'row x closed']), /blocker: `none`, .* got: row x closed/)
  assert.match(await cli(['blocker', r, '2']), /blocker: give the row's blocker/)
  assert.equal(await cli(['note', r, '1', 'review the second\n  commit first']), '0||')
  assert.match(await cli(['note', r, '1', 'a', 'b']), /note: give the note, one argument/)
  assert.equal(await cli(['blocker', r, '9', 'none']), `1||ERROR: blocker: no row with id 9 in ${r}\n`)
  assert.equal(await cli(['summary', r, '--open']), '0|open=1 label=one blocker=PR acme/app#12 merged note=review the second commit first\nopen=2 label=two blocker=release installed\n|')
  assert.equal(await cli(['blocker', r, '1', 'none']), '0||')
  assert.equal(await cli(['note', r, '1', '']), '0||')
  assert.equal(await cli(['summary', r, '--open', '--label', '1']), '0|open=1 label=one\n|')
  assert.equal(Object.hasOwn(rows()[0] ?? {}, 'note'), false)
  await cli(['close', r, '2', '--verdict', 'done'])
  assert.equal(await cli(['blocker', r, '2', 'none']), '1||ERROR: blocker: row 2 is not open\n')
  assert.equal(await cli(['note', r, '2', 'x']), '1||ERROR: note: row 2 is not open\n')
})

test('blocker: the moment (until, an existing ISO UTC time) and the measure (free words) are accepted by open and blocker, the rest refused', async () => {
  await withGoals()
  const r = rec()
  assert.equal(await cli(['open', r, '--class', 'c', '--tier', 'deep', '--label', 'moment', '--blocker', 'until 2026-11-15T11:00:00Z']), '0|1\n|')
  assert.equal(await cli(['open', r, '--class', 'c', '--tier', 'deep', '--label', 'measure', '--blocker', 'measure dashboard p95 under 300 ms']), '0|2\n|')
  assert.equal(rows()[0]?.['blocker'], 'until 2026-11-15T11:00:00Z')
  assert.equal(rows()[1]?.['blocker'], 'measure dashboard p95 under 300 ms')
  assert.equal(await cli(['blocker', r, '1', 'until 2026-11-15T12:30:00Z']), '0||')
  assert.equal(await cli(['blocker', r, '2', 'measure 3 runs green']), '0||')
  assert.equal(rows()[0]?.['blocker'], 'until 2026-11-15T12:30:00Z')
  assert.equal(rows()[1]?.['blocker'], 'measure 3 runs green')
  // An until that is not an existing instant, or not in the form, and a measure with no words, are refused.
  for (const bad of ['until 2026-02-30T00:00:00Z', 'until 2026-11-15 11:00', 'until 2026-11-15T11:00:00+02:00', 'measure ', 'measure']) {
    assert.match(await cli(['blocker', r, '2', bad]), /blocker: `none`, .* got: /, bad)
    assert.match(await cli(['open', r, '--class', 'c', '--tier', 'deep', '--blocker', bad]), /open: --blocker takes `none`, .* got: /, bad)
  }
})

test('verdict: the row carries the verdict, its few words and the findings index, level 1 of the review', async () => {
  await withGoals()
  const r = rec()
  await cli(['open', r, '--class', 'c', '--tier', 'deep'])
  assert.equal(await cli(['verdict', r, '1']), '1||ERROR: verdict: --head is required\n')
  assert.match(await cli(['verdict', r, '1', '--head', 'abc', '--result', 'pass', '--words', 'clean']), /too short/)
  assert.match(await cli(['verdict', r, '1', '--head', 'abc1234', '--result', 'maybe', '--words', 'x']), /--result is pass, fail or accepted, got: maybe/)
  assert.match(await cli(['verdict', r, '1', '--head', 'abc1234', '--result', 'pass']), /--words "<a few words>" is required/)
  assert.match(await cli(['verdict', r, '1', '--head', 'abc1234', '--result', 'pass', '--words', 'a\nb']), /one line of at most 120 characters/)
  assert.match(await cli(['verdict', r, '1', '--head', 'abc1234', '--result', 'pass', '--words', 'x'.repeat(121)]), /one line of at most 120 characters/)
  assert.match(await cli(['verdict', r, '1', '--head', 'abc1234', '--result', 'fail', '--words', 'x', '--findings', 'rel/index.md']), /--findings is the absolute path of the review's findings index, got: rel\/index.md/)
  assert.equal(await cli(['verdict', r, '1', '--head', 'abc1234', '--result', 'fail', '--words', '1 critical', '--findings', '/b/review-1.md']),
    '0|row 1: fail — 1 critical — findings: /b/review-1.md\n|WARNING: verdict: row 1 has no review recorded: recording the verdict anyway\n')
  // A new review round voids the verdict of the previous one; a correction keeps it; the verdict moves no round, it keeps the row's count.
  await cli(['review', r, '1', '--head', 'abc1234'])
  assert.equal(await cli(['verdict', r, '1', '--head', 'abc1234', '--result', 'fail', '--words', '1 critical', '--findings', '/b/review-1.md']), '0|row 1: fail — 1 critical — findings: /b/review-1.md\n|')
  const before = (rows()[0]?.['review'] as Record<string, unknown>)['verdict']
  assert.deepEqual(before, { head: 'abc1234', result: 'fail', words: '1 critical', findings: '/b/review-1.md', rounds: 0, at: '2026-11-08T10:11:12Z' })
  await cli(['fixed', r, '1', '--head', 'def5678'])
  assert.deepEqual((rows()[0]?.['review'] as Record<string, unknown>)['verdict'], before)
  assert.equal(await cli(['verdict', r, '1', '--head', 'def5678', '--result', 'accepted', '--words', '2 set aside']), '0|row 1: accepted — 2 set aside — findings: none\n|')
  assert.deepEqual(rows()[0]?.['review'], {
    head: 'abc1234', norms: '', at: '2026-11-08T10:11:12Z', fixed: { head: 'def5678', at: '2026-11-08T10:11:12Z' },
    verdict: { head: 'def5678', result: 'accepted', words: '2 set aside', findings: null, rounds: 1, at: '2026-11-08T10:11:12Z' },
  })
  assert.equal(rows()[0]?.['rounds'], 1)
  assert.equal(openLine(rows()[0] ?? {}), 'open=1 label= verdict=accepted@def5678 — 2 set aside — findings=none')
  await cli(['review', r, '1', '--head', 'aaa1111'])
  assert.equal((rows()[0]?.['review'] as Record<string, unknown>)['verdict'], undefined)
})

test('verdict --reviewed is itself the review at its head: it records the head when none is, and warns of nothing', async () => {
  await withGoals()
  const r = rec()
  await cli(['open', r, '--class', 'c', '--tier', 'deep'])
  assert.equal(await cli(['verdict', r, '1', '--head', 'abc1234', '--result', 'pass', '--words', 'clean', '--reviewed']), '0|row 1: pass — clean — findings: none\n|')
  assert.deepEqual(rows()[0]?.['review'], {
    head: 'abc1234', norms: '', at: '2026-11-08T10:11:12Z',
    verdict: { head: 'abc1234', result: 'pass', words: 'clean', findings: null, rounds: 0, at: '2026-11-08T10:11:12Z' },
  })
  // A review the row already holds at the verdict's head is kept, as is its correction round.
  await cli(['fixed', r, '1', '--head', 'abc1234'])
  await cli(['verdict', r, '1', '--head', 'abc1234', '--result', 'accepted', '--words', 'ok', '--reviewed'])
  const kept = rows()[0]?.['review'] as Record<string, unknown>
  assert.equal(kept['head'], 'abc1234')
  assert.deepEqual(kept['fixed'], { head: 'abc1234', at: '2026-11-08T10:11:12Z' })
  // A review of another head is the review of an earlier round: the verdict replaces it, its correction round with it.
  await cli(['verdict', r, '1', '--head', 'def5678', '--result', 'accepted', '--words', 'ok', '--reviewed'])
  assert.deepEqual(rows()[0]?.['review'], {
    head: 'def5678', norms: '', at: '2026-11-08T10:11:12Z',
    verdict: { head: 'def5678', result: 'accepted', words: 'ok', findings: null, rounds: 1, at: '2026-11-08T10:11:12Z' },
  })
  const again = await cli(['fixed', r, '1', '--head', '9990000'])
  assert.doesNotMatch(again, /already has its correction round/)
  // The same commit abbreviated on one side is the same head: the review keeps its norms and its correction round, no review step is said.
  const long = `abc1234${'0'.repeat(33)}`
  await cli(['review', r, '1', '--head', 'abc1234', '--norms', 'tool'])
  await cli(['fixed', r, '1', '--head', 'abc1234'])
  await cli(['verdict', r, '1', '--head', long, '--result', 'pass', '--words', 'ok', '--reviewed'])
  const abbreviated = rows()[0]?.['review'] as Record<string, unknown>
  assert.deepEqual([abbreviated['head'], abbreviated['norms'], (abbreviated['fixed'] as Record<string, unknown>)['head']], ['abc1234', 'tool', 'abc1234'])
  // Without the flag the warning stays: a person who forgot `review` is told.
  const second = await cli(['open', r, '--class', 'c', '--tier', 'deep'])
  assert.equal(second.startsWith('0|2'), true)
  assert.match(await cli(['verdict', r, '2', '--head', 'abc1234', '--result', 'pass', '--words', 'clean']), /row 2 has no review recorded/)
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

test('ready: the surface and the audit only; the head, the review and the label are the gate\'s', async () => {
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
  // The review at the head and the `Ready` label are the github gate's: a row no review touched,
  // or one read at another head (a rebase), is neither refused here nor handed a label command.
  assert.equal(await cli(['ready', r, '1', '--head', 'abc1234'], d(two)), '0|ready: row 1: 2 screenshot(s) on o/r#12, audited clean at abc1234\n|')
  await cli(['review', r, '1', '--head', 'abc1234', '--norms', 'tool'])
  assert.equal(await cli(['ready', r, '1', '--head', 'abc1234ffff'], d(two)), '0|ready: row 1: 2 screenshot(s) on o/r#12, audited clean at abc1234\n|')
  assert.equal(await cli(['ready', r, '1', '--head', '9999999'], d(two)), '0|ready: row 1: 2 screenshot(s) on o/r#12, audited clean at abc1234\n|')
  assert.match(await cli(['ready', r, '1', '--head', '99'], d(two)), /head 99 is too short/)

  // A minor row: no review, a review, its correction and a head neither read: the same line.
  await cli(['surface', r, '2', '--minor', 'a tooltip'])
  const minor = '0|ready: row 2: frontend change ruled minor: a tooltip - tell the operator this reason with the ready\n|'
  assert.equal(await cli(['ready', r, '2', '--head', 'aaaaaaa']), minor)
  await cli(['review', r, '2', '--head', 'aaaaaaa', '--norms', 'none'])
  await cli(['fixed', r, '2', '--head', 'bbbbbbb'])
  assert.equal(await cli(['ready', r, '2', '--head', 'ccccccc']), minor)

  // A row of no surface, with no E2E line: ready, and no E2E field written.
  await cli(['surface', r, '3', '--none'])
  assert.equal(await cli(['ready', r, '3', '--head', 'abc1234']), '0|ready: row 3: no frontend surface\n|')
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
  assert.ok(priced.calls.includes('python3 /p/routing.py cost --session a --json'))
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

test('goals: handed to goals.ts, the record registered from its first write', async () => {
  const sessions = join(dir, 'cfg', 'sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, '1.json'), '{"sessionId":"s1","name":"Orch: build","updatedAt":1}')
  const r = rec()
  const d = deps({ CLAUDE_CODE_SESSION_ID: 's1' }, { goals: 0 })
  assert.match(await cli(['goals', r], d), /a subcommand is required/)
  assert.match(await cli(['goals', r, 'bogus'], d), /unknown subcommand: bogus/)
  assert.equal(await cli(['goals', r, 'init', '--spec', 'none'], d), '0||')
  assert.ok(d.calls.includes(`node /p/goals.ts init ${join(dir, 'p')}/goals.md --spec none`))
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

/** The journal a test reads: the dispatch events (one per write) apart from the steps, links and escapes. */
function journaled(env: Record<string, string> = {}, answers: Answers = {}): Deps & World & { events: Record<string, unknown>[]; dispatches: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = []
  const dispatches: Record<string, unknown>[] = []
  const journal = (event: object): void => {
    const e = event as Record<string, unknown>
    ;(e['kind'] === 'dispatch' ? dispatches : events).push(e)
  }
  return { ...deps({ CLAUDE_CODE_SESSION_ID: 'orch-1', ...env }, answers), journal, events, dispatches }
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

test('a verdict --reviewed is the review of its head: it leaves the review step in the journal, the head with it', async () => {
  await withGoals()
  const d = journaled()
  const head = 'd'.repeat(40)
  const none = { repo: null, pr: null, head: null }
  await cli(['open', rec(), '--class', 'feature', '--tier', 'deep'], d)
  d.events.length = 0
  // A row with no review: the verdict records the head and says so.
  await cli(['verdict', rec(), '1', '--head', head, '--result', 'pass', '--words', 'clean', '--reviewed'], d)
  assert.deepEqual(factsOf(d.events), [
    ['step', 'orchestrator.dispatch.review', { step: 'review', edge: 'end', record: 'p/r.jsonl', row: 1, result: null }, { ...none, head }],
  ])
  // Without the flag, or with the review already at that head, the verdict says no review step.
  d.events.length = 0
  await cli(['verdict', rec(), '1', '--head', head, '--result', 'pass', '--words', 'clean', '--reviewed'], d)
  await cli(['verdict', rec(), '1', '--head', head, '--result', 'pass', '--words', 'clean'], d)
  assert.deepEqual(d.events, [])
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

test('each write is published as a dispatch event: the row, its class and pair, a one-word verdict, a full head; a read or a refused write publishes none', async () => {
  await withGoals()
  const d = journaled()
  const head = 'e'.repeat(40)
  await cli(['open', rec(), '--class', 'feature', '--model', 'model-x-1[1m]', '--effort', 'high', '--label', 'A: secret'], d)
  await cli(['open', rec(), '--class', 'Odd Class', '--tier', 'light'], d)
  await cli(['review', rec(), '1', '--head', head], d)
  await cli(['verdict', rec(), '1', '--head', 'abc1234', '--result', 'fail', '--words', 'secret words'], d)
  await cli(['close', rec(), '1', '--verdict', 'merged'], d)
  await cli(['close', rec(), '2', '--verdict', 'thing#12 merged, the secret said'], d)
  await cli(['pr', rec(), 'acme/app#7', '--working', 'Agent: secret'], d)
  await cli(['goals', rec(), 'met', 'G1', '--evidence', 'x#1'], d)
  await cli(['summary', rec()], d)
  await cli(['goals', rec(), 'status'], d)
  assert.match(await cli(['round', rec(), '9'], d), /^1\|/)
  const record = 'p/r.jsonl'
  const pair = { class: 'feature', tier: null, model: 'model-x-1[1m]', effort: 'high' }
  const bare = { class: null, tier: null, model: null, effort: null, verdict: null }
  assert.deepEqual(d.dispatches.map(e => [(e['source'] as { code: string }).code, e['fact'], (e['subject'] as { head: string | null }).head]), [
    ['orchestrator.dispatch.open', { sub: 'open', record, row: 1, ...pair, verdict: null }, null],
    ['orchestrator.dispatch.open', { sub: 'open', record, row: 2, ...bare, tier: 'light' }, null],
    ['orchestrator.dispatch.review', { sub: 'review', record, row: 1, ...pair, verdict: null }, head],
    ['orchestrator.dispatch.verdict', { sub: 'verdict', record, row: 1, ...pair, verdict: 'fail' }, null],
    ['orchestrator.dispatch.close', { sub: 'close', record, row: 1, ...pair, verdict: 'merged' }, null],
    ['orchestrator.dispatch.close', { sub: 'close', record, row: 2, ...bare, tier: 'light' }, null],
    ['orchestrator.dispatch.pr', { sub: 'pr', record, row: null, ...bare }, null],
    ['orchestrator.dispatch.goals', { sub: 'goals', record, row: null, ...bare }, null],
  ])
  for (const event of d.dispatches) {
    assert.equal(event['v'], 3)
    assert.equal((event['context'] as { session: string }).session, 'orch-1')
    assert.ok(parseJournalEvent(event), JSON.stringify(event))
  }
  assert.ok(!JSON.stringify(d.dispatches).includes('secret'))
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

test('a pull request\'s line in the ledger: set, kept beside the rows, archived beside the record', async () => {
  await withGoals()
  const r = rec()
  await cli(['open', r, '--class', 'c', '--tier', 'deep'])
  assert.equal(await cli(['pr', r]), '1||ERROR: pr: a pull request <owner/name>#<n> is required\n')
  assert.equal(await cli(['pr', r, 'acme/app#x', '--working', 'Agent: a']), '1||ERROR: pr: a pull request <owner/name>#<n> is required, got: acme/app#x\n')
  assert.equal(await cli(['pr', r, 'acme/app#7']), '1||ERROR: pr: give one of --working "<agent>", --waiting "<what>" or --parked "<the operator\'s words, dated>"\n')
  assert.equal(await cli(['pr', r, 'acme/app#7', '--working', 'Agent: a', '--parked', 'later']), '1||ERROR: pr: give one of --working "<agent>", --waiting "<what>" or --parked "<the operator\'s words, dated>"\n')
  assert.equal(await cli(['pr', r, 'acme/app#7', '--waiting', ' ']), '1||ERROR: pr: --waiting needs its text\n')
  assert.equal(await cli(['pr', r, 'acme/app#7', '--working', 'Agent: a']), '0|acme/app#7 en cours (agent Agent: a)\n|')
  assert.equal(await cli(['pr', r, 'acme/app#8', '--waiting', 'la CI']), '0|acme/app#8 attend la CI depuis 2026-11-08T10:11Z\n|')
  assert.equal(await cli(['pr', r, 'acme/app#7', '--parked', 'plus tard, 2026-11-08']), "0|acme/app#7 en attente par l'opérateur\n|")
  const text = readFileSync(r, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  assert.deepEqual(text.map(line => line['id'] ?? `${line['repo']}#${line['pr']} ${line['status']}`), [1, 'acme/app#8 waiting', 'acme/app#7 parked'])
  // The rows' readings never take a ledger line for a row.
  assert.equal(await cli(['summary', r, '--open', '--ids']), '0|open=1\ndeferred=0\nids: 1\n|')
  assert.equal(await cli(['round', r, '1']), '0||')
  assert.equal(readFileSync(r, 'utf8').split('\n').filter(Boolean).length, 3)
  assert.equal(await cli(['pr-archive', r, 'acme/app#9']), `1||ERROR: pr-archive: acme/app#9 has no line in ${r}\n`)
  assert.equal(await cli(['pr-archive', r, 'acme/app#7']), '0|archived acme/app#7\n|')
  const archived = readFileSync(join(dir, 'p', 'r.archive.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  assert.deepEqual(archived.map(line => [line['pr'], line['status'], line['archived']]), [[7, 'parked', '2026-11-08T10:11:12Z']])
  assert.deepEqual(readFileSync(r, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)['pr'] ?? 'row'), ['row', 8])
})
