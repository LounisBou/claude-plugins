// The pull request record contract, owned by github: one file per record under
// <config>/pr-records/<owner>/<name>/<head>/. Defined here once; `npm run core` writes it as
// pr-record.json beside each plugin's copy, which github's Python writer loads, so the two
// sides cannot drift.

export const PR_RECORD_CONTRACT = {
  version: 1,
  kinds: ['review', 'norms', 'e2e', 'tests'],
  results: ['pass', 'fail', 'waived', 'not-applicable', 'accepted'],
  // The kinds the operator's waiver lifts, once a pull request's check plan requires them.
  waivable: ['e2e', 'norms'],
  // The kind a pull request may need none of, with the reason in its detail: one whose files hold
  // no runtime, the writer checks which.
  not_applicable: 'e2e',
  // The orchestrator's review verdict that sets non-critical points aside: the result it writes, the
  // kind, and the plugin that alone writes it, with its tool. It stands on its own at its head, over a
  // failed review there too. Its detail is `set aside: <point> — <reason>; …`.
  acceptance: { result: 'accepted', kind: 'review', plugin: 'orchestrator', tool: 'mcp__orchestrator__review' },
  // The plugins, by the name their host gives them, that alone write each kind through
  // mcp__github__record, each with the tool it writes it with; a kind with no producer here is
  // written by any caller (`open`).
  producers: {
    review: [{ plugin: 'pr-review', tool: 'its auto-fix-loop' }, { plugin: 'orchestrator', tool: 'mcp__orchestrator__review' }],
    norms: [{ plugin: 'norms', tool: '/norms:check' }],
  },
  open: 'e2e',
  // The kind a script alone writes: the local test run of a stacked pull request, by github's light CI
  // (mcp__github__light_ci), its producer's slug and the only results it writes. No waiver lifts it and
  // mcp__github__record never writes it; a record of it from another producer passes nothing.
  scripted: { kind: 'tests', plugin: 'github', tool: 'mcp__github__light_ci', producer: 'light-ci', results: ['pass', 'fail'] },
  detail_max: 500,
  patterns: {
    head: '^[0-9a-fA-F]{40}$',
    repo_part: '^[A-Za-z0-9_.-]+$',
    producer: '^[a-z0-9-]+$',
  },
} as const

const contract = PR_RECORD_CONTRACT

export type Kind = 'review' | 'norms' | 'e2e' | 'tests'
export type Result = 'pass' | 'fail' | 'waived' | 'not-applicable' | 'accepted'

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
export const ACCEPTANCE = contract.acceptance
export const SCRIPTED = contract.scripted

/** The kind a caller of mcp__github__record writes: the one its plugin produces, the open kind otherwise. */
export function kindFor(origin: string): Kind {
  for (const kind of KINDS) if (producersOf(kind).some(producer => producer.plugin === origin)) return kind
  return contract.open
}

/** The producers the contract declares for a kind, none for the kind any caller writes. */
export function producersOf(kind: string): ReadonlyArray<{ readonly plugin: string; readonly tool: string }> {
  return Object.entries(contract.producers).find(([named]) => named === kind)?.[1] ?? []
}

const HEAD = new RegExp(contract.patterns.head)
const PRODUCER = new RegExp(contract.patterns.producer)
const REPO_PART = new RegExp(contract.patterns.repo_part)

function isKind(value: unknown): value is Kind {
  return value === 'review' || value === 'norms' || value === 'e2e' || value === 'tests'
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

/**
 * Whether a record lets its kind pass the ready gate: a pass, a waiver or a not applicable where one
 * is allowed, or the orchestrator's acceptance of a review. A record of the scripted kind passes only
 * from its script.
 */
export function accepts(record: PrRecord): boolean {
  if (record.kind === SCRIPTED.kind && record.producer !== SCRIPTED.producer) return false
  return record.result === 'pass' || (record.result === 'waived' && (contract.waivable as readonly Kind[]).includes(record.kind))
    || (record.result === 'not-applicable' && record.kind === contract.not_applicable)
    || isAcceptance(record)
}

/** Whether a record is the orchestrator's acceptance of a review. */
export function isAcceptance(record: PrRecord): boolean {
  return record.result === ACCEPTANCE.result && record.kind === ACCEPTANCE.kind
}

/** The detail of an acceptance: each point set aside with its reason, cut to DETAIL_MAX. */
export function acceptanceDetail(setAsides: ReadonlyArray<{ readonly point: string; readonly reason: string }>): string {
  return ('set aside: ' + setAsides.map(s => s.point.trim() + ' — ' + s.reason.trim()).join('; ')).slice(0, DETAIL_MAX)
}
