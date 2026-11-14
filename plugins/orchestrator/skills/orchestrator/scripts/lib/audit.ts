// The audit trail a script of the orchestrator's skill writes (core's learning.ts, version 2):
// the facts it alone sees as they happen — a dispatch row opened, reviewed, corrected or closed, a
// wait on a pull request's checks — into the orchestrator's journal. Each event holds names,
// numbers and pointers, never a command line or the words of a verdict, a ruling or a defect.
// Writing is an observation: a journal that cannot be written is said on stderr, and the
// command's own outcome stands.
import { randomBytes } from 'node:crypto'
import { relative, sep } from 'node:path'
import { appendEvent } from '../../../../core/journal-sync.ts'
import {
  auditEvent, journalDir, learningEvent, type AuditEvent, type AuditKind, type EventInput, type Evidence, type Facts, type LearningEvent,
} from '../../../../core/learning.ts'
import { configDir, setting, type Env } from '../../../../core/paths.ts'

export const PLUGIN = 'orchestrator'

/** Takes one event a script built; a test hands in its own. */
export type Journal = (event: LearningEvent | AuditEvent) => void

/** A time as the contract writes it: to the second, in UTC. */
export function stamp(date: Date): string {
  return date.toISOString().replace(/\.[0-9]{3}Z$/, 'Z')
}

/**
 * The orchestrator's journal under the configuration directory, or ORCHESTRATOR_JOURNAL_DIR when
 * set: the suite points it at its own directory, so its runs never write the operator's journal.
 * A write that fails is said through `warn`.
 */
export function scriptJournal(env: Env, now: () => Date, warn: (line: string) => void): Journal {
  const dir = setting(env, 'ORCHESTRATOR_JOURNAL_DIR') ?? journalDir(configDir(env, setting(env, 'HOME')), PLUGIN)
  return event => {
    try {
      appendEvent(dir, event, stamp(now()))
    } catch (error) {
      warn(`audit: the journal could not be written: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * A file named for the journal: its path under the configuration directory, else under the home
 * directory, else its last two segments, so two records of one project are told apart and no
 * absolute path is written. Null when even that is no path the contract takes.
 */
export function pointerOf(path: string, env: Env): string | null {
  for (const root of [configDir(env, setting(env, 'HOME')), setting(env, 'HOME')]) {
    if (root === undefined) continue
    const inside = relative(root, path)
    if (inside !== '' && !inside.startsWith('..') && !inside.startsWith(sep)) return checked(inside)
  }
  return checked(path.split('/').filter(part => part !== '').slice(-2).join('/'))
}

function checked(path: string): string | null {
  return auditEvent({ ...probe, kind: 'link', fact: { record: path, row: null, session: null, goal: null, prs: [] } }) ? path : null
}

const probe = { at: '2000-01-01T00:00:00Z', random: '00000000', source: { plugin: PLUGIN, code: 'orchestrator.probe' }, trust: 'computed' as const }

/** What every event of one run shares: its time and the host session that ran it. */
export interface AuditRun {
  readonly at: string
  readonly session: string | null
}

export function auditRun(env: Env, now: Date): AuditRun {
  return { at: stamp(now), session: setting(env, 'CLAUDE_CODE_SESSION_ID') ?? null }
}

const random = (): string => randomBytes(4).toString('hex')

/** A head the contract takes (the full 40 characters), else null: a shortened one points at nothing certain. */
export function fullHead(head: string | undefined): string | null {
  return head !== undefined && /^[0-9a-fA-F]{40}$/.test(head) ? head.toLowerCase() : null
}

type Extra = Pick<EventInput, 'subject' | 'evidence'>

/** Writes an audit event; one the contract refuses (a session id it does not take, say) is written with that field left out. */
export function writeAudit<K extends AuditKind>(journal: Journal | undefined, run: AuditRun, kind: K, code: string, fact: Facts[K], extra: Extra = {}): void {
  if (journal === undefined) return
  const input = { at: run.at, random: random(), source: { plugin: PLUGIN, code }, trust: 'computed' as const, ...extra }
  const event = auditEvent({ ...input, kind, fact, context: { session: run.session } }) ?? auditEvent({ ...input, kind, fact })
  if (event !== undefined) journal(event)
}

/** Writes a version 1 event (an escape) the same way. */
export function writeEscape(journal: Journal | undefined, run: AuditRun, code: string, evidence: readonly Evidence[]): void {
  if (journal === undefined) return
  const input = { at: run.at, random: random(), source: { plugin: PLUGIN, code }, trust: 'computed' as const, kind: 'escape' as const, evidence }
  const event = learningEvent({ ...input, context: { session: run.session } }) ?? learningEvent(input)
  if (event !== undefined) journal(event)
}
