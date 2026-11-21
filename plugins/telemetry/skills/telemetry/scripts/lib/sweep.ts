// The sweep: what no hook of a session hands the writer, read after the fact, at most once a UTC
// day when a session's end starts it. Two reads, each over the last SWEEP_DAYS day files:
// - a session whose events stopped IDLE_MS ago with no `session_end` after them (a closed tab, a
//   killed process, a machine that slept) gets the `session_summary` of its transcript, as
//   `backfill` writes one, with `source: sweep`;
// - a question of the orchestrator's round, once settled, gets a `question` event read from its
//   file through core's `parseRoundQuestion`: its id, its asker and the letter chosen;
// - a write of the orchestrator's dispatch record gets a `dispatch` event read from the event its
//   script published in the orchestrator's journal (core's audit contract, kind `dispatch`);
// - what github's reconciler did between two renewals of its lease gets a `reconcile` event read
//   from the event it published in github's journal (core's audit contract, kind `reconcile`).
// Nothing is kept beside the store: a session is closed by an end or a summary at or after its last
// event, a question or a dispatch is recorded when an event of the window carries its id, and one
// before the window is past reading.
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { journalDir, journalEntryOf, parseAuditEvent, type AuditEvent } from '../../../../core/learning.ts'
import { ROUND_ARCHIVE_DIR, ROUND_DIR } from '../../../../core/orchestration.ts'
import { moduleDirUnder } from '../../../../core/roots.ts'
import { parseRoundQuestion, type RoundQuestion } from '../../../../core/round-question.ts'
import { readText, update } from '../../../../core/store.ts'
import { HEAD_MAX, makeEvent, roleOf, type Event } from '../../../../hooks/collect.ts'
import type { EnvSecrets } from './redact.ts'
import { append, dayFiles, eventsDir } from './store.ts'
import { summarizeFile, transcriptOf } from './transcript.ts'

/** The day files read: today's and the days before it. */
export const SWEEP_DAYS = 7
/** A session with no event for this long and no end is taken as ended. */
export const IDLE_MS = 24 * 3_600_000
/** The `source` of a question read from its round file, and of a summary the sweep wrote. */
export const ROUND_FILE = 'round_file'
export const SWEPT = 'sweep'
/** The `source` of a dispatch read from the orchestrator's journal. */
export const JOURNAL = 'journal'
/** The plugin whose journal holds the dispatch record's events. */
const DISPATCH_PLUGIN = 'orchestrator'
/** The plugin whose journal holds the reconciler's counts. */
const RECONCILE_PLUGIN = 'github'

const DAY_MS = 24 * 3_600_000
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10)
const statePath = (stateDir: string): string => join(stateDir, 'sweep.json')

type Fields = Record<string, unknown>
const record = (value: unknown): Fields => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {})

function sweptDay(raw: string | undefined): string | null {
  try {
    const day = record(JSON.parse(raw ?? 'null'))['swept_day']
    return typeof day === 'string' ? day : null
  } catch {
    return null
  }
}

/** Whether no sweep has been started this UTC day. */
export function sweepDue(stateDir: string, now: number): boolean {
  return sweptDay(readText(statePath(stateDir))) !== dayOf(now)
}

/** Takes the day's sweep, under the state file's lock: true for the one caller that got it. */
export function claimSweep(stateDir: string, now: number): boolean {
  let claimed = false
  update(statePath(stateDir), current => {
    claimed = sweptDay(current) !== dayOf(now)
    return `${JSON.stringify({ swept_day: dayOf(now) })}\n`
  })
  return claimed
}

/** What the window's events say of one session. */
interface Seen {
  /** Its last event that is neither an end nor a summary. */
  last: number
  /** Its last end or summary. */
  closed: number
  spawned: boolean
}

/** The sessions of the window's day files, and the ids of the round questions and journal dispatches they already record. */
export function readWindow(dir: string, firstDay: string): { sessions: Map<string, Seen>; questions: Set<string>; dispatches: Set<string>; reconciles: Set<string> } {
  const sessions = new Map<string, Seen>()
  const questions = new Set<string>()
  const dispatches = new Set<string>()
  const reconciles = new Set<string>()
  for (const name of dayFiles(dir).filter(file => file.slice(0, 10) >= firstDay)) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (line === '') continue
      let e: Fields
      try {
        e = record(JSON.parse(line))
      } catch {
        continue
      }
      const session = e['session']
      const at = typeof e['ts'] === 'string' ? Date.parse(e['ts']) : NaN
      if (typeof session !== 'string' || !Number.isFinite(at)) continue
      if (e['event'] === 'question' && e['source'] === ROUND_FILE) {
        if (typeof e['id'] === 'string') questions.add(e['id'])
        continue
      }
      if (e['event'] === 'dispatch' && e['source'] === JOURNAL) {
        if (typeof e['id'] === 'string') dispatches.add(e['id'])
        continue
      }
      if (e['event'] === 'reconcile' && e['source'] === JOURNAL) {
        if (typeof e['id'] === 'string') reconciles.add(e['id'])
        continue
      }
      const seen = sessions.get(session) ?? { last: -Infinity, closed: -Infinity, spawned: false }
      if (e['event'] === 'session_end' || e['event'] === 'session_summary') seen.closed = Math.max(seen.closed, at)
      else seen.last = Math.max(seen.last, at)
      if (e['spawned'] === true) seen.spawned = true
      sessions.set(session, seen)
    }
  }
  return { sessions, questions, dispatches, reconciles }
}

/** The summary of a session the window shows idle and never ended, or undefined when it ended, is still fresh or has no transcript. */
export function unendedSummary(config: string, session: string, seen: Seen, now: number): Event | undefined {
  if (!Number.isFinite(seen.last) || seen.closed >= seen.last || now - seen.last < IDLE_MS) return undefined
  const path = transcriptOf(config, session)
  if (path === undefined) return undefined
  let summary: ReturnType<typeof summarizeFile>
  try {
    summary = summarizeFile(path, seen.spawned)
  } catch {
    return undefined
  }
  const ended = Date.parse(summary.ended ?? '')
  // The transcript moved since the last event: the session lives, whatever the events say.
  if (Number.isFinite(ended) && now - ended < IDLE_MS) return undefined
  // Written at the later of the two ends, so the summary closes every event it was read after.
  return makeEvent('session_summary', Number.isFinite(ended) ? Math.max(ended, seen.last) : seen.last, session, { ...summary, source: SWEPT })
}

/** The round questions the orchestrator's module directory holds, open ones and files that are none left out. */
export function settledQuestions(moduleDir: string): RoundQuestion[] {
  const found: RoundQuestion[] = []
  for (const dir of [join(moduleDir, ROUND_DIR), join(moduleDir, ROUND_DIR, ROUND_ARCHIVE_DIR)]) {
    let names: string[]
    try {
      names = readdirSync(dir).filter(name => name.endsWith('.json')).sort()
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const question = parseRoundQuestion(JSON.parse(readFileSync(join(dir, name), 'utf8')))
        if (question !== undefined && question.answer !== null) found.push(question)
      } catch { /* a file being written, or no JSON: read at the next sweep */ }
    }
  }
  return found
}

/** The `question` event of a settled round question: the asker as the event's session and title, the letter, never a word of either text. */
export function questionEvent(question: RoundQuestion): Event | undefined {
  if (question.answer === null) return undefined
  const answered = Date.parse(question.answer.at)
  return makeEvent('question', answered, question.session, {
    title: question.asker,
    role: roleOf(question.asker),
    source: ROUND_FILE,
    id: question.id,
    kind: question.kind,
    status: question.status,
    by: question.answer.by,
    count: 1,
    options: [question.options],
    recommended: question.recommended ?? undefined,
    chosen: [question.answer.withdrawn ? '-' : question.answer.letter ?? 'other'],
    wait_ms: Math.max(0, answered - Date.parse(question.at)),
    urgent: question.urgent ? true : undefined,
  })
}

type Dispatch = Extract<AuditEvent, { kind: 'dispatch' }>
type Reconcile = Extract<AuditEvent, { kind: 'reconcile' }>

// The audit events of `kind` in the journal `dir` written on or after `firstDay`, by a known session; an entry that is none left out.
function journalEvents<K extends AuditEvent['kind']>(dir: string, firstDay: string, kind: K): Extract<AuditEvent, { kind: K }>[] {
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  const found: Extract<AuditEvent, { kind: K }>[] = []
  for (const name of names) {
    const entry = journalEntryOf(name)
    if (entry === undefined || entry.at.slice(0, 10) < firstDay) continue
    try {
      const event = parseAuditEvent(JSON.parse(readFileSync(join(dir, name), 'utf8')))
      if (event?.kind === kind && event.context.session !== null) found.push(event as Extract<AuditEvent, { kind: K }>)
    } catch { /* a file being written, or no JSON: read at the next sweep */ }
  }
  return found
}

/** The dispatch events of the journal `dir` written on or after `firstDay`, by a known session; an entry that is none left out. */
export function journalDispatches(dir: string, firstDay: string): Dispatch[] {
  return journalEvents(dir, firstDay, 'dispatch')
}

/** The reconciler's count events of the journal `dir` written on or after `firstDay`, by a known session. */
export function journalReconciles(dir: string, firstDay: string): Reconcile[] {
  return journalEvents(dir, firstDay, 'reconcile')
}

/** The `reconcile` event of a journal's reconcile: the session that held the lease and what it did since its last one. */
export function reconcileEvent(event: Reconcile): Event {
  const { fact } = event
  return makeEvent('reconcile', Date.parse(event.at), event.context.session ?? '', {
    source: JOURNAL, id: event.id, ticks: fact.ticks, listings: fact.listings, gates: fact.gates, moves: fact.moves,
  })
}

/** The `dispatch` event of a journal's dispatch: the session that wrote it, the record's file name, the row and its pair. */
export function dispatchEvent(event: Dispatch): Event {
  const { fact } = event
  return makeEvent('dispatch', Date.parse(event.at), event.context.session ?? '', {
    source: JOURNAL,
    id: event.id,
    sub: fact.sub,
    record: fact.record === null ? undefined : basename(fact.record),
    row: fact.row === null ? undefined : String(fact.row),
    class: fact.class ?? undefined,
    tier: fact.tier ?? undefined,
    model: fact.model ?? undefined,
    effort: fact.effort ?? undefined,
    head: event.subject.head?.slice(0, HEAD_MAX),
    verdict: fact.verdict ?? undefined,
  })
}

export interface SweepOptions {
  readonly config: string
  readonly stateDir: string
  readonly secrets: EnvSecrets
  /** The orchestrator's module directory, when its environment moves it. */
  readonly moduleDir?: string | undefined
  /** The orchestrator's journal, when its environment moves it (ORCHESTRATOR_JOURNAL_DIR). */
  readonly journalDir?: string | undefined
  /** github's journal, where a test puts it. */
  readonly githubJournalDir?: string | undefined
  readonly now: number
}

export interface SweepResult {
  readonly sessions: number
  readonly questions: number
  readonly dispatches: number
  /** The reconciler's count events recorded, when there were any. */
  readonly reconciles?: number
  readonly refused: readonly string[]
}

/** One sweep: the summaries of the sessions that never ended, the settled round questions and the journal's dispatches, appended to the store. */
export function sweep(options: SweepOptions): SweepResult {
  const { config, stateDir, now } = options
  const firstDay = dayOf(now - (SWEEP_DAYS - 1) * DAY_MS)
  const dir = eventsDir(stateDir)
  const window = readWindow(dir, firstDay)
  const summaries = [...window.sessions].flatMap(([session, seen]) => unendedSummary(config, session, seen, now) ?? [])
  const questions = settledQuestions(moduleDirUnder(config, options.moduleDir))
    .filter(question => question.answer !== null && question.answer.at.slice(0, 10) >= firstDay && !window.questions.has(question.id))
    .flatMap(question => questionEvent(question) ?? [])
  const dispatches = journalDispatches(options.journalDir ?? journalDir(config, DISPATCH_PLUGIN), firstDay)
    .filter(event => !window.dispatches.has(event.id))
    .map(dispatchEvent)
  const reconciles = journalReconciles(options.githubJournalDir ?? journalDir(config, RECONCILE_PLUGIN), firstDay)
    .filter(event => !window.reconciles.has(event.id))
    .map(reconcileEvent)
  const lines = (events: readonly Event[]): string => events.map(event => JSON.stringify(event)).join('\n')
  // A refused line is a question, a dispatch or a reconcile whose session has no id of the host's shape; a summary's session came from the store.
  const asked = append(dir, lines([...summaries, ...questions]), options.secrets).refused
  const published = append(dir, lines(dispatches), options.secrets).refused
  const counted = append(dir, lines(reconciles), options.secrets).refused
  return {
    sessions: summaries.length, questions: questions.length - asked.length, dispatches: dispatches.length - published.length,
    ...(reconciles.length > 0 ? { reconciles: reconciles.length - counted.length } : {}), refused: [...asked, ...published, ...counted],
  }
}
