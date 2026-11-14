// hooks/audit.ts
// The audit trail the hooks module writes into the orchestrator's journal (core's learning.ts):
// each refusal of this module's guards by its stable code, each review verdict with the decision
// on each finding, each pull request opened or merged through the github tool, each declared
// wait from the end of the turn that declared it to the start of the next. Mounted first: every
// handler here calls `next`, then reads what the chain answered, so the guards and the tools
// decide as if it were not there. An observer: a journal that cannot be written is one line in
// the module's log, and the call's answer stands. The events are built in audit-events.ts.
import { appendEventOver, randomPart, type JournalIo } from '../core/journal.ts'
import { journalDir } from '../core/learning.ts'
import { parseSessionName } from '../core/names.ts'
import {
  answerText, githubEvents, PLUGIN, refusalEvent, reviewEvents, stampOf, waitEvents, type Built, type Stamp, type WaitSeen,
} from './audit-events.ts'
import { guardFallback, killDecision } from './guards.ts'
import { messageOf, type Host, type On } from './host.ts'
import { MODE_DIALOG_DENY } from './mode-dialog.ts'
import { MODELS_DENY } from './models-guard.ts'
import { configDir, logLine, storeIo } from './module-io.ts'
import { moduleDirOf } from './module-log.ts'
import { QUESTION_BY_MESSAGE } from './one-question.ts'
import { unnamedReport } from './relay.ts'
import { findingsOf, NOT_ORCHESTRATOR, REVIEW_TOOL } from './review.ts'
import { parseSessionRow, sessionKey } from './supervision.ts'
import { DECLARATIONS, type Declarations } from './wait.ts'

type Held = Host<'plugin' | 'env' | 'process' | 'fs' | 'session' | 'clock'>

// What precedes the words of the command a kill refusal quotes, read off the guard's own builders.
const KILL_PREFIX = (killDecision('1', 'pkill x')?.deny ?? '').split('Seen:')[0] ?? ''
const UNREAD_MARK_PREFIX = (guardFallback(undefined, 'pkill x', '\u0000')?.deny ?? '').split('(\u0000)')[0] ?? ''

// Each refusal of this module's guards, by the stable code the journal holds it under.
const REFUSALS: readonly (readonly [string, (deny: string) => boolean])[] = [
  ['orchestrator.kill.pattern', deny => KILL_PREFIX !== '' && deny.startsWith(KILL_PREFIX)],
  ['orchestrator.kill.unread-mark', deny => UNREAD_MARK_PREFIX !== '' && deny.startsWith(UNREAD_MARK_PREFIX)],
  ['orchestrator.message.question-to-coordinator', deny => deny === QUESTION_BY_MESSAGE],
  ['orchestrator.message.report-unnamed', deny => deny === unnamedReport(Number(/ is (\d+) characters/.exec(deny)?.[1] ?? -1))],
  ['orchestrator.models.map-write', deny => deny === MODELS_DENY],
  ['orchestrator.mode.dialog', deny => deny === MODE_DIALOG_DENY],
]

/** The stable code of a refusal this module's guards answered with, or null for one they did not. */
export function refusalCode(tool: string, result: unknown): string | null {
  const r = (typeof result === 'object' && result !== null ? result : {}) as { deny?: unknown; result?: unknown; isError?: unknown }
  if (typeof r.deny === 'string') return REFUSALS.find(([, matches]) => matches(r.deny as string))?.[0] ?? null
  if (tool === `mcp__orchestrator__${REVIEW_TOOL}` && r.isError === true && r.result === NOT_ORCHESTRATOR) return 'orchestrator.review.not-orchestrator'
  return null
}

export const STOP_GATE_CODE = 'orchestrator.stop-gate.held'

const SESSION = /^[A-Za-z0-9._-]{1,80}$/

// The journal's I/O over the host's nouns: the module's store I/O, and a listing that answers none when it fails.
function ioOf($: Held): JournalIo {
  return { ...storeIo($), list: dir => $.fs.list(dir).then(entries => entries.map(entry => entry.name), () => []) }
}

// The role the session's name gives, from its row in the module's store; null when it has none yet.
async function roleOf($: Held, config: string, session: string | null): Promise<string | null> {
  if (session === null) return null
  try {
    const row = parseSessionRow(await $.fs.read(`${moduleDirOf(config, await $.env.get('ORCHESTRATOR_MODULE_DIR'))}/store/${sessionKey(session)}`))
    return typeof row?.name === 'string' ? parseSessionName(row.name)?.role ?? null : null
  } catch {
    return null
  }
}

// What the module keeps between handlers: whether the journal was pruned (once per process, at
// its first write), and the wait the last turn declared, until the next turn starts.
interface Memory {
  readonly now: () => Date
  pruned: boolean
  pending: { span: string; wait: WaitSeen } | null
}

// Writes what `build` makes of this moment; answers the events written, none when the journal failed.
async function write($: Held, memory: Memory, build: (stamp: Stamp) => Built[]): Promise<Built[]> {
  try {
    const config = await configDir($)
    const id = await $.session.id().catch(() => '')
    const session = SESSION.test(id) ? id : null
    const stamp: Stamp = { at: stampOf(memory.now()), random: randomPart, session, role: await roleOf($, config, session) }
    const events = build(stamp)
    for (const event of events) {
      await appendEventOver(ioOf($), journalDir(config, PLUGIN), event, stamp.at, !memory.pruned)
      memory.pruned = true
    }
    return events
  } catch (err) {
    await logLine($, 'audit', `the journal could not be written: ${messageOf(err)}`)
    return []
  }
}

// A tool call the chain answered: a refusal of this module's guards, a review verdict, a github act.
async function observeTool($: Held, memory: Memory, e: Readonly<Record<string, unknown>>, result: unknown): Promise<void> {
  try {
    const tool = String(e['tool'] ?? '')
    const code = refusalCode(tool, result)
    if (code !== null) await write($, memory, stamp => refusalEvent(stamp, code))
    const answer = answerText(result)
    if (answer !== null && tool === `mcp__orchestrator__${REVIEW_TOOL}` && e['plan'] === undefined) {
      const verdict = String(e['verdict'] ?? '').trim()
      if (verdict === 'pass' || verdict === 'fail' || verdict === 'accepted') {
        const config = await configDir($)
        await write($, memory, stamp => reviewEvents(stamp, { repo: e['repo'], pr: e['pr'], verdict, findings: findingsOf(e) }, answer, config))
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

  on('classic.Stop', {}, async ($, e, next) => {
    const result = await next(e)
    if (typeof result === 'object' && result !== null && typeof (result as { block?: unknown }).block === 'string') {
      await write($, memory, stamp => refusalEvent(stamp, STOP_GATE_CODE))
    }
    return result
  }).catch(net)

  on('turn.complete', {}, async ($, e, next) => {
    const result = await next(e)
    const wait = e.agentId === undefined ? declarations.current() : null
    if (wait !== null) await startWait($, memory, { kind: wait.kind, consent: wait.consent })
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
async function net($: Held, e: unknown, next: ((e: unknown) => Promise<unknown>) & { error?: { kind?: string; message?: string } }): Promise<unknown> {
  await logLine($, 'audit', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
  return next(e)
}
