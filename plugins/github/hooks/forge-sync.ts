// What the reconciler copies between this machine and the forge at a pull request's head (core's forge-status.ts):
// for each record kind, the check plan and the repository's E2E exemption, the newer side wins. A copy the forge holds
// that is newer than this machine's is imported here; one this machine holds that the forge lacks, or holds older, is
// posted, once a listing taken a beat after it was made still lacks it (the tool that wrote it posted it at once).
// Only the statuses the operator's account created are read. Pure: the module (register.ts) reads, writes and posts.

import {
  FORGE, forgeDescription, parseForgeDescription, parseRecordStatus, recordPost, trustedStatuses,
  type ForgePost, type ForgeRecord, type ForgeStatus,
} from '../core/forge-status.ts'
import { KINDS, type PrRecord } from '../core/pr-record.ts'
import { planInput, type CheckPlan, type Checks } from './check-plan.ts'
import { parseExemption, type Exemption } from './e2e-scope.ts'
import { TICK_MS } from './reconcile.ts'

/** The statuses one beat posts at most; the others at the next. */
export const POSTS_PER_TICK = 8
/** How long a copy made here is left to the tool that made it before the reconciler posts it. */
export const SETTLE_MS = TICK_MS
/** The session a copy imported from the forge is written with. */
export const FORGE_SESSION = 'forge'

// What the plan and the exemption read imported from the forge give in place of the words the forge does not keep.
const COPIED = 'copied from the forge'

/** What the reconciler does at one head: the records, the plan and the exemption to import, the statuses to post. */
export type ForgeSync = {
  readonly records: ForgeRecord[]
  readonly plan?: { readonly checks: Checks; readonly at: string }
  readonly exemption?: Exemption
  readonly posts: ForgePost[]
  /** What cannot be posted, one line each. */
  readonly unposted: string[]
}

/** What a head holds on each side. `listedAt`: when the listing that read `statuses` was taken (ms). */
export type ForgeSides = {
  readonly repo: string
  readonly statuses: readonly ForgeStatus[]
  readonly viewer: string
  readonly records: readonly PrRecord[]
  readonly plan: CheckPlan | undefined
  readonly exemption: Exemption | undefined
  readonly listedAt: number
}

/** A plan as its status's body: each need, a required review's rounds after a slash. */
export function planBody(plan: Checks): string {
  return 'e2e=' + plan.e2e.need + ' norms=' + plan.norms.need + ' review=' + plan.review.need + (plan.review.max !== undefined ? '/' + plan.review.max : '')
}

/** The plan a status's body gives, or undefined when it is none. The reasons the forge does not keep read as a copy's. */
export function planFromBody(body: string): Checks | undefined {
  const fields = new Map(body.split(' ').map((word) => [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] as const))
  const [e2e, norms, review] = [fields.get('e2e'), fields.get('norms'), fields.get('review')]
  if (fields.size !== 3 || e2e === undefined || norms === undefined || review === undefined) return undefined
  const [need, max] = review.split('/')
  const checks = planInput({ e2e: e2e + ': ' + COPIED, norms: norms + ': ' + COPIED, review: (need ?? '') + (max !== undefined ? ': max ' + max : '') })
  return typeof checks === 'string' ? undefined : checks
}

/** An exemption as its status's body: whether it stands, its rules and its end, as compact JSON. */
export function exemptionBody(exemption: Exemption): string {
  return JSON.stringify({ e: exemption.exempt, p: exemption.paths, l: exemption.labels, ...(exemption.until !== undefined ? { u: exemption.until } : {}) })
}

/** The exemption a status's body gives for `repo`, made at `at`, or undefined when it is none. The operator's words stay on the machine that wrote them. */
export function exemptionFromBody(body: string, repo: string, at: string, creator: string): Exemption | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { e, p, l, u } = raw as Record<string, unknown>
  return parseExemption({
    v: 1, repo: repo.toLowerCase(), exempt: e, paths: p, labels: l, detail: COPIED + ', posted by ' + creator, session: FORGE_SESSION, at, ...(u !== undefined ? { until: u } : {}),
  })
}

// Which side is newer, by the instants both write (ISO UTC to the second, so their text orders as their time).
function newer(here: string | undefined, there: string | undefined): 'import' | 'post' | undefined {
  if (there !== undefined && (here === undefined || there > here)) return 'import'
  if (here !== undefined && (there === undefined || here > there)) return 'post'
  return undefined
}

// The newest record of each kind this machine holds.
function newestByKind(records: readonly PrRecord[]): Map<string, PrRecord> {
  const newest = new Map<string, PrRecord>()
  for (const record of records) {
    const kept = newest.get(record.kind)
    if (!kept || record.at > kept.at) newest.set(record.kind, record)
  }
  return newest
}

/** What to import and what to post at one head, the newer side winning for each record kind, the plan and the exemption. */
export function forgeSync(sides: ForgeSides): ForgeSync {
  const trusted = trustedStatuses(sides.statuses, sides.viewer)
  const settled = (at: string) => Date.parse(at) + SETTLE_MS <= sides.listedAt
  const out: { records: ForgeRecord[]; plan?: NonNullable<ForgeSync['plan']>; exemption?: Exemption; posts: ForgePost[]; unposted: string[] } = { records: [], posts: [], unposted: [] }
  const newest = newestByKind(sides.records)
  for (const kind of KINDS) {
    const status = trusted.get(kind)
    const there = status ? parseRecordStatus(status) : undefined
    const here = newest.get(kind)
    const side = newer(here?.at, there?.at)
    if (side === 'import' && there) out.records.push(there)
    if (side === 'post' && here && settled(here.at)) {
      const post = recordPost(here)
      if (post) out.posts.push(post)
    }
  }
  const planStatus = trusted.get(FORGE.plan)
  const planRead = planStatus ? parseForgeDescription(planStatus.description) : undefined
  const planThere = planRead ? planFromBody(planRead.body) : undefined
  const planSide = newer(sides.plan?.at, planThere && planRead ? planRead.at : undefined)
  if (planSide === 'import' && planThere && planRead) out.plan = { checks: planThere, at: planRead.at }
  if (planSide === 'post' && sides.plan && settled(sides.plan.at)) {
    const description = forgeDescription(sides.plan.at, planBody(sides.plan))
    if (description) out.posts.push({ name: FORGE.plan, state: 'success', description })
  }
  const exemptStatus = trusted.get(FORGE.exemption)
  const exemptRead = exemptStatus ? parseForgeDescription(exemptStatus.description) : undefined
  const exemptThere = exemptRead && exemptStatus ? exemptionFromBody(exemptRead.body, sides.repo, exemptRead.at, exemptStatus.creator) : undefined
  const exemptSide = newer(sides.exemption?.at, exemptThere?.at)
  if (exemptSide === 'import' && exemptThere) out.exemption = exemptThere
  if (exemptSide === 'post' && sides.exemption && settled(sides.exemption.at)) {
    const description = forgeDescription(sides.exemption.at, exemptionBody(sides.exemption))
    if (description) out.posts.push({ name: FORGE.exemption, state: 'success', description })
    else out.unposted.push('github: the E2E exemption of ' + sides.repo + ' is too long for the forge (' + FORGE.description_max + ' characters): the other machine does not see it')
  }
  return out
}
