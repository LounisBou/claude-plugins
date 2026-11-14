// hooks/findings.ts
// The findings of a norms check, read from what its agents return rather than from figures the
// model gives. Each norms agent's prompt ends with a request for one JSON block of its findings
// (hooks/check.ts adds it); the block is read here when the agent's answer comes back, and
// check_done (hooks/record.ts) computes the record's pass from what was read. An agent that
// ends without a readable block leaves its findings unknown, and no record is written over it.

export type Severity = 'error' | 'warning' | 'info'
export type Finding = { severity: Severity; file: string; summary: string }

const SEVERITIES: readonly string[] = ['error', 'warning', 'info']

export const REPORT_REQUEST = '\n\nEnd your answer with one fenced ```json block holding '
  + '{"findings": [{"severity": "error" | "warning" | "info", "file": "<path>", "summary": "<one line>"}]}: '
  + 'every finding you report, and an empty list when you found none or the check was SKIPPED. The block is due even then. '
  + 'The check\'s record is computed from this block alone.'

const FENCE = /```json\s*\n([\s\S]*?)\n\s*```/g

// The findings of an agent's answer: its last JSON block, or null when it has none or the block
// breaks the shape.
export function reportOf(text: string): Finding[] | null {
  const last = [...text.matchAll(FENCE)].map(m => m[1] ?? '').at(-1)
  if (last === undefined) return null
  let raw: unknown
  try {
    raw = JSON.parse(last)
  } catch {
    return null
  }
  const list = (raw as { findings?: unknown } | null)?.findings
  if (!Array.isArray(list)) return null
  const findings: Finding[] = []
  for (const item of list) {
    const entry = (item ?? {}) as Record<string, unknown>
    const severity = String(entry.severity ?? '').toLowerCase()
    if (!SEVERITIES.includes(severity)) return null
    findings.push({ severity: severity as Severity, file: String(entry.file ?? ''), summary: String(entry.summary ?? '') })
  }
  return findings
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const textParts = (body: unknown): string => {
  if (typeof body === 'string') return body
  if (!Array.isArray(body)) return ''
  return body.map(part => (typeof part === 'string' ? part : isObject(part) && typeof part.text === 'string' ? part.text : '')).join('\n')
}

// What an agent answered, as text. The host answers an Agent call with a record in `result`: a
// completed agent's content (or the report its hand-back delivered), or the launch of one running
// in the background, which is no report. Any other answer is read as the text it carries.
export function agentText(answer: unknown): string {
  const body = isObject(answer) ? answer.result ?? answer.text : answer
  if (!isObject(body)) return textParts(body)
  if (body.status !== 'completed') return ''
  const report = body.handbackReport
  if ((body.handback === 'send' || body.handback === 'flagged') && isObject(report) && typeof report.text === 'string') return report.text
  return body.handback === 'withheld' ? '' : textParts(body.content)
}

// The reports of the running check, by agent type: null for an agent whose answer held no readable
// block. An agent that runs again replaces its report. Memory of the module, like the pass of
// pr-review's loop: a restart loses it, and check_done then asks for the agents again.
const reports = new Map<string, Finding[] | null>()

export function noteReport(agent: string, findings: Finding[] | null): void {
  reports.set(agent, findings)
}

export function resetReports(): void {
  reports.clear()
}

export type Reported =
  | { findings: Finding[] }
  | { why: string }

// The findings of the check once every agent that ran reported them, or why they are not known.
export function reported(): Reported {
  if (reports.size === 0) return { why: 'no norms agent has reported its findings since /norms:check began: run the check\'s agents first' }
  const unreadable = [...reports].filter(([, findings]) => findings === null).map(([agent]) => agent)
  if (unreadable.length > 0) return { why: `${unreadable.join(', ')} returned no readable findings block, so its findings are unknown: run it again` }
  return { findings: [...reports.values()].flatMap(findings => findings ?? []) }
}
