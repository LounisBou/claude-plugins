// The check plan of a pull request: which proofs it owes, decided once when the work is scoped by
// its orchestrator, each one it does not owe with its reason. One file per pull request under the
// plugin's data directory, kept across its heads. A pull request with no plan owes every proof.
// Pure functions only: register.ts reads and writes the file, and posts the plan on the pull request.

import { DETAIL_MAX, RECORD_VERSION, type Kind } from '../core/pr-record.ts'
import { isRepoName } from './e2e-scope.ts'

export const PLAN_DIR = 'check-plans'
// The plan's one writer: the orchestrator's tool, from an orchestrator session, never an implementer.
export const PLAN_WRITER = { plugin: 'orchestrator', tool: 'mcp__orchestrator__review' } as const

// What each planned check may need, the strictest first. E2E may be replaced by desktop and mobile screenshots;
// a review may be one review_only pass, a depth the gate does not read.
const NEEDS = { e2e: ['required', 'none', 'screenshots'], norms: ['required', 'none'], review: ['full', 'one-pass'] } as const
type Planned = keyof typeof NEEDS
// What a check left out of a plan needs: norms is on demand.
const DEFAULT: Record<Planned, string> = { e2e: 'required', norms: 'none', review: 'full' }
const PLANNED = Object.keys(NEEDS) as Planned[]

export type Check = { readonly need: string; readonly reason: string }
export type Checks = Record<Planned, Check>
export type CheckPlan = Checks & { readonly v: number; readonly repo: string; readonly pr: number; readonly at: string }

// The kinds that stand without a record at the head, each with the line naming why.
export type Excused = Partial<Record<Kind, string>>

// `<need>` or `<need>: <reason>`; a need other than the strictest and the default carries its reason.
function checkOf(kind: Planned, value: unknown): Check | string {
  const text = value === undefined ? DEFAULT[kind] : typeof value === 'string' ? value.trim() : ''
  const at = text.indexOf(':')
  const need = (at === -1 ? text : text.slice(0, at)).trim().toLowerCase()
  const reason = at === -1 ? '' : text.slice(at + 1).trim()
  if (!(NEEDS[kind] as readonly string[]).includes(need)) return kind + ' is one of ' + NEEDS[kind].join(', ') + ', got: ' + (text || 'nothing')
  const strictest = need === NEEDS[kind][0]
  if (!strictest && need !== DEFAULT[kind] && reason === '') return kind + ' ' + need + ' gives its reason: "' + need + ': <why>"'
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

/** The plan a file holds, or undefined when it breaks its shape: then the pull request owes every proof. */
export function parsePlan(raw: unknown): CheckPlan | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { v, repo, pr, at } = raw as Record<string, unknown>
  if (v !== RECORD_VERSION || typeof repo !== 'string' || !isRepoName(repo) || !Number.isInteger(pr) || (pr as number) < 1 || typeof at !== 'string') return undefined
  const checks = planInput(Object.fromEntries(PLANNED.map((kind) => {
    const check = (raw as Record<string, any>)[kind]
    return [kind, String(check?.need) + (check?.reason ? ': ' + check.reason : '')]
  })))
  return typeof checks === 'string' ? undefined : { v, repo, pr: pr as number, ...checks, at }
}

/** The file of a pull request's plan under the plugin's data directory. */
export function planPath(dataDir: string, repo: string, pr: number): string {
  if (!isRepoName(repo)) throw new Error('github: no repository named ' + JSON.stringify(repo))
  return dataDir + '/' + PLAN_DIR + '/' + repo.toLowerCase() + '/' + pr + '.json'
}

/** The required E2E a new plan lifts, which only the operator's waiver lifts: the gate reads no other planned check. */
export function relaxed(before: CheckPlan | undefined, after: Checks): Planned[] {
  return before?.e2e.need === 'required' && after.e2e.need !== 'required' ? ['e2e'] : []
}

/** The kinds the plan excuses, each named with the plan's date and reason. */
export function planExcuses(plan: CheckPlan | undefined): Excused {
  const excused: Excused = {}
  if (!plan) return excused
  const by = 'check plan, ' + plan.at.slice(0, 10) + ': '
  if (plan.e2e.need === 'none') excused.e2e = by + plan.e2e.reason
  if (plan.e2e.need === 'screenshots') excused.e2e = by + 'desktop and mobile screenshots in its place, ' + plan.e2e.reason
  if (plan.norms.need === 'none' && plan.norms.reason) excused.norms = by + plan.norms.reason
  return excused
}

/** The plan as the pull request shows it, in one comment. */
export function planText(plan: Checks): string {
  const line = (kind: Planned) => '- ' + kind + ': ' + plan[kind].need + (plan[kind].reason ? ' — ' + plan[kind].reason : '')
  return '**Check plan**\n\n' + PLANNED.map(line).join('\n') + '\n\nThe ready gate requires the E2E marked required; the operator\'s waiver lifts it.'
}
