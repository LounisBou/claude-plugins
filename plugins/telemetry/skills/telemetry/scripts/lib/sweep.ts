// The sweep: what no hook of a session hands the writer, read after the fact, at most once a UTC
// day when a session's end starts it. Two reads, each over the last SWEEP_DAYS day files:
// - a session whose events stopped IDLE_MS ago with no `session_end` after them (a closed tab, a
//   killed process, a machine that slept) gets the `session_summary` of its transcript, as
//   `backfill` writes one, with `source: sweep`;
// - a question of the orchestrator's round, once settled, gets a `question` event read from its
//   file through core's `parseRoundQuestion`: its id, its asker and the letter chosen.
// Nothing is kept beside the store: a session is closed by an end or a summary at or after its last
// event, a question is recorded when an event of the window carries its id, and one settled before
// the window is past reading.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { moduleDirOf, ROUND_ARCHIVE_DIR, ROUND_DIR } from '../../../../core/orchestration.ts'
import { parseRoundQuestion, type RoundQuestion } from '../../../../core/round-question.ts'
import { readText, update } from '../../../../core/store.ts'
import { makeEvent, roleOf, type Event } from '../../../../hooks/collect.ts'
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

/** The sessions of the window's day files, and the ids of the round questions they already record. */
export function readWindow(dir: string, firstDay: string): { sessions: Map<string, Seen>; questions: Set<string> } {
  const sessions = new Map<string, Seen>()
  const questions = new Set<string>()
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
      const seen = sessions.get(session) ?? { last: -Infinity, closed: -Infinity, spawned: false }
      if (e['event'] === 'session_end' || e['event'] === 'session_summary') seen.closed = Math.max(seen.closed, at)
      else seen.last = Math.max(seen.last, at)
      if (e['spawned'] === true) seen.spawned = true
      sessions.set(session, seen)
    }
  }
  return { sessions, questions }
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

export interface SweepOptions {
  readonly config: string
  readonly stateDir: string
  readonly secrets: EnvSecrets
  /** The orchestrator's module directory, when its environment moves it. */
  readonly moduleDir?: string | undefined
  readonly now: number
}

export interface SweepResult {
  readonly sessions: number
  readonly questions: number
  readonly refused: readonly string[]
}

/** One sweep: the summaries of the sessions that never ended and the settled round questions, appended to the store. */
export function sweep(options: SweepOptions): SweepResult {
  const { config, stateDir, now } = options
  const firstDay = dayOf(now - (SWEEP_DAYS - 1) * DAY_MS)
  const dir = eventsDir(stateDir)
  const window = readWindow(dir, firstDay)
  const summaries = [...window.sessions].flatMap(([session, seen]) => unendedSummary(config, session, seen, now) ?? [])
  const questions = settledQuestions(moduleDirOf(config, options.moduleDir))
    .filter(question => question.answer !== null && question.answer.at.slice(0, 10) >= firstDay && !window.questions.has(question.id))
    .flatMap(question => questionEvent(question) ?? [])
  const { refused } = append(dir, [...summaries, ...questions].map(event => JSON.stringify(event)).join('\n'), options.secrets)
  // A refused line is a question whose asker's session has no id of the host's shape; a summary's session came from the store.
  return { sessions: summaries.length, questions: questions.length - refused.length, refused }
}
