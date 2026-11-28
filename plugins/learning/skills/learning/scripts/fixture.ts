// The audit trail's entries for the tests, as a journal holds them: written out field by field, not
// built by core's writer, so a spec reads the shape of each version as it is on disk.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { journalDir } from '../../../core/learning.ts'

const HEAD = 'a'.repeat(40)
const RECORD = `pr-records/acme/app/${HEAD}/review.json`

let serial = 0

export interface Entry {
  readonly v: number
  readonly id: string
  readonly at: string
  readonly kind: string
  readonly fact: Readonly<Record<string, unknown>>
  readonly [field: string]: unknown
}

/** One entry of version `v` at `ms`, of the pull request `pr` of acme/app; none for null. */
export function entry(v: number, kind: string, code: string, fact: Entry['fact'], ms: number, pr: number | null): Entry {
  const at = `${new Date(ms).toISOString().slice(0, 19)}Z`
  return {
    v, id: `${at.replace(/[-:]/g, '')}-${(0xf0000000 + serial++).toString(16)}`, at, kind,
    source: { plugin: 'orchestrator', code },
    subject: { repo: pr === null ? null : 'acme/app', pr, head: HEAD },
    context: { role: 'orchestrator', mode: null, paths: [], languages: [], session: '9f391605-d7df-4532-928d-5ac4c1bd59f1' },
    evidence: [{ type: 'record', path: RECORD }],
    trust: 'computed', fact,
  }
}

const FACT = { decision: 'kept', severity: 'important', file: 'src/a.ts', line: 12 }

/** A decision on a review's finding, version 4: kept, important, in src/a.ts unless `change` says otherwise. */
export function decision(ms: number, pr: number, change: Entry['fact'] = {}): Entry {
  return entry(4, 'decision', 'orchestrator.review.decision', { ...FACT, finding_id: 'tests:981d8efd9b', lens: 'tests', ...change }, ms, pr)
}

/** The same decision as version 2 wrote it, without the finding's id and its lens. */
export function earlierDecision(ms: number, pr: number): Entry {
  return entry(2, 'decision', 'orchestrator.review.decision', { ...FACT }, ms, pr)
}

/** A failure of the method, version 2: a verdict accepted over a failed review. */
export function failure(ms: number, pr: number): Entry {
  return entry(2, 'failure', 'orchestrator.review.overridden', { failure: 'verdict-overridden', count: null, prs: [] }, ms, pr)
}

/** One entry of each audit fact that is no kind of a candidate, at the version it is written at. */
export function otherFacts(ms: number, pr: number): Entry[] {
  return [
    entry(2, 'link', 'orchestrator.dispatch.close', { record: 'work/dispatch.jsonl', row: 83, session: null, goal: null, prs: [] }, ms, pr),
    entry(2, 'step', 'orchestrator.dispatch.review', { step: 'review', edge: 'end', record: 'work/dispatch.jsonl', row: 3, result: null }, ms, pr),
    entry(2, 'review', 'orchestrator.review.verdict', { verdict: 'fail', kept: 2, set_aside: 0 }, ms, pr),
    entry(2, 'wait', 'orchestrator.wait.operator', { wait: 'operator', edge: 'end', span: null, on: 'operator' }, ms, pr),
    entry(3, 'dispatch', 'orchestrator.dispatch.cost', { sub: 'cost', record: 'work/dispatch.jsonl', row: 554, class: 'fix', tier: 'standard', model: null, effort: null, verdict: null }, ms, pr),
    entry(5, 'reconcile', 'orchestrator.reconcile.counts', { ticks: 60, listings: 239, gates: 25, moves: 0 }, ms, pr),
  ]
}

/** `entries` in the orchestrator's journal under `config`, one file each. */
export function writeEntries(config: string, entries: readonly Entry[]): void {
  mkdirSync(journalDir(config, 'orchestrator'), { recursive: true })
  for (const one of entries) writeFileSync(join(journalDir(config, 'orchestrator'), `${one.id}.json`), JSON.stringify(one))
}
