// hooks/report.ts
// The review's verdict, computed from what the review agents return rather than
// from a count the model gives. During a pass of auto-fix-loop, each agent the
// session launches is asked to end with one JSON block of its findings; the
// block is read here, and the loop counts the Critical and Important ones.
// An agent that ends without a readable block makes the pass's count unknown.

export type Severity = 'critical' | 'important' | 'suggestion'
export type Finding = { severity: Severity; file: string; summary: string }

const SEVERITIES: readonly string[] = ['critical', 'important', 'suggestion']

export const REPORT_REQUEST = '\n\nEnd your answer with one fenced ```json block holding '
  + '{"findings": [{"severity": "critical" | "important" | "suggestion", "file": "<path>", "summary": "<one line>"}]}: '
  + 'every finding you report, and an empty list when you found none. The review\'s verdict is computed from this block alone.'

const FENCE = /```json\s*\n([\s\S]*?)\n\s*```/g

// The findings of an agent's answer: its last JSON block, or null when it has none
// or the block breaks the shape.
export function reportOf(text: string): Finding[] | null {
  const blocks = [...text.matchAll(FENCE)].map((m) => m[1] ?? '')
  const last = blocks.at(-1)
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
    const severity = String((item as any)?.severity ?? '').toLowerCase()
    if (!SEVERITIES.includes(severity)) return null
    findings.push({ severity: severity as Severity, file: String((item as any)?.file ?? ''), summary: String((item as any)?.summary ?? '') })
  }
  return findings
}

// The text of a tool's answer: a string, content blocks, or { result | text }.
export function answerText(answer: any): string {
  const body = answer?.result ?? answer?.text ?? answer
  if (typeof body === 'string') return body
  if (Array.isArray(body)) return body.map((part: any) => (typeof part === 'string' ? part : String(part?.text ?? ''))).join('\n')
  return ''
}

// The id of an agent the host launched in the background, from the answer to its launch.
export function launchedAgent(text: string): string | undefined {
  return text.startsWith('Async agent launched') ? text.match(/agentId:\s*([A-Za-z0-9_-]+)/)?.[1] : undefined
}

// A refusal of the host's auto-mode classifier: the hook changed the call after it was reviewed,
// so the call never ran and is issued again.
// How many times a pass may ask for a hand-back that has not come before it ends as silent.
export const MAX_WAITS = 3

export const isRefusedRewrite = (text: string): boolean => text.includes("a hook changed this call's input")

// The pass's findings once every agent reported, or undefined: none ran, or one did not report.
export function passFindings(reports: readonly (Finding[] | null)[]): Finding[] | undefined {
  if (reports.length === 0 || reports.some((r) => r === null)) return undefined
  return reports.flatMap((r) => r ?? [])
}

export const isBlocking = (finding: Finding): boolean => finding.severity !== 'suggestion'
