// hooks/supervision.ts
// The shared store: one row per live session — the figures the gauge measured,
// the name the walk read, the repository of the working directory — written by
// this file's own session.measure handler and removed by its session.end, one
// file per key under the module's state root. The supervision pane below reads
// the same rows, opened when the person types /coordinator-supervision or
// /orchestrator-supervision — never on a start: the operator wants nothing placed
// on screen unasked — and in a coordinator, by the module itself once, at the end
// of its first turn while the coordinator's record names one: his ruling of
// 2026-10-18. In a coordinator session it lists the orchestrators, and under them
// the first question of its round (round.ts); in an orchestrator session,
// that orchestrator's own agents, read from the launcher's chain and the host's
// session records; in any other role it opens nothing. The commands hold no $ of
// the writing side and read the same files through their own $.fs calls plus
// the pure row parser and the urgency sort below.
//
// The engine fences $ to the file that received it — never passed across an
// import — so this file spells its own env resolution, its own log stamp, its
// own origin read and its own transcript-window reader, while the figures
// cross as a plain import (currentReading, no $ argument) and the name runs
// over the walk's pure core with readers built here.
import { currentReading } from './gauge.ts'
import { tripGate } from './gauge-core.ts'
import {
  roleOf, walkName, hostBasenames, hostRecordOf, blockArgv, bytesOfBase64,
  type ReadRecord, type HostNames,
} from './session-name.ts'
import { withDeadline, isDegradedPass, chainEntries, watchNumberOf } from './stop-gate.ts'
import { typedByOperator } from './models-guard.ts'
import { logArgv, moduleDirOf, LOG_TIMEOUT_MS } from './module-log.ts'
import { commandsDirOf, isBare, isOwnCopy } from './short-names.ts'
import {
  parseWait, parseStatus, handsOver, waitPatch, clearedWait, fingerprint, relayText, heldQuestion, withdrawalText, gateText, noStatusText, NO_STATUS_KEY, coordinatorOf, chainOwnerTty, waitLabel, waitParts,
  type WaitKind,
} from './relay.ts'
import { entryFingerprint, roundEntry, roundEntryId, roundPath, paneQuestions, entryQuestions, plainText, textSpans, prPieces, repositoryOwners, numberLabel, questionBody, questionShape, isDue, dueText, asksNothing, carriesChoices, type RoundAnswer, type RoundChoice, type RoundEntry } from './round.ts'
import {
  remoteRowOf, rowIsNews, rowSent, parseRowSent, rowText, deliveryOf, isPeerOrigin, isMarked, parseRemoteRow,
  remoteKey, withRemote, isRemoteStale, learntOf, parseLearnt, machineLabel, prsInFlight, ROW_MARKER, REMOTE_STALE_AFTER_MS, type RemoteRow,
} from './remote-row.ts'
import { deckOf, deckText, deckIsNews, DECK_FILE, type Deck } from './deck.ts'

// One row per live session, the store's whole schema. `pid` is the session's host
// process — the row lives while it does.
export type SessionRow = {
  role: 'orchestrator' | 'agent' | 'auditor' | 'coordinator' | null
  name: string | null
  pid?: string | null
  // The session's tty, the walk's: an agent's orchestrator is the chain naming it.
  tty?: string | null
  repo: string | null
  context_percent: number
  context_tokens: number
  window: number
  model: string
  busy: boolean
  updated_at: string
  // An orchestrator's last turn ended on its machine line (relay.ts): waiting on the
  // operator, with what it blocks, or done — an agent's, on its status line; since when;
  // and the fingerprint of the last one reported up, so none is reported twice. Never
  // in the row's own file: they live in the session's wait file (WaitRecord), which the
  // relay alone writes, and a read merges them in (withWait).
  waiting?: WaitKind | null
  blocks?: string | null
  waiting_since?: string | null
  relayed?: string | null
  // A row received from an orchestrator on another machine (remote-row.ts): its machine.
  machine?: string | null
}

// A row lives while its session's host process does: a session idle for hours —
// waiting on a long agent phase, on a CI watch — is still there, and one that
// ended without its end event (a crash, a kill) is gone the moment its pid is.
// A row written before rows carried a pid falls back to the old rule: no
// measure for an hour, no row.
export const STALE_AFTER_MS = 60 * 60 * 1000

// The rule above as a function, pure and exported: the commands read the same
// store through their own $ (the fence forbids sharing the reader) and judge
// every row by this same rule. `alive` is the set of live pids the caller read
// (livePidsArgv, livePids); null when that read failed, and a read that failed
// knows nothing of any pid: the row is kept, never judged dead on no evidence.
export function isStale(row: SessionRow, now: number, alive: ReadonlySet<string> | null = new Set()): boolean {
  if (row.pid) return alive !== null && !alive.has(String(row.pid))
  const at = Date.parse(row.updated_at)
  return !Number.isFinite(at) || now - at > STALE_AFTER_MS
}

// One ps listing every live pid on the machine, run when a row names a pid at
// all; the caller intersects. Never `ps -p <the rows' pids>`: its exit and its
// output depend on the pids asked — one it refuses (macOS: « process id too
// large ») fails the whole call with nothing printed — so a single bad row
// made every live row read as dead, and the store reader removed them all.
export function livePidsArgv(pids: readonly string[]): string[] | null {
  return pids.some(pid => /^\d+$/.test(pid)) ? ['ps', '-A', '-o', 'pid='] : null
}

// The live pids out of that ps's result, or null when the read failed: no
// result (it rejected, it timed out), a degraded pass, a non-zero exit, or a
// listing with no pid in it — ps lists itself, so an honest one is never empty.
// Null is « unknown », never « none alive »: a caller deletes nothing on it.
export function livePids(result: unknown): Set<string> | null {
  if (typeof result !== 'object' || result === null) return null
  const { exitCode, stdout } = result as { exitCode?: unknown; stdout?: unknown }
  if (exitCode !== 0) return null
  const pids = new Set(String(stdout ?? '').split('\n').map(line => line.trim()).filter(pid => /^\d+$/.test(pid)))
  return pids.size === 0 ? null : pids
}

// The supervision pane: the id names it at the engine (the open, the render's
// requestId), the title its tab while more than one pane is open — what it
// lists, by the role it was opened in. The id's spelling is the shipped type's
// own contract — letters, digits, `_` and `-`.
const PANE_ID = 'supervision'
const PANE_TITLES = { coordinator: 'Orchestrators', orchestrator: 'Agents' } as const

// The commands that toggle the pane, as the host hands them to command.run (short-names.ts):
// the 0.80.0 forms of both roles' short names, the plugin's `supervision` file, and the bare
// short names of the installer's user commands (`coordinator-supervision` is also its file).
export const SUPERVISION_COMMANDS = [
  'orchestrator:orchestrator-supervision', 'orchestrator:coordinator-supervision', 'orchestrator:supervision',
  'orchestrator-supervision', 'coordinator-supervision',
] as const

// The tool that opens or closes the same pane on the operator's plain words, called by the
// session's main thread; a subagent is refused it, as it is the rename.
export const SUPERVISION_TOOL = 'supervision'
export const PANE_MAIN_THREAD_ONLY = "only the session's main thread opens or closes the supervision pane"
const PANE_ROLES_ONLY = 'The supervision pane opens in a coordinator session (« Coord : … ») or an orchestrator session (« Orch : … ») alone.'

// The sort's one law: a row past the rotation gate outranks every row below
// it, however full each side is; within a side, the fill descends. The floor
// is any number no honest fill reaches, added to the fill so the order stays
// one comparison.
const GATE_URGENCY_FLOOR = 1000

// The pane opened once in this session, by the module or by the command: kept by the host in
// $.state (types/index.d.ts), so a reload of the module does not open it again.
const PANE_OPENED = { plugin: 'orchestrator', key: 'paneOpened' } as const

// How often a coordinator's session reads its round for questions just due, urgent or with
// the pane closed meanwhile, rather than at the operator's next word. A one-shot clock, armed
// again by each reading.
const ROUND_WAKE_MS = 30000

// How often an open pane redraws on its own. A render is raised by a measure of
// this session, and a supervisor mostly waits: without a clock its rows — the
// others' fills, their ages — froze at its own last turn.
const PANE_REFRESH_MS = 20000

// How often an open coordinator's pane looks at its round. The host offers no watch on a
// file: the clock stats the round's directory, whose mtime every write moves (the module, the
// script's round-close and the senders' sessions all rename a file into it), and redraws only
// when it moved, so a question settled elsewhere leaves the pane within this delay for one
// stat a tick.
const PANE_ROUND_POLL_MS = 2000

// The pane's last option under a question's choices where the surface draws no text field
// (mobile): no state changes, the operator types his answer in a tab. Its hotkey is no
// choice's letter (A to E).
const OTHER_KEY = 'other'
const OTHER_HOTKEY = 'o'

// The words the coordinator's pane draws, in one table: the operator reads them at a glance, so
// each says one thing and says it the same way wherever it is drawn. Where the surface draws a
// text field, the last option is that field (`other`): its text answers the entry.
const WORDS = {
  questions: 'Questions for you',
  pending: 'pending',
  none: 'none',
  orchestrators: 'Orchestrators',
  noOrchestrator: 'no live orchestrator',
  status: 'Status',
  blocks: 'Blocks',
  other: 'Other answer',
  otherBelow: 'Other answer: type it below',
  otherInSession: 'Other answer: in the session',
  otherPlaceholder: 'type another answer',
  send: 'send',
  choose: 'Choose',
  recommended: 'recommended',
  choices: 'Choices',
  next: 'next',
  notDelivered: 'not delivered',
} as const
const OTHER_LABEL = WORDS.other

// The question card's geometry, in cells, counted as drawn (the row count follows it): the border
// on each side, the padding inside it, the indent of a field's value under its label, and the
// column of a choice's letter badge, its text hanging after it.
const CARD_BORDER = 1
const CARD_PADDING_X = 2
const CARD_PADDING_TOP = 1
const FIELD_INDENT = 2
const BADGE_COLUMN = 5

// The mark of the recommended choice and of the recommendation's line.
const STAR = '★'

// The colour of inline code in a question's text, its backticks dropped.
const CODE_COLOR = 'background'

// The rule's length where the pane's width is not told: one row, cut at the pane's edge.
const RULE_FALLBACK = 40

// How long after a question's first draw its picker is brought into view: the scroll names the
// picker by its key, which the engine knows only once the draw has landed.
const SCROLL_AFTER_DRAW_MS = 150

// The picker's own last option where the surface draws one: picking it moves the ring to the
// text field, so the arrows reach the free answer as they reach a choice. No letter is A to E.
const OTHER_VALUE = 'other'

// The address of an entry's text field, which the ring is sent to and watched leaving.
const answerKey = (id: string) => `answer:${id}`

// The width of the label column a wait's lines sit in (« Status », « Blocks »): the longer
// label and a gap, so what a long blocks text wraps under is its own first character.
const WAIT_LABEL_COLUMN = 8

// The columns the scroll track takes on the pane's right edge, the track and a gap; the content
// keeps clear of them. Drawn only once the body is known to scroll.
const TRACK_COLUMNS = 2

// The cells of the track drawn on the body's right edge over a tree taller than its window: one
// per window row, true where the thumb is, its length the window's share of the tree and its
// place the window's. Null when the tree fits.
export function scrollTrack(offset: number, bodyRows: number, contentRows: number): boolean[] | null {
  if (bodyRows < 1 || contentRows <= bodyRows) return null
  const thumb = Math.max(1, Math.round((bodyRows * bodyRows) / contentRows))
  const travel = Math.min(1, Math.max(0, offset / (contentRows - bodyRows)))
  const start = Math.round(travel * (bodyRows - thumb))
  return Array.from({ length: bodyRows }, (_, row) => row >= start && row < start + thumb)
}

// A line cut into rows of at most `width` cells at its spaces, a word longer than a row cut
// where the row ends: the key line pinned to the window's bottom takes as many rows as this
// gives, so it is drawn whole over the rows it covers.
export function wrapWords(text: string, width: number): string[] {
  const rows: string[] = []
  let row = ''
  for (let word of text.split(' ')) {
    while (word.length > width) {
      if (row !== '') rows.push(row)
      rows.push(word.slice(0, width))
      word = word.slice(width)
      row = ''
    }
    if (row === '') row = word
    else if (row.length + 1 + word.length <= width) row = `${row} ${word}`
    else {
      rows.push(row)
      row = word
    }
  }
  if (row !== '' || rows.length === 0) rows.push(row)
  return rows
}

// The config dir, this file's own resolution: $ never crosses an import, so
// each domain that needs it spells the same two env reads itself.
async function configDir($: any): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
}

// The scripts' state root (the launcher's chains, the coordinator's record): the
// override first, else the config dir's claude-orchestrator.
async function stateDir($: any): Promise<string> {
  return (await $.env.get('ORCHESTRATOR_STATE_DIR')) ?? `${await configDir($)}/claude-orchestrator`
}

// The store's root under the module's own directory (module-log.ts, moduleDirOf): one file per key.
async function storeOf($: any): Promise<string> {
  return `${moduleDirOf(await configDir($), await $.env.get('ORCHESTRATOR_MODULE_DIR'))}/store`
}

// The key is the session's own: one file per session id, so two sessions
// writing at once write two files and neither merge can lose the other's row.
// The id is sanitised the way the stop gate sanitises its own paths — the key
// names a file, and an id is host-generated but never trusted as a path.
export function sessionKey(id: string): string {
  return `sessions/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

// The row parser, the measure-file doctrine: $.fs.write is not atomic, so a
// line caught mid-write is data that parses to nothing; a row without a stamp
// is no row either — staleness cannot be judged of it, and what the end
// handler truncates must not outlive its session as a phantom.
export function parseSessionRow(text: string): SessionRow | null {
  try {
    const row = JSON.parse(text) as SessionRow
    if (!row || typeof row !== 'object' || typeof row.updated_at !== 'string') return null
    return row
  } catch {
    return null
  }
}

// The session's wait, in its own file beside its row (`waits/<id>`): the relay is its
// one writer, so the measure's read-merge-write of the row can never put an older wait
// back over a newer one — a lost wait was the very defect the relay ends. The name and
// the pid ride along for the coordinator's facts, which read this file alone.
export type WaitRecord = Pick<SessionRow, 'waiting' | 'blocks' | 'waiting_since' | 'relayed'> & { name: string | null; pid: string | null; last_waiting?: WaitKind | null; typed?: { blocks: string; since: string | null } | null }

export function waitKey(id: string): string {
  return `waits/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

// An agent's gate crossing reported (`gates/<id>`, « reported » or empty): the measure
// handler is its one writer, so it never races the relay's wait file.
export function gateKey(id: string): string {
  return `gates/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

// What an orchestrator last sent its coordinator of its row (`rows/<id>`, remote-row.ts):
// the send path is its one writer.
export function rowKey(id: string): string {
  return `rows/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

export function parseWaitRecord(text: string): WaitRecord | null {
  try {
    const record = JSON.parse(text) as WaitRecord
    return record && typeof record === 'object' ? record : null
  } catch {
    return null
  }
}

// A row as the readers show it: the wait file's fields over the row's.
export function withWait(row: SessionRow, waitText: string): SessionRow {
  const wait = parseWaitRecord(waitText)
  if (!wait) return row
  // A cleared wait keeps its blocks and start for the next same wait; readers see none.
  const on = wait.waiting === 'operator' || wait.waiting === 'done'
  return { ...row, waiting: on ? wait.waiting : null, blocks: on ? wait.blocks ?? null : null, waiting_since: on ? wait.waiting_since ?? null : null, relayed: wait.relayed ?? null }
}

async function readWait($: any, id: string): Promise<WaitRecord | null> {
  return parseWaitRecord(String(await $.fs.read(`${await storeOf($)}/${waitKey(id)}`).catch(() => '')))
}

// Written atomically: a temporary file beside it, then one rename — $.fs.write is not
// atomic, and a wait caught mid-write would read as none.
async function writeWait($: any, id: string, record: WaitRecord): Promise<void> {
  await writeAtomic($, `${await storeOf($)}/${waitKey(id)}`, JSON.stringify(record) + '\n')
}

async function writeAtomic($: any, path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await $.fs.write(tmp, text)
  const moved = await $.process.run(['mv', '-f', tmp, path], { timeoutMs: 5000 })
  if (!moved || moved.exitCode !== 0) {
    await $.process.run(['rm', '-f', tmp], { timeoutMs: 5000 }).catch(() => undefined)
    throw new Error(`the file ${path} could not be renamed into place`)
  }
}

// writeSession reads the key's file, merges the patch over what it finds and
// writes it back stamped: per-key writes do not collide across sessions, and
// the stamp the row is judged stale by is the write's own unless the patch
// carries one (the measure handler passes the reading's own time). The
// measure handler is the only writer of a key: a same-key race is last-writer-wins,
// at most one measure of freshness. The relay writes its own file (writeWait).
export async function writeSession($: any, id: string, patch: Partial<SessionRow>): Promise<void> {
  const path = `${await storeOf($)}/${sessionKey(id)}`
  const base: SessionRow = parseSessionRow(String(await $.fs.read(path).catch(() => ''))) ?? {
    role: null, name: null, repo: null,
    context_percent: 0, context_tokens: 0, window: 0,
    model: '', busy: false, updated_at: '',
  }
  const row: SessionRow = { ...base, ...patch, updated_at: patch.updated_at ?? new Date().toISOString() }
  await $.fs.write(path, JSON.stringify(row) + '\n')
}

// One row per live session: every file under the store's sessions directory,
// minus the dead (isStale) and the unreadable (a line caught mid-write). The
// files of the dead and the empty ones are removed as they are met — $.fs has
// no remove, rm does — so the store does not grow with every session the
// machine ever ran.
export async function readSessions($: any): Promise<Record<string, SessionRow>> {
  const dir = `${await storeOf($)}/sessions`
  let entries: { name: string; kind: string }[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return {}   // no store yet: nothing was ever written
  }
  const read: [string, string, SessionRow | null][] = []
  for (const entry of entries) {
    if (!entry || entry.kind !== 'file') continue
    const text = String(await $.fs.read(`${dir}/${entry.name}`).catch(() => ''))
    const row = parseSessionRow(text)
    const waits = `${await storeOf($)}/waits/${entry.name}`
    read.push([entry.name, text, row && withWait(row, String(await $.fs.read(waits).catch(() => '')))])
  }
  const argv = livePidsArgv(read.map(([, , row]) => String(row?.pid ?? '')))
  const alive = argv ? livePids(await $.process.run(argv, { timeoutMs: 5000 }).catch(() => null)) : new Set<string>()
  const rows: Record<string, SessionRow> = {}
  const dead: string[] = []
  const now = Date.now()
  for (const [name, text, row] of read) {
    if (row && !isStale(row, now, alive)) rows[`sessions/${name}`] = row
    else if (text === '' || row) dead.push(`${dir}/${name}`, `${await storeOf($)}/waits/${name}`, `${await storeOf($)}/gates/${name}`, `${await storeOf($)}/rows/${name}`)
  }
  // A liveness read that failed removes nothing: its rows are drawn as alive
  // and the next read that answers sweeps the dead. Removing on it wiped the
  // whole store at every render the pane drew.
  if (alive !== null && dead.length > 0) await $.process.run(['rm', '-f', ...dead], { timeoutMs: 5000 }).catch(() => undefined)
  return rows
}

// The session's own row goes with it: removed, or — rm failing — truncated to
// empty, which the row parser reads as no row and the next read removes.
export async function deleteSession($: any, id: string): Promise<void> {
  const path = `${await storeOf($)}/${sessionKey(id)}`
  const store = await storeOf($)
  const done = await $.process.run(['rm', '-f', path, `${store}/${waitKey(id)}`, `${store}/${gateKey(id)}`, `${store}/${rowKey(id)}`], { timeoutMs: 5000 }).catch(() => null)
  if (!done || done.exitCode !== 0) await $.fs.write(path, '')
}

// The reading's age, the pane row's last element: how long ago the row's own
// measure stamped it. A stamp that parses to nothing names no age; a live
// session idle for hours reads in hours, the largest bucket.
function ageLabel(updated_at: string, now: number): string | null {
  const at = Date.parse(updated_at)
  if (!Number.isFinite(at)) return null
  const minutes = Math.floor((now - at) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

export type PaneRow = {
  label: string
  urgency: number
  // The store key of the row's session, what a round entry's session is matched to.
  key: string
  // The label's pieces, for the block the coordinator's pane draws: the name, what comes
  // before the fill, the fill with its gate words, the age and the wait, the wait split into
  // its status words and what it blocks.
  name: string
  head: string
  fill: string
  // The fill alone, « 42% »: the figure the commands' tables align.
  percent: string
  past: boolean
  age: string | null
  wait: string | null
  status: string | null
  blocked: string | null
  waiting: WaitKind | null
}
// The pane's rows, the store read end to end and sorted by rotation urgency:
// the sessions past the gate first (they are the rotation's next moves), then
// the rest, each side by fill descending. The label carries what the design
// names — the name, the role, the fill against the gate, the reading's age —
// with the gate the gauge's own double gate, so a session past it by tokens
// alone on a wide window is marked past it here too.
export function paneRows(rows: Record<string, SessionRow>): PaneRow[] {
  const now = Date.now()
  return Object.entries(rows)
    .map(([key, row]) => {
      const past = tripGate(row.context_percent, row.context_tokens, row.window).tripped
      const name = row.name ?? 'unnamed'
      const head = [row.role ?? 'no role', ...(row.machine ? [`remote ${row.machine}`] : [])].join(' · ')
      const percent = `${row.context_percent}%`
      const fill = `${percent}${past ? ' past the gate' : ''}`
      const age = ageLabel(row.updated_at, now)
      const wait = waitLabel(row)
      const split = waitParts(row)
      const parts = [name, head, fill]
      if (age !== null) parts.push(age)
      if (wait !== null) parts.push(wait)
      return {
        label: parts.join(' · '), urgency: (past ? GATE_URGENCY_FLOOR : 0) + row.context_percent,
        key, name, head, fill, percent, past, age, wait, status: split?.status ?? null, blocked: split?.blocks ?? null,
        waiting: wait !== null ? row.waiting ?? null : null,
      }
    })
    .sort((a, b) => b.urgency - a.urgency)
}

// The round's first open question as a coordinator's pane draws it, above the orchestrator
// rows: a header naming its sender and the sender's own numbering (« Orch : x — Question 5 of
// 6 »; the name alone when the sender gave none: the pane adds no numbering of its own, the
// section's title counts the questions), then one line per lettered choice, the recommended one
// marked and drawn bold. A question without lettered choices is its header alone: the pane draws
// its text and the « other answer » option under it. A done proposal is no question. Nothing
// open: no line.
export type RoundLine = { letter: string | null; text: string; bold: boolean }
export function roundLines(entries: readonly RoundEntry[]): RoundLine[] {
  const questions = paneQuestions(entries)
  if (questions.length === 0) return []
  const first = questions[0]
  const number = questionShape(first.question, first.choices)?.number ?? null
  const header = { letter: null, text: number === null ? first.from : `${first.from} — ${number}`, bold: false }
  if (first.choices.length === 0) return [header]
  return [header, ...first.choices.map(choice => {
    const recommended = choice.letter === first.recommendation
    return { letter: choice.letter, text: `${choice.text}${recommended ? '  (recommended)' : ''}`, bold: recommended }
  })]
}

// One agent of this orchestrator as the pane reads it: the host's own record of
// the session on the agent's tty — its name, its status — and the store's row
// of that session for the figures, null while no measure has written one.
export type AgentView = { name: string | null; status: 'idle' | 'busy' | null; row: SessionRow | null }

// The orchestrator's pane rows: its agents under the store rows' own law — past
// the gate first, then the fill descending, an unmeasured agent last. The label
// carries the name, the status, the fill against the gate and the reading's age.
export function agentPaneRows(agents: readonly AgentView[]): { label: string; name: string; rest: string; urgency: number }[] {
  const now = Date.now()
  return agents
    .map(agent => {
      const name = agent.name ?? agent.row?.name ?? 'unnamed'
      // The label cut in two, the name the pane draws bold and what follows it.
      const row = (parts: string[], urgency: number) => ({ label: [name, ...parts].join(' · '), name, rest: ` · ${parts.join(' · ')}`, urgency })
      const parts = [agent.status ?? 'status unknown']
      if (!agent.row) return row([...parts, 'not measured yet'], -1)
      const past = tripGate(agent.row.context_percent, agent.row.context_tokens, agent.row.window).tripped
      parts.push(`${agent.row.context_percent}%${past ? ' past the gate' : ''}`)
      const age = ageLabel(agent.row.updated_at, now)
      if (age !== null) parts.push(age)
      return row(parts, (past ? GATE_URGENCY_FLOOR : 0) + agent.row.context_percent)
    })
    .sort((a, b) => b.urgency - a.urgency)
}

// The agents of the orchestrator on `tty`: the launcher's chain entries its own
// tab wrote (the owner is the terminal session's id, the stop gate's rule — no
// owner, no entry counted: a recycled tty's occupant would be), each read
// through the process on the agent's tty to the host's record of it, and that
// session's store row. An entry no live session answers for is an agent gone.
async function agentViews($: any, tty: string): Promise<AgentView[]> {
  const config = await configDir($)
  const state = await stateDir($)
  const terminal = String((await $.env.get('ITERM_SESSION_ID')) ?? '')
  const owner = terminal.includes(':') ? terminal.slice(terminal.lastIndexOf(':') + 1) : ''
  if (!owner) return []
  const chain = String(await $.fs.read(`${state}/chains/${tty.split('/').pop()}.jsonl`).catch(() => ''))
  const views: AgentView[] = []
  for (const entry of chainEntries(chain)) {
    if (entry.owner !== owner) continue
    const ps = await $.process.run(['ps', '-t', entry.tty.replace(/^\/dev\//, ''), '-o', 'pid='])
    if (ps.exitCode !== 0) continue
    for (const pid of String(ps.stdout ?? '').split('\n').map((line: string) => line.trim().split(/\s+/)[0] ?? '').filter((pid: string) => /^\d+$/.test(pid))) {
      const record = hostRecordOf(String(await $.fs.read(`${config}/sessions/${pid}.json`).catch(() => '')))
      if (!record || !record.sessionId) continue
      const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(record.sessionId)}`).catch(() => '')))
      // The host's record says the agent lives: its row is shown whatever its age.
      views.push({ name: record.name, status: record.status, row })
      break
    }
  }
  return views
}

// The bound on this file's side reads — the name walk, the origin read — the
// guards' own deadline convention inherited at the Task 9 review's word: well
// inside the ten seconds a handler owns, so a read that cannot answer in time
// is quietly no name (no repository), never a late row or a held measure. The
// operator's env knob turns it, milliseconds like its name says.
async function sideReadBoundMs($: any): Promise<number> {
  const raw = await $.env.get('ORCHESTRATOR_SIDE_READ_MS')
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 2000
}

// The session's name under the side-read bound, this file's own walk over its
// own readers (the per-file convention the fence leaves no way around), its tty
// kept — the pane of an orchestrator reads its agents from the chain its own tty
// names — and its host pid, the row's life. Every read carries the bound as its
// timeout, so a walk that loses the race stops with it instead of running on
// behind the next one; `known` false then, and the row keeps the name it had.
async function walkWithinBound($: any, sessionId: string):
Promise<{ tty: string | null; name: string | null; pid: string | null; known: boolean }> {
  const bound = await sideReadBoundMs($)
  const until = Date.now() + bound
  const left = () => Math.max(1, until - Date.now())
  const config = await configDir($)
  const readRecord: ReadRecord = async (pid: string) => {
    try {
      return String(await $.fs.read(`${config}/sessions/${pid}.json`))
    } catch {
      return null
    }
  }
  const hostNames: HostNames = async () => {
    const host = (await $.env.get('ORCHESTRATOR_HOST_CLI')) ?? 'claude'
    let resolved: string | null = null
    try {
      const found = await $.process.run(['sh', '-c', 'command -v -- "$1"', 'sh', host], { timeoutMs: left() })
      const path = found.exitCode === 0 ? String(found.stdout ?? '').trim() : ''
      if (path.startsWith('/')) resolved = (await $.fs.stat(path, { resolve: true })).realPath ?? path
    } catch { /* unresolved: the spelled name alone */ }
    return hostBasenames(host, resolved)
  }
  const walked = await withDeadline(walkName(
    (argv: readonly string[]) => $.process.run(argv, { timeoutMs: left() }),
    async (path: string) => (await $.fs.stat(path)).size,
    (path: string, index: number) => readBlock($, path, index, left()),
    await transcriptPathOf($, sessionId),
    readRecord,
    hostNames,
    sessionId,
  ), bound)
  return isDegradedPass(walked) ? { tty: null, name: null, pid: null, known: false } : walked
}

// The pane as the module remembers it: what it was opened to list, and its clock, started by
// the open and cancelled by any close. A coordinator's pane also keeps the questions whose
// « other answer » was pressed (their ids: the hint is drawn under them), the answers chosen
// in it that were not delivered, said on their question until its sender is gone or the entry
// no longer holds that answer, the entries whose answer is in flight, so a second press on one
// does nothing, and the entry whose « Other answer » was picked, its text field drawn until the
// ring leaves it.
export type PaneMemory = {
  opened: { role: 'coordinator' | 'orchestrator'; tty: string | null } | null
  ticker: { cancel(): void } | null
  other: Set<string>
  writing: string | null
  undelivered: Map<string, { entry: RoundEntry; reason: string }>
  answering: Set<string>
  // The answers already given to the first questions of an entry that asks several, by entry
  // id, each with its question's number: the entry is answered, and its sender told, once its
  // last question is. Module memory: a reload asks them again from the first.
  partial?: Map<string, string[]>
  // The content last drawn, as the module counts its rows, and the tree's height as the
  // person's last move measured it, with the content it measured.
  drawn?: string
  // The clock's ticks since the pane was last drawn, and the round directory's mtime that draw
  // read: the clock redraws when the first reaches PANE_REFRESH_MS or the second moves.
  ticksSinceDraw?: number
  roundSeen?: number | null
  measure?: { contentRows: number; drawn: string }
}

// The pane opened, by the command or by the module: the role it lists, its title, its clock,
// and, for a coordinator's, its record.
async function openPane($: any, pane: PaneMemory, role: 'coordinator' | 'orchestrator', tty: string | null, pid: string | null): Promise<{ isPlaced?: boolean; reason?: string } | undefined> {
  pane.opened = { role, tty }
  // With the keys, so the picker answers at once: the host grants them only over an empty
  // prompt, never taking text the operator is typing.
  const placed = await $.ui.open({ id: PANE_ID, title: PANE_TITLES[role], focus: true })
  // No round read yet: an absent round is no move, and a draw that throws before reading it
  // leaves nothing that moves at every tick.
  pane.roundSeen = null
  pane.ticker?.cancel()
  pane.ticker = $.clock.every(PANE_ROUND_POLL_MS, () => paneTick($, pane))
  if (role === 'coordinator') await recordPaneOpen($, pid).catch((err: unknown) => logLine($, `pane: ${(err as Error).message}`))
  return placed
}

// One tick of the pane's clock: a pane never drawn, or drawn PANE_REFRESH_MS ago, is redrawn;
// a coordinator's is also redrawn when its round's directory moved since the last draw, the move
// recorded at once, so a draw that fails is retried once per move, never at every tick.
function paneTick($: any, pane: PaneMemory): void {
  if (pane.ticksSinceDraw === undefined || ++pane.ticksSinceDraw * PANE_ROUND_POLL_MS >= PANE_REFRESH_MS) {
    $.ui.invalidate('ui.render')
    return
  }
  if (pane.opened?.role !== 'coordinator') return
  roundMtime($).then(mtime => {
    if (mtime === pane.roundSeen) return
    pane.roundSeen = mtime
    $.ui.invalidate('ui.render')
  })
}

// The round directory's mtime, or null when it cannot be read (never written, or gone).
async function roundMtime($: any): Promise<number | null> {
  try {
    const stat = await $.fs.stat(`${await stateDir($)}/round`)
    return typeof stat?.mtimeMs === 'number' ? stat.mtimeMs : null
  } catch {
    return null
  }
}

// The pane open at the host, and its close by the command or the tool: the clock stops and a
// coordinator's record goes with it.
async function paneShown($: any): Promise<boolean> {
  const panes: readonly { id: string }[] = await $.ui.panes()
  return panes.some(open => open.id === PANE_ID)
}

async function closeShown($: any, pane: PaneMemory): Promise<void> {
  pane.ticker?.cancel()
  pane.ticker = null
  await $.ui.close({ id: PANE_ID })
  await recordPaneClosed($).catch((err: unknown) => logLine($, `pane: ${(err as Error).message}`))
}

// The coordinator's pane as `coordinator.sh round` reads it, `<state>/pane.json`: the session
// whose pane is open and its host pid, the script holding the pane open while that pid lives.
// Without it every question is due in the tab at once, there being no pane to answer it in.
export type PaneRecord = { session: string; pid: string; at: string }

async function panePath($: any): Promise<string> {
  return `${await stateDir($)}/pane.json`
}

// A pane whose pid is unknown is not recorded: a record naming none is no pane to the script.
async function recordPaneOpen($: any, pid: string | null): Promise<void> {
  if (!pid) {
    await logLine($, 'pane: no host pid read for this session; the pane is not recorded open')
    return
  }
  const record: PaneRecord = { session: await $.session.id(), pid, at: new Date().toISOString() }
  await writeAtomic($, await panePath($), JSON.stringify(record) + '\n')
}

// The record of this session's pane, when it is this session's: another coordinator's is left.
async function readPaneRecord($: any): Promise<PaneRecord | null> {
  try {
    const record = JSON.parse(String(await $.fs.read(await panePath($)))) as PaneRecord
    return record && typeof record === 'object' && record.session === await $.session.id() ? record : null
  } catch {
    return null
  }
}

async function recordPaneClosed($: any): Promise<void> {
  if (!(await readPaneRecord($))) return
  const done = await $.process.run(['rm', '-f', await panePath($)], { timeoutMs: 5000 }).catch(() => null)
  if (!done || done.exitCode !== 0) await logLine($, `pane: the record ${await panePath($)} could not be removed`)
}

// The coordinator's pane as `coordinator.sh round` judges it (its pane_open): a record naming a
// pid that runs, whichever session wrote it. A record absent, unreadable or naming no pid is no
// pane, and so is one whose pid the machine's listing does not hold, or a listing that failed,
// as the script's own ps failing is.
async function paneIsOpen($: any): Promise<boolean> {
  let pid: string
  try {
    pid = String((JSON.parse(String(await $.fs.read(await panePath($)))) as { pid?: unknown })?.pid ?? '')
  } catch {
    return false
  }
  if (!/^\d+$/.test(pid)) return false
  const alive = livePids(await $.process.run(['ps', '-A', '-o', 'pid='], { timeoutMs: 5000 }).catch(() => null))
  return alive?.has(pid) ?? false
}

// The entries the coordinator was woken for, `<state>/round-woken.json`, a JSON list of ids: in
// the state directory, not the host's state of one session, so that neither a reload of the
// module nor a successor coordinator wakes twice for one entry. A file absent or unreadable is
// none woken for.
async function wokenPath($: any): Promise<string> {
  return `${await stateDir($)}/round-woken.json`
}

async function readWoken($: any): Promise<string[]> {
  return readIds($, await wokenPath($))
}

async function readIds($: any, path: string): Promise<string[]> {
  try {
    const ids: unknown = JSON.parse(String(await $.fs.read(path)))
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

// An entry the coordinator was shown: one its `coordinator.sh round` printed open
// (`<state>/round-listed.json`, the script's own record) or one the module woke it for. Read by
// the files, never by its model's memory: a question it presented and then saw settled
// elsewhere was asked a second time (the operator's report of 2026-10-25).
async function shownToCoordinator($: any, id: string): Promise<boolean> {
  return (await readWoken($)).includes(id) || (await readIds($, `${await stateDir($)}/round-listed.json`)).includes(id)
}

// The reason an entry withdrawn by the operator's prompt in its sender's own tab records.
const TAB_ANSWER = "answered in the sender's own tab"

// An entry settled in the pane or at its sender's turn end, closed by the module itself when the
// coordinator on this machine was shown it: the answer it was closed with.
export type Settled = { entry: RoundEntry; answer: RoundAnswer }

// The notice that an entry the coordinator was shown is settled and already closed: where and
// how, worded by the answer it was closed with. One line, no command to run, no operator text.
export function settledText(entry: RoundEntry, answer: RoundAnswer): string {
  const reason = answer.text.replace(/^withdrawn: /, '')
  const [where, how] = answer.by === 'pane' ? ['in the pane', `answered at ${answer.at}`]
    : answer.by === 'tab' || reason === TAB_ANSWER ? [`in ${entry.from}'s tab`, 'answered there']
    : reason.startsWith('superseded by ') ? ['superseded', `by ${reason.slice('superseded by '.length)}, present that one`]
    : reason === "the sender's session ended" ? ['', 'session ended']
    : ['', reason.replace(/\s*\n\s*/g, ' ').trim() || 'withdrawn by its sender']
  return `[module] Settled${where ? ` ${where}` : ''}: ${entry.from}'s question since ${entry.since} (entry ${entry.id}) — ${how}. `
    + 'Already closed: drop it, never ask or relay it again, present the next.'
}

// Whether the entry is closed by the module when settled: the coordinator on this machine was
// shown it. A coordinator elsewhere never reads this round.
async function closesItself($: any, id: string): Promise<boolean> {
  return !!(await coordinatorAddress($))?.local && await shownToCoordinator($, id)
}

// The settled entries told to the coordinator on this machine, one message each, while time is
// left before `until`: a notice that does not fit, is refused or throws is one log line.
async function tellSettled($: any, settled: readonly Settled[], until = Infinity): Promise<void> {
  if (settled.length === 0) return
  let to: string
  try {
    const coordinator = await coordinatorAddress($)
    if (!coordinator?.local) return
    to = coordinator.to
  } catch (err) {
    await logLine($, `round: ${(err as Error).message}`)
    return
  }
  for (const { entry, answer } of settled) {
    try {
      // No bound given, the caller's own deadline holds the sends.
      const left = until - Date.now()
      const send = () => $.session.send({ to, text: settledText(entry, answer) })
      const sent = left === Infinity ? await send() : left > 0 ? await withDeadline(send(), left) : null
      if (!sent || isDegradedPass(sent)) await logLine($, `round: no time left to tell ${to} that ${entry.id} is settled`)
      else if (!sent.isDelivered) await logLine($, `round: the settled notice of ${entry.id} was not delivered to ${to}: ${sent.reason ?? 'no answer'}`)
    } catch (err) {
      await logLine($, `round: ${(err as Error).message}`)
    }
  }
}

// The round's reading, ROUND_WAKE_MS from now, one chain at a time: `timer` is the one armed, and
// an arm while it is pending arms nothing; `generation` moves when the session ends, so a reading
// already running then arms no next one.
export type WakeMemory = { timer: { cancel(): void } | null; generation: number }

function armWake($: any, wake: WakeMemory): void {
  if (wake.timer) return
  const generation = wake.generation
  const timer = $.clock.after(ROUND_WAKE_MS, () => wakeTick($, wake, timer, generation))
  wake.timer = timer
}

function stopWake(wake: WakeMemory): void {
  wake.generation++
  wake.timer?.cancel()
  wake.timer = null
}

// One reading: a failure is one log line, and the next reading still comes. A timer no longer
// the one armed reads nothing.
async function wakeTick($: any, wake: WakeMemory, timer: unknown, generation: number): Promise<void> {
  if (wake.timer !== timer) return
  wake.timer = null
  try {
    await wakeForDue($)
  } catch (err) {
    await logLine($, `round wake: ${(err as Error).message}`)
  }
  if (wake.generation === generation) armWake($, wake)
}

// The questions just due, read in the coordinator's own session: one wake submitted to it for
// those it was not woken for yet, the pane open as the script reads it. A question whose sender
// has ended has no one left to answer, as in the pane. The ids woken for are read again just
// before the submit, another session may have woken for some meanwhile, and recorded only once
// the host took it: a submit that fails or is dropped is tried again at the next reading. The
// ids kept are those the round still holds, so the list never outgrows it.
async function wakeForDue($: any): Promise<void> {
  const local = await readSessions($)
  const read = (await readRound($)).map(found => found.entry)
  const paneOpen = await paneIsOpen($)
  const present = new Set(read.map(entry => entry.id))
  const now = Date.now()
  const dueBeside = (woken: readonly string[]) => (entry: RoundEntry) =>
    sessionKey(entry.session) in local && !woken.includes(entry.id) && isDue(entry, now, paneOpen)
  if (!read.some(dueBeside(await readWoken($)))) return
  const woken = (await readWoken($)).filter(id => present.has(id))
  const due = read.filter(dueBeside(woken))
  if (due.length === 0) return
  const taken = await $.prompt.submit({ text: dueText(due) })
  if (taken && typeof taken === 'object' && 'drop' in taken && taken.drop) {
    await logLine($, `round wake: the host dropped the wake: ${String(taken.drop)}`)
    return
  }
  await writeAtomic($, await wokenPath($), JSON.stringify([...woken, ...due.map(entry => entry.id)]) + '\n')
}

// A coordinator's pane opens by itself, the operator's ruling of 2026-10-18: at the end of the
// first turn its role reads `coordinator` while the coordinator's record names one. Once per
// session — the flag is the host's, so neither a reload nor a later turn opens it again, and a
// pane he closed with the command stays closed.
// True when the session is the recorded coordinator's, which arms its round's wake.
async function openOnFirstTurn($: any, pane: PaneMemory): Promise<boolean> {
  const self = await recordedCoordinator($)
  if (!self) return false
  if ((await $.state.get(PANE_OPENED)).value) return true
  await $.state.set(PANE_OPENED, true)
  const panes: readonly { id: string }[] = await $.ui.panes()
  if (!panes.some(open => open.id === PANE_ID)) await openPane($, pane, 'coordinator', self.tty, self.pid)
  return true
}

// This session's tty and host pid when its role reads `coordinator` while the coordinator's
// record names one, else null. The role is the row's; a first turn can end before the first
// measure writes the row, and then the name is walked, bounded. A row that carries no pid has
// its pid walked the same way, its role kept.
async function recordedCoordinator($: any): Promise<{ tty: string | null; pid: string | null } | null> {
  const sessionId = await $.session.id()
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
  let role = row?.role ?? null
  let tty = row?.tty ?? null
  let pid = row?.pid ?? null
  if (row && role !== 'coordinator') return null
  if (!row || !pid) {
    const walked = await walkWithinBound($, sessionId)
    if (walked.known) {
      if (!row) role = roleOf(walked.name)
      tty = tty ?? walked.tty
      pid = walked.pid
    }
  }
  if (role !== 'coordinator') return null
  if (!coordinatorOf(String(await $.fs.read(`${await stateDir($)}/coordinator.json`).catch(() => '')))) return null
  return { tty, pid }
}

// The coordinator's round reading, module memory that register and registerWake share: a reload
// starts it afresh, the host having dropped the old environment's timers with it.
let wake: WakeMemory = { timer: null, generation: 0 }

// The round's reading armed when the module loads — the host's session.start fires at a reload
// too — so a reload with no turn after it still wakes the coordinator. Mounted beside the
// supervision rather than in it, whose register holds no start handler: nothing is opened at a
// start. Bounded, as the first start is awaited.
export function registerWake(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  on('session.start', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      const self = await withDeadline(recordedCoordinator($), RELAY_BOUND_MS)
      if (isDegradedPass(self)) await logLine($, `round wake: did not finish within ${RELAY_BOUND_MS} ms`)
      else if (self) armWake($, wake)
    } catch (err) {
      await logLine($, `round wake: ${(err as Error).message}`)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// The supervision tool registered at each start, mounted beside the supervision like the wake:
// a registration, never an open. Every session gets it, the tool.call refusing those that
// supervise nothing, so a role read later than the start is never missed.
export function registerPaneTool(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  on('session.start', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      await $.tool.register({
        name: SUPERVISION_TOOL,
        isDeferred: false,
        description: 'Opens or closes the supervision pane, when the operator says to start, launch or open the supervision, or to end, stop or close it. Only in a coordinator or an orchestrator session.',
        inputSchema: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['open', 'close'] } },
          required: ['action'],
        },
      })
    } catch (err) {
      // A start never fails on the tool: the commands still open the pane.
      await logLine($, `supervision tool not registered: ${(err as Error).message}`)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  // Module memory: the role the pane was opened in, the tty its agents are read
  // from — the render lists what the open asked for — and the open pane's clock.
  // A reload forgets it, and the pane then asks to be opened again.
  const pane: PaneMemory = { opened: null, ticker: null, other: new Set(), writing: null, undelivered: new Map(), answering: new Set() }
  // The entry whose recommended choice was last asked the focus: once per entry, never at a redraw.
  let focusedFor: string | null = null
  // This session's own repository, read once: its owner names the pull requests the pane links.
  let ownRepo: Promise<string | null> | null = null
  const stopTicker = () => {
    pane.ticker?.cancel()
    pane.ticker = null
  }
  // The coordinator's round read for questions just due, armed by a start or a turn end that
  // finds it the recorded coordinator (registerWake).
  wake = { timer: null, generation: 0 }

  // The engine allows one no-matcher registration per event, and the gauge
  // owns session.measure's and session.end's: this domain observes the same
  // events beside it, declared by an empty matcher — a partial of e with no
  // field named, so every measure and every end reaches the store. The chain
  // still answers in registration order, which register pins (the gauge
  // first, or the row runs one measure behind).
  on('session.measure', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      // The gauge mounted before this domain answers first in the chain, so
      // the reading is this measure's own — fresh, never one measure behind
      // (register pins the order). Without one the gauge itself failed,
      // already said in its own log: no row is written on top of figures
      // nobody has.
      const reading = currentReading()
      if (reading) {
        const sessionId = e.sessionId ?? await $.session.id()
        // The side reads run bounded: a walk or an origin read that cannot
        // answer in time is quietly no new name and no repository — the
        // figures still land, and the next measure names the row.
        const walked = await walkWithinBound($, sessionId)
        const origin = await withDeadline(repoOf($), await sideReadBoundMs($))
        await writeSession($, sessionId, {
          // A walk that did not finish leaves the row's name, role and pid as they were.
          ...(walked.known ? { role: roleOf(walked.name), name: walked.name } : {}),
          ...(walked.pid ? { pid: walked.pid } : {}),
          ...(walked.tty ? { tty: walked.tty } : {}),
          repo: isDegradedPass(origin) ? null : origin,
          context_percent: reading.context_percent,
          context_tokens: reading.context_tokens,
          window: reading.context_window,
          model: reading.model,
          busy: false,
          updated_at: reading.updated_at,
        })
        // An orchestrator's row to a coordinator on another machine, when it is news.
        if (walked.known && roleOf(walked.name) === 'orchestrator') {
          const sent = await withDeadline(sendRow($, sessionId), RELAY_BOUND_MS)
          if (isDegradedPass(sent)) await logLine($, `row: did not finish within ${RELAY_BOUND_MS} ms`)
        }
        // An agent's measure past its gate: its orchestrator told once per crossing.
        if (walked.known && walked.tty && roleOf(walked.name) === 'agent') {
          const done = await withDeadline(reportGate($, sessionId, walked.name!, walked.tty, reading), RELAY_BOUND_MS)
          if (isDegradedPass(done)) await logLine($, `gate: did not finish within ${RELAY_BOUND_MS} ms`)
        }
      }
    } catch (err) {
      // A row that cannot be written, or a gate report that failed, never blocks the
      // measure: the next one writes it.
      await logLine($, (err as Error).message)
    }
    // The deck follows the row just written (writeDeck): a new fill is what its keys draw.
    await refreshDeck($)
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    // The registered net the plan's every-handler rule asks validate to see:
    // the measure is let through, the state dir says why, and next is
    // replay-safe in a catch, called or not.
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('session.end', {}, async ($: any, e: any, next: (e: any) => any) => {
    const sessionId = e.sessionId ?? await $.session.id()
    try {
      stopWake(wake)
      await deleteSession($, sessionId)
      await recordPaneClosed($)
    } catch (err) {
      // The end is never held on the store's own failure; it is said.
      await logLine($, (err as Error).message)
    }
    // What the host's end bound leaves, shared by the round and the deck after it.
    let until = Date.now() + Math.min(RELAY_BOUND_MS, next.budget?.remainingMs ?? RELAY_BOUND_MS)
    try {
      // A question whose sender has ended has no one left to answer it. After the row is
      // gone, and bounded by what the host's own end bound leaves: a slow round never
      // starves the store's deletion.
      // Every write first, then the notices in what is left of it.
      const bound = Math.min(RELAY_BOUND_MS, next.budget?.remainingMs ?? RELAY_BOUND_MS)
      until = Date.now() + bound
      const done = await withDeadline(withdrawStale($, sessionId, null, "the sender's session ended"), bound)
      if (isDegradedPass(done)) await logLine($, `round: did not finish within ${bound} ms`)
      else await tellSettled($, done, until)
    } catch (err) {
      await logLine($, `round: ${(err as Error).message}`)
    }
    // The ended session leaves the deck, in what the round left of the bound.
    const left = until - Date.now()
    if (left > 0) await refreshDeck($, left)
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The end of a main-loop turn that answered: an orchestrator's wait written to its
  // row and, once per wait, entered in the round of a coordinator on this machine or
  // reported to one elsewhere — an agent's state to its orchestrator (relayTurnEnd). Here
  // rather than at classic.Stop: a stop the gate refuses goes on in the same turn, so
  // the message a stop carries is not always the turn's last word, and the gate's own
  // deadline is not this report's to spend; turn.complete fires once the turn is over,
  // with its final answer. Bounded, and never holds the turn's end.
  on('turn.complete', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      if (!e.agentId && e.reason === 'answer') {
        const done = await withDeadline(relayTurnEnd($, String(e.answer ?? '')), RELAY_BOUND_MS)
        if (isDegradedPass(done)) await logLine($, `relay: did not finish within ${RELAY_BOUND_MS} ms`)
        // The wait just written is what the pane shows: the row follows it, when it is news.
        const sent = await withDeadline(sendRow($, await $.session.id()), RELAY_BOUND_MS)
        if (isDegradedPass(sent)) await logLine($, `row: did not finish within ${RELAY_BOUND_MS} ms`)
      } else if (!e.agentId) {
        // A turn that ended without an answer (interrupted, failed) still ends the mark's turn.
        await dropMark($)
      }
    } catch (err) {
      await logLine($, `relay: ${(err as Error).message}`)
    }
    try {
      if (!e.agentId) {
        const done = await withDeadline(openOnFirstTurn($, pane), RELAY_BOUND_MS)
        if (isDegradedPass(done)) await logLine($, `pane: did not finish within ${RELAY_BOUND_MS} ms`)
        else if (done) armWake($, wake)
      }
    } catch (err) {
      await logLine($, `pane: ${(err as Error).message}`)
    }
    // The wait the relay just wrote, or cleared, is what the deck's keys show.
    if (!e.agentId) await refreshDeck($)
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // A turn starts: the session works again, and a wait its row carried is over.
  on('turn.start', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      const sessionId = await $.session.id()
      const wait = await readWait($, sessionId)
      if (wait?.waiting) {
        await writeWait($, sessionId, clearedWait(wait))
        await refreshDeck($)
      }
    } catch (err) {
      await logLine($, `relay: ${(err as Error).message}`)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The operator types in an orchestrator whose question the coordinator holds: he answered it
  // in this tab, so the question is withdrawn — its round entry marked, or a coordinator elsewhere
  // told (withdrawOnTyped). prompt.submit runs
  // before turn.start, so the wait is usually still on. Never adds context, never holds the prompt.
  on('prompt.submit', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      const done = await withDeadline(withdrawOnTyped($, String(e.origin?.kind ?? ''), String(e.text ?? '')), RELAY_BOUND_MS)
      if (isDegradedPass(done)) await logLine($, `withdraw: did not finish within ${RELAY_BOUND_MS} ms`)
    } catch (err) {
      await logLine($, `withdraw: ${(err as Error).message}`)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The model's own « handed over » to its successor, the predecessor's last word in a
  // succession: the work is the successor's now, and the session's open questions with it.
  // The message is sent all the same.
  on('session.send', {}, async ($: any, e: any, next: (e: any) => any) => {
    const handedOver = !e.agentId && e.origin?.kind === 'model' && typeof e.text === 'string' && handsOver(e.text)
    const sent = await next(e)
    try {
      // Only a hand-over that was not refused closes the questions: a refused one leaves
      // the sender in charge of them.
      if (handedOver && sent?.isDelivered !== false) await handOver($, await $.session.id())
    } catch (err) {
      await logLine($, `round: ${(err as Error).message}`)
    }
    return sent
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // A peer's delivery, read before it is queued. A marked row (remote-row.ts) is written to
  // the store and consumed: no model reads it, on either side. A coordinator's message
  // teaches this machine its address, for the relay and the row when the coordinator runs
  // elsewhere. Anything else passes through untouched.
  on('session.receive', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      if (!e.agentId && isPeerOrigin(e.origin) && typeof e.text === 'string') {
        const delivery = deliveryOf(e.text)
        if (isMarked(delivery.body)) {
          const received = await receiveRow($, delivery.body)
          // A remote orchestrator's row is one of the deck's keys.
          await refreshDeck($)
          return received
        }
        const learnt = learntOf(delivery, Date.now())
        if (learnt) await learnCoordinator($, learnt)
      }
    } catch (err) {
      await logLine($, `receive: ${(err as Error).message}`)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The pane opens on the person's own command alone — the shipped types' «
  // asked » open, placed at any width — in the two supervising roles: a
  // coordinator's lists the orchestrators, an orchestrator's its own agents.
  // Anywhere else the command says so and opens nothing. Every form of either role's
  // command answers, the same toggle on the same pane; a bare short name only when its user
  // command is this plugin's copy, the operator's own command of that name run as he wrote it.
  for (const command of SUPERVISION_COMMANDS) on('command.run', { command }, async ($: any, e: any, next: any) => {
    if (isBare(String(e?.command ?? ''))) {
      const dir = commandsDirOf(await $.env.get('ORCHESTRATOR_COMMANDS_DIR'), await configDir($))
      if (!isOwnCopy(String(await $.fs.read(`${dir}/${e.command}.md`).catch(() => '')))) return next(e)
    }
    const { tty, name, pid } = await walkWithinBound($, await $.session.id())
    const role = roleOf(name)
    if (role !== 'coordinator' && role !== 'orchestrator') {
      return { text: 'The supervision pane opens in a coordinator session (« Coord : … »), listing the orchestrators, or in an orchestrator session (« Orch : … »), listing its agents; /orchestrator-status lists the sessions here.' }
    }
    // A toggle: the same command closes the pane it opened (Escape does not —
    // the pane holds no focus), beside the pane's own ✕. Either way the pane is his
    // from now on: the module no longer opens it on its own.
    await $.state.set(PANE_OPENED, true)
    if (await paneShown($)) {
      await closeShown($, pane)
      return { text: 'Supervision pane closed.' }
    }
    await openPane($, pane, role, tty, pid)
    return { text: `Supervision pane opened; type /${role}-supervision again, or click its ✕, to close it.` }
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The same pane on the operator's plain words: the model calls the tool with `open` or
  // `close` where he types no command. Not a toggle — the word says which — and, like the
  // command, the pane is his from then on.
  on('tool.call', { tool: `mcp__orchestrator__${SUPERVISION_TOOL}` }, async ($: any, e: any) => {
    if (e.agentId) return { result: PANE_MAIN_THREAD_ONLY, isError: true }
    if (e.action !== 'open' && e.action !== 'close') return { result: 'action is "open" or "close"', isError: true }
    const { tty, name, pid } = await walkWithinBound($, await $.session.id())
    const role = roleOf(name)
    if (role !== 'coordinator' && role !== 'orchestrator') return { result: PANE_ROLES_ONLY, isError: true }
    await $.state.set(PANE_OPENED, true)
    const shown = await paneShown($)
    if (e.action === 'close') {
      if (!shown) return { result: 'The supervision pane is not open.' }
      await closeShown($, pane)
      return { result: 'Supervision pane closed.' }
    }
    if (shown) return { result: 'The supervision pane is already open.' }
    const placed = await openPane($, pane, role, tty, pid)
    if (placed && placed.isPlaced === false) return { result: `Supervision pane opened, not drawn yet: ${placed.reason ?? 'no reason given'}.` }
    return { result: 'Supervision pane opened.' }
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: "the supervision pane could not be opened or closed; the module's log says why", isError: true }
  })

  // The pane closed by its ✕ or its key: its clock stops with it.
  on('ui.close', { id: PANE_ID }, async ($: any, e: any, next: (e: any) => any) => {
    stopTicker()
    await recordPaneClosed($).catch((err: unknown) => logLine($, `pane: ${(err as Error).message}`))
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The body's window moving at the person's wheel or keys: the host's measure of the tree is
  // kept for the track, with the content it measured. A plugin's own move never reaches here.
  on('ui.scroll', { component: 'Pane', requestId: PANE_ID }, async ($: any, e: any, next: (e: any) => any) => {
    if (pane.drawn) pane.measure = { contentRows: e.contentRows, drawn: pane.drawn }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The pane's ring leaving the text field, for the picker or off the pane: the field goes
  // with it, so that Tab from a choice never reaches it, until « Other answer » is picked again.
  on('ui.focus', { component: 'Pane', requestId: PANE_ID }, async ($: any, e: any, next: (e: any) => any) => {
    const result = await next(e)
    if (pane.writing !== null && !result?.deny && e.element !== answerKey(pane.writing)) {
      pane.writing = null
      $.ui.invalidate('ui.render')
    }
    return result
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The pane's own render: the matcher names the render envelope's component
  // and requestId — the pane's id — so the rows are drawn in this plugin's pane
  // alone and never in another plugin's.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($: any, e: any, next: (e: any) => any) => {
    try {
      // The store at draw time: the gauge's invalidate after every measure and
      // the pane's own clock re-raise this render. Display only.
      pane.ticksSinceDraw = 0
      let rows: { label: string; name: string; rest: string; urgency: number }[] = []
      let blocks: PaneRow[] = []
      let speaker: string | null = null
      let asking: RoundEntry | null = null
      let failed: { entry: RoundEntry; reason: string }[] = []
      let pending = 0
      let owners = new Map<string, string>()
      let none = 'type /coordinator-supervision or /orchestrator-supervision to open the pane again'
      const coordinator = pane.opened?.role === 'coordinator'
      if (coordinator) {
        const local = await readSessions($)
        const merged = withRemote(local, await readRemoteRows($), Date.now(), REMOTE_STALE_AFTER_MS)
        blocks = paneRows(Object.fromEntries(Object.entries(merged).filter(([, row]) => row.role === 'orchestrator')))
        owners = repositoryOwners([await (ownRepo ??= repoOf($)), ...Object.values(merged).flatMap(row => [row.repo, ...((row as { prs?: unknown }).prs instanceof Array ? (row as { prs: string[] }).prs : [])])])
        none = WORDS.noOrchestrator
        // A question whose sender has ended has no one left to answer: only the entries of a
        // session with a live row are drawn, and counted.
        // Stat before the read: a write landing between the two is seen by the next tick.
        pane.roundSeen = await roundMtime($)
        const read = await readRound($)
        const drawn = read.map(found => found.entry).filter(entry => sessionKey(entry.session) in local)
        const questions = paneQuestions(drawn)
        // The answers given to the first questions of an entry no longer drawn are forgotten.
        for (const id of pane.partial?.keys() ?? []) if (!questions.some(entry => entry.id === id)) pane.partial!.delete(id)
        // Each question counts, those of an entry that asks several one by one, less those
        // already answered.
        pending = questions.reduce((sum, entry) => sum + entryQuestions(entry).length - (pane.partial?.get(entry.id)?.length ?? 0), 0)
        // The orchestrator whose question is drawn, by its session: two may share a name.
        const first = questions[0]
        speaker = first ? sessionKey(first.session) : null
        asking = first ?? null
        // An answer not delivered is said until a render finds its sender gone, or its entry
        // settled since: withdrawn, closed, or holding another answer than the one that failed.
        const held = new Map(read.map(({ entry }) => [entry.id, entry]))
        for (const [id, notice] of pane.undelivered) {
          const now = held.get(id)
          const same = (now?.status === 'answered' || now?.status === 'closed') && now.answer?.by === 'pane' && now.answer.at === notice.entry.answer?.at
          if (!(sessionKey(notice.entry.session) in local) || !same) pane.undelivered.delete(id)
        }
        failed = [...pane.undelivered.values()]
      } else if (pane.opened?.role === 'orchestrator') {
        // Bounded like every side read: an agent list that cannot be read in
        // time draws as none, never a held render.
        const views = pane.opened.tty ? await withDeadline(agentViews($, pane.opened.tty), await sideReadBoundMs($)) : []
        rows = isDegradedPass(views) ? [] : agentPaneRows(views)
        none = isDegradedPass(views) ? 'the agents could not be read in time' : 'no agent running'
      }
      const el = $.ui.resolve(e)
      if (!coordinator) {
        return el.Box({
          flexDirection: 'column',
          children: rows.length === 0
            ? [el.Text({ children: none })]
            // The default text colour with the name bold; a row past the gate is warning, each
            // piece carrying the colour itself.
            : rows.map(row => {
              const tint = row.urgency >= GATE_URGENCY_FLOOR ? { color: 'warning' } : {}
              return el.Text({ children: [el.Text({ ...tint, bold: true, children: row.name }), el.Text({ ...tint, children: row.rest })] })
            }),
        })
      }
      // Every piece below is drawn with the rows it takes at the content's width: the host tells
      // the tree's height only at the person's own `ui.scroll` (never at a plugin's), so until a
      // move measured this very content, the count is the module's, and it is the drawn rows'
      // sum — the card's border, padding, indents and blank lines counted as drawn.
      const scroll: { offset: number; bodyRows: number } | undefined = e.props?.scroll
      const columns: number = e.props?.bodyColumns ?? 0
      const width = columns - TRACK_COLUMNS
      const rowsOf = (text: string, at: number) => width > 0 ? text.split('\n').reduce((sum, line) => sum + wrapWords(line, Math.max(1, at)).length, 0) : 0
      type Drawn = { node: unknown; rows: number }
      // A column of pieces a blank line apart: their rows and one per gap.
      const spacedRows = (items: readonly Drawn[]) => items.reduce((sum, item) => sum + item.rows, 0) + Math.max(0, items.length - 1)
      const spaced = (items: readonly Drawn[]): Drawn => ({ node: el.Box({ flexDirection: 'column', gap: 1, children: items.map(item => item.node) }), rows: spacedRows(items) })
      // A text drawn with the marks it carried — inline code in its colour, bold, italic — and each
      // pull request it names a link of its own, `style` the whole text's.
      const rich = (text: string, style: object = {}) => el.Text({ children: textSpans(text).flatMap(span => linked(span.text).map(piece => el.Text({
        ...style,
        ...(span.code ? { color: CODE_COLOR } : {}),
        ...(span.bold ? { bold: true } : {}),
        ...(span.italic ? { italic: true } : {}),
        children: piece,
      }))) })
      const linked = (text: string): unknown[] => typeof el.Link === 'function'
        ? prPieces(text, owners).map(piece => (typeof piece === 'string' ? piece : el.Link({ href: piece.href, children: piece.text })))
        : [text]
      // A text as it takes rows. The host does not tell whether its surface draws a hyperlink as
      // such: where it does not, it writes the URL after the link's text, so each link is counted
      // with its URL, the conservative count.
      const takesRows = (text: string): string => typeof el.Link === 'function'
        ? prPieces(plainText(text), owners).map(piece => (typeof piece === 'string' ? piece : `${piece.text} ${piece.href}`)).join('')
        : plainText(text)
      // Each orchestrator is a block: one line, a dot in its state's colour, its bold name and
      // its figures in the normal colour; the speaker's whole line bold in `suggestion`. A wait
      // adds a Status line and, on the operator, a Blocks line, each label in a column of its own
      // so a long text wraps under its own first character. A blank line between two blocks.
      const block = (row: PaneRow, i: number): Drawn => {
        const state = row.waiting === 'operator' ? 'warning' : row.waiting === 'done' ? 'success' : 'suggestion'
        const speaks = row.key === speaker
        const style = (over: object = {}) => (speaks ? { bold: true, color: 'suggestion', ...over } : over)
        const line = el.Text({
          children: [
            el.Text({ color: state, children: '●' }),
            el.Text({ children: ' ' }),
            el.Text(speaks ? style({ children: row.name }) : { bold: true, children: row.name }),
            el.Text(style({ children: ` · ${row.head} · ` })),
            el.Text(row.past ? { ...style(), color: 'error', children: row.fill } : style({ children: row.fill })),
            ...(row.age !== null ? [el.Text(style({ children: ` · ${row.age}` }))] : []),
          ],
        })
        const labelled = (label: string, text: unknown): unknown => el.Box({
          flexDirection: 'row',
          paddingLeft: 2,
          children: [
            el.Box({ width: WAIT_LABEL_COLUMN, flexShrink: 0, children: [el.Text({ children: `${label}:` })] }),
            el.Box({ flexGrow: 1, flexShrink: 1, children: [text] }),
          ],
        })
        const textWidth = width - 2 - WAIT_LABEL_COLUMN
        return {
          node: el.Box({
            flexDirection: 'column',
            ...(i > 0 ? { marginTop: 1 } : {}),
            children: [
              line,
              ...(row.status !== null ? [labelled(WORDS.status, el.Text({ color: state, children: row.status }))] : []),
              ...(row.blocked !== null ? [labelled(WORDS.blocks, rich(row.blocked))] : []),
            ],
          }),
          rows: (i > 0 ? 1 : 0)
            + rowsOf(`● ${row.name} · ${row.head} · ${row.fill}${row.age !== null ? ` · ${row.age}` : ''}`, width)
            + (row.status !== null ? rowsOf(row.status, textWidth) : 0)
            + (row.blocked !== null ? rowsOf(takesRows(row.blocked), textWidth) : 0),
        }
      }
      const listed: Drawn[] = blocks.length === 0 ? [{ node: el.Text({ children: none }), rows: rowsOf(none, width) }] : blocks.map(block)
      const waiting = blocks.filter(row => row.waiting === 'operator').length
      const says = waiting === 0
        ? WORDS.none
        : `${WORDS.none} in the pane — ${waiting} orchestrator${waiting === 1 ? ' waits' : 's wait'} for you: ask the coordinator`
      // The question the card asks: an entry that asks several presents them one at a time, the
      // first not yet answered.
      const parts = asking ? entryQuestions(asking) : []
      const index = asking ? Math.min(pane.partial?.get(asking.id)?.length ?? 0, parts.length - 1) : 0
      const part = parts[index] ?? null
      // An entry's key, or with several questions its question's, so each question's picker, field
      // and focus are its own.
      const keyOf = (entry: RoundEntry) => (parts.length > 1 ? `${entry.id}:${index + 1}` : entry.id)
      // Where the surface draws a picker, the choices are one Select: it holds the arrows while it
      // has the ring, where a focused pane taller than its body scrolls on them, and a click only
      // gives it the ring — a stray click answers nothing. Its last option leads to the text
      // field. A picker's option is one line, cut at the pane's width, so each choice's whole text
      // is drawn once above it and the options carry their letter alone. Elsewhere (mobile, a tap
      // the only way) one Button per choice.
      const picker = typeof el.Select === 'function'
      const pickKey = (entry: RoundEntry) => `choices:${keyOf(entry)}`
      const firstPick = () => part === null ? null : (part.choices.find(c => c.letter === part.recommendation) ?? part.choices[0])?.letter ?? null
      const focusKey = () => {
        const pick = firstPick()
        if (asking === null || pick === null) return null
        return picker ? pickKey(asking) : `choice:${pick}`
      }
      const answer = (entry: RoundEntry, letter: string) => answerFromPane($, pane, entry, { letter, text: part!.choices.find(c => c.letter === letter)!.text }, index)
      const choices = (entry: RoundEntry) => el.Select({
        key: pickKey(entry),
        // A prompt to choose, its value the choice the ring starts on: never an answer sent.
        label: WORDS.choose,
        options: [
          ...part!.choices.map(c => ({ value: c.letter, label: c.letter === part!.recommendation ? `${c.letter} (${WORDS.recommended})` : c.letter })),
          { value: OTHER_VALUE, label: WORDS.otherBelow },
        ],
        value: firstPick()!,
        // The ring starts on the picker when the pane takes the keys.
        autoFocus: true,
        onSelect: (value: string) => {
          if (value !== OTHER_VALUE) return answer(entry, value)
          // The field is drawn from the next draw on, which the focus call waits for.
          pane.writing = keyOf(entry)
          $.ui.invalidate('ui.render')
          return Promise.resolve($.ui.focus({ requestId: PANE_ID, key: answerKey(keyOf(entry)) })).catch(() => undefined)
        },
      })
      const focus = focusKey()
      if (asking !== null && focus !== null && focusedFor !== keyOf(asking)) {
        // Once per question: the ring to its first choice for a pane already holding the keys,
        // and the window to it, so a question drawn below the rows shows its choice. Never
        // awaited, so the draw never waits on itself, and a refusal (the pane holds no keys yet)
        // is not an error.
        focusedFor = keyOf(asking)
        try {
          Promise.resolve($.ui.focus({ requestId: PANE_ID, key: focus })).catch(() => undefined)
        } catch {
          // A host without the call: the autoFocus mark still starts the ring.
        }
        // The window is moved once the picker is drawn: before, the key names nothing.
        try {
          $.clock.after(SCROLL_AFTER_DRAW_MS, () => {
            try {
              Promise.resolve($.ui.scroll({ to: { key: focus }, in: PANE_ID })).catch(() => undefined)
            } catch {
              // A host without the call: the window stays where it is.
            }
          })
        } catch {
          // A host without a clock: the window stays where it is.
        }
      }
      // The card's widths: inside its border and padding, a field's value under its label, a
      // choice's text after its badge.
      const inner = width - 2 * CARD_BORDER - 2 * CARD_PADDING_X
      const valueWidth = inner - FIELD_INDENT
      const choiceWidth = valueWidth - BADGE_COLUMN
      const choosing = part !== null && part.choices.length > 0
      // A question in the decide shape draws its fields as the sender labelled them, and nothing
      // else of its turn; one in an older shape draws its body whole.
      const shape = part ? questionShape(part.question, part.choices) : null
      const body = asking && part && shape === null ? questionBody({ question: part.question, choices: part.choices }) : ''
      // The choices: the letter a badge, the text hanging after it so a wrapped line stays under
      // its first word, a blank line between two; the recommended one in `success` with its star.
      // Without a picker, each a Button carrying its whole text.
      const choiceList = (entry: RoundEntry): Drawn => spaced(part!.choices.map(c => {
        const recommended = c.letter === part!.recommendation
        const tail = recommended ? `  ${STAR}` : ''
        if (!picker) {
          const label = `[${c.letter}] ${plainText(c.text)}${tail}`
          const key = `choice:${c.letter}`
          return {
            node: el.Button({
              key,
              label,
              hotkey: c.letter.toLowerCase(),
              // The ring starts on the focused choice when the pane takes the keys.
              ...(key === focus ? { autoFocus: true } : {}),
              ...(recommended ? { children: [el.Text({ bold: true, color: 'success', children: label })] } : {}),
              onPress: () => answer(entry, c.letter),
            }),
            rows: rowsOf(label, valueWidth),
          }
        }
        const look = recommended ? { bold: true, color: 'success' } : {}
        return {
          node: el.Box({
            flexDirection: 'row',
            children: [
              el.Box({ width: BADGE_COLUMN, flexShrink: 0, children: [el.Text({ bold: true, color: recommended ? 'success' : 'suggestion', children: `[${c.letter}]` })] }),
              el.Box({ flexGrow: 1, flexShrink: 1, children: [el.Text({ ...look, children: [rich(c.text, look), ...(tail ? [el.Text({ ...look, children: tail })] : [])] })] }),
            ],
          }),
          rows: rowsOf(`${takesRows(c.text)}${tail}`, choiceWidth),
        }
      }))
      // A field: its label upper-case in `suggestion` on a line of its own, its value indented
      // under it — the context dim, the question bold. A label with no text heads what follows
      // it: the choices, when it is the last.
      const indented = (inside: Drawn): Drawn => ({ node: el.Box({ paddingLeft: FIELD_INDENT, flexDirection: 'column', children: [inside.node] }), rows: inside.rows })
      // The choices under a label of their own, as the sender's fields are, when the sender's text
      // gives none above them.
      const labelledChoices = (entry: RoundEntry): Drawn => {
        const label = WORDS.choices.toUpperCase()
        const list = indented(choiceList(entry))
        return {
          node: el.Box({ flexDirection: 'column', children: [el.Text({ bold: true, color: 'suggestion', children: label }), list.node] }),
          rows: rowsOf(label, inner) + list.rows,
        }
      }
      const fieldLook = (label: string) => /^cont/i.test(label) ? { dimColor: true } : /^quest/i.test(label) ? { bold: true } : {}
      const fields = (entry: RoundEntry): Drawn[] => {
        const list = shape?.fields ?? []
        const heading = choosing && list.length > 0 && list[list.length - 1].text === '' ? list.length - 1 : -1
        return list.map((field, i) => {
          const label: Drawn = { node: el.Text({ bold: true, color: 'suggestion', children: field.label.toUpperCase() }), rows: rowsOf(field.label.toUpperCase(), inner) }
          const value: Drawn | null = i === heading
            ? indented(choiceList(entry))
            : field.text === '' ? null : indented({ node: rich(field.text, fieldLook(field.label)), rows: rowsOf(takesRows(field.text), valueWidth) })
          return {
            node: el.Box({ flexDirection: 'column', children: [label.node, ...(value ? [value.node] : [])] }),
            rows: label.rows + (value?.rows ?? 0),
          }
        }).concat(choosing && heading < 0 ? [labelledChoices(entry)] : [])
      }
      const recommendation = shape?.recommendation ?? null
      const recommendationLine = (): Drawn | null => {
        if (recommendation === null) return null
        const head = `${STAR} ${recommendation.label}${recommendation.separator}`
        return {
          node: el.Text({ children: [el.Text({ color: 'success', children: `${STAR} ` }), el.Text({ bold: true, children: `${recommendation.label}${recommendation.separator}` }), rich(recommendation.text)] }),
          rows: rowsOf(`${head}${takesRows(recommendation.text)}`, inner),
        }
      }
      // Beside a picker the field is drawn only once « Other answer » is picked: drawn sooner,
      // it is a stop of the ring that Tab reaches from a choice, and text typed there lands.
      const otherAnswer = (entry: RoundEntry): Drawn[] => typeof el.Input === 'function'
        ? (picker && choosing && pane.writing !== keyOf(entry) ? [] : [{
          node: el.Input({
            key: answerKey(keyOf(entry)),
            label: OTHER_LABEL,
            placeholder: WORDS.otherPlaceholder,
            submitLabel: WORDS.send,
            onSubmit: (value: string) => answerFromPaneText($, pane, entry, value, index),
          }),
          rows: 1,
        }])
        : [{
          node: el.Box({
            flexDirection: 'column',
            children: [
              el.Button({
                key: OTHER_KEY,
                label: WORDS.otherInSession,
                hotkey: OTHER_HOTKEY,
                onPress: () => {
                  pane.other.add(keyOf(entry))
                  $.ui.invalidate('ui.render')
                },
              }),
              ...(pane.other.has(keyOf(entry)) ? [el.Text({ color: 'suggestion', children: `type your answer in this tab, or in ${entry.from}'s tab` })] : []),
            ],
          }),
          rows: 1 + (pane.other.has(keyOf(entry)) ? rowsOf(`type your answer in this tab, or in ${entry.from}'s tab`, inner) : 0),
        }]
      // The card: a rounded border in `suggestion`, its title the sender and the question's own
      // number, then its pieces a blank line apart.
      const card = (entry: RoundEntry): Drawn => {
        const title = part!.number === null ? entry.from : `${entry.from} · ${numberLabel(part!.number)}`
        const pieces: Drawn[] = [
          { node: el.Text({ bold: true, color: 'suggestion', children: title }), rows: rowsOf(title, inner) },
          ...(shape !== null ? fields(entry) : []),
          ...(body !== '' ? [{ node: rich(body), rows: rowsOf(takesRows(body), inner) }] : []),
          ...(shape === null && choosing ? [labelledChoices(entry)] : []),
          ...[recommendationLine()].filter((line): line is Drawn => line !== null),
          ...(choosing && picker ? [{ node: choices(entry), rows: 1 + (e.props?.isFocused ? part!.choices.length + 1 : 0) }] : []),
          ...otherAnswer(entry),
        ]
        return {
          node: el.Box({
            flexDirection: 'column',
            borderStyle: 'round',
            borderColor: 'suggestion',
            paddingX: CARD_PADDING_X,
            paddingTop: CARD_PADDING_TOP,
            gap: 1,
            children: pieces.map(piece => piece.node),
          }),
          rows: 2 * CARD_BORDER + CARD_PADDING_TOP + spacedRows(pieces),
        }
      }
      // Under the card, the entry's next question, by its number and its first field, dim.
      const following = asking && index + 1 < parts.length ? parts[index + 1] : null
      const nextLine = following === null ? null : (() => {
        const subject = questionShape(following.question, following.choices)?.fields[0]?.text.split('\n')[0] ?? ''
        const words = `${WORDS.next}: ${following.number === null ? `question ${index + 2}` : numberLabel(following.number)}${subject ? ` — ${plainText(subject)}` : ''}`
        return { node: el.Text({ dimColor: true, children: words }), rows: rowsOf(words, width) }
      })()
      // An answer not delivered is one line at the section's foot, every one of them in it, so a
      // notice never stands between the title and the next question.
      const noticeText = `${WORDS.notDelivered}: ${failed.map(notice => `${notice.reason} — the answer to ${notice.entry.from} (blocks: ${notice.entry.blocks})`).join(' · ')}`
      const notices: Drawn[] = failed.length === 0 ? [] : [{ node: el.Text({ color: 'error', children: noticeText }), rows: rowsOf(noticeText, width) }]
      const title = pending === 0 ? WORDS.questions : `${WORDS.questions} — ${pending} ${WORDS.pending}`
      // A rule, dim, closes the questions, a blank line below them: one row, cut at the pane's width.
      const rule: Drawn = {
        node: el.Box({ marginTop: 1, children: [el.Text({ dimColor: true, wrap: 'truncate-end', children: '─'.repeat(width > 0 ? width : RULE_FALLBACK) })] }),
        rows: 2,
      }
      const section: Drawn[] = [
        { node: el.Text({ bold: true, color: 'suggestion', children: title }), rows: rowsOf(title, width) },
        ...(asking === null ? [{ node: el.Text({ children: says }), rows: rowsOf(says, width) }] : [card(asking)]),
        ...(nextLine ? [nextLine] : []),
        ...notices,
        rule,
      ]
      const heading: Drawn = { node: el.Text({ bold: true, children: WORDS.orchestrators }), rows: rowsOf(WORDS.orchestrators, width) }
      // The key line, dim, at the foot: once the pane holds the keys, how to give them is no
      // longer said.
      const keyLine = asking === null ? null : picker
        ? `${e.props?.isFocused ? '' : 'ctrl+x tab or a click: give the pane the keys · '}arrows: move · Enter: choose · Esc: back to the prompt`
        : 'ctrl+x tab: give the pane the keys · arrows or Tab: move · Enter: choose · a letter: pick it · Esc: back to the prompt'
      const flow: Drawn[] = [
        { node: el.Box({ flexDirection: 'column', children: section.map(piece => piece.node) }), rows: section.reduce((sum, piece) => sum + piece.rows, 0) },
        heading,
        ...listed,
      ]
      // The body's window and the tree's height: a track on the right edge and the key line
      // pinned to the window's top once the tree is taller, each drawn at the window's own rows
      // (the offset), so both stay in view wherever it is. At the top, not the bottom: the host
      // keeps the held picker in view by bringing it to the window's bottom edge, where a pinned
      // line would cover it.
      const drawnKey = JSON.stringify([asking?.id ?? null, index, pending, blocks, failed.map(notice => notice.reason), pane.writing, [...pane.other], e.props?.isFocused ?? false, columns, scroll?.bodyRows ?? null, keyLine])
      pane.drawn = drawnKey
      const measured = pane.measure && pane.measure.drawn === drawnKey ? pane.measure.contentRows : null
      const pinnedRows = keyLine !== null && width > 0 ? wrapWords(keyLine, width) : []
      const counted = width > 0 ? flow.reduce((sum, piece) => sum + piece.rows, 0) + pinnedRows.length : 0
      const track = scroll && width > 0 ? scrollTrack(scroll.offset, scroll.bodyRows, measured ?? counted) : null
      const pinned = track !== null && pinnedRows.length > 0 ? pinnedRows : null
      const overlays = track === null || !scroll ? [] : [
        el.Box({
          position: 'absolute', top: scroll.offset, right: 0, width: 1, flexDirection: 'column',
          children: track.map(thumb => el.Text(thumb ? { color: 'suggestion', children: '█' } : { dimColor: true, children: '│' })),
        }),
        ...(pinned === null ? [] : [el.Box({
          position: 'absolute', top: scroll.offset, left: 0, width, flexDirection: 'column',
          children: pinned.map(row => el.Text({ dimColor: true, children: row.padEnd(width) })),
        })]),
      ]
      return el.Box({
        flexDirection: 'column',
        ...(track !== null ? { paddingRight: TRACK_COLUMNS } : {}),
        ...(pinned !== null ? { paddingTop: pinned.length } : {}),
        children: [...flow.map(piece => piece.node), ...(pinned === null && keyLine !== null ? [el.Text({ dimColor: true, children: keyLine })] : []), ...overlays],
      })
    } catch (err) {
      // A pane that fails to draw never blocks the render: the engine draws its own.
      await logLine($, (err as Error).message)
      return next(e)
    }
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// The bound on the whole relay at a turn's end: the row and wait reads, the wait's
// write, the coordinator's record and the send queued. Well inside a handler's ten seconds.
const RELAY_BOUND_MS = 5000

// The wait record without the mark of a typed prompt, which belongs to one turn and is never written back.
function withoutMark(record: WaitRecord): WaitRecord {
  const { typed: _mark, ...rest } = record
  return rest
}

// The mark cleared at the end of a turn that gave no answer: prompt.submit runs before turn.start,
// so the turn's start cannot clear it without erasing the mark of its own prompt.
async function dropMark($: any): Promise<void> {
  const sessionId = await $.session.id()
  const now = await readWait($, sessionId)
  if (now?.typed) await writeWait($, sessionId, withoutMark(now))
}

// A turn's end, read and reported. The role comes from the session's row (the measure's
// walk named it), else from a walk of its own. An orchestrator's machine line goes to the
// coordinator: an entry of its round when it runs on this machine, a message when it runs
// on another; an agent's status line to its orchestrator, found in the
// launcher's chains (orchestratorOn), never in the turn's text; any other role, nothing.
// No line: a wait the session carried is cleared; an orchestrator sends nothing, an agent's
// orchestrator is sent one report, unless it was already (key `no-status`). A line: written to the
// session's wait file, then reported unless this very one was already — the fingerprint
// is kept only once the entry is in place or the send is delivered. Nobody to send to: nothing
// is sent. A write that fails or a send refused is one log line; the turn's end is never held
// on it. The row itself is never written here: the measure is its one writer.
// A prompt the operator typed while a question was held left a mark (withdrawOnTyped): the turn
// that ends on the same wait leaves the question open, any other end withdraws it as answered
// in the tab, and only such a turn withdraws the session's other open entries as answered there.
// A turn that ends on an operator wait whose text asks nothing is entered as its own entry and
// never withdraws its session's open question with choices.
export async function relayTurnEnd($: any, answer: string): Promise<void> {
  const sessionId = await $.session.id()
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
  let name = row?.name ?? null
  let pid = row?.pid ?? null
  let tty = row?.tty ?? null
  if (!row?.role || (row.role === 'agent' && !tty)) {
    const walked = await walkWithinBound($, sessionId)
    if (walked.known) {
      name = walked.name
      pid = walked.pid ?? pid
      tty = walked.tty ?? tty
    }
  }
  const role = roleOf(name)
  if (!name || (role !== 'orchestrator' && role !== 'agent')) return
  const wait = role === 'orchestrator' ? parseWait(answer) : parseStatus(answer)
  // The mark of a prompt the operator typed while a question was held (withdrawOnTyped): it
  // belongs to this turn alone and is never written back. Withdrawn before the wait is read:
  // a fingerprint the withdrawal forgot stays forgotten.
  const typed = role === 'orchestrator' ? (await readWait($, sessionId))?.typed ?? null : null
  let forgotten = false
  let heldKey: string | null = null
  let swept = false
  if (typed) {
    const sameWait = wait?.kind === 'operator' && wait.blocks === typed.blocks
    heldKey = (await readWait($, sessionId))?.relayed ?? null
    if (!sameWait) {
      forgotten = await withdrawHeld($, sessionId, name, typed)
      // He answered in this tab: a turn ending on another machine line, a wait or done, leaves
      // none of the session's other open entries waiting either.
      if (wait) {
        await tellSettled($, await withdrawStale($, sessionId, roundEntryId(sessionId, wait), TAB_ANSWER))
        swept = true
      }
    }
  }
  const read = await readWait($, sessionId)
  const before = read ? withoutMark(read) : null
  // A wait rewritten while the withdrawal was sent keeps the fingerprint it was written with.
  const relayed = forgotten && (before?.relayed ?? null) === heldKey ? null : before?.relayed ?? null
  // A turn that ends on « handed over »: the successor holds the work, and the questions.
  if (!wait && role === 'orchestrator' && handsOver(answer)) await handOver($, sessionId)
  if (!wait && role === 'orchestrator') {
    if (before?.waiting || typed) await writeWait($, sessionId, { ...clearedWait(before!), relayed, name, pid })
    return
  }
  const patch = wait
    ? waitPatch(before, wait, new Date().toISOString())
    : before?.waiting ? clearedWait(before) : null
  if (patch) await writeWait($, sessionId, { ...patch, relayed, name, pid })
  const key = wait ? fingerprint(wait) : NO_STATUS_KEY
  if (relayed === key) return
  const coordinator = role === 'orchestrator' ? await coordinatorAddress($) : null
  // A coordinator on this machine reads its round: the wait is entered there, and its model
  // is not woken for it. The fingerprint is kept once the entry is in place, as a delivery's.
  if (coordinator?.local && wait && patch) {
    const entry = roundEntry(sessionId, name, wait, patch.waiting_since!, new Date().toISOString())
    const kept = entry.kind === 'operator' && entry.choices.length === 0 ? await keptChoices($, entry) : null
    if (kept) {
      // The same wait, its text now a note: the entry keeps its choices and takes the urgent mark
      // or its absence, urgent, it is due at once.
      if (Boolean(kept.entry.urgent) !== Boolean(entry.urgent)) {
        const { urgent: _, ...plain } = kept.entry
        await writeAtomic($, kept.path, JSON.stringify(entry.urgent ? { ...plain, urgent: true } : plain) + '\n')
      }
      await writeWait($, sessionId, { ...patch, relayed: key, name, pid })
      return
    }
    await writeAtomic($, roundPath(await stateDir($), entry.id), JSON.stringify(entry) + '\n')
    await writeWait($, sessionId, { ...patch, relayed: key, name, pid })
    if (entry.kind !== 'operator' || swept) return
    // A new question is what the session waits on now: its older open entries are not. A turn
    // the operator typed in withdrew them already, above. A wait that asks nothing never
    // withdraws its session's open question with choices, which only copies its urgent mark.
    const silent = asksNothing(entry)
    if (silent && entry.urgent) await markUrgent($, sessionId)
    await tellSettled($, await withdrawStale($, sessionId, entry.id, `superseded by ${entry.id}`, silent ? carriesChoices : undefined))
    return
  }
  const to = role === 'orchestrator'
    ? coordinator?.to ?? null
    : tty ? await orchestratorOn($, tty) : null
  if (!to) {
    if (role === 'agent') await logLine($, `relay: no orchestrator found for ${name} on ${tty ?? 'an unknown tty'}`)
    return
  }
  const context = row && row.context_tokens > 0 ? `${row.context_tokens.toLocaleString('en-US')} (${row.context_percent}%)` : null
  const text = wait ? relayText(name, wait, patch!.waiting_since!, context) : noStatusText(name, context)
  const sent = await $.session.send({ to, text })
  if (sent?.isDelivered) {
    await writeWait($, sessionId, { ...(patch ?? before ?? {}), relayed: key, name, pid })
  } else {
    await logLine($, `relay: not delivered to ${to}: ${sent?.reason ?? 'no answer'}`)
  }
}

// The operator typed a prompt (composer or bridge) in an orchestrator whose relayed question
// is still on him. What he typed may be the answer or not — a word to the session about
// something else — and only the turn's end tells (relayTurnEnd): here the question is only
// marked in the session's wait file as held while he typed. Anything else does nothing, a slash
// command included: it starts no turn, so nothing would read the mark. Without a coordinator
// nothing is marked. A wait file that holds no question (the last turn ended on done) leaves the
// round's own open entry of the session to be marked, the earliest when several, when the
// coordinator runs on this machine. The wait is re-read before it is written back, a turn's start may have
// written it.
export async function withdrawOnTyped($: any, kind: string, text: string): Promise<void> {
  if (!typedByOperator(kind) || text.trimStart().startsWith('/')) return
  const sessionId = await $.session.id()
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
  let name = row?.name ?? null
  if (!row?.role) {
    const walked = await walkWithinBound($, sessionId)
    if (walked.known) name = walked.name
  }
  if (!name || roleOf(name) !== 'orchestrator') return
  const coordinator = await coordinatorAddress($)
  if (!coordinator) return
  const held = heldQuestion(await readWait($, sessionId)) ?? (coordinator.local ? await openQuestion($, sessionId) : null)
  if (!held) return
  const now = await readWait($, sessionId)
  if (now) await writeWait($, sessionId, { ...now, typed: held })
}

// The session's open operator entry in the round, the earliest when several: the question a
// later turn's wait left open and the wait file no longer names (it ended on done, say).
async function openQuestion($: any, sessionId: string): Promise<{ blocks: string; since: string | null } | null> {
  const open = (await readRound($))
    .map(({ entry }) => entry)
    .filter(entry => entry.session === sessionId && entry.kind === 'operator' && entry.status === 'open' && !!entry.blocks)
    .sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0))
  return open.length > 0 ? { blocks: open[0].blocks!, since: open[0].since } : null
}

// The held question withdrawn at the end of the turn the operator typed in: answered in the
// sender's own tab. An entry in the round of a coordinator on this machine is marked, a
// coordinator elsewhere is sent the withdrawal. True when it is done, so the question asked
// again is relayed again; a send refused is one log line, and the fingerprint is kept.
async function withdrawHeld($: any, sessionId: string, name: string, held: { blocks: string; since: string | null }): Promise<boolean> {
  const coordinator = await coordinatorAddress($)
  if (!coordinator) return false
  try {
    if (coordinator.local) {
      await tellSettled($, await withdrawEntry($, sessionId, name, held))
    } else {
      const sent = await $.session.send({ to: coordinator.to, text: withdrawalText(name, held.blocks, held.since) })
      if (!sent?.isDelivered) {
        await logLine($, `withdraw: not delivered to ${coordinator.to}: ${sent?.reason ?? 'no answer'}`)
        return false
      }
    }
    return true
  } catch (err) {
    await logLine($, `withdraw: ${(err as Error).message}`)
    return false
  }
}

// The session's open question with choices that this very wait holds, the same blocks since the
// same start: a text without choices under it is a note on that question, never a new one.
async function keptChoices($: any, entry: RoundEntry): Promise<{ path: string; entry: RoundEntry } | null> {
  return (await readRound($)).find(({ entry: open }) =>
    open.session === entry.session && open.kind === 'operator' && open.status === 'open'
    && open.blocks === entry.blocks && open.since === entry.since && open.choices.length > 0) ?? null
}

// The urgent mark of a wait that asks nothing, copied onto its session's open questions with
// choices: they stay open beside it (the operator's report of 2026-10-25), and its urgency is theirs.
async function markUrgent($: any, sessionId: string): Promise<void> {
  for (const { path, entry } of await readRound($)) {
    if (entry.session !== sessionId || entry.status !== 'open' || entry.urgent || !carriesChoices(entry)) continue
    await writeAtomic($, path, JSON.stringify({ ...entry, urgent: true }) + '\n')
  }
}

// The session's open entries withdrawn by its hand-over, every write first, then the notices
// in what is left of the bound.
async function handOver($: any, sessionId: string): Promise<void> {
  const until = Date.now() + RELAY_BOUND_MS
  const done = await withDeadline(withdrawStale($, sessionId, null, 'handed over to its successor'), RELAY_BOUND_MS)
  if (isDegradedPass(done)) await logLine($, `round: did not finish within ${RELAY_BOUND_MS} ms`)
  else await tellSettled($, done, until)
}

// The held question's entry in the round: that session's open operator question with the same
// start and the same blocks, marked withdrawn, answered in its own tab, or closed so when the
// coordinator was shown it (the entries to tell it of). None found, nothing is written and the
// log says so; one that cannot be written throws, and the next typed prompt tries again.
async function withdrawEntry($: any, sessionId: string, name: string, held: { blocks: string; since: string | null }): Promise<Settled[]> {
  const settled: Settled[] = []
  let matched = 0
  for (const { path, entry } of await readRound($)) {
    if (entry.session !== sessionId || entry.kind !== 'operator' || entry.status !== 'open') continue
    if (entry.since !== held.since || entry.blocks !== held.blocks) continue
    matched++
    const at = new Date().toISOString()
    const closed = await closesItself($, entry.id)
    const answer: RoundAnswer = { text: closed ? `withdrawn: ${TAB_ANSWER}` : TAB_ANSWER, by: 'tab', at }
    await writeAtomic($, path, JSON.stringify({ ...entry, status: closed ? 'closed' : 'withdrawn', answer }) + '\n')
    if (closed) settled.push({ entry, answer })
  }
  if (matched === 0) await logLine($, `round: no open entry matched for ${name} since ${held.since ?? '?'}`)
  return settled
}

// A choice pressed in the coordinator's pane: the entry, read again so a question settled
// meanwhile is left as it is, becomes answered by the pane, written whole and renamed into
// place, and the asking orchestrator's own session is sent the operator's choice (senderAddress).
// Its fingerprint is forgotten, so the same question asked again is entered again. A send not
// delivered, or one that throws, keeps the entry answered, is one log line, and the pane says it
// on that question until its sender is gone or the entry is settled again. A press on an entry
// whose answer is in flight does nothing. The pane is drawn again: the next open question comes up.
export async function answerFromPane($: any, pane: PaneMemory, asked: RoundEntry, choice: RoundChoice, part = 0): Promise<void> {
  return answerPart($, pane, asked, `${choice.letter} : ${choice.text}`, part)
}

// The text typed in the pane's « other answer » field answers the entry as a choice does; a
// text empty once trimmed does nothing.
export async function answerFromPaneText($: any, pane: PaneMemory, asked: RoundEntry, typed: string, part = 0): Promise<void> {
  const text = typed.trim()
  if (text === '') return
  return answerPart($, pane, asked, text, part)
}

// The answer to one question of an entry. An entry that asks several is answered one question at
// a time: each answer is kept, with the question's number, until the last, and then all of them
// go together, in order, as the entry's answer. An answer to a question other than the one the
// pane presents (a press landing late) does nothing.
async function answerPart($: any, pane: PaneMemory, asked: RoundEntry, text: string, part: number): Promise<void> {
  const parts = entryQuestions(asked)
  if (parts.length < 2) return answerEntryFromPane($, pane, asked, text)
  const given = pane.partial?.get(asked.id) ?? []
  if (part !== given.length || part >= parts.length) return
  const number = parts[part].number
  const answers = [...given, `${number === null ? `Question ${part + 1}` : number}: ${text}`]
  forgetDraft(pane, `${asked.id}:${part + 1}`)
  if (answers.length < parts.length) {
    pane.partial = (pane.partial ?? new Map()).set(asked.id, answers)
    $.ui.invalidate('ui.render')
    return
  }
  pane.partial?.delete(asked.id)
  return answerEntryFromPane($, pane, asked, answers.join(' · '))
}

// A question's « other answer » forgotten: its field and its note to answer in the session.
function forgetDraft(pane: PaneMemory, key: string): void {
  pane.other.delete(key)
  if (pane.writing === key) pane.writing = null
}

// The one sequence both answers share: the entry written answered by the pane with `text`, its
// fingerprint forgotten, the text sent to its sender.
async function answerEntryFromPane($: any, pane: PaneMemory, asked: RoundEntry, text: string): Promise<void> {
  if (pane.answering.has(asked.id)) return
  pane.answering.add(asked.id)
  try {
    const path = roundPath(await stateDir($), asked.id)
    const entry = parseRoundEntry(String(await $.fs.read(path).catch(() => '')))
    if (!entry || entry.status !== 'open') return
    const at = new Date().toISOString()
    // The coordinator that was shown this question leaves it at once, in its own session: the
    // entry is closed here, in the same rename, and never waits on its round-close.
    const closed = await shownToCoordinator($, entry.id)
    const answer: RoundAnswer = { text: closed ? `answered from the pane: ${text}` : text, by: 'pane', at }
    await writeAtomic($, path, JSON.stringify({ ...entry, status: closed ? 'closed' : 'answered', answer }) + '\n')
    forgetDraft(pane, entry.id)
    await forgetRelayed($, entry)
    let reason: string | null = null
    try {
      const sent = await $.session.send({ to: await senderAddress($, entry), text: paneAnswerText(entry, text, at) })
      if (!sent?.isDelivered) reason = sent?.reason ?? 'no answer'
    } catch (err) {
      reason = (err as Error).message
    }
    if (reason !== null) {
      pane.undelivered.set(entry.id, { entry: { ...entry, status: 'answered', answer: { text, by: 'pane', at } }, reason })
      await logLine($, `round: the pane's answer was not delivered to ${entry.from}: ${reason}`)
    }
    if (closed) {
      const taken = await $.prompt.submit({ text: settledText(entry, answer) })
      if (taken && typeof taken === 'object' && 'drop' in taken && taken.drop) await logLine($, `round: the host dropped the settled notice of ${entry.id}: ${String(taken.drop)}`)
    }
  } catch (err) {
    await logLine($, `round: ${(err as Error).message}`)
  } finally {
    pane.answering.delete(asked.id)
    $.ui.invalidate('ui.render')
  }
}

// Where an entry's answer goes: its sender's own session, by the id the entry recorded, while
// that session has a live row on this machine — two sessions may share a name, and a name sent
// to is refused when they do. An entry naming no such session goes to its sender's name.
async function senderAddress($: any, entry: RoundEntry): Promise<string | { sessionId: string }> {
  if (entry.session === '') return entry.from
  return sessionKey(entry.session) in await readSessions($) ? { sessionId: entry.session } : entry.from
}

// A settled entry's fingerprint forgotten in its sender's wait file, so the same question asked
// again is entered again: the file is re-read and written back with `relayed` null only when it
// still holds that entry's own fingerprint (a later wait may have replaced it).
async function forgetRelayed($: any, entry: RoundEntry): Promise<void> {
  const now = await readWait($, entry.session)
  if (now && now.relayed === entryFingerprint(entry)) await writeWait($, entry.session, { ...withoutMark(now), relayed: null })
}

// The message the asking orchestrator receives: a report of the operator's choice, never more.
export function paneAnswerText(entry: RoundEntry, answer: string, at: string): string {
  return `[module] The operator answered from the coordinator's pane at ${at} — ${answer} (question since ${entry.since}, blocks: ${entry.blocks})`
}

// An orchestrator's turn ended on a machine line other than the wait an open entry of its own
// holds: that entry is no longer what it waits on, so it is withdrawn by the sender, leaves the
// pane and its count, and its fingerprint is forgotten. A turn with no machine line says nothing
// of its wait and withdraws nothing. The same withdrawal closes every open entry of a session
// that is superseded by its new question, that ended, or that handed over (`current` null).
// `current` is the id of the entry this turn's wait has, kept open; `why` the withdrawal's answer
// text; `kept` the entries left open besides. An entry the coordinator on this machine was shown
// is closed instead, its answer « withdrawn: <why> », and returned so the caller tells it once
// every write is done. Each withdrawal is one log line; one that cannot be written is one too,
// and the relay goes on.
async function withdrawStale($: any, sessionId: string, current: string | null, why: string, kept?: (entry: RoundEntry) => boolean): Promise<Settled[]> {
  const settled: Settled[] = []
  for (const { path, entry } of await readRound($)) {
    if (entry.session !== sessionId || entry.status !== 'open' || entry.id === current || kept?.(entry)) continue
    try {
      const closed = await closesItself($, entry.id)
      const answer: RoundAnswer = { text: closed ? `withdrawn: ${why}` : why, by: 'sender', at: new Date().toISOString() }
      await writeAtomic($, path, JSON.stringify({ ...entry, status: closed ? 'closed' : 'withdrawn', answer }) + '\n')
      await logLine($, `round: withdrawn by the sender: ${entry.id}`)
      await forgetRelayed($, entry)
      if (closed) settled.push({ entry, answer })
    } catch (err) {
      await logLine($, `round: ${(err as Error).message}`)
    }
  }
  return settled
}

// Every entry of the round on this machine, each with the file it was read from. A file that
// does not parse to an entry is skipped, never repaired; a temporary file is no entry yet. A
// directory that exists and cannot be listed is said in the log and read as empty; one never
// written is no failure — nothing was ever asked.
export async function readRound($: any): Promise<{ path: string; entry: RoundEntry }[]> {
  const dir = `${await stateDir($)}/round`
  let listed: readonly { name: string; kind: string }[]
  try {
    listed = await $.fs.list(dir)
  } catch (err) {
    if (await $.fs.exists(dir).catch(() => true)) await logLine($, `round: cannot list ${dir}: ${(err as Error).message}`)
    return []
  }
  const read: { path: string; entry: RoundEntry }[] = []
  for (const file of listed) {
    if (!file || file.kind !== 'file' || !file.name.endsWith('.json') || file.name.includes('.tmp-')) continue
    const entry = parseRoundEntry(String(await $.fs.read(`${dir}/${file.name}`).catch(() => '')))
    if (entry) read.push({ path: `${dir}/${file.name}`, entry })
  }
  return read
}

const ROUND_STATUSES: readonly string[] = ['open', 'answered', 'withdrawn', 'closed']

// An entry file read back: the JSON of one entry, each field of its type, or nothing.
function parseRoundEntry(text: string): RoundEntry | null {
  try {
    const e = JSON.parse(text)
    if (!e || typeof e !== 'object') return null
    const texts = [e.id, e.from, e.session, e.since, e.question, e.at].every(field => typeof field === 'string')
    const choices = Array.isArray(e.choices) && e.choices.every((c: any) => typeof c?.letter === 'string' && typeof c?.text === 'string')
    const nullable = [e.blocks, e.recommendation].every(field => field === null || typeof field === 'string')
    const known = (e.kind === 'operator' || e.kind === 'done') && ROUND_STATUSES.includes(e.status)
    return texts && choices && nullable && known ? e as RoundEntry : null
  } catch {
    return null
  }
}

// Where an orchestrator's reports go: the coordinator registered on this machine first
// (coordinator.sh's record), else the one a peer delivery taught this machine — its
// address as the envelope gave it, else its name. Null when neither names one.
export async function coordinatorAddress($: any): Promise<{ to: string; name: string; local: boolean } | null> {
  const local = coordinatorOf(String(await $.fs.read(`${await stateDir($)}/coordinator.json`).catch(() => '')))
  if (local) return { to: local, name: local, local: true }
  const learnt = parseLearnt(String(await $.fs.read(`${await storeOf($)}/coordinator-learnt`).catch(() => '')))
  return learnt ? { to: learnt.from ?? learnt.name, name: learnt.name, local: false } : null
}

async function learnCoordinator($: any, learnt: { name: string; from: string | null; at: string }): Promise<void> {
  const path = `${await storeOf($)}/coordinator-learnt`
  const known = parseLearnt(String(await $.fs.read(path).catch(() => '')))
  if (known && known.name === learnt.name && known.from === learnt.from) return
  await writeAtomic($, path, JSON.stringify(learnt) + '\n')
}

// The host name, read once per module load: the machine label a row carries.
let machine: string | null = null
async function machineOf($: any): Promise<string> {
  if (machine === null) {
    const run = await $.process.run(['hostname', '-s'], { timeoutMs: 2000 }).catch(() => null)
    machine = machineLabel(run?.exitCode === 0 ? String(run.stdout ?? '') : '')
  }
  return machine
}

// The pull requests in flight of one session, read from the state dir's ci-watch directory.
// Every file name listed (at most CI_WATCH_LIST_CAP) is kept, so a base log is seen wherever it
// sits in the listing; the owner files read are those of at most CI_WATCH_READ_CAP watches
// still in flight, the newest first. A directory that cannot be read means no pull request,
// never a failure.
const CI_WATCH_LIST_CAP = 4096
const CI_WATCH_READ_CAP = 256
async function prsOf($: any, sessionId: string, repo: string | null): Promise<string[]> {
  const dir = `${await stateDir($)}/ci-watch`
  const entries: { name: string; kind: string; mtimeMs?: number }[] = await $.fs.list(dir).catch(() => [])
  const files = entries.slice(0, CI_WATCH_LIST_CAP).filter(entry => entry?.kind === 'file')
  const names = files.map(entry => entry.name)
  const listed = new Set(names)
  const watches = files
    .filter(entry => watchNumberOf(entry.name) !== null && !listed.has(entry.name.replace(/\.log$/, '-base.log')))
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    .slice(0, CI_WATCH_READ_CAP)
  const owners = new Map<string, string>()
  for (const entry of watches) {
    owners.set(entry.name, String(await $.fs.read(`${dir}/${entry.name}.session`).catch(() => '')).trim())
  }
  return prsInFlight(names, owners, sessionId, repo)
}

// An orchestrator's row, sent to a coordinator on another machine when it is news
// (remote-row.ts): a coordinator on this machine reads the store itself, and none known
// is nobody to send to. What was sent is kept only once delivered; a failure is one log
// line, tried again at the next measure or turn end.
export async function sendRow($: any, sessionId: string): Promise<void> {
  const store = await storeOf($)
  const read = parseSessionRow(String(await $.fs.read(`${store}/${sessionKey(sessionId)}`).catch(() => '')))
  if (read?.role !== 'orchestrator') return
  const to = await coordinatorAddress($)
  if (!to || to.local) return
  const prs = await prsOf($, sessionId, read.repo)
  const row = remoteRowOf(withWait(read, String(await $.fs.read(`${store}/${waitKey(sessionId)}`).catch(() => ''))), await machineOf($), prs)
  if (!row) return
  const now = Date.now()
  const path = `${store}/${rowKey(sessionId)}`
  if (!rowIsNews(row, parseRowSent(String(await $.fs.read(path).catch(() => ''))), now)) return
  let sent = await $.session.send({ to: to.to, text: rowText(row) })
  if (!sent?.isDelivered && to.to !== to.name) sent = await $.session.send({ to: to.name, text: rowText(row) })
  if (sent?.isDelivered) await writeAtomic($, path, JSON.stringify(rowSent(row, now)) + '\n')
  else await logLine($, `row: not delivered to ${to.name}: ${sent?.reason ?? 'no answer'}`)
}

// A marked delivery: consumed whatever it holds — the marker is the module's own, never a
// message for the model — and written as a remote row only when it passes every check.
async function receiveRow($: any, body: string): Promise<{ consumed: string }> {
  const row = parseRemoteRow(body)
  if (!row) {
    await logLine($, `receive: a marked row was refused (${body.length} characters)`)
    return { consumed: 'orchestrator: a malformed supervision row, refused' }
  }
  await writeAtomic($, `${await storeOf($)}/${remoteKey(row.name)}`, JSON.stringify(row) + '\n')
  return { consumed: 'orchestrator: a supervision row, stored' }
}

// The rows received from other machines, each checked again as it is read; a stale or
// unreadable one is removed as it is met, so the directory never outgrows the live set.
const REMOTE_READ_CAP = 64
export async function readRemoteRows($: any): Promise<RemoteRow[]> {
  const dir = `${await storeOf($)}/remote`
  const entries: { name: string; kind: string }[] = await $.fs.list(dir).catch(() => [])
  const rows: RemoteRow[] = []
  const dead: string[] = []
  const now = Date.now()
  for (const entry of entries.slice(0, REMOTE_READ_CAP)) {
    if (!entry || entry.kind !== 'file' || entry.name.includes('.tmp-')) continue
    const row = parseRemoteRow(`${ROW_MARKER}${String(await $.fs.read(`${dir}/${entry.name}`).catch(() => ''))}`)
    if (row && !isRemoteStale(row, now, REMOTE_STALE_AFTER_MS)) rows.push(row)
    else dead.push(`${dir}/${entry.name}`)
  }
  if (dead.length > 0) await $.process.run(['rm', '-f', ...dead], { timeoutMs: 5000 }).catch(() => undefined)
  return rows
}

// The machine's deck (deck.ts): the store, the remote rows, the round, the chains and the
// sleepers read once and written to the state directory's deck.json, only when it is news.
// Bounded by its callers and never a failure of theirs: a deck that cannot be written is one
// log line, and the next change writes it.
let lastDeck: { deck: Deck; at: number } | null = null
export async function writeDeck($: any): Promise<void> {
  const state = await stateDir($)
  const local = await readSessions($)
  const chainDir = `${state}/chains`
  const listed: readonly { name: string; kind: string; mtimeMs?: number }[] = await $.fs.list(chainDir).catch(() => [])
  const chains = []
  for (const entry of listed) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
    chains.push({ name: entry.name, mtimeMs: entry.mtimeMs ?? 0, text: String(await $.fs.read(`${chainDir}/${entry.name}`).catch(() => '')) })
  }
  const prs = new Map<string, string[]>()
  for (const [key, row] of Object.entries(local)) {
    if (row.role === 'orchestrator') prs.set(key, await prsOf($, key.slice('sessions/'.length), row.repo))
  }
  const now = Date.now()
  const deck = deckOf({
    machine: await machineOf($), now, local, chains, prs,
    remote: await readRemoteRows($),
    round: (await readRound($)).map(read => read.entry),
    sleepingText: String(await $.fs.read(`${state}/sleeping.json`).catch(() => '')),
    gate: await gateEnv($),
  })
  if (!deckIsNews(deck, lastDeck, now)) return
  await writeAtomic($, `${state}/${DECK_FILE}`, deckText(deck))
  lastDeck = { deck, at: now }
}

async function refreshDeck($: any, bound = RELAY_BOUND_MS): Promise<void> {
  try {
    const done = await withDeadline(writeDeck($), bound)
    if (isDegradedPass(done)) await logLine($, `deck: did not finish within ${bound} ms`)
  } catch (err) {
    await logLine($, `deck: ${(err as Error).message}`)
  }
}

// The orchestrator an agent on `tty` reports to: the chain that names the tty
// (chainOwnerTty), then the live orchestrator row measured on that chain's tty, the
// latest if two. Null when no chain names it or no orchestrator sits there.
export async function orchestratorOn($: any, tty: string): Promise<string | null> {
  const dir = `${await stateDir($)}/chains`
  const listed: readonly { name: string; kind: string; mtimeMs?: number }[] = await $.fs.list(dir).catch(() => [])
  const chains = []
  for (const entry of listed) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
    chains.push({ name: entry.name, mtimeMs: entry.mtimeMs ?? 0, text: String(await $.fs.read(`${dir}/${entry.name}`).catch(() => '')) })
  }
  const owner = chainOwnerTty(chains, tty)
  if (!owner) return null
  const rows = `${await storeOf($)}/sessions`
  let found: SessionRow | null = null
  for (const entry of await $.fs.list(rows).catch(() => [])) {
    const row = parseSessionRow(String(await $.fs.read(`${rows}/${entry.name}`).catch(() => '')))
    if (row?.role === 'orchestrator' && row.tty === owner && row.name && (!found || row.updated_at > found.updated_at)) found = row
  }
  return found?.name ?? null
}

// An agent's measure against the gate its session runs under (the gauge's thresholds,
// read from this session's environment): past it and not yet reported, its orchestrator
// is sent the figures once; back under it, the mark is cleared for the next crossing.
export async function reportGate($: any, sessionId: string, name: string, tty: string,
  reading: { context_tokens: number; context_percent: number; context_window: number }): Promise<void> {
  const path = `${await storeOf($)}/${gateKey(sessionId)}`
  const past = tripGate(reading.context_percent, reading.context_tokens, reading.context_window, await gateEnv($)).tripped
  const reported = String(await $.fs.read(path).catch(() => '')).trim() === 'reported'
  if (past === reported) return
  if (!past) {
    await $.fs.write(path, '')
    return
  }
  const to = await orchestratorOn($, tty)
  if (!to) {
    await logLine($, `gate: no orchestrator found for ${name} on ${tty}`)
    return
  }
  const sent = await $.session.send({ to, text: gateText(name, reading.context_tokens, reading.context_percent) })
  if (sent?.isDelivered) await $.fs.write(path, 'reported\n')
  else await logLine($, `gate: not delivered to ${to}: ${sent?.reason ?? 'no answer'}`)
}

// The gate's thresholds from the environment, the gauge's own reading spelled again here
// (the $ fence): a value that is no positive number stays undefined, and tripGate applies
// the default itself.
async function gateEnv($: any): Promise<{ gate?: number; gateTokens?: number; largeWindow?: number }> {
  const threshold = (raw: string | undefined) => {
    const n = raw === undefined ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  return {
    gate: threshold(await $.env.get('ORCHESTRATOR_CONTEXT_GATE')),
    gateTokens: threshold(await $.env.get('ORCHESTRATOR_CONTEXT_GATE_TOKENS')),
    largeWindow: threshold(await $.env.get('ORCHESTRATOR_LARGE_WINDOW')),
  }
}

// One line appended to the module's log (module-log.ts): the stamp names the
// half that failed. Never throws, never blocks the handler it serves.
async function logLine($: any, message: string): Promise<void> {
  try {
    const config = await configDir($)
    await $.process.run(logArgv($.plugin.root, config, 'supervision', message, undefined, await $.env.get('ORCHESTRATOR_MODULE_DIR')), { timeoutMs: LOG_TIMEOUT_MS })
  } catch { /* the log itself never blocks the handler that failed */ }
}

// $.fs.read carries no range and refuses past 4 MiB, so the walk's transcript
// window comes from dd (blockArgv), as bytes — this file's own reader, the
// per-file convention: the engine fences $ to the file that received it, so
// guards.ts's identical reader cannot be imported, and each domain spells its
// own over its own $.
async function readBlock($: any, path: string, index: number, timeoutMs: number): Promise<Uint8Array> {
  const { exitCode, stdout } = await $.process.run(blockArgv(path, index), { timeoutMs })
  if (exitCode !== 0) throw new Error(`dd exited ${exitCode} on ${path}`)
  return bytesOfBase64(String(stdout ?? ''))
}

// The transcript, found the gauge's own way (the guards' reader, spelled over
// this file's $): by session id under the projects directory. A miss returns
// '': the rename fallback then names nothing, and the launch name stands alone.
async function transcriptPathOf($: any, sessionId: string): Promise<string> {
  try {
    const projects = `${await configDir($)}/projects`
    for (const entry of await $.fs.list(projects)) {
      if (entry.kind !== 'dir') continue
      const candidate = `${projects}/${entry.name}/${sessionId}.jsonl`
      if (await $.fs.exists(candidate)) return candidate
    }
  } catch { /* no projects directory: no transcript to name */ }
  return ''
}

// The session's repository (`owner/name`), this file's own one-line read of
// the origin remote — the per-file convention again: the stop gate's
// repositoryOf holds its own $ and cannot be imported. The read runs in the
// working directory the host runs the module in, the session's project; null
// when there is no origin: a session outside any checkout reports no
// repository, never a failure.
async function repoOf($: any): Promise<string | null> {
  try {
    const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'])
    if (remote.exitCode !== 0) return null
    return /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(String(remote.stdout ?? '').trim())?.[1] ?? null
  } catch {
    return null
  }
}
