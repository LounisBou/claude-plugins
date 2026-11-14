// hooks/review.ts
// The orchestrator's review verdict: once its review round has read a pull request's head, the
// orchestrator records the verdict for the github ready gate, a pass, a fail, or an acceptance
// that sets non-critical points aside, each with its reason. The record is github's (core's
// pr-record.ts): this tool writes it only from an orchestrator session, and github checks the rest
// at the head of the clean checkout it reads: the caller's plugin, a session that did not push
// that head, and no pass over a failed review there. In place of a verdict, the same tool writes the pull
// request's check plan (github's check-plan.ts), which github takes from this plugin only.
import { ACCEPTANCE, acceptanceDetail } from '../core/pr-record.ts'
import { PLAN_NEEDS } from '../core/readiness.ts'
import { isOrchestratorSession } from './supervision.ts'
import { messageOf, type Host, type On } from './host.ts'
import { logLine } from './module-io.ts'

type Held = Host<'plugin' | 'env' | 'process' | 'tool' | 'session' | 'fs'>

// The tool's short name: the model calls it as mcp__orchestrator__review.
export const REVIEW_TOOL = 'review'
const RECORD_TOOL = 'mcp__github__record'
const VERDICTS = ['pass', 'fail', ACCEPTANCE.result] as const

export const NOT_ORCHESTRATOR = 'Only an orchestrator session records a review verdict or a check plan: the review round and the scope are its own.'

// The needs a plan may give a check, as core's readiness contract lists them.
export const needsOf = (check: keyof typeof PLAN_NEEDS): string => PLAN_NEEDS[check].join(', ')

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

// The record tool's call for a verdict, or the line that says what the input lacks.
export function verdictCall(input: Record<string, unknown>): { tool: string } & Record<string, unknown> | string {
  const pr = Number(String(input['pr'] ?? '').replace('#', ''))
  if (!Number.isInteger(pr) || pr < 1) return 'pr is the pull request number'
  const repo = text(input['repo']) ? { repo: text(input['repo']) } : {}
  const plan = input['plan']
  if (plan !== undefined) {
    if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) return 'plan is {"e2e": …, "norms": …, "review": …}'
    return input['verdict'] === undefined ? { tool: RECORD_TOOL, pr, ...repo, plan } : 'a plan goes in place of the verdict'
  }
  const verdict = text(input['verdict'])
  if (!VERDICTS.some((v) => v === verdict)) return 'verdict is pass, fail or ' + ACCEPTANCE.result
  const raw = input['set_asides']
  const setAsides = Array.isArray(raw) ? raw.map((s) => ({ point: text(s?.point), reason: text(s?.reason) })) : []
  if (verdict === ACCEPTANCE.result && (setAsides.length === 0 || setAsides.some((s) => !s.point || !s.reason))) {
    return 'set_asides lists each point set aside with its one-line reason: [{"point": "...", "reason": "..."}]'
  }
  if (verdict !== ACCEPTANCE.result && raw !== undefined) return 'set_asides goes with the verdict ' + ACCEPTANCE.result + ' only'
  const detail = verdict === ACCEPTANCE.result ? acceptanceDetail(setAsides) : text(input['detail'])
  const dir = text(input['dir']) ? { dir: text(input['dir']) } : {}
  return { tool: RECORD_TOOL, pr, ...repo, ...dir, kind: ACCEPTANCE.kind, result: verdict, detail }
}

// The record tool's answer as the tool's own: its text, an error when it refused or failed.
function answerOf(written: unknown): { result: string; isError?: boolean } {
  const w = (typeof written === 'object' && written !== null ? written : {}) as { result?: unknown; deny?: unknown; isError?: unknown }
  if (typeof w.deny === 'string') return { result: w.deny, isError: true }
  const text = typeof w.result === 'string' ? w.result : JSON.stringify(w.result ?? null)
  return w.isError === true ? { result: text, isError: true } : { result: text }
}

export function register(on: On<Held>): void {
  on('session.start', {}, async ($, e, next) => {
    try {
      await $.tool.register({
        name: REVIEW_TOOL,
        isDeferred: false,
        description: 'Records the review round\'s verdict at a pull request\'s head for the github ready gate: pass, fail, or accepted with each point set aside and its reason. From a clean checkout at the head; only in an orchestrator session. In place of the verdict, plan sets the proofs the pull request owes.',
        inputSchema: {
          type: 'object',
          properties: {
            pr: { type: 'integer', description: 'the pull request number' },
            repo: { type: 'string', description: 'owner/name; omitted, the checkout\'s origin' },
            dir: { type: 'string', description: 'absolute path of a clean checkout at the head; omitted, the session\'s directory' },
            verdict: { type: 'string', enum: [...VERDICTS] },
            set_asides: {
              type: 'array',
              description: 'accepted: each point set aside with its one-line reason',
              items: { type: 'object', properties: { point: { type: 'string' }, reason: { type: 'string' } }, required: ['point', 'reason'] },
            },
            detail: { type: 'string', description: 'pass or fail: one line on what was reviewed or found' },
            plan: {
              type: 'object',
              description: 'in place of the verdict: each "<need>" or "<need>: <reason>"',
              properties: {
                e2e: { type: 'string', description: needsOf('e2e') },
                norms: { type: 'string', description: needsOf('norms') },
                review: { type: 'string', description: needsOf('review') },
              },
            },
          },
          required: ['pr'],
        },
      })
    } catch (err) {
      await logLine($, 'review', `review tool not registered: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'review', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${REVIEW_TOOL}` }, async ($, e) => {
    if (e.agentId) return { result: "only the session's main thread records a review verdict", isError: true }
    const call = verdictCall(e)
    if (typeof call === 'string') return { result: call, isError: true }
    if (!(await isOrchestratorSession($, await $.session.id()))) return { result: NOT_ORCHESTRATOR, isError: true }
    return answerOf(await $.tool.call(call))
  }).catch(async ($, e, next) => {
    await logLine($, 'review', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the review verdict could not be recorded; the log says why', isError: true }
  })
}
