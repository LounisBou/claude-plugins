// hooks/review.ts
// The orchestrator's review verdict: once its review round has read a pull request's head, the
// orchestrator records the verdict for the github ready gate, a pass, a fail, or an acceptance
// that sets non-critical points aside, each with its reason. The record is github's (core's
// pr-record.ts): this tool writes it only from an orchestrator session, and github checks the rest
// at the head of the clean checkout it reads: the caller's plugin, a session that did not push
// that head, and no pass over a failed review there. In place of a verdict, the same tool writes the pull
// request's check plan (github's check-plan.ts), which github takes from this plugin only.
import { ACCEPTANCE, acceptanceDetail, DETAIL_MAX } from '../core/pr-record.ts'
import { AUDIT_CONTRACT, type Decision, type FindingSeverity } from '../core/learning.ts'
import { PLAN_NEEDS, REVIEW_ROUNDS } from '../core/readiness.ts'
import { isOrchestratorSession } from './supervision.ts'
import { messageOf, type Host, type On } from './host.ts'
import { logLine } from './module-io.ts'

type Held = Host<'plugin' | 'env' | 'process' | 'tool' | 'session' | 'fs'>

// The tool's short name: the model calls it as mcp__orchestrator__review.
export const REVIEW_TOOL = 'review'
const RECORD_TOOL = 'mcp__github__record'
const VERDICTS = ['pass', 'fail', ACCEPTANCE.result] as const

// A finding as the tool takes it: its point, and its file, line and severity when known.
const FINDING = {
  point: { type: 'string' },
  file: { type: 'string', description: 'its repository path' },
  line: { type: 'integer' },
  severity: { type: 'string', enum: [...AUDIT_CONTRACT.finding_severities] },
}

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
  const setAsides = itemsOf(input['set_asides'], 'set_asides')
  const kept = itemsOf(input['kept'], 'kept')
  if (typeof setAsides === 'string') return setAsides
  if (typeof kept === 'string') return kept
  if (verdict === ACCEPTANCE.result && (setAsides.length === 0 || setAsides.some((s) => !s.reason))) {
    return 'set_asides lists each point set aside with its one-line reason: [{"point": "...", "reason": "..."}]'
  }
  if (verdict === 'pass' && input['set_asides'] !== undefined) return 'set_asides goes with the verdict ' + ACCEPTANCE.result + ' or fail only'
  if (setAsides.some((s) => !s.reason)) return 'each point set aside carries its one-line reason'
  if (verdict !== 'fail' && input['kept'] !== undefined) return 'kept goes with the verdict fail only: the findings its correction round fixes'
  const set = setAsides.length > 0 ? acceptanceDetail(setAsides) : ''
  const detail = verdict === ACCEPTANCE.result ? set : [text(input['detail']), set].filter(Boolean).join('; ').slice(0, DETAIL_MAX)
  const dir = text(input['dir']) ? { dir: text(input['dir']) } : {}
  return { tool: RECORD_TOOL, pr, ...repo, ...dir, kind: ACCEPTANCE.kind, result: verdict, detail }
}

// A finding the verdict names: its point and reason for the record's line, and what the audit trail
// keeps of it — its file, line and severity when the orchestrator gives them, never its words.
type Finding = { point: string; reason: string; file: string | null; line: number | null; severity: FindingSeverity | null }

// The findings of `kept` or `set_asides`, none when absent, or the line that says what is wrong.
function itemsOf(raw: unknown, name: string): Finding[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return `${name} is a list: [{"point": "...", ...}]`
  const items: Finding[] = []
  for (const item of raw) {
    const fields = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const point = text(fields['point'])
    if (!point) return `each item of ${name} names its point`
    const { file, line, severity } = fields
    if (file !== undefined && typeof file !== 'string') return `file is the finding's repository path`
    if (line !== undefined && !(typeof line === 'number' && Number.isInteger(line) && line >= 1)) return 'line is a line number, from 1'
    if (severity !== undefined && !AUDIT_CONTRACT.finding_severities.some((s) => s === severity)) return `severity is ${AUDIT_CONTRACT.finding_severities.join(', ')}`
    items.push({ point, reason: text(fields['reason']), file: text(file) || null, line: typeof line === 'number' ? line : null, severity: (severity as FindingSeverity | undefined) ?? null })
  }
  return items
}

// The orchestrator's decision on each finding a valid verdict names: kept, then set aside.
export function findingsOf(input: Record<string, unknown>): { decision: Decision; file: string | null; line: number | null; severity: FindingSeverity | null }[] {
  const decided = (raw: unknown, decision: Decision) => {
    const items = itemsOf(raw, '')
    return typeof items === 'string' ? [] : items.map(({ file, line, severity }) => ({ decision, file, line, severity }))
  }
  return [...decided(input['kept'], 'kept'), ...decided(input['set_asides'], 'set-aside')]
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
              description: 'accepted, or fail: each point set aside with its one-line reason',
              items: { type: 'object', properties: { ...FINDING, reason: { type: 'string' } }, required: ['point', 'reason'] },
            },
            kept: {
              type: 'array',
              description: 'fail: each finding the correction round fixes',
              items: { type: 'object', properties: FINDING, required: ['point'] },
            },
            detail: { type: 'string', description: 'pass or fail: one line on what was reviewed or found' },
            plan: {
              type: 'object',
              description: 'in place of the verdict: each "<need>" or "<need>: <reason>"; a required review "required: max <n>", its rounds from 1 to ' + REVIEW_ROUNDS.cap + '; the review is never skipped, "one-pass" for a mechanical pull request is one round with no correction round',
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
