// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The readiness of a pull request, defined here once: what Ready means at its head, who holds each
// condition, which evidence its check plan may require, and what a new head voids. github's ready
// gate computes it with `missingEvidence`; pr-review reads which findings block a review, the
// orchestrator the needs a plan may name, github's protection the CI check to require; the method's
// lifecycle points here. `npm run core` writes it as readiness.json for github's Python engine.

import { accepts, KINDS, PR_RECORD_CONTRACT, type Kind, type PrRecord } from './pr-record.ts'

export const READINESS_CONTRACT = {
  version: 1,
  // A pull request is ready at its head when every condition holds there. Each is held by the one
  // that refuses a merge without it: the github ready gate reads the records at the head, GitHub
  // itself requires the workflow's aggregator job, the status check named here. The Ready label,
  // which the gate puts and a merge needs, takes every condition, whoever holds it.
  conditions: {
    review: { holder: 'gate', means: 'a review record that passes: no blocking finding, or the orchestrator\'s acceptance of its set-asides, unless the check plan excuses it' },
    e2e: { holder: 'gate', means: 'passed, waived by the operator or not applicable, unless the check plan or an exemption excuses it' },
    norms: { holder: 'gate', means: 'passed or waived where the check plan requires it; a failed run at the head blocks anyway' },
    ci: { holder: 'github', check: 'ci', means: 'the required status check of the default branch, green' },
  },
  // The severities a review finding blocks with.
  blocking: ['critical', 'important'],
  // The needs a check plan gives each check, the strictest first; one left out of a plan takes its
  // `omitted` need. Only `required` requires; the operator's waiver alone lifts a required E2E or
  // norms check (pr-record's `waivable`). With no plan, the E2E and the review are owed and norms
  // are on demand. A required review runs at most `max` rounds, `required: max <n>` from 1 to the
  // cap, the review loop's own limit; a plan silent on them runs `omitted`. No plan excuses the
  // review: `one-pass`, for a mechanical pull request, is one round by an independent reviewer with
  // no correction round expected, and still needs its record at the head. A review need other than
  // `required` reads as a required review of its rounds: `one-pass` one, a former `none` the same
  // (never no review) and a former `full` the cap.
  plan: {
    needs: { e2e: ['required', 'none', 'screenshots'], norms: ['required', 'none'], review: ['required', 'one-pass'] },
    omitted: { e2e: 'none: not in the plan', norms: 'none: not in the plan', review: 'required' },
    rounds: { omitted: 3, cap: 3 },
    former: { review: { full: 3, 'one-pass': 1, none: 1 } },
  },
  // A new head starts with no record; one whose own diff is an earlier head's (same commit count,
  // same patch fingerprint) carries every record that passes there. The operator's waiver stands
  // for every later head until a run fails after it.
  voids: 'a head whose own diff differs',
} as const

export type Condition = keyof typeof READINESS_CONTRACT.conditions
export type Holder = (typeof READINESS_CONTRACT.conditions)[Condition]['holder']
export type Planned = keyof typeof READINESS_CONTRACT.plan.needs

/** What a pull request still misses at its head: the condition, its holder, and the record that failed it, if any. */
export type Missing = { readonly condition: Condition; readonly holder: Holder; readonly record?: PrRecord }

/** What the gate knows at a head. */
export type HeadEvidence = {
  // Per kind, the record with the latest time at the head.
  readonly latest: ReadonlyMap<Kind, PrRecord>
  // The kinds the check plan or an exemption excuses.
  readonly excused: ReadonlySet<Kind>
  // The kinds the check plan requires.
  readonly required: ReadonlySet<Kind>
  // The kinds an earlier head of the same diff, or the operator's waiver, stands for.
  readonly carried: ReadonlySet<Kind>
  // Whether GitHub reads the required CI check green at the head.
  readonly ciGreen: boolean
}

export const CI_CHECK = READINESS_CONTRACT.conditions.ci.check
export const PLAN_NEEDS = READINESS_CONTRACT.plan.needs
export const PLAN_OMITTED = READINESS_CONTRACT.plan.omitted
export const REVIEW_ROUNDS = READINESS_CONTRACT.plan.rounds
// The kinds the operator's waiver lifts once the plan requires them.
export const WAIVABLE = PR_RECORD_CONTRACT.waivable
export type Waivable = (typeof WAIVABLE)[number]

/** A plan's review need, the rounds a required review runs at most; a one-pass review is one round. */
export type ReviewNeed = { readonly need: 'required'; readonly max: number }

const FORMER_REVIEW: Readonly<Record<string, number>> = READINESS_CONTRACT.plan.former.review
const ROUNDS = /^max\s+(\d+)$/i

/** The review need a plan gives as `<need>` and the text after its colon, or the error to answer. */
export function reviewNeed(need: string, rest: string): ReviewNeed | string {
  const word = need.trim().toLowerCase()
  const former = Object.hasOwn(FORMER_REVIEW, word) ? FORMER_REVIEW[word] : undefined
  if (former !== undefined) return { need: 'required', max: former }
  if (word !== 'required') return 'review is one of ' + PLAN_NEEDS.review.join(', ') + ', got: ' + (need.trim() || 'nothing')
  const text = rest.trim()
  if (text === '') return { need: 'required', max: REVIEW_ROUNDS.omitted }
  const max = Number(ROUNDS.exec(text)?.[1])
  if (max >= 1 && max <= REVIEW_ROUNDS.cap) return { need: 'required', max }
  return 'review required runs from 1 to ' + REVIEW_ROUNDS.cap + ' rounds: "required" or "required: max <n>", got: required: ' + text
}

/** The rounds a review loop runs for a plan's stored review need: a required review's max within the cap, a former need's, `omitted` for anything else. */
export function reviewRounds(review: unknown): number {
  const { need, max } = (typeof review === 'object' && review !== null ? review : {}) as Record<string, unknown>
  if (typeof need === 'string' && Object.hasOwn(FORMER_REVIEW, need)) return FORMER_REVIEW[need]!
  if (need !== 'required' || typeof max !== 'number' || !Number.isInteger(max) || max < 1) return REVIEW_ROUNDS.omitted
  return Math.min(max, REVIEW_ROUNDS.cap)
}

/** Whether a finding of this severity blocks a review. */
export function blocks(severity: string): boolean {
  return (READINESS_CONTRACT.blocking as readonly string[]).includes(severity.toLowerCase())
}

/** Whether a record of an earlier head of the same diff counts at the new head: any record that passes. */
export function carriesAcross(record: PrRecord): boolean {
  return accepts(record)
}

const holderOf = (condition: Condition): Holder => READINESS_CONTRACT.conditions[condition].holder

/** The conditions a pull request misses at its head, in the contract's order; none when it is ready. */
export function missingEvidence(evidence: HeadEvidence): Missing[] {
  const missing: Missing[] = []
  for (const kind of KINDS) {
    const record = evidence.latest.get(kind)
    if (record && accepts(record)) continue
    if (record?.result === 'fail') {
      missing.push({ condition: kind, holder: holderOf(kind), record })
      continue
    }
    if (evidence.excused.has(kind)) continue
    // Norms are on demand unless the plan requires them.
    if (kind === 'norms' && !record && !evidence.required.has('norms')) continue
    if (!record && evidence.carried.has(kind)) continue
    missing.push({ condition: kind, holder: holderOf(kind), ...(record ? { record } : {}) })
  }
  if (!evidence.ciGreen) missing.push({ condition: 'ci', holder: holderOf('ci') })
  return missing
}

/** The conditions a holder refuses a merge on. */
export function heldBy(missing: readonly Missing[], holder: Holder): Missing[] {
  return missing.filter((item) => item.holder === holder)
}
