// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The github reconciler's reading of each open pull request it follows: what the readiness gate found at the
// pull request's head the last time something it reads changed, kept one file a pull request under the
// configuration directory, `<config>/pr-reconcile/<owner>/<name>/<pr>.json`, so the orchestrator reads CI and
// readiness there instead of asking GitHub again. Written by github's hooks module alone; read by the
// orchestrator's tick. A producer of records touches the edge marker beside them to have the next listing at once.
// Pure, with no import: a hooks module imports it.

export const RECONCILE_DIR = 'pr-reconcile'
export const RECONCILE_VERSION = 1
/** The marker a producer touches (its mtime) so the reconciler lists its repositories at its next tick. */
export const RECONCILE_EDGE = '.edge'

/** The CI the gate read at the head, as `pr-gate` gives it: its result, the checks failed and running, and the rest kept whole. */
export interface ReconcileCi {
  readonly result: string
  readonly running: number
  readonly failed: readonly string[]
  readonly [field: string]: unknown
}

/** One pull request's reading, at its head. */
export interface ReconcileReading {
  readonly v: typeof RECONCILE_VERSION
  readonly repo: string
  readonly pr: number
  readonly head: string
  readonly base: string
  readonly draft: boolean
  readonly labels: readonly string[]
  readonly ci: ReconcileCi
  /** What the gate found missing for Ready at the head, empty when ready. */
  readonly missing: readonly string[]
  /** When the gate read it, ISO UTC. */
  readonly at: string
  /** What the reconciler read the gate on: a reading of the same fingerprint is not read again. */
  readonly fingerprint: string
}

export function reconcileRoot(config: string): string {
  return `${config}/${RECONCILE_DIR}`
}

export function reconcilePath(config: string, repo: string, pr: number): string {
  return `${reconcileRoot(config)}/${repo.toLowerCase()}/${pr}.json`
}

export function reconcileEdgePath(config: string): string {
  return `${reconcileRoot(config)}/${RECONCILE_EDGE}`
}

const isText = (value: unknown): value is string => typeof value === 'string'
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText)

/** A reading's text read, or undefined when it is not one of this version. */
export function parseReconcile(text: string): ReconcileReading | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const ci = r['ci']
  if (r['v'] !== RECONCILE_VERSION || !isText(r['repo']) || typeof r['pr'] !== 'number' || !Number.isInteger(r['pr']) || r['pr'] < 1) return undefined
  if (!isText(r['head']) || !/^[0-9a-f]{40}$/.test(r['head']) || !isText(r['base']) || typeof r['draft'] !== 'boolean') return undefined
  if (!texts(r['labels']) || !texts(r['missing']) || !isText(r['at']) || !isText(r['fingerprint'])) return undefined
  if (typeof ci !== 'object' || ci === null || Array.isArray(ci)) return undefined
  const c = ci as Record<string, unknown>
  if (!isText(c['result']) || typeof c['running'] !== 'number' || !texts(c['failed'])) return undefined
  return {
    v: RECONCILE_VERSION, repo: r['repo'], pr: r['pr'], head: r['head'], base: r['base'], draft: r['draft'], labels: r['labels'],
    ci: { ...c, result: c['result'], running: c['running'], failed: c['failed'] }, missing: r['missing'], at: r['at'], fingerprint: r['fingerprint'],
  }
}
