// hooks/stop-gate.ts
// The pure parts of an orchestrator's turn end, over plain values: the launcher's
// listing and the orchestrator's own agents, the busy wake the module's tick
// says, and the refusals of a declared done or deferred wait (wait.ts). Pure on
// purpose — the engine fences $ to the file that received it, so every read
// happens in the handler that holds $ and its answer passes in here. The stop
// itself is never held: guards.ts's handler only acts at it.

import { withDeadline as cancelAtDeadline, DeadlineExceeded } from '../core/deadline.ts'
import type { WaitKind } from '../core/orchestration.ts'
import { parseSessionName, sessionName } from '../core/names.ts'
import type { ChainEntry } from '../core/chain-entries.ts'
import type { Host } from './host.ts'

// A parsed value that holds fields: an object, an array among them.
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

// --- the decision shapes -----------------------------------------------------------------

// One race, the handlers' own law: a read runs under a deadline, and one that
// cannot answer in time lets the call or the stop pass. The degraded answer is a value told apart from the work's
// own, so the handler can say so in the log and stand down.
export type DegradedPass = { decision: 'pass'; degraded: true }
const DEGRADED: DegradedPass = { decision: 'pass', degraded: true }

export function isDegradedPass(value: unknown): value is DegradedPass {
  return typeof value === 'object' && value !== null && (value as { degraded?: unknown }).degraded === true
}

// The work is cancelled at the deadline (core's deadline, the one implementation): it is handed
// a signal aborted when the deadline wins, and checks it before any step that writes. A promise
// already started cannot be cancelled: that form is kept only for the callers not ported yet.
export async function withDeadline<T>(work: ((signal: AbortSignal) => Promise<T>) | Promise<T>, ms: number): Promise<T | DegradedPass> {
  try {
    return await cancelAtDeadline(ms, typeof work === 'function' ? work : () => work)
  } catch (err) {
    if (err instanceof DeadlineExceeded) return DEGRADED
    throw err
  }
}

// --- the declared wait (hooks/wait.ts) ----------------------------------------------------------

// What a turn may declare will wake it, by `declare_wait({kind, blocks})`: a question for the
// operator, every goal met, or only deferred work left (core's WAIT_KINDS). A command, monitor,
// subagent or agent of its own wakes the session by itself, never declared.
// `urgent` marks an operator wait the coordinator presents at once (URGENT_LINE).
// asked: the ids of the questions asked with `ask` (question.ts) an operator wait waits on.
export type DeclaredWait = { kind: WaitKind; blocks: string; urgent?: true; asked?: string[] }

// The one machine line a declaration spells: the form the relay reads a declared wait in.
// It is never taught: the model declares, and a line it writes itself decides nothing.
export function waitLine(wait: DeclaredWait): string {
  switch (wait.kind) {
    case 'operator': return `waiting: operator${wait.urgent ? ' (urgent)' : ''} — blocks: ${wait.blocks}`
    case 'deferred': return `waiting: deferred — ${wait.blocks}`
    case 'done': return 'waiting: done'
  }
}


// --- the refusal texts of a declared done or deferred wait (wait.ts holdsRecord) -----------------
// The deferral path beside the others: work the operator put off is recorded with his ruling
// and ended on its own declared wait, never put to him again as a question.
const DEFER_ROW = 'set its revisit date (dispatch-record.sh blocker <record> <id> "until <ISO UTC time>"), record his ruling with dispatch-record.sh defer <record> <id> --ruling "<his words, dated>" '
  + 'and declare a deferred wait'
const ROW_ONE = `Not done: row %s is open%p. Dispatch it, close it, or say what blocks it — or, if the operator deferred it, ${DEFER_ROW}.`
const ROW_MANY = `Not done: rows %s are open%p. Dispatch them, close them, or say what blocks them — or, if the operator deferred them, ${DEFER_ROW}.`
// The spec's goals (goals.md beside a registered record, read by goals.py check): done is
// measured against what the spec set out to reach, not against the plan alone.
const GOALS_OPEN = 'Not done against the spec: %s open%p. Dispatch the work that meets it and record its evidence '
  + '(dispatch-record.sh goals <record> met <G> --evidence …), or put it to the operator when he has not ruled, '
  + 'with an operator wait that blocks on <G> — or, if he deferred it, record his ruling with '
  + 'dispatch-record.sh goals <record> defer <G> --ruling "<his words, dated>" and declare a deferred wait.'
const DEFERRED_STILL = 'Not done: %s deferred by the operator, still open. Declare a deferred wait, not done.'
const COUNT_WRONG = 'A deferred wait must give the number of deferred rows and goals together: the right count is %s.'
const IDS_WRONG = 'A deferred wait must name every deferred item (rows by their number, goals as G<n>): %s.'
const NOTHING_DEFERRED = 'Nothing is deferred: no open row or goal carries the operator\'s ruling. '
  + 'If everything is finished, declare done.'
const GOALS_FAULT = 'goals.md is not a record of the spec: %s.'
// The to-dos of the session's own list (todo.ts): an open one holds a done, one he did not put off a deferred.
const TODO_WAYS = ' Do it and close it (todo done, with its outcome), hand it on (todo add … to <session>, then todo done naming it), '
  + 'or, if the operator put it off, record his ruling (todo defer) and declare a deferred wait.'
/** The refusal that names the open to-dos and what to do with each; `verb` is the wait that was refused. */
export const todoOpen = (names: readonly string[], verb: 'done' | 'deferred' = 'done'): string =>
  `Not ${verb}: ${names.length === 1 ? `to-do ${names[0]} is` : `to-dos ${names.join(', ')} are`} open.${TODO_WAYS}`

// Where the rows and the goals were read: the record files and goals.md files that hold them,
// said in the refusal so a session sees whose file it is being asked about. Nothing is said
// when the caller does not know them.
type Where = { rows?: readonly string[] | undefined; goals?: readonly string[] | undefined }
const placed = (paths: readonly string[] | undefined) => (paths && paths.length > 0 ? ` in ${paths.join(', ')}` : '')
// One pass over the template, so a label or a path that spells a placeholder is never filled twice.
const fill = (template: string, names: readonly string[], paths: readonly string[] | undefined) =>
  template.replace(/%([sp])/g, (_, which: string) => (which === 's' ? names.join(', ') : placed(paths)))

function notDoneReasons(deferred: readonly string[],
  goals: { open: readonly string[]; faults: readonly string[] } = { open: [], faults: [] }, where: Where = {}): string[] {
  const reasons: string[] = []
  if (deferred.length > 0) reasons.push(fill(deferred.length === 1 ? ROW_ONE : ROW_MANY, deferred, where.rows))
  if (goals.open.length > 0) reasons.push(fill(GOALS_OPEN, goals.open, where.goals))
  if (goals.faults.length > 0) reasons.push(GOALS_FAULT.replace('%s', goals.faults.join('; ')))
  return reasons
}

// A wait on the operator whose reason blocks nothing: no question for him, so no wait on him.
const OPERATOR_LINE = /^waiting:\s*operator\s*(?:\(urgent\)\s*)?(?:—|–|--|-)\s*blocks:\s*(.*)$/i
// A reason that blocks nothing: empty, `n/a`, `-`, or one whose first word is `nothing` or
// `none` and that names nothing after it: no identifier (`G5`, `#12`, `row 3`), no « than », « but »,
// « except » or « before » — « nothing yet », « none for now ».
const NOTHING_BLOCKED = /^(?:|n\/a|-|(?:nothing|none)\b.*)$/i
const NAMES_SOMETHING = /\bG\d+\b|#\d+|\brow\s+\d+\b|\b(?:than|but|except|before)\b/i

export function blocksNothing(line: string): boolean {
  const matched = OPERATOR_LINE.exec(line)
  if (matched === null) return false
  const reason = (matched[1] ?? '').trim().replace(/\.$/, '').trim()
  return NOTHING_BLOCKED.test(reason) && !NAMES_SOMETHING.test(reason)
}

// --- the launcher's listing (stop_gate.py:187-219) ---------------------------------------

export type Row = { tty: string; title: string; name: string }

// parse_row() ported: `w1/t2 | <tty> | <title> | <name>[ | self][ | hidden]`, the
// launcher's row_for. The title may carry the row's own separator and is rejoined.
function parseRow(line: string): Row | null {
  const parts = line.split(' | ')
  if (parts.length < 4) return null
  while (parts.length > 4 && (parts[parts.length - 1] === 'self' || parts[parts.length - 1] === 'hidden')) parts.pop()
  return { tty: parts[1] ?? '', title: parts.slice(2, -1).join(' | '), name: parts[parts.length - 1] ?? '' }
}

export function listing(out: string): Row[] {
  return out.split('\n').map(parseRow).filter((r): r is Row => r !== null)
}

// activity() ported: `idle`, `busy`, or null when the title carries no host activity
// glyph — a shell left behind by an agent that exited, or a stranger's tab on a
// recycled tty.
const IDLE_GLYPH = '✳'
function activity(title: string): 'idle' | 'busy' | null {
  const glyph = title.split(' ', 1)[0] ?? ''
  if (glyph === IDLE_GLYPH) return 'idle'
  if (glyph.length === 1 && glyph.charCodeAt(0) > 127 && !/\p{L}|\p{N}/u.test(glyph)) return 'busy'
  return null
}

// label() ported: the name it was launched with, unless it is the launcher's own
// parenthesised mark — then the title, else the tty.
function labelOf(row: Row): string {
  return row.name && !row.name.startsWith('(') ? row.name : (row.title || row.tty)
}

// The names of the sessions the listing shows running, each by its label: a tab whose title carries
// no host activity glyph runs none. What a ledger line's agent is matched against (core's pr-ledger.ts).
export function liveNames(rows: readonly Row[]): Set<string> {
  return new Set(rows.filter(row => activity(row.title) !== null).map(labelOf))
}

// The tabs the listing shows running an agent, by their label, each with its tty and whether it is idle: where the module
// closes an agent done with its work. The listing is the machine's: a label may sit on several ttys, each orchestration's
// own (the caller keeps its chain's).
export function tabsOf(rows: readonly Row[]): Map<string, { tty: string; idle: boolean }[]> {
  const tabs = new Map<string, { tty: string; idle: boolean }[]>()
  for (const row of rows) {
    const state = activity(row.title)
    if (state !== null) tabs.set(labelOf(row), [...(tabs.get(labelOf(row)) ?? []), { tty: row.tty, idle: state === 'idle' }])
  }
  return tabs
}

// --- the orchestrator's own agents (stop_gate.py:224-247) --------------------------------

// The host's status of the session a tty runs, from the host's own per-process record
// (`<config dir>/sessions/<pid>.json`, the file the peer listing reads): `busy` for the
// whole of a turn, `idle` between turns. Null when the text is no such record.
export function hostStatusOf(text: string): 'idle' | 'busy' | null {
  try {
    const status = (JSON.parse(text) as { status?: unknown })?.status
    return status === 'idle' || status === 'busy' ? status : null
  } catch {
    return null
  }
}

export type OwnAgent = { label: string; state: 'idle' | 'busy'; tty: string }

// own_agents() ported: the chain entries this session wrote that still run an agent,
// an idle resident agent left out. With no owner known no entry is counted — a recycled
// tty's occupant would be (the chain file outlives the session that wrote it).
export function ownAgents(rows: readonly Row[], entries: readonly ChainEntry[], owner: string,
  hostStatus: ReadonlyMap<string, 'idle' | 'busy'> = new Map()): OwnAgent[] {
  if (!owner) return []
  const byTty = new Map(rows.map(r => [r.tty, r]))
  const agents: OwnAgent[] = []
  for (const entry of entries) {
    if (entry.owner !== owner) continue
    const row = byTty.get(entry.tty)
    // The host's own session status first, the title's glyph only without one: the
    // glyph lags the turn — a freshly spawned agent's tab reads ✳, idle, through its
    // first half-minute of work (measured live).
    const state = row ? (hostStatus.get(entry.tty) ?? activity(row.title)) : null
    // Spawned with --resident and idle: idle by design, no pull request of its own to show.
    if (state === 'idle' && entry.resident === true) continue
    if (state) agents.push({ label: labelOf(row!), state, tty: entry.tty })
  }
  return agents
}

// The owner a chain entry names: the one session that wrote it. Inside tmux every window
// inherits the server's ITERM_SESSION_ID, so it stops naming one session; the pane does:
// `tmux:<socket path>:<pane id>` (the socket is the first field of TMUX). Elsewhere it is
// the part of ITERM_SESSION_ID after its last colon. The launcher states the same rule
// (iterm_agent.py, `tmux_owner`); empty when neither names a session.
export async function chainOwner($: Host<'env'>): Promise<string> {
  const tmux = String((await $.env.get('TMUX')) ?? '')
  const pane = String((await $.env.get('TMUX_PANE')) ?? '')
  if (tmux && pane) return `tmux:${tmux.split(',')[0]}:${pane}`
  const session = String((await $.env.get('ITERM_SESSION_ID')) ?? '')
  return session.includes(':') ? session.slice(session.lastIndexOf(':') + 1) : ''
}

// The chains are read through core's parser; supervision.ts still imports it under this name.
export { parseChain as chainEntries } from '../core/chain-entries.ts'

// --- the pull request of an idle agent (stop_gate.py:250-288) ----------------------------

// pull_request_of() ported over the answers the handler read: the branch's pull
// request, or nothing. One gh read per idle agent in the handler; this decides what the
// answer says.
export function pullRequestOf(branch: string | null, answer: string | null): { number: string; state: string; ready?: boolean; repo?: string } | null {
  if (!branch || !answer) return null
  try {
    const pr: unknown = JSON.parse(answer)
    if (!isObject(pr) || pr['number'] === undefined || pr['state'] === undefined) return null
    // Ready is the label the github ready gate puts at the head (its own test ignores the case); an answer with no labels says nothing of it.
    const labels = pr['labels']
    const ready = Array.isArray(labels) ? labels.some(label => isObject(label) && String(label['name']).toLowerCase() === 'ready') : undefined
    // The repository the address names, to tell this pull request from another of the same number.
    const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(String(pr['url'] ?? ''))?.[1]
    return { number: String(pr['number']), state: String(pr['state']), ...(ready === undefined ? {} : { ready }), ...(repo === undefined ? {} : { repo }) }
  } catch {
    return null
  }
}

// --- the rows of a done or deferred wait ------------------------------------------------

// open_rows() ported over the already-read record files: `<id> (<label>)` for each
// row still open, no matter which record file carries it.
export function openRows(texts: readonly string[]): string[] {
  return rowsWhere(texts, row => row['state'] === 'open')
}

// The open rows the operator deferred (`deferred` carries his ruling): still open, put off.
export function deferredRows(texts: readonly string[]): string[] {
  return rowsWhere(texts, row => row['state'] === 'open' && typeof row['deferred'] === 'string' && row['deferred'].trim() !== '')
}

function rowsWhere(texts: readonly string[], keep: (row: Record<string, unknown>) => boolean): string[] {
  const rows: string[] = []
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const row: unknown = JSON.parse(line)
        if (isObject(row) && keep(row)) {
          rows.push(`${row['id']} (${row['label'] || 'no label'})`)
        }
      } catch { /* a line that is no row: no row */ }
    }
  }
  return rows
}

const dirname = (p: string) => p.split('/').slice(0, -1).join('/') || '/'

// --- the work in flight and the busy wake --------------------------------------------------

// The work the host itself says is in flight for the session, off the stop's own payload:
// `background_tasks` (background shells, monitors, subagents, workflows — running, pending or
// backgrounded) and `session_crons` (scheduled wake-ups), each named by what it runs. Null when
// the payload carries no task list at all — a host that does not say — so the caller can tell
// « nothing runs » from « not told ».
//
// A task the host lists as settled wakes nothing: its type only promises a string status, so
// the terminal ones it uses for its tasks (`completed`, `failed`, `killed`, and `stopped` on a
// task's end notice) are left out. Any other status, or none, still counts. A scheduled wake-up
// carries no status.
const SETTLED_TASK = new Set(['completed', 'failed', 'killed', 'stopped'])

export function hostTasks(tasks: unknown, crons: unknown): string[] | null {
  if (!Array.isArray(tasks)) return null
  const named: string[] = []
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue
    const t = task as { command?: unknown; description?: unknown; type?: unknown; status?: unknown }
    if (typeof t.status === 'string' && SETTLED_TASK.has(t.status)) continue
    const what = [t.command, t.description, t.type].find(v => typeof v === 'string' && v.trim() !== '')
    named.push(typeof what === 'string' ? what.trim() : 'a background task')
  }
  for (const cron of Array.isArray(crons) ? crons : []) {
    if (!cron || typeof cron !== 'object') continue
    const schedule = (cron as { schedule?: unknown }).schedule
    named.push(`a scheduled wake-up${typeof schedule === 'string' && schedule.trim() !== '' ? ` (${schedule.trim()})` : ''}`)
  }
  return named
}

export type Held = { case: string; reason: string }

// The bound of a busy own agent's turn: past it in one turn, the orchestrator is woken
// (busyWake below), and again at each bound after.
export const NOTICE_TTL_MS = 2 * 60 * 60 * 1000

// A busy own agent as its host record reads it: `since` its turn's start (statusUpdatedAt), `key`
// that turn (its session and start). Its fill is left out: measured at a turn's end only, it would
// be the one before this turn.
export type BusyAgent = { label: string; key: string; since: number }

// The line that wakes an orchestrator on an agent busy past the bound in one turn.
export function busyLine(agent: BusyAgent, now: number): string {
  const minutes = Math.floor((now - agent.since) / 60_000)
  return `[module] ${agent.label} busy ${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')} in one turn — read its tree`
}

/*
 * The orchestrator's wake on its busy agents, once per bound each turn: the lines of the agents
 * past a bound not told yet (`told`: the bounds told per turn, updated here, its other turns
 * dropped), and the instant the next bound of those still busy falls, null when none is.
 */
export function busyWake(agents: readonly BusyAgent[], told: Map<string, number>, now: number): { lines: string[]; next: number | null } {
  for (const key of [...told.keys()]) if (!agents.some(agent => agent.key === key)) told.delete(key)
  const lines: string[] = []
  let next: number | null = null
  for (const agent of agents) {
    const bounds = Math.floor((now - agent.since) / NOTICE_TTL_MS)
    if (bounds > (told.get(agent.key) ?? 0)) {
      lines.push(busyLine(agent, now))
      told.set(agent.key, bounds)
    }
    const at = agent.since + ((told.get(agent.key) ?? 0) + 1) * NOTICE_TTL_MS
    next = next === null ? at : Math.min(next, at)
  }
  return { lines, next }
}

// The successor's spawn, as the session ran it through Bash: the launcher's spawn
// with --successor (its script or the python beneath it). Run without error, it is
// the hand-over the turn's end reads (supervision.ts).
export function isSuccessorSpawn(command: string): boolean {
  return /\biterm[-_]agent\.(?:sh|py)\b[^\n]*\bspawn\b[^\n]*(?:^|\s)--successor(?:\s|=|$)/m.test(command)
}

// A declared done or deferred wait, over the facts wait.ts read: the rows still open. None
// open: the declaration is taken.
//
// The spec's goals come next: the goals each goals.md beside a registered record still
// holds open, and the faults that make the file no record of the spec (a goal met with no
// evidence on disk, one ruled out without the operator's words, a row count or a text that
// is not the spec's). goals.py check reads them, the one implementation of the grammar.
//
// Work the operator deferred (`deferredRows` among the open rows, `goalsDeferred` beside the
// open goals) is open and put off by his ruling. The ending `waiting: deferred — <n> items`
// (`ending: 'deferred'`) takes it when nothing else is open, and is refused when nothing is
// deferred; `waiting: done` refuses it, and names the line that fits.
// The taught form counts the deferred items: rows and goals together. The older forms stay
// accepted: `<n> rows` with ` G<m>` for goals, and the ids, each named and none unknown.
const COUNT_ITEMS = /^(\d+)\s+items?$/i
const COUNT_FORM = /^(\d+)\s+rows?(?:\s+G(\d+))?$/i
const TODO_WORD = /^to-?dos?$/i
const ROW_WORD = /^rows?$/i
function idsMismatch(listed: string, rows: readonly string[], goals: readonly string[], todos: readonly string[] = []): string | null {
  const total = rows.length + goals.length + todos.length
  const countWrong = COUNT_WRONG.replace('%s', `${total} items`)
  const items = COUNT_ITEMS.exec(listed.trim())
  if (items) return Number(items[1]) === total ? null : countWrong
  const counted = COUNT_FORM.exec(listed.trim())
  if (counted) {
    if (Number(counted[1]) === rows.length && Number(counted[2] ?? 0) === goals.length && todos.length === 0) return null
    return countWrong
  }
  const wanted = new Map<string, string>()
  for (const row of rows) wanted.set((row.split(' ')[0] ?? '').toUpperCase(), `row ${row.split(' ')[0]}`)
  for (const goal of goals) wanted.set(goal.toUpperCase(), goal)
  for (const todo of todos) wanted.set(`T${todo.split(' ')[0]}`.toUpperCase(), `to-do ${todo.split(' ')[0]}`)
  // A to-do is named « to-do 7 » (as the refusal prints it), « todo 7 », « to-dos 7 » or « T7 »: after a
  // to-do word a bare number is that to-do; a row word gives the bare numbers back to the rows.
  const named: { id: string, said: string }[] = []
  let kind: 'row' | 'todo' = 'row'
  for (const token of listed.split(/[,\s]+/).filter(id => id !== '')) {
    if (TODO_WORD.test(token)) kind = 'todo'
    else if (ROW_WORD.test(token)) kind = 'row'
    else if (kind === 'todo' && /^\d+$/.test(token)) named.push({ id: `T${token}`, said: `to-do ${token}` })
    else named.push({ id: token, said: token })
  }
  const upper = named.map(item => item.id.toUpperCase())
  const missing = [...wanted].filter(([id]) => !upper.includes(id)).map(([, name]) => name)
  const unknown = named.filter(item => !wanted.has(item.id.toUpperCase())).map(item => item.said)
  if (missing.length === 0 && unknown.length === 0) return null
  const said = [missing.length > 0 ? `missing ${missing.join(', ')}` : '', unknown.length > 0 ? `unknown ${unknown.join(', ')}` : '']
  return IDS_WRONG.replace('%s', said.filter(part => part !== '').join('; '))
}

export function checkWakeDone(left: {
  deferred: readonly string[]
  deferredRows?: readonly string[]
  goalsOpen?: readonly string[]
  goalsDeferred?: readonly string[]
  goalsFaults?: readonly string[]
  todos?: readonly string[]
  todosDeferred?: readonly string[]
  rowRecords?: readonly string[]
  goalsRecords?: readonly string[]
  ending?: 'done' | 'deferred'
  ids?: string | undefined
}): Held | null {
  const putOff = left.deferredRows ?? []
  const rows = left.deferred.filter(row => !putOff.includes(row))
  const goals = { open: left.goalsOpen ?? [], faults: left.goalsFaults ?? [] }
  const putOffGoals = left.goalsDeferred ?? []
  const reasons = notDoneReasons(rows, goals, { rows: left.rowRecords, goals: left.goalsRecords })
  const putOffTodos = left.todosDeferred ?? []
  const names = [...putOff.map(row => `row ${row}`), ...putOffGoals, ...putOffTodos.map(todo => `to-do ${todo}`)]
  if ((left.todos ?? []).length > 0) reasons.push(todoOpen(left.todos ?? [], left.ending === 'deferred' ? 'deferred' : 'done'))
  if (left.ending === 'deferred') {
    if (names.length === 0 && reasons.length === 0) return { case: 'nothing-deferred', reason: NOTHING_DEFERRED }
    const wrong = names.length > 0 && left.ids !== undefined ? idsMismatch(left.ids, putOff, putOffGoals, putOffTodos) : null
    if (wrong) reasons.push(wrong)
  } else if (names.length > 0) {
    reasons.push(DEFERRED_STILL.replace('%s', names.join(', ')))
  }
  if (reasons.length === 0) return null
  return { case: 'not-done', reason: reasons.join(' ') }
}

// One goals.md as wait.ts reads it: the path, and goals.py check --json's answer.
export type GoalsReading = {
  path: string
  ok: boolean
  open: readonly string[]
  deferred: readonly string[]
  faults: readonly string[]
  notes: readonly string[]
}

// goals.py check --json's answer, or null when the text is none: a reading wait.ts cannot
// parse is a read that failed, and holds nothing.
export function parseGoalsCheck(path: string, text: string): GoalsReading | null {
  try {
    const a: unknown = JSON.parse(text)
    if (!isObject(a) || typeof a['ok'] !== 'boolean' || !Array.isArray(a['open']) || !Array.isArray(a['faults'])) return null
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
    return {
      path, ok: a['ok'], open: strings(a['open']), deferred: strings(a['deferred']), faults: strings(a['faults']), notes: strings(a['notes']),
    }
  } catch {
    return null
  }
}

// --- whose a record is ----------------------------------------------------------------------

// A dispatch record belongs to one orchestration: dispatch-record.sh writes its name in
// `<record>.owner` at the first write, and a session answers for no other's rows or goals.
// The orchestration is the session's name in the house shape, without its reference, which
// is what a successor keeps; the file will hold the orchestration's id the day it has one.
// The shape is core's: a hand-typed « Orch:x », or the former « Orch : x », is spelled the
// current way first.
const REFERENCE = / \[[^\]\s]+\]$/
export function orchestrationOf(name: string | null | undefined): string | null {
  const bare = (name ?? '').trim().replace(REFERENCE, '').trim().replace(/^(\S+?) ?: */u, '$1: ')
  const parsed = parseSessionName(bare)
  return parsed?.role === 'orchestrator' ? sessionName('Orch', parsed.subject) : null
}

// The owner an owner file names: its first line, as the orchestration when it reads as one,
// null when the file is blank.
export function ownerOf(text: string): string | null {
  const line = (text.split('\n')[0] ?? '').trim()
  return line === '' ? null : orchestrationOf(line) ?? line
}

// A record with no owner is read as it always was; an owned one only by its owner.
export const isOwnRecord = (owner: string | null, own: string | null): boolean => owner === null || owner === own

// The record files that hold an open row the operator has not deferred: the ones a refusal
// about rows names. `texts` runs parallel to `records`.
export function recordsWithOpenRows(records: readonly string[], texts: readonly string[]): string[] {
  return records.filter((_, i) => rowsWhere([texts[i] ?? ''], row =>
    row['state'] === 'open' && !(typeof row['deferred'] === 'string' && row['deferred'].trim() !== '')).length > 0)
}

// The goals.md of each registered record: the file beside it, once per directory.
export function goalsPaths(records: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const record of records) {
    const path = record.trim()
    if (path) seen.add(`${dirname(path)}/goals.md`)
  }
  return [...seen]
}

// The pull request number a log name carries: core's, where ci-watch's log name is defined.
export { watchNumberOf } from '../core/orchestration.ts'
