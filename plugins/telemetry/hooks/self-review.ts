// hooks/self-review.ts
// The `self_review` tool: an implementer records the outcome of each finding of its self-review,
// fixed or answered with its reason, as one `self_review` event per finding. register.ts lists the
// tool and answers its calls; a call that cannot be recorded says why and records nothing.
import { makeEvent, type Event } from './collect.ts'

export const SELF_REVIEW_TOOL = 'mcp__telemetry__self_review'

export const SELF_REVIEW_DESCRIPTION =
  'Record the outcome of each finding of your self-review, once the gate is green: fixed, or answered with its reason. '
  + 'Answers your report\'s `self-review:` lines, one per finding.'

const SEVERITIES = ['critical', 'important', 'minor'] as const
const OUTCOMES = ['fixed', 'answered'] as const

export const SELF_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'owner/name of the pull request' },
    pr: { type: 'integer', minimum: 1, description: 'the pull request number' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lens: { type: 'string', description: 'the reader\'s lens that reported it' },
          file: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          severity: { type: 'string', enum: [...SEVERITIES] },
          outcome: { type: 'string', enum: [...OUTCOMES] },
          reason: { type: 'string', description: 'answered: why it stays' },
        },
        required: ['lens', 'outcome'],
      },
    },
  },
  required: ['findings'],
}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
const positive = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined)

/** The events of one call, or why it records none: an answered finding needs its reason. */
export function selfReviewEvents(at: number, session: string, input: unknown): { events: Event[] } | { why: string } {
  const e = record(input)
  const findings = Array.isArray(e['findings']) ? e['findings'].map(record) : []
  if (findings.length === 0) return { why: 'no finding given' }
  const repo = text(e['repo'])
  const pr = positive(e['pr'])
  const target = repo === undefined && pr === undefined ? undefined : { repo, pr }
  const events: Event[] = []
  for (const [index, finding] of findings.entries()) {
    const lens = text(finding['lens'])
    const outcome = (OUTCOMES as readonly unknown[]).includes(finding['outcome']) ? finding['outcome'] as string : undefined
    const reason = text(finding['reason'])
    if (lens === undefined || outcome === undefined) return { why: `finding ${index + 1}: a lens and an outcome (fixed or answered) are needed` }
    if (outcome === 'answered' && reason === undefined) return { why: `finding ${index + 1}: an answered finding needs its reason` }
    const severity = (SEVERITIES as readonly unknown[]).includes(finding['severity']) ? finding['severity'] as string : undefined
    events.push(makeEvent('self_review', at, session, { agent: text(e['agentId']), lens, file: text(finding['file']), line: positive(finding['line']), severity, outcome, reason, target }))
  }
  return { events }
}

/** A finding's line in the implementer's report: `self-review: <lens> [<severity>] <file>:<line> — fixed`, or `— answered: <reason>`. */
export function selfReviewLine(event: Event): string {
  const where = typeof event['file'] === 'string' ? ` ${event['file']}${typeof event['line'] === 'number' ? `:${event['line']}` : ''}` : ''
  const severity = typeof event['severity'] === 'string' ? ` [${event['severity']}]` : ''
  const outcome = event['outcome'] === 'answered' ? `answered: ${String(event['reason'])}` : 'fixed'
  return `self-review: ${String(event['lens'])}${severity}${where} — ${outcome}`
}
