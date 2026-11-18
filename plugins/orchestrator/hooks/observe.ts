// hooks/observe.ts
// The orchestrator's journal writer (core's journal.ts and learning.ts), shared by the audit trail
// (audit.ts) and the guards that observe instead of refusing (guards.ts, naming.ts, commands.ts):
// one escape per call a guard once refused and now lets through, under the guard's stable code. It
// imports no guard, so a guard imports it. An observer: a journal that cannot be written is one
// line in the module's log, and the call goes on.
import { appendEventOver, randomPart, type JournalIo } from '../core/journal.ts'
import { journalDir } from '../core/learning.ts'
import { parseSessionName } from '../core/names.ts'
import { observedEvent, refusalEvent, PLUGIN, stampOf, type Built, type Stamp, type WaitSeen } from './audit-events.ts'
import { messageOf, type Host } from './host.ts'
import { configDir, logLine, storeIo } from './module-io.ts'
import { moduleDirOf } from './module-log.ts'
import { parseSessionRow, sessionKey } from './supervision.ts'

// The stable codes of the guards that observe, as the journal holds them.
export const STOP_GATE_CODE = 'orchestrator.stop-gate.held'
export const REPORT_UNNAMED_CODE = 'orchestrator.message.report-unnamed'
export const MAP_WRITE_CODE = 'orchestrator.models.map-write'
export const MODE_DIALOG_CODE = 'orchestrator.mode.dialog'
export const WAITED_ON_DIALOG_CODE = 'orchestrator.dialog.waited-on'
export const RENAME_PENDING_CODE = 'orchestrator.naming.rename-pending'
export const END_TODO_OPEN_CODE = 'orchestrator.coordinator-end.todo-open'

export type Held = Host<'plugin' | 'env' | 'process' | 'fs' | 'session' | 'clock'>

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
export interface Memory {
  readonly now: () => Date
  pruned: boolean
  pending: { span: string; wait: WaitSeen } | null
}

// Writes what `build` makes of this moment; answers the events written, none when the journal failed.
export async function write($: Held, memory: Memory, build: (stamp: Stamp) => Built[]): Promise<Built[]> {
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

// The memory of the guards' observations: pruned once per process, as the handlers' own.
const observing: Memory = { now: () => new Date(), pruned: false, pending: null }

/*
 * A guard of this module that observes instead of refusing: the call it once refused goes through,
 * and the journal holds one escape under the guard's stable code. Never throws: a journal that
 * cannot be written is one line in the module's log.
 */
export async function observed($: Held, code: string): Promise<void> {
  await write($, observing, stamp => observedEvent(stamp, code))
}

/*
 * A guard of this module that refuses: the journal holds one refusal under the guard's stable code.
 * Never throws: a journal that cannot be written is one line in the module's log.
 */
export async function refused($: Held, code: string): Promise<void> {
  await write($, observing, stamp => refusalEvent(stamp, code))
}
