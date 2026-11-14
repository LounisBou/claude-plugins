// The check plan of a pull request: which proofs it owes, decided once when the work is scoped by
// its orchestrator, each one it does not owe with its reason. One file per pull request under the
// plugin's data directory, kept across its heads. The needs a plan may give and what one left out
// means are core's readiness contract (readiness.ts). Pure functions only: register.ts reads and
// writes the file, and posts the plan on the pull request.

import { CONSENT_GRANT, CONSENT_REFUSE } from '../core/consent-record.ts'
import { DETAIL_MAX, RECORD_VERSION, type Kind } from '../core/pr-record.ts'
import { PLAN_NEEDS, PLAN_OMITTED, reviewNeed, WAIVABLE, type Planned, type Waivable } from '../core/readiness.ts'
import { isRepoName } from './e2e-scope.ts'

export const PLAN_DIR = 'check-plans'
// The plan's one writer: the orchestrator's tool, from an orchestrator session, never an implementer.
export const PLAN_WRITER = { plugin: 'orchestrator', tool: 'mcp__orchestrator__review' } as const

const PLANNED = Object.keys(PLAN_NEEDS) as Planned[]

// A required review carries the rounds it runs at most (core's `reviewNeed`).
export type Check = { readonly need: string; readonly reason: string; readonly max?: number }
export type Checks = Record<Planned, Check>
export type CheckPlan = Checks & { readonly v: number; readonly repo: string; readonly pr: number; readonly at: string }

// The kinds that stand without a record at the head, each with the line naming why, and the kinds the plan requires.
export type Excused = Partial<Record<Kind, string>> & { required?: readonly Kind[] }

// `<need>` or `<need>: <reason>`; a need other than the strictest carries its reason, a required
// review its rounds in its place.
function checkOf(kind: Planned, value: unknown): Check | string {
  const text = value === undefined ? PLAN_OMITTED[kind] : typeof value === 'string' ? value.trim() : ''
  const at = text.indexOf(':')
  const reason = at === -1 ? '' : text.slice(at + 1).trim()
  let need = (at === -1 ? text : text.slice(0, at)).trim().toLowerCase()
  if (kind === 'review') {
    const review = reviewNeed(need, reason)
    if (typeof review === 'string') return review
    if (review.need === 'required') return { need: review.need, reason: '', max: review.max }
    need = review.need
  }
  if (!(PLAN_NEEDS[kind] as readonly string[]).includes(need)) return kind + ' is one of ' + PLAN_NEEDS[kind].join(', ') + ', got: ' + (text || 'nothing')
  const strictest = need === PLAN_NEEDS[kind][0]
  if (!strictest && reason === '') return kind + ' ' + need + ' gives its reason: "' + need + ': <why>"'
  if (reason.length > DETAIL_MAX) return kind + '\'s reason is at most ' + DETAIL_MAX + ' characters'
  return { need, reason: strictest ? '' : reason }
}

/** The plan a call gives, {e2e?, norms?, review?} as `<need>[: <reason>]` each, or the error to answer. */
export function planInput(raw: unknown): Checks | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'a plan is an object'
  const checks: Partial<Checks> = {}
  for (const kind of PLANNED) {
    const check = checkOf(kind, (raw as Record<string, unknown>)[kind])
    if (typeof check === 'string') return check
    checks[kind] = check
  }
  return checks as Checks
}

/** The plan a file holds, or undefined when it breaks its shape: then it is read as no plan. */
export function parsePlan(raw: unknown): CheckPlan | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { v, repo, pr, at } = raw as Record<string, unknown>
  if (v !== RECORD_VERSION || typeof repo !== 'string' || !isRepoName(repo) || !Number.isInteger(pr) || (pr as number) < 1 || typeof at !== 'string') return undefined
  const checks = planInput(Object.fromEntries(PLANNED.map((kind) => {
    const check = (raw as Record<string, any>)[kind]
    return [kind, String(check?.need) + (check?.max !== undefined ? ': max ' + String(check.max) : check?.reason ? ': ' + check.reason : '')]
  })))
  return typeof checks === 'string' ? undefined : { v, repo, pr: pr as number, ...checks, at }
}

/** The file of a pull request's plan under the plugin's data directory. */
export function planPath(dataDir: string, repo: string, pr: number): string {
  if (!isRepoName(repo)) throw new Error('github: no repository named ' + JSON.stringify(repo))
  return dataDir + '/' + PLAN_DIR + '/' + repo.toLowerCase() + '/' + pr + '.json'
}

/** The kinds the plan excuses, each named with the plan's date and reason. */
export function planExcuses(plan: CheckPlan | undefined): Excused {
  if (!plan) return {}
  const excused: Excused = { required: WAIVABLE.filter((kind) => plan[kind].need === 'required') }
  const by = 'check plan, ' + plan.at.slice(0, 10) + ': '
  if (plan.e2e.need === 'none') excused.e2e = by + plan.e2e.reason
  if (plan.e2e.need === 'screenshots') excused.e2e = by + 'desktop and mobile screenshots in its place, ' + plan.e2e.reason
  if (plan.norms.need === 'none') excused.norms = by + plan.norms.reason
  if (plan.review.need === 'none') excused.review = by + plan.review.reason
  return excused
}

/*
 * The operator's waiver of a required E2E or norms check: one question, « Dispense d'E2E pour <owner/name>#<n> : <why> »
 * or « Dispense de normes pour … », its choices « Accorder » and « Refuser », asked by dialog or in the round. His answer,
 * from any channel, is the consent record of the pull request (core's consent-record.ts) whose subject names the check;
 * the newest one decides.
 */
export type { Waivable }
export const WAIVED = WAIVABLE
// The question's words for each check it waives, and the consent subject its answer is recorded under.
export const WAIVER_WORDS: Record<Waivable, string> = { e2e: "d'E2E", norms: 'de normes' }
export const waiverSubject = (check: Waivable) => (check + '-waiver') as 'e2e-waiver' | 'norms-waiver'
const WAIVER_QUESTION = /^\s*Dispense (d['’]E2E|de normes) pour ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\s*:/i

/** The check and pull request a dialog question asks the waiver of, or undefined when it is no waiver question. */
export function waiverQuestion(question: unknown): { check: Waivable; repo: string; pr: number } | undefined {
  const q = (typeof question === 'object' && question !== null ? question : {}) as Record<string, unknown>
  const match = WAIVER_QUESTION.exec(String(q['question'] ?? ''))
  const labels = Array.isArray(q['options']) ? q['options'].map((o) => String(o?.label ?? '').trim()) : []
  if (!match || labels.length !== 2 || !labels.includes(CONSENT_GRANT) || !labels.includes(CONSENT_REFUSE) || q['multiSelect'] === true) return undefined
  const pr = Number(match[3])
  const check: Waivable = /normes/i.test(match[1]!) ? 'norms' : 'e2e'
  return isRepoName(match[2]!) && pr > 0 ? { check, repo: match[2]!, pr } : undefined
}

/** A check's need as a plan writes it: a required review with its rounds. */
export const needText = (check: Check): string => check.need + (check.max !== undefined ? ': max ' + check.max : '')

/** The plan as the pull request shows it, in one comment. */
export function planText(plan: Checks): string {
  const line = (kind: Planned) => '- ' + kind + ': ' + needText(plan[kind]) + (plan[kind].reason ? ' — ' + plan[kind].reason : '')
  return '**Check plan**\n\n' + PLANNED.map(line).join('\n') + '\n\nThe ready gate requires the E2E and norms checks marked required.'
}
