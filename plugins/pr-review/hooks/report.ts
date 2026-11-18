// hooks/report.ts
// The review's verdict, computed from what the review agents return rather than
// from a count the model gives. During a pass of auto-fix-loop, each agent the
// session launches is asked to end with one JSON block of its findings; the
// block is read here, and the loop counts the Critical and Important ones.
// An agent that ends without a readable block makes the pass's count unknown.

import { fieldsOf } from '../core/host.ts'
import { blocks } from '../core/readiness.ts'

export type Severity = 'critical' | 'important' | 'suggestion'
export type Finding = { severity: Severity; file: string; summary: string }

const SEVERITIES: readonly Severity[] = ['critical', 'important', 'suggestion']
const isSeverity = (value: string): value is Severity => SEVERITIES.some((s) => s === value)

export const REPORT_REQUEST = '\n\nEnd your answer with one fenced ```json block holding '
  + '{"findings": [{"severity": "critical" | "important" | "suggestion", "file": "<path>", "summary": "<one line>"}]}: '
  + 'every finding you report, and an empty list when you found none. The block is due even then, in place of any '
  + 'prose such as "no findings" an earlier line allows. The review\'s verdict is computed from this block alone.'

// Whitespace aside: a prompt the session wrote keeps the words, not always the line breaks.
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

// Whether a review agent's prompt carries the request, which the session writes there itself.
export const carriesRequest = (prompt: string): boolean => squash(prompt).includes(squash(REPORT_REQUEST))

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
    const fields = fieldsOf(item) ?? {}
    const severity = String(fields['severity'] ?? '').toLowerCase()
    if (!isSeverity(severity)) return null
    findings.push({ severity, file: String(fields['file'] ?? ''), summary: String(fields['summary'] ?? '') })
  }
  return findings
}

// The text of a tool's answer: a string, content blocks, or { result | text }.
export function answerText(answer: unknown): string {
  const fields = fieldsOf(answer)
  const body = fields?.['result'] ?? fields?.['text'] ?? answer
  if (typeof body === 'string') return body
  if (Array.isArray(body)) return body.map((part: unknown) => (typeof part === 'string' ? part : String(fieldsOf(part)?.['text'] ?? ''))).join('\n')
  return ''
}

// Core answers an Agent call with the tool's record in `result`, an object, beside the text the
// model reads: the record of an agent that completed, or of one launched in the background, whose
// report is not read.
// `recordOf` is the one validator: it narrows what the host answered to the fields read below.
type AgentRecord = {
  status: unknown
  handback: unknown
  // The text of the report the agent's hand-back tool delivered, when it has one.
  reportText: string | undefined
  // The text of each part of the agent's content, when the content is a list.
  content: string[] | undefined
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const recordOf = (answer: unknown): AgentRecord | undefined => {
  const result = isObject(answer) ? answer['result'] : undefined
  if (!isObject(result)) return undefined
  const report = result['handbackReport']
  const reportText = isObject(report) && typeof report['text'] === 'string' ? report['text'] : undefined
  const content = Array.isArray(result['content'])
    ? result['content'].map((part: unknown) => (isObject(part) && typeof part['text'] === 'string' ? part['text'] : ''))
    : undefined
  return { status: result['status'], handback: result['handback'], reportText, content }
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

// A refusal of the host's auto-mode classifier: the hook changed the call after it was reviewed,
// so the call never ran and is issued again.
export const isRefusedRewrite = (text: string): boolean => text.includes("a hook changed this call's input")

// The pass's findings once every agent reported, or undefined: none ran, or one did not report.
export function passFindings(reports: readonly (Finding[] | null)[]): Finding[] | undefined {
  if (reports.length === 0 || reports.some((r) => r === null)) return undefined
  return reports.flatMap((r) => r ?? [])
}

// The severities that block a review are core's readiness contract's.
export const isBlocking = (finding: Finding): boolean => blocks(finding.severity)
