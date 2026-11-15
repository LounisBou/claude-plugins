// learning — forget and check, in code with no model.
//
//   forget.ts --config <dir>    each merged remedy checked against the window after its merge, and
//                               each learned guard that stayed silent over two windows
//
// <dir> is the host's configuration directory. A merged remedy whose candidate's signature did not
// fall to half over the window after its merge is moved to `ineffective`: its candidate reopens, and
// the retrospective judges it again (core/learning.ts, `afterLanding`, `isDue`); its remedy is then
// proposed for removal. A learned guard with no event under its code over two windows is proposed for
// removal (`isSilentGuard`). A removal is a pull request: this script writes the state move and
// prints the proposals, nothing else. A prompt rule's removal reads its ablation instead
// (scripts/lib/outcome/ablation.ts).
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterLanding, isSilentGuard, moved, type CandidateState, type LearningEvent } from '../../../core/learning.ts'
import { readJournals } from './health.ts'
import { keep, readStates } from './retrospective.ts'

export const FORGET_USAGE = 'usage: forget.ts --config <dir>'

const iso = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`

export interface Checked {
  /** One line per merged remedy and per proposal. */
  readonly lines: readonly string[]
  /** The states moved to `ineffective`, to keep. */
  readonly reopened: readonly CandidateState[]
}

/** What forgetting and checking say of `states` at `now`, from the journals' events. */
export function check(states: readonly CandidateState[], events: readonly LearningEvent[], now: number): Checked {
  const lines: string[] = []
  const reopened: CandidateState[] = []
  for (const state of states) {
    const landed = afterLanding(state, events, now)
    if (landed === undefined) continue
    const remedy = `${state.remedy?.rung ?? 'remedy'} ${state.pr ?? ''}`.trim()
    if (landed.verdict === 'pending') {
      lines.push(`  ${state.signature}: ${remedy} merged at ${state.at}, checked at ${landed.due}`)
      continue
    }
    if (landed.verdict === 'held') {
      lines.push(`  ${state.signature}: ${remedy} held, ${landed.before} events before its merge, ${landed.after} after`)
      if (isSilentGuard(state, events, now)) lines.push(`  ${state.signature}: learned guard ${state.pr ?? ''} silent over two windows, proposed for removal`)
      continue
    }
    const next = moved(state, { state: 'ineffective' }, iso(now))
    if (typeof next === 'string') {
      lines.push(`  ${state.signature}: ineffective but not moved: ${next}`)
      continue
    }
    reopened.push(next)
    lines.push(`  ${state.signature}: ${remedy} ineffective, ${landed.before} events before its merge, ${landed.after} after: reopened, its remedy proposed for removal`)
  }
  return { lines, reopened }
}

export interface Deps {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly now: () => number
}

/** The command line; the exit status. */
export function run(args: readonly string[], deps: Deps): number {
  const [flag, config, ...rest] = args
  if (flag !== '--config' || config === undefined || rest.length > 0) {
    deps.err(FORGET_USAGE)
    return 2
  }
  try {
    const events = readJournals(config).flatMap(journal => journal.events)
    const { lines, reopened } = check(readStates(config, deps.err), events, deps.now())
    for (const state of reopened) keep(config, state)
    deps.out(lines.length === 0 ? 'learning forget: no merged remedy to check.' : ['learning forget, the merged remedies:', ...lines, 'A removal is a pull request; this script moved only the reopened candidates.'].join('\n'))
    return 0
  } catch (error) {
    deps.err(`learning forget: the journals or the states could not be read or written, so nothing is done: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/* node:coverage ignore next 7 */
const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = run(process.argv.slice(2), {
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
    now: Date.now,
  })
}
