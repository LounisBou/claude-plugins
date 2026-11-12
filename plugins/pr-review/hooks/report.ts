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
  + 'every finding you report, and an empty list when you found none. The block is due even then, in place of any '
  + 'prose such as "no findings" an earlier line allows. The review\'s verdict is computed from this block alone.'

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

// Core answers an Agent call with the tool's record in `result`, an object, beside the text the
// model reads: the record of an agent that completed, or of one launched in the background.
// `recordOf` is the one validator: it narrows what the host answered to the fields read below.
type AgentRecord = {
  status: unknown
  agentId: unknown
  handback: unknown
  // The text of the report the agent's hand-back tool delivered, when it has one.
  reportText: string | undefined
  // The text of each part of the agent's content, when the content is a list.
  content: string[] | undefined
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const recordOf = (answer: unknown): AgentRecord | undefined => {
  const result = isObject(answer) ? answer.result : undefined
  if (!isObject(result)) return undefined
  const report = result.handbackReport
  const reportText = isObject(report) && typeof report.text === 'string' ? report.text : undefined
  const content = Array.isArray(result.content)
    ? result.content.map((part: unknown) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
    : undefined
  return { status: result.status, agentId: result.agentId, handback: result.handback, reportText, content }
}

// What an agent answered: a completed record's report (the one its hand-back tool delivered, else its
// content), or the text a hook answered. A launch, or a record of any other state, is no report.
export function agentText(answer: unknown): string {
  const record = recordOf(answer)
  if (record === undefined) return answerText(answer)
  if (record.status !== 'completed') return ''
  const delivered = record.handback === 'send' || record.handback === 'flagged'
  if (delivered && record.reportText !== undefined) return record.reportText
  if (record.handback === 'withheld' || record.content === undefined) return ''
  return record.content.join('\n')
}

// The id of an agent the host launched in the background: only from core's record of the launch.
export function launchedAgent(answer: unknown): string | undefined {
  const record = recordOf(answer)
  const id = record?.status === 'async_launched' ? record.agentId : undefined
  return typeof id === 'string' && id !== '' ? id : undefined
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
