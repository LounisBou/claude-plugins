// The outcome evals' harness run end to end with no model: real git benches over a small
// repository whose merged change has a test, stub agents, a stub meter and a stub judge.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, rmSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { deckPath, run as outcome, parseOptions } from '../../outcome.ts'
import type { Io } from '../io.ts'
import { gitBench, isTestPath, printed, tail } from './bench.ts'
import { parseCapsFile, parseCases, selectCases, type Case, type Caps } from './cases.ts'
import { brief, overlap, runEvals, type Agent, type Judge, type Meter, type Ports, type Report } from './harness.ts'
import { Ledger } from './ledger.ts'
import { markdown, totals } from './report.ts'
import { filesJudge, idleAgent, oracleAgent, silentMeter } from './stub.ts'

const CAPS: Caps = { runUsd: 40, caseArmUsd: 10, judgeUsd: 1, cases: 1 }

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim()
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}

// The suite fails on a value of `broken`, and runs every check a change adds.
const SUITE = '#!/bin/bash\nset -e\ncd "$(dirname "$0")/.."\n[ "$(cat value)" != broken ]\nfor check in tests/*.check; do [ -f "$check" ] && bash "$check"; done\necho suite done\n'

interface Fixture {
  readonly root: string
  readonly task: Case
}

/** A repository whose merged change sets the value to 2, with a check that fails on the base. */
function fixture(merged = '2'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'outcome-repo-'))
  git(root, 'init', '--quiet', '--initial-branch=main')
  write(root, 'plugins/demo/value', '1\n')
  write(root, 'plugins/demo/tests/run-tests.sh', SUITE)
  git(root, 'add', '--all')
  git(root, 'commit', '--quiet', '-m', 'base')
  const base = git(root, 'rev-parse', 'HEAD')
  write(root, 'plugins/demo/value', `${merged}\n`)
  write(root, 'plugins/demo/tests/value.check', '[ "$(cat value)" = 2 ]\n')
  git(root, 'add', '--all')
  git(root, 'commit', '--quiet', '-m', 'the value is 2')
  const merge = git(root, 'rev-parse', 'HEAD')
  return { root, task: { id: 'value-is-two', pr: 7, base, merge, plugin: 'demo', task: 'The value must be 2.' } }
}

const quiet = (): void => undefined

/** A stand-in for the host's binary: its test kit passes when the plugin's value is 2. */
// Asked headless, it answers as the host does: an arm in a bench sets the value to 2, and every
// answer carries a verdict a judge would give.
const HOST = join(mkdtempSync(join(tmpdir(), 'outcome-host-')), 'host')
writeFileSync(
  HOST,
  [
    '#!/bin/bash',
    'if [ "$1" = -p ]; then',
    '  [ -d plugins/demo ] && printf "2\\n" > plugins/demo/value',
    `  printf '%s' '${JSON.stringify({ subtype: 'success', is_error: false, total_cost_usd: 1.25, result: '{"matches": true, "reason": "r", "findings": [{"severity": "minor", "text": "t"}]}' })}'`,
    '  exit 0',
    'fi',
    '[ "$1 $2" = "plugin test" ] || exit 9',
    '[ "$(cat "$3/value")" = 2 ]',
    '',
  ].join('\n'),
)
chmodSync(HOST, 0o755)

function ports(root: string, overrides: Partial<Ports> = {}): Ports {
  return { bench: gitBench(root, 60_000, HOST), agent: oracleAgent(), meter: silentMeter(), judge: filesJudge(), now: Date.now, log: quiet, pollMs: 5, armMs: 60_000, ...overrides }
}

async function evaluate(fix: Fixture, overrides: Partial<Ports> = {}, caps: Caps = CAPS, signal = new AbortController().signal): Promise<Report> {
  return runEvals({ mode: 'dry-run', repository: 'o/r', cases: [fix.task], caps, workRoot: mkdtempSync(join(tmpdir(), 'outcome-work-')), ports: ports(fix.root, overrides), signal })
}

/** An agent that works until it is stopped, reporting `costUsd`. */
function busyAgent(costUsd: number): Agent {
  return {
    run: ({ signal }) => new Promise(done => signal.addEventListener('abort', () => done({ costUsd, error: null }), { once: true })),
  }
}

function meterAt(usd: number): Meter {
  return { start: async () => ({ spent: async () => usd }) }
}

describe('outcome evals: a dry run', () => {
  it('grades the oracle as passing every grade, and calibrates the case', async () => {
    const report = await evaluate(fixture())
    assert.equal(report.stopped, null)
    const [entry] = report.cases
    assert.ok(entry)
    assert.deepEqual(entry.calibration, { referenceSuite: true, referenceSuiteTail: null, referenceTests: ['plugins/demo/tests/value.check'], referenceTestsFailOnBase: true })
    for (const result of entry.arms) {
      assert.equal(result.status, 'done')
      assert.equal(result.grades?.suite, true)
      assert.equal(result.grades?.referenceTests, true)
      assert.equal(result.grades?.intent?.matches, true)
      assert.deepEqual(result.grades?.review, { blocking: 0, minor: 0 })
      assert.equal(result.grades?.referenceOverlap, 1)
      assert.deepEqual(result.grades?.outsidePlugin, [])
    }
    assert.deepEqual(entry.arms.map(result => result.arm), ['single', 'orchestration'])
    assert.equal(totals(report, 'single').referenceTests, 1)
  })

  it('fails an arm that leaves nothing on the reference tests and the intent, without asking the judge', async () => {
    let asked = 0
    const judge: Judge = { ...filesJudge(), intent: async () => { asked++; return { costUsd: 0, verdict: null, error: null } } }
    const report = await evaluate(fixture(), { agent: idleAgent(), judge })
    const grades = report.cases[0]?.arms[0]?.grades
    assert.equal(grades?.suite, true)
    assert.equal(grades?.referenceTests, false)
    assert.equal(grades?.intent?.matches, false)
    assert.equal(grades?.files, 0)
    assert.equal(asked, 0)
  })

  it('leaves the suite ungraded when it fails on the merged result too', async () => {
    const report = await evaluate(fixture('broken'))
    const entry = report.cases[0]
    assert.equal(entry?.calibration.referenceSuite, false)
    assert.ok(markdown(report).includes(entry?.calibration.referenceSuiteTail ?? 'unreachable'))
    assert.equal(entry?.arms[0]?.grades?.suite, null)
    assert.equal(entry?.arms[0]?.grades?.referenceTests, null)
  })

  it('counts a file outside the plugin, the catalogue excepted', async () => {
    const agent: Agent = {
      async run({ dir }) {
        write(dir, 'plugins/demo/value', '2\n')
        write(dir, 'scripts/stray.ts', 'x\n')
        write(dir, '.claude-plugin/marketplace.json', '{}\n')
        return { costUsd: 0.5, error: null }
      },
    }
    const report = await evaluate(fixture(), { agent })
    const result = report.cases[0]?.arms[0]
    assert.deepEqual(result?.grades?.outsidePlugin, ['scripts/stray.ts'])
    assert.equal(result?.grades?.files, 3)
    assert.equal(result?.costUsd, 0.5)
    assert.equal(report.spentUsd, 1)
  })
})

describe('outcome evals: the caps', () => {
  it('stops an arm when its meter reaches its share, and charges what it spent', async () => {
    const report = await evaluate(fixture(), { agent: busyAgent(0), meter: meterAt(8) })
    const result = report.cases[0]?.arms[0]
    assert.equal(result?.status, 'stopped-at-cap')
    assert.ok((result?.costUsd ?? 0) >= 8)
    assert.ok((result?.costUsd ?? 0) <= CAPS.caseArmUsd)
  })

  it('reads an arm the host stopped at its budget as stopped at the cap', async () => {
    const agent: Agent = { run: async ({ budgetUsd }) => ({ costUsd: budgetUsd, error: 'budget exceeded' }) }
    const report = await evaluate(fixture(), { agent })
    assert.equal(report.cases[0]?.arms[0]?.status, 'stopped-at-cap')
  })

  it('starts no arm the run cannot pay in full, and says why the run stopped', async () => {
    const agent: Agent = { run: async () => ({ costUsd: 6, error: null }) }
    const report = await evaluate(fixture(), { agent }, { ...CAPS, runUsd: 15 })
    const [single, orchestration] = report.cases[0]?.arms ?? []
    assert.equal(single?.status, 'done')
    assert.equal(orchestration?.status, 'not-started')
    assert.match(report.stopped ?? '', /run cap/)
    assert.ok(report.spentUsd <= 15)
    assert.equal(totals(report, 'orchestration').ran, 0)
  })

  it('leaves the judgments out once the case-and-arm cap is spent', async () => {
    const agent: Agent = {
      async run({ dir }) {
        write(dir, 'plugins/demo/value', '2\n')
        return { costUsd: 8.5, error: null }
      },
    }
    const judge: Judge = { intent: async () => ({ costUsd: null, verdict: null, error: 'no answer' }), review: filesJudge().review }
    const report = await evaluate(fixture(), { agent, judge }, { ...CAPS, caseArmUsd: 9, judgeUsd: 1 })
    const result = report.cases[0]?.arms[0]
    assert.equal(result?.grades?.intent, null)
    assert.equal(result?.grades?.review, null)
    assert.equal(result?.costUsd, 9)
    assert.equal(result?.grades?.notes.length, 2)
  })

  it('stops an arm at its deadline', async () => {
    const report = await evaluate(fixture(), { agent: busyAgent(1), armMs: 20 })
    assert.equal(report.cases[0]?.arms[0]?.status, 'deadline')
  })

  it('reports an agent that fails as an error, graded on what it left', async () => {
    const agent: Agent = { run: async () => { throw new Error('the host is gone') } }
    const report = await evaluate(fixture(), { agent })
    const result = report.cases[0]?.arms[0]
    assert.equal(result?.status, 'error')
    assert.equal(result?.reason, 'the host is gone')
    assert.equal(result?.grades?.files, 0)
  })

  it('stops the run when it is cancelled, the arm at work included', async () => {
    const controller = new AbortController()
    const agent: Agent = {
      run: input => {
        setTimeout(() => controller.abort(new Error('cancelled')), 5)
        return busyAgent(0.2).run(input)
      },
    }
    const report = await evaluate(fixture(), { agent }, CAPS, controller.signal)
    const [single, orchestration] = report.cases[0]?.arms ?? []
    assert.equal(single?.status, 'cancelled')
    assert.equal(single?.grades, null)
    assert.equal(orchestration?.status, 'not-started')
    assert.equal(report.stopped, 'the run was cancelled')
  })
})

describe('outcome evals: inputs', () => {
  const sha = (digit: string): string => digit.repeat(40)
  const entry = { id: 'a-case', pr: 3, base: sha('a'), merge: sha('b'), plugin: 'github', task: ' Fix it. ' }

  it('reads cases and trims the task', () => {
    const cases = parseCases({ version: 1, repository: 'o/r', cases: [entry] })
    assert.equal(cases.cases[0]?.task, 'Fix it.')
  })

  it('refuses a malformed case file', () => {
    assert.throws(() => parseCases([]), /not an object/)
    assert.throws(() => parseCases({ version: 2 }), /version/)
    assert.throws(() => parseCases({ version: 1, repository: 'nope', cases: [entry] }), /repository/)
    assert.throws(() => parseCases({ version: 1, repository: 'o/r', cases: [] }), /non-empty/)
    assert.throws(() => parseCases({ version: 1, repository: 'o/r', cases: [entry, entry] }), /twice/)
    assert.throws(() => parseCases({ version: 1, repository: 'o/r', cases: ['x'] }), /object/)
    assert.throws(() => parseCases({ version: 1, repository: 'o/r', cases: [{ ...entry, id: 'Bad Id' }] }), /kebab/)
    assert.throws(() => parseCases({ version: 1, repository: 'o/r', cases: [{ ...entry, base: 'abc' }] }), /commit hash/)
    assert.throws(() => parseCases({ version: 1, repository: 'o/r', cases: [{ ...entry, merge: entry.base }] }), /same commit/)
    assert.throws(() => parseCases({ version: 1, repository: 'o/r', cases: [{ ...entry, task: '  ' }] }), /empty/)
    assert.throws(() => parseCases({ version: 1, repository: 'o/r', cases: [{ ...entry, plugin: '../x' }] }), /plugin/)
    assert.throws(() => parseCases({ version: 1, repository: 'o/r', cases: [{ ...entry, pr: 0 }] }), /pull request/)
  })

  it('reads the caps and refuses caps that cannot hold', () => {
    const runs = { pilot: CAPS, measure: { ...CAPS, cases: 6 } }
    assert.equal(parseCapsFile({ version: 1, runs }).runs.measure.cases, 6)
    assert.throws(() => parseCapsFile(null), /not an object/)
    assert.throws(() => parseCapsFile({ version: 0, runs }), /version/)
    assert.throws(() => parseCapsFile({ version: 1, runs: [] }), /runs/)
    assert.throws(() => parseCapsFile({ version: 1, runs: { ...runs, pilot: 3 } }), /object/)
    assert.throws(() => parseCapsFile({ version: 1, runs: { ...runs, pilot: { ...CAPS, runUsd: -1 } } }), /positive/)
    assert.throws(() => parseCapsFile({ version: 1, runs: { ...runs, pilot: { ...CAPS, caseArmUsd: 50 } } }), /above/)
    assert.throws(() => parseCapsFile({ version: 1, runs: { ...runs, pilot: { ...CAPS, judgeUsd: 5 } } }), /nothing/)
  })

  it('selects the named case, or the first ones of the file', () => {
    const cases = parseCases({ version: 1, repository: 'o/r', cases: [entry, { ...entry, id: 'b-case' }] })
    assert.deepEqual(selectCases(cases, CAPS, undefined).map(task => task.id), ['a-case'])
    assert.deepEqual(selectCases(cases, CAPS, 'b-case').map(task => task.id), ['b-case'])
    assert.throws(() => selectCases(cases, CAPS, 'c-case'), /no case named/)
    assert.throws(() => selectCases(cases, { ...CAPS, cases: 3 }, undefined), /replays 3/)
  })

  it('keeps the run inside its cap in the ledger', () => {
    const ledger = new Ledger(CAPS)
    const account = ledger.open()
    assert.ok(account)
    assert.equal(account.armUsd, 8)
    account.charge(9.5)
    assert.equal(account.judgeUsd, 0.5)
    account.charge(1)
    assert.throws(() => account.charge(-1), /non-negative/)
    assert.equal(ledger.spent, 10.5)
    ledger.open()?.charge(10)
    ledger.open()?.charge(10)
    assert.equal(ledger.open(), null)
  })
})

describe('outcome evals: pieces', () => {
  it('tells a test of the plugin from the rest', () => {
    assert.equal(isTestPath('plugins/a/tests/run-tests.sh', 'a'), true)
    assert.equal(isTestPath('plugins/a/hooks/tests/x.test.ts', 'a'), true)
    assert.equal(isTestPath('plugins/a/hooks/x.test.ts', 'a'), true)
    assert.equal(isTestPath('plugins/a/engine/test_x.py', 'a'), true)
    assert.equal(isTestPath('plugins/a/hooks/x.ts', 'a'), false)
    assert.equal(isTestPath('plugins/b/tests/run-tests.sh', 'a'), false)
  })

  it('reads what a failed process printed', () => {
    assert.equal(printed('plain'), 'plain')
    assert.equal(printed({ stdout: 'out', stderr: 'err', code: 1 }), 'out\nerr')
  })

  it('keeps the failing lines of a long suite output before its last ones', () => {
    const output = ['  FAIL early check', ...Array.from({ length: 100 }, (_, n) => `  ok   check ${n}`), '1 failed'].join('\n')
    const kept = tail(output).split('\n')
    assert.equal(kept[0], '  FAIL early check')
    assert.ok(kept.includes('1 failed'))
    assert.equal(kept.at(-1), '  ok   check 99')
    assert.ok(kept.length <= 40)
  })

  it('measures the overlap of two sets of files', () => {
    assert.equal(overlap([], []), 1)
    assert.equal(overlap(['a', 'b'], ['b', 'c']), 1 / 3)
  })

  it('reports a missing suite as failing', async () => {
    const fix = fixture()
    const bench = gitBench(fix.root, 60_000, HOST)
    assert.equal((await bench.suite(fix.root, 'nothing', new AbortController().signal)).passed, false)
    await assert.rejects(bench.suite(fix.root, '../x', new AbortController().signal), /not a plugin name/)
  })

  it("runs the host's test kit when the plugin holds TypeScript tests", async () => {
    const fix = fixture()
    const bench = gitBench(fix.root, 60_000, HOST)
    const signal = new AbortController().signal
    write(fix.root, 'plugins/demo/hooks/x.test.ts', '')
    assert.equal((await bench.suite(fix.root, 'demo', signal)).passed, true)
    write(fix.root, 'plugins/demo/value', '3\n')
    rmSync(join(fix.root, 'plugins/demo/tests/value.check'))
    const failed = await bench.suite(fix.root, 'demo', signal)
    assert.equal(failed.passed, false)
    assert.ok(failed.tail.includes('suite done'))
  })

  it('briefs both arms alike, naming the suite', () => {
    const task = fixture().task
    assert.match(brief('o/r', task), /plugins\/demo\/tests\/run-tests\.sh/)
    assert.ok(brief('o/r', task).includes(task.task))
  })

  it('writes a report table per case and the totals', async () => {
    const report = await evaluate(fixture(), { agent: { run: async () => ({ costUsd: 1, error: null }) } }, { ...CAPS, runUsd: 10 })
    const text = markdown(report)
    assert.equal(text.split('\n').filter(line => line.startsWith('| single |')).length, 2)
    assert.ok(text.includes(report.stopped ?? 'unreachable'))
  })
})

interface Recorded extends Io {
  readonly lines: { out: string[]; err: string[] }
}

function recorder(): Recorded {
  const lines = { out: [] as string[], err: [] as string[] }
  return { lines, out: line => lines.out.push(line), err: line => lines.err.push(line), env: {} }
}

describe('outcome evals: the command', () => {
  function repository(): string {
    const fix = fixture()
    write(fix.root, 'evals/outcome/cases.json', JSON.stringify({ version: 1, repository: 'o/r', cases: [fix.task] }))
    write(fix.root, 'evals/outcome/caps.json', JSON.stringify({ version: 1, runs: { pilot: CAPS, measure: CAPS } }))
    return fix.root
  }

  it('runs a dry run into a directory outside the checkout and writes the report', async () => {
    const root = repository()
    const out = join(mkdtempSync(join(tmpdir(), 'outcome-out-')), 'run')
    const io = recorder()
    assert.equal(await outcome(root, ['dry-run', '--out', out], io, new AbortController().signal), 0)
    const report: Report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
    assert.equal(report.cases[0]?.arms[1]?.grades?.referenceTests, true)
    assert.ok(existsSync(join(out, 'report.md')))
    assert.equal(await outcome(root, ['dry-run', '--out', out], io, new AbortController().signal), 2)
    assert.match(io.lines.err.join('\n'), /must be empty/)
  })

  it('refuses a directory inside the checkout, and a bad command line', () => {
    const root = repository()
    assert.match(String(parseOptions(root, ['dry-run', '--out', 'inside'])), /outside the checkout/)
    assert.match(String(parseOptions(root, ['dry-run', '--out', '.'])), /outside the checkout/)
    assert.match(String(parseOptions(root, ['dry-run'])), /usage/)
    assert.match(String(parseOptions(root, ['replay', '--out', '/tmp/x'])), /usage/)
    assert.match(String(parseOptions(root, ['dry-run', '--out', '/tmp/x', '--nope'])), /nope/)
    assert.deepEqual(parseOptions(root, ['dry-run', '--out', '/tmp/x', '--case', 'a']), {
      mode: 'dry-run',
      out: '/tmp/x',
      only: 'a',
      host: 'claude',
      model: undefined,
      judgeModel: undefined,
      deck: undefined,
    })
    assert.match(String(parseOptions(root, ['pilot', '--out', '/tmp/x', '--model', 'm'])), /needs --model and --judge-model/)
    const measure = parseOptions(root, ['measure', '--out', '/tmp/x', '--model', 'm', '--judge-model', 'j'])
    assert.equal(typeof measure === 'string' ? measure : measure.judgeModel, 'j')
  })

  it('runs a pilot through the host, under the pilot caps, with the arms and the judge it names', async () => {
    const root = repository()
    const out = join(mkdtempSync(join(tmpdir(), 'outcome-out-')), 'run')
    const deck = join(mkdtempSync(join(tmpdir(), 'outcome-deck-')), 'deck.json')
    const args = ['pilot', '--out', out, '--host', HOST, '--model', 'm', '--judge-model', 'j', '--deck', deck]
    assert.equal(await outcome(root, args, recorder(), new AbortController().signal), 0)
    const report: Report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
    assert.equal(report.mode, 'pilot')
    for (const result of report.cases[0]?.arms ?? []) {
      assert.equal(result.status, 'done')
      assert.equal(result.grades?.referenceTests, true)
      assert.equal(result.grades?.intent?.matches, true)
      assert.deepEqual(result.grades?.review, { blocking: 0, minor: 1 })
      assert.equal(result.costUsd, 3.75)
    }
    assert.equal(report.spentUsd, 7.5)
    assert.ok('enabledPlugins' in JSON.parse(readFileSync(join(out, 'settings.json'), 'utf8')))
  })

  it("finds the deck under the orchestrator's state directory", () => {
    assert.equal(deckPath({ ORCHESTRATOR_STATE_DIR: '/state' }), '/state/deck.json')
    assert.equal(deckPath({ CLAUDE_CONFIG_DIR: '/config' }), '/config/claude-orchestrator/deck.json')
  })

  it('refuses a bad command line with its usage', async () => {
    const io = recorder()
    assert.equal(await outcome(repository(), ['nope'], io, new AbortController().signal), 2)
    assert.match(io.lines.err.join('\n'), /usage/)
  })
})
