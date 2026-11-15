// The outcomes reader: each guard in warn's would-be refusals, judged by what the forge says of
// their pull requests, and the phase core gives each guard, learned or not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { candidateStateDir, candidateStateFile, journalDir, judged, learningEvent, moved, parseCandidate, type CandidateState, type LearningEvent, type PrFacts } from '../../../core/learning.ts'
import { ghForge, outcomes, OUTCOMES_USAGE, parsePrView, render, run, type Forge } from './outcomes.ts'

const CODE = 'github.learned.rule'
let serial = 0

function escape(pr: number | null, at: string, code = CODE, repo = 'acme/app'): LearningEvent {
  const event = learningEvent({
    at, random: (serial++).toString(16).padStart(8, '0'), kind: 'escape', source: { plugin: 'github', code }, trust: 'computed',
    evidence: [{ type: 'refusal', code }], subject: { repo, pr, head: null },
  })
  assert.ok(event)
  return event
}

function learnedState(code: string, merged: boolean): CandidateState {
  const events = ['20261101T101500Z-0a1b2c3d', '20261102T101500Z-0a1b2c3d', '20261103T101500Z-0a1b2c3d']
  const candidate = parseCandidate({
    v: 1, signature: `refusal:${code}`, kind: 'refusal', code, severity: null, classes: [], languages: [],
    since: '2026-10-15T10:00:00Z', until: '2026-11-14T10:00:00Z', events, prs: ['acme/app#7', 'acme/app#8'], repos: ['acme/app'],
  })
  assert.ok(candidate)
  const cause = { resolved: true, first_failure: 'a step', counterfactual: 'it passes', evidence: [events[0]], alternatives: ['another'], confidence: 'low' }
  const proposed = judged(candidate, { signature: candidate.signature, cause, remedy: { scope: 'project', rung: 'guard', target: 'acme/app', proof: { type: 'test', path: 'hooks/tests/a.test.ts' } } }, '2026-11-14T11:00:00Z')
  assert.ok(typeof proposed !== 'string', String(proposed))
  if (!merged) return proposed
  const done = moved(proposed, { state: 'merged', pr: 'acme/app#9' }, '2026-11-15T11:00:00Z')
  assert.ok(typeof done !== 'string', String(done))
  return done
}

const AT = '2026-11-14T10:00:00Z'
const CORRECTED: PrFacts = { mergedAt: '2026-11-14T12:00:00Z', commits: ['2026-11-14T09:00:00Z', '2026-11-14T11:00:00Z'] }
const UNCORRECTED: PrFacts = { mergedAt: '2026-11-14T12:00:00Z', commits: ['2026-11-14T09:00:00Z'] }
const OPEN: PrFacts = { mergedAt: null, commits: ['2026-11-14T09:00:00Z'] }

function forgeOf(byPr: Record<number, PrFacts | string>, asked: string[] = []): Forge {
  return (repo, pr) => {
    asked.push(`${repo}#${pr}`)
    return byPr[pr] ?? 'gh exited 1: not found'
  }
}

test('each pull request is judged at its first would-be refusal, asked of the forge once, and tallied', () => {
  const asked: string[] = []
  const events = [escape(1, AT), escape(1, '2026-11-14T11:30:00Z'), escape(2, AT), escape(3, AT), escape(4, AT), escape(null, AT), escape(1, AT, 'github.other.rule')]
  const list = outcomes(events, [], forgeOf({ 1: CORRECTED, 2: UNCORRECTED, 3: OPEN }, asked))
  assert.deepEqual(list.map(o => [o.code, o.right, o.wrong, o.open, o.unread, o.verdict]), [
    ['github.learned.rule', 1, 1, 1, 1, 'warn'],
    ['github.other.rule', 1, 0, 0, 0, 'warn'],
  ])
  assert.deepEqual(asked, ['acme/app#1', 'acme/app#2', 'acme/app#3', 'acme/app#4'])
})

test('a code is ready to enforce at nine in ten of five decided, proved wrong under it, and a learned guard takes core\'s phase', () => {
  const five = [1, 2, 3, 4, 5].map(pr => escape(pr, AT))
  const right = forgeOf({ 1: CORRECTED, 2: CORRECTED, 3: CORRECTED, 4: CORRECTED, 5: CORRECTED })
  assert.equal(outcomes(five, [], right)[0]?.verdict, 'enforce')
  assert.equal(outcomes(five, [], forgeOf({ 1: CORRECTED, 2: CORRECTED, 3: CORRECTED, 4: UNCORRECTED, 5: UNCORRECTED }))[0]?.verdict, 'wrong')
  // A learned guard enforces only once its remedy merged.
  const [proposed] = outcomes(five, [learnedState(CODE, false)], right)
  assert.equal(proposed?.verdict, 'warn')
  assert.equal(proposed?.learned?.state, 'proposed')
  assert.equal(outcomes(five, [learnedState(CODE, true)], right)[0]?.verdict, 'enforce')
  // A learned guard with no would-be refusal yet is listed all the same.
  assert.deepEqual(outcomes([], [learnedState(CODE, true)], right).map(o => [o.code, o.right + o.wrong + o.open, o.verdict]), [[CODE, 0, 'warn']])
})

test('render says each code\'s tally and phase, the learned guard it is, and that it changes nothing', () => {
  assert.match(render([]), /no guard in warn/)
  const text = render(outcomes([escape(1, AT), escape(2, AT)], [learnedState(CODE, true)], forgeOf({ 1: CORRECTED })))
  assert.match(text, /github\.learned\.rule +1 right, 0 wrong, 0 open, 1 unread: warn \(learned guard refusal:github\.learned\.rule, merged\)/)
  assert.match(text, /pull request; this report changes nothing/)
  const wrong = render(outcomes([1, 2, 3, 4, 5].map(pr => escape(pr, AT)), [], forgeOf({ 1: UNCORRECTED, 2: UNCORRECTED, 3: UNCORRECTED, 4: UNCORRECTED, 5: UNCORRECTED })))
  assert.match(wrong, /0 right, 5 wrong, 0 open: proved wrong, proposed for removal/)
})

test('the forge is asked through gh pr view, its answer read, a refusal or a stranger answer said', () => {
  const runs: string[][] = []
  const forge = ghForge(argv => {
    runs.push([...argv])
    if (argv[3] === '1') return { status: 0, stdout: JSON.stringify({ mergedAt: '2026-11-14T12:00:00Z', commits: [{ committedDate: '2026-11-14T11:00:00Z' }, { committedDate: 'soon' }, 'x'] }), stderr: '' }
    if (argv[3] === '2') return { status: 0, stdout: '[]', stderr: '' }
    return { status: 1, stdout: '', stderr: 'warning\nGraphQL: Could not resolve to a PullRequest\n' }
  })
  assert.deepEqual(forge('acme/app', 1), { mergedAt: '2026-11-14T12:00:00Z', commits: ['2026-11-14T11:00:00Z'] })
  assert.deepEqual(runs[0], ['gh', 'pr', 'view', '1', '-R', 'acme/app', '--json', 'mergedAt,commits'])
  assert.equal(forge('acme/app', 2), 'gh answered no pull request')
  assert.equal(forge('acme/app', 3), 'gh exited 1: GraphQL: Could not resolve to a PullRequest')
  assert.deepEqual(parsePrView(JSON.stringify({ mergedAt: '', commits: [] })), { mergedAt: null, commits: [] })
  assert.deepEqual(parsePrView(JSON.stringify({ mergedAt: '0001-01-01T00:00:00Z', commits: [] })), { mergedAt: null, commits: [] })
  assert.equal(parsePrView('not json'), undefined)
  assert.equal(parsePrView('null'), undefined)
})

test('the command line reads the journals and the states under --config, and refuses any other call', () => {
  const config = mkdtempSync(join(tmpdir(), 'learning-outcomes-'))
  try {
    mkdirSync(journalDir(config, 'github'), { recursive: true })
    for (const e of [escape(1, AT), escape(2, AT)]) writeFileSync(join(journalDir(config, 'github'), `${e.id}.json`), JSON.stringify(e))
    mkdirSync(candidateStateDir(config), { recursive: true })
    const state = learnedState(CODE, true)
    writeFileSync(join(candidateStateDir(config), candidateStateFile(state.signature)), JSON.stringify(state))
    writeFileSync(join(candidateStateDir(config), 'broken.json'), '{')
    const outs: string[] = []
    const errs: string[] = []
    assert.equal(run(['--config', config], { out: l => outs.push(l), err: l => errs.push(l), forge: forgeOf({ 1: CORRECTED, 2: OPEN }) }), 0)
    assert.match(outs.join('\n'), /1 right, 0 wrong, 1 open: warn \(learned guard/)
    assert.match(errs.join('\n'), /broken\.json cannot be read/)
    assert.equal(run([], { out: l => outs.push(l), err: l => errs.push(l), forge: forgeOf({}) }), 2)
    assert.equal(errs.at(-1), OUTCOMES_USAGE)
    assert.equal(run(['--config', config], { out: l => outs.push(l), err: l => errs.push(l), forge: () => { throw new Error('no gh') } }), 1)
    assert.match(errs.at(-1) ?? '', /could not be read: no gh/)
  } finally {
    rmSync(config, { recursive: true, force: true })
  }
})
