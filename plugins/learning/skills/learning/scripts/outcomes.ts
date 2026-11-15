// learning — the outcomes of the guards in warn, read from the forge: a report, never an act.
//
//   outcomes.ts --config <dir>    per guard code that left would-be refusals, and per learned guard,
//                                 warn, ready to enforce, or proved wrong
//
// <dir> is the host's configuration directory. A guard in warn lets a call through and leaves an
// escape under its code, the refusal it would have answered as its evidence. Each pull request those
// escapes name is asked of the forge (the `gh` CLI): a commit after the first would-be refusal and
// before the merge makes it right, a merge with none wrong, neither yet open (core/learning.ts,
// `prOutcomeOf`, `wouldBeVerdict`). A learned guard is a candidate's state whose remedy is a guard,
// its escapes under its candidate's code; its phase is core's `guardPhase`, any other code's
// `isEnforceable`. Raising a guard to enforce is a pull request that sets its plugin's phase; this
// script changes nothing.
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  guardPhase, isEnforceable, prOutcomeOf, provedWrong, tallyOf, wouldBeRefusals, wouldBeVerdict,
  type CandidateState, type LearningEvent, type PrFacts, type WouldBeVerdict,
} from '../../../core/learning.ts'
import { readJournals } from './health.ts'
import { readStates } from './retrospective.ts'

export const OUTCOMES_USAGE = 'usage: outcomes.ts --config <dir>'

/** What the forge answers of a pull request: its facts, or the sentence that says why it was not read. */
export type Forge = (repo: string, pr: number) => PrFacts | string

export interface GuardOutcome {
  readonly code: string
  readonly right: number
  readonly wrong: number
  readonly open: number
  /** The pull requests the forge did not answer. */
  readonly unread: number
  readonly verdict: 'warn' | 'enforce' | 'wrong'
  /** The learned guard's state, where the code is one. */
  readonly learned: CandidateState | undefined
}

/** The codes of the guards in warn: those whose escapes point at the refusal they would have made. */
function warnedCodes(events: readonly LearningEvent[]): string[] {
  return events.filter(e => e.kind === 'escape' && e.evidence.some(p => p.type === 'refusal')).map(e => e.source.code)
}

/** The outcome of every guard in warn and every learned guard, by code; the forge asked once per pull request. */
export function outcomes(events: readonly LearningEvent[], states: readonly CandidateState[], forge: Forge): GuardOutcome[] {
  const learned = states.filter(state => state.remedy?.rung === 'guard')
  const codes = [...new Set([...warnedCodes(events), ...learned.map(state => state.candidate.code)])].sort()
  const asked = new Map<string, PrFacts | string>()
  const factsOf = (key: string, repo: string, pr: number): PrFacts | string => {
    const known = asked.get(key) ?? forge(repo, pr)
    asked.set(key, known)
    return known
  }
  return codes.map(code => {
    const verdicts: WouldBeVerdict[] = []
    let unread = 0
    for (const [key, list] of wouldBeRefusals(events, code)) {
      const first = list.reduce((a, b) => (a.at <= b.at ? a : b))
      const { repo, pr } = first.subject
      if (repo === null || pr === null) continue
      const facts = factsOf(key, repo, pr)
      if (typeof facts === 'string') unread++
      else verdicts.push(wouldBeVerdict(prOutcomeOf(facts, first.at)))
    }
    const tally = tallyOf(verdicts)
    const state = learned.find(s => s.candidate.code === code)
    const phase = state === undefined ? (isEnforceable(tally) ? 'enforce' : 'warn') : guardPhase(state, verdicts)
    return { code, ...tally, unread, verdict: provedWrong(tally) ? 'wrong' : phase === 'enforce' ? 'enforce' : 'warn', learned: state }
  })
}

const SAID = { warn: 'warn', enforce: 'ready to enforce', wrong: 'proved wrong, proposed for removal' } as const

/** The report, in lines. */
export function render(list: readonly GuardOutcome[]): string {
  if (list.length === 0) return 'learning outcomes: no guard in warn left a would-be refusal, and no learned guard is kept.'
  return [
    'learning outcomes, per guard code: would-be refusals right (corrected), wrong (merged uncorrected), open; the phase they give',
    ...list.map(o => `  ${o.code.padEnd(40)} ${o.right} right, ${o.wrong} wrong, ${o.open} open${o.unread > 0 ? `, ${o.unread} unread` : ''}: ${SAID[o.verdict]}${o.learned === undefined ? '' : ` (learned guard ${o.learned.signature}, ${o.learned.state})`}`),
    'A guard is raised to enforce, or removed, by a pull request; this report changes nothing.',
  ].join('\n')
}

/** The forge's answer through the `gh` CLI: `gh pr view` with its merge time and its commits' times. */
export function ghForge(run: (argv: readonly string[]) => { status: number | null; stdout: string; stderr: string }): Forge {
  return (repo, pr) => {
    const out = run(['gh', 'pr', 'view', String(pr), '-R', repo, '--json', 'mergedAt,commits'])
    if (out.status !== 0) return `gh exited ${out.status ?? 'on a signal'}: ${out.stderr.trim().split('\n').at(-1) ?? ''}`
    return parsePrView(out.stdout) ?? 'gh answered no pull request'
  }
}

/** The facts of a `gh pr view --json mergedAt,commits` answer, or undefined when it is not one. */
export function parsePrView(text: string): PrFacts | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const { mergedAt, commits } = raw as { mergedAt?: unknown; commits?: unknown }
  if (!Array.isArray(commits)) return undefined
  const times = commits.flatMap(c => {
    const at = typeof c === 'object' && c !== null ? (c as { committedDate?: unknown }).committedDate : undefined
    return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? [at] : []
  })
  // gh writes an unmerged pull request's time as empty, or as the zero time.
  const merged = typeof mergedAt === 'string' && mergedAt !== '' && !mergedAt.startsWith('0001-') ? mergedAt : null
  return { mergedAt: merged, commits: times }
}

export interface Deps {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly forge: Forge
}

/** The command line; the exit status. */
export function run(args: readonly string[], deps: Deps): number {
  const [flag, config, ...rest] = args
  if (flag !== '--config' || config === undefined || rest.length > 0) {
    deps.err(OUTCOMES_USAGE)
    return 2
  }
  try {
    const events = readJournals(config).flatMap(journal => journal.events)
    deps.out(render(outcomes(events, readStates(config, deps.err), deps.forge)))
    return 0
  } catch (error) {
    deps.err(`learning outcomes: the journals or the states could not be read: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/* node:coverage ignore next 8 */
const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = run(process.argv.slice(2), {
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
    forge: ghForge(([command = 'gh', ...argv]) => spawnSync(command, argv, { encoding: 'utf8', timeout: 30_000 })),
  })
}
