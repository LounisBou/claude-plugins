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
  // itself requires the workflow's aggregator job, the status check named here.
  conditions: {
    review: { holder: 'gate', means: 'a review record that passes: no blocking finding, or the orchestrator\'s acceptance of its set-asides' },
    e2e: { holder: 'gate', means: 'passed, waived by the operator or not applicable, unless the check plan or an exemption excuses it' },
    norms: { holder: 'gate', means: 'passed or waived where the check plan requires it; a failed run at the head blocks anyway' },
    ci: { holder: 'github', check: 'ci', means: 'the required status check of the default branch, green' },
  },
  // The severities a review finding blocks with.
  blocking: ['critical', 'important'],
  // The needs a check plan gives each check, the strictest first; one left out of a plan takes its
  // `omitted` need. Only `required` requires; the operator's waiver alone lifts a required E2E or
  // norms check (pr-record's `waivable`). With no plan, the E2E is owed and norms are on demand.
  plan: {
    needs: { e2e: ['required', 'none', 'screenshots'], norms: ['required', 'none'], review: ['full', 'one-pass'] },
    omitted: { e2e: 'none: not in the plan', norms: 'none: not in the plan', review: 'full' },
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
// The kinds the operator's waiver lifts once the plan requires them.
export const WAIVABLE = PR_RECORD_CONTRACT.waivable
export type Waivable = (typeof WAIVABLE)[number]

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
