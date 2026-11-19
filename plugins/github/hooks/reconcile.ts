// The reconciler's pure decisions: the listing it reads, the fingerprint that says whether the gate must read a
// pull request again, when a repository is listed next, and the lease that keeps one reconciler per machine.
// The loop that runs them is the module's (register.ts), the gate's rule core's readiness contract.

import type { ForgeStatus } from '../core/forge-status.ts'

/** The timer's beat: each beat checks the local inputs, and lists the repositories whose listing is due. */
export const TICK_MS = 60_000
/** A repository where nothing changed and no CI runs is listed less often, up to this. */
export const IDLE_MAX_MS = 300_000
/** The quota left under which no repository is listed until it resets. */
export const QUOTA_LOW = 500
/** The wait when the quota is low and its reset unknown, or a listing was refused for the rate limit. */
export const QUOTA_WAIT_MS = 900_000
/** The gates read at one beat; the others at the next. */
export const GATES_PER_TICK = 4
/** A gate that failed on a fingerprint is not tried again on the same one before this. */
export const RETRY_MS = 300_000
/** The times another machine may undo this one's label on a head before the reconciler stops moving that label there. */
export const FLAP_UNDONE = 3
/** A repository whose records directory changed within this is reconciled. */
export const RECENT_MS = 30 * 24 * 3600 * 1000
/** A lease runs this long; its holder renews it when less than LEASE_RENEW_MS is left. */
export const LEASE_MS = 300_000
export const LEASE_RENEW_MS = 180_000
export const LEASE_FILE = '.lease'
export const LEASE_VERSION = 1

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'

/** One open pull request as the listing reads it, with the gate's copies on the forge at its head (core's forge-status.ts) when it read them. */
// mergeable and mergeState: GitHub's mergeability against the base (MERGEABLE, CONFLICTING, UNKNOWN) and its merge state, when listed.
export type ListedPr = {
  number: number; draft: boolean; head: string; base: string; labels: string[]; rollup: string | null
  mergeable?: string; mergeState?: string; statuses?: ForgeStatus[]
}
/** What the quota had left after the listing, and when it resets (ms), when GitHub said. */
export type Rate = { remaining?: number; resetAt?: number }
/** The rows, the account that listed them (whose statuses the reconciler trusts) when it said, and the quota. */
export type Listing = { rows: ListedPr[]; viewer?: string; rate: Rate }

// A status as the listing gives it, or undefined.
function statusOf(raw: unknown): ForgeStatus | undefined {
  if (!isRecord(raw)) return undefined
  const { context, state, description, creator } = raw
  if (!isText(context) || !isText(state) || !isText(description) || !isText(creator)) return undefined
  return { context, state, description, creator }
}

/** The statuses of a row in context order, so two listings of the same statuses read equal. */
export function sortedStatuses(statuses: readonly ForgeStatus[]): ForgeStatus[] {
  return [...statuses].sort((a, b) => (a.context < b.context ? -1 : a.context > b.context ? 1 : 0))
}

/** `pr-panel --reconcile`'s answer, or a throw naming what is wrong with it. */
export function parseListing(text: string): Listing {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw) || !Array.isArray(raw['rows'])) throw new Error('pr-panel --reconcile answered no rows')
  const rows: ListedPr[] = []
  for (const row of raw['rows']) {
    if (!isRecord(row) || typeof row['number'] !== 'number' || !Number.isInteger(row['number']) || row['number'] < 1) continue
    const head = row['head']
    if (!isText(head) || !/^[0-9a-f]{40}$/.test(head)) continue
    const labels = Array.isArray(row['labels']) ? row['labels'].filter(isText) : []
    const mergeable = isText(row['mergeable']) ? row['mergeable'] : undefined
    const mergeState = isText(row['mergeState']) ? row['mergeState'] : undefined
    const listed = row['statuses']
    const statuses = Array.isArray(listed) ? { statuses: sortedStatuses(listed.map(statusOf).filter((s): s is ForgeStatus => s !== undefined)) } : {}
    rows.push({
      number: row['number'], draft: row['draft'] === true, head, base: isText(row['base']) ? row['base'] : '', labels,
      rollup: isText(row['rollup']) ? row['rollup'] : null, ...(mergeable === undefined ? {} : { mergeable }), ...(mergeState === undefined ? {} : { mergeState }), ...statuses,
    })
  }
  const rate = isRecord(raw['rate']) ? raw['rate'] : {}
  const remaining = rate['remaining']
  const resetAt = isText(rate['resetAt']) ? Date.parse(rate['resetAt']) : NaN
  const viewer = isText(raw['viewer']) ? { viewer: raw['viewer'] } : {}
  return { rows, ...viewer, rate: { ...(typeof remaining === 'number' ? { remaining } : {}), ...(Number.isFinite(resetAt) ? { resetAt } : {}) } }
}

/**
 * What the gate reads that may change without the session asking: on GitHub, the head, the base, the draft, the
 * labels, the CI rollup and the mergeability against the base; on the machine, the mtimes of the head's records directory, the check plan and the
 * repository's exemption, and whether that exemption ran out. Two equal fingerprints need no new gate.
 */
export type Local = { records: number; plan: number; exemption: number; expired: boolean }

export function fingerprintOf(row: ListedPr, local: Local, labels: readonly string[] = row.labels): string {
  const named = [...labels].map((label) => label.toLowerCase()).sort()
  return JSON.stringify([row.head, row.base, row.draft, row.rollup, named, row.mergeable ?? null, row.mergeState ?? null,
    local.records, local.plan, local.exemption, local.expired])
}

// A rollup still on its way: the repository is not idle while one runs.
const RUNNING = new Set(['PENDING', 'EXPECTED'])
// A mergeability GitHub has not computed yet: it resolves lazily, so the repository is listed again at the next beat.
const computing = (row: ListedPr): boolean => row.mergeable === 'UNKNOWN'

/** When a repository is listed next, and how many listings in a row found it idle. */
export type Schedule = { nextAt: number; idle: number }

/**
 * The next listing after one at `now`: at the reset when the quota is low (QUOTA_WAIT_MS when its reset is unknown),
 * at the next beat when a pull request changed or a CI runs, else later each idle listing, doubling up to IDLE_MAX_MS.
 */
export function nextListing(before: Schedule | undefined, now: number, changed: boolean, rows: readonly ListedPr[], rate: Rate): Schedule {
  if (rate.remaining !== undefined && rate.remaining < QUOTA_LOW) {
    return { nextAt: rate.resetAt !== undefined && rate.resetAt > now ? rate.resetAt : now + QUOTA_WAIT_MS, idle: before?.idle ?? 0 }
  }
  if (changed || rows.some((row) => (row.rollup !== null && RUNNING.has(row.rollup)) || computing(row))) return { nextAt: now + TICK_MS, idle: 0 }
  const idle = (before?.idle ?? 0) + 1
  return { nextAt: now + Math.min(TICK_MS * 2 ** idle, IDLE_MAX_MS), idle }
}

/** The repositories, lowercased, whose records directory changed within RECENT_MS of `now`, and those named beside. */
export function reconciledRepos(records: ReadonlyArray<{ repo: string; mtimeMs: number }>, named: readonly string[], now: number): string[] {
  const repos = new Set<string>()
  for (const { repo, mtimeMs } of records) if (now - mtimeMs <= RECENT_MS) repos.add(repo.toLowerCase())
  for (const repo of named) repos.add(repo.toLowerCase())
  return [...repos].sort()
}

/** What the reconciler counted since it took the lease: its beats, its listings (one GitHub call each), its gates, and its statuses posted (one call each). */
export type Counts = { since: string; ticks: number; listings: number; gates: number; moves: number; posts?: number }
/** The machine's lease: who reconciles, until when (ms), and what it counted. */
export type Lease = { v: number; holder: string; until: number; counts?: Counts }

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

export function parseLease(text: string | undefined): Lease | undefined {
  if (text === undefined) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw) || raw['v'] !== LEASE_VERSION || !isText(raw['holder']) || typeof raw['until'] !== 'number') return undefined
  const c = raw['counts']
  const counts = isRecord(c) && isText(c['since']) && isCount(c['ticks']) && isCount(c['listings']) && isCount(c['gates']) && isCount(c['moves'])
    ? { since: c['since'], ticks: c['ticks'], listings: c['listings'], gates: c['gates'], moves: c['moves'], ...(isCount(c['posts']) ? { posts: c['posts'] } : {}) }
    : undefined
  return { v: LEASE_VERSION, holder: raw['holder'], until: raw['until'], ...(counts ? { counts } : {}) }
}

/** Whose the lease is at `now`: this reconciler's, another's still running, or nobody's (none, unreadable or run out). */
export function leaseOf(lease: Lease | undefined, me: string, now: number): 'mine' | 'other' | 'free' {
  if (!lease || !(now < lease.until)) return 'free'
  return lease.holder === me ? 'mine' : 'other'
}

/** Whether this reconciler must write the lease at `now`: it is free, or its own runs out within LEASE_RENEW_MS. */
export function leaseDue(lease: Lease | undefined, me: string, now: number): boolean {
  const whose = leaseOf(lease, me, now)
  return whose === 'free' || (whose === 'mine' && lease !== undefined && lease.until - now < LEASE_RENEW_MS)
}

/**
 * The lease's text once `me` takes or renews it at `now`, read under the lease's lock; undefined, nothing written,
 * when another holds it still: of two sessions taking it at once, the second reads the first's and stands aside.
 */
export function takenLease(current: string | undefined, me: string, now: number, counts: Counts): string | undefined {
  if (leaseOf(parseLease(current), me, now) === 'other') return undefined
  return JSON.stringify({ v: LEASE_VERSION, holder: me, until: now + LEASE_MS, counts }) + '\n'
}

/** The label a gate puts. */
export type LabelMove = 'ready' | 'not-ready'

/** The label this machine last wrote to a pull request, at which head, how many times in a row it wrote that same label again, whether it said so. */
export type Flap = { head: string; wrote: LabelMove; undone: number; said: boolean }

/**
 * The reconciler is about to put `move` at `head`. A label put again after this machine wrote that very label there, with
 * no other label between, was taken away in the meantime by another machine (or the operator): past FLAP_UNDONE of them the
 * label is held (two machines in lasting disagreement would move it forever, each move waking the other). Nothing is
 * counted here, only when the write goes through (flapWrote). `say` is true once, the first time it holds.
 */
export function flapCheck(prev: Flap | undefined, head: string, move: LabelMove): { hold: boolean; say: boolean; flap?: Flap } {
  if (!prev || prev.head !== head || prev.wrote !== move || prev.undone < FLAP_UNDONE) return { hold: false, say: false }
  return { hold: true, say: !prev.said, flap: { ...prev, said: true } }
}

/** What is kept once `move` was written at `head`: the same label again counts one undo, another label (a verdict that changed) or another head starts again. */
export function flapWrote(prev: Flap | undefined, head: string, move: LabelMove): Flap {
  const again = prev?.head === head && prev.wrote === move
  return { head, wrote: move, undone: again ? prev.undone + 1 : 0, said: again ? prev.said : false }
}
