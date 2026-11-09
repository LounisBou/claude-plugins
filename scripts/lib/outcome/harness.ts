// The outcome evals' run: each case replayed from its base by each arm, and graded on what it
// left. Calibration first, with no model: the suite must pass on the merged result, and the
// reference's own tests must fail on the base, or the grader they feed reads « not graded »
// rather than a figure that measures the bench. Then each arm, under its cap: stopped when its
// meter reaches its share, when its deadline passes, or when the run is cancelled. Then the
// grades: the suite on the arm's result, the reference's tests laid over it, the intent judged
// against the task and the reference, the findings of a review. Money passes through the ledger.
import { join } from 'node:path'
import type { Bench, Diff } from './bench.ts'
import { ARMS, type Arm, type Case, type Caps, type Mode } from './cases.ts'
import { Ledger, type Account } from './ledger.ts'

/** What an orchestration driven as a session reports of its run. */
export interface OrchestrationRun {
  /** The agent sessions it opened, besides its own. */
  readonly agentsOpened: number
  /** The decisions it took in place of the operator, `question → choice`. */
  readonly decisions: readonly string[]
  /** The question of the turn that ended waiting on the operator, or null. */
  readonly askedOperator: string | null
  /** Why the driver ended the arm with nothing to grade; absent when it has something. */
  readonly notGraded?: string
}

export interface AgentRun {
  /** What the arm reports it spent, when it reports it. */
  readonly costUsd: number | null
  readonly error: string | null
  /** Set by an arm that is an orchestrator session; the single arm and the dry run's oracle leave it out. */
  readonly orchestration?: OrchestrationRun
}

export interface AgentInput {
  readonly case: Case
  readonly arm: Arm
  readonly dir: string
  readonly prompt: string
  readonly budgetUsd: number
  readonly signal: AbortSignal
}

export interface Agent {
  run(input: AgentInput): Promise<AgentRun>
}

/** A running reading of what an arm has spent since it started, every session it opened included. */
export interface Probe {
  spent(): Promise<number>
}

export interface Meter {
  start(arm: Arm): Promise<Probe>
}

export interface IntentVerdict {
  readonly matches: boolean
  readonly reason: string
}

export interface Finding {
  readonly severity: 'blocking' | 'minor'
  readonly text: string
}

export interface ReviewVerdict {
  readonly findings: readonly Finding[]
}

export interface Judgment<T> {
  readonly costUsd: number | null
  readonly verdict: T | null
  readonly error: string | null
}

export interface JudgeInput {
  readonly case: Case
  readonly diff: Diff
  readonly reference: Diff
  readonly budgetUsd: number
  readonly signal: AbortSignal
}

/** A model asked what needs judgment; never the arm's own session. */
export interface Judge {
  intent(input: JudgeInput): Promise<Judgment<IntentVerdict>>
  review(input: JudgeInput): Promise<Judgment<ReviewVerdict>>
}

export interface Ports {
  readonly bench: Bench
  readonly agent: Agent
  readonly meter: Meter
  readonly judge: Judge
  readonly now: () => number
  readonly log: (line: string) => void
  /** How often an arm's meter is read. */
  readonly pollMs: number
  /** An arm still working at this is stopped. */
  readonly armMs: number
}

export type Status = 'done' | 'stopped-at-cap' | 'deadline' | 'cancelled' | 'error' | 'not-started' | 'asked-operator' | 'not-graded'

export interface Grades {
  /** The plugin's suite on the arm's result; null when it fails on the reference too. */
  readonly suite: boolean | null
  /** The suite with the reference's tests laid over the result; null when they do not fail on the base. */
  readonly referenceTests: boolean | null
  readonly intent: IntentVerdict | null
  readonly review: { readonly blocking: number; readonly minor: number } | null
  readonly files: number
  readonly lines: number
  /** Files touched outside the case's plugin, the catalogue excepted. */
  readonly outsidePlugin: readonly string[]
  /** Files touched in common with the reference over files touched by either, 0 to 1. */
  readonly referenceOverlap: number
  /** Why a grade is missing, one line each. */
  readonly notes: readonly string[]
}

export interface ArmResult {
  readonly arm: Arm
  readonly status: Status
  readonly reason: string | null
  readonly costUsd: number
  readonly durationSeconds: number
  /** The agent sessions an orchestration opened; null for an arm that is not one. */
  readonly agentsOpened: number | null
  /** The decisions an orchestration took in place of the operator. */
  readonly decisions: readonly string[]
  readonly grades: Grades | null
}

export interface Calibration {
  readonly referenceSuite: boolean
  /** The suite's last lines when it fails on the merged result, else null. */
  readonly referenceSuiteTail: string | null
  readonly referenceTests: readonly string[]
  readonly referenceTestsFailOnBase: boolean
}

export interface CaseResult {
  readonly id: string
  readonly pr: number
  readonly plugin: string
  readonly calibration: Calibration
  readonly arms: readonly ArmResult[]
}

export interface Report {
  readonly version: 1
  readonly mode: Mode | 'dry-run'
  readonly startedAt: string
  readonly finishedAt: string
  readonly caps: Caps
  readonly spentUsd: number
  /** Why the run ended before its last arm, or null. */
  readonly stopped: string | null
  readonly cases: readonly CaseResult[]
}

export interface RunInput {
  readonly mode: Mode | 'dry-run'
  readonly repository: string
  readonly cases: readonly Case[]
  readonly caps: Caps
  /** An empty directory outside the checkout: the benches are made under it. */
  readonly workRoot: string
  readonly ports: Ports
  readonly signal: AbortSignal
}

const CATALOGUE = '.claude-plugin/marketplace.json'

/** What an arm is asked: the same words for both arms, so only the way of working differs. */
export function brief(repository: string, task: Case): string {
  return [
    `This is a checkout of ${repository} at the commit before a change. Make the change the task below asks for.`,
    '',
    task.task,
    '',
    `Follow the repository's CLAUDE.md. Land the change with a test that fails without it, and run plugins/${task.plugin}/tests/run-tests.sh.`,
    'Commit the change in this checkout. It has no remote: push nothing and open no pull request.',
  ].join('\n')
}

export function overlap(a: readonly string[], b: readonly string[]): number {
  const union = new Set([...a, ...b])
  if (union.size === 0) return 1
  const inB = new Set(b)
  return a.filter(path => inB.has(path)).length / union.size
}

function reasonOf(signal: AbortSignal): string {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason.message : String(reason)
}

async function calibrate(task: Case, input: RunInput): Promise<Calibration> {
  const { bench } = input.ports
  const reference = join(input.workRoot, task.id, 'reference')
  await bench.prepare(reference, task.merge)
  const suite = await bench.suite(reference, task.plugin, input.signal)
  const tests = await bench.referenceTests(task.base, task.merge, task.plugin)
  let referenceTestsFailOnBase = false
  if (tests.length > 0) {
    const base = join(input.workRoot, task.id, 'base-with-reference-tests')
    await bench.prepare(base, task.base)
    await bench.overlay(base, task.merge, tests)
    referenceTestsFailOnBase = !(await bench.suite(base, task.plugin, input.signal)).passed
  }
  return { referenceSuite: suite.passed, referenceSuiteTail: suite.passed ? null : suite.tail, referenceTests: tests, referenceTestsFailOnBase }
}

interface Worked {
  readonly status: Exclude<Status, 'not-started'>
  readonly reason: string | null
  readonly costUsd: number
  readonly orchestration: OrchestrationRun | null
}

/**
 * An orchestration its driver could not grade is not graded, an error of its close said beside.
 * An orchestration that opened no agent measured a single session: it is not graded, whatever
 * stopped it. One that ended on a question for the operator is stopped there, and graded on
 * what it left. An error or a cancellation stays what it is.
 */
function asOrchestration(worked: Worked, orchestration: OrchestrationRun | undefined): Worked {
  if (orchestration === undefined) return worked
  const kept = { ...worked, orchestration }
  if (worked.status === 'cancelled') return kept
  if (orchestration.notGraded !== undefined) {
    const error = worked.status === 'error' ? ` (${worked.reason ?? ''})` : ''
    return { ...kept, status: 'not-graded', reason: `not graded: ${orchestration.notGraded}${error}` }
  }
  if (worked.status === 'error') return kept
  if (orchestration.agentsOpened === 0) {
    return { ...kept, status: 'not-graded', reason: `not graded: no agent opened${worked.reason === null ? '' : ` (${worked.reason})`}` }
  }
  if (worked.status === 'done' && orchestration.askedOperator !== null) {
    return { ...kept, status: 'asked-operator', reason: `stopped: asked the operator — ${orchestration.askedOperator}` }
  }
  return kept
}

async function work(task: Case, arm: Arm, dir: string, account: Account, input: RunInput): Promise<Worked> {
  const { agent, meter, pollMs, armMs } = input.ports
  const controller = new AbortController()
  const stop = (why: string): void => {
    if (!controller.signal.aborted) controller.abort(new Error(why))
  }
  const cancel = (): void => stop('cancelled')
  input.signal.addEventListener('abort', cancel, { once: true })
  if (input.signal.aborted) cancel()
  const deadline = setTimeout(() => stop('deadline'), armMs)
  const probe = await meter.start(arm)
  let reading = 0
  const poll = setInterval(() => {
    probe.spent().then(
      usd => {
        reading = Math.max(reading, usd)
        if (reading >= account.armUsd) stop('cap')
      },
      () => undefined, // an unreadable meter leaves the host's own budget and the deadline to stop the arm
    )
  }, pollMs)
  let result: AgentRun
  try {
    result = await agent.run({ case: task, arm, dir, prompt: brief(input.repository, task), budgetUsd: account.armUsd, signal: controller.signal })
  } catch (error: unknown) {
    result = { costUsd: null, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearInterval(poll)
    clearTimeout(deadline)
    input.signal.removeEventListener('abort', cancel)
  }
  const final = await probe.spent().catch(() => 0)
  const costUsd = Math.max(reading, final, result.costUsd ?? 0)
  account.charge(costUsd)
  const worked = ((): Worked => {
    const base = { costUsd, orchestration: null }
    if (controller.signal.aborted) {
      const why = reasonOf(controller.signal)
      if (why === 'cap') return { ...base, status: 'stopped-at-cap', reason: `the arm reached its ${account.armUsd} USD share` }
      if (why === 'deadline') return { ...base, status: 'deadline', reason: `the arm worked past ${Math.round(armMs / 60000)} minutes` }
      return { ...base, status: 'cancelled', reason: 'the run was cancelled' }
    }
    if (costUsd >= account.armUsd) return { ...base, status: 'stopped-at-cap', reason: `the arm reached its ${account.armUsd} USD share` }
    if (result.error !== null) return { ...base, status: 'error', reason: result.error }
    return { ...base, status: 'done', reason: null }
  })()
  return asOrchestration(worked, result.orchestration)
}

async function judged<T>(account: Account, notes: string[], what: string, ask: (budgetUsd: number) => Promise<Judgment<T>>): Promise<T | null> {
  const budgetUsd = account.judgeUsd
  if (budgetUsd <= 0) {
    notes.push(`${what}: not judged, the case-and-arm cap is reached`)
    return null
  }
  let judgment: Judgment<T>
  try {
    judgment = await ask(budgetUsd)
  } catch (error: unknown) {
    judgment = { costUsd: null, verdict: null, error: error instanceof Error ? error.message : String(error) }
  }
  // A judgment that reports no cost is charged its whole allowance.
  account.charge(judgment.costUsd ?? budgetUsd)
  if (judgment.verdict === null) notes.push(`${what}: no verdict (${judgment.error ?? 'none returned'})`)
  return judgment.verdict
}

/** What the grades say of an orchestration whose agents left the graded checkout as it was. */
const NO_COMMIT = 'no commit in the graded checkout'

async function grade(task: Case, dir: string, calibration: Calibration, account: Account, input: RunInput, orchestration: OrchestrationRun | null): Promise<Grades> {
  const { bench, judge } = input.ports
  const notes: string[] = []
  const diff = await bench.changes(dir, task.base)
  if (diff.files.length === 0 && (orchestration?.agentsOpened ?? 0) > 0) notes.push(NO_COMMIT)
  const reference = await bench.reference(task.base, task.merge)

  let suite: boolean | null = null
  if (calibration.referenceSuite) suite = (await bench.suite(dir, task.plugin, input.signal)).passed
  else notes.push('suite: not graded, it fails on the merged result too')

  let referenceTests: boolean | null = null
  if (!calibration.referenceSuite) notes.push('reference tests: not graded, the suite fails on the merged result')
  else if (calibration.referenceTests.length === 0) notes.push('reference tests: not graded, the merged change added none')
  else if (!calibration.referenceTestsFailOnBase) notes.push('reference tests: not graded, they pass on the base already')
  else {
    await bench.overlay(dir, task.merge, calibration.referenceTests)
    referenceTests = (await bench.suite(dir, task.plugin, input.signal)).passed
  }

  let intent: IntentVerdict | null
  let review: Grades['review'] = null
  if (diff.files.length === 0) {
    intent = { matches: false, reason: 'the arm left no change' }
  } else {
    const ask = { case: task, diff, reference, signal: input.signal }
    intent = await judged(account, notes, 'intent', budgetUsd => judge.intent({ ...ask, budgetUsd }))
    const found = await judged(account, notes, 'review', budgetUsd => judge.review({ ...ask, budgetUsd }))
    if (found !== null) {
      const blocking = found.findings.filter(finding => finding.severity === 'blocking').length
      review = { blocking, minor: found.findings.length - blocking }
    }
  }

  return {
    suite,
    referenceTests,
    intent,
    review,
    files: diff.files.length,
    lines: diff.lines,
    outsidePlugin: diff.files.filter(path => !path.startsWith(`plugins/${task.plugin}/`) && path !== CATALOGUE),
    referenceOverlap: overlap(diff.files, reference.files),
    notes,
  }
}

function notStarted(arm: Arm, reason: string): ArmResult {
  return { arm, status: 'not-started', reason, costUsd: 0, durationSeconds: 0, agentsOpened: null, decisions: [], grades: null }
}

export async function runEvals(input: RunInput): Promise<Report> {
  const { ports } = input
  const startedAt = new Date(ports.now()).toISOString()
  const ledger = new Ledger(input.caps)
  const cases: CaseResult[] = []
  let stopped: string | null = null

  for (const task of input.cases) {
    if (stopped !== null) break
    ports.log(`${task.id}: calibrating on the merged result and the base`)
    const calibration = await calibrate(task, input)
    const arms: ArmResult[] = []
    for (const arm of ARMS) {
      if (stopped !== null || input.signal.aborted) {
        stopped ??= 'the run was cancelled'
        arms.push(notStarted(arm, stopped))
        continue
      }
      const account = ledger.open()
      if (account === null) {
        stopped = `the run cap of ${input.caps.runUsd} USD cannot pay another ${input.caps.caseArmUsd} USD arm`
        arms.push(notStarted(arm, stopped))
        continue
      }
      const dir = join(input.workRoot, task.id, arm)
      await ports.bench.prepare(dir, task.base)
      ports.log(`${task.id}: ${arm} at work, its share ${account.armUsd} USD`)
      const started = ports.now()
      const worked = await work(task, arm, dir, account, input)
      const durationSeconds = Math.round((ports.now() - started) / 1000)
      if (worked.status === 'cancelled') stopped = 'the run was cancelled'
      const grades = stopped === null && worked.status !== 'not-graded' ? await grade(task, dir, calibration, account, input, worked.orchestration) : null
      ports.log(`${task.id}: ${arm} ${worked.status}, ${account.spent.toFixed(2)} USD`)
      const { orchestration } = worked
      arms.push({ arm, status: worked.status, reason: worked.reason, costUsd: account.spent, durationSeconds, agentsOpened: orchestration?.agentsOpened ?? null, decisions: orchestration?.decisions ?? [], grades })
    }
    cases.push({ id: task.id, pr: task.pr, plugin: task.plugin, calibration, arms })
  }

  return {
    version: 1,
    mode: input.mode,
    startedAt,
    finishedAt: new Date(ports.now()).toISOString(),
    caps: input.caps,
    spentUsd: ledger.spent,
    stopped,
    cases,
  }
}
