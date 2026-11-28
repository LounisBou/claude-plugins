// learning — the distiller, in code with no model.
//
//   distil.ts --config <dir>    the candidates of the journals under <dir>, one JSON line each
//
// <dir> is the host's configuration directory, read as the health report reads it. The events of
// every version (`candidateEvents`) inside the contract's window are grouped by signature
// (core/learning.ts, `signatureOf`); a group that reaches the contract's thresholds is a candidate
// (`CANDIDATE_CONTRACT`). The same journals at the same time give the same lines. A journal that
// cannot be read is said on the error stream and nothing is proposed.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CANDIDATE_CONTRACT, CANDIDATE_VERSION, countsInCluster, LEARNING_CONTRACT, learningEvent, LEARNING_WINDOW_DAYS, parseCandidate, signatureFrom,
  signaturePartsOf, type AuditEvent, type Candidate, type Evidence, type LearningEvent, type SignatureParts,
} from '../../../core/learning.ts'
import { readJournals, type Journal } from './health.ts'

export const DISTIL_USAGE = 'usage: distil.ts --config <dir>'

const DAY_MS = 86_400_000

const iso = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`
const rising = (values: Iterable<string>): string[] => [...new Set(values)].sort()

/**
 * An audit event read as one of the four kinds a candidate is made of, under its own identifier: a
 * review decision that kept its finding is a finding, whose severity and file are the fact's; a
 * failure of the method is an escape. The audit trail's other facts are none of the four: undefined.
 */
function asLearningEvent(event: AuditEvent): LearningEvent | undefined {
  const read = {
    at: event.at, random: event.id.slice(-8), source: event.source, subject: event.subject, context: event.context,
    evidence: event.evidence, trust: event.trust,
  }
  if (event.kind === 'failure') return learningEvent({ ...read, kind: 'escape' })
  if (event.kind !== 'decision' || event.fact.decision !== 'kept') return undefined
  const { file } = event.fact
  const severity = LEARNING_CONTRACT.severities.find(known => known === event.fact.severity)
  const pointer: Evidence[] = file !== null && severity !== undefined ? [{ type: 'finding', severity, file }] : []
  return learningEvent({
    ...read, kind: 'finding',
    context: { ...event.context, paths: file === null ? [] : [file] },
    evidence: [...pointer, ...event.evidence].slice(0, LEARNING_CONTRACT.evidence_max),
  })
}

/** The events the candidates and their checks are computed from, out of every version the journals hold. */
export function candidateEvents(journals: readonly Journal[]): LearningEvent[] {
  return journals.flatMap(journal => [...journal.events, ...(journal.audit ?? []).flatMap(event => asLearningEvent(event) ?? [])])
}

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
    candidates = distil(candidateEvents(readJournals(config)), deps.now())
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
