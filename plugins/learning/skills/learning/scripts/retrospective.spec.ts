// The retrospective's code: what waits, the judgment kept as the candidate's state, the session started.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { candidateStateDir, candidateStateFile, journalDir, learningEvent, parseCandidateState, RETROSPECTIVE_CONTRACT, type LearningEvent } from '../../../core/learning.ts'
import { launchArgv, LOG_FILE, PROMPT, RETROSPECTIVE_USAGE, run, STARTED_FILE, type Deps } from './retrospective.ts'
import { decision, writeEntries } from './fixture.ts'

const NOW = Date.parse('2026-11-14T10:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const HEAD = 'a'.repeat(40)

let serial = 0

/** `count` refusals of `code`, a day old, over two pull requests of one repository. */
function events(code: string, count = 3): LearningEvent[] {
  return Array.from({ length: count }, (_, i) => {
    const event = learningEvent({
      kind: 'refusal', at: new Date(NOW - DAY).toISOString().replace('.000Z', 'Z'), random: (serial++).toString(16).padStart(8, '0'),
      source: { plugin: 'github', code }, subject: { repo: 'acme/app', pr: 1 + (i % 2), head: HEAD }, context: { paths: ['src/a.ts'], role: 'implementer' },
      evidence: [{ type: 'refusal', code }, { type: 'record', path: 'records/review.json' }, { type: 'check', name: 'CI', head: HEAD }, { type: 'finding', severity: 'critical', file: 'src/a.ts' }, { type: 'ruling', path: 'round/1.md', line: 4 }],
      trust: 'computed',
    })
    assert.ok(event)
    return event
  })
}

function scratch(work: (config: string) => void): void {
  const config = mkdtempSync(join(tmpdir(), 'learning-retro-'))
  try {
    work(config)
  } finally {
    rmSync(config, { recursive: true, force: true })
  }
}

function journal(config: string, list: readonly LearningEvent[]): void {
  mkdirSync(journalDir(config, 'github'), { recursive: true })
  for (const event of list) writeFileSync(join(journalDir(config, 'github'), `${event.id}.json`), JSON.stringify(event))
}

interface Capture { outs: string[]; errs: string[]; launched: string[][]; deps: Deps }

function capture(input = '', now = NOW, status = 0): Capture {
  const outs: string[] = []
  const errs: string[] = []
  const launched: string[][] = []
  return { outs, errs, launched, deps: { out: l => outs.push(l), err: l => errs.push(l), now: () => now, input: () => input, launch: (...args) => { launched.push(args); return status } } }
}

const SIGNATURE = 'refusal:github.writing.rule:critical:source:typescript'
const judgement = (list: readonly LearningEvent[], change: Record<string, unknown> = {}) => JSON.stringify({
  signature: SIGNATURE,
  cause: { resolved: true, first_failure: 'the rules are read after the text', counterfactual: 'read first, the commit passes', evidence: [list[0]?.id], alternatives: ['the rules changed'], confidence: 'low' },
  remedy: { scope: 'project', rung: 'lint', target: 'acme/app', proof: { type: 'test', path: 'tests/writing.test.ts' } },
  ...change,
})
const stateIn = (config: string) => parseCandidateState(JSON.parse(readFileSync(join(candidateStateDir(config), candidateStateFile(SIGNATURE)), 'utf8')))

test('the digest lists each candidate that waits with the pointers of its events', () => {
  scratch(config => {
    const none = capture()
    assert.equal(run(['digest', '--config', config], none.deps), 0)
    assert.deepEqual(none.outs, ['learning retrospective: 0 of 0 candidates to judge'])
    const list = events('github.writing.rule', RETROSPECTIVE_CONTRACT.digest_events + 2)
    journal(config, list)
    const { outs, errs, deps } = capture()
    assert.equal(run(['digest', '--config', config], deps), 0)
    const lines = outs.join('\n').split('\n')
    assert.equal(lines[0], 'learning retrospective: 1 of 1 candidates to judge')
    assert.equal(lines[1], `candidate ${SIGNATURE}`)
    assert.match(lines[2] ?? '', /^ {2}8 events from 2 pull requests \(acme\/app#1, acme\/app#2\) in 1 repositories \(acme\/app\), /)
    assert.equal(lines[3], `  event ${list[0]?.id} trust computed; acme/app#1; head ${HEAD}; role implementer; paths src/a.ts; refusal github.writing.rule; record records/review.json; check CI at ${HEAD}; finding critical src/a.ts; ruling round/1.md:4`)
    assert.equal(lines.filter(line => line.startsWith('  event ')).length, RETROSPECTIVE_CONTRACT.digest_events)
    assert.equal(lines.at(-1), '  and 2 more events')
    assert.deepEqual(errs, [])
  })
})

test('a repository cluster is digested by its sessions, and its judgment kept under a file of the candidates\' directory', () => {
  scratch(config => {
    const code = 'github.ready.held'
    const list = ['sess-1', 'sess-1', 'sess-2'].map(session => {
      const event = learningEvent({
        kind: 'refusal', at: new Date(NOW - DAY).toISOString().replace('.000Z', 'Z'), random: (serial++).toString(16).padStart(8, '0'),
        source: { plugin: 'github', code }, subject: { repo: 'acme/app_x' }, context: { session }, evidence: [{ type: 'refusal', code }], trust: 'computed',
      })
      assert.ok(event)
      return event
    })
    journal(config, list)
    const read = capture()
    assert.equal(run(['digest', '--config', config], read.deps), 0)
    const lines = read.outs.join('\n').split('\n')
    const signature = 'refusal:github.ready.held:@acme/app_x'
    assert.equal(lines[1], `candidate ${signature}`)
    assert.match(lines[2] ?? '', /^ {2}3 events from 2 sessions and no pull request in 1 repositories \(acme\/app_x\), /)
    const kept = capture(judgement(list, { signature, remedy: { scope: 'project', rung: 'lint', target: 'acme/app_x', proof: { type: 'test', path: 'tests/ready.test.ts' } } }))
    assert.equal(run(['judge', '--config', config], kept.deps), 0)
    assert.deepEqual([kept.outs, kept.errs], [[`${signature}: proposed`], []])
    assert.deepEqual(readdirSync(candidateStateDir(config)), ['refusal_github.ready.held_@acme+app_x.json'])
    const after = capture()
    assert.equal(run(['digest', '--config', config], after.deps), 0)
    assert.deepEqual(after.outs, ['learning retrospective: 0 of 1 candidates to judge'])
  })
})

test('the digest stays under its ceiling and counts the candidates past it', () => {
  scratch(config => {
    const codes = Array.from({ length: 40 }, (_, i) => `github.guard-${String(i).padStart(2, '0')}.${'x'.repeat(60)}`)
    journal(config, codes.flatMap(code => events(code)))
    const { outs, deps } = capture()
    assert.equal(run(['digest', '--config', config], deps), 0)
    const text = outs.join('\n')
    const shown = text.split('\n').filter(line => line.startsWith('candidate ')).length
    assert.ok(shown > 0 && shown < 40, String(shown))
    assert.ok(text.length < RETROSPECTIVE_CONTRACT.digest_max_chars + 300)
    assert.match(text, new RegExp(`\\n${40 - shown} more candidates wait past the digest's ceiling`))
  })
})

test('a judgment is kept as the state of its candidate, which waits no more', () => {
  scratch(config => {
    const list = events('github.writing.rule')
    journal(config, list)
    const kept = capture(judgement(list))
    assert.equal(run(['judge', '--config', config], kept.deps), 0)
    assert.deepEqual([kept.outs, kept.errs], [[`${SIGNATURE}: proposed`], []])
    const state = stateIn(config)
    assert.deepEqual([state?.state, state?.at, state?.candidate.events, state?.remedy?.rung], ['proposed', '2026-11-14T10:00:00Z', list.map(e => e.id).sort(), 'lint'])
    const after = capture(judgement(list))
    assert.equal(run(['digest', '--config', config], after.deps), 0)
    assert.deepEqual(after.outs, ['learning retrospective: 0 of 1 candidates to judge'])
    assert.equal(run(['judge', '--config', config], after.deps), 1)
    assert.match(after.errs[0] ?? '', /is no candidate that waits/)
  })
})

test('a judgment that lacks a part, is no JSON or names no candidate is refused with what it lacks, and nothing is kept', () => {
  scratch(config => {
    const list = events('github.writing.rule')
    journal(config, list)
    const cases: Array<[string, RegExp]> = [
      [judgement(list, { remedy: { scope: 'project', rung: 'lint', target: 'acme/app' } }), /is not kept: a remedy holds `scope`/],
      [judgement(list, { cause: { resolved: true } }), /is not kept: a resolved cause holds/],
      ['not json', /is not JSON/],
      ['null', /is no candidate that waits/],
      [judgement(list, { signature: 'refusal:github.other.rule' }), /is no candidate that waits/],
    ]
    for (const [input, said] of cases) {
      const { outs, errs, deps } = capture(input)
      assert.equal(run(['judge', '--config', config], deps), 1)
      assert.match(errs[0] ?? '', said)
      assert.deepEqual(outs, [])
    }
    assert.throws(() => stateIn(config), /ENOENT/)
  })
})

test('a rejected candidate holds its ruling and waits again only once its events have doubled', () => {
  scratch(config => {
    const list = events('github.writing.rule')
    journal(config, list)
    assert.equal(run(['judge', '--config', config], capture(judgement(list)).deps), 0)
    const opened = capture()
    assert.equal(run(['mark', '--config', config, SIGNATURE, 'proposed', '--pr', 'acme/app#9'], opened.deps), 0)
    assert.equal(run(['mark', '--config', config, SIGNATURE, 'merged'], opened.deps), 0)
    assert.equal(stateIn(config)?.pr, 'acme/app#9')
    const bare = capture()
    assert.equal(run(['mark', '--config', config, SIGNATURE, 'rejected'], bare.deps), 1)
    assert.match(bare.errs[0] ?? '', /is not moved to rejected: a rejected candidate holds the ruling/)
    const rejected = capture()
    assert.equal(run(['mark', '--config', config, SIGNATURE, 'rejected', '--ruling', 'not worth a lint'], rejected.deps), 0)
    assert.deepEqual(rejected.outs, [`${SIGNATURE}: rejected`])
    assert.deepEqual([stateIn(config)?.state, stateIn(config)?.ruling], ['rejected', 'not worth a lint'])
    journal(config, events('github.writing.rule', 2))
    const five = capture()
    assert.equal(run(['digest', '--config', config], five.deps), 0)
    assert.equal(five.outs[0], 'learning retrospective: 0 of 1 candidates to judge')
    journal(config, events('github.writing.rule', 1))
    const six = capture()
    assert.equal(run(['digest', '--config', config], six.deps), 0)
    assert.match(six.outs[0] ?? '', /^learning retrospective: 1 of 1 candidates to judge\n.*\n.*\n {2}rejected at 2026-11-14T10:00:00Z on 3 events, ruling: not worth a lint\n/)
  })
})

test('mark refuses a signature never judged, a state that is none, and a state file that is not one', () => {
  scratch(config => {
    const { errs, deps } = capture()
    assert.equal(run(['mark', '--config', config, SIGNATURE, 'merged'], deps), 1)
    assert.match(errs[0] ?? '', /has no state to move: it was never judged/)
    assert.deepEqual([run(['mark', '--config', config, SIGNATURE, 'done'], deps), run(['mark', '--config', config], deps), run(['mark', '--config', config, SIGNATURE, 'merged', '--pr'], deps)], [2, 2, 2])
    mkdirSync(candidateStateDir(config), { recursive: true })
    writeFileSync(join(candidateStateDir(config), candidateStateFile(SIGNATURE)), '{"v":1}')
    assert.equal(run(['mark', '--config', config, SIGNATURE, 'merged'], deps), 1)
    assert.match(errs.at(-1) ?? '', /has no state to move: a candidate's state holds exactly/)
    journal(config, events('github.writing.rule'))
    const read = capture()
    assert.equal(run(['digest', '--config', config], read.deps), 0)
    assert.deepEqual(read.outs, ['learning retrospective: 0 of 1 candidates to judge'])
    assert.match(read.errs[0] ?? '', /the state of refusal:github\.writing\.rule\S* cannot be read, so it is not judged again/)
    writeFileSync(join(candidateStateDir(config), candidateStateFile(SIGNATURE)), 'not json')
    assert.equal(run(['mark', '--config', config, SIGNATURE, 'merged'], deps), 1)
  })
})

test('start launches the session once the candidates reach the threshold, and not again within the hours the contract holds', () => {
  scratch(config => {
    const codes = Array.from({ length: RETROSPECTIVE_CONTRACT.min_candidates }, (_, i) => `github.guard.rule-${i}`)
    journal(config, codes.slice(1).flatMap(code => events(code)))
    const under = capture()
    assert.equal(run(['start', '--config', config], under.deps), 0)
    assert.deepEqual([under.outs, under.launched], [[`learning retrospective: not started, ${codes.length - 1} candidates wait and it starts at ${codes.length}`], []])
    journal(config, events(codes[0] ?? ''))
    const failed = capture('', NOW, 127)
    assert.equal(run(['start', '--config', config], failed.deps), 1)
    assert.deepEqual(failed.errs, ['learning retrospective: the session did not start (exit 127)'])
    const first = capture()
    assert.equal(run(['start', '--config', config], first.deps), 0)
    assert.deepEqual(first.launched, [[PROMPT, join(config, 'learning', LOG_FILE), join(config, 'learning')]])
    assert.deepEqual(first.outs, [`learning retrospective: started on ${codes.length} candidates, its report goes to ${join(config, 'learning', LOG_FILE)}`])
    assert.equal(readFileSync(join(config, 'learning', STARTED_FILE), 'utf8'), '2026-11-14T10:00:00Z\n')
    const soon = capture('', NOW + (RETROSPECTIVE_CONTRACT.again_hours - 1) * HOUR)
    assert.equal(run(['start', '--config', config], soon.deps), 0)
    assert.deepEqual([soon.outs, soon.launched], [['learning retrospective: not started, one was started at 2026-11-14T10:00:00Z'], []])
    const later = capture('', NOW + RETROSPECTIVE_CONTRACT.again_hours * HOUR)
    assert.equal(run(['start', '--config', config], later.deps), 0)
    assert.equal(later.launched.length, 1)
  })
})

test('run refuses a call that is none of its commands, and says what it could not read', () => {
  const { errs, deps } = capture()
  assert.deepEqual([run([], deps), run(['digest'], deps), run(['digest', '--config', 'a', 'b'], deps), run(['forget', '--config', 'a'], deps)], [2, 2, 2, 2])
  assert.deepEqual(errs, Array.from({ length: 4 }, () => RETROSPECTIVE_USAGE))
  scratch(config => {
    mkdirSync(join(config, 'norms'))
    writeFileSync(journalDir(config, 'norms'), 'a file where the journal directory should be')
    const broken = capture()
    assert.equal(run(['start', '--config', config], broken.deps), 1)
    assert.match(broken.errs[0] ?? '', /so nothing is done/)
    assert.deepEqual(broken.launched, [])
  })
  assert.deepEqual(launchArgv('p', '/l').slice(-3), ['learning-retrospective', 'p', '/l'])
})

test("the digest gives the audit trail's kept findings with their pointers, and their judgment is kept", () => {
  scratch(config => {
    const kept = [1, 1, 2].map(pr => decision(NOW - DAY, pr))
    writeEntries(config, kept)
    const signature = 'finding:orchestrator.review.decision:important:source:typescript'
    const shown = capture()
    assert.equal(run(['digest', '--config', config], shown.deps), 0)
    const lines = shown.outs.join('\n').split('\n')
    assert.deepEqual(lines.slice(0, 2), ['learning retrospective: 1 of 1 candidates to judge', `candidate ${signature}`])
    assert.equal(lines[3], `  event ${kept[0]?.id} trust computed; acme/app#1; head ${HEAD}; role orchestrator; paths src/a.ts; finding important src/a.ts; record pr-records/acme/app/${HEAD}/review.json`)
    const judging = capture(judgement([], {
      signature,
      cause: { resolved: true, first_failure: 'a step', counterfactual: 'it passes', evidence: [kept[0]?.id], alternatives: ['another'], confidence: 'low' },
    }))
    assert.equal(run(['judge', '--config', config], judging.deps), 0)
    assert.deepEqual([judging.outs, judging.errs], [[`${signature}: proposed`], []])
  })
})
