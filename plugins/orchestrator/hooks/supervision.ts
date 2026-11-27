// hooks/supervision.ts
// The shared store: one row per live session — the figures the gauge measured,
// the name the walk read, the repository of the working directory — written by
// this file's own session.measure handler and removed by its session.end, one
// file per key under the module's state root. The supervision pane below reads
// the same rows, opened on the person's word (/orchestrator-supervision or the supervision
// tool's `open`) and left as he left it: the role keeps whether its pane is open (paneStatePath),
// so a successor puts it as it was — open stays open, what he closed stays closed — and nothing
// else opens it, on a start, a turn or a wake. In a coordinator session it lists the orchestrators, and under them
// the first question of its round (round.ts); in an orchestrator session,
// that orchestrator's own agents, read from the launcher's chain and the host's
// session records; in any other role it opens nothing. The commands hold no $ of
// the writing side and read the same files through their own $.fs calls plus
// the pure row parser and the urgency sort below.
//
// The config dir, the state root, the log line, the store's I/O and the gate's
// thresholds are module-io.ts's; this file spells its own origin read and its
// own transcript-window reader, while the figures
// cross as a plain import (currentReading, no $ argument) and the name runs
// over the walk's pure core with readers built here.
import { currentReading } from './gauge.ts'
import { tripGate } from './gauge-core.ts'
import {
  roleOf, walkName, hostBasenames, hostRecordOf, blockArgv, bytesOfBase64,
  type ReadRecord, type HostNames,
} from './session-name.ts'
import { withDeadline, isDegradedPass, chainEntries, chainOwner, watchNumberOf, hostTasks } from './stop-gate.ts'
import { isTemporary, STORE_CONTRACT, staleTemporaries, removeArgv, withLockOver, writeAtomicOver } from '../core/store-io.ts'
import { commandsDirOf, isBare, isOwnCopy } from './short-names.ts'
import {
  declaredWait, parseStatus, waitPatch, clearedWait, fingerprint, relayText, gateText, gateSelfText, noStatusText, noStatusKey, heldReport, readDeliveryFacts, factsLine, coordinatorOf, chainOwnerTty, waitLabel, waitParts, localMinute, openQuestions, parseWithdrawal,
  hostStopOf, stopInTail, stopKey, stopText, type HostStop, type KeptGate, type WaitKind,
  confirmsTakeover,
} from './relay.ts'
import { receiveAsked, receiveAskedAck, receiveReply, receiveReplyAck, resendReplies } from './remote-asked.ts'
import { planOlder, planWithdrawal } from './settle.ts'
import { answerAskedFromPane, askedAsEntry, closeRound, moveAsked, nameMovedAsked, withdrawAsked, withdrawAskedIds, askedGroups, askedLines, askedLook, readAsked, type Asked } from './question.ts'
import { entryFingerprint, roundEntry, roundEntryId, roundPath, plainText, textSpans, prPieces, repositoryOwners, isDue, dueText, isRoundKind, type RoundAnswer, type RoundDelivery, type RoundEntry } from './round.ts'
import {
  remoteRowOf, rowIsNews, rowSent, parseRowSent, rowText, deliveryOf, isPeerOrigin, isMarked, parseRemoteRow,
  remoteKey, withRemote, isRemoteStale, learntOf, parseLearnt, successorOf, parseSuccessor, machineLabel, prsInFlight, prShaped, capPrs, cleanBlocks, ROW_MARKER, REMOTE_STALE_AFTER_MS,
  type RemoteRow, type LearntSuccessor, type Delivery,
} from './remote-row.ts'
import { qAskLine, qAnswerLine, qAckLine, parseQ, parseQAck, isQ, isQAck, joinLines, splitLines, seqOf, type QAck, type QEvent } from './remote-round.ts'
import { targetOf, homeArgv, stateArgv, windowOf, panesArgv, panesOf, stateAfterPr, stateAfterTurn, stateAfterMeasure, TMUX_TIMEOUT_MS, type TabState, type TabTarget } from './tab-state.ts'
import { deckOf, deckText, deckIsNews, DECK_FILE, DECK_VERSION, type Deck, type DeckUsage } from './deck.ts'
import { newBook, settle, ingest, rewind, forget, usageOf, appendedArgv, consumedOf, COST_RULE, type Price, type Prices, type UsageBook } from './usage.ts'
import { configDir, dataDir, gateEnv, logLine, moduleDir, stateDir, storeIo, writeAtomic } from './module-io.ts'
import { unattendedPaneLines, type Unattended, type UnattendedPaneLine } from '../core/pr-ledger.ts'
import { isDeckUsage, parseDeck } from '../core/deck.ts'
import { ciGatePath, ROUND_DIR } from '../core/orchestration.ts'
import { orchForm } from '../core/names.ts'
import { fieldsOf, messageOf, type Events, type Host, type On, type SessionSendResult, type Timer, type UiOpenResult } from './host.ts'
import { DECLARATIONS, type Declarations } from './wait.ts'
import type { DeclaredWait } from './stop-gate.ts'

// The host's nouns this file calls.
type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'session' | 'clock' | 'ui' | 'tool' | 'prompt'>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isFigure = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const ROLES: Record<NonNullable<SessionRow['role']>, true> = { orchestrator: true, agent: true, auditor: true, coordinator: true }
const isRole = (value: unknown): value is NonNullable<SessionRow['role']> => typeof value === 'string' && Object.hasOwn(ROLES, value)
// Every kind a session's wait takes (relay.ts), the type holding the list whole.
const WAITS: Record<WaitKind, true> = { operator: true, done: true, delivered: true, blocked: true, question: true, waiting: true }
const isWaitKind = (value: unknown): value is WaitKind => typeof value === 'string' && Object.hasOwn(WAITS, value)

// A record of the host's session registry (`<config>/sessions/<pid>.json`), its session id set.
type RegistryRecord = { sessionId: string; name: unknown; pid: unknown; startedAt: unknown }
function registryRecord(text: string): RegistryRecord | null {
  const read: unknown = JSON.parse(text)
  if (!isRecord(read) || !isText(read['sessionId']) || read['sessionId'] === '') return null
  return { sessionId: read['sessionId'], name: read['name'], pid: read['pid'], startedAt: read['startedAt'] }
}

// A price the cost rule (usage.ts COST_RULE) reads: every rate a finite number, and a tier's threshold one too.
const RATE_NAMES = COST_RULE.terms.map(term => term.rate)
function isPrice(value: unknown): value is Price {
  if (!isRecord(value) || !RATE_NAMES.every(name => isFigure(value[name]))) return false
  const above = value['above']
  return above === undefined || above === null
    || (isRecord(above) && isFigure(above['tokens']) && RATE_NAMES.every(name => above[name] === undefined || isFigure(above[name])))
}

// One row per live session, the store's whole schema. `pid` is the session's host
// process — the row lives while it does.
export type SessionRow = {
  role: 'orchestrator' | 'agent' | 'auditor' | 'coordinator' | null
  name: string | null
  pid?: string | null
  // The session's tty, the walk's: an agent's orchestrator is the chain naming it.
  tty?: string | null
  // The session's window, `<session>:@N.%N`, when it runs in a home session (the deck's focus).
  tmux?: string | null
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
  // The session's own token use (usage.ts), published by its own read (readOwnUsage) and kept
  // by the measure's merge: the deck takes every session's from here. Absent until the first
  // read completes; null when its transcript is not found.
  usage?: DeckUsage | null
  // An orchestrator's pull requests nobody attends, read at its last turn end (unattended.ts): the
  // line its context and the coordinator's facts say, and the list the pane draws in local time.
  unattended?: UnattendedView | null
}

// `open`: the pull requests its dispatch record's lines hold that the forge reads open, as `owner/name#n`, whoever
// has a watch on them: the deck lists them beside the ones its own ci-watch files cover, so a successor keeps its predecessor's.
export type UnattendedView = { at: string; line: string | null; prs: readonly Unattended[]; unread: readonly string[]; open?: readonly string[] }

// A row lives while its session's host process does: a session idle for hours —
// waiting on a long agent phase, on a CI watch — is still there, and one that
// ended without its end event (a crash, a kill) is gone the moment its pid is.
// A row written before rows carried a pid falls back to the old rule: no
// measure for an hour, no row.
export const STALE_AFTER_MS = 60 * 60 * 1000

// One process as the machine's listing shows it: its state flags and its tty
// (`??` when it has none), both null when the listing carried the pid alone.
export type ProcessState = { stat: string | null; tty: string | null }
// The listing, by pid: the pids it shows, each with its state.
export type ProcessTable = ReadonlyMap<string, ProcessState>

// The rule above as a function, pure and exported: the commands read the same
// store through their own $ (the fence forbids sharing the reader) and judge
// every row by this same rule. `alive` is the process table the caller read
// (livePidsArgv, livePids); null when that read failed, and a read that failed
// knows nothing of any pid: the row is kept, never judged dead on no evidence.
export function isStale(row: SessionRow, now: number, alive: ProcessTable | null = new Map()): boolean {
  if (row.pid) return alive !== null && !runsLive(alive, String(row.pid), row.tty)
  const at = Date.parse(row.updated_at)
  return !Number.isFinite(at) || now - at > STALE_AFTER_MS
}

// Whether `pid` still runs a session, the one reading the deck, the pane and the
// commands share. A pid in the table is not enough: a host whose tab was closed
// under the terminal's session-keeping daemon stays listed for days, exiting and
// never reaped (`?Es`, tty `??`), and its row read as a live orchestrator nine
// hours stale. A pid is live when it is listed, neither exiting (an `E` among
// its flags) nor a zombie (state `Z`), and, when the row recorded a tty, still
// on that tty: a tty lost (`??`) or another one is a session whose tab is gone.
// A row with no tty recorded is not judged on its tty: a session started off a
// terminal runs without one. A listing that carried the pid alone judges by the
// pid alone.
export function runsLive(table: ProcessTable, pid: string, tty?: string | null): boolean {
  const listed = table.get(pid)
  if (!listed) return false
  const flags = (listed.stat ?? '').replace(/^\?+/, '')
  if (flags.startsWith('Z') || flags.includes('E')) return false
  if (!tty || listed.tty === null) return true
  return listed.tty === tty.replace(/^\/dev\//, '')
}

// One ps listing every process on the machine with its state and tty, run when
// a row names a pid at all; the caller looks its pids up. Never `ps -p <the
// rows' pids>`: its exit and its output depend on the pids asked — one it
// refuses (macOS: « process id too large ») fails the whole call with nothing
// printed — so a single bad row made every live row read as dead, and the store
// reader removed them all.
export function livePidsArgv(pids: readonly string[]): string[] | null {
  return pids.some(pid => /^\d+$/.test(pid)) ? ['ps', '-A', '-o', 'pid=,stat=,tty='] : null
}

// The process table out of that ps's result, or null when the read failed: no
// result (it rejected, it timed out), a degraded pass, a non-zero exit, or a
// listing with no pid in it — ps lists itself, so an honest one is never empty.
// Null is « unknown », never « none alive »: a caller deletes nothing on it. A
// line carrying the pid alone (a listing asked for `pid=` only) has no state.
export function livePids(result: unknown): Map<string, ProcessState> | null {
  if (!isRecord(result) || result['exitCode'] !== 0) return null
  const table = new Map<string, ProcessState>()
  for (const line of String(result['stdout'] ?? '').split('\n')) {
    const [pid, stat, tty] = line.trim().split(/\s+/)
    if (pid !== undefined && /^\d+$/.test(pid)) table.set(pid, { stat: stat ?? null, tty: tty ?? null })
  }
  return table.size === 0 ? null : table
}

// The supervision pane: the id names it at the engine (the open, the render's
// requestId), the title its tab while more than one pane is open — what it
// lists, by the role it was opened in. The id's spelling is the shipped type's
// own contract — letters, digits, `_` and `-`.
const PANE_ID = 'supervision'
const PANE_TITLES = { coordinator: 'Orchestrators', orchestrator: 'Agents' } as const

// The commands that toggle the pane, as the host hands them to command.run (short-names.ts):
// the 0.80.0 form of the short name, the plugin's `supervision` file, and the bare short name of
// the installer's user command. One command for both roles, the operator's ruling 229 (« B »):
// /orchestrator:supervision alone is kept, the coordinator's own name is gone.
export const SUPERVISION_COMMANDS = [
  'orchestrator:orchestrator-supervision', 'orchestrator:supervision', 'orchestrator-supervision',
] as const

// The tool that opens or closes the same pane on the operator's plain words, called by the
// session's main thread; a subagent is refused it, as it is the rename.
export const SUPERVISION_TOOL = 'supervision'
export const PANE_MAIN_THREAD_ONLY = "only the session's main thread opens or closes the supervision pane"
const PANE_ROLES_ONLY = 'The supervision pane opens in a coordinator session (« Coord: … ») or an orchestrator session (« Orch: … ») alone.'

// The sort's one law: a row past the rotation gate outranks every row below
// it, however full each side is; within a side, the fill descends. The floor
// is any number no honest fill reaches, added to the fill so the order stays
// one comparison.
const GATE_URGENCY_FLOOR = 1000

// How often a coordinator's session reads its round for questions just due, urgent or with
// the pane closed meanwhile, rather than at the operator's next word. A one-shot clock, armed
// again by each reading.
const ROUND_WAKE_MS = 30000

// What a start or a turn end that could not tell whether this session is the coordinator logs:
// its reading then asks again (wakeTick).
const UNTOLD_LINE = 'round wake: not told yet whether this session is the coordinator; its reading asks again'

// The answer to a question asked with `ask` sent to another machine and not acknowledged is sent
// again by that same reading once its last send is this old, ANSWER_SENDS sends at most, then
// failed, both ways (remote-asked.ts).
export const ANSWER_RESEND_MS = 30000
export const ANSWER_SENDS = 3

// A coordinator's pane render that takes longer than this is logged with its duration: its reads
// are bounded one by one, and a pane held past this is one the operator sees frozen.
const PANE_RENDER_BOUND_MS = 5000

// The bound on the render's read of the origin remote (repoOf): a git that hangs costs the pane
// its links, never the render.
const REPO_READ_MS = 2000

// How often an open pane redraws on its own. A render is raised by a measure of
// this session, and a supervisor mostly waits: without a clock its rows — the
// others' fills, their ages — froze at its own last turn.
const PANE_REFRESH_MS = 20000

// How often an open coordinator's pane looks at its round. The host offers no watch on a
// file: the clock stats the round's directory, whose mtime every write moves (the module, the
// `settle` and the senders' sessions all rename a file into it), and redraws only
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
  notDelivered: 'not delivered',
  delivering: 'being delivered',
} as const
const OTHER_LABEL = WORDS.other

// How many rows tall the « Other answer » field is drawn, label included: a longer text scrolls
// within it. The host's terminal field wraps its text, and places its caret, at the pane's whole
// width less its label and its hint, whatever padding the boxes around it take: indented, its
// lines were wider than its room, cut with « … », the caret rows below them. It is drawn at the
// pane's left edge, and no scroll track (its right margin) is drawn while it is, the key line
// still pinned: across the pane's whole width, the width it wraps at is the one it has.
const ANSWER_ROWS = 4

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

// The store's root under the module's own directory (module-io.ts, moduleDir): one file per key.
export async function storeOf($: Host<'env'>): Promise<string> {
  return `${await moduleDir($)}/store`
}

// The key is the session's own: one file per session id, so two sessions
// writing at once write two files and neither merge can lose the other's row.
// The id is sanitised: the key names a file, and an id is host-generated but
// never trusted as a path.
export function sessionKey(id: string): string {
  return `sessions/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

// The row parser, the measure-file doctrine: $.fs.write is not atomic, so a
// line caught mid-write is data that parses to nothing; a row without a stamp
// is no row either — staleness cannot be judged of it, and what the end
// handler truncates must not outlive its session as a phantom.
export function parseSessionRow(text: string): SessionRow | null {
  let read: unknown
  try {
    read = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(read) || !isText(read['updated_at'])) return null
  // Each field read through its type: a field of another type reads as the empty row's.
  const field = <T>(key: string, check: (value: unknown) => value is T, fallback: T): T => {
    const value = read[key]
    return check(value) ? value : fallback
  }
  const optional = <K extends keyof SessionRow>(key: K, check: (value: unknown) => value is NonNullable<SessionRow[K]> | null): Partial<SessionRow> => {
    const value = read[key]
    return check(value) ? { [key]: value } : {}
  }
  const isUnattended = (value: unknown): value is UnattendedView | null => value === null || (isRecord(value) && isText(value['at']) && isTextOrNull(value['line'])
    && Array.isArray(value['prs']) && value['prs'].every(pr => isRecord(pr) && isText(pr['repo']) && isFigure(pr['pr']) && isTextOrNull(pr['since'])
      && (pr['waits'] === undefined || (isRecord(pr['waits']) && ['ready', 'hold', 'record'].includes(String(pr['waits']['why'])) && (pr['waits']['on'] === undefined || isText(pr['waits']['on'])))))
    && Array.isArray(value['unread']) && value['unread'].every(isText)
    && (value['open'] === undefined || (Array.isArray(value['open']) && value['open'].every(isText))))
  return {
    role: field('role', isRole, null),
    name: field('name', isText, null),
    repo: field('repo', isText, null),
    context_percent: field('context_percent', isFigure, 0),
    context_tokens: field('context_tokens', isFigure, 0),
    window: field('window', isFigure, 0),
    model: field('model', isText, ''),
    busy: read['busy'] === true,
    updated_at: read['updated_at'],
    ...(isTextOrNull(read['pid']) ? { pid: read['pid'] } : isFigure(read['pid']) ? { pid: String(read['pid']) } : {}),
    ...optional('tty', isTextOrNull),
    ...optional('tmux', isTextOrNull),
    ...optional('waiting', (value): value is WaitKind | null => value === null || isWaitKind(value)),
    ...optional('blocks', isTextOrNull),
    ...optional('waiting_since', isTextOrNull),
    ...optional('relayed', isTextOrNull),
    ...optional('machine', isTextOrNull),
    ...optional('usage', (value): value is DeckUsage | null => value === null || isDeckUsage(value)),
    ...optional('unattended', isUnattended),
  }
}

// The session's wait, in its own file beside its row (`waits/<id>`): the relay is its
// one writer, so the measure's read-merge-write of the row can never put an older wait
// back over a newer one — a lost wait was the very defect the relay ends. The name and
// the pid ride along for the coordinator's facts, which read this file alone.
// `pending` is the id of the entry sent to a coordinator on another machine and not acknowledged
// yet, with the fingerprint its acknowledgment keeps (`pending_key`): an outbox, never drawn or
// answered from here (remote-round.ts). `relayed_id` is the id of the entry that acknowledgment
// kept, so the answer to it forgets `relayed` as forgetRelayed does on the coordinator's machine.
export type WaitRecord = Pick<SessionRow, 'waiting' | 'blocks' | 'waiting_since' | 'relayed'> & { name: string | null; pid: string | null; last_waiting?: WaitKind | null; pending?: string | null; pending_key?: string | null; relayed_id?: string | null }

export function waitKey(id: string): string {
  return `waits/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

// An agent's gate crossing reported (`gates/<id>`, « reported » or empty): the measure's gate
// reports are its one writer, one at a time (reportGate), so it never races the relay's wait file.
export function gateKey(id: string): string {
  return `gates/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

// What an orchestrator last sent its coordinator of its row (`rows/<id>`, remote-row.ts):
// the send path is its one writer.
export function rowKey(id: string): string {
  return `rows/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

// The last answer of a coordinator on another machine this session took (`answered/<id>`, its
// entry's id and start): the receive path is its one writer, and it goes with the session's row.
export function answeredKey(id: string): string {
  return `answered/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

// The successor an orchestrator learnt from its « takeover confirmed » (`successors/<id>`,
// remote-row.ts): the receive path is its one writer, and it goes with the session's row.
export function successorKey(id: string): string {
  return `successors/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

// What an agent was last told of its orchestrator (`told/<agent session>`: the orchestrator's session
// and the instant, in ms), written by whichever side told it first; it goes with the agent's row.
export function toldKey(id: string): string {
  return `told/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

// Whether a successor's inherited agents are all told (`inherit/<session>`: `{"done": bool}`): written
// when the session sends its « takeover confirmed », rewritten once every one is told; none for a
// session that never took a predecessor's place. It goes with the session's row.
export function inheritKey(id: string): string {
  return `inherit/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

export function parseWaitRecord(text: string): WaitRecord | null {
  try {
    return waitRecordOf(JSON.parse(text))
  } catch {
    return null
  }
}

// A wait file's value, each field read through its type.
function waitRecordOf(read: unknown): WaitRecord | null {
  if (!isRecord(read)) return null
  // A field kept only when the file holds it, of its type: the merge (mergeWait) tells a field absent from one null.
  const kept = <K extends keyof WaitRecord>(key: K, check: (value: unknown) => value is WaitRecord[K]): Partial<WaitRecord> => {
    const value = read[key]
    return Object.hasOwn(read, key) && check(value) ? { [key]: value } : {}
  }
  const kind = (value: unknown): value is WaitKind | null => value === null || isWaitKind(value)
  return {
    name: isText(read['name']) ? read['name'] : null,
    pid: isText(read['pid']) ? read['pid'] : isFigure(read['pid']) ? String(read['pid']) : null,
    ...kept('waiting', kind),
    ...kept('last_waiting', kind),
    ...kept('blocks', isTextOrNull),
    ...kept('waiting_since', isTextOrNull),
    ...kept('relayed', isTextOrNull),
    ...kept('pending', isTextOrNull),
    ...kept('pending_key', isTextOrNull),
    ...kept('relayed_id', isTextOrNull),
  }
}

// A row as the readers show it: the wait file's fields over the row's.
export function withWait(row: SessionRow, waitText: string): SessionRow {
  const wait = parseWaitRecord(waitText)
  if (!wait) return row
  // A cleared wait keeps its blocks and start for the next same wait; readers see none.
  const waiting = wait.waiting === 'operator' || wait.waiting === 'done' ? wait.waiting : null
  const on = waiting !== null
  return { ...row, waiting, blocks: on ? wait.blocks ?? null : null, waiting_since: on ? wait.waiting_since ?? null : null, relayed: wait.relayed ?? null }
}

async function readWait($: Host<'env' | 'fs'>, id: string): Promise<WaitRecord | null> {
  const read = parseWaitRecord(String(await $.fs.read(`${await storeOf($)}/${waitKey(id)}`).catch(() => '')))
  seenWaits.set(id, read)
  return read
}

// What this process last read or wrote of each wait file: the base of its next write's merge.
const seenWaits = new Map<string, WaitRecord | null>()

// A write of a wait file merged with what another process wrote since this one read it: the
// file has writers in several processes (its session's relay, the coordinator's hooks forgetting
// a fingerprint, the coordinator's `settle`), and a write computed from an older read put back
// a fingerprint another had just forgotten. A field this write leaves as it read it, and that the
// file now holds otherwise, keeps the file's value; every other field is this write's.
export function mergeWait(seen: WaitRecord | null | undefined, now: WaitRecord | null, record: WaitRecord): WaitRecord {
  if (!seen || !now) return record
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const merged: Record<string, unknown> = { ...record }
  const [wasOf, isOf, mineOf] = [seen, now, record].map(r => new Map<string, unknown>(Object.entries(r)))
  for (const key of new Set([...Object.keys(record), ...Object.keys(now), ...Object.keys(seen)])) {
    const [was, is, mine] = [wasOf?.get(key), isOf?.get(key), mineOf?.get(key)]
    if (same(mine, was) && !same(is, was)) {
      if (is === undefined) delete merged[key]
      else merged[key] = is
    }
  }
  return waitRecordOf(merged) ?? record
}

// Written under the file's lock, merged (mergeWait), through a temporary file and one rename —
// $.fs.write is not atomic, and a wait caught mid-write would read as none.
async function writeWait($: Host<'clock' | 'env' | 'fs' | 'process'>, id: string, record: WaitRecord): Promise<void> {
  const path = `${await storeOf($)}/${waitKey(id)}`
  const io = storeIo($)
  await withLockOver(io, path, async () => {
    const merged = mergeWait(seenWaits.get(id), parseWaitRecord((await io.read(path)) ?? ''), record)
    await writeAtomicOver(io, path, JSON.stringify(merged) + '\n')
    seenWaits.set(id, merged)
  })
}

// A round entry read again and written under its lock, so its writers on this machine — the pane
// answering, its sender withdrawing or moving it, a delivery's outcome, the coordinator's script
// closing it — never write over each other's change: `change` is handed the entry as it stands
// (null when there is none, or it does not parse) and answers the entry to write, or null to
// leave it. Answers what was written.
async function changeEntry($: Host<'clock' | 'fs' | 'process'>, path: string, change: (entry: RoundEntry | null) => RoundEntry | null | Promise<RoundEntry | null>): Promise<RoundEntry | null> {
  const io = storeIo($)
  return withLockOver(io, path, async () => {
    const next = await change(parseRoundEntry((await io.read(path)) ?? ''))
    if (next) await writeAtomicOver(io, path, JSON.stringify(next) + '\n')
    return next
  })
}

// writeSession reads the key's file, merges the patch over what it finds and
// writes it back stamped: per-key writes do not collide across sessions, and
// the stamp the row is judged stale by is the write's own unless the patch
// carries one (the measure handler passes the reading's own time). The
// measure handler is the only writer of a key: a same-key race is last-writer-wins,
// at most one measure of freshness. The relay writes its own file (writeWait).
// The row is written atomically (writeAtomic), its temporary file named and its line
// spelled as the launcher's row_write does (iterm_agent.py): a reader never meets a
// row caught mid-write.
export async function writeSession($: Host<'clock' | 'env' | 'fs' | 'process'>, id: string, patch: Partial<SessionRow>): Promise<void> {
  await onOwnRow(async () => {
    const path = `${await storeOf($)}/${sessionKey(id)}`
    const base: SessionRow = parseSessionRow(String(await $.fs.read(path).catch(() => ''))) ?? {
      role: null, name: null, repo: null,
      context_percent: 0, context_tokens: 0, window: 0,
      model: '', busy: false, updated_at: '',
    }
    const row: SessionRow = { ...base, ...patch, updated_at: patch.updated_at ?? new Date().toISOString() }
    await writeAtomic($, path, JSON.stringify(row) + '\n')
  })
}

// The row has two writers in its own session's process, the measure and the usage read
// (publishUsage): their read-merge-writes run one after the other, so neither puts back a
// field the other just wrote.
let ownRowWrites: Promise<unknown> = Promise.resolve()
function onOwnRow<T>(work: () => Promise<T>): Promise<T> {
  const run = ownRowWrites.then(work, work)
  ownRowWrites = run.catch(() => undefined)
  return run
}

// The usage read's answer, into the session's own row: the row's stamp is the measure's and
// stays; a row gone meanwhile (the session ended) is not written again, nor one that carries
// no usage and gets none (the deck reads both as null).
async function publishUsage($: Host<'clock' | 'env' | 'fs' | 'process'>, id: string, usage: DeckUsage | null): Promise<void> {
  await onOwnRow(async () => {
    const path = `${await storeOf($)}/${sessionKey(id)}`
    const row = parseSessionRow(String(await $.fs.read(path).catch(() => '')))
    if (row && (usage || row.usage)) await writeAtomic($, path, JSON.stringify({ ...row, usage }) + '\n')
  })
}

// The turn end's reading of the pull requests nobody attends, into the session's own row: the
// row's stamp is the measure's and stays; a row gone meanwhile (the session ended) is not written again.
export async function publishUnattended($: Host<'clock' | 'env' | 'fs' | 'process'>, id: string, view: UnattendedView): Promise<void> {
  await onOwnRow(async () => {
    const path = `${await storeOf($)}/${sessionKey(id)}`
    const row = parseSessionRow(String(await $.fs.read(path).catch(() => '')))
    if (row) await writeAtomic($, path, JSON.stringify({ ...row, unattended: view }) + '\n')
  })
}

// One row per live session: every file under the store's sessions directory,
// minus the dead (isStale) and the unreadable (a line caught mid-write). The
// files of the dead and the empty ones are removed as they are met — $.fs has
// no remove, rm does — so the store does not grow with every session the
// machine ever ran.
export async function readSessions($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>): Promise<Record<string, SessionRow>> {
  return (await readStore($)).rows
}

// The same read, with what the pane traces beside the rows: each file it left out, by its key,
// with the reason (`dropped`), and the process table it judged them by (`alive`, null when that
// read failed, and no table at all when no row named a pid and none was read).
export type StoreRead = { rows: Record<string, SessionRow>; dropped: Map<string, string>; alive: ProcessTable | null | undefined }

// Why a row the read met is no live row: empty, caught mid-write, or stale by the rule above.
function droppedReason(text: string, row: SessionRow | null, alive: StoreRead['alive']): string {
  if (text === '') return 'empty'
  if (!row) return 'unreadable'
  if (!row.pid) return 'stale, no pid and no measure for an hour'
  const listed = alive instanceof Map && alive.has(String(row.pid))
  const where = row.tty ? ` on ${row.tty}` : ''
  return listed ? `stale pid ${row.pid}: exiting, or no longer${where}` : `stale pid ${row.pid}: not running${where}`
}

async function readStore($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>): Promise<StoreRead> {
  const dir = `${await storeOf($)}/sessions`
  let entries: { name: string; kind: string; mtimeMs?: number }[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return { rows: {}, dropped: new Map(), alive: undefined }   // no store yet: nothing was ever written
  }
  const read: [string, string, SessionRow | null][] = []
  // A temporary file is a row write in flight (writeAtomic): no second row, and removed only once
  // it is older than any write takes (staleTemporaries), or a live writer's rename fails.
  const stale = staleTemporaries(dir, entries, Date.now())
  for (const entry of entries) {
    if (!entry || entry.kind !== 'file' || isTemporary(entry.name)) continue
    const text = String(await $.fs.read(`${dir}/${entry.name}`).catch(() => ''))
    const row = parseSessionRow(text)
    const waits = `${await storeOf($)}/waits/${entry.name}`
    read.push([entry.name, text, row && withWait(row, String(await $.fs.read(waits).catch(() => '')))])
  }
  const argv = livePidsArgv(read.map(([, , row]) => String(row?.pid ?? '')))
  const alive = argv ? livePids(await $.process.run(argv, { timeoutMs: 5000 }).catch(() => null)) : undefined
  const rows: Record<string, SessionRow> = {}
  const dropped = new Map<string, string>()
  const dead: string[] = []
  // Each row judged dead, with the successor its session learnt: read before the sweep removes it.
  const gone = new Map<string, LearntSuccessor | null>()
  const now = Date.now()
  for (const [name, text, row] of read) {
    if (row && !isStale(row, now, alive)) {
      rows[`sessions/${name}`] = row
      continue
    }
    dropped.set(`sessions/${name}`, droppedReason(text, row, alive))
    if (text === '' || row) {
      // A row with no pid removed for idleness alone is not known dead: its sender may live on,
      // and keeps the successor it learnt for its own later end.
      const known = text === '' || !!row?.pid
      if (known) gone.set(`sessions/${name}`, parseSuccessor(String(await $.fs.read(`${await storeOf($)}/successors/${name}`).catch(() => ''))))
      dead.push(`${dir}/${name}`, `${await storeOf($)}/waits/${name}`, `${await storeOf($)}/gates/${name}`, `${await storeOf($)}/rows/${name}`, `${await storeOf($)}/told/${name}`, `${await storeOf($)}/inherit/${name}`)
      if (known) dead.push(`${await storeOf($)}/successors/${name}`)
    }
  }
  // A liveness read that failed removes nothing: its rows are drawn as alive
  // and the next read that answers sweeps the dead. Removing on it wiped the
  // whole store at every render the pane drew.
  // A temporary file a dead writer left is removed whatever the liveness read gave.
  const removed = [...stale, ...(alive !== null ? dead : [])]
  if (removed.length > 0) await $.process.run(removeArgv(...removed), { timeoutMs: 5000 }).catch(() => undefined)
  if (alive !== null && gone.size > 0) await sweepGoneSenders($, gone)
  return { rows, dropped, alive }
}

// The entries a session left open and no session end closed (a killed host, a tab closed with no
// clean end, an end past its bound): every open entry of this machine whose sender's row this read
// has just judged dead and removed is withdrawn, on the read every reader makes — the sender
// `co round` prints as « sender gone » — or, its sender having learnt a successor, moved to that
// successor, as the sender's own end would have done. Only a row removed here is judged: a
// session not yet measured (a successor an entry was moved to) has no row and is not gone. An
// entry naming no session, or from another machine, is not judged. A sweep that fails is one log
// line and the read goes on.
async function sweepGoneSenders($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, removed: ReadonlyMap<string, LearntSuccessor | null>): Promise<void> {
  try {
    const senders = new Set<string>()
    for (const { entry } of await readRound($)) {
      if (entry.status === 'open' && entry.session !== '' && !entry.origin && removed.has(sessionKey(entry.session))) senders.add(entry.session)
    }
    for (const sessionId of senders) {
      const successor = removed.get(sessionKey(sessionId)) ?? null
      const settled = successor
        ? await moveToSuccessor($, sessionId, successor)
        : await withdrawStale($, sessionId, null, "the sender's session ended")
      await tellSettled($, settled, Date.now() + RELAY_BOUND_MS)
    }
  } catch (err) {
    await logLine($, 'supervision', `round: ${messageOf(err)}`)
  }
}

// The session's own row goes with it: removed, or — rm failing — replaced by an empty file in one
// rename (a link planted at the row is replaced, its target untouched), which the row parser reads
// as no row and the next read removes.
export async function deleteSession($: Host<'clock' | 'env' | 'fs' | 'process'>, id: string): Promise<void> {
  const path = `${await storeOf($)}/${sessionKey(id)}`
  const store = await storeOf($)
  const done = await $.process.run(['rm', '-f', path, `${store}/${waitKey(id)}`, `${store}/${gateKey(id)}`, `${store}/${rowKey(id)}`, `${store}/${successorKey(id)}`, `${store}/${answeredKey(id)}`, `${store}/${toldKey(id)}`, `${store}/${inheritKey(id)}`], { timeoutMs: 5000 }).catch(() => null)
  if (!done || done.exitCode !== 0) await writeAtomic($, path, '')
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
  // The pull requests nobody attends its last turn end read, in local time, one to a line; null when none.
  unattended: UnattendedPaneLine[] | null
}

// A row's unattended pull requests as the pane says them, in local time: the head « Attend ton geste » on
// its own line, then one pull request to a line, « En anomalie » and its own after; only the anomaly alarms.
export function unattendedOfRow(row: SessionRow): UnattendedPaneLine[] | null {
  const lines = row.unattended ? unattendedPaneLines(row.unattended.prs, row.unattended.unread, localMinute) : []
  return lines.length === 0 ? null : lines
}

// A line cut to `room` cells with an ellipsis, never wrapped; whole when the room is not told.
export function cutLine(text: string, room: number): string {
  return room > 0 && text.length > room ? `${text.slice(0, room - 1)}…` : text
}

// The width of the label column of the unattended lines (the longest label, « En conflit », and a gap).
const UNATTENDED_LABEL_COLUMN = 11

// A line's words as drawn in `room` cells: a group of pull requests as it is, for the host to wrap; one
// pull request with what it waits on cut to the room left, so that its time, last, stays whole.
export function unattendedText(line: UnattendedPaneLine, room: number): string {
  if (line.wraps) return line.text
  const tail = line.time === undefined ? '' : ` · ${line.time}`
  const left = room - line.text.length - tail.length - 2
  const on = line.on === undefined ? '' : room <= 0 ? `  ${line.on}` : left < 1 ? '' : `  ${cutLine(line.on, left)}`
  return `${line.text}${on}${tail}`
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
        unattended: unattendedOfRow(row),
      }
    })
    .sort((a, b) => b.urgency - a.urgency)
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
// tab wrote (the owner is the terminal session's id, the turn end's rule — no
// owner, no entry counted: a recycled tty's occupant would be), each read
// through the process on the agent's tty to the host's record of it, and that
// session's store row. An entry no live session answers for is an agent gone.
async function agentViews($: Host<'env' | 'fs' | 'process'>, tty: string): Promise<AgentView[]> {
  const owner = await chainOwner($)
  if (!owner) return []
  return (await chainAgents($, tty, owner)).map(({ name, status, row }) => ({ name, status, row }))
}

// The live agents of the chain kept under `tty` (those `owner` launched, or every one when null),
// each by the host's record of the session on its tty.
async function chainAgents($: Host<'env' | 'fs' | 'process'>, tty: string, owner: string | null): Promise<(AgentView & { sessionId: string; startedAt: number | null })[]> {
  const config = await configDir($)
  const state = await dataDir($)
  const chain = String(await $.fs.read(`${state}/chains/${tty.split('/').pop()}.jsonl`).catch(() => ''))
  const views: (AgentView & { sessionId: string; startedAt: number | null })[] = []
  for (const entry of chainEntries(chain)) {
    if (owner !== null && entry.owner !== owner) continue
    const ps = await $.process.run(['ps', '-t', entry.tty.replace(/^\/dev\//, ''), '-o', 'pid='])
    if (ps.exitCode !== 0) continue
    for (const pid of String(ps.stdout ?? '').split('\n').map((line: string) => line.trim().split(/\s+/)[0] ?? '').filter((pid: string) => /^\d+$/.test(pid))) {
      const record = hostRecordOf(String(await $.fs.read(`${config}/sessions/${pid}.json`).catch(() => '')))
      if (!record || !record.sessionId) continue
      const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(record.sessionId)}`).catch(() => '')))
      // The host's record says the agent lives: its row is shown whatever its age.
      views.push({ name: record.name, status: record.status, row, sessionId: record.sessionId, startedAt: record.startedAt ?? null })
      break
    }
  }
  return views
}

// The line an agent is sent when its orchestrator's successor confirmed the takeover.
export function successorText(successor: { name: string; session: string | null }): string {
  return `[module] Your orchestrator is now ${successor.name}${successor.session ? ` (session ${successor.session})` : ''}: it confirmed the takeover. Send your reports, questions and deliveries to it; the previous one takes no more.`
}

// What an agent was last told of its orchestrator, or null when the store holds nothing.
type Told = { session: string; at: number }
function parseTold(text: string): Told | null {
  try {
    const value = JSON.parse(text) as { session?: unknown; at?: unknown }
    return typeof value.session === 'string' && typeof value.at === 'number' ? { session: value.session, at: value.at } : null
  } catch {
    return null
  }
}

// One agent sent the line that names its orchestrator now, and the fact recorded once it was
// delivered: a refused or failed send is one log line, the agent left untold for the next try.
async function tellAgent($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, agent: { name: string | null; sessionId: string }, successor: { name: string; session: string | null }): Promise<boolean> {
  let sent: { isDelivered: boolean; reason?: string | undefined } | null | undefined
  try {
    sent = await $.session.send({ to: { sessionId: agent.sessionId }, text: successorText(successor) })
  } catch (err) {
    sent = { isDelivered: false, reason: messageOf(err) }
  }
  if (!sent?.isDelivered) {
    await logLine($, 'supervision', `successor: ${agent.name ?? agent.sessionId} not told: ${sent?.reason ?? 'no answer'}`)
    return false
  }
  try {
    await writeAtomic($, `${await storeOf($)}/${toldKey(agent.sessionId)}`, JSON.stringify({ session: successor.session ?? '', at: Date.now() }) + '\n')
  } catch (err) {
    await logLine($, 'supervision', `successor: ${agent.name ?? agent.sessionId} told, not recorded: ${messageOf(err)}`)
  }
  return true
}

const toldOf = async ($: Host<'env' | 'fs'>, agentSession: string): Promise<Told | null> =>
  parseTold(String(await $.fs.read(`${await storeOf($)}/${toldKey(agentSession)}`).catch(() => '')))

/*
 * At a successor's « takeover confirmed », the agents of the chain are told who their orchestrator
 * is now: the chain the launcher handed to the successor's tty, and what is left under this
 * session's own. An agent the successor's own session was already recorded as telling is not told twice.
 */
async function tellAgentsSuccessor($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, sessionId: string, successor: { name: string; session: string | null }): Promise<void> {
  const own = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
  const theirs = successor.session ? parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(successor.session)}`).catch(() => ''))) : null
  const ttys = [...new Set([theirs?.tty, own?.tty].flatMap(tty => (tty ? [tty] : [])))]
  const told = new Set<string>([sessionId, ...(successor.session ? [successor.session] : [])])
  for (const tty of ttys) {
    for (const agent of await chainAgents($, tty, null)) {
      if (told.has(agent.sessionId) || roleOf(agent.name) !== 'agent') continue
      told.add(agent.sessionId)
      if (successor.session !== null && (await toldOf($, agent.sessionId))?.session === successor.session) continue
      await tellAgent($, agent, successor)
    }
  }
}

const inheritOf = async ($: Host<'env' | 'fs'>, session: string): Promise<{ done: boolean } | null> => {
  try {
    const value = JSON.parse(String(await $.fs.read(`${await storeOf($)}/${inheritKey(session)}`).catch(() => ''))) as { done?: unknown }
    return typeof value.done === 'boolean' ? { done: value.done } : null
  } catch {
    return null
  }
}

// The sessions whose inherited agents a pass is telling now: a pass past its bound runs on, and no
// second one starts beside it, so an agent is never sent the line twice.
const telling = new Set<string>()

/*
 * A successor's own module tells the agents it inherited, the case the predecessor's never could:
 * it died or was closed before it received « takeover confirmed ». The session is a successor from
 * the moment it sends that message itself (`inherit/<session>`, written then). The facts are the
 * chain its tty holds, kept by its own tab's owner, and the host's record of each agent's start: an
 * agent that started before this session is inherited. One line each, recorded under
 * `told/<agent session>`; an agent the predecessor's module told already (it recorded its successor's
 * session, or the instant after this session started) is passed. A line the send did not reach leaves
 * the session pending: the next measure runs the pass again, and nothing runs after every agent is told.
 */
async function tellInheritedAgents($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, sessionId: string, name: string, pid: string, tty: string): Promise<void> {
  if (telling.has(sessionId)) return
  telling.add(sessionId)
  try {
    const config = await configDir($)
    const owner = await chainOwner($)
    const started = hostRecordOf(String(await $.fs.read(`${config}/sessions/${pid}.json`).catch(() => '')))?.startedAt
    if (!owner || started === undefined) {
      await logLine($, 'supervision', `successor: inherited agents not read: ${owner ? 'no start in the host record' : 'no chain owner'}`)
      return
    }
    let pending = false
    for (const agent of await chainAgents($, tty, owner)) {
      if (agent.sessionId === sessionId || roleOf(agent.name) !== 'agent' || agent.startedAt === null || agent.startedAt >= started) continue
      const told = await toldOf($, agent.sessionId)
      if (told !== null && (told.session === sessionId || (told.session === '' && told.at >= started))) continue
      if (!(await tellAgent($, agent, { name, session: sessionId }))) pending = true
    }
    await writeAtomic($, `${await storeOf($)}/${inheritKey(sessionId)}`, JSON.stringify({ done: !pending }) + '\n')
  } finally {
    telling.delete(sessionId)
  }
}

// The bound on this file's side reads — the name walk, the origin read — the
// guards' own deadline convention inherited at the Task 9 review's word: well
// inside the ten seconds a handler owns, so a read that cannot answer in time
// is quietly no name (no repository), never a late row or a held measure. The
// operator's env knob turns it, milliseconds like its name says.
async function sideReadBoundMs($: Host<'env'>): Promise<number> {
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
async function walkWithinBound($: Host<'env' | 'fs' | 'process'>, sessionId: string):
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
// « other answer » was pressed (their ids: the hint is drawn under them), the questions whose
// answer is in flight, so a second press on one does nothing, and
// the entry whose « Other answer » was picked, its text field drawn until the ring leaves it.
export type PaneMemory = {
  opened: { role: 'coordinator' | 'orchestrator'; tty: string | null; name: string; pid: string | null } | null
  ticker: { cancel(): void } | null
  other: Set<string>
  writing: string | null
  answering: Set<string>
  // The content last drawn, as the module counts its rows, and the tree's height as the
  // person's last move measured it, with the content it measured.
  drawn?: string
  // The clock's ticks since the pane was last drawn, and the round directory's mtime that draw
  // read: the clock redraws when the first reaches PANE_REFRESH_MS or the second moves.
  ticksSinceDraw?: number
  roundSeen?: number | null
  measure?: { contentRows: number; drawn: string }
  // The role's pane put as it was left, once per module life (restorePane).
  restored?: boolean
}

function freshPane(): PaneMemory {
  return { opened: null, ticker: null, other: new Set(), writing: null, answering: new Set() }
}

// The pane opened, by his word or to put it as its role left it: the role it lists, its title, its
// clock, the role's state and, for a coordinator's, its record.
async function openPane($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, pane: PaneMemory, role: 'coordinator' | 'orchestrator', tty: string | null, pid: string | null, name: string): Promise<UiOpenResult | undefined> {
  pane.opened = { role, tty, name, pid }
  await keepPaneState($, name, true)
  // With the keys, so the picker answers at once: the host grants them only over an empty
  // prompt, never taking text the operator is typing.
  const placed = await $.ui.open({ id: PANE_ID, title: PANE_TITLES[role], focus: true })
  startTicker($, pane)
  if (role === 'coordinator') await keepPaneRecord($, pid, tty, 'the pane opened')
  return placed
}

// A pane the host shows already, opened by no call of this one: the module takes it as its own, so
// that it draws its role's list on its clock, and writes its record when the one there is dead.
async function takeShownPane($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, pane: PaneMemory, role: 'coordinator' | 'orchestrator', tty: string | null, pid: string | null, name: string): Promise<void> {
  pane.opened = { role, tty, name, pid }
  await keepPaneState($, name, true)
  if (!pane.ticker) startTicker($, pane)
  $.ui.invalidate('ui.render')
  if (role === 'coordinator' && (await paneRecordState($)) === 'dead') await keepPaneRecord($, pid, tty, 'the pane shown had no live record')
}

function startTicker($: Host<'clock' | 'env' | 'fs' | 'ui'>, pane: PaneMemory): void {
  // No round read yet: an absent round is no move, and a draw that throws before reading it
  // leaves nothing that moves at every tick.
  pane.roundSeen = null
  pane.ticker?.cancel()
  pane.ticker = $.clock.every(PANE_ROUND_POLL_MS, () => paneTick($, pane))
}

// One tick of the pane's clock: a pane never drawn, or drawn PANE_REFRESH_MS ago, is redrawn;
// a coordinator's is also redrawn when its round's directory moved since the last draw, the move
// recorded at once, so a draw that fails is retried once per move, never at every tick.
function paneTick($: Host<'env' | 'fs' | 'ui'>, pane: PaneMemory): void {
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
async function roundMtime($: Host<'env' | 'fs'>): Promise<number | null> {
  try {
    const stat = await $.fs.stat(`${await dataDir($)}/${ROUND_DIR}`)
    return typeof stat?.mtimeMs === 'number' ? stat.mtimeMs : null
  } catch {
    return null
  }
}

// The pane open at the host, and its close by the command or the tool: the clock stops and a
// coordinator's record goes with it.
async function paneShown($: Host<'ui'>): Promise<boolean> {
  const panes: readonly { id: string }[] = await $.ui.panes()
  return panes.some(open => open.id === PANE_ID)
}

async function closeShown($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, pane: PaneMemory, name: string): Promise<void> {
  pane.ticker?.cancel()
  pane.ticker = null
  await keepPaneState($, name, false)
  await $.ui.close({ id: PANE_ID })
  await recordPaneClosed($).catch((err: unknown) => logLine($, 'supervision', `pane: ${messageOf(err)}`))
}

// Whether a role's pane is open is the role's, not the session's: `<state>/pane-open-<name>`, the
// name without its reference, which a successor carries, is there while the pane is open and gone
// once he closed it. The host's panes end with the session that drew them; this file is what lets
// the successor's first turn put the pane as it was (restorePane). Only his word writes it — the
// command, the tool, his ✕ — never the close the host makes when a session ends.
function paneStatePath(state: string, name: string): string {
  return `${state}/pane-open-${orchForm(name).replace(/[^A-Za-z0-9._-]/g, '_')}`
}

async function keepPaneState($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process'>, name: string, open: boolean): Promise<void> {
  const path = paneStatePath(await dataDir($), name)
  try {
    if (open) await writeAtomic($, path, 'open\n')
    else {
      const done = await $.process.run(removeArgv(path), { timeoutMs: 5000 })
      if (done.exitCode !== 0) throw new Error(`${path} was not removed`)
    }
  } catch (err) {
    await logLine($, 'supervision', `pane: the pane's state could not be kept: ${messageOf(err)}`)
  }
}

// The pane put as its role left it, at the first turn start of a session whose role has one: when
// the state says open, opened where the host shows no pane, taken as the module's own where it
// shows one (a module started over). A session that is neither coordinator nor orchestrator, and
// a role whose pane he closed, are left as they are.
async function restorePane($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, pane: PaneMemory): Promise<void> {
  if (pane.restored) return
  const { tty, name, pid } = await walkWithinBound($, await $.session.id())
  // A walk that did not answer is tried again at the next turn's start.
  if (name === null) return
  pane.restored = true
  const role = roleOf(name)
  if (role !== 'coordinator' && role !== 'orchestrator') return
  if (!(await $.fs.exists(paneStatePath(await dataDir($), name)))) return
  if (await paneShown($)) await takeShownPane($, pane, role, tty, pid, name)
  else await openPane($, pane, role, tty, pid, name)
}

// The coordinator's pane as `coordinator.sh round` reads it, `<state>/pane.json`: the session
// whose pane is open, its host pid and the tty of its tab, the script holding the pane open while
// that pid still runs a session on that tty. Without it every question is due in the tab at once,
// there being no pane to answer it in.
export type PaneRecord = { session: string; pid: string; tty?: string | null; at: string }

async function panePath($: Host<'env'>): Promise<string> {
  return `${await dataDir($)}/pane.json`
}

// A record that could not be written is said, and holds up nothing else.
async function keepPaneRecord($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, pid: string | null, tty: string | null, why: string): Promise<void> {
  await recordPaneOpen($, pid, tty, why).catch((err: unknown) => logLine($, 'supervision', `pane: ${messageOf(err)}`))
}

// A pane whose pid is unknown is not recorded: a record naming none is no pane to the script.
async function recordPaneOpen($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, pid: string | null, tty: string | null, why: string): Promise<void> {
  if (!pid) {
    await logLine($, 'supervision', 'pane: no host pid read for this session; the pane is not recorded open')
    return
  }
  const record: PaneRecord = { session: await $.session.id(), pid, ...(tty ? { tty } : {}), at: new Date().toISOString() }
  await writeAtomic($, await panePath($), JSON.stringify(record) + '\n')
  await logLine($, 'supervision', `pane: recorded open, pid ${pid}${tty ? ` on ${tty}` : ''}: ${why}`)
}

// The record of this session's pane, when it is this session's: another coordinator's is left.
async function readPaneRecord($: Host<'env' | 'fs' | 'session'>): Promise<PaneRecord | null> {
  try {
    const read: unknown = JSON.parse(String(await $.fs.read(await panePath($))))
    if (!isRecord(read) || !isText(read['session']) || !isText(read['pid']) || !isText(read['at']) || !isTextOrNull(read['tty'] ?? null)) return null
    const tty = read['tty']
    const record: PaneRecord = { session: read['session'], pid: read['pid'], at: read['at'], ...(isTextOrNull(tty) ? { tty } : {}) }
    return record.session === await $.session.id() ? record : null
  } catch {
    return null
  }
}

async function recordPaneClosed($: Host<'env' | 'fs' | 'plugin' | 'process' | 'session'>): Promise<void> {
  if (!(await readPaneRecord($))) return
  const done = await $.process.run(['rm', '-f', await panePath($)], { timeoutMs: 5000 }).catch(() => null)
  if (!done || done.exitCode !== 0) await logLine($, 'supervision', `pane: the record ${await panePath($)} could not be removed`)
  else await logLine($, 'supervision', 'pane: the record removed with this session\'s pane')
}

// The pane record's process, whichever session wrote it: `live`, its pid still runs a session;
// `dead`, a record absent, unreadable or naming no pid, which asks no listing, or one whose pid
// the machine's listing does not hold, or holds as exiting or a zombie, or on another tty than the
// record's (a host whose tab was closed stays listed for days under the terminal's session-keeping
// daemon: runsLive's rule); `unknown`, the listing failed. Only a `dead` record is written over.
async function paneRecordState($: Host<'env' | 'fs' | 'process'>): Promise<'live' | 'dead' | 'unknown'> {
  let pid: string
  let tty: string | null = null
  try {
    const record: unknown = JSON.parse(String(await $.fs.read(await panePath($))))
    pid = String(isRecord(record) ? record['pid'] ?? '' : '')
    if (isRecord(record) && isText(record['tty'])) tty = record['tty']
  } catch {
    return 'dead'
  }
  const argv = livePidsArgv([pid])
  if (!argv) return 'dead'
  const alive = livePids(await $.process.run(argv, { timeoutMs: 5000 }).catch(() => null))
  if (alive === null) return 'unknown'
  return runsLive(alive, pid, tty) ? 'live' : 'dead'
}

// The coordinator's pane as `coordinator.sh round` judges it (its pane_open): a live record alone.
// A listing that failed is no pane, as the script's own ps failing is.
async function paneIsOpen($: Host<'env' | 'fs' | 'process'>): Promise<boolean> {
  return (await paneRecordState($)) === 'live'
}

// Whether a coordinator is live on this machine, from coordinator.sh's record (<state>/coordinator.json):
// one that names a coordinator whose process still runs a session on its recorded tty (runsLive).
// What cannot be told is live, since a coordinator read as gone loses its questions to another
// session: a record that exists and cannot be read, one naming no pid, a listing that failed.
// No record, or an empty one, is none.
export async function coordinatorRuns($: Host<'env' | 'fs' | 'process'>): Promise<boolean> {
  const path = `${await stateDir($)}/coordinator.json`
  let text: string
  try {
    text = String(await $.fs.read(path))
  } catch {
    return await $.fs.exists(path).catch(() => true)
  }
  if (!coordinatorOf(text)) return false
  // coordinatorOf parsed this text: it is an object, or its name would be none.
  const record = JSON.parse(text) as Record<string, unknown>
  const pid = String(record['pid'] ?? '')
  const tty = isText(record['tty']) ? record['tty'] : null
  const argv = livePidsArgv([pid])
  if (!argv) return true
  const alive = livePids(await $.process.run(argv, { timeoutMs: 5000 }).catch(() => null))
  return alive === null || runsLive(alive, pid, tty)
}

// The record follows the pane this host shows, both ways. A coordinator's pane the module draws,
// with its record gone, or naming another session whose process is known to run no more, is
// recorded again: there is one record for the machine, and a second session of the role (two
// successors started together) writes over it and removes it as its own when it ends. Another
// session's is left while its process runs, or while the listing cannot say.
//
// A record that says open while this host shows no such pane is removed: the pane went with no
// close of the module's (the host's own, a tab or a session gone, a clear that gave the session
// another id), and a record left behind held every question back from the tab for as long as the
// host process lived. Only the record this session or this host wrote is judged, another live
// coordinator's is its own; a host that cannot say which panes it shows leaves the record, said in
// the log. Read at each wake, each turn and each start, so that `coordinator.sh round` never reads
// a pane that is not there.
async function reconcilePaneRecord($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>): Promise<void> {
  let record: unknown = null
  let text = ''
  try {
    text = String(await $.fs.read(await panePath($)))
    record = JSON.parse(text)
  } catch {
    // No record, or one that cannot be read: it names no pane.
  }
  const drawn = shownPane.opened?.role === 'coordinator' ? shownPane.opened : null
  if (!isRecord(record) && !drawn) return
  try {
    if (await paneShown($)) {
      // A pane whose pid was not read at its open was said then: nothing to record it with.
      if (drawn?.pid && (!isRecord(record) || (record['session'] !== await $.session.id() && (await paneRecordState($)) === 'dead'))) {
        await keepPaneRecord($, drawn.pid, drawn.tty, 'the pane shown had no live record')
      }
      return
    }
    if (!isRecord(record)) return
    const pid = String(record['pid'] ?? '')
    const mine = record['session'] === await $.session.id()
    const self = mine || pid === '' ? null : await recordedCoordinator($)
    const own = mine || (typeof self === 'object' && self !== null && String(self.pid ?? '') === pid)
    if (!own) return
    // An open that finished while this ran wrote a new record: it is the pane's, not removed.
    if (String(await $.fs.read(await panePath($)).catch(() => '')) !== text) return
    const done = await $.process.run(['rm', '-f', await panePath($)], { timeoutMs: 5000 }).catch(() => null)
    if (!done || done.exitCode !== 0) await logLine($, 'supervision', `pane: the record ${await panePath($)} could not be removed`)
    else await logLine($, 'supervision', 'pane: the record said open while the host shows no pane; removed')
  } catch (err) {
    await logLine($, 'supervision', `pane: the record could not be checked: ${messageOf(err)}`)
  }
}

// The entries the coordinator was woken for, `<state>/round-woken.json`, a JSON list of ids: in
// the state directory, not the host's state of one session, so that neither a reload of the
// module nor a successor coordinator wakes twice for one entry. A file absent or unreadable is
// none woken for.
async function wokenPath($: Host<'env'>): Promise<string> {
  return `${await dataDir($)}/round-woken.json`
}

async function readWoken($: Host<'env' | 'fs'>): Promise<string[]> {
  return readIds($, await wokenPath($))
}

async function readIds($: Host<'fs'>, path: string): Promise<string[]> {
  try {
    const ids: unknown = JSON.parse(String(await $.fs.read(path)))
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

// Ids added to a list file under its lock, the list read again first: two coordinators at a
// succession write the same lists, and a list written from an older read lost the other's ids.
// Only the ids `keep` holds stay (the round's present entries), so the list never outgrows it.
async function addIds($: Host<'clock' | 'fs' | 'process'>, path: string, ids: readonly string[], keep: (id: string) => boolean): Promise<void> {
  const io = storeIo($)
  await withLockOver(io, path, async () => {
    let listed: string[] = []
    try {
      const read: unknown = JSON.parse((await io.read(path)) ?? '[]')
      if (Array.isArray(read)) listed = read.filter((id): id is string => typeof id === 'string')
    } catch { /* a list that does not parse is none */ }
    const next = [...new Set([...listed.filter(keep), ...ids])]
    await writeAtomicOver(io, path, JSON.stringify(next) + '\n')
  })
}

// An entry entered again under the id of one that was settled, forgotten as shown: the marks of the
// coordinator's lists were the earlier entry's, and would close the new one as told when withdrawn.
async function forgetShown($: Host<'clock' | 'env' | 'fs' | 'process'>, id: string): Promise<void> {
  const state = await dataDir($)
  for (const path of [await wokenPath($), `${state}/round-listed.json`]) {
    if ((await readIds($, path)).includes(id)) await addIds($, path, [], kept => kept !== id)
  }
}

// An entry the coordinator was shown: one its `coordinator.sh round` printed open
// (`<state>/round-listed.json`, the script's own record) or one the module woke it for. Read by
// the files, never by its model's memory: a question it presented and then saw settled
// elsewhere was asked a second time (the operator's report of 2026-10-25).
async function shownToCoordinator($: Host<'env' | 'fs'>, id: string): Promise<boolean> {
  return (await readWoken($)).includes(id) || (await readIds($, `${await dataDir($)}/round-listed.json`)).includes(id)
}

// The reason an entry withdrawn by the operator's prompt in its sender's own tab records.
const TAB_ANSWER = "answered in the sender's own tab"

// Two questions are the same when their text is, whatever the spacing between the words.
const sameQuestion = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

// Two entries of one session are twins when either was moved to it at a succession and they ask
// the same question; a blank question is no question, so it never makes two entries twins.
const areTwins = (a: RoundEntry, b: RoundEntry): boolean =>
  (a.movedFrom !== undefined || b.movedFrom !== undefined) && a.question.trim() !== '' && sameQuestion(a.question, b.question)

// An entry settled in the pane or at its sender's turn end, closed by the module itself when the
// coordinator on this machine was shown it: the answer it was closed with.
export type Settled = { entry: RoundEntry; answer: RoundAnswer }

// The notice that an entry the coordinator was shown is settled and already closed: where and
// how, worded by the answer it was closed with. One line, no command to run, no operator text.
export function settledText(entry: RoundEntry, answer: RoundAnswer): string {
  const reason = answer.text.replace(/^withdrawn: /, '')
  const [where, how] = answer.by === 'pane' ? ['in the pane', `answered at ${answer.at}`]
    : answer.by === 'tab' || reason === TAB_ANSWER ? [`in ${entry.from}'s tab`, answer.typed ? `answered there: "${answer.typed.replace(/\s*\n\s*/g, ' ')}"` : 'answered there']
    : reason.startsWith('superseded by ') ? ['superseded', `by ${reason.slice('superseded by '.length)}, present that one`]
    : reason === "the sender's session ended" ? ['', 'session ended']
    : ['', reason.replace(/\s*\n\s*/g, ' ').trim() || 'withdrawn by its sender']
  return `[module] Settled${where ? ` ${where}` : ''}: ${entry.from}'s question since ${entry.since} (entry ${entry.id}) — ${how}. `
    + 'Already closed: drop it, never ask or relay it again, present the next.'
}

// Whether the entry is closed by the module when settled: the coordinator on this machine was
// shown it. A coordinator elsewhere never reads this round.
export async function closesItself($: Host<'env' | 'fs'>, id: string): Promise<boolean> {
  return !!(await coordinatorAddress($))?.local && await shownToCoordinator($, id)
}

// The settled entries told to the coordinator on this machine, one message each, while time is
// left before `until`: a notice that does not fit, is refused or throws is one log line.
export async function tellSettled($: Host<'env' | 'fs' | 'plugin' | 'process' | 'session'>, settled: readonly Settled[], until = Infinity): Promise<void> {
  if (settled.length === 0) return
  let to: CoordinatorTo
  let name: string
  try {
    const coordinator = await coordinatorAddress($)
    if (!coordinator?.local) return
    to = coordinator.to
    name = coordinator.name
  } catch (err) {
    await logLine($, 'supervision', `round: ${messageOf(err)}`)
    return
  }
  for (const { entry, answer } of settled) {
    // A question the coordinator asked itself: its answer reaches it as the asker, never as a notice.
    if ((typeof to !== 'string' && entry.session === to.sessionId) || entry.from === name) continue
    try {
      // No bound given, the caller's own deadline holds the sends.
      const left = until - Date.now()
      const send = () => sendTo($, to, settledText(entry, answer))
      const sent = left === Infinity ? await send() : left > 0 ? await withDeadline(send(), left) : null
      if (!sent || isDegradedPass(sent)) await logLine($, 'supervision', `round: no time left to tell ${addressLabel(to)} that ${entry.id} is settled`)
      else if (!sent.isDelivered) await logLine($, 'supervision', `round: the settled notice of ${entry.id} was not delivered to ${addressLabel(to)}: ${sent.reason ?? 'no answer'}`)
    } catch (err) {
      await logLine($, 'supervision', `round: ${messageOf(err)}`)
    }
  }
}

// The round's reading, ROUND_WAKE_MS from now, one chain at a time: `timer` is the one armed, and
// an arm while it is pending arms nothing; `generation` moves when the session ends, so a reading
// already running then arms no next one. `told` once a start or a turn end read this session as
// the recorded coordinator: until then each reading asks it again, and reads the round only once
// it is (wakeTick).
export type WakeMemory = { timer: { cancel(): void } | null; generation: number; told: boolean }

// The reading armed for this session as a start or a turn end read it: none for a session told it
// is no coordinator, the one that asks for a session not told yet.
function armFor($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'prompt' | 'session' | 'ui'>, wake: WakeMemory, self: CoordinatorSelf): void {
  if (self === 'none') return
  if (self !== 'untold') wake.told = true
  armWake($, wake)
}

function armWake($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'prompt' | 'session' | 'ui'>, wake: WakeMemory): void {
  if (wake.timer) return
  const generation = wake.generation
  // A host whose clock answers no timer leaves one that cancels nothing: the reading still runs once.
  let timer: Timer = { cancel: () => undefined }
  const armed = $.clock.after(ROUND_WAKE_MS, () => wakeTick($, wake, timer, generation))
  const cancel = isRecord(armed) ? armed['cancel'] : undefined
  if (typeof cancel === 'function') timer = { cancel: () => { Reflect.apply(cancel, armed, []) } }
  wake.timer = timer
}

function stopWake(wake: WakeMemory): void {
  wake.generation++
  wake.timer?.cancel()
  wake.timer = null
  wake.told = false
}

// One reading: the questions just due, then the answers to send again to another machine. A
// failure of either is one log line, and the next reading still comes. A timer no longer the one
// armed reads nothing. A session not told yet is asked first, bounded as a start asks it: one told
// no coordinator ends the chain, one still untold reads nothing and is asked again at the next
// reading, and one that ended while it was asked reads nothing.
async function wakeTick($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'prompt' | 'session' | 'ui'>, wake: WakeMemory, timer: unknown, generation: number): Promise<void> {
  if (wake.timer !== timer) return
  wake.timer = null
  if (!wake.told) {
    let self: CoordinatorSelf = 'untold'
    try {
      const asked = await withDeadline(recordedCoordinator($), RELAY_BOUND_MS)
      if (!isDegradedPass(asked)) self = asked
    } catch (err) {
      await logLine($, 'supervision', `round wake: ${messageOf(err)}`)
    }
    if (wake.generation !== generation || self === 'none') return
    if (self === 'untold') {
      armWake($, wake)
      return
    }
    wake.told = true
  }
  try {
    await wakeForDue($)
  } catch (err) {
    await logLine($, 'supervision', `round wake: ${messageOf(err)}`)
  }
  try {
    await resendReplies($)
  } catch (err) {
    await logLine($, 'supervision', `round resend: ${messageOf(err)}`)
  }
  if (wake.generation === generation) armWake($, wake)
}

// The host's clock, read through $ so a render's duration is the host's measure; a $ that carries
// no clock reading (an older host) reads the process's own.
async function clockNow($: Host<'clock'>): Promise<number> {
  try {
    const now = Number(await $.clock.now())
    return Number.isFinite(now) ? now : Date.now()
  } catch {
    return Date.now()
  }
}

// The open entries moved to a successor at a succession (`movedFrom`) whose session has no row yet
// but that the host runs: its registry (`<config>/sessions/<pid>.json`) names the session, and
// that pid is live in the read's process table. A successor's first row is written at its first
// measure, minutes after the move (2026-11-04: 3 min 15 s), and its questions are drawn and due
// meanwhile. A move whose successor's session was not resolved names none: then a record of the
// successor's name, other than its predecessor's, stands for it. A process table that could not be
// read judges no record dead, as the store's read keeps its rows. One moved by name alone that no
// live record takes is closed (closeUnhosted). The answer is the entries' ids.
async function hostedSuccessors($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, entries: readonly RoundEntry[], rows: Record<string, SessionRow>, alive: StoreRead['alive'], asked: ReadonlySet<string> = new Set()): Promise<Set<string>> {
  const wanted = entries.filter(entry => entry.status === 'open' && entry.movedFrom && !entry.origin && !(entry.session !== '' && sessionKey(entry.session) in rows))
  const hosted = new Set<string>()
  if (wanted.length === 0) return hosted
  // A question asked with `ask` moved by name alone takes the session of the record that hosts it.
  const named = new Map<string, string>()
  const sessionOf = new Map<string, string>()
  const takes = (entry: RoundEntry, record: RegistryRecord) => entry.session !== ''
    ? record.sessionId === entry.session
    : record.name === entry.from && record.sessionId !== entry.movedFrom
  const dir = `${await configDir($)}/sessions`
  const pids = new Map<string, string[]>()
  const listed: { name: string; kind: string }[] | null = await $.fs.list(dir).catch(() => null)
  for (const file of listed ?? []) {
    if (!file || file.kind !== 'file' || !file.name.endsWith('.json')) continue
    try {
      const record = registryRecord(String(await $.fs.read(`${dir}/${file.name}`)))
      if (record === null || !/^\d+$/.test(String(record.pid ?? ''))) continue
      const ids = wanted.filter(entry => takes(entry, record)).map(entry => entry.id)
      for (const id of ids) if (asked.has(id)) sessionOf.set(id, record.sessionId)
      if (ids.length > 0) pids.set(String(record.pid), [...(pids.get(String(record.pid)) ?? []), ...ids])
    } catch { /* a record being written, or gone: not this one */ }
  }
  const argv = livePidsArgv([...pids.keys()])
  const table = alive !== undefined ? alive
    : argv === null ? new Map<string, ProcessState>()
    : livePids(await $.process.run(argv, { timeoutMs: 5000 }).catch(() => null))
  for (const [pid, ids] of pids) if (table === null || runsLive(table, pid)) for (const id of ids) hosted.add(id)
  for (const entry of wanted) {
    const session = sessionOf.get(entry.id)
    if (entry.session === '' && hosted.has(entry.id) && session !== undefined) named.set(entry.id, session)
  }
  try {
    await nameMovedAsked($, named)
  } catch (err) {
    await logLine($, 'supervision', `round: ${messageOf(err)}`)
  }
  if (listed !== null) await closeUnhosted($, wanted.filter(entry => entry.session === '' && !hosted.has(entry.id)), asked)
  return hosted
}

// The entries moved to a successor by its name alone that no session of that name runs: no
// session's end, no store read and no withdrawal matches an entry naming no session, so they are
// withdrawn here, by the sender, as a gone sender's are. Judged only on a registry listed: a
// listing that failed closes nothing, and a process table that could not be read takes every
// record of that name as live.
async function closeUnhosted($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, orphans: readonly RoundEntry[], asked: ReadonlySet<string> = new Set()): Promise<void> {
  if (orphans.length === 0) return
  try {
    const ids = new Set(orphans.map(entry => entry.id))
    const why = "the sender's session ended"
    const settled = await withdrawStale($, '', null, why, entry => !ids.has(entry.id))
    const gone = await withdrawAskedIds($, orphans.filter(entry => asked.has(entry.id)).map(entry => entry.id), why)
    await tellSettled($, [...settled, ...await shownAsked($, gone, why)], Date.now() + RELAY_BOUND_MS)
  } catch (err) {
    await logLine($, 'supervision', `round: ${messageOf(err)}`)
  }
}

// The questions asked with `ask` withdrawn by their asker that the coordinator here was shown,
// as the settled notices tell them: each closed by its asker, why.
async function shownAsked($: Host<'env' | 'fs'>, withdrawn: readonly Asked[], why: string): Promise<Settled[]> {
  const told: Settled[] = []
  for (const entry of withdrawn) {
    if (await closesItself($, entry.id)) told.push({ entry: askedAsEntry(entry), answer: { text: `withdrawn: ${why}`, by: 'sender', at: entry.answer?.at ?? new Date().toISOString() } })
  }
  return told
}

// The questions just due, read in the coordinator's own session: one wake submitted to it for
// those it was not woken for yet, the pane open as the script reads it. A question whose sender
// has ended has no one left to answer, as in the pane. The ids woken for are read again just
// before the submit, another session may have woken for some meanwhile, and recorded only once
// the host took it: a submit that fails or is dropped is tried again at the next reading. The
// ids kept are those the round still holds, so the list never outgrows it.
async function wakeForDue($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'prompt' | 'session' | 'ui'>): Promise<void> {
  await reconcilePaneRecord($)
  const store = await readStore($)
  const local = store.rows
  const round = await readRound($)
  await withdrawOlder($, round)
  // An operator entry of an older release is withdrawn above, never due.
  const relayed = round.map(found => found.entry).filter(entry => entry.kind === 'done')
  // The questions asked with `ask`, due as the relay's entries are, read through them only; one
  // claimed by his prompt in its asker's tab has left the pane, and is not due until that turn's
  // end, while its id stays one the round holds.
  const asked = await readAsked($)
  const read = [...relayed, ...asked.filter(entry => !entry.claimed).map(askedAsEntry)]
  const paneOpen = await paneIsOpen($)
  const present = new Set([...read.map(entry => entry.id), ...asked.map(entry => entry.id)])
  const now = Date.now()
  const hosted = await hostedSuccessors($, read, local, store.alive, new Set(asked.map(entry => entry.id)))
  // A question the coordinator asked itself is never due to it: it holds it in its own turn already.
  const own = await $.session.id()
  const dueBeside = (woken: readonly string[]) => (entry: RoundEntry) =>
    entry.session !== own && (sessionKey(entry.session) in local || hosted.has(entry.id)) && !woken.includes(entry.id) && isDue(entry, now, paneOpen)
  if (!read.some(dueBeside(await readWoken($)))) return
  const woken = (await readWoken($)).filter(id => present.has(id))
  const due = read.filter(dueBeside(woken))
  if (due.length === 0) return
  const taken = await $.prompt.submit({ text: dueText(due) })
  if (taken && typeof taken === 'object' && 'drop' in taken && taken.drop) {
    await logLine($, 'supervision', `round wake: the host dropped the wake: ${String(taken.drop)}`)
    return
  }
  await addIds($, await wokenPath($), due.map(entry => entry.id), id => present.has(id))
}

// The words an older release's operator question is refused or withdrawn with: this release
// enters none, no pane draws one, and its sender is told to ask it with ask.
export function olderQuestionText(id: string, done: 'not entered' | 'withdrawn'): string {
  return `Your question ${id} was ${done}: the coordinator's machine runs a newer release, which takes questions through the ask tool only. Ask it again with the ask tool.`
}

// Each open operator entry of an older release still in the round, read in the coordinator's own
// session: withdrawn through closeRound, by the coordinator, then its sender told — a session of
// this machine by a message, one of another machine by an answer on the line its ask came by,
// which clears its wait there. Written before it is told, so a notice is never sent twice; a
// notice not delivered, or a failure, is one log line.
async function withdrawOlder($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, round: readonly { path: string; entry: RoundEntry }[]): Promise<void> {
  for (const { path, entry } of round) {
    if (entry.kind !== 'operator' || entry.status !== 'open') continue
    try {
      const at = new Date().toISOString()
      const text = olderQuestionText(entry.id, 'withdrawn')
      const me = { session: await $.session.id(), name: '', role: 'coordinator' }
      const closed = await closeRound($, path, current => {
        const fresh = current === undefined ? null : parseRoundEntry(current)
        return fresh === null ? null : planOlder(fresh, text, at)
      }, me, at)
      if (closed === null || 'error' in closed) continue
      await logLine($, 'supervision', `round: an operator question of an older release withdrawn: ${entry.id}`)
      const origin = entry.origin
      const sent = origin
        ? await $.session.send({ to: origin.address, text: qAnswerLine(entry.id, entry.since, 'withdrawn', at, text) })
        : await $.session.send({ to: { sessionId: entry.session }, text: `[module] ${text}` })
      if (!sent?.isDelivered) await logLine($, 'supervision', `round: the withdrawal of ${entry.id} was not delivered: ${sent?.reason ?? 'no answer'}`)
    } catch (err) {
      await logLine($, 'supervision', `round: ${entry.id}: ${messageOf(err)}`)
    }
  }
}

// The pane is never opened here: it opens on his word (the command, the tool) or as its role left
// it (restorePane, at a turn's start). What the end of a turn does for a coordinator is check the pane's record against the host (reconcilePaneRecord)
// and say what the session is to its round's wake (recordedCoordinator), which arms it.
async function atTurnEnd($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>): Promise<CoordinatorSelf> {
  const self = await recordedCoordinator($)
  if (typeof self === 'object') await reconcilePaneRecord($)
  return self
}

// This session to the round's wake: the recorded coordinator, with its tty and host pid; `none`,
// told it is not that coordinator; `untold`, nothing tells yet what it is, and it is asked again.
type CoordinatorSelf = { tty: string | null; pid: string | null } | 'none' | 'untold'

// This session's tty and host pid when its role reads `coordinator` while the coordinator's
// record names one. The role is the row's; a row that names neither a role nor a name is a
// measure whose own walk did not answer (session.measure), and tells nothing. A first turn can
// end before the first measure writes the row: then the name is walked, bounded, and a walk that
// does not answer is `untold`, never `none` — a coordinator idle after its takeover had no reading
// of its round until its next turn (the operator's report of 2026-11-21). A row that carries no
// pid has its pid walked the same way, its role kept.
async function recordedCoordinator($: Host<'env' | 'fs' | 'process' | 'session'>): Promise<CoordinatorSelf> {
  const sessionId = await $.session.id()
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
  const told = row !== null && (row.role !== null || row.name !== null)
  let role = told ? row.role : null
  let tty = row?.tty ?? null
  let pid = row?.pid ?? null
  if (told && role !== 'coordinator') return 'none'
  if (!told || !pid) {
    const walked = await walkWithinBound($, sessionId)
    if (walked.known) {
      if (!told) role = roleOf(walked.name)
      tty = tty ?? walked.tty
      pid = walked.pid
    } else if (!told) return 'untold'
  }
  if (role !== 'coordinator') return 'none'
  if (!coordinatorOf(String(await $.fs.read(`${await stateDir($)}/coordinator.json`).catch(() => '')))) return 'none'
  return { tty, pid }
}

// The work in flight the host listed at this session's last stop (classic.Stop: its background
// tasks and scheduled wake-ups), taken by the relay of the turn's end that follows it: an agent
// that ends a turn to wait on its subagents or background work is not idle, and its orchestrator
// is not woken for it. Null when the host listed nothing at all.
let inFlightAtStop: readonly string[] | null = null

// The coordinator's round reading, module memory that register and registerWake share: a reload
// starts it afresh, the host having dropped the old environment's timers with it.
let wake: WakeMemory = { timer: null, generation: 0, told: false }

// The pane's memory, module memory that register and the record's reconciliation share, started
// afresh by register like the wake's.
let shownPane: PaneMemory = freshPane()

// The temporary files a writer killed between its write and its rename left (writeAtomic): every
// directory the module writes in is listed at a session's start, which spawns nothing, and those
// older than core's STALE_MS are removed in one process, none when there are none. The readers of
// the store and of the round sweep their own directory at each read the same way.
export const WRITTEN_DIRS = ['sessions', 'waits', 'gates', 'rows', 'answered', 'successors', 'remote']
export async function sweepTemporaries($: Host<'env' | 'fs' | 'process'>): Promise<string[]> {
  const store = await storeOf($)
  const state = await dataDir($)
  const now = Date.now()
  const stale: string[] = []
  // The protected root too, where the coordinator's scripts replace their records.
  for (const dir of new Set([...WRITTEN_DIRS.map(name => `${store}/${name}`), store, await stateDir($), state, `${state}/${ROUND_DIR}`])) {
    stale.push(...staleTemporaries(dir, await $.fs.list(dir).catch(() => []), now))
  }
  if (stale.length > 0) await $.process.run(removeArgv(...stale), { timeoutMs: 5000 })
  return stale
}

// The round's reading armed when the module loads — the host's session.start fires at a reload
// too — so a reload with no turn after it still wakes the coordinator. Mounted beside the
// supervision rather than in it, whose register holds no start handler: nothing is opened at a
// start. Bounded, as the first start is awaited.
export function registerWake(on: On<Held>): void {
  on('session.start', {}, async ($, e, next) => {
    try {
      const swept = await withDeadline(sweepTemporaries($), RELAY_BOUND_MS)
      if (isDegradedPass(swept)) await logLine($, 'supervision', `sweep: did not finish within ${RELAY_BOUND_MS} ms`)
    } catch (err) {
      await logLine($, 'supervision', `sweep: ${messageOf(err)}`)
    }
    try {
      // A start not told in time is untold: its reading asks again.
      const self = await withDeadline(recordedCoordinator($), RELAY_BOUND_MS)
      if (isDegradedPass(self)) await logLine($, 'supervision', `round wake: did not finish within ${RELAY_BOUND_MS} ms`)
      else if (typeof self === 'object') await reconcilePaneRecord($)
      else if (self === 'untold') await logLine($, 'supervision', UNTOLD_LINE)
      armFor($, wake, isDegradedPass(self) ? 'untold' : self)
    } catch (err) {
      await logLine($, 'supervision', `round wake: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// The supervision tool registered at each start, mounted beside the supervision like the wake:
// a registration, never an open. Every session gets it, the tool.call refusing those that
// supervise nothing, so a role read later than the start is never missed.
export function registerPaneTool(on: On<Held>): void {
  on('session.start', {}, async ($, e, next) => {
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
      await logLine($, 'supervision', `supervision tool not registered: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// The window's state written at the session's start, fresh or resumed, as a turn's end would write
// it: a session that takes no turn (a `--resume` that is only re-homed) shows its state all the
// same, never an empty tab. Only a window that shows none is written: a reload (the host's
// session.start fires at one too) in the middle of a turn keeps its `busy`, and a window a pull
// request's read put at `review` or `over` keeps that. Mounted beside the supervision like the wake and the pane's tool, whose
// register holds no start handler. Bounded, as the first start is awaited; outside a home session
// nothing is written, and a failure is logged and never fails the start.
export function registerStartState(on: On<Held>): void {
  on('session.start', {}, async ($, e, next) => {
    try {
      const shown = await withDeadline(showStartState($), RELAY_BOUND_MS)
      if (isDegradedPass(shown)) await logLine($, 'supervision', `tab-state: did not finish within ${RELAY_BOUND_MS} ms`)
    } catch (err) {
      await logLine($, 'supervision', `tab-state: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// A start's write, only on a window that shows no state yet: its own pane is read from the
// server's panes, the way showPrStates reads them.
async function showStartState($: Host<'env' | 'fs' | 'plugin' | 'process' | 'session'>): Promise<void> {
  const tab = await tabOf($)
  if (!tab) return
  const listed = await $.process.run(panesArgv(tab.bin, tab.target.socket), { timeoutMs: TMUX_TIMEOUT_MS })
  if (!listed || listed.exitCode !== 0) throw new Error(`tmux exited ${listed?.exitCode ?? 'without answer'} listing the panes`)
  if (panesOf(String(listed.stdout ?? '')).some(pane => pane.pane === tab.target.pane && pane.shown !== '')) return
  await showTurnEnd($)
}

// `declarations`: the waits this session's turns declared and its successor's spawn (wait.ts), which the turn's end reads.
export function register(on: On<Held>, declarations: Declarations = DECLARATIONS): void {
  // Module memory: the role the pane was opened in, the tty its agents are read
  // from — the render lists what the open asked for — and the open pane's clock.
  // A reload forgets it, and the pane then asks to be opened again, until a turn's start or the
  // tool's open takes it back (takeShownPane).
  const pane = shownPane = freshPane()
  // The entry whose recommended choice was last asked the focus: once per entry, never at a redraw.
  let focusedFor: string | null = null
  // This session's own repository, read once it answers: its owner names the pull requests the
  // pane links. A read that did not answer is no answer, and the next render reads it again.
  let ownRepo: Promise<string | null | undefined> | null = null
  // Whether the last render went past its bound: a slow render is said once per crossing of it.
  let renderSlow = false
  const stopTicker = () => {
    pane.ticker?.cancel()
    pane.ticker = null
  }
  // The coordinator's round read for questions just due, armed by a start (registerWake) or a turn
  // end that does not find it told no coordinator.
  wake = { timer: null, generation: 0, told: false }

  // The engine allows one no-matcher registration per event, and the gauge
  // owns session.measure's and session.end's: this domain observes the same
  // events beside it, declared by an empty matcher — a partial of e with no
  // field named, so every measure and every end reaches the store. The chain
  // still answers in registration order, which register pins (the gauge
  // first, or the row runs one measure behind).
  on('session.measure', {}, async ($, e, next) => {
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
        // The repository is the pane's own memory (ownRepo): read once it answers, not at every measure.
        const origin = await withDeadline((async () => {
          const repo = await (ownRepo ??= repoRead($))
          if (repo === undefined) ownRepo = null
          return repo ?? null
        })(), await sideReadBoundMs($))
        await writeSession($, sessionId, {
          // A walk that did not finish leaves the row's name, role and pid as they were.
          ...(walked.known ? { role: roleOf(walked.name), name: walked.name } : {}),
          ...(walked.pid ? { pid: walked.pid } : {}),
          ...(walked.tty ? { tty: walked.tty } : {}),
          tmux: await windowAddress($),
          repo: isDegradedPass(origin) ? null : origin,
          context_percent: reading.context_percent,
          context_tokens: reading.context_tokens,
          window: reading.context_window,
          model: reading.model,
          busy: false,
          updated_at: reading.updated_at,
        })
        // The window's tab shows the gate crossed, or left.
        await showGate($, reading)
        // A successor whose pass left an agent untold goes on with it, only while that holds.
        if (walked.known && walked.tty && walked.pid && roleOf(walked.name) === 'orchestrator' && (await inheritOf($, sessionId))?.done === false) {
          const done = await withDeadline(tellInheritedAgents($, sessionId, walked.name!, walked.pid, walked.tty), RELAY_BOUND_MS)
          if (isDegradedPass(done)) await logLine($, 'supervision', `successor: agents not told within ${RELAY_BOUND_MS} ms`)
        }
        // An agent's measure past its gate: its orchestrator told once per crossing.
        if (walked.known && walked.tty && roleOf(walked.name) === 'agent') {
          const done = await withDeadline(reportGate($, sessionId, walked.name!, walked.tty, reading), RELAY_BOUND_MS)
          if (isDegradedPass(done)) await logLine($, 'supervision', `gate: did not finish within ${RELAY_BOUND_MS} ms`)
        }
      }
    } catch (err) {
      // A row that cannot be written, or a gate report that failed, never blocks the
      // measure: the next one writes it.
      await logLine($, 'supervision', messageOf(err))
    }
    // The deck follows the row just written (writeDeck): a new fill is what its keys draw.
    await refreshDeck($)
    return next(e)
  }).catch(async ($, e, next) => {
    // The registered net the plan's every-handler rule asks validate to see:
    // the measure is let through, the state dir says why, and next is
    // replay-safe in a catch, called or not.
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // A session that sends « takeover confirmed » itself is the successor taking a predecessor's place:
  // the agents of the chain it was handed are told who their orchestrator is, even if the
  // predecessor never receives the word. Once per session: the claim is written before the first send.
  on('session.send', {}, async ($, e, next) => {
    const out = await next(e)
    try {
      if (e.agentId || e.origin?.kind !== 'model' || !confirmsTakeover(e.text ?? '')) return out
      const sessionId = await $.session.id()
      if ((await inheritOf($, sessionId)) !== null) return out
      const walked = await walkWithinBound($, sessionId)
      if (!walked.known || !walked.tty || !walked.pid || roleOf(walked.name) !== 'orchestrator') return out
      await writeAtomic($, `${await storeOf($)}/${inheritKey(sessionId)}`, JSON.stringify({ done: false }) + '\n')
      const done = await withDeadline(tellInheritedAgents($, sessionId, walked.name!, walked.pid, walked.tty), RELAY_BOUND_MS)
      if (isDegradedPass(done)) await logLine($, 'supervision', `successor: agents not told within ${RELAY_BOUND_MS} ms`)
    } catch (err) {
      await logLine($, 'supervision', `successor: ${messageOf(err)}`)
    }
    return out
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('session.end', {}, async ($, e, next) => {
    const sessionId = e.sessionId ?? await $.session.id()
    // Read before the row goes: the successor's file goes with it.
    let successor: LearntSuccessor | null = null
    try {
      stopWake(wake)
      successor = await readSuccessor($, sessionId)
      await deleteSession($, sessionId)
      await recordPaneClosed($)
    } catch (err) {
      // The end is never held on the store's own failure; it is said.
      await logLine($, 'supervision', messageOf(err))
    }
    // What the host's end bound leaves, shared by the round and the deck after it.
    let until = Date.now() + Math.min(RELAY_BOUND_MS, next.budget?.remainingMs ?? RELAY_BOUND_MS)
    try {
      // A question whose sender has ended has no one left to answer it, unless a successor took
      // it over: then it is the successor's. After the row is gone, and bounded by what the
      // host's own end bound leaves: a slow round never starves the store's deletion.
      // Every write first, then the notices in what is left of it.
      const bound = Math.min(RELAY_BOUND_MS, next.budget?.remainingMs ?? RELAY_BOUND_MS)
      until = Date.now() + bound
      const done = await withDeadline(successor
        ? moveToSuccessor($, sessionId, successor)
        : withdrawStale($, sessionId, null, "the sender's session ended").then(async settled => {
          const asked = await withdrawAsked($, sessionId, "the sender's session ended")
          return [...settled, ...await shownAsked($, asked, "the sender's session ended")]
        }), bound)
      if (isDegradedPass(done)) await logLine($, 'supervision', `round: did not finish within ${bound} ms`)
      else await tellSettled($, done, until)
    } catch (err) {
      await logLine($, 'supervision', `round: ${messageOf(err)}`)
    }
    // The ended session leaves the deck, in what the round left of the bound.
    const left = until - Date.now()
    if (left > 0) await refreshDeck($, left)
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The end of a main-loop turn that answered: an orchestrator's wait written to its
  // row and, once per wait, entered in the round of a coordinator on this machine or
  // reported to one elsewhere — an agent's state to its orchestrator (relayTurnEnd). Here
  // rather than at classic.Stop: a stop the gate refuses goes on in the same turn, so
  // the message a stop carries is not always the turn's last word, and the gate's own
  // deadline is not this report's to spend; turn.complete fires once the turn is over,
  // with its final answer. Bounded, and never holds the turn's end.
  on('classic.Stop', {}, async ($, e, next) => {
    inFlightAtStop = hostTasks(e.background_tasks, e.session_crons)
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
  on('turn.complete', {}, async ($, e, next) => {
    // What this turn's end has to tell a coordinator on another machine goes in one message,
    // sent whatever the reads before it did.
    const outbox: Outgoing[] = []
    try {
      // A turn the person interrupted is his; any other end is read, a stop the host wrote included.
      if (!e.agentId && e.reason !== 'aborted' && e.isAborted !== true) {
        const inFlight = inFlightAtStop
        inFlightAtStop = null
        const sessionId = await $.session.id()
        const declared = { wait: declarations.current(), handedOver: declarations.handedOver(sessionId) }
        const done = await withDeadline(relayTurnEnd($, String(e.answer ?? ''), e.turnId, inFlight, e.reason ?? 'answer', declared, outbox), RELAY_BOUND_MS)
        if (isDegradedPass(done)) await logLine($, 'supervision', `relay: did not finish within ${RELAY_BOUND_MS} ms`)
        // The wait just written is what the pane shows: the row follows it, when it is news.
        const queued = await withDeadline(sendRow($, sessionId, outbox), RELAY_BOUND_MS)
        if (isDegradedPass(queued)) await logLine($, 'supervision', `row: did not finish within ${RELAY_BOUND_MS} ms`)
      }
    } catch (err) {
      await logLine($, 'supervision', `relay: ${messageOf(err)}`)
    }
    try {
      const sent = await withDeadline(flushOutbox($, outbox), RELAY_BOUND_MS)
      if (isDegradedPass(sent)) await logLine($, 'supervision', `send: did not finish within ${RELAY_BOUND_MS} ms`)
    } catch (err) {
      await logLine($, 'supervision', `send: ${messageOf(err)}`)
    }
    // The wait the relay just wrote, or none, is what the window's tab shows.
    if (!e.agentId) await showTurnEnd($)
    try {
      if (!e.agentId) {
        const done = await withDeadline(atTurnEnd($), RELAY_BOUND_MS)
        if (isDegradedPass(done)) await logLine($, 'supervision', `pane: did not finish within ${RELAY_BOUND_MS} ms`)
        else if (done === 'untold') await logLine($, 'supervision', UNTOLD_LINE)
        armFor($, wake, isDegradedPass(done) ? 'untold' : done)
      }
    } catch (err) {
      await logLine($, 'supervision', `pane: ${messageOf(err)}`)
    }
    // The wait the relay just wrote, or cleared, is what the deck's keys show.
    if (!e.agentId) await refreshDeck($)
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // A turn starts: the session works again, and a wait its row carried is over.
  on('turn.start', {}, async ($, e, next) => {
    if (!e.agentId) await showTabState($, 'busy')
    // The model's turn may run `coordinator.sh round`, which reads the pane's record: a record of a
    // pane that is gone is dropped before it does.
    if (!e.agentId) await reconcilePaneRecord($).catch((err: unknown) => logLine($, 'supervision', `pane: ${messageOf(err)}`))
    // A successor's first turn puts the pane as its role left it.
    if (!e.agentId) {
      const restored = await withDeadline(restorePane($, pane), RELAY_BOUND_MS).catch((err: unknown) => logLine($, 'supervision', `pane: ${messageOf(err)}`))
      if (isDegradedPass(restored)) await logLine($, 'supervision', `pane: did not finish within ${RELAY_BOUND_MS} ms`)
    }
    try {
      const sessionId = await $.session.id()
      const wait = await readWait($, sessionId)
      if (wait?.waiting) {
        await writeWait($, sessionId, clearedWait(wait))
        await refreshDeck($)
      }
      // A closing proposal says nothing is left to do: the session working again ends it, and its turn's
      // end enters a new one if it still is done. Only a session whose row may enter the round reads it.
      const row = e.agentId ? null : parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
      if (!e.agentId && (row?.name == null || entersRound(roleOf(row.name)))) {
        const until = Date.now() + RELAY_BOUND_MS
        const done = await withDeadline(withdrawStale($, sessionId, null, WORKS_AGAIN, entry => entry.kind !== 'done'), RELAY_BOUND_MS)
        if (isDegradedPass(done)) await logLine($, 'supervision', `round: did not finish within ${RELAY_BOUND_MS} ms`)
        else await tellSettled($, done, until)
      }
    } catch (err) {
      await logLine($, 'supervision', `relay: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // A peer's delivery, read before it is queued. A marked row (remote-row.ts) is written to
  // the store and consumed: no model reads it, on either side; so are a remote orchestrator's
  // ask, entered in the coordinator's round, its acknowledgment, and the acknowledgment of an
  // answer sent back (remote-round.ts), by the event line. That answer reaches the sender's model as its readable part alone, its marked line taken out. A coordinator's message
  // teaches this machine its address, for the relay and the row when the coordinator runs
  // elsewhere; a successor's « takeover confirmed » teaches an orchestrator who holds its open
  // questions once it hands over or ends. Anything else passes through untouched.
  // A message of several marked lines (a remote orchestrator's turn end, flushOutbox) is read line
  // by line, each as a delivery of its own: every one of them is the module's, consumed, and what
  // a line would pass on to a model is dropped.
  on('session.receive', {}, async ($, e, next) => {
    const delivery = !e.agentId && isPeerOrigin(e.origin) && typeof e.text === 'string' ? deliveryOf(e.text) : null
    const lines = delivery ? splitLines(delivery.body) : null
    if (!delivery || !lines) {
      const read = await readDelivery($, e, declarations)
      return isPassed(read) ? next(read.passed) : read
    }
    for (const line of lines) {
      // A line that is not consumed reaches no model.
      const read = await readDelivery($, { ...e, text: e.text.replace(delivery.body, () => line) }, declarations)
      if (isPassed(read)) await logLine($, 'supervision', `receive: a line of a message of several was not the module's, dropped (${line.length} characters)`)
    }
    return { consumed: 'orchestrator: a message of several marked lines, read' }
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The pane opens on the person's own command alone — the shipped types' «
  // asked » open, placed at any width — in the two supervising roles: a
  // coordinator's lists the orchestrators, an orchestrator's its own agents.
  // Anywhere else the command says so and opens nothing. Every form of the
  // command answers, the same toggle on the same pane; a bare short name only when its user
  // command is this plugin's copy, the operator's own command of that name run as he wrote it.
  for (const command of SUPERVISION_COMMANDS) on('command.run', { command }, async ($, e, next) => {
    if (isBare(String(e?.command ?? ''))) {
      const dir = commandsDirOf(await $.env.get('ORCHESTRATOR_COMMANDS_DIR'), await configDir($))
      if (!isOwnCopy(String(await $.fs.read(`${dir}/${e.command}.md`).catch(() => '')))) return next(e)
    }
    const { tty, name, pid } = await walkWithinBound($, await $.session.id())
    const role = roleOf(name)
    if (name === null || (role !== 'coordinator' && role !== 'orchestrator')) {
      return { text: 'The supervision pane opens in a coordinator session (« Coord: … »), listing the orchestrators, or in an orchestrator session (« Orch: … »), listing its agents; /orchestrator:status lists the sessions here.' }
    }
    // A toggle: the same command closes the pane it opened (Escape does not —
    // the pane holds no focus), beside the pane's own ✕.
    if (await paneShown($)) {
      await closeShown($, pane, name)
      return { text: 'Supervision pane closed.' }
    }
    await openPane($, pane, role, tty, pid, name)
    return { text: 'Supervision pane opened; type /orchestrator-supervision again, or click its ✕, to close it.' }
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The same pane on the operator's plain words: the model calls the tool with `open` or
  // `close` where he types no command. Not a toggle — the word says which.
  on('tool.call', { tool: `mcp__orchestrator__${SUPERVISION_TOOL}` }, async ($, e) => {
    if (e.agentId) return { result: PANE_MAIN_THREAD_ONLY, isError: true }
    const action = e['action']
    if (action !== 'open' && action !== 'close') return { result: 'action is "open" or "close"', isError: true }
    const { tty, name, pid } = await walkWithinBound($, await $.session.id())
    const role = roleOf(name)
    if (name === null || (role !== 'coordinator' && role !== 'orchestrator')) return { result: PANE_ROLES_ONLY, isError: true }
    const shown = await paneShown($)
    if (action === 'close') {
      // His word is kept even when the pane was already gone (his ✕ before it).
      if (shown) await closeShown($, pane, name)
      else await keepPaneState($, name!, false)
      return { result: shown ? 'Supervision pane closed.' : 'The supervision pane is not open.' }
    }
    if (shown) {
      await takeShownPane($, pane, role, tty, pid, name)
      return { result: 'The supervision pane is already open.' }
    }
    const placed = await openPane($, pane, role, tty, pid, name)
    if (placed && placed.isPlaced === false) return { result: `Supervision pane opened, not drawn yet: ${placed.reason ?? 'no reason given'}.` }
    return { result: 'Supervision pane opened.' }
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: "the supervision pane could not be opened or closed; the module's log says why", isError: true }
  })

  // The pane closed, by its ✕ or its key or by the module or the host: its clock stops with it and
  // its record goes. His ✕ is his word and the role keeps it closed; the close the host makes when
  // a session ends is not, and leaves the role's state for the successor.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    stopTicker()
    await recordPaneClosed($).catch((err: unknown) => logLine($, 'supervision', `pane: ${messageOf(err)}`))
    if (fieldsOf(fieldsOf(e)?.['origin'])?.['kind'] === 'person') {
      const name = pane.opened?.name ?? (await walkWithinBound($, await $.session.id())).name
      if (name !== null) await keepPaneState($, name, false)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The body's window moving at the person's wheel or keys: the host's measure of the tree is
  // kept for the track, with the content it measured. A plugin's own move never reaches here.
  on('ui.scroll', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    if (pane.drawn) pane.measure = { contentRows: e.contentRows, drawn: pane.drawn }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The pane's ring leaving the text field, for the picker or off the pane: the field goes
  // with it, so that Tab from a choice never reaches it, until « Other answer » is picked again.
  // The ring landing on a field: the host moves the window to bring it into view and tells the
  // module nothing of that move, so the pane is drawn again once it has, its key line pinned at
  // the window's new top.
  on('ui.focus', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    if (isRecord(result) && result['deny']) return result
    if (pane.writing !== null && e.element !== answerKey(pane.writing)) {
      pane.writing = null
      $.ui.invalidate('ui.render')
    }
    if (typeof e.element === 'string' && e.element.startsWith(answerKey(''))) {
      $.clock.after(SCROLL_AFTER_DRAW_MS, () => $.ui.invalidate('ui.render'))
    }
    return result
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The pane's own render: the matcher names the render envelope's component
  // and requestId — the pane's id — so the rows are drawn in this plugin's pane
  // alone and never in another plugin's.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const started = await clockNow($)
    try {
      // The store at draw time: the gauge's invalidate after every measure and
      // the pane's own clock re-raise this render. Display only.
      pane.ticksSinceDraw = 0
      let rows: { label: string; name: string; rest: string; urgency: number }[] = []
      let blocks: PaneRow[] = []
      let failed: { entry: RoundEntry; reason: string }[] = []
      let delivering: RoundEntry[] = []
      let pending = 0
      // The open questions asked with `ask` (question.ts), drawn from their fields.
      let asked: Asked[] = []
      let owners = new Map<string, string>()
      let none = 'type /orchestrator-supervision to open the pane again'
      let ownUnattended: UnattendedPaneLine[] | null = null
      const coordinator = pane.opened?.role === 'coordinator'
      if (coordinator) {
        const store = await readStore($)
        const local = store.rows
        const merged = withRemote(local, await readRemoteRows($), Date.now(), REMOTE_STALE_AFTER_MS)
        blocks = paneRows(Object.fromEntries(Object.entries(merged).filter(([, row]) => row.role === 'orchestrator')))
        const repo = await (ownRepo ??= repoRead($))
        if (repo === undefined) ownRepo = null
        owners = repositoryOwners([repo ?? null, ...Object.values(merged).flatMap(row => [row.repo, ...('prs' in row && Array.isArray(row.prs) ? row.prs.filter(isText) : []), ...(row.unattended?.prs.map(u => u.repo) ?? [])])])
        none = WORDS.noOrchestrator
        // Stat before the read: a write landing between the two is seen by the next tick.
        pane.roundSeen = await roundMtime($)
        // A question asked with `ask` is drawn while its asker has a live row on this machine, as an entry is.
        // One moved to a successor by its name alone is drawn while a live record of that name hosts it.
        // A replica of one asked on another machine, while a live remote row of its asker's name was measured there.
        const allAsked = await readAsked($)
        const hostedAsked = await hostedSuccessors($, allAsked.map(askedAsEntry), local, store.alive, new Set(allAsked.map(entry => entry.id)))
        const localAsked = allAsked.filter(entry => entry.origin !== undefined
          ? merged[remoteKey(entry.sender.name)]?.machine === entry.origin.machine
          : sessionKey(entry.sender.session) in local || hostedAsked.has(entry.id))
        asked = askedGroups(localAsked).flat()
        pending = asked.length
        // An answer to a question asked with `ask` not delivered, while its asker has a row here;
        // none for an entry its sender withdrew, whose answer nobody waits for any more (a
        // withdrawal by the coordinator not delivered stays drawn: its asker still waits).
        failed = localAsked.filter(entry => !(entry.status === 'withdrawn' && entry.answer?.by === 'sender') && (entry.status === 'answered' || entry.origin !== undefined) && entry.delivery?.state === 'failed')
          .map(entry => ({ entry: askedAsEntry(entry), reason: entry.delivery!.reason ?? 'no answer' }))
        // A replica's answer on its way to its owner's machine, until the owner acknowledges it.
        delivering = localAsked.filter(entry => entry.origin !== undefined && (entry.delivery?.state === 'pending' || entry.delivery?.state === 'sent')).map(askedAsEntry)
      } else if (pane.opened?.role === 'orchestrator') {
        // Bounded like every side read: an agent list that cannot be read in
        // time draws as none, never a held render.
        const views = pane.opened.tty ? await withDeadline(agentViews($, pane.opened.tty), await sideReadBoundMs($)) : []
        rows = isDegradedPass(views) ? [] : agentPaneRows(views)
        none = isDegradedPass(views) ? 'the agents could not be read in time' : 'no agent running'
        // Its own pull requests nobody attends, read at its last turn end, above its agents.
        const own = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(await $.session.id())}`).catch(() => '')))
        ownUnattended = own ? unattendedOfRow(own) : null
      }
      const el = $.ui.resolve(e)
      const columns: number = e.props?.bodyColumns ?? 0
      // One line of the unattended reading: its label in a column of its own, its words beside it, a
      // group wrapping under its first character and one pull request cut to the line, never wrapped.
      // `used`: the columns the line's container takes before it, beside the scroll track.
      const unattendedRow = (line: UnattendedPaneLine, used: number, say: (words: string, style: object, outer: object) => unknown): unknown => {
        const tint = line.anomaly ? { color: 'warning' } : {}
        return el.Box({
          flexDirection: 'row',
          children: [
            el.Box({ width: UNATTENDED_LABEL_COLUMN, flexShrink: 0, children: [el.Text({ ...tint, children: line.label })] }),
            el.Box({ flexGrow: 1, flexShrink: 1, children: [say(unattendedText(line, columns > 0 ? columns - TRACK_COLUMNS - used - UNATTENDED_LABEL_COLUMN : 0), tint, line.wraps ? {} : { wrap: 'truncate-end' })] }),
          ],
        })
      }
      if (!coordinator) {
        return el.Box({
          flexDirection: 'column',
          children: [
            ...(ownUnattended !== null ? ownUnattended.map(said => unattendedRow(said, 0, (words, style, outer) => el.Text({ ...style, ...outer, children: words }))) : []),
            ...(rows.length === 0
              ? [el.Text({ children: none })]
              // The default text colour with the name bold; a row past the gate is warning, each
              // piece carrying the colour itself.
              : rows.map(row => {
                const tint = row.urgency >= GATE_URGENCY_FLOOR ? { color: 'warning' } : {}
                return el.Text({ children: [el.Text({ ...tint, bold: true, children: row.name }), el.Text({ ...tint, children: row.rest })] })
              })),
          ],
        })
      }
      // Every piece below is drawn with the rows it takes at the content's width: the host tells
      // the tree's height only at the person's own `ui.scroll` (never at a plugin's), so until a
      // move measured this very content, the count is the module's, and it is the drawn rows'
      // sum — the card's border, padding, indents and blank lines counted as drawn.
      const scroll: { offset: number; bodyRows: number } | undefined = e.props?.scroll
      const width = columns - TRACK_COLUMNS
      const rowsOf = (text: string, at: number) => width > 0 ? text.split('\n').reduce((sum, line) => sum + wrapWords(line, Math.max(1, at)).length, 0) : 0
      type Drawn = { node: unknown; rows: number }
      // A text drawn with the marks it carried — inline code in its colour, bold, italic — and each
      // pull request it names a link of its own, `style` the whole text's, `outer` the props of the line itself.
      const rich = (text: string, style: object = {}, outer: object = {}) => el.Text({ ...outer, children: textSpans(text).flatMap(span => linked(span.text).map(piece => el.Text({
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
      // its figures in the normal colour. A wait adds a Status line and, on the operator, a Blocks
      // line, each label in a column of its own so a long text wraps under its own first
      // character. A blank line between two blocks.
      const block = (row: PaneRow, i: number): Drawn => {
        const state = row.waiting === 'operator' ? 'warning' : row.waiting === 'done' ? 'success' : 'suggestion'
        const line = el.Text({
          children: [
            el.Text({ color: state, children: '●' }),
            el.Text({ children: ' ' }),
            el.Text({ bold: true, children: row.name }),
            el.Text({ children: ` · ${row.head} · ` }),
            el.Text(row.past ? { color: 'error', children: row.fill } : { children: row.fill }),
            ...(row.age !== null ? [el.Text({ children: ` · ${row.age}` })] : []),
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
        const unattendedWidth = width - 2 - UNATTENDED_LABEL_COLUMN
        return {
          node: el.Box({
            flexDirection: 'column',
            ...(i > 0 ? { marginTop: 1 } : {}),
            children: [
              line,
              ...(row.status !== null ? [labelled(WORDS.status, el.Text({ color: state, children: row.status }))] : []),
              ...(row.blocked !== null ? [labelled(WORDS.blocks, rich(row.blocked))] : []),
              ...(row.unattended !== null ? [el.Box({ paddingLeft: 2, flexDirection: 'column', children: row.unattended.map(said => unattendedRow(said, 2, rich)) })] : []),
            ],
          }),
          rows: (i > 0 ? 1 : 0)
            + rowsOf(`● ${row.name} · ${row.head} · ${row.fill}${row.age !== null ? ` · ${row.age}` : ''}`, width)
            + (row.status !== null ? rowsOf(row.status, textWidth) : 0)
            + (row.blocked !== null ? rowsOf(takesRows(row.blocked), textWidth) : 0)
            + (row.unattended ?? []).reduce((sum, said) => sum + (said.wraps ? rowsOf(takesRows(said.text), unattendedWidth) : width > 0 ? 1 : 0), 0),
        }
      }
      const listed: Drawn[] = blocks.length === 0 ? [{ node: el.Text({ children: none }), rows: rowsOf(none, width) }] : blocks.map(block)
      // A waiting row whose question asked with `ask` the pane holds, drawn or next in line, is not one
      // the operator is left without.
      const askedHere = new Set(asked.map(entry => sessionKey(entry.sender.session)))
      const waiting = blocks.filter(row => row.waiting === 'operator' && !askedHere.has(row.key)).length
      const waitsFor = `${waiting} orchestrator${waiting === 1 ? ' waits' : 's wait'} for you: ask the coordinator`
      const says = waiting === 0 ? WORDS.none : asked.length > 0 ? waitsFor : `${WORDS.none} in the pane — ${waitsFor}`
      // Where the surface draws a picker, the choices are one Select: it holds the arrows while it
      // has the ring, where a focused pane taller than its body scrolls on them, and a click only
      // gives it the ring — a stray click answers nothing. Its last option leads to the text
      // field. Elsewhere (mobile, a tap the only way) one Button per choice.
      const Select = el.Select
      const picker = Select !== undefined
      // The first question asked with `ask` takes the controls: its picker, its choices, its field.
      const answering: Asked | null = asked[0] ?? null
      const answeringPick = answering === null ? null : (answering.choices.find(c => c.letter === answering.recommended) ?? answering.choices[0])?.letter ?? null
      const focus = answering === null || answeringPick === null ? null : picker ? `choices:${answering.id}` : `choice:${answeringPick}`
      const focusFor = answering?.id ?? null
      if (focusFor !== null && focus !== null && focusedFor !== focusFor) {
        // Once per question: the ring to its first choice for a pane already holding the keys,
        // and the window to it, so a question drawn below the rows shows its choice. Never
        // awaited, so the draw never waits on itself, and a refusal (the pane holds no keys yet)
        // is not an error.
        focusedFor = focusFor
        try {
          Promise.resolve($.ui.focus({ requestId: PANE_ID, key: focus })).catch(() => undefined)
        } catch {
          // A host without the call: the autoFocus mark still starts the ring.
        }
        // The window is moved once the picker is drawn: before, the key names nothing. The host
        // tells no `ui.scroll` for a plugin's own move and draws nothing after it, so the pane is
        // drawn again once the move lands: the track and the key line sit at the window's offset
        // read at draw time, and are left above the window until then.
        try {
          $.clock.after(SCROLL_AFTER_DRAW_MS, () => {
            try {
              Promise.resolve($.ui.scroll({ to: { key: focus }, in: PANE_ID }))
                .then(() => $.ui.invalidate('ui.render'))
                .catch(() => undefined)
            } catch {
              // A host without the call: the window stays where it is.
            }
          })
        } catch {
          // A host without a clock: the window stays where it is.
        }
      }
      // An answer not delivered is one line at the section's foot, every one of them in it, so a
      // notice never stands between the title and the next question.
      const answerTo = (entry: RoundEntry) => `the answer to ${entry.from}${entry.origin ? ` on ${entry.origin.machine}` : ''} (blocks: ${entry.blocks})`
      const noticeText = `${WORDS.notDelivered}: ${failed.map(notice => `${notice.reason} — ${answerTo(notice.entry)}`).join(' · ')}`
      // An answer on its way to another machine, dim, until its sender acknowledges it.
      const deliveringText = `${WORDS.delivering}: ${delivering.map(entry => `${answerTo(entry)} — ${entry.delivery!.state === 'pending'
        ? 'not sent yet'
        : `sent ${entry.delivery!.attempts} of ${ANSWER_SENDS}, not acknowledged yet`}`).join(' · ')}`
      const notices: Drawn[] = [
        ...(delivering.length === 0 ? [] : [{ node: el.Text({ dimColor: true, children: deliveringText }), rows: rowsOf(deliveringText, width) }]),
        ...(failed.length === 0 ? [] : [{ node: el.Text({ color: 'error', children: noticeText }), rows: rowsOf(noticeText, width) }]),
      ]
      const title = pending === 0 ? WORDS.questions : `${WORDS.questions} — ${pending} ${WORDS.pending}`
      // A rule, dim, closes the questions, a blank line below them: one row, cut at the pane's width.
      const rule: Drawn = {
        node: el.Box({ marginTop: 1, children: [el.Text({ dimColor: true, wrap: 'truncate-end', children: '─'.repeat(width > 0 ? width : RULE_FALLBACK) })] }),
        rows: 2,
      }
      // The first question asked with `ask`, the only one drawn, each line from a field of the object.
      const askedDrawn = askedLines(asked)
      const askedPieces = askedDrawn.map(line => ({
        node: el.Box({ paddingLeft: line.indent, children: [rich(line.text, askedLook(line.look))] }),
        rows: rowsOf(takesRows(line.text), width - line.indent),
      }))
      // His answer to the question asked with `ask` the controls are under, once at a time: the
      // object answered by the pane, its asker sent the answer, the coordinator that was shown it
      // told it is settled, as for an entry, the pane drawn again. A question the pane's own
      // session asked is told by its answer, submitted to that session: no second notice.
      const answerAsked = (id: string, text: string): Promise<void> => {
        if (pane.answering.has(id)) return Promise.resolve()
        pane.answering.add(id)
        return (async () => {
          const shown = await shownToCoordinator($, id)
          const done = await answerAskedFromPane($, id, text)
          if (done === null || done.answer === null) return
          forgetDraft(pane, id)
          const own = done.sender.session !== '' && done.sender.session === await $.session.id()
          if (shown && !own) await $.prompt.submit({ text: settledText(askedAsEntry(done), { text: done.answer.text, by: 'pane', at: done.answer.at }) })
        })()
          .catch(err => logLine($, 'supervision', `round: ${messageOf(err)}`))
          .finally(() => {
            pane.answering.delete(id)
            $.ui.invalidate('ui.render')
          })
      }
      // Whether this draw holds the « Other answer » field: the field takes the pane's whole width,
      // so no scroll track is drawn beside it, the key line still pinned (see ANSWER_ROWS).
      let fieldDrawn = false
      // The controls under that question's lines, as the card draws its own: a picker of its letters
      // and « Other answer » where the surface has one, a Button per choice elsewhere, then the field.
      const askedControls = (entry: Asked): Drawn[] => {
        const indent = 4
        const at = width - indent
        const pick = (letter: string) => answerAsked(entry.id, `${letter} : ${entry.choices.find(c => c.letter === letter)!.text}`)
        const choosingAsked = entry.choices.length > 0
        // A control drawn at the pane's edge (`edge`) rather than under the question's indent.
        const controls: (Drawn & { edge?: true })[] = []
        if (choosingAsked && Select) {
          controls.push({
            node: Select({
              key: `choices:${entry.id}`,
              label: WORDS.choose,
              options: [
                ...entry.choices.map(c => ({ value: c.letter, label: c.letter === entry.recommended ? `${c.letter} (${WORDS.recommended})` : c.letter })),
                { value: OTHER_VALUE, label: WORDS.otherBelow },
              ],
              value: answeringPick!,
              autoFocus: true,
              onSelect: (value: string) => {
                if (value !== OTHER_VALUE) return pick(value)
                pane.writing = entry.id
                $.ui.invalidate('ui.render')
                return Promise.resolve($.ui.focus({ requestId: PANE_ID, key: answerKey(entry.id) })).catch(() => undefined)
              },
            }),
            rows: 1 + (e.props?.isFocused ? entry.choices.length + 1 : 0),
          })
        } else if (choosingAsked) {
          for (const c of entry.choices) {
            const label = `[${c.letter}] ${plainText(c.text)}${c.letter === entry.recommended ? `  ${STAR}` : ''}`
            const key = `choice:${c.letter}`
            controls.push({
              node: el.Button({ key, label, hotkey: c.letter.toLowerCase(), ...(key === focus ? { autoFocus: true } : {}), onPress: () => pick(c.letter) }),
              rows: rowsOf(label, at),
            })
          }
        }
        if (typeof el.Input === 'function') {
          if (!(picker && choosingAsked && pane.writing !== entry.id)) {
            fieldDrawn = true
            controls.push({
              node: el.Input({
                key: answerKey(entry.id),
                label: OTHER_LABEL,
                placeholder: WORDS.otherPlaceholder,
                submitLabel: WORDS.send,
                rows: ANSWER_ROWS,
                onSubmit: (value: string) => (value.trim() === '' ? undefined : answerAsked(entry.id, value)),
              }),
              rows: ANSWER_ROWS,
              edge: true,
            })
          }
        } else {
          const note = `type your answer in this tab, or in ${entry.sender.name}'s tab`
          const noted = pane.other.has(entry.id)
          controls.push({
            node: el.Box({
              flexDirection: 'column',
              children: [
                el.Button({ key: OTHER_KEY, label: WORDS.otherInSession, hotkey: OTHER_HOTKEY, onPress: () => { pane.other.add(entry.id); $.ui.invalidate('ui.render') } }),
                ...(noted ? [el.Text({ color: 'suggestion', children: note })] : []),
              ],
            }),
            rows: 1 + (noted ? rowsOf(note, at) : 0),
          })
        }
        return controls.map(control => ({ node: el.Box({ paddingLeft: control.edge ? 0 : indent, children: [control.node] }), rows: control.rows }))
      }
      // The controls go right under the lines of the question they answer: its Blocks line, the first.
      const answeredEnd = answering === null ? -1 : askedDrawn.findIndex(line => line.look === 'label')
      if (answering !== null && answeredEnd >= 0) askedPieces.splice(answeredEnd + 1, 0, ...askedControls(answering))
      const section: Drawn[] = [
        { node: el.Text({ bold: true, color: 'suggestion', children: title }), rows: rowsOf(title, width) },
        // Beside the questions asked with `ask`, the line still counts the orchestrators waiting with none drawn.
        ...(askedPieces.length === 0 || waiting > 0 ? [{ node: el.Text({ children: says }), rows: rowsOf(says, width) }] : []),
        ...(askedPieces.length === 0 ? [] : [{
          node: el.Box({ flexDirection: 'column', children: askedPieces.map(piece => piece.node) }),
          rows: askedPieces.reduce((sum, piece) => sum + piece.rows, 0),
        }]),
        ...notices,
        rule,
      ]
      const heading: Drawn = { node: el.Text({ bold: true, children: WORDS.orchestrators }), rows: rowsOf(WORDS.orchestrators, width) }
      // The key line, dim, at the foot: once the pane holds the keys, how to give them is no
      // longer said.
      const keyLine = answering === null ? null : picker
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
      // line would cover it. While the « Other answer » field is drawn the track alone is left
      // out: its right margin would take columns the field counts as its own (see ANSWER_ROWS).
      const drawnKey = JSON.stringify([answering?.id ?? null, pending, asked.map(entry => entry.id), blocks, failed.map(notice => notice.reason), delivering.map(entry => entry.delivery), pane.writing, [...pane.other], e.props?.isFocused ?? false, columns, scroll?.bodyRows ?? null, keyLine])
      pane.drawn = drawnKey
      const measured = pane.measure && pane.measure.drawn === drawnKey ? pane.measure.contentRows : null
      const pinnedRows = keyLine !== null && width > 0 ? wrapWords(keyLine, width) : []
      const counted = width > 0 ? flow.reduce((sum, piece) => sum + piece.rows, 0) + pinnedRows.length : 0
      const taller = scroll && width > 0 ? scrollTrack(scroll.offset, scroll.bodyRows, measured ?? counted) : null
      const track = fieldDrawn ? null : taller
      const pinned = taller !== null && pinnedRows.length > 0 ? pinnedRows : null
      const overlays = taller === null || !scroll ? [] : [
        ...(track === null ? [] : [el.Box({
          position: 'absolute', top: scroll.offset, right: 0, width: 1, flexDirection: 'column',
          children: track.map(thumb => el.Text(thumb ? { color: 'suggestion', children: '█' } : { dimColor: true, children: '│' })),
        })]),
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
      await logLine($, 'supervision', messageOf(err))
      return next(e)
    } finally {
      const took = await clockNow($) - started
      if (took > PANE_RENDER_BOUND_MS && !renderSlow) await logLine($, 'supervision', `pane: the render took ${took} ms, past its bound of ${PANE_RENDER_BOUND_MS} ms`)
      renderSlow = took > PANE_RENDER_BOUND_MS
    }
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// The bound on the whole relay at a turn's end: the row and wait reads, the wait's
// write, the coordinator's record and the send queued. Well inside a handler's ten seconds.
const RELAY_BOUND_MS = 5000

// The bound on each read of a delivery's facts (git's three and gh's one, run at once): inside the relay's.
const FACTS_BOUND_MS = 3000

// The gate's last answer ci-watch kept for a pull request, under the state root it shares with the
// scripts: a file it has not written is no reading.
function keptGate($: Host<'env' | 'fs'>): KeptGate {
  return async (repo, pr) => {
    const path = ciGatePath(await dataDir($), repo, String(pr))
    return await $.fs.exists(path) ? String(await $.fs.read(path)) : null
  }
}

// Whether a session of this role puts its operator questions into the round: an orchestrator, a
// coordinator and an auditor do, as one rule for every turn's end.
export function entersRound(role: string | null): boolean {
  return role === 'orchestrator' || role === 'coordinator' || role === 'auditor'
}

// The session's name, host pid and tty, with its row: the row's (the measure's walk named it), else
// a walk of its own when the row names no role, or an agent without its tty.
export async function selfOf($: Host<'env' | 'fs' | 'process'>, sessionId: string): Promise<{ row: SessionRow | null; name: string | null; pid: string | null; tty: string | null }> {
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
  if (row?.role && (row.role !== 'agent' || row.tty)) return { row, name: row.name, pid: row.pid ?? null, tty: row.tty ?? null }
  const walked = await walkWithinBound($, sessionId)
  return walked.known
    ? { row, name: walked.name, pid: walked.pid ?? row?.pid ?? null, tty: walked.tty ?? row?.tty ?? null }
    : { row, name: row?.name ?? null, pid: row?.pid ?? null, tty: row?.tty ?? null }
}

// A turn's end, read and reported. The role comes from the session's row (the measure's
// walk named it), else from a walk of its own. An orchestrator's machine line goes to the
// coordinator: an entry of its round when it runs on this machine, a message when it runs
// on another; an agent's status line to its orchestrator, found in the launcher's chains or
// else in the orchestrator its launch recorded (orchestratorOn), never in the turn's text; any
// other role, nothing.
// No line: a wait the session carried is cleared; an orchestrator sends nothing, an agent's
// orchestrator is sent one report for each such turn, with the turn's last text cut at the cap, unless
// that very turn was already (key `no-status:<turn id>`). A line: written to the
// session's wait file, then reported unless this very one was already — the fingerprint
// is kept only once the entry is in place or the send is delivered. Nobody to send to: nothing
// is sent. A write that fails or a send refused is one log line; the turn's end is never held
// on it. The row itself is never written here: the measure is its one writer.
// An operator wait waits on questions asked with `ask`, already in the round as their own objects:
// its wait is written, so its row shows it waiting, and no entry is entered or sent.
// An agent's turn without a status line that ended with work still in flight (`inFlight`, what the
// host listed at the stop) is no idle agent: nothing is sent; its next turn's end reports.
// An agent's turn the host ended in its own words (its limit or spend text, an API error: relay.ts hostStopOf,
// read on the answer, else on the transcript's tail) is sent as one stop line (relayStop), work in
// flight or not: nothing resumes it. Any other end that is no answer is read for that alone.
export async function relayTurnEnd($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, answer: string, turnId: unknown, inFlight: readonly string[] | null = null, reason: string = 'answer',
  declared: { wait: DeclaredWait | null; handedOver: boolean } = { wait: null, handedOver: false }, outbox: Outgoing[] = []): Promise<void> {
  const sessionId = await $.session.id()
  const { row, name, pid, tty } = await selfOf($, sessionId)
  const role = roleOf(name)
  const orchestrating = entersRound(role)
  if (!name || (!orchestrating && role !== 'agent')) return
  if (role === 'agent') {
    const stop = hostStopOf(answer) ?? (reason !== 'answer' || answer.trim() === '' ? await stopAtTail($, sessionId) : null)
    if (stop) return relayStop($, sessionId, name, pid, tty, stop, turnId)
  }
  if (reason !== 'answer') return
  // An agent's text goes up held to the verdict limit; an orchestrator's to the coordinator is never cut here.
  const whole = answer
  if (role === 'agent') answer = heldReport(answer)
  const wait = orchestrating ? declaredWait(declared.wait, answer) : parseStatus(answer)
  const before = await readWait($, sessionId)
  const relayed = before?.relayed ?? null
  // The id of the entry a remote coordinator acknowledged, kept while its fingerprint is.
  const relayedId = relayed !== null ? before?.relayed_id ?? null : null
  // A session that spawned its successor, once that successor confirmed the takeover: it holds the work, and the questions.
  const successor = role === 'orchestrator' && declared.handedOver ? await readSuccessor($, sessionId) : null
  if (successor) await handOver($, sessionId, successor)
  if (!wait && orchestrating) {
    if (before?.waiting) await writeWait($, sessionId, { ...clearedWait(before), relayed, relayed_id: relayedId, name, pid })
    return
  }
  const patch = wait
    ? waitPatch(before, wait, new Date().toISOString())
    : before?.waiting ? clearedWait(before) : null
  if (patch) await writeWait($, sessionId, { ...patch, relayed, relayed_id: relayedId, name, pid })
  if (orchestrating && wait?.kind === 'operator') return
  if (!wait && inFlight !== null && inFlight.length > 0) return
  const key = wait ? fingerprint(wait) : noStatusKey(turnId, answer)
  let coordinator: Awaited<ReturnType<typeof coordinatorAddress>> = null
  if (relayed === key) {
    // The fingerprint of a question whose entry the coordinator closed (its answer comes by a
    // message, which forgets nothing) or archived blocks nothing: only an entry still open does.
    if (!orchestrating || !wait || wait.kind !== 'done') return
    coordinator = await coordinatorAddress($)
    if (!coordinator?.local || await entryIsOpen($, roundEntryId(sessionId, wait))) return
  } else if (orchestrating) {
    coordinator = await coordinatorAddress($)
  }
  // A coordinator on this machine reads its round: the wait is entered there, and its model
  // is not woken for it. The fingerprint is kept once the entry is in place, as a delivery's.
  if (coordinator?.local && wait && patch) {
    const entry = roundEntry(sessionId, name, wait, patch.waiting_since!, new Date().toISOString())
    // A closing proposal entered again after its withdrawal reuses its id: the coordinator was not shown this one.
    await forgetShown($, entry.id)
    await changeEntry($, roundPath(await dataDir($), entry.id), () => entry)
    await writeWait($, sessionId, { ...patch, relayed: key, name, pid })
    return
  }
  const to = orchestrating
    ? coordinator?.to ?? null
    : await orchestratorOn($, tty, name, 'relay')
  if (!to) {
    if (role === 'agent') await logLine($, 'supervision', `relay: no orchestrator found for ${name} on ${tty ?? 'an unknown tty'}`)
    return
  }
  // A coordinator on another machine is sent the entry itself, to enter in its round: the wait
  // holds it as pending until the acknowledgment, which keeps the fingerprint (receiveAck). The
  // pending mark is written before the send, so an acknowledgment arriving as it returns finds it.
  if (orchestrating && wait && patch) {
    const entry = roundEntry(sessionId, name, wait, patch.waiting_since!, new Date().toISOString())
    await writeWait($, sessionId, { ...patch, relayed, relayed_id: relayedId, pending: entry.id, pending_key: key, name, pid })
    const item: Outgoing = {
      to: coordinator!, line: qAskLine(entry, await machineOf($)),
      settle: async sent => {
        if (sent?.isDelivered) return
        await logLine($, 'supervision', `relay: not delivered to ${addressLabel(to)}: ${sent?.reason ?? 'no answer'}`)
        const now = await readWait($, sessionId)
        if (now && now.pending === entry.id) await writeWait($, sessionId, { ...now, pending: null, pending_key: null })
      },
    }
    outbox.push(item)
    return
  }
  /*
   * The figure is the host's own at this turn's end: the row is written by the measure, which
   * runs after the turn ends, so it still holds the turn before's figure (a gate crossed in this
   * turn went unsaid). The row answers only when the host has no figure.
   */
  const now = await $.session.usage().then(u => u.context, () => null)
  const figure = now && typeof now.tokens === 'number' && now.tokens > 0 && typeof now.percent === 'number'
    ? { tokens: now.tokens, percent: now.percent }
    : row && row.context_tokens > 0 ? { tokens: row.context_tokens, percent: row.context_percent } : null
  const context = figure ? `${figure.tokens.toLocaleString('en-US')} (${figure.percent}%)` : null
  /*
   * A delivery's facts are read on the repository, not taken from its report (relay.ts readDeliveryFacts),
   * in the session's own checkout: the module runs in another directory, and a read there said FALSE
   * CLAIM of clean deliveries (2026-11-15). A checkout the host does not name gives no facts line,
   * said in the log.
   */
  const checkout = wait?.kind === 'delivered' ? await $.session.root().then(root => root || $.session.cwd()).catch(() => '') : ''
  if (wait?.kind === 'delivered' && !checkout) await logLine($, 'supervision', `relay: ${name}'s checkout is unread: its delivery goes without facts`)
  const facts = checkout
    ? factsLine(await readDeliveryFacts((argv, timeoutMs) => $.process.run(argv, { timeoutMs: timeoutMs ?? FACTS_BOUND_MS, cwd: checkout }), whole, keptGate($)))
    : null
  const text = wait ? relayText(name, wait, patch!.waiting_since!, context, facts) : noStatusText(name, context, answer)
  const sent = orchestrating ? await sendToCoordinator($, coordinator!, text) : await $.session.send({ to, text })
  if (sent?.isDelivered) {
    await writeWait($, sessionId, { ...(patch ?? before ?? {}), relayed: key, name, pid })
  } else {
    await logLine($, 'supervision', `relay: not delivered to ${addressLabel(to)}: ${sent?.reason ?? 'no answer'}`)
  }
}

// The bytes of the transcript's end read for a stop the host wrote: its last lines, never the whole file.
const STOP_TAIL_BYTES = 65536

// The stop the session's transcript ends on (relay.ts stopInTail), null when it cannot be read.
async function stopAtTail($: Host<'env' | 'fs' | 'process'>, sessionId: string): Promise<HostStop | null> {
  const path = await transcriptPathOf($, sessionId)
  if (path === '') return null
  const tail = await $.process.run(['tail', '-c', String(STOP_TAIL_BYTES), path], { timeoutMs: FACTS_BOUND_MS }).catch(() => null)
  return tail && tail.exitCode === 0 ? stopInTail(String(tail.stdout ?? '')) : null
}

// An agent stopped by the host, told to its orchestrator in one line, once per stop (relay.ts
// stopKey in the wait file's `relayed`); a wait it carried is cleared. Nobody to tell, or a send
// refused, is one log line, and the next turn's end tries again.
async function relayStop($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, sessionId: string, name: string,
  pid: string | null, tty: string | null, stop: HostStop, turnId: unknown): Promise<void> {
  const before = await readWait($, sessionId)
  const key = stopKey(turnId, stop)
  if (before?.relayed === key) return
  const to = await orchestratorOn($, tty, name, 'relay')
  if (!to) {
    await logLine($, 'supervision', `relay: no orchestrator found for ${name} on ${tty ?? 'an unknown tty'}`)
    return
  }
  const sent = await $.session.send({ to, text: stopText(name, stop) })
  if (sent?.isDelivered) await writeWait($, sessionId, { ...(before?.waiting ? clearedWait(before) : before ?? {}), relayed: key, name, pid })
  else await logLine($, 'supervision', `relay: not delivered to ${addressLabel(to)}: ${sent?.reason ?? 'no answer'}`)
}

// The session's open entries moved to the successor that confirmed the takeover, within the bound.
async function handOver($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, sessionId: string, successor: LearntSuccessor): Promise<void> {
  const until = Date.now() + RELAY_BOUND_MS
  const done = await withDeadline(moveToSuccessor($, sessionId, successor), RELAY_BOUND_MS)
  if (isDegradedPass(done)) await logLine($, 'supervision', `round: did not finish within ${RELAY_BOUND_MS} ms`)
  else await tellSettled($, done, until)
}

// The held question's entry in the round: that session's open operator question with the same
// start and the same blocks, marked withdrawn, answered in its own tab, or closed so when the
// coordinator was shown it (the entries to tell it of), with what the operator typed (`held.said`).
// With it, every open entry of that session twin to one of those (areTwins: one of the two moved to
// it at a succession, `movedFrom`, the same question, spacing aside) is settled the same way: the successor
// asking again what its predecessor asked keeps the predecessor's wait start and its own wording
// of the blocks, so only the question's text recognises the two as one (the operator's report of
// 2026-11-10). A moved entry that asks another question stays open. None found, nothing is written and the
// log says so; one that cannot be written throws, and the next typed prompt tries again, and so
// does the turn's end.
async function withdrawEntry($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process'>, sessionId: string, name: string, held: { blocks: string; since: string | null; said?: string }): Promise<Settled[]> {
  const settled: Settled[] = []
  const open = (await readRound($)).filter(({ entry }) => entry.session === sessionId && entry.kind === 'operator' && entry.status === 'open')
  const direct = open.filter(({ entry }) => entry.since === held.since && entry.blocks === held.blocks)
  const twins = open.filter(({ entry }) => !direct.some(found => found.entry.id === entry.id) && direct.some(found => areTwins(found.entry, entry)))
  for (const { path, entry } of [...direct, ...twins]) {
    const at = new Date().toISOString()
    const closed = await closesItself($, entry.id)
    const answer: RoundAnswer = { text: closed ? `withdrawn: ${TAB_ANSWER}` : TAB_ANSWER, by: 'tab', at, ...(held.said ? { typed: held.said } : {}) }
    // Read again under the lock: an answer the pane wrote meanwhile stands.
    const written = await changeEntry($, path, current =>
      current && current.status === 'open' && current.session === sessionId ? { ...current, status: closed ? 'closed' : 'withdrawn', answer } : null)
    if (!written) await logLine($, 'supervision', `round: ${entry.id} was settled meanwhile, left as it is`)
    else if (closed) settled.push({ entry, answer })
  }
  if (direct.length === 0) await logLine($, 'supervision', `round: no open entry matched for ${name} since ${held.since ?? '?'}`)
  return settled
}

// A question's « other answer » forgotten: its field and its note to answer in the session.
function forgetDraft(pane: PaneMemory, key: string): void {
  pane.other.delete(key)
  if (pane.writing === key) pane.writing = null
}

// Whether the round holds the entry of that id, open: a file absent, or in any other status, is not.
async function entryIsOpen($: Host<'env' | 'fs'>, id: string): Promise<boolean> {
  return parseRoundEntry(String(await $.fs.read(roundPath(await dataDir($), id)).catch(() => '')))?.status === 'open'
}

// A settled entry's fingerprint forgotten in its sender's wait file, so the same question asked
// again is entered again: the file is re-read and written back with `relayed` null only when it
// still holds that entry's own fingerprint (a later wait may have replaced it).
export async function forgetRelayed($: Host<'clock' | 'env' | 'fs' | 'process'>, entry: RoundEntry): Promise<void> {
  const now = await readWait($, entry.session)
  if (now && now.relayed === entryFingerprint(entry)) await writeWait($, entry.session, { ...now, relayed: null })
}

// The session's own name by its walk alone (its host's record, its launch name, its last rename):
// the name of a session whose row is not written yet, or was written by a walk that did not finish.
// `known` is false when the walk did not finish, the whole of it (the transcript's place included)
// held to the side-read bound, and a name null with `known` true is a session found unnamed.
export async function walkedName($: Host<'env' | 'fs' | 'process'>, sessionId: string): Promise<{ known: boolean; name: string | null }> {
  const walked = await withDeadline(walkWithinBound($, sessionId), await sideReadBoundMs($))
  return isDegradedPass(walked) ? { known: false, name: null } : { known: walked.known, name: walked.name }
}

// The role of the session: the name its row holds, else the name its walk reads.
export async function sessionRole($: Host<'env' | 'fs' | 'process'>, sessionId: string): Promise<string | null> {
  return roleOf(await sessionNameOf($, sessionId))
}

// Whether the session reports to a live orchestrator: the launch's record, else its tty's chain (orchestratorOn).
export async function reportsToOrchestrator($: Host<'env' | 'fs' | 'plugin' | 'process'>, sessionId: string, name: string): Promise<boolean> {
  const { tty } = await walkWithinBound($, sessionId)
  return (await orchestratorOn($, tty, name, 'review session')) !== null
}

// The session's name: the one its row holds, else the one its walk reads.
export async function sessionNameOf($: Host<'env' | 'fs' | 'process'>, sessionId: string): Promise<string | null> {
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
  return row?.name ?? (await walkWithinBound($, sessionId)).name ?? null
}

// Whether the session is an orchestrator.
export async function isOrchestratorSession($: Host<'env' | 'fs' | 'process'>, sessionId: string): Promise<boolean> {
  return (await sessionRole($, sessionId)) === 'orchestrator'
}

// Why a closing proposal is withdrawn when its session's next turn starts.
export const WORKS_AGAIN = 'its sender works again'
// Why a closing proposal is withdrawn at its sender's hand-over, never moved to the successor.
export const HANDED_ON = 'its sender handed over: the successor works on'

// The open entries of a session withdrawn by their sender: a closing proposal once its session starts
// a turn again (WORKS_AGAIN) or hands over (HANDED_ON), every open entry of a session that ended, or
// that died with no successor learnt. Each leaves the pane and its count.
// `current` is the id of the entry this turn's wait has, kept open; `why` the withdrawal's answer
// text; `kept` the entries left open besides. An entry the
// coordinator on this machine was shown is closed instead, its answer « withdrawn: <why> », and returned so the caller tells it once
// every write is done. Each withdrawal is one log line; one that cannot be written is one too,
// and the relay goes on.
async function withdrawStale($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, sessionId: string, current: string | null, why: string, kept?: (entry: RoundEntry) => boolean): Promise<Settled[]> {
  const settled: Settled[] = []
  for (const { path, entry } of await readRound($)) {
    if (entry.session !== sessionId || entry.status !== 'open' || entry.id === current || kept?.(entry)) continue
    try {
      const shown = await closesItself($, entry.id)
      const at = new Date().toISOString()
      // Read again under the lock: a move to a successor or an answer in between is never overwritten.
      const done = await closeRound($, path, current => {
        const fresh = parseRoundEntry(current ?? '')
        return !fresh || fresh.status !== 'open' || fresh.session !== sessionId ? null : planWithdrawal(fresh, why, at, shown)
      }, { session: sessionId, name: entry.from, role: 'orchestrator' }, at, () => logLine($, 'supervision', `round: withdrawn by the sender: ${entry.id}`))
      if (done === null || 'error' in done) continue
      const answer = done.plan.entry['answer']
      if (shown && isRoundAnswer(answer)) settled.push({ entry, answer })
    } catch (err) {
      await logLine($, 'supervision', `round: ${messageOf(err)}`)
    }
  }
  return settled
}

// Every entry of the round on this machine, each with the file it was read from. A file that
// does not parse to an entry is skipped, never repaired; a temporary file is no entry yet. A
// directory that exists and cannot be listed is said in the log and read as empty; one never
// written is no failure — nothing was ever asked.
export async function readRound($: Host<'env' | 'fs' | 'plugin' | 'process'>): Promise<{ path: string; entry: RoundEntry }[]> {
  const dir = `${await dataDir($)}/${ROUND_DIR}`
  let listed: readonly { name: string; kind: string; mtimeMs?: number }[]
  try {
    listed = await $.fs.list(dir)
  } catch (err) {
    if (await $.fs.exists(dir).catch(() => true)) await logLine($, 'supervision', `round: cannot list ${dir}: ${messageOf(err)}`)
    return []
  }
  const stale = staleTemporaries(dir, listed, Date.now())
  if (stale.length > 0) await $.process.run(removeArgv(...stale), { timeoutMs: 5000 }).catch(() => undefined)
  const read: { path: string; entry: RoundEntry }[] = []
  for (const file of listed) {
    if (!file || file.kind !== 'file' || !file.name.endsWith('.json') || isTemporary(file.name)) continue
    const entry = parseRoundEntry(String(await $.fs.read(`${dir}/${file.name}`).catch(() => '')))
    if (entry) read.push({ path: `${dir}/${file.name}`, entry })
  }
  return read
}

const ROUND_STATUSES: readonly RoundEntry['status'][] = ['open', 'answered', 'withdrawn', 'closed']

// An entry file read back: the JSON of one entry, each field of its type, or nothing.
export function parseRoundEntry(text: string): RoundEntry | null {
  try {
    return roundEntryOf(JSON.parse(text))
  } catch {
    return null
  }
}

const ANSWER_BYS: readonly RoundAnswer['by'][] = ['pane', 'coordinator', 'tab', 'sender', 'message']
const isStatus = (value: unknown): value is RoundEntry['status'] => ROUND_STATUSES.some(status => status === value)

// An entry's answer, each field of its type, or undefined when it is none.
function roundAnswerOf(read: unknown): RoundAnswer | undefined {
  if (!isRecord(read)) return undefined
  const { text, by, at } = { text: read['text'], by: ANSWER_BYS.find(known => known === read['by']), at: read['at'] }
  if (!isText(text) || by === undefined || !isText(at)) return undefined
  const extra: Partial<RoundAnswer> = {}
  for (const key of ['author', 'evidence', 'typed', 'record'] as const) {
    const value = read[key]
    if (value === undefined) continue
    if (!isText(value)) return undefined
    extra[key] = value
  }
  return { text, by, at, ...extra }
}

export function isRoundAnswer(value: unknown): value is RoundAnswer {
  return roundAnswerOf(value) !== undefined
}

// An entry's value, each field of its type, or nothing.
function roundEntryOf(e: unknown): RoundEntry | null {
  if (!isRecord(e)) return null
  const { id, from, session, since, question, at, blocks, recommendation, kind, status } = {
    id: e['id'], from: e['from'], session: e['session'], since: e['since'], question: e['question'], at: e['at'],
    blocks: e['blocks'], recommendation: e['recommendation'], kind: e['kind'], status: e['status'],
  }
  if (!isText(id) || !isText(from) || !isText(session) || !isText(since) || !isText(question) || !isText(at)) return null
  if (!isTextOrNull(blocks) || !isTextOrNull(recommendation) || !isRoundKind(kind) || !isStatus(status)) return null
  const choicesRead = e['choices']
  if (!Array.isArray(choicesRead)) return null
  const choices: RoundEntry['choices'] = []
  for (const c of choicesRead) {
    if (!isRecord(c) || !isText(c['letter']) || !isText(c['text'])) return null
    choices.push({ letter: c['letter'], text: c['text'] })
  }
  const answer = e['answer'] === null || e['answer'] === undefined ? null : roundAnswerOf(e['answer'])
  if (answer === undefined) return null
  const originRead = e['origin']
  const origin = originRead === undefined ? undefined
    : isRecord(originRead) && isText(originRead['machine']) && isText(originRead['address'])
      ? { machine: originRead['machine'], address: originRead['address'] }
      : null
  if (origin === null) return null
  const delivery = deliveryOfEntry(e['delivery'], origin !== undefined)
  if (delivery === null) return null
  const movedFrom = e['movedFrom']
  if (movedFrom !== undefined && !isText(movedFrom)) return null
  return {
    id, from, session, kind, since, blocks, question, choices, recommendation, status, at, answer,
    ...(e['urgent'] === true ? { urgent: true as const } : {}),
    ...(movedFrom !== undefined ? { movedFrom } : {}),
    ...(origin !== undefined ? { origin } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
  }
}

// An entry's delivery, when it carries one, its fields of their type and no other, the reason a
// text: beside an origin, its state one of a remote answer's and no answer stamp; without one, its
// state one of an answer's on this machine and the stamp of the answer it carries. Undefined when
// it carries none, null when it is malformed.
const DELIVERY_STATES: readonly RoundDelivery['state'][] = ['pending', 'sent', 'acked', 'failed']
const LOCAL_DELIVERY_STATES: readonly RoundDelivery['state'][] = ['pending', 'delivered', 'failed']
function deliveryOfEntry(d: unknown, remote: boolean): RoundDelivery | null | undefined {
  if (d === undefined) return undefined
  if (!isRecord(d)) return null
  const state = (remote ? DELIVERY_STATES : LOCAL_DELIVERY_STATES).find(known => known === d['state'])
  const { at, attempts, answerAt, reason } = { at: d['at'], attempts: d['attempts'], answerAt: d['answerAt'], reason: d['reason'] }
  const shaped = state !== undefined && (remote ? answerAt === undefined : isText(answerAt))
  if (!shaped || !isText(at) || typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) return null
  if (reason !== undefined && !isText(reason)) return null
  if (!Object.keys(d).every(key => ['state', 'at', 'attempts', 'answerAt', 'reason'].includes(key))) return null
  return { state, at, attempts, ...(isText(answerAt) ? { answerAt } : {}), ...(reason !== undefined ? { reason } : {}) }
}

// Where an orchestrator's reports go: the coordinator registered on this machine first
// (coordinator.sh's record), else the one a peer delivery taught this machine — its
// address as the envelope gave it, else its name. Null when neither names one. A name recorded
// without its reference may be another session's too, one the host keeps for its remote control
// say, and the host refuses a send to a name several carry: the coordinator on this machine is
// then addressed by the session id the host's registry gives it.
export type CoordinatorTo = string | { sessionId: string }
export async function coordinatorAddress($: Host<'env' | 'fs'>): Promise<{ to: CoordinatorTo; name: string; local: boolean } | null> {
  const recordText = String(await $.fs.read(`${await stateDir($)}/coordinator.json`).catch(() => ''))
  const local = coordinatorOf(recordText)
  if (local) return { to: REFERENCED.test(local) ? local : (await registeredSession($, local, recordText)) ?? local, name: local, local: true }
  const learnt = parseLearnt(String(await $.fs.read(`${await storeOf($)}/coordinator-learnt`).catch(() => '')))
  return learnt ? { to: learnt.from ?? learnt.name, name: learnt.name, local: false } : null
}

// A name that carries its session's reference, « Coord: ops [abc] »: no other session has it.
export const REFERENCED = / \[[^\]\s]+\]$/

// The session id of the one session on this machine that the host's registry (its sessions
// directory, one record per process) names so, the process the coordinator's record names when
// several do; null when none or several, or when the registry cannot be read. `exclude` is a
// session id left out of the candidates, and `pid` the process to choose among several, over
// the record's own.
async function registeredSession($: Host<'env' | 'fs'>, name: string, recordText: string, options: { exclude?: string; pid?: string | null } = {}): Promise<{ sessionId: string } | null> {
  let pid: string | null = options.pid ?? null
  try {
    const read: unknown = JSON.parse(recordText)
    const recorded = isRecord(read) ? read['pid'] : undefined
    if (pid === null && recorded !== undefined && recorded !== null && String(recorded) !== '') pid = String(recorded)
  } catch { /* coordinatorOf read it already */ }
  const dir = `${await configDir($)}/sessions`
  const named: { pid: string; sessionId: string }[] = []
  try {
    for (const file of await $.fs.list(dir)) {
      if (!file || file.kind !== 'file' || !file.name.endsWith('.json')) continue
      try {
        const record = registryRecord(String(await $.fs.read(`${dir}/${file.name}`)))
        if (record !== null && record.name === name && record.sessionId !== options.exclude) named.push({ pid: String(record.pid ?? ''), sessionId: record.sessionId })
      } catch { /* a record being written, or gone: not this one */ }
    }
  } catch {
    return null
  }
  const chosen = named.length > 1 && pid !== null ? named.filter(record => record.pid === pid) : named
  const [only] = chosen
  return chosen.length === 1 && only ? { sessionId: only.sessionId } : null
}

// A send to the coordinator. An address a peer delivery taught that refuses — a bridge whose
// session ended when the coordinator handed over to a successor of its name — is forgotten before
// the same text goes to the name, so the acknowledgment that answers it teaches the new address
// (learnCoordinator): the name alone is the coordinator, whatever session holds it now.
export type Coordinator = { to: CoordinatorTo; name: string; local: boolean }
export async function sendToCoordinator($: Host<'clock' | 'env' | 'fs' | 'process' | 'session'>, coordinator: Coordinator, text: string): Promise<SessionSendResult> {
  const sent = await sendTo($, coordinator.to, text)
  if (sent?.isDelivered || coordinator.local || coordinator.to === coordinator.name) return sent
  await forgetAddress($, coordinator)
  const named = await sendTo($, coordinator.name, text)
  return named?.isDelivered ? named : { isDelivered: false, reason: `${sent?.reason ?? 'no answer'}; by its name: ${named?.reason ?? 'no answer'}` }
}

// The learnt address forgotten while the file still holds that very one: an address learnt since stays.
async function forgetAddress($: Host<'clock' | 'env' | 'fs' | 'process'>, coordinator: Coordinator): Promise<void> {
  const path = `${await storeOf($)}/coordinator-learnt`
  const known = parseLearnt(String(await $.fs.read(path).catch(() => '')))
  if (!known || known.name !== coordinator.name || known.from === null || known.from !== coordinator.to) return
  await writeAtomic($, path, JSON.stringify({ ...known, from: null, at: new Date().toISOString() }) + '\n')
}

// A name the host refuses as several sessions' is sent once more to the one the refusal places on
// this machine, by its reference, when it names exactly one.
async function sendTo($: Host<'session'>, to: CoordinatorTo, text: string): Promise<SessionSendResult> {
  const sent = await $.session.send({ to, text })
  if (sent?.isDelivered || typeof to !== 'string') return sent
  const here = String(sent.reason ?? '').split('\n').flatMap(line => line.match(/^\s*(.+ \[[^\]\s]+\]) — .*\bon this machine\b/)?.[1] ?? [])
  const [only] = here
  return here.length === 1 && only !== undefined && only !== to ? $.session.send({ to: only, text }) : sent
}



// A recipient as a log line names it.
function addressLabel(to: CoordinatorTo): string {
  return typeof to === 'string' ? to : `session ${to.sessionId}`
}

// `forgotten`: taught only when the address of a coordinator of that name was forgotten, by any of
// its deliveries, its acknowledgments among them; any other coordinator's message teaches always.
async function learnCoordinator($: Host<'clock' | 'env' | 'fs' | 'process'>, learnt: { name: string; from: string | null; at: string }, forgotten = false): Promise<void> {
  const path = `${await storeOf($)}/coordinator-learnt`
  const known = parseLearnt(String(await $.fs.read(path).catch(() => '')))
  if (known && known.name === learnt.name && known.from === learnt.from) return
  if (forgotten && !(known && known.name === learnt.name && known.from === null)) return
  await writeAtomic($, path, JSON.stringify(learnt) + '\n')
}

// A successor's « takeover confirmed », recorded by an orchestrator only, over any successor
// recorded before it: its session id when this machine's registry names it alone, else its name
// and address. At « takeover confirmed » the predecessor and its successor carry one name, so
// the receiving session's own record is left out of the candidates, and the process id the
// reply address carries (`uds:/…/<pid>.sock`) chooses among the several that remain.
async function learnSuccessor($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, learnt: LearntSuccessor): Promise<LearntSuccessor | null> {
  const sessionId = await $.session.id()
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
  if (roleOf(row?.name ?? null) !== 'orchestrator') return null
  const session = (await registeredSession($, learnt.name, '', { exclude: sessionId, pid: successorPid(learnt) }))?.sessionId ?? null
  await writeAtomic($, `${await storeOf($)}/${successorKey(sessionId)}`, JSON.stringify({ ...learnt, session }) + '\n')
  await logLine($, 'supervision', `round: successor learnt: ${learnt.name}${session ? ` (session ${session})` : ''}`)
  return { ...learnt, session }
}

// The process id a successor's reply address carries (`uds:/…/<pid>.sock`), or none.
function successorPid(successor: LearntSuccessor): string | null {
  return successor.from?.match(/\/(\d+)\.sock$/)?.[1] ?? null
}

async function readSuccessor($: Host<'env' | 'fs'>, sessionId: string): Promise<LearntSuccessor | null> {
  return parseSuccessor(String(await $.fs.read(`${await storeOf($)}/${successorKey(sessionId)}`).catch(() => '')))
}

// The session's open entries rewritten in place for its successor: its session and name become
// theirs and the status stays open. The successor's own fingerprint is left as it is. Each move
// is one log line; one that cannot be written is one too, and the others go on. A closing
// proposal is withdrawn instead (HANDED_ON): the one settlement the coordinator is told of.
async function moveToSuccessor($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, sessionId: string, successor: LearntSuccessor): Promise<Settled[]> {
  // A successor the registry did not name alone at its « takeover confirmed » is looked up again:
  // its record may have landed since. One still unnamed is drawn on its name (hostedSuccessors).
  const session = successor.session ?? (await registeredSession($, successor.name, '', { exclude: sessionId, pid: successorPid(successor) }))?.sessionId ?? ''
  // A closing proposal is never handed on: the successor works, so the orchestration is not done.
  const settled = await withdrawStale($, sessionId, null, HANDED_ON, entry => entry.kind !== 'done')
  for (const { path, entry } of await readRound($)) {
    if (entry.session !== sessionId || entry.status !== 'open' || entry.kind === 'done') continue
    try {
      const written = await changeEntry($, path, fresh =>
        !fresh || fresh.status !== 'open' || fresh.session !== sessionId ? null : { ...fresh, session, from: successor.name, movedFrom: sessionId })
      if (written) await logLine($, 'supervision', `round: moved to the successor ${successor.name}: ${entry.id}`)
    } catch (err) {
      await logLine($, 'supervision', `round: ${messageOf(err)}`)
    }
  }
  // The questions asked with `ask` follow, their asker now the successor.
  await moveAsked($, sessionId, { session, name: successor.name })
  return settled
}

// The host name, read once per module load: the machine label a row carries.
let machine: string | null = null
async function machineOf($: Host<'process'>): Promise<string> {
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
async function prsOf($: Host<'env' | 'fs'>, sessionId: string, repo: string | null): Promise<string[]> {
  const dir = `${await dataDir($)}/ci-watch`
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

// The pull requests an orchestrator's row lists: those its own ci-watch files cover, and the open ones its
// dispatch record holds (the row's `unattended.open`, set at its last turn end), each once, as `owner/name#n`,
// sorted and cut to the row's cap. A successor owns none of its predecessor's watches; the record is what it keeps.
async function pullRequestsOf($: Host<'env' | 'fs'>, sessionId: string, row: SessionRow): Promise<string[]> {
  return capPrs([...await prsOf($, sessionId, row.repo), ...(row.unattended?.open ?? []).filter(prShaped)])
}

// An orchestrator's row, for a coordinator on another machine when it is news
// (remote-row.ts): a coordinator on this machine reads the store itself, and none known
// is nobody to send to. It is sent at a turn's end alone, with the figures the host has at that
// instant, in the turn's one message (flushOutbox); what was sent is kept only once delivered, a
// failure is one log line, and the next turn's end sends it again.
export async function sendRow($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, sessionId: string, outbox?: Outgoing[]): Promise<void> {
  const store = await storeOf($)
  const read = parseSessionRow(String(await $.fs.read(`${store}/${sessionKey(sessionId)}`).catch(() => '')))
  if (read?.role !== 'orchestrator') return
  const to = await coordinatorAddress($)
  if (!to || to.local) return
  const prs = await pullRequestsOf($, sessionId, read)
  const waitText = String(await $.fs.read(`${store}/${waitKey(sessionId)}`).catch(() => ''))
  const fill = await hostFill($)
  // The reading is the one of this instant: its stamp is now, not the last measure's.
  const measured = { ...read, updated_at: new Date().toISOString(), ...(fill ? { context_tokens: fill.tokens, context_percent: fill.percent, window: fill.window } : {}) }
  const row = remoteRowOf(withWait(measured, waitText), await machineOf($), prs, openQuestions(parseWaitRecord(waitText)))
  if (!row) return
  const now = Date.now()
  const path = `${store}/${rowKey(sessionId)}`
  if (!rowIsNews(row, parseRowSent(String(await $.fs.read(path).catch(() => ''))), now)) return
  const item: Outgoing = {
    to, line: rowText(row),
    settle: async sent => {
      if (sent?.isDelivered) await writeAtomic($, path, JSON.stringify(rowSent(row, now)) + '\n')
      else await logLine($, 'supervision', `row: not delivered to ${to.name}: ${sent?.reason ?? 'no answer'}`)
    },
  }
  if (outbox) outbox.push(item)
  else await flushOutbox($, [item])
}

// The context fill as the host states it at this instant, none when it states none.
async function hostFill($: Host<'session'>): Promise<{ tokens: number; percent: number; window: number } | null> {
  try {
    const { context } = await $.session.usage()
    const { tokens, percent, window } = context ?? {}
    return typeof tokens === 'number' && tokens > 0 && typeof percent === 'number' && typeof window === 'number' && window > 0 ? { tokens, percent, window } : null
  } catch {
    return null
  }
}

// What a turn's end has to tell the coordinator on another machine: each line, the coordinator it
// goes to, and what is done once the send answered. One turn is one message, its lines in order
// (remote-round.ts splitLines), so the coordinator's phone shows one delivery for it.
export type Outgoing = { to: Coordinator; line: string; settle: (sent: SessionSendResult) => Promise<void> }

export async function flushOutbox($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, outbox: readonly Outgoing[]): Promise<void> {
  const [first] = outbox
  if (!first) return
  const sent = await sendToCoordinator($, first.to, joinLines(outbox.map(item => item.line))).catch((err: unknown): SessionSendResult => ({ isDelivered: false, reason: messageOf(err) }))
  // One item's settling that throws leaves the others' to run: a delivered row is still recorded.
  for (const item of outbox) await item.settle(sent).catch((err: unknown) => logLine($, 'supervision', `send: ${messageOf(err)}`))
}

// A remote orchestrator's ask (remote-round.ts), consumed whatever it holds. In the coordinator's
// session alone, one that passes every check is entered in the round with where it came from, and
// acknowledged to its sender. The same entry sent again, its wait's start unchanged, is never
// entered twice, whatever became of it since: it is acknowledged again, its first acknowledgment
// having been lost. Anything else is one log line.
async function receiveAsk($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, delivery: Delivery, asked: { entry: RoundEntry; machine: string } | null): Promise<{ consumed: string }> {
  const from = peerAddress(delivery)
  if (!asked || !from) {
    await logLine($, 'supervision', `receive: a remote question was refused (${delivery.body.length} characters${from ? '' : ', no sender address'})`)
    return { consumed: 'orchestrator: a malformed remote question, refused' }
  }
  // The line is the module's own: whatever throws below, it is consumed, never passed to a model.
  let step = 'the role read'
  try {
    if (await ownRole($) !== 'coordinator') {
      await logLine($, 'supervision', `receive: a remote question reached a session that is no coordinator: ${asked.entry.id}`)
      return { consumed: 'orchestrator: a remote question for no coordinator, dropped' }
    }
    // An older machine's question, asked by its machine line: this release enters none, no pane
    // would draw it. It is answered by the line it came by, which clears the sender's wait and
    // tells its model to ask it with ask; never acknowledged as entered.
    if (asked.entry.kind !== 'done') {
      await logLine($, 'supervision', `receive: an operator question from ${asked.machine} refused, its release asks by its machine line: ${asked.entry.id}`)
      step = 'the refusal'
      const at = new Date().toISOString()
      const readable = olderQuestionText(asked.entry.id, 'not entered')
      const sent = await $.session.send({ to: from, text: qAnswerLine(asked.entry.id, asked.entry.since, 'refused', at, readable) })
      if (!sent?.isDelivered) await logLine($, 'supervision', `receive: the refusal of ${asked.entry.id} was not delivered to ${from}: ${sent?.reason ?? 'no answer'}`)
      return { consumed: 'orchestrator: a remote operator question of an older release, refused' }
    }
    step = 'the entry read'
    const path = roundPath(await dataDir($), asked.entry.id)
    const known = parseRoundEntry(String(await $.fs.read(path).catch(() => '')))
    if (known?.since !== asked.entry.since) {
      const entry: RoundEntry = { ...asked.entry, origin: { machine: asked.machine, address: from } }
      step = 'the entry write'
      await changeEntry($, path, () => entry)
      await logLine($, 'supervision', `round: entered from ${asked.machine}: ${entry.id}`)
      step = 'the deck refresh'
      await refreshDeck($)
      step = 'the pane redraw'
      $.ui.invalidate('ui.render')
    }
    step = 'the acknowledgment'
    const sent = await $.session.send({ to: from, text: qAckLine({ id: asked.entry.id, seq: seqOf(asked.entry.since), of: 'ask' }) })
    if (!sent?.isDelivered) await logLine($, 'supervision', `receive: the acknowledgment of ${asked.entry.id} was not delivered to ${from}: ${sent?.reason ?? 'no answer'}`)
  } catch (err) {
    await logLine($, 'supervision', `receive: a remote question failed at ${step} (${asked.entry.id}): ${messageOf(err)}`)
  }
  return { consumed: 'orchestrator: a remote question, entered' }
}

// A coordinator's acknowledgment, consumed whatever it holds: the one of the entry this session's
// wait holds as pending, and of the very ask it holds (the same start), keeps its fingerprint, as
// a delivery's, and clears it. An older ask's, late, matches nothing: the newer one stays pending
// and is sent again. The wait is read again just before, a turn's end may have written it. Any
// other is one log line.
async function receiveAck($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, ack: QAck | null): Promise<{ consumed: string }> {
  let step = 'the wait read'
  try {
    const sessionId = await $.session.id()
    const now = ack === null ? null : await readWait($, sessionId)
    if (ack === null || !now || now.pending !== ack.id || !now.waiting_since || seqOf(now.waiting_since) !== ack.seq || typeof now.pending_key !== 'string') {
      await logLine($, 'supervision', `receive: an acknowledgment ${ack === null ? 'was refused' : `of ${ack.id} matches no pending question`}`)
      return { consumed: 'orchestrator: an acknowledgment, dropped' }
    }
    step = 'the wait write'
    await writeWait($, sessionId, { ...now, relayed: now.pending_key, relayed_id: now.pending, pending: null, pending_key: null })
  } catch (err) {
    await logLine($, 'supervision', `receive: an acknowledgment failed at ${step}${ack ? ` (${ack.id})` : ''}: ${messageOf(err)}`)
    return { consumed: 'orchestrator: an acknowledgment, failed' }
  }
  return { consumed: 'orchestrator: an acknowledgment, recorded' }
}

// The coordinator's answer to this session's question (remote-round.ts), the marked line consumed
// whatever happens. One that parses is taken when the wait's entry is that very one, of the same
// start — acknowledged (`relayed_id`), or still pending, its ask's acknowledgment lost: the wait
// forgets its fingerprint, as forgetRelayed does on the coordinator's machine, its pending ask, and
// its start, so the same wait asked again is a new ask, of a new start (waitPatch), entered again.
// It is acknowledged to the address it came from, and its readable line is passed to the model, the
// one part a model reads. The last one taken is kept (answeredKey): the same answer sent again, its
// acknowledgment lost, is acknowledged again and passed nowhere. A throw is one log line and the
// readable line still passes. A refused one is one log line, passed nowhere, never acknowledged.
async function receiveAnswer($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, delivery: Delivery, answer: { id: string } & Extract<QEvent, { kind: 'answer' }>): Promise<{ consumed: string } | { readable: string }> {
  let step = 'the wait read'
  try {
    const sessionId = await $.session.id()
    const taken = `${await storeOf($)}/${answeredKey(sessionId)}`
    const last = parseAnswered(String(await $.fs.read(taken).catch(() => '')))
    const again = last?.id === answer.id && last.since === answer.since
    // Settled first in this session's own tab: the answer that crossed it is not applied.
    const already = again && last.by === 'tab'
    const now = again ? null : await readWait($, sessionId)
    if (now && now.waiting_since === answer.since && (now.relayed_id === answer.id || now.pending === answer.id)) {
      step = 'the wait write'
      await writeWait($, sessionId, { ...now, waiting_since: null, relayed: null, relayed_id: null, pending: null, pending_key: null })
      step = 'the answer record'
      await writeAtomic($, taken, JSON.stringify({ id: answer.id, since: answer.since }) + '\n')
    }
    step = 'the acknowledgment'
    const from = peerAddress(delivery)
    if (!from) await logLine($, 'supervision', `receive: the answer to ${answer.id} came with no sender address, not acknowledged`)
    else {
      const ack = qAckLine({ id: answer.id, seq: seqOf(answer.since), of: 'answer', ...(already ? { already: true as const } : {}) })
      const sent = await $.session.send({ to: from, text: ack })
      if (!sent?.isDelivered) await logLine($, 'supervision', `receive: the acknowledgment of the answer to ${answer.id} was not delivered to ${from}: ${sent?.reason ?? 'no answer'}`)
    }
    if (already) return { consumed: 'orchestrator: an answer to a question answered in its tab first, said already answered' }
    if (again) return { consumed: 'orchestrator: an answer received already, acknowledged again' }
  } catch (err) {
    await logLine($, 'supervision', `receive: an answer failed at ${step} (${answer.id}): ${messageOf(err)}`)
  }
  return { readable: answer.readable }
}

// The last answer taken, as answeredKey's file holds it: null when it holds no id and start.
function parseAnswered(text: string): { id: string; since: string; by?: 'tab' } | null {
  try {
    const read: unknown = JSON.parse(text)
    if (!isRecord(read)) return null
    const [id, since] = [read['id'], read['since']]
    return isText(id) && isText(since) ? { id, since, ...(read['by'] === 'tab' ? { by: 'tab' as const } : {}) } : null
  } catch {
    return null
  }
}

// A remote sender's acknowledgment of the answer sent to it, consumed whatever it holds: the
// entry of that id and start, its answer pending, sent or failed, is acknowledged and closed, and
// the pane drawn again. Any other is one log line.
async function receiveAnswerAck($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'ui'>, ack: QAck | null): Promise<{ consumed: string }> {
  let step = 'the entry read'
  try {
    if (!ack) {
      await logLine($, 'supervision', "receive: an answer's acknowledgment was refused")
      return { consumed: "orchestrator: an answer's acknowledgment, refused" }
    }
    const path = roundPath(await dataDir($), ack.id)
    const entry = parseRoundEntry(String(await $.fs.read(path).catch(() => '')))
    const state = entry?.delivery?.state
    if (!entry?.origin || !entry.delivery || seqOf(entry.since) !== ack.seq || (state !== 'pending' && state !== 'sent' && state !== 'failed')) {
      await logLine($, 'supervision', `receive: an answer's acknowledgment of ${ack.id} matches no answer sent`)
      return { consumed: "orchestrator: an answer's acknowledgment, dropped" }
    }
    step = 'the entry write'
    await changeEntry($, path, now => {
      if (!now?.delivery || now.delivery.state !== entry.delivery!.state) return null
      const { reason: _reason, ...delivery } = now.delivery
      // Answered first in its sender's tab: the pane says so, as it says an answer not delivered.
      if (ack.already) return { ...now, status: 'closed', delivery: { ...delivery, state: 'failed', at: new Date().toISOString(), reason: ALREADY_ANSWERED } }
      return { ...now, status: 'closed', delivery: { ...delivery, state: 'acked', at: new Date().toISOString() } }
    })
    step = 'the pane redraw'
    $.ui.invalidate('ui.render')
  } catch (err) {
    await logLine($, 'supervision', `receive: an answer's acknowledgment failed at ${step}${ack ? ` (${ack.id})` : ''}: ${messageOf(err)}`)
  }
  return { consumed: "orchestrator: an answer's acknowledgment, recorded" }
}

// An event line's acknowledgment (remote-round.ts), dispatched by the event it takes.
async function receiveQAck($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, ack: QAck | null, from: string | null): Promise<{ consumed: string }> {
  if (ack?.of === 'asked') return receiveAskedAck($, from, ack)
  if (ack?.of === 'reply') return receiveReplyAck($, from, ack)
  return ack?.of === 'answer' ? receiveAnswerAck($, ack) : receiveAck($, ack)
}

// What the pane says of an answer its sender's tab had settled first.
export const ALREADY_ANSWERED = 'already answered in its own tab'

// A peer's address as its envelope gave it, when it is one a send can reach.
function peerAddress(delivery: Delivery): string | null {
  return delivery.from && delivery.from.length <= 200 && /^(?:uds|bridge):\S+$/.test(delivery.from) ? delivery.from : null
}

// This session's role, by the name its row carries, else by a walk of its own.

async function ownRole($: Host<'env' | 'fs' | 'process' | 'session'>): Promise<SessionRow['role']> {
  const sessionId = await $.session.id()
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
  if (row?.name) return roleOf(row.name)
  const walked = await walkWithinBound($, sessionId)
  return walked.known ? roleOf(walked.name) : null
}

// A marked delivery: consumed whatever it holds — the marker is the module's own, never a
// message for the model — and written as a remote row only when it passes every check.
async function receiveRow($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process'>, body: string): Promise<{ consumed: string }> {
  const row = parseRemoteRow(body)
  if (!row) {
    await logLine($, 'supervision', `receive: a marked row was refused (${body.length} characters)`)
    return { consumed: 'orchestrator: a malformed supervision row, refused' }
  }
  const path = `${await storeOf($)}/${remoteKey(row.name)}`
  const io = storeIo($)
  try {
    await withLockOver(io, path, () => writeAtomicOver(io, path, JSON.stringify(row) + '\n'))
  } catch (err) {
    // The lock stayed held, or the write failed: the next row the sender sends is stored instead.
    await logLine($, 'supervision', `receive: a remote row of ${row.name} was not stored: ${messageOf(err)}`)
    return { consumed: 'orchestrator: a supervision row, not stored' }
  }
  return { consumed: 'orchestrator: a supervision row, stored' }
}

// A remote orchestrator's withdrawal (withdrawalText): the fast path to what its next row says. In
// the coordinator's session alone, the open entry of that sender with that start and those blocks is
// settled as answered in its tab; any other is a message nobody needs: nothing is open, nothing
// changes. Only the peer whose address the entry came from (origin.address) can withdraw it, and
// the words the message quotes are a peer's, never the operator's consent: they are not passed on.
// Consumed whatever it holds, the line being the module's own.
async function receiveWithdrawal($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, withdrawal: NonNullable<ReturnType<typeof parseWithdrawal>>, from: string | null): Promise<{ consumed: string } | null> {
  if (await ownRole($) !== 'coordinator') return null
  try {
    const blocks = cleanBlocks(withdrawal.blocks)
    for (const { entry } of await readRound($)) {
      if (entry.status !== 'open' || entry.kind !== 'operator' || !entry.origin || entry.origin.address !== from || entry.from !== withdrawal.name || entry.since !== withdrawal.since || entry.blocks !== blocks) continue
      await tellSettled($, await withdrawEntry($, entry.session, entry.from, { blocks, since: entry.since }), Date.now() + RELAY_BOUND_MS)
    }
    $.ui.invalidate('ui.render')
  } catch (err) {
    await logLine($, 'supervision', `receive: a withdrawal failed (${withdrawal.name}): ${messageOf(err)}`)
  }
  return { consumed: 'coordinator: a remote withdrawal, applied' }
}

// The rows received from other machines, each checked again as it is read; a stale or
// malformed one is removed, so the directory never outgrows the live set. A row met dead is read
// again under the lock its writer takes (receiveRow), and removed only when it is still dead: a
// sender's newer row landing between the first read and the removal, or a read that failed once,
// never loses a live row.
const REMOTE_READ_CAP = 64
export async function readRemoteRows($: Host<'clock' | 'env' | 'fs' | 'process'>): Promise<RemoteRow[]> {
  const dir = `${await storeOf($)}/remote`
  const entries: { name: string; kind: string }[] = await $.fs.list(dir).catch(() => [])
  const rows: RemoteRow[] = []
  const now = Date.now()
  const live = (text: string | undefined) => {
    const row = text === undefined ? null : parseRemoteRow(`${ROW_MARKER}${text}`)
    return row && !isRemoteStale(row, now, REMOTE_STALE_AFTER_MS) ? row : null
  }
  const io = storeIo($)
  for (const entry of entries.slice(0, REMOTE_READ_CAP)) {
    if (!entry || entry.kind !== 'file' || isTemporary(entry.name) || entry.name.endsWith(STORE_CONTRACT.lock_suffix)) continue
    const path = `${dir}/${entry.name}`
    const row = live(await io.read(path))
    if (row) { rows.push(row); continue }
    const kept = await withLockOver(io, path, async () => {
      const text = await io.read(path)
      const again = live(text)
      if (!again && text !== undefined) await io.run(removeArgv(path))
      return again
    }, { tries: 5 }).catch(() => null)
    if (kept) rows.push(kept)
  }
  return rows
}

// The machine's deck (deck.ts): the store, the remote rows, the round (its entries and its questions
// asked with `ask`), the chains and the sleepers read once and written to the data root's
// deck.json, only when it is news against
// the file as it stands, whichever session wrote it last: every session of the machine computes
// the same view of the same store, so a view another one already wrote is not written again, and
// the stamp's refresh (DECK_REFRESH_MS) is the machine's, not each session's. Bounded by its
// callers and never a failure of theirs: a deck that cannot be written is one log line, and the
// next change writes it.
export async function writeDeck($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>): Promise<void> {
  const state = await dataDir($)
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
    if (row.role === 'orchestrator') prs.set(key, await pullRequestsOf($, key.slice('sessions/'.length), row))
  }
  const now = Date.now()
  const deck = deckOf({
    machine: await machineOf($), now, local, chains, prs,
    remote: await readRemoteRows($),
    // The relay's entries and the questions asked with `ask`, each its own object in the round; one
    // his prompt claimed in its asker's tab is gone from the round, as the pane and the wake read it.
    round: [...(await readRound($)).map(read => read.entry), ...(await readAsked($)).filter(entry => !entry.claimed).map(askedAsEntry)],
    sleepingText: String(await $.fs.read(`${await stateDir($)}/sleeping.json`).catch(() => '')),
    gate: await gateEnv($),
  })
  const path = `${state}/${DECK_FILE}`
  if (!deckIsNews(deck, writtenDeck(String(await $.fs.read(path).catch(() => ''))), now)) return
  await writeAtomic($, path, deckText(deck))
}

// The deck a file holds, with the time it was generated, or null when it holds none of this version.
function writtenDeck(text: string): { deck: Deck; at: number } | null {
  const deck = parseDeck(text)
  const at = Date.parse(deck?.generated_at ?? '')
  return deck && Number.isFinite(at) ? { deck, at } : null
}

// The session's own usage (usage.ts): its transcript and its subagents', never another
// session's, booked in module memory across reads so each one reads only the bytes appended
// since the last. The read runs detached from the hook that starts it (refreshDeck), one at a
// time per process: no hook waits on it, the deck written meanwhile carries the rows as they
// stand, and when the read completes it publishes the usage in the session's row and writes
// the deck again. A hook arriving while one runs starts none: the next hook's read takes
// whatever was appended meanwhile.
type OwnBook = { id: string; main: string | null | undefined; missedAt: number; book: UsageBook }
let ownBook: OwnBook | null = null
let usageRead: Promise<void> | null = null
const USAGE_READ_MS = 60 * 1000
// A transcript not found is looked for again after this long, never on every read: a session's
// first hook can run before the host has written its transcript.
export const TRANSCRIPT_RETRY_MS = 60 * 1000
const USAGE_ROLES: ReadonlySet<string> = new Set(['coordinator', 'orchestrator', 'agent'])

// Starts the read when none runs, and answers the running one: its promise never rejects. A
// hook never awaits it; a test does, with its own clock.
export function refreshUsage($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, clock: () => number = Date.now): Promise<void> {
  if (!usageRead) {
    usageRead = readOwnUsage($, clock)
      .then(async published => { if (published) await writeDeck($) })
      .catch(err => logLine($, 'supervision', `deck: usage: ${messageOf(err)}`))
      .finally(() => { usageRead = null })
  }
  return usageRead
}

// One read: the session's row says whether the deck lists it (its role); its transcript is
// found once, and a miss is looked for again at most once per TRANSCRIPT_RETRY_MS, so a read
// in between never lists the projects directory. True when the row was written.
async function readOwnUsage($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, clock: () => number): Promise<boolean> {
  const id = String(await $.session.id())
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(id)}`).catch(() => '')))
  if (!row || !USAGE_ROLES.has(String(row.role))) return false
  if (!ownBook || ownBook.id !== id) ownBook = { id, main: undefined, missedAt: 0, book: newBook() }
  const own = ownBook
  if (own.main === null && clock() - own.missedAt >= TRANSCRIPT_RETRY_MS) own.main = undefined
  if (own.main === undefined) {
    own.main = (await transcriptPathOf($, id)) || null
    if (!own.main) own.missedAt = clock()
    if (!own.main) await logOnce($, `transcript ${id}`, 'missing', `deck: no transcript found for session ${id}: its usage is null`)
  }
  await publishUsage($, id, own.main ? await bookOwn($, own, own.main) : null)
  return true
}

// The appended lines of the main transcript and of every subagent's, booked. A main
// transcript that cannot be read (deleted, unreadable) is usage null: its book and its path
// are dropped, and the next read looks for it again.
async function bookOwn($: Host<'env' | 'fs' | 'plugin' | 'process'>, own: OwnBook, main: string): Promise<DeckUsage | null> {
  const now = Date.now()
  const { prices, text } = await readPrices($)
  try {
    const size = (await $.fs.stat(main)).size
    if (typeof size !== 'number') throw new Error('no size')
  } catch (err) {
    await logOnce($, `main ${own.id}`, main, `deck: the transcript ${main} cannot be read (${messageOf(err)}): its usage is null`)
    own.main = undefined
    own.book = newBook()
    return null
  }
  logged.delete(`main ${own.id}`)
  const book = own.book
  settle(book, now, prices, text)
  const subagents = `${main.slice(0, -'.jsonl'.length)}/subagents`
  const listed: readonly { name: string; kind: string }[] = await $.fs.list(subagents).catch(() => [])
  const paths = [main, ...listed.filter(e => e.kind === 'file' && e.name.endsWith('.jsonl')).map(e => `${subagents}/${e.name}`).sort()]
  for (const path of [...book.files.keys()]) if (!paths.includes(path)) forget(book, path)
  for (const path of paths) {
    try {
      await readAppended($, book, path)
      logged.delete(`file ${path}`)
    } catch (err) {
      const message = messageOf(err)
      await logOnce($, `file ${path}`, message, `deck: usage of ${path}: ${message}`)
    }
  }
  if (book.malformed > 0) await logOnce($, `malformed ${own.id}`, String(book.malformed), `deck: ${book.malformed} malformed lines dropped from the transcripts of session ${own.id}`)
  return usageOf(book, now)
}

// routing/prices.json under the state directory. Missing or no JSON object: no prices, every
// period's cost null and its tokens still counted, said once per text the file holds.
async function readPrices($: Host<'env' | 'fs' | 'plugin' | 'process'>): Promise<{ prices: Prices; text: string }> {
  const path = `${await stateDir($)}/routing/prices.json`
  let text: string | null = null
  try {
    text = String(await $.fs.read(path))
  } catch { /* missing: said below */ }
  if (text === null) {
    await logOnce($, 'prices', '', `deck: no ${path}: every cost is null`)
    return { prices: {}, text: '' }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed)) {
      logged.delete('prices')
      // An entry the rule cannot price prices nothing, as usage.ts prices it.
      return { prices: Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, Price] => isPrice(entry[1]))), text }
    }
  } catch { /* said below */ }
  await logOnce($, 'prices', text, `deck: ${path} is no JSON object: every cost is null`)
  return { prices: {}, text }
}

// What the usage read last said per topic: a condition is logged when it starts or changes,
// never again on every read while it lasts, and forgotten when it ends.
const logged = new Map<string, string>()
async function logOnce($: Host<'env' | 'plugin' | 'process'>, topic: string, fingerprint: string, message: string): Promise<void> {
  if (logged.get(topic) === fingerprint) return
  logged.set(topic, fingerprint)
  await logLine($, 'supervision', message)
}

// The lines appended to one transcript since the book's offset; a file shorter than it was
// rewritten and is read again from its first byte.
async function readAppended($: Host<'fs' | 'process'>, book: UsageBook, path: string): Promise<void> {
  const size = (await $.fs.stat(path)).size
  if (typeof size !== 'number') throw new Error('no size')
  if (size < (book.files.get(path)?.offset ?? 0)) rewind(book, path)
  const offset = book.files.get(path)?.offset ?? 0
  if (size === offset) return
  const run = await $.process.run(appendedArgv(path, offset, size - offset), { timeoutMs: USAGE_READ_MS })
  const read = run?.exitCode === 0 ? consumedOf(String(run.stdout ?? '')) : null
  if (!read) throw new Error(`the reader exited ${run?.exitCode}`)
  ingest(book, path, offset, read.text, read.consumed)
}

async function refreshDeck($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, bound = RELAY_BOUND_MS): Promise<void> {
  // Detached: the hook goes on, and the read writes the row and the deck again when it is done.
  void refreshUsage($)
  try {
    const done = await withDeadline(writeDeck($), bound)
    if (isDegradedPass(done)) await logLine($, 'supervision', `deck: did not finish within ${bound} ms`)
  } catch (err) {
    await logLine($, 'supervision', `deck: ${messageOf(err)}`)
  }
}

// The deck and the remote coordinator's row said again, for a change of the session's row that no turn end made
// (the module's tick, ledger.ts): bounded, and never a failure of the caller's.
export async function refreshRowAndDeck($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, sessionId: string): Promise<void> {
  try {
    const sent = await withDeadline(sendRow($, sessionId), RELAY_BOUND_MS)
    if (isDegradedPass(sent)) await logLine($, 'supervision', `row: did not finish within ${RELAY_BOUND_MS} ms`)
  } catch (err) {
    await logLine($, 'supervision', `row: ${messageOf(err)}`)
  }
  await refreshDeck($)
}

// The orchestrator an agent reports to, and the path that found it, said in the log under
// `what`. First the orchestrator the launch recorded (ORCHESTRATOR_REPORTS_TO), without its
// reference: the session of the host's registry that bears that name and runs live (runsLive,
// so a host that is exiting does not count), the one started last when several do, so a
// replacement wins over the session it replaced. Then, when that is unset or finds none, the
// chain that names the agent's tty (chainOwnerTty) and the live orchestrator row measured on
// that chain's tty, the latest if two; a chain whose owner tty holds no live orchestrator
// leaves the entry orphaned, one log line. A pid the process table cannot be read for is never
// judged dead. Null when neither path finds one.
export async function orchestratorOn($: Host<'env' | 'fs' | 'plugin' | 'process'>, tty: string | null, agent: string, what: string): Promise<CoordinatorTo | null> {
  const dir = `${await dataDir($)}/chains`
  const listed: readonly { name: string; kind: string; mtimeMs?: number }[] = tty ? await $.fs.list(dir).catch(() => []) : []
  const chains = []
  for (const entry of listed) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
    chains.push({ name: entry.name, mtimeMs: entry.mtimeMs ?? 0, text: String(await $.fs.read(`${dir}/${entry.name}`).catch(() => '')) })
  }
  let alive: ReturnType<typeof livePids> | undefined
  const live = async (pid: unknown): Promise<boolean> => {
    if (pid === null || pid === undefined || !/^\d+$/.test(String(pid))) return true
    if (alive === undefined) alive = livePids(await $.process.run(['ps', '-A', '-o', 'pid=,stat=,tty='], { timeoutMs: 5000 }).catch(() => null))
    return alive === null || runsLive(alive, String(pid))
  }
  const recorded = String((await $.env.get('ORCHESTRATOR_REPORTS_TO')) ?? '').trim()
  const bare = recorded.replace(REFERENCED, '').trim()
  if (bare) {
    const registry = `${await configDir($)}/sessions`
    let chosen: { sessionId: string; startedAt: number } | null = null
    for (const file of await $.fs.list(registry).catch(() => [])) {
      if (!file || file.kind !== 'file' || !file.name.endsWith('.json')) continue
      try {
        const record = registryRecord(String(await $.fs.read(`${registry}/${file.name}`)))
        if (record === null || record.name !== bare) continue
        const startedAt = Number(record.startedAt) || 0
        if ((!chosen || startedAt > chosen.startedAt) && await live(record.pid)) chosen = { sessionId: record.sessionId, startedAt }
      } catch { /* a record being written, or gone: not this one */ }
    }
    if (chosen) {
      await logLine($, 'supervision', `${what}: ${agent} on ${tty ?? 'an unknown tty'} goes to ${bare} (session ${chosen.sessionId}) by the launch record`)
      return { sessionId: chosen.sessionId }
    }
    await logLine($, 'supervision', `${what}: ${agent} was launched for ${recorded}, and no live session bears the name ${bare}`)
  }
  const rows = `${await storeOf($)}/sessions`
  const orchestrators = new Map<string, SessionRow>()
  for (const entry of await $.fs.list(rows).catch(() => [])) {
    // A row write in flight (writeAtomic) is no orchestrator of its own.
    if (entry.name.includes('.tmp-')) continue
    const row = parseSessionRow(String(await $.fs.read(`${rows}/${entry.name}`).catch(() => '')))
    if (row?.role !== 'orchestrator' || !row.name || !row.tty) continue
    const held = orchestrators.get(row.tty)
    if ((!held || row.updated_at > held.updated_at) && await live(row.pid)) orchestrators.set(row.tty, row)
  }
  const owner = tty ? chainOwnerTty(chains, tty, ownerTty => orchestrators.has(ownerTty)) : null
  const found = owner ? orchestrators.get(owner) ?? null : null
  if (found?.name) {
    await logLine($, 'supervision', `${what}: ${agent} on ${tty} goes to ${found.name} by the chain on ${owner}`)
    return found.name
  }
  const stale = tty ? chainOwnerTty(chains, tty) : null
  if (stale) await logLine($, 'supervision', `${what}: the chain on ${stale} names ${tty} and has no live owner: the entry is orphaned`)
  return null
}

type GateReading = { context_tokens: number; context_percent: number; context_window: number }

// Each session's gate reports, one at a time, each within its bound: a measure's report and the
// agent's own line taken later read and write the same mark, and two of them never both find it
// unsent. A report past its bound gives its place to the next one and writes nothing after it: a
// line it delivers late is sent again, one line twice rather than a crossing left unsaid.
const gateRuns = new Map<string, Promise<void>>()
// The agent's own gate line the host holds, by session, with the crossing it was put for: the host
// takes it at the end of the agent's turn, long past the measure's bound, and no measure puts a
// second one meanwhile. A fall back under the gate forgets it: taken after that, it marks nothing.
const gateTelling = new Map<string, symbol>()

const gateMark = async ($: Host<'fs'>, path: string): Promise<string> => String(await $.fs.read(path).catch(() => '')).trim()

function gateRun($: Host<'env' | 'plugin' | 'process'>, sessionId: string, name: string, bound: number, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const run = (gateRuns.get(sessionId) ?? Promise.resolve()).then(() => withDeadline(work, bound))
  gateRuns.set(sessionId, run.then(() => undefined, () => undefined))
  return run.then(async done => {
    if (isDegradedPass(done)) await logLine($, 'supervision', `gate: a report of ${name} did not finish within ${bound} ms: the next one goes on`)
  })
}

// An agent's measure against the gate its session runs under (the gauge's thresholds, read from
// this session's environment): past it, the agent's own line is put to the host, never awaited, and
// its orchestrator is sent the figures once, marked `sent` as soon as they are delivered; the
// agent's line is marked `told` when the host takes it, both done marked `reported`. What was not
// delivered is tried again at the next measure. Back under it, the mark is cleared for the next
// crossing. The report is over with what was queued behind it while it ran: the mark of a line
// the host took meanwhile. The mark, a fixed name of the data root, is put in place by a rename.
export async function reportGate($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'prompt' | 'session'>, sessionId: string, name: string, tty: string,
  reading: GateReading, bound = RELAY_BOUND_MS): Promise<void> {
  await gateRun($, sessionId, name, bound, signal => gateReport($, sessionId, name, tty, reading, bound, signal))
  await gateRuns.get(sessionId)
}

async function gateReport($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'prompt' | 'session'>, sessionId: string, name: string, tty: string,
  reading: GateReading, bound: number, signal: AbortSignal): Promise<void> {
  const path = `${await storeOf($)}/${gateKey(sessionId)}`
  const past = tripGate(reading.context_percent, reading.context_tokens, reading.context_window, await gateEnv($)).tripped
  const mark = await gateMark($, path)
  if (signal.aborted) return
  if (!past) {
    gateTelling.delete(sessionId)
    if (mark !== '') await writeAtomic($, path, '')
    return
  }
  const told = mark === 'told' || mark === 'reported'
  if (!told && !gateTelling.has(sessionId)) tellGate($, sessionId, name, path, reading, bound)
  if (mark === 'sent' || mark === 'reported' || !await sendGate($, tty, name, reading) || signal.aborted) return
  await writeAtomic($, path, `${told ? 'reported' : 'sent'}\n`)
}

// The agent's own gate line put to the host: once it is taken, its mark written in turn with the
// reports, while the crossing it was put for holds. A line dropped or refused is one log line, and
// the next measure puts it again.
function tellGate($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'prompt'>, sessionId: string, name: string, path: string, reading: GateReading, bound: number): void {
  const crossing = Symbol(sessionId)
  gateTelling.set(sessionId, crossing)
  void (async () => $.prompt.submit({ text: gateSelfText(reading.context_tokens, reading.context_percent) }))()
    .then(taken => taken && typeof taken === 'object' && 'drop' in taken && taken.drop ? `the host dropped ${name}'s own line: ${String(taken.drop)}` : null,
      (err: unknown) => `${name}'s own line was refused: ${messageOf(err)}`)
    .then(failed => gateRun($, sessionId, name, bound, async signal => {
      const holds = gateTelling.get(sessionId) === crossing
      if (holds) gateTelling.delete(sessionId)
      if (failed !== null) return logLine($, 'supervision', `gate: ${failed}`)
      if (!holds) return
      const mark = await gateMark($, path)
      if (!signal.aborted && (mark === '' || mark === 'sent')) await writeAtomic($, path, `${mark === 'sent' ? 'reported' : 'told'}\n`)
    }))
    .catch((err: unknown) => logLine($, 'supervision', `gate: ${messageOf(err)}`))
}

// The orchestrator's line of an agent's gate crossing; whether it was delivered.
async function sendGate($: Host<'env' | 'fs' | 'plugin' | 'process' | 'session'>, tty: string, name: string,
  reading: { context_tokens: number; context_percent: number }): Promise<boolean> {
  const to = await orchestratorOn($, tty, name, 'gate')
  if (!to) {
    await logLine($, 'supervision', `gate: no orchestrator found for ${name} on ${tty}`)
    return false
  }
  const sent = await $.session.send({ to, text: gateText(name, reading.context_tokens, reading.context_percent) })
  if (!sent?.isDelivered) await logLine($, 'supervision', `gate: not delivered to ${addressLabel(to)}: ${sent?.reason ?? 'no answer'}`)
  return sent?.isDelivered === true
}

// What each window of a home session shows, kept by the window it is written on (the server's
// socket and the pane): the home mark read once, the state last written, whether the context is
// past its gate, and whether a failure was already said.
type TabMemory = { home: boolean | null; window: string | null; shown: TabState | null; past: boolean; said: boolean; misses: number }
const tabs = new Map<string, TabMemory>()

// This session's window, when it runs in a home session. The mark is read once per window: a
// session carries it from the moment it is made. Outside tmux nothing is run; in a tmux session
// without the mark, the one read. A read that fails is said once and tried again at the next
// change; a second failure marks the window not-home for the session's life, so a hung or
// absent tmux costs two processes, not one per event. The hook goes on.
async function tabOf($: Host<'env' | 'plugin' | 'process'>): Promise<{ target: TabTarget; bin: string; memory: TabMemory } | null> {
  const target = targetOf(await $.env.get('TMUX'), await $.env.get('TMUX_PANE'))
  if (!target) return null
  const bin = (await $.env.get('ORCHESTRATOR_TMUX')) || 'tmux'
  const key = `${target.socket}|${target.pane}`
  let memory = tabs.get(key)
  if (!memory) {
    memory = { home: null, window: null, shown: null, past: false, said: false, misses: 0 }
    tabs.set(key, memory)
  }
  if (memory.home === null) {
    try {
      const read = await $.process.run(homeArgv(bin, target), { timeoutMs: TMUX_TIMEOUT_MS })
      if (!read || read.exitCode !== 0) throw new Error(`tmux exited ${read?.exitCode ?? 'without answer'} reading the home mark`)
      memory.window = windowOf(String(read.stdout ?? ''))
      memory.home = memory.window !== null
      memory.said = false
    } catch (err) {
      memory.misses += 1
      if (memory.misses >= 2) memory.home = false
      await tabFailure($, memory, messageOf(err))
      return null
    }
  }
  return memory.home ? { target, bin, memory } : null
}

async function tabFailure($: Host<'env' | 'plugin' | 'process'>, memory: TabMemory, message: string): Promise<void> {
  if (memory.said) return
  memory.said = true
  await logLine($, 'supervision', `tab-state: ${message}`)
}

// The state written on the window, only when it is not the one already shown.
async function showTabState($: Host<'env' | 'plugin' | 'process'>, state: TabState): Promise<void> {
  const tab = await tabOf($).catch(() => null)
  if (!tab || tab.memory.shown === state) return
  try {
    const set = await $.process.run(stateArgv(tab.bin, tab.target, state), { timeoutMs: TMUX_TIMEOUT_MS })
    if (!set || set.exitCode !== 0) throw new Error(`tmux exited ${set?.exitCode ?? 'without answer'} writing ${state}`)
    tab.memory.shown = state
    tab.memory.said = false
  } catch (err) {
    tab.memory.shown = null
    await tabFailure($, tab.memory, messageOf(err))
  }
}

// The windows of the agents whose pull request was read: merged or closed, their work is over and
// their orchestrator owes their close (`over`); an open one that carries Ready turns a delivery's
// window from « under review » to « done », and one that lost it back (stateAfterPr). Asked by the
// orchestrator's turn end, which reads each idle agent's pull request: no poller of its
// own. The agents are named by the ttys of their panes, found on the server this session runs in;
// each state stands until the window's own session writes its next. A session outside a home
// session shows nothing; a failure is said once (until a write of this session's own succeeds) and
// the gate goes on.
export async function showPrStates($: Host<'env' | 'plugin' | 'process'>, reads: readonly { tty: string; pr: { state: string; ready?: boolean | undefined } }[]): Promise<void> {
  if (reads.length === 0) return
  try {
    const tab = await tabOf($)
    if (!tab) return
    const listed = await $.process.run(panesArgv(tab.bin, tab.target.socket), { timeoutMs: TMUX_TIMEOUT_MS })
    if (!listed || listed.exitCode !== 0) throw new Error(`tmux exited ${listed?.exitCode ?? 'without answer'} listing the panes`)
    const panes = panesOf(String(listed.stdout ?? ''))
    for (const { tty, pr } of reads) {
      const window = panes.find(pane => pane.tty === tty)
      const next = window ? stateAfterPr(window.shown, pr) : null
      if (!window || !next) continue
      // One window that cannot be written (its pane closed since the list) leaves the others to be.
      try {
        const set = await $.process.run(stateArgv(tab.bin, { socket: tab.target.socket, pane: window.pane }, next), { timeoutMs: TMUX_TIMEOUT_MS })
        if (!set || set.exitCode !== 0) throw new Error(`tmux exited ${set?.exitCode ?? 'without answer'} writing ${next} on ${window.pane}`)
      } catch (err) {
        await tabFailure($, tab.memory, messageOf(err))
      }
    }
  } catch (err) {
    const tab = await tabOf($).catch(() => null)
    if (tab) await tabFailure($, tab.memory, messageOf(err))
    else await logLine($, 'supervision', `tab-state: ${messageOf(err)}`)
  }
}

// The address of this session's window when it runs in a home session, else null.
async function windowAddress($: Host<'env' | 'plugin' | 'process'>): Promise<string | null> {
  try {
    return (await tabOf($))?.memory.window ?? null
  } catch {
    return null
  }
}

// A turn ended: the questions the session has open, else the wait it left, else the gate, else rest.
async function showTurnEnd($: Host<'env' | 'fs' | 'plugin' | 'process' | 'session'>): Promise<void> {
  try {
    const tab = await tabOf($)
    if (!tab) return
    const sessionId = await $.session.id()
    const wait = await readWait($, sessionId)
    const asked = (await readAsked($)).some(entry => entry.sender.session === sessionId && entry.status === 'open')
    await showTabState($, stateAfterTurn(wait?.waiting, tab.memory.past, asked))
  } catch (err) {
    await logLine($, 'supervision', `tab-state: ${messageOf(err)}`)
  }
}

// Writes the state of another session's window: its address is its session row's, the server the caller's
// (a home session's processes share one). A session with no window, or no server here, is left as it is.
export async function setSessionWindow($: Host<'env' | 'fs' | 'plugin' | 'process'>, sessionId: string, state: TabState): Promise<void> {
  const tab = await tabOf($).catch(() => null)
  const address = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))?.tmux
  if (!tab || !address) return
  await $.process.run(stateArgv(tab.bin, { socket: tab.target.socket, pane: address }, state), { timeoutMs: TMUX_TIMEOUT_MS }).catch(() => undefined)
}

// A measure: the gate's side remembered for the turn's end, and shown at once on a window at rest.
async function showGate($: Host<'env' | 'fs' | 'plugin' | 'process'>, reading: { context_percent: number; context_tokens: number; context_window: number }): Promise<void> {
  try {
    const tab = await tabOf($)
    if (!tab) return
    tab.memory.past = tripGate(reading.context_percent, reading.context_tokens, reading.context_window, await gateEnv($)).tripped
    const next = stateAfterMeasure(tab.memory.shown, tab.memory.past)
    if (next) await showTabState($, next)
  } catch (err) {
    await logLine($, 'supervision', `tab-state: ${messageOf(err)}`)
  }
}

// $.fs.read carries no range and refuses past 4 MiB, so the walk's transcript
// window comes from dd (blockArgv), as bytes — this file's own reader, the
// per-file convention: the engine fences $ to the file that received it, so
// guards.ts's identical reader cannot be imported, and each domain spells its
// own over its own $. A caller in another file hands its $ in as an argument,
// as it does to every other function of this file it calls.
export async function readBlock($: Host<'process'>, path: string, index: number, timeoutMs: number): Promise<Uint8Array> {
  const { exitCode, stdout } = await $.process.run(blockArgv(path, index), { timeoutMs })
  if (exitCode !== 0) throw new Error(`dd exited ${exitCode} on ${path}`)
  return bytesOfBase64(String(stdout ?? ''))
}

// The transcript, found the gauge's own way (the guards' reader, spelled over
// this file's $): by session id under the projects directory. A miss returns
// '': the rename fallback then names nothing, and the launch name stands alone.
export async function transcriptPathOf($: Host<'env' | 'fs'>, sessionId: string): Promise<string> {
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
// the origin remote — the per-file convention again: no other
// file's reader holding $ can be imported. The read runs in the
// working directory the host runs the module in, the session's project; null
// when there is no origin: a session outside any checkout reports no
// repository, never a failure. Bounded (REPO_READ_MS): it runs in the pane's
// render, and a git that hangs held the render for the host's default 30 s.
// Undefined when git gave no answer — it could not run, or was ended at its bound
// before it said anything — a value the render does not keep. No origin, or no checkout, is git's
// own answer: its `error:` or `fatal:` line.
async function repoRead($: Host<'process'>): Promise<string | null | undefined> {
  try {
    const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: REPO_READ_MS })
    if (remote.exitCode !== 0) return /^(?:error|fatal):/m.test(String(remote.stderr ?? '')) ? null : undefined
    return /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(String(remote.stdout ?? '').trim())?.[1] ?? null
  } catch {
    return undefined
  }
}

// A peer's delivery as the module reads it (the session.receive handler of `register`): the result
// of a line the module consumes, or `{ passed }` with the event a model is to read.
async function readDelivery($: Held, e: Events['session.receive'], declarations: Declarations): Promise<unknown> {
  let passed = e
  try {
    if (!e.agentId && isPeerOrigin(e.origin) && typeof e.text === 'string') {
      const delivery = deliveryOf(e.text)
      const learnt = learntOf(delivery, Date.now())
      // A write that fails here is one log line: the marked lines below are still consumed.
      if (learnt) await learnCoordinator($, learnt, true).catch((err: unknown) => logLine($, 'supervision', `receive: ${messageOf(err)}`))
      if (isQAck(delivery.body)) return await receiveQAck($, parseQAck(delivery.body), peerAddress(delivery))
      const q = isQ(delivery.body) ? parseQ(delivery.body) : null
      // A question asked with `ask` crossing machines (remote-asked.ts): its owner's push, taken
      // by the coordinator alone, and the reply given on its replica, which its asker's model reads.
      if (q?.event.kind === 'asked' || q?.event.kind === 'reply') {
        const from = peerAddress(delivery)
        if (!from) {
          await logLine($, 'supervision', `receive: a remote ${q.event.kind} of ${q.id} came with no sender address, refused`)
          return { consumed: `orchestrator: a remote ${q.event.kind} with no sender address, refused` }
        }
        if (q.event.kind === 'asked') {
          if (await ownRole($) === 'coordinator') return await receiveAsked($, from, q.event.object)
          await logLine($, 'supervision', `receive: a remote question asked with ask reached a session that is no coordinator: ${q.id}`)
          return { consumed: 'orchestrator: a remote question asked with ask for no coordinator, dropped' }
        }
        const received = await receiveReply($, from, q.id, q.seq, q.event.reply)
        if ('consumed' in received) return received
        const at = e.text.indexOf(delivery.body)
        passed = { ...e, text: at < 0 ? received.readable : e.text.slice(0, at) + received.readable + e.text.slice(at + delivery.body.length) }
      } else if (q?.event.kind === 'answer') {
        const received = await receiveAnswer($, delivery, { id: q.id, ...q.event })
        if ('consumed' in received) return received
        // The marked first line out, the readable answer in its place, the envelope kept.
        const at = e.text.indexOf(delivery.body)
        passed = { ...e, text: at < 0 ? received.readable : e.text.slice(0, at) + received.readable + e.text.slice(at + delivery.body.length) }
      } else if (isQ(delivery.body)) {
        return await receiveAsk($, delivery, q && q.event.kind === 'ask' ? { entry: q.event.entry, machine: q.event.machine } : null)
      }
      const withdrawal = parseWithdrawal(delivery.body)
      if (withdrawal) {
        const received = await receiveWithdrawal($, withdrawal, peerAddress(delivery))
        if (received) return received
      }
      if (isMarked(delivery.body)) {
        const received = await receiveRow($, delivery.body)
        // A remote orchestrator's row is one of the deck's keys.
        await refreshDeck($)
        return received
      }
      if (learnt) await learnCoordinator($, learnt)
      const successor = successorOf(delivery, Date.now())
      const taken = successor ? await learnSuccessor($, successor) : null
      if (taken) {
        const sessionId = await $.session.id()
        await tellAgentsSuccessor($, sessionId, taken)
        // A session that spawned this successor hands it the work and the questions now.
        if (declarations.handedOver(sessionId)) await handOver($, sessionId, taken)
      }
    }
  } catch (err) {
    await logLine($, 'supervision', `receive: ${messageOf(err)}`)
  }
  return { passed }
}

function isPassed(read: unknown): read is { passed: Events['session.receive'] } {
  return typeof read === 'object' && read !== null && 'passed' in read
}
