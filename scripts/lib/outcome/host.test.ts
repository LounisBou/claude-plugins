// The real adapters, with a stand-in for the host's binary: the arguments each arm and judge
// gets, the answers read back, the process group ended at a stop, the deck's sessions metered.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Case } from './cases.ts'
import type { Diff } from './bench.ts'
import {
  agentArgs,
  armPrompt,
  deckMeter,
  deckSessions,
  DeckLedger,
  hostAgent,
  hostJudge,
  intentPrompt,
  JUDGE_DIFF_CHARS,
  judgeArgs,
  judgmentOf,
  launcherClose,
  parseHostResult,
  parseIntent,
  parseReview,
  reviewPrompt,
  runOf,
  withoutOrchestrator,
} from './host.ts'

const TASK: Case = { id: 'a-case', pr: 1, base: 'a'.repeat(40), merge: 'b'.repeat(40), plugin: 'demo', task: 'Make the value 2.' }
const DIFF: Diff = { patch: '+2\n', files: ['plugins/demo/value'], lines: 1 }
const OPTIONS = { host: 'h', model: 'm', orchestratorDir: '/o', settingsFile: '/s.json' }

/** A stand-in for the host: prints `answer`, records its arguments, sleeps when asked to. */
function fakeHost(answer: string, behaviour = ''): { binary: string; argsFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'outcome-fake-host-'))
  const binary = join(dir, 'host')
  const argsFile = join(dir, 'args')
  writeFileSync(join(dir, 'answer'), answer)
  writeFileSync(binary, `#!/bin/bash\nprintf '%s\\n' "$@" > '${argsFile}'\n${behaviour}\ncat '${join(dir, 'answer')}'\n`)
  chmodSync(binary, 0o755)
  return { binary, argsFile }
}

const answer = (fields: Record<string, unknown>): string => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 1.25, session_id: 's1', result: 'done', ...fields })

describe('outcome evals: the host answer', () => {
  it('reads the cost, the error and the result', () => {
    assert.deepEqual(parseHostResult(answer({})), { costUsd: 1.25, isError: false, result: 'done', sessionId: 's1' })
    const failed = parseHostResult(answer({ subtype: 'error_max_budget_usd', total_cost_usd: -1, result: 3, session_id: 4 }))
    assert.deepEqual(failed, { costUsd: null, isError: true, result: '', sessionId: null })
    assert.match(String(parseHostResult('not json')), /no JSON/)
    assert.match(String(parseHostResult('[1]')), /not an object/)
  })

  it('turns an exit into an arm run', () => {
    assert.deepEqual(runOf({ code: 0, stdout: answer({}), stderr: '' }), { costUsd: 1.25, error: null })
    assert.deepEqual(runOf({ code: 0, stdout: answer({ is_error: true, result: 'over budget' }), stderr: '' }), { costUsd: 1.25, error: 'over budget' })
    assert.deepEqual(runOf({ code: 1, stdout: answer({ result: '' }), stderr: '' }), { costUsd: 1.25, error: 'the host exited with 1' })
    assert.match(runOf({ code: 1, stdout: '', stderr: 'boom' }).error ?? '', /boom/)
    assert.match(runOf({ code: 1, stdout: '', stderr: '' }).error ?? '', /no JSON/)
  })
})

describe('outcome evals: the arms on the host', () => {
  it('gives each arm its budget and model, the orchestration its plugin and skill', () => {
    const single = agentArgs(OPTIONS, 'single', 'Do it.', 8)
    assert.deepEqual(single.slice(0, 8), ['-p', 'Do it.', '--output-format', 'json', '--max-budget-usd', '8.00', '--model', 'm'])
    assert.equal(single.includes('--plugin-dir'), false)
    const orchestration = agentArgs(OPTIONS, 'orchestration', 'Do it.', 8)
    assert.equal(orchestration[orchestration.indexOf('--plugin-dir') + 1], '/o')
    assert.equal(orchestration[1], armPrompt('orchestration', 'Do it.'))
    assert.notEqual(armPrompt('orchestration', 'Do it.'), 'Do it.')
    assert.ok(armPrompt('orchestration', 'Do it.').endsWith('Do it.'))
  })

  it('turns off every installed orchestrator and nothing else', () => {
    assert.deepEqual(withoutOrchestrator({ enabledPlugins: { 'orchestrator@lounisbou': true, 'orchestrator@other': true, 'github@lounisbou': true } }), {
      enabledPlugins: { 'orchestrator@lounisbou': false, 'orchestrator@other': false },
    })
    assert.deepEqual(withoutOrchestrator(null), { enabledPlugins: {} })
  })

  it('runs the host in the bench and closes what the arm left', async () => {
    const fake = fakeHost(answer({}))
    const closed: string[] = []
    const agent = hostAgent({ ...OPTIONS, host: fake.binary }, async arm => void closed.push(arm))
    const dir = mkdtempSync(join(tmpdir(), 'outcome-bench-'))
    const run = await agent.run({ case: TASK, arm: 'single', dir, prompt: 'Do it.', budgetUsd: 3, signal: new AbortController().signal })
    assert.deepEqual(run, { costUsd: 1.25, error: null })
    assert.equal(readFileSync(fake.argsFile, 'utf8').split('\n')[5], '3.00')
    assert.deepEqual(closed, ['single'])
  })

  it('ends the host when the arm is stopped', async () => {
    const fake = fakeHost(answer({}), 'sleep 30')
    const agent = hostAgent({ ...OPTIONS, host: fake.binary }, async () => undefined)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    const run = await agent.run({ case: TASK, arm: 'single', dir: tmpdir(), prompt: 'x', budgetUsd: 1, signal: controller.signal })
    assert.ok(Date.now() - started < 10_000)
    assert.notEqual(run.error, null)
  })
})

describe('outcome evals: the deck meter', () => {
  const deck = (sessions: Record<string, number | null>, tty = true): unknown => ({
    version: 3,
    coordinator: null,
    orchestrators: Object.entries(sessions)
      .filter(([key]) => key.startsWith('o'))
      .map(([key, cost]) => ({
        key,
        tty: tty ? `/dev/tty${key}` : null,
        usage: { week: { cost_usd: cost } },
        agents: Object.entries(sessions)
          .filter(([agent]) => agent.startsWith(`a${key}`))
          .map(([agent, agentCost]) => ({ key: agent, tty: `/dev/tty${agent}`, usage: { week: { cost_usd: agentCost } } })),
      })),
    unattached_agents: [{ key: 'u', tty: null, usage: null }, 'junk'],
  })

  it('lists every local session with its week cost', () => {
    const sessions = deckSessions(deck({ o1: 2, ao1x: 1 }))
    assert.deepEqual(sessions.map(session => [session.key, session.weekUsd]), [['o1', 2], ['ao1x', 1], ['u', null]])
    assert.deepEqual(deckSessions('nope'), [])
  })

  it('counts only the sessions opened since the start, each at its highest reading', () => {
    const ledger = new DeckLedger(deckSessions(deck({ o1: 50 })))
    assert.equal(ledger.read(deckSessions(deck({ o1: 60, o2: 1, ao2x: 2 }))), 3)
    // the agent gone from the deck keeps what it spent; the week's start reads lower and is kept higher
    assert.equal(ledger.read(deckSessions(deck({ o1: 70, o2: 0.5 }))), 3)
    assert.equal(ledger.read(deckSessions(deck({ o2: 4, ao2y: null }))), 6)
    assert.deepEqual(ledger.openSince(deckSessions(deck({ o1: 1, o2: 4, ao2y: 1 }))), ['/dev/ttyo2', '/dev/ttyao2y'])
  })

  it('reads the deck file, and closes what an orchestration left open', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'outcome-deck-')), 'deck.json')
    const closed: string[] = []
    const { meter, close } = deckMeter(path, async tty => void closed.push(tty))
    await close('orchestration')
    const probe = await meter.start('orchestration')
    assert.equal(await probe.spent(), 0)
    writeFileSync(path, JSON.stringify(deck({ o9: 2.5 })))
    assert.equal(await probe.spent(), 2.5)
    writeFileSync(path, '{"half')
    assert.equal(await probe.spent(), 2.5)
    writeFileSync(path, JSON.stringify(deck({ o9: 2.5 })))
    await close('single')
    assert.deepEqual(closed, [])
    await close('orchestration')
    assert.deepEqual(closed, ['/dev/ttyo9'])
  })

  it("closes a tab through the launcher, and refuses what is not a terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outcome-launcher-'))
    const scripts = join(dir, 'skills', 'iterm-agents', 'scripts')
    mkdirSync(scripts, { recursive: true })
    const log = join(dir, 'log')
    writeFileSync(join(scripts, 'iterm_agent.py'), `import sys\nopen(${JSON.stringify(log)}, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n`)
    const closeTty = launcherClose(dir)
    await closeTty('/dev/ttys004')
    await closeTty('/dev/../etc; rm')
    assert.equal(readFileSync(log, 'utf8'), 'close --tty /dev/ttys004\n')
  })
})

describe('outcome evals: the judge on the host', () => {
  it('cuts a long diff and says so', () => {
    const long = { ...DIFF, patch: 'x'.repeat(JUDGE_DIFF_CHARS + 10) }
    assert.match(intentPrompt({ case: TASK, diff: long, reference: DIFF }), /10 more characters/)
    assert.ok(reviewPrompt({ case: TASK, diff: DIFF }).includes(TASK.task))
  })

  it('reads a verdict, fenced or not, and refuses a malformed one', () => {
    assert.deepEqual(parseIntent('```json\n{"matches": true, "reason": "r"}\n```'), { matches: true, reason: 'r' })
    assert.equal(parseIntent('{"matches": "yes"}'), null)
    assert.equal(parseIntent('no object'), null)
    assert.equal(parseIntent('{broken}'), null)
    assert.deepEqual(parseReview('{"findings": [{"severity": "blocking", "text": "t"}]}'), { findings: [{ severity: 'blocking', text: 't' }] })
    assert.equal(parseReview('{"findings": [{"severity": "major", "text": "t"}]}'), null)
    assert.equal(parseReview('{"findings": 1}'), null)
  })

  it('reads a judgment from the host, and none from an error', () => {
    assert.deepEqual(judgmentOf({ code: 0, stdout: answer({ result: '{"matches": false, "reason": "r"}' }), stderr: '' }, parseIntent), {
      costUsd: 1.25,
      verdict: { matches: false, reason: 'r' },
      error: null,
    })
    assert.equal(judgmentOf({ code: 0, stdout: answer({ is_error: true }), stderr: '' }, parseIntent).verdict, null)
    assert.equal(judgmentOf({ code: 1, stdout: '', stderr: '' }, parseIntent).costUsd, null)
    assert.deepEqual(judgeArgs({ host: 'h', model: 'j', settingsFile: '/s', dir: '/d' }, 'p', 1).slice(4, 8), ['--max-budget-usd', '1.00', '--model', 'j'])
  })

  it('asks the host for both judgments', async () => {
    const fake = fakeHost(answer({ result: '{"matches": true, "reason": "r", "findings": []}' }))
    const judge = hostJudge({ host: fake.binary, model: 'j', settingsFile: '/s', dir: tmpdir() })
    const input = { case: TASK, diff: DIFF, reference: DIFF, budgetUsd: 1, signal: new AbortController().signal }
    assert.equal((await judge.intent(input)).verdict?.matches, true)
    assert.deepEqual((await judge.review(input)).verdict, { findings: [] })
  })
})
