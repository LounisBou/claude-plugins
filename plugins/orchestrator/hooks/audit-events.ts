// hooks/audit-events.ts
// The events of the audit trail the hooks module writes (core's learning.ts), built from what a
// handler saw: a guard's refusal by its stable code, a review verdict with the orchestrator's
// decision on each finding, a pull request opened or merged through the github tool, a declared
// wait's start and end. Pure: the handlers in audit.ts read the host and write the journal. Each
// event holds names, numbers and pointers; a finding's point, a reason, a title, a body or a
// wait's `blocks` never enter one.
import {
  auditEvent, learningEvent, prRefsOf, type AuditEvent, type Decision, type Edge, type EventInput, type Facts, type FindingSeverity,
  type LearningEvent, type Verdict, type WaitKind,
} from '../core/learning.ts'

export const PLUGIN = 'orchestrator'

export type Built = LearningEvent | AuditEvent

/** What every event of one observation shares: its time, its random part, the session and its role. */
export interface Stamp {
  readonly at: string
  readonly random: () => string
  readonly session: string | null
  readonly role: string | null
}

type Extra = Pick<EventInput, 'subject' | 'evidence'>

function input(stamp: Stamp, code: string, extra: Extra) {
  return {
    at: stamp.at, random: stamp.random(), source: { plugin: PLUGIN, code }, context: { session: stamp.session, role: stamp.role },
    trust: 'computed' as const, ...extra,
  }
}

function audit<K extends keyof Facts>(stamp: Stamp, kind: K, code: string, fact: Facts[K], extra: Extra = {}): Built[] {
  const event = auditEvent({ ...input(stamp, code, extra), kind, fact })
  return event === undefined ? [] : [event]
}

/** The time as the contract writes it: to the second, in UTC. */
export function stampOf(date: Date): string {
  return date.toISOString().replace(/\.[0-9]{3}Z$/, 'Z')
}

/** A guard's refusal: one version 1 event, its code as its source and its evidence. */
export function refusalEvent(stamp: Stamp, code: string): Built[] {
  const event = learningEvent({ ...input(stamp, code, { evidence: [{ type: 'refusal', code }] }), kind: 'refusal' })
  return event === undefined ? [] : [event]
}

/** A repository the contract takes, lower-cased as the forge reads it; null for anything else. */
function repoOf(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.trim()) ? value.trim().toLowerCase() : null
}

function prOf(value: unknown): number | null {
  const n = Number(String(value ?? '').replace('#', ''))
  return Number.isInteger(n) && n >= 1 ? n : null
}

/** The text of a tool's answer when it went through: neither refused nor an error. */
export function answerText(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const r = result as { result?: unknown; deny?: unknown; isError?: unknown; block?: unknown }
  if (r.deny !== undefined || r.isError === true || r.block !== undefined) return null
  return typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? null)
}

/**
 * The record a review verdict was written to, as the journal names it: its path under the
 * configuration directory (the first line of github's answer), and the head it lies under.
 */
export function recordOf(answer: string, configDir: string): { path: string | null; head: string | null } {
  const first = answer.split('\n')[0]?.trim() ?? ''
  const root = `${configDir.replace(/\/+$/, '')}/`
  const path = first.startsWith(root) ? first.slice(root.length) : null
  const head = path?.split('/').find(part => /^[0-9a-fA-F]{40}$/.test(part))?.toLowerCase() ?? null
  return { path, head }
}

export interface ReviewSeen {
  readonly repo: unknown
  readonly pr: unknown
  readonly verdict: Verdict
  readonly findings: readonly { readonly decision: Decision; readonly file: string | null; readonly line: number | null; readonly severity: FindingSeverity | null }[]
}

/**
 * A verdict written: the review with its counts, the decision on each finding, and, for an
 * acceptance over the failed review at its head, the overridden verdict as the method's failure.
 */
export function reviewEvents(stamp: Stamp, seen: ReviewSeen, answer: string, configDir: string): Built[] {
  const record = recordOf(answer, configDir)
  const extra: Extra = {
    subject: { repo: repoOf(seen.repo), pr: prOf(seen.pr), head: record.head },
    evidence: record.path === null ? [] : [{ type: 'record', path: record.path }],
  }
  const count = (decision: Decision) => seen.findings.filter(f => f.decision === decision).length
  return [
    ...audit(stamp, 'review', 'orchestrator.review.verdict', { verdict: seen.verdict, kept: count('kept'), set_aside: count('set-aside') }, extra),
    ...seen.findings.flatMap(finding => {
      const fact = { decision: finding.decision, severity: finding.severity, file: finding.file, line: finding.line }
      // A file the contract does not take as a path is left out rather than losing the decision.
      const written = audit(stamp, 'decision', 'orchestrator.review.decision', fact, extra)
      return written.length > 0 ? written : audit(stamp, 'decision', 'orchestrator.review.decision', { ...fact, file: null }, extra)
    }),
    ...(seen.verdict === 'accepted' ? audit(stamp, 'failure', 'orchestrator.review.overridden', { failure: 'verdict-overridden', count: null, prs: [] }, extra) : []),
  ]
}

/** The address of a pull request on GitHub: its repository and its number. */
export const PULL_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)/

/** A conventional commit's fix: `fix: …`, `fix(scope): …`, `fix!: …`. */
const FIX_TITLE = /^fix(?:\([^)]*\))?!?:/

/**
 * A call of the github tool that went through: a pull request opened ends its implementation and
 * links it to the session, and when its title is a fix naming other pull requests, it is the
 * method's failure, with the pull requests it names; a merge is the merge step.
 */
export function githubEvents(stamp: Stamp, call: Readonly<Record<string, unknown>>, answer: string): Built[] {
  const args = (typeof call['args'] === 'object' && call['args'] !== null ? call['args'] : {}) as Record<string, unknown>
  if (call['command'] === 'pr-merge') {
    const pr = prOf(args['pr'])
    if (pr === null) return []
    return audit(stamp, 'step', 'orchestrator.github.merge', { step: 'merge', edge: 'end', record: null, row: null, result: null },
      { subject: { repo: repoOf(call['repo']), pr } })
  }
  if (call['command'] !== 'pr-create') return []
  const url = PULL_URL.exec(answer)
  if (url === null) return []
  const subject = { repo: repoOf(url[1]), pr: prOf(url[2]) }
  const title = typeof args['title'] === 'string' ? args['title'] : ''
  const self = [`${subject.repo}#${subject.pr}`, `${subject.repo?.split('/')[1]}#${subject.pr}`]
  const fixes = FIX_TITLE.test(title.trim())
    ? prRefsOf(`${title}\n${typeof args['body'] === 'string' ? args['body'] : ''}`).filter(ref => !self.includes(ref.toLowerCase()))
    : []
  return [
    ...audit(stamp, 'step', 'orchestrator.github.pr-create', { step: 'implement', edge: 'end', record: null, row: null, result: null }, { subject }),
    ...audit(stamp, 'link', 'orchestrator.github.pr-create', { record: null, row: null, session: stamp.session, goal: null, prs: [] }, { subject }),
    ...(fixes.length > 0 ? audit(stamp, 'failure', 'orchestrator.github.fix', { failure: 'fix-after-merge', count: null, prs: fixes }, { subject }) : []),
  ]
}

/** On whom a declared wait waits: the operator for his question or his deferral, the tool it watches, nobody once done. */
const WAIT_ON = { operator: 'operator', deferred: 'operator', tool: 'tool', done: null } as const

export interface WaitSeen {
  readonly kind: WaitKind
  readonly consent?: { readonly repo: string; readonly pr?: number } | undefined
}

/** A declared wait's start (span null) or end (span: the start's identifier); its consent's pull request, if any. */
export function waitEvents(stamp: Stamp, wait: WaitSeen, edge: Edge, span: string | null): Built[] {
  return audit(stamp, 'wait', `orchestrator.wait.${wait.kind}`, { wait: wait.kind, edge, span, on: WAIT_ON[wait.kind] },
    { subject: { repo: repoOf(wait.consent?.repo), pr: prOf(wait.consent?.pr) } })
}
