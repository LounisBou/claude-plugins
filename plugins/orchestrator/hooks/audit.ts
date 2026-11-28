// hooks/audit.ts
// The audit trail the hooks module writes into the orchestrator's journal (core's learning.ts):
// each refusal of this module's guards by its stable code, naming its repository (the kill guard's and
// the review tool's; the guards that observe write their escape through observe.ts), each review verdict
// with the decision on each finding, each pull request opened or merged through the github tool, each declared
// wait from the end of the turn that declared it to the start of the next. Mounted first: every
// handler here calls `next`, then reads what the chain answered, so the guards and the tools
// decide as if it were not there. An observer: a journal that cannot be written is one line in
// the module's log, and the call's answer stands. The events are built in audit-events.ts.
import { answerText, githubEvents, refusalEvent, reviewEvents, waitEvents, type WaitSeen } from './audit-events.ts'
import { guardFallback, killDecision } from './guards.ts'
import { messageOf, type Caught, type Next, type On } from './host.ts'
import { MODELS_DENY } from './models-guard.ts'
import { configDir, logLine } from './module-io.ts'
import { write, type Held, type Memory } from './observe.ts'
import { repositoryOf } from './review-rounds.ts'
import { findingsOf, NOT_ORCHESTRATOR, REVIEW_TOOL, withIndexIds } from './review.ts'
import { DECLARATIONS, type Declarations } from './wait.ts'

// What precedes the words of the command a kill refusal quotes, read off the guard's own builders.
const KILL_PREFIX = (killDecision('1', 'pkill x')?.deny ?? '').split('Seen:')[0] ?? ''
const UNREAD_MARK_PREFIX = (guardFallback(undefined, 'pkill x', '\u0000')?.deny ?? '').split('(\u0000)')[0] ?? ''

// Each refusal of this module's guards, by the stable code the journal holds it under.
const REFUSALS: readonly (readonly [string, (deny: string) => boolean])[] = [
  ['orchestrator.kill.pattern', deny => KILL_PREFIX !== '' && deny.startsWith(KILL_PREFIX)],
  ['orchestrator.kill.unread-mark', deny => UNREAD_MARK_PREFIX !== '' && deny.startsWith(UNREAD_MARK_PREFIX)],
  ['orchestrator.models.map-write', deny => deny === MODELS_DENY],
]

/** The stable code of a refusal this module's guards answered with, or null for one they did not. */
export function refusalCode(tool: string, result: unknown): string | null {
  const r = (typeof result === 'object' && result !== null ? result : {}) as { deny?: unknown; result?: unknown; isError?: unknown }
  if (typeof r.deny === 'string') return REFUSALS.find(([, matches]) => matches(r.deny as string))?.[0] ?? null
  if (tool === `mcp__orchestrator__${REVIEW_TOOL}` && r.isError === true && r.result === NOT_ORCHESTRATOR) return 'orchestrator.review.not-orchestrator'
  return null
}

// A tool call the chain answered: a refusal of this module's guards, a review verdict, a github act.
async function observeTool($: Held, memory: Memory, e: Readonly<Record<string, unknown>>, result: unknown): Promise<void> {
  try {
    const tool = String(e['tool'] ?? '')
    const code = refusalCode(tool, result)
    if (code !== null) {
      // The review call names its repository and pull request; a guard's refusal is the session's checkout's.
      const cwd = await $.session.cwd().catch(() => undefined)
      const repo = await repositoryOf($, String(e['repo'] ?? '').trim(), cwd)
      await write($, memory, stamp => refusalEvent(stamp, code, { repo, pr: e['pr'] }))
    }
    const answer = answerText(result)
    if (answer !== null && tool === `mcp__orchestrator__${REVIEW_TOOL}` && e['plan'] === undefined) {
      const verdict = String(e['verdict'] ?? '').trim()
      if (verdict === 'pass' || verdict === 'fail' || verdict === 'accepted') {
        const config = await configDir($)
        // The findings index names each finding's id: a decision carries it, an index not read leaves it unknown.
        const path = typeof e['findings'] === 'string' && e['findings'].startsWith('/') ? e['findings'] : null
        const index = path === null ? null : await $.fs.read(path).catch(() => null)
        await write($, memory, stamp => reviewEvents(stamp, { repo: e['repo'], pr: e['pr'], verdict, findings: withIndexIds(findingsOf(e), index) }, answer, config))
      }
    }
    if (answer !== null && tool === 'mcp__github__gh') await write($, memory, stamp => githubEvents(stamp, e, answer))
  } catch (err) {
    await logLine($, 'audit', `a tool call not observed: ${messageOf(err)}`)
  }
}

// The turn ended on the wait it declared: the last one ends, this one starts.
async function startWait($: Held, memory: Memory, wait: WaitSeen): Promise<void> {
  await endWait($, memory)
  const [start] = await write($, memory, stamp => waitEvents(stamp, wait, 'start', null))
  if (start !== undefined) memory.pending = { span: start.id, wait }
}

// The next turn starts, or the session ends: the wait is over.
async function endWait($: Held, memory: Memory): Promise<void> {
  const ended = memory.pending
  memory.pending = null
  if (ended !== null) await write($, memory, stamp => waitEvents(stamp, ended.wait, 'end', ended.span))
}

export function register(on: On<Held>, declarations: Declarations = DECLARATIONS, now: () => Date = () => new Date()): void {
  const memory: Memory = { now, pruned: false, pending: null }

  on('tool.call', {}, async ($, e, next) => {
    const result = await next(e)
    await observeTool($, memory, e, result)
    return result
  }).catch(net)

  on('turn.complete', {}, async ($, e, next) => {
    const result = await next(e)
    const wait = e.agentId === undefined ? declarations.current() : null
    if (wait !== null) await startWait($, memory, { kind: wait.kind })
    return result
  }).catch(net)

  on('turn.start', {}, async ($, e, next) => {
    if (e.agentId === undefined) await endWait($, memory)
    return next(e)
  }).catch(net)

  on('session.end', {}, async ($, e, next) => {
    await endWait($, memory)
    return next(e)
  }).catch(net)
}

// The net under every handler: what failed is logged, and the event goes on.
async function net<E>($: Held, e: E, next: Next<E> & Caught): Promise<unknown> {
  await logLine($, 'audit', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
  return next(e)
}
