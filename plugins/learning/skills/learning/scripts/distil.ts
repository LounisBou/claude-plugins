// learning — the distiller, in code with no model.
//
//   distil.ts --config <dir>    the candidates of the journals under <dir>, one JSON line each
//
// <dir> is the host's configuration directory, read as the health report reads it. The version 1
// events of the contract's window are grouped by signature (core/learning.ts, `signatureOf`); a
// group that reaches the contract's thresholds is a candidate (`CANDIDATE_CONTRACT`). The same
// journals at the same time give the same lines. A journal that cannot be read is said on the error
// stream and nothing is proposed.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CANDIDATE_CONTRACT, CANDIDATE_VERSION, countsInCluster, LEARNING_WINDOW_DAYS, parseCandidate, signatureFrom, signaturePartsOf,
  type Candidate, type LearningEvent, type SignatureParts,
} from '../../../core/learning.ts'
import { readJournals } from './health.ts'

export const DISTIL_USAGE = 'usage: distil.ts --config <dir>'

const DAY_MS = 86_400_000

const iso = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`
const rising = (values: Iterable<string>): string[] => [...new Set(values)].sort()

/**
 * The candidates of `events` at `now`: per signature, the events inside the window that count toward
 * a cluster (`countsInCluster`), kept when they are enough and name enough pull requests. A pull request is named by an
 * event that holds both its repository and its number. In the order of the signatures, whatever the
 * order the events come in.
 */
export function distil(events: readonly LearningEvent[], now: number): Candidate[] {
  const clusters = new Map<string, { readonly parts: SignatureParts; readonly events: LearningEvent[] }>()
  for (const event of events) {
    if (now - Date.parse(event.at) > LEARNING_WINDOW_DAYS * DAY_MS) continue
    if (!countsInCluster(event)) continue
    const parts = signaturePartsOf(event)
    const signature = signatureFrom(parts)
    const cluster = clusters.get(signature) ?? { parts, events: [] }
    cluster.events.push(event)
    clusters.set(signature, cluster)
  }
  const candidates: Candidate[] = []
  for (const signature of rising(clusters.keys())) {
    const cluster = clusters.get(signature)
    if (cluster === undefined) continue
    const ids = rising(cluster.events.map(e => e.id))
    const prs = rising(cluster.events.flatMap(({ subject }) => (subject.repo !== null && subject.pr !== null ? [`${subject.repo}#${subject.pr}`] : [])))
    if (ids.length < CANDIDATE_CONTRACT.min_events || prs.length < CANDIDATE_CONTRACT.min_prs) continue
    const candidate = parseCandidate({
      v: CANDIDATE_VERSION, signature, ...cluster.parts,
      since: iso(now - LEARNING_WINDOW_DAYS * DAY_MS), until: iso(now),
      events: ids, prs, repos: rising(cluster.events.flatMap(e => e.subject.repo ?? [])),
    })
    if (candidate === undefined) throw new Error(`the cluster ${signature} is no candidate of the contract`)
    candidates.push(candidate)
  }
  return candidates
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
    deps.err(DISTIL_USAGE)
    return 2
  }
  let candidates: Candidate[]
  try {
    candidates = distil(readJournals(config).flatMap(journal => journal.events), deps.now())
  } catch (error) {
    deps.err(`learning distil: the journals could not be read, so nothing is proposed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  for (const candidate of candidates) deps.out(JSON.stringify(candidate))
  return 0
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
