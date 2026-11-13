// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The pull request record contract, owned by github: one file per record under
// <config>/pr-records/<owner>/<name>/<head>/. Defined here once; `npm run core` writes it as
// pr-record.json beside each plugin's copy, which github's Python writer loads, so the two
// sides cannot drift.

export const PR_RECORD_CONTRACT = {
  version: 1,
  kinds: ['review', 'norms', 'e2e'],
  results: ['pass', 'fail', 'waived', 'not-applicable'],
  waivable: 'e2e',
  // The kind a pull request may need none of, with the reason in its detail: one whose files hold
  // no runtime, the writer checks which.
  not_applicable: 'e2e',
  // The plugin, by the name its host gives it, that alone writes each kind through
  // mcp__github__record, and the tool it writes it with; a kind with no producer here is written by
  // any caller (`open`).
  producers: {
    review: { plugin: 'pr-review', tool: 'its auto-fix-loop' },
    norms: { plugin: 'norms', tool: '/norms:check' },
  },
  open: 'e2e',
  detail_max: 500,
  patterns: {
    head: '^[0-9a-fA-F]{40}$',
    repo_part: '^[A-Za-z0-9_.-]+$',
    producer: '^[a-z0-9-]+$',
    waiver_date: String.raw`\b\d{4}-\d{2}-\d{2}\b`,
  },
} as const

const contract = PR_RECORD_CONTRACT

export type Kind = 'review' | 'norms' | 'e2e'
export type Result = 'pass' | 'fail' | 'waived' | 'not-applicable'

export interface PrRecord {
  readonly v: number
  readonly repo: string
  readonly pr: number
  readonly head: string
  readonly kind: Kind
  readonly result: Result
  readonly producer: string
  readonly detail: string
  readonly session: string
  readonly at: string
}

export const KINDS: readonly Kind[] = contract.kinds.filter(isKind)
export const RECORD_VERSION = contract.version
export const DETAIL_MAX = contract.detail_max

/** The kind a caller of mcp__github__record writes: the one its plugin produces, the open kind otherwise. */
export function kindFor(origin: string): Kind {
  for (const kind of KINDS) if (producerOf(kind)?.plugin === origin) return kind
  return contract.open
}

/** The producer the contract declares for a kind, or undefined for the kind any caller writes. */
export function producerOf(kind: string): { readonly plugin: string; readonly tool: string } | undefined {
  return Object.entries(contract.producers).find(([named]) => named === kind)?.[1]
}

const HEAD = new RegExp(contract.patterns.head)
const PRODUCER = new RegExp(contract.patterns.producer)
const REPO_PART = new RegExp(contract.patterns.repo_part)

function isKind(value: unknown): value is Kind {
  return value === 'review' || value === 'norms' || value === 'e2e'
}

function isResult(value: unknown): value is Result {
  return contract.results.some(result => result === value)
}

function isRepo(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split('/')
  return parts.length === 2 && parts.every(part => REPO_PART.test(part) && part !== '.' && part !== '..')
}

/**
 * The record `raw` holds, or undefined when a field breaks the contract's shape. Whether its
 * result lets it through the gate is `accepts`'s to say, so a waiver of the wrong kind is still
 * read, and named, as what it is.
 */
export function parsePrRecord(raw: unknown): PrRecord | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const { v, repo, pr, head, kind, result, producer, detail, session, at } = r
  if (v !== RECORD_VERSION || !isRepo(repo) || typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) return undefined
  if (typeof head !== 'string' || !HEAD.test(head) || !isKind(kind) || !isResult(result)) return undefined
  if (typeof producer !== 'string' || !PRODUCER.test(producer) || typeof detail !== 'string' || detail.length > DETAIL_MAX) return undefined
  if (typeof session !== 'string' || typeof at !== 'string') return undefined
  return { v, repo, pr, head, kind, result, producer, detail, session, at }
}

/** Whether a record lets its kind pass the ready gate: a pass, or a waiver or a not applicable where one is allowed. */
export function accepts(record: PrRecord): boolean {
  return record.result === 'pass' || (record.result === 'waived' && record.kind === contract.waivable)
    || (record.result === 'not-applicable' && record.kind === contract.not_applicable)
}
