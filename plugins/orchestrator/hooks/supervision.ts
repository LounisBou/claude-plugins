// hooks/supervision.ts
// The shared store: one row per live session — the figures the gauge measured,
// the name the walk read, the repository of the working directory — written by
// this file's own session.measure handler and removed by its session.end, one
// file per key under the module's state root. The supervision pane below reads
// the same rows, opened on the person's word alone (/orchestrator-supervision or the
// supervision tool's `open`) — never by the module itself, on a start, a turn, a wake or a
// succession: what he closed stays closed, there being nothing that opens it again. In a
// coordinator session it lists the orchestrators, and under them
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
import { withDeadline, isDegradedPass, chainEntries, chainOwner, watchNumberOf } from './stop-gate.ts'
import { moduleDirOf } from './module-log.ts'
import { answersChoice, consentPath, consentRecordOf, CONSENT_GRANT, grants, parseConsentSubject, type Answerer, type ConsentSubject } from '../core/consent-record.ts'
import { isTemporary, STORE_CONTRACT, staleTemporaries, removeArgv, withLockOver, writeAtomicOver } from '../core/store-io.ts'
import { commandsDirOf, isBare, isOwnCopy } from './short-names.ts'
import {
  parseWait, parseStatus, handsOver, waitPatch, clearedWait, fingerprint, relayText, gateText, noStatusText, noStatusKey, heldReport, coordinatorOf, chainOwnerTty, waitLabel, waitParts, localMinute, openQuestions, parseWithdrawal,
  type WaitKind,
} from './relay.ts'
import { receiveAsked, receiveAskedAck, receiveReply, receiveReplyAck, resendReplies } from './remote-asked.ts'
import { planOlder, planWithdrawal } from './settle.ts'
import { answerAskedFromPane, askedAsEntry, closeRound, moveAsked, nameMovedAsked, withdrawAsked, withdrawAskedIds, askedGroups, askedLines, askedLook, readAsked, type Asked } from './question.ts'
import { entryFingerprint, roundEntry, roundEntryId, roundPath, plainText, textSpans, prPieces, repositoryOwners, isDue, dueText, toldText, type RoundAnswer, type RoundEntry } from './round.ts'
import {
  remoteRowOf, rowIsNews, rowSent, parseRowSent, rowText, deliveryOf, isPeerOrigin, isMarked, parseRemoteRow,
  remoteKey, withRemote, isRemoteStale, learntOf, parseLearnt, successorOf, parseSuccessor, machineLabel, prsInFlight, cleanBlocks, ROW_MARKER, REMOTE_STALE_AFTER_MS,
  type RemoteRow, type LearntSuccessor, type Delivery,
} from './remote-row.ts'
import {
  askLine, ackLine, parseAsk, parseAck, isAsk, isAck,
  answerLine, parseAnswer, answerAckLine, parseAnswerAck, isAnswer, isAnswerAck,
  qAskLine, qAnswerLine, qAckLine, parseQ, parseQAck, isQ, isQAck, seqOf, type QAck,
} from './remote-round.ts'
import { targetOf, homeArgv, stateArgv, windowOf, stateAfterTurn, stateAfterMeasure, TMUX_TIMEOUT_MS, type TabState, type TabTarget } from './tab-state.ts'
import { deckOf, deckText, deckIsNews, DECK_FILE, DECK_VERSION, type Deck, type DeckUsage } from './deck.ts'
import { newBook, settle, ingest, rewind, forget, usageOf, appendedArgv, consumedOf, type Prices, type UsageBook } from './usage.ts'
import { configDir, gateEnv, logLine, stateDir, storeIo, writeAtomic } from './module-io.ts'
import { unattendedLine, type Unattended } from '../core/pr-ledger.ts'

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

export type UnattendedView = { at: string; line: string | null; prs: readonly Unattended[]; unread: readonly string[] }

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
  if (typeof result !== 'object' || result === null) return null
  const { exitCode, stdout } = result as { exitCode?: unknown; stdout?: unknown }
  if (exitCode !== 0) return null
  const table = new Map<string, ProcessState>()
  for (const line of String(stdout ?? '').split('\n')) {
    const [pid, stat, tty] = line.trim().split(/\s+/)
    if (/^\d+$/.test(pid ?? '')) table.set(pid, { stat: stat ?? null, tty: tty ?? null })
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

// How many rows tall the « Other answer » field is drawn, label included. The host's field
// holds lines (a newline starts one) and cuts a line wider than its room with an ellipsis, never
// wrapping it: the text typed is drawn again under the field, whole and wrapped.
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

// The store's root under the module's own directory (module-log.ts, moduleDirOf): one file per key.
export async function storeOf($: any): Promise<string> {
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
// `pending` is the id of the entry sent to a coordinator on another machine and not acknowledged
// yet, with the fingerprint its acknowledgment keeps (`pending_key`): an outbox, never drawn or
// answered from here (remote-round.ts). `relayed_id` is the id of the entry that acknowledgment
// kept, so the answer to it forgets `relayed` as forgetRelayed does on the coordinator's machine.
export type WaitRecord = Pick<SessionRow, 'waiting' | 'blocks' | 'waiting_since' | 'relayed'> & { name: string | null; pid: string | null; last_waiting?: WaitKind | null; pending?: string | null; pending_key?: string | null; relayed_id?: string | null }

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
  const fields = (r: WaitRecord) => r as unknown as Record<string, unknown>
  for (const key of new Set([...Object.keys(record), ...Object.keys(now), ...Object.keys(seen)])) {
    const [was, is, mine] = [fields(seen)[key], fields(now)[key], fields(record)[key]]
    if (same(mine, was) && !same(is, was)) {
      if (is === undefined) delete merged[key]
      else merged[key] = is
    }
  }
  return merged as WaitRecord
}

// Written under the file's lock, merged (mergeWait), through a temporary file and one rename —
// $.fs.write is not atomic, and a wait caught mid-write would read as none.
async function writeWait($: any, id: string, record: WaitRecord): Promise<void> {
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
async function changeEntry($: any, path: string, change: (entry: RoundEntry | null) => RoundEntry | null | Promise<RoundEntry | null>): Promise<RoundEntry | null> {
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
export async function writeSession($: any, id: string, patch: Partial<SessionRow>): Promise<void> {
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
async function publishUsage($: any, id: string, usage: DeckUsage | null): Promise<void> {
  await onOwnRow(async () => {
    const path = `${await storeOf($)}/${sessionKey(id)}`
    const row = parseSessionRow(String(await $.fs.read(path).catch(() => '')))
    if (row && (usage || row.usage)) await writeAtomic($, path, JSON.stringify({ ...row, usage }) + '\n')
  })
}

// The turn end's reading of the pull requests nobody attends, into the session's own row: the
// row's stamp is the measure's and stays; a row gone meanwhile (the session ended) is not written again.
export async function publishUnattended($: any, id: string, view: UnattendedView): Promise<void> {
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
export async function readSessions($: any): Promise<Record<string, SessionRow>> {
  return (await readStore($)).rows
}

// The same read, with what the pane traces beside the rows: each file it left out, by its key,
// with the reason (`dropped`), and the process table it judged them by (`alive`, null when that
// read failed, and no table at all when no row named a pid and none was read).
export type StoreRead = { rows: Record<string, SessionRow>; dropped: Map<string, string>; alive: ProcessTable | null | Set<string> }

// Why a row the read met is no live row: empty, caught mid-write, or stale by the rule above.
function droppedReason(text: string, row: SessionRow | null, alive: StoreRead['alive']): string {
  if (text === '') return 'empty'
  if (!row) return 'unreadable'
  if (!row.pid) return 'stale, no pid and no measure for an hour'
  const listed = alive instanceof Map && alive.has(String(row.pid))
  const where = row.tty ? ` on ${row.tty}` : ''
  return listed ? `stale pid ${row.pid}: exiting, or no longer${where}` : `stale pid ${row.pid}: not running${where}`
}

async function readStore($: any): Promise<StoreRead> {
  const dir = `${await storeOf($)}/sessions`
  let entries: { name: string; kind: string; mtimeMs?: number }[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return { rows: {}, dropped: new Map(), alive: new Set() }   // no store yet: nothing was ever written
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
  const alive = argv ? livePids(await $.process.run(argv, { timeoutMs: 5000 }).catch(() => null)) : new Set<string>()
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
      dead.push(`${dir}/${name}`, `${await storeOf($)}/waits/${name}`, `${await storeOf($)}/gates/${name}`, `${await storeOf($)}/rows/${name}`)
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
async function sweepGoneSenders($: any, removed: ReadonlyMap<string, LearntSuccessor | null>): Promise<void> {
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
    await logLine($, 'supervision', `round: ${(err as Error).message}`)
  }
}

// The session's own row goes with it: removed, or — rm failing — truncated to
// empty, which the row parser reads as no row and the next read removes.
export async function deleteSession($: any, id: string): Promise<void> {
  const path = `${await storeOf($)}/${sessionKey(id)}`
  const store = await storeOf($)
  const done = await $.process.run(['rm', '-f', path, `${store}/${waitKey(id)}`, `${store}/${gateKey(id)}`, `${store}/${rowKey(id)}`, `${store}/${successorKey(id)}`, `${store}/${answeredKey(id)}`], { timeoutMs: 5000 }).catch(() => null)
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
  // The pull requests nobody attends its last turn end read, in local time; null when none.
  unattended: string | null
}

// A row's unattended pull requests as the pane says them: the same line its context reads, in local time.
export function unattendedOfRow(row: SessionRow): string | null {
  const view = row.unattended
  return view ? unattendedLine(view.prs, view.unread, localMinute) : null
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
// tab wrote (the owner is the terminal session's id, the stop gate's rule — no
// owner, no entry counted: a recycled tty's occupant would be), each read
// through the process on the agent's tty to the host's record of it, and that
// session's store row. An entry no live session answers for is an agent gone.
async function agentViews($: any, tty: string): Promise<AgentView[]> {
  const config = await configDir($)
  const state = await stateDir($)
  const owner = await chainOwner($)
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
// « other answer » was pressed (their ids: the hint is drawn under them), the questions whose
// answer is in flight, so a second press on one does nothing,
// the entry whose « Other answer » was picked, its text field drawn until the ring leaves it, and
// the text typed in each field, which the pane draws again whole under it.
export type PaneMemory = {
  opened: { role: 'coordinator' | 'orchestrator'; tty: string | null } | null
  ticker: { cancel(): void } | null
  other: Set<string>
  writing: string | null
  answering: Set<string>
  typed?: Map<string, string>
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
  if (role === 'coordinator') await recordPaneOpen($, pid, tty).catch((err: unknown) => logLine($, 'supervision', `pane: ${(err as Error).message}`))
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
  await recordPaneClosed($).catch((err: unknown) => logLine($, 'supervision', `pane: ${(err as Error).message}`))
}

// The coordinator's pane as `coordinator.sh round` reads it, `<state>/pane.json`: the session
// whose pane is open, its host pid and the tty of its tab, the script holding the pane open while
// that pid still runs a session on that tty. Without it every question is due in the tab at once,
// there being no pane to answer it in.
export type PaneRecord = { session: string; pid: string; tty?: string | null; at: string }

async function panePath($: any): Promise<string> {
  return `${await stateDir($)}/pane.json`
}

// A pane whose pid is unknown is not recorded: a record naming none is no pane to the script.
async function recordPaneOpen($: any, pid: string | null, tty: string | null): Promise<void> {
  if (!pid) {
    await logLine($, 'supervision', 'pane: no host pid read for this session; the pane is not recorded open')
    return
  }
  const record: PaneRecord = { session: await $.session.id(), pid, ...(tty ? { tty } : {}), at: new Date().toISOString() }
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
  if (!done || done.exitCode !== 0) await logLine($, 'supervision', `pane: the record ${await panePath($)} could not be removed`)
}

// The coordinator's pane as `coordinator.sh round` judges it (its pane_open): a record naming a
// pid that still runs a session, whichever session wrote it. A record absent, unreadable or naming
// no pid is no pane, and so is one whose pid the machine's listing does not hold, or holds as
// exiting or a zombie, or on another tty than the record's (a host whose tab was closed stays
// listed for days under the terminal's session-keeping daemon: runsLive's rule), or a listing that
// failed, as the script's own ps failing is.
async function paneIsOpen($: any): Promise<boolean> {
  let pid: string
  let tty: string | null = null
  try {
    const record = JSON.parse(String(await $.fs.read(await panePath($)))) as { pid?: unknown; tty?: unknown } | null
    pid = String(record?.pid ?? '')
    if (typeof record?.tty === 'string') tty = record.tty
  } catch {
    return false
  }
  const argv = livePidsArgv([pid])
  if (!argv) return false
  const alive = livePids(await $.process.run(argv, { timeoutMs: 5000 }).catch(() => null))
  return alive !== null && runsLive(alive, pid, tty)
}

// A record that says open while this host shows no such pane is removed: the pane went with no
// close of the module's (the host's own, a tab or a session gone, a clear that gave the session
// another id), and a record left behind held every question back from the tab for as long as the
// host process lived. Only the record this session or this host wrote is judged, another live
// coordinator's is its own; a host that cannot say which panes it shows leaves the record, said in
// the log. Read at each wake, each turn and each start, so that `coordinator.sh round` never reads
// a pane that is not there.
async function reconcilePaneRecord($: any): Promise<void> {
  let record: { session?: unknown; pid?: unknown } | null
  let text: string
  try {
    text = String(await $.fs.read(await panePath($)))
    record = JSON.parse(text)
  } catch {
    return
  }
  if (!record || typeof record !== 'object') return
  try {
    if (await paneShown($)) return
    const pid = String(record.pid ?? '')
    const own = record.session === await $.session.id() || (pid !== '' && String((await recordedCoordinator($))?.pid ?? '') === pid)
    if (!own) return
    // An open that finished while this ran wrote a new record: it is the pane's, not removed.
    if (String(await $.fs.read(await panePath($)).catch(() => '')) !== text) return
    const done = await $.process.run(['rm', '-f', await panePath($)], { timeoutMs: 5000 }).catch(() => null)
    if (!done || done.exitCode !== 0) await logLine($, 'supervision', `pane: the record ${await panePath($)} could not be removed`)
    else await logLine($, 'supervision', 'pane: the record said open while the host shows no pane; removed')
  } catch (err) {
    await logLine($, 'supervision', `pane: the record could not be checked: ${(err as Error).message}`)
  }
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

// Ids added to a list file under its lock, the list read again first: two coordinators at a
// succession write the same lists, and a list written from an older read lost the other's ids.
// Only the ids `keep` holds stay (the round's present entries), so the list never outgrows it.
async function addIds($: any, path: string, ids: readonly string[], keep: (id: string) => boolean): Promise<void> {
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

// An entry the coordinator was shown: one its `coordinator.sh round` printed open
// (`<state>/round-listed.json`, the script's own record) or one the module woke it for. Read by
// the files, never by its model's memory: a question it presented and then saw settled
// elsewhere was asked a second time (the operator's report of 2026-10-25).
async function shownToCoordinator($: any, id: string): Promise<boolean> {
  return (await readWoken($)).includes(id) || (await readIds($, `${await stateDir($)}/round-listed.json`)).includes(id)
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
export async function closesItself($: any, id: string): Promise<boolean> {
  return !!(await coordinatorAddress($))?.local && await shownToCoordinator($, id)
}

// The settled entries told to the coordinator on this machine, one message each, while time is
// left before `until`: a notice that does not fit, is refused or throws is one log line.
export async function tellSettled($: any, settled: readonly Settled[], until = Infinity): Promise<void> {
  if (settled.length === 0) return
  let to: CoordinatorTo
  try {
    const coordinator = await coordinatorAddress($)
    if (!coordinator?.local) return
    to = coordinator.to
  } catch (err) {
    await logLine($, 'supervision', `round: ${(err as Error).message}`)
    return
  }
  for (const { entry, answer } of settled) {
    try {
      // No bound given, the caller's own deadline holds the sends.
      const left = until - Date.now()
      const send = () => sendToCoordinator($, to, settledText(entry, answer))
      const sent = left === Infinity ? await send() : left > 0 ? await withDeadline(send(), left) : null
      if (!sent || isDegradedPass(sent)) await logLine($, 'supervision', `round: no time left to tell ${addressLabel(to)} that ${entry.id} is settled`)
      else if (!sent.isDelivered) await logLine($, 'supervision', `round: the settled notice of ${entry.id} was not delivered to ${addressLabel(to)}: ${sent.reason ?? 'no answer'}`)
    } catch (err) {
      await logLine($, 'supervision', `round: ${(err as Error).message}`)
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

// One reading: the questions just due, then the answers to send again to another machine. A
// failure of either is one log line, and the next reading still comes. A timer no longer the one
// armed reads nothing.
async function wakeTick($: any, wake: WakeMemory, timer: unknown, generation: number): Promise<void> {
  if (wake.timer !== timer) return
  wake.timer = null
  try {
    await wakeForDue($)
  } catch (err) {
    await logLine($, 'supervision', `round wake: ${(err as Error).message}`)
  }
  try {
    await resendReplies($)
  } catch (err) {
    await logLine($, 'supervision', `round resend: ${(err as Error).message}`)
  }
  if (wake.generation === generation) armWake($, wake)
}

// The host's clock, read through $ so a render's duration is the host's measure; a $ that carries
// no clock reading (an older host) reads the process's own.
async function clockNow($: any): Promise<number> {
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
async function hostedSuccessors($: any, entries: readonly RoundEntry[], rows: Record<string, SessionRow>, alive: StoreRead['alive'], asked: ReadonlySet<string> = new Set()): Promise<Set<string>> {
  const wanted = entries.filter(entry => entry.status === 'open' && entry.movedFrom && !entry.origin && !(entry.session !== '' && sessionKey(entry.session) in rows))
  const hosted = new Set<string>()
  if (wanted.length === 0) return hosted
  // A question asked with `ask` moved by name alone takes the session of the record that hosts it.
  const named = new Map<string, string>()
  const sessionOf = new Map<string, string>()
  const takes = (entry: RoundEntry, record: { sessionId: string; name?: unknown }) => entry.session !== ''
    ? record.sessionId === entry.session
    : record.name === entry.from && record.sessionId !== entry.movedFrom
  const dir = `${await configDir($)}/sessions`
  const pids = new Map<string, string[]>()
  const listed: { name: string; kind: string }[] | null = await $.fs.list(dir).catch(() => null)
  for (const file of listed ?? []) {
    if (!file || file.kind !== 'file' || !file.name.endsWith('.json')) continue
    try {
      const record = JSON.parse(String(await $.fs.read(`${dir}/${file.name}`)))
      if (typeof record?.sessionId !== 'string' || record.sessionId === '' || !/^\d+$/.test(String(record.pid ?? ''))) continue
      const ids = wanted.filter(entry => takes(entry, record)).map(entry => entry.id)
      for (const id of ids) if (asked.has(id)) sessionOf.set(id, record.sessionId)
      if (ids.length > 0) pids.set(String(record.pid), [...(pids.get(String(record.pid)) ?? []), ...ids])
    } catch { /* a record being written, or gone: not this one */ }
  }
  const table = alive instanceof Map ? alive
    : alive === null ? null
    : pids.size === 0 ? new Map()
    : livePids(await $.process.run(livePidsArgv([...pids.keys()])!, { timeoutMs: 5000 }).catch(() => null))
  for (const [pid, ids] of pids) if (table === null || runsLive(table, pid)) for (const id of ids) hosted.add(id)
  for (const entry of wanted) if (entry.session === '' && hosted.has(entry.id) && sessionOf.has(entry.id)) named.set(entry.id, sessionOf.get(entry.id) as string)
  try {
    await nameMovedAsked($, named)
  } catch (err) {
    await logLine($, 'supervision', `round: ${(err as Error).message}`)
  }
  if (listed !== null) await closeUnhosted($, wanted.filter(entry => entry.session === '' && !hosted.has(entry.id)), asked)
  return hosted
}

// The entries moved to a successor by its name alone that no session of that name runs: no
// session's end, no store read and no withdrawal matches an entry naming no session, so they are
// withdrawn here, by the sender, as a gone sender's are. Judged only on a registry listed: a
// listing that failed closes nothing, and a process table that could not be read takes every
// record of that name as live.
async function closeUnhosted($: any, orphans: readonly RoundEntry[], asked: ReadonlySet<string> = new Set()): Promise<void> {
  if (orphans.length === 0) return
  try {
    const ids = new Set(orphans.map(entry => entry.id))
    const why = "the sender's session ended"
    const settled = await withdrawStale($, '', null, why, entry => !ids.has(entry.id))
    const gone = await withdrawAskedIds($, orphans.filter(entry => asked.has(entry.id)).map(entry => entry.id), why)
    await tellSettled($, [...settled, ...await shownAsked($, gone, why)], Date.now() + RELAY_BOUND_MS)
  } catch (err) {
    await logLine($, 'supervision', `round: ${(err as Error).message}`)
  }
}

// The questions asked with `ask` withdrawn by their asker that the coordinator here was shown,
// as the settled notices tell them: each closed by its asker, why.
async function shownAsked($: any, withdrawn: readonly Asked[], why: string): Promise<Settled[]> {
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
async function wakeForDue($: any): Promise<void> {
  await reconcilePaneRecord($)
  const store = await readStore($)
  const local = store.rows
  const round = await readRound($)
  await withdrawOlder($, round)
  // An operator entry of an older release is withdrawn above, never told nor due.
  const relayed = round.map(found => found.entry).filter(entry => entry.kind === 'done')
  // The questions asked with `ask`, told and due as the relay's entries are, read through them only;
  // one claimed by his prompt in its asker's tab has left the pane, and is neither told nor due
  // until that turn's end, while its id stays one the round holds.
  const asked = await readAsked($)
  const read = [...relayed, ...asked.filter(entry => !entry.claimed).map(askedAsEntry)]
  const paneOpen = await paneIsOpen($)
  const present = new Set([...read.map(entry => entry.id), ...asked.map(entry => entry.id)])
  const now = Date.now()
  await tellNew($, read, present)
  const hosted = await hostedSuccessors($, read, local, store.alive, new Set(asked.map(entry => entry.id)))
  const dueBeside = (woken: readonly string[]) => (entry: RoundEntry) =>
    (sessionKey(entry.session) in local || hosted.has(entry.id)) && !woken.includes(entry.id) && isDue(entry, now, paneOpen)
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
async function withdrawOlder($: any, round: readonly { path: string; entry: RoundEntry }[]): Promise<void> {
  for (const { path, entry } of round) {
    if (entry.kind !== 'operator' || entry.status !== 'open') continue
    try {
      const at = new Date().toISOString()
      const text = olderQuestionText(entry.id, 'withdrawn')
      const me = { session: await $.session.id(), name: '', role: 'coordinator' }
      const closed = await closeRound($, path, current => {
        const fresh = current === undefined ? null : parseRoundEntry(current)
        return fresh === null ? null : planOlder(fresh as never, text, at)
      }, me, at)
      if (closed === null || 'error' in closed) continue
      await logLine($, 'supervision', `round: an operator question of an older release withdrawn: ${entry.id}`)
      const origin = entry.origin
      const sent = origin
        ? await $.session.send({ to: origin.address, text: (origin.line === 'q' ? qAnswerLine : answerLine)(entry.id, entry.since, 'withdrawn', at, text) })
        : await $.session.send({ to: { sessionId: entry.session }, text: `[module] ${text}` })
      if (!sent?.isDelivered) await logLine($, 'supervision', `round: the withdrawal of ${entry.id} was not delivered: ${sent?.reason ?? 'no answer'}`)
    } catch (err) {
      await logLine($, 'supervision', `round: ${entry.id}: ${(err as Error).message}`)
    }
  }
}

// The entries the coordinator's conversation was told of, `<state>/round-told.json`, a JSON list
// of ids beside round-woken.json, whose ids keep their own meaning (a wake submitted).
async function toldPath($: any): Promise<string> {
  return `${await stateDir($)}/round-told.json`
}

// Each new open operator question told to the coordinator's conversation in one line, the
// operator's ruling of 2026-11-04 (« B »): pane open or not, read from the round alone, never from
// what the pane drew — no live-row filter, no due rule. The line is a transcript notice
// ($.ui.log), drawn in the conversation and starting no model turn, so nothing is shown between
// two questions of a decision round (his ruling of 2026-10-31, 6.3). An id is recorded once its
// line is drawn, and the list keeps the ids the round still holds. A failure is one log line and
// never holds the due wake.
async function tellNew($: any, read: readonly RoundEntry[], present: ReadonlySet<string>): Promise<void> {
  try {
    const path = await toldPath($)
    const told = (await readIds($, path)).filter(id => present.has(id))
    const fresh = read.filter(entry => entry.status === 'open' && entry.kind === 'operator' && !told.includes(entry.id))
    if (fresh.length === 0) return
    // Each id written as soon as its line is drawn: a later line the host refuses never draws
    // the earlier ones twice.
    for (const entry of fresh) {
      $.ui.log(toldText(entry))
      told.push(entry.id)
      await addIds($, path, [entry.id], id => present.has(id))
    }
  } catch (err) {
    await logLine($, 'supervision', `round told: ${(err as Error).message}`)
  }
}

// The pane is never opened here: it opens on his word alone (the command, the tool). What the end
// of a turn does for a coordinator is check the pane's record against the host (reconcilePaneRecord)
// and report whether the session is the recorded coordinator's, which arms its round's wake.
async function atTurnEnd($: any): Promise<boolean> {
  const self = await recordedCoordinator($)
  if (!self) return false
  await reconcilePaneRecord($)
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

// The temporary files a writer killed between its write and its rename left (writeAtomic): every
// directory the module writes in is listed at a session's start, which spawns nothing, and those
// older than core's STALE_MS are removed in one process, none when there are none. The readers of
// the store and of the round sweep their own directory at each read the same way.
export const WRITTEN_DIRS = ['sessions', 'waits', 'gates', 'rows', 'answered', 'successors', 'remote']
export async function sweepTemporaries($: any): Promise<string[]> {
  const store = await storeOf($)
  const state = await stateDir($)
  const now = Date.now()
  const stale: string[] = []
  for (const dir of [...WRITTEN_DIRS.map(name => `${store}/${name}`), store, state, `${state}/round`]) {
    stale.push(...staleTemporaries(dir, await $.fs.list(dir).catch(() => []), now))
  }
  if (stale.length > 0) await $.process.run(removeArgv(...stale), { timeoutMs: 5000 })
  return stale
}

// The round's reading armed when the module loads — the host's session.start fires at a reload
// too — so a reload with no turn after it still wakes the coordinator. Mounted beside the
// supervision rather than in it, whose register holds no start handler: nothing is opened at a
// start. Bounded, as the first start is awaited.
export function registerWake(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  on('session.start', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      const swept = await withDeadline(sweepTemporaries($), RELAY_BOUND_MS)
      if (isDegradedPass(swept)) await logLine($, 'supervision', `sweep: did not finish within ${RELAY_BOUND_MS} ms`)
    } catch (err) {
      await logLine($, 'supervision', `sweep: ${(err as Error).message}`)
    }
    try {
      const self = await withDeadline(recordedCoordinator($), RELAY_BOUND_MS)
      if (isDegradedPass(self)) await logLine($, 'supervision', `round wake: did not finish within ${RELAY_BOUND_MS} ms`)
      else if (self) {
        await reconcilePaneRecord($)
        armWake($, wake)
      }
    } catch (err) {
      await logLine($, 'supervision', `round wake: ${(err as Error).message}`)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
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
      await logLine($, 'supervision', `supervision tool not registered: ${(err as Error).message}`)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  // Module memory: the role the pane was opened in, the tty its agents are read
  // from — the render lists what the open asked for — and the open pane's clock.
  // A reload forgets it, and the pane then asks to be opened again.
  const pane: PaneMemory = { opened: null, ticker: null, other: new Set(), writing: null, answering: new Set(), typed: new Map() }
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
        // An orchestrator's row to a coordinator on another machine, when it is news.
        if (walked.known && roleOf(walked.name) === 'orchestrator') {
          const sent = await withDeadline(sendRow($, sessionId), RELAY_BOUND_MS)
          if (isDegradedPass(sent)) await logLine($, 'supervision', `row: did not finish within ${RELAY_BOUND_MS} ms`)
        }
        // The window's tab shows the gate crossed, or left.
        await showGate($, reading)
        // An agent's measure past its gate: its orchestrator told once per crossing.
        if (walked.known && walked.tty && roleOf(walked.name) === 'agent') {
          const done = await withDeadline(reportGate($, sessionId, walked.name!, walked.tty, reading), RELAY_BOUND_MS)
          if (isDegradedPass(done)) await logLine($, 'supervision', `gate: did not finish within ${RELAY_BOUND_MS} ms`)
        }
      }
    } catch (err) {
      // A row that cannot be written, or a gate report that failed, never blocks the
      // measure: the next one writes it.
      await logLine($, 'supervision', (err as Error).message)
    }
    // The deck follows the row just written (writeDeck): a new fill is what its keys draw.
    await refreshDeck($)
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    // The registered net the plan's every-handler rule asks validate to see:
    // the measure is let through, the state dir says why, and next is
    // replay-safe in a catch, called or not.
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('session.end', {}, async ($: any, e: any, next: (e: any) => any) => {
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
      await logLine($, 'supervision', (err as Error).message)
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
      await logLine($, 'supervision', `round: ${(err as Error).message}`)
    }
    // The ended session leaves the deck, in what the round left of the bound.
    const left = until - Date.now()
    if (left > 0) await refreshDeck($, left)
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
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
  on('turn.complete', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      if (!e.agentId && e.reason === 'answer') {
        const done = await withDeadline(relayTurnEnd($, String(e.answer ?? ''), e.turnId), RELAY_BOUND_MS)
        if (isDegradedPass(done)) await logLine($, 'supervision', `relay: did not finish within ${RELAY_BOUND_MS} ms`)
        // The wait just written is what the pane shows: the row follows it, when it is news.
        const sent = await withDeadline(sendRow($, await $.session.id()), RELAY_BOUND_MS)
        if (isDegradedPass(sent)) await logLine($, 'supervision', `row: did not finish within ${RELAY_BOUND_MS} ms`)
      }
    } catch (err) {
      await logLine($, 'supervision', `relay: ${(err as Error).message}`)
    }
    // The wait the relay just wrote, or none, is what the window's tab shows.
    if (!e.agentId) await showTurnEnd($)
    try {
      if (!e.agentId) {
        const done = await withDeadline(atTurnEnd($), RELAY_BOUND_MS)
        if (isDegradedPass(done)) await logLine($, 'supervision', `pane: did not finish within ${RELAY_BOUND_MS} ms`)
        else if (done) armWake($, wake)
      }
    } catch (err) {
      await logLine($, 'supervision', `pane: ${(err as Error).message}`)
    }
    // The wait the relay just wrote, or cleared, is what the deck's keys show.
    if (!e.agentId) await refreshDeck($)
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // A turn starts: the session works again, and a wait its row carried is over.
  on('turn.start', {}, async ($: any, e: any, next: (e: any) => any) => {
    if (!e.agentId) await showTabState($, 'busy')
    // The model's turn may run `coordinator.sh round`, which reads the pane's record: a record of a
    // pane that is gone is dropped before it does.
    if (!e.agentId) await reconcilePaneRecord($).catch((err: unknown) => logLine($, 'supervision', `pane: ${(err as Error).message}`))
    try {
      const sessionId = await $.session.id()
      const wait = await readWait($, sessionId)
      if (wait?.waiting) {
        await writeWait($, sessionId, clearedWait(wait))
        await refreshDeck($)
      }
    } catch (err) {
      await logLine($, 'supervision', `relay: ${(err as Error).message}`)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
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
      await logLine($, 'supervision', `round: ${(err as Error).message}`)
    }
    return sent
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // A peer's delivery, read before it is queued. A marked row (remote-row.ts) is written to
  // the store and consumed: no model reads it, on either side; so are a remote orchestrator's
  // ask, entered in the coordinator's round, its acknowledgment, and the acknowledgment of an
  // answer sent back (remote-round.ts), by the event line or an older machine's lines. That
  // answer reaches the sender's model as its readable part alone, its marked line taken out. A coordinator's message
  // teaches this machine its address, for the relay and the row when the coordinator runs
  // elsewhere; a successor's « takeover confirmed » teaches an orchestrator who holds its open
  // questions once it hands over or ends. Anything else passes through untouched.
  on('session.receive', {}, async ($: any, e: any, next: (e: any) => any) => {
    let passed = e
    try {
      if (!e.agentId && isPeerOrigin(e.origin) && typeof e.text === 'string') {
        const delivery = deliveryOf(e.text)
        if (isQAck(delivery.body)) return await receiveQAck($, parseQAck(delivery.body), peerAddress(delivery))
        if (isAck(delivery.body)) return await receiveAck($, oldAck(parseAck(delivery.body), 'ask'))
        if (isAnswerAck(delivery.body)) return await receiveAnswerAck($, oldAck(parseAnswerAck(delivery.body), 'answer'))
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
        } else if (isQ(delivery.body) && q?.event.kind !== 'answer') {
          return await receiveAsk($, delivery, q && q.event.kind === 'ask' ? { entry: q.event.entry, machine: q.event.machine } : null, true)
        }
        if (isAsk(delivery.body)) return await receiveAsk($, delivery, parseAsk(delivery.body), false)
        if (q?.event.kind === 'answer' || isAnswer(delivery.body)) {
          const answer = q?.event.kind === 'answer' ? { id: q.id, ...q.event } : parseAnswer(delivery.body)
          const received = await receiveAnswer($, delivery, answer, q !== null)
          if ('consumed' in received) return received
          // The marked first line out, the readable answer in its place, the envelope kept.
          const at = e.text.indexOf(delivery.body)
          passed = { ...e, text: at < 0 ? received.readable : e.text.slice(0, at) + received.readable + e.text.slice(at + delivery.body.length) }
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
        const learnt = learntOf(delivery, Date.now())
        if (learnt) await learnCoordinator($, learnt)
        const successor = successorOf(delivery, Date.now())
        if (successor) await learnSuccessor($, successor)
      }
    } catch (err) {
      await logLine($, 'supervision', `receive: ${(err as Error).message}`)
    }
    return next(passed)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The pane opens on the person's own command alone — the shipped types' «
  // asked » open, placed at any width — in the two supervising roles: a
  // coordinator's lists the orchestrators, an orchestrator's its own agents.
  // Anywhere else the command says so and opens nothing. Every form of the
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
      return { text: 'The supervision pane opens in a coordinator session (« Coord: … »), listing the orchestrators, or in an orchestrator session (« Orch: … »), listing its agents; /orchestrator-status lists the sessions here.' }
    }
    // A toggle: the same command closes the pane it opened (Escape does not —
    // the pane holds no focus), beside the pane's own ✕.
    if (await paneShown($)) {
      await closeShown($, pane)
      return { text: 'Supervision pane closed.' }
    }
    await openPane($, pane, role, tty, pid)
    return { text: 'Supervision pane opened; type /orchestrator-supervision again, or click its ✕, to close it.' }
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The same pane on the operator's plain words: the model calls the tool with `open` or
  // `close` where he types no command. Not a toggle — the word says which.
  on('tool.call', { tool: `mcp__orchestrator__${SUPERVISION_TOOL}` }, async ($: any, e: any) => {
    if (e.agentId) return { result: PANE_MAIN_THREAD_ONLY, isError: true }
    if (e.action !== 'open' && e.action !== 'close') return { result: 'action is "open" or "close"', isError: true }
    const { tty, name, pid } = await walkWithinBound($, await $.session.id())
    const role = roleOf(name)
    if (role !== 'coordinator' && role !== 'orchestrator') return { result: PANE_ROLES_ONLY, isError: true }
    const shown = await paneShown($)
    if (e.action === 'close') {
      if (shown) await closeShown($, pane)
      return { result: shown ? 'Supervision pane closed.' : 'The supervision pane is not open.' }
    }
    const placed = shown ? undefined : await openPane($, pane, role, tty, pid)
    if (shown) return { result: 'The supervision pane is already open.' }
    if (placed && placed.isPlaced === false) return { result: `Supervision pane opened, not drawn yet: ${placed.reason ?? 'no reason given'}.` }
    return { result: 'Supervision pane opened.' }
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: "the supervision pane could not be opened or closed; the module's log says why", isError: true }
  })

  // The pane closed, by its ✕ or its key or by the module: its clock stops with it and its record
  // goes. Nothing is kept of who closed it: no later start opens it again.
  on('ui.close', { id: PANE_ID }, async ($: any, e: any, next: (e: any) => any) => {
    stopTicker()
    await recordPaneClosed($).catch((err: unknown) => logLine($, 'supervision', `pane: ${(err as Error).message}`))
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The body's window moving at the person's wheel or keys: the host's measure of the tree is
  // kept for the track, with the content it measured. A plugin's own move never reaches here.
  on('ui.scroll', { component: 'Pane', requestId: PANE_ID }, async ($: any, e: any, next: (e: any) => any) => {
    if (pane.drawn) pane.measure = { contentRows: e.contentRows, drawn: pane.drawn }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The pane's ring leaving the text field, for the picker or off the pane: the field goes
  // with it, so that Tab from a choice never reaches it, until « Other answer » is picked again.
  on('ui.focus', { component: 'Pane', requestId: PANE_ID }, async ($: any, e: any, next: (e: any) => any) => {
    const result = await next(e)
    if (pane.writing !== null && !result?.deny && e.element !== answerKey(pane.writing)) {
      pane.typed?.delete(pane.writing)
      pane.writing = null
      $.ui.invalidate('ui.render')
    }
    return result
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The pane's own render: the matcher names the render envelope's component
  // and requestId — the pane's id — so the rows are drawn in this plugin's pane
  // alone and never in another plugin's.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($: any, e: any, next: (e: any) => any) => {
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
      let ownUnattended: string | null = null
      const coordinator = pane.opened?.role === 'coordinator'
      if (coordinator) {
        const store = await readStore($)
        const local = store.rows
        const merged = withRemote(local, await readRemoteRows($), Date.now(), REMOTE_STALE_AFTER_MS)
        blocks = paneRows(Object.fromEntries(Object.entries(merged).filter(([, row]) => row.role === 'orchestrator')))
        const repo = await (ownRepo ??= repoRead($))
        if (repo === undefined) ownRepo = null
        owners = repositoryOwners([repo ?? null, ...Object.values(merged).flatMap(row => [row.repo, ...((row as { prs?: unknown }).prs instanceof Array ? (row as { prs: string[] }).prs : [])])])
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
        // An answer to a question asked with `ask` not delivered, while its asker has a row here.
        failed = localAsked.filter(entry => (entry.status === 'answered' || entry.origin !== undefined) && entry.delivery?.state === 'failed')
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
      if (!coordinator) {
        return el.Box({
          flexDirection: 'column',
          children: [
            ...(ownUnattended !== null ? [el.Text({ color: 'warning', children: ownUnattended })] : []),
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
      const columns: number = e.props?.bodyColumns ?? 0
      const width = columns - TRACK_COLUMNS
      const rowsOf = (text: string, at: number) => width > 0 ? text.split('\n').reduce((sum, line) => sum + wrapWords(line, Math.max(1, at)).length, 0) : 0
      type Drawn = { node: unknown; rows: number }
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
        return {
          node: el.Box({
            flexDirection: 'column',
            ...(i > 0 ? { marginTop: 1 } : {}),
            children: [
              line,
              ...(row.status !== null ? [labelled(WORDS.status, el.Text({ color: state, children: row.status }))] : []),
              ...(row.blocked !== null ? [labelled(WORDS.blocks, rich(row.blocked))] : []),
              ...(row.unattended !== null ? [el.Box({ paddingLeft: 2, children: [rich(row.unattended, { color: 'warning' })] })] : []),
            ],
          }),
          rows: (i > 0 ? 1 : 0)
            + rowsOf(`● ${row.name} · ${row.head} · ${row.fill}${row.age !== null ? ` · ${row.age}` : ''}`, width)
            + (row.status !== null ? rowsOf(row.status, textWidth) : 0)
            + (row.blocked !== null ? rowsOf(takesRows(row.blocked), textWidth) : 0)
            + (row.unattended !== null ? rowsOf(takesRows(row.unattended), width - 2) : 0),
        }
      }
      const listed: Drawn[] = blocks.length === 0 ? [{ node: el.Text({ children: none }), rows: rowsOf(none, width) }] : blocks.map(block)
      // A waiting row whose question asked with `ask` the pane draws is not one the operator is left
      // without.
      const askedHere = new Set(asked.map(entry => sessionKey(entry.sender.session)))
      const waiting = blocks.filter(row => row.waiting === 'operator' && !askedHere.has(row.key)).length
      const waitsFor = `${waiting} orchestrator${waiting === 1 ? ' waits' : 's wait'} for you: ask the coordinator`
      const says = waiting === 0 ? WORDS.none : asked.length > 0 ? waitsFor : `${WORDS.none} in the pane — ${waitsFor}`
      // Where the surface draws a picker, the choices are one Select: it holds the arrows while it
      // has the ring, where a focused pane taller than its body scrolls on them, and a click only
      // gives it the ring — a stray click answers nothing. Its last option leads to the text
      // field. Elsewhere (mobile, a tap the only way) one Button per choice.
      const picker = typeof el.Select === 'function'
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
      // The questions asked with `ask`, grouped by asker, each line from a field of the object.
      const askedPieces = askedLines(asked).map(line => ({
        node: el.Box({ paddingLeft: line.indent, children: [rich(line.text, askedLook(line.look))] }),
        rows: rowsOf(takesRows(line.text), width - line.indent),
      }))
      // His answer to the question asked with `ask` the controls are under, once at a time: the
      // object answered by the pane, its asker sent the answer, the coordinator that was shown it
      // told it is settled, as for an entry, the pane drawn again.
      const answerAsked = (id: string, text: string): Promise<void> => {
        if (pane.answering.has(id)) return Promise.resolve()
        pane.answering.add(id)
        return (async () => {
          const shown = await shownToCoordinator($, id)
          const done = await answerAskedFromPane($, id, text)
          if (done === null || done.answer === null) return
          forgetDraft(pane, id)
          if (shown) await $.prompt.submit({ text: settledText(askedAsEntry(done), { text: done.answer.text, by: 'pane', at: done.answer.at }) })
        })()
          .catch(err => logLine($, 'supervision', `round: ${(err as Error).message}`))
          .finally(() => {
            pane.answering.delete(id)
            $.ui.invalidate('ui.render')
          })
      }
      // The controls under that question's lines, as the card draws its own: a picker of its letters
      // and « Other answer » where the surface has one, a Button per choice elsewhere, then the field.
      const askedControls = (entry: Asked): Drawn[] => {
        const indent = 4
        const at = width - indent
        const pick = (letter: string) => answerAsked(entry.id, `${letter} : ${entry.choices.find(c => c.letter === letter)!.text}`)
        const choosingAsked = entry.choices.length > 0
        const controls: Drawn[] = []
        if (choosingAsked && picker) {
          controls.push({
            node: el.Select({
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
            const typed = pane.typed?.get(entry.id) ?? ''
            controls.push({
              node: el.Input({
                key: answerKey(entry.id),
                label: OTHER_LABEL,
                placeholder: WORDS.otherPlaceholder,
                submitLabel: WORDS.send,
                rows: ANSWER_ROWS,
                onInput: (value: string) => {
                  if (value === '') pane.typed?.delete(entry.id)
                  else pane.typed?.set(entry.id, value)
                  $.ui.invalidate('ui.render')
                },
                onSubmit: (value: string) => (value.trim() === '' ? undefined : answerAsked(entry.id, value)),
              }),
              rows: ANSWER_ROWS,
            }, ...(typed === '' ? [] : [{ node: el.Text({ children: typed }), rows: rowsOf(typed, at) }]))
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
        return controls.map(control => ({ node: el.Box({ paddingLeft: indent, children: [control.node] }), rows: control.rows }))
      }
      // The controls go right under the lines of the question they answer: its Blocks line, the first.
      const answeredEnd = answering === null ? -1 : askedLines(asked).findIndex(line => line.look === 'label')
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
      // line would cover it.
      const drawnKey = JSON.stringify([answering?.id ?? null, pending, asked.map(entry => entry.id), blocks, failed.map(notice => notice.reason), delivering.map(entry => entry.delivery), pane.writing, [...pane.other], [...(pane.typed ?? [])], e.props?.isFocused ?? false, columns, scroll?.bodyRows ?? null, keyLine])
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
      await logLine($, 'supervision', (err as Error).message)
      return next(e)
    } finally {
      const took = await clockNow($) - started
      if (took > PANE_RENDER_BOUND_MS && !renderSlow) await logLine($, 'supervision', `pane: the render took ${took} ms, past its bound of ${PANE_RENDER_BOUND_MS} ms`)
      renderSlow = took > PANE_RENDER_BOUND_MS
    }
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// The bound on the whole relay at a turn's end: the row and wait reads, the wait's
// write, the coordinator's record and the send queued. Well inside a handler's ten seconds.
const RELAY_BOUND_MS = 5000

// Whether a session of this role puts its operator questions into the round: an orchestrator, a
// coordinator and an auditor do, as one rule for every turn's end.
export function entersRound(role: string | null): boolean {
  return role === 'orchestrator' || role === 'coordinator' || role === 'auditor'
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
export async function relayTurnEnd($: any, answer: string, turnId: unknown): Promise<void> {
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
  const orchestrating = entersRound(role)
  if (!name || (!orchestrating && role !== 'agent')) return
  // An agent's text goes up held to the verdict limit; an orchestrator's to the coordinator is never cut here.
  if (role === 'agent') answer = heldReport(answer)
  const wait = orchestrating ? parseWait(answer) : parseStatus(answer)
  const before = await readWait($, sessionId)
  const relayed = before?.relayed ?? null
  // The id of the entry a remote coordinator acknowledged, kept while its fingerprint is.
  const relayedId = relayed !== null ? before?.relayed_id ?? null : null
  // A turn that ends on « handed over »: the successor holds the work, and the questions.
  if (!wait && role === 'orchestrator' && handsOver(answer)) await handOver($, sessionId)
  if (!wait && orchestrating) {
    if (before?.waiting) await writeWait($, sessionId, { ...clearedWait(before), relayed, relayed_id: relayedId, name, pid })
    return
  }
  const patch = wait
    ? waitPatch(before, wait, new Date().toISOString())
    : before?.waiting ? clearedWait(before) : null
  if (patch) await writeWait($, sessionId, { ...patch, relayed, relayed_id: relayedId, name, pid })
  if (orchestrating && wait?.kind === 'operator') return
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
    await changeEntry($, roundPath(await stateDir($), entry.id), () => entry)
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
    const machine = await machineOf($)
    const sent = await sendToCoordinator($, to, qAskLine(entry, machine))
    if (sent?.isDelivered) {
      // Until the old lines retire, the old ask goes beside the event line: a coordinator of an
      // older release reads that one alone; this release's enters the first and ignores the other.
      const old = await sendToCoordinator($, to, askLine(entry, machine))
      if (!old?.isDelivered) await logLine($, 'supervision', `relay: the old ask line was not delivered to ${addressLabel(to)}: ${old?.reason ?? 'no answer'}`)
      return
    }
    await logLine($, 'supervision', `relay: not delivered to ${addressLabel(to)}: ${sent?.reason ?? 'no answer'}`)
    const now = await readWait($, sessionId)
    if (now && now.pending === entry.id) await writeWait($, sessionId, { ...now, pending: null, pending_key: null })
    return
  }
  const context = row && row.context_tokens > 0 ? `${row.context_tokens.toLocaleString('en-US')} (${row.context_percent}%)` : null
  const text = wait ? relayText(name, wait, patch!.waiting_since!, context) : noStatusText(name, context, answer)
  const sent = orchestrating ? await sendToCoordinator($, to, text) : await $.session.send({ to, text })
  if (sent?.isDelivered) {
    await writeWait($, sessionId, { ...(patch ?? before ?? {}), relayed: key, name, pid })
  } else {
    await logLine($, 'supervision', `relay: not delivered to ${addressLabel(to)}: ${sent?.reason ?? 'no answer'}`)
  }
}

// The session's open entries moved to the successor it learnt, or, none learnt, withdrawn by its
// hand-over, every write first, then the notices in what is left of the bound.
async function handOver($: any, sessionId: string): Promise<void> {
  const until = Date.now() + RELAY_BOUND_MS
  const successor = await readSuccessor($, sessionId)
  const done = await withDeadline(successor
    ? moveToSuccessor($, sessionId, successor)
    : withdrawStale($, sessionId, null, 'handed over to its successor').then(async settled => {
      await withdrawAsked($, sessionId, 'handed over to its successor')
      return settled
    }), RELAY_BOUND_MS)
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
async function withdrawEntry($: any, sessionId: string, name: string, held: { blocks: string; since: string | null; said?: string }): Promise<Settled[]> {
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
    else {
      if (closed) settled.push({ entry, answer })
      await writeTabConsent($, entry, held.said ?? '', at)
    }
  }
  if (direct.length === 0) await logLine($, 'supervision', `round: no open entry matched for ${name} since ${held.since ?? '?'}`)
  return settled
}

// The operator's answer to an entry that asks his consent, written as that subject's consent
// record (core's consent-record.ts), the contract github reads in place of the round. An entry
// that asks none, an answer with nothing to quote, or a write that fails leaves the answer as it
// is: an entry that asked a consent and records none says why in one log line.
export async function writeConsent($: any, entry: RoundEntry, text: string, by: Answerer, at: string): Promise<string | null> {
  if (!entry.consent) return null
  const record = consentRecordOf({ subject: entry.consent, entry: entry.id, question: entry.question, answer: text, choices: entry.choices, by, at })
  if (!record) {
    const why = `« ${text.trim()} » names none of its choices`
    await logLine($, 'supervision', `round: the consent of ${entry.id} (${subjectLabel(entry.consent)}) was not recorded: ${why}`)
    return why
  }
  try {
    const path = consentPath(await configDir($), record)
    const made = await $.process.run(['mkdir', '-p', '--', path.slice(0, path.lastIndexOf('/'))], { timeoutMs: 5000 })
    if (made.exitCode !== 0) throw new Error(made.stderr || `mkdir exited ${made.exitCode}`)
    await writeAtomic($, path, JSON.stringify(record) + '\n')
    return null
  } catch (err) {
    await logLine($, 'supervision', `round: the consent of ${entry.id} was not recorded: ${(err as Error).message}`)
    return (err as Error).message
  }
}

// The words the operator typed in the asking session's own tab, as the answer to an entry that
// asks his consent: a record (`by: 'tab'`, as writeConsent writes the pane's) only when they name
// one choice of the entry unambiguously (answersChoice) and that choice grants (« Accorder »,
// core's grants): the record's answer is its text. A prompt typed there can be any instruction,
// and a refusal is no consent: free prose, an ambiguous answer and a refusing choice leave no
// record, and the log says so once.
async function writeTabConsent($: any, entry: RoundEntry, typed: string, at: string): Promise<void> {
  if (!entry.consent) return
  const chosen = answersChoice(typed, entry.choices)
  if (!chosen || !grants(chosen.text)) {
    await logLine($, 'supervision', `round: the words typed for ${entry.id} are not one unambiguous « ${CONSENT_GRANT} », no consent recorded`)
    return
  }
  await writeConsent($, entry, `${chosen.letter} : ${chosen.text}`, 'tab', at)
}

// A question's « other answer » forgotten: its field and its note to answer in the session.
function forgetDraft(pane: PaneMemory, key: string): void {
  pane.other.delete(key)
  pane.typed?.delete(key)
  if (pane.writing === key) pane.writing = null
}

// Whether the round holds the entry of that id, open: a file absent, or in any other status, is not.
async function entryIsOpen($: any, id: string): Promise<boolean> {
  return parseRoundEntry(String(await $.fs.read(`${await stateDir($)}/round/${id}.json`).catch(() => '')))?.status === 'open'
}

// A settled entry's fingerprint forgotten in its sender's wait file, so the same question asked
// again is entered again: the file is re-read and written back with `relayed` null only when it
// still holds that entry's own fingerprint (a later wait may have replaced it).
export async function forgetRelayed($: any, entry: RoundEntry): Promise<void> {
  const now = await readWait($, entry.session)
  if (now && now.relayed === entryFingerprint(entry)) await writeWait($, entry.session, { ...now, relayed: null })
}

// The session's own name by its walk alone (its host's record, its launch name, its last rename):
// the name of a session whose row is not written yet, or was written by a walk that did not finish.
// `known` is false when the walk did not finish, the whole of it (the transcript's place included)
// held to the side-read bound, and a name null with `known` true is a session found unnamed.
export async function walkedName($: any, sessionId: string): Promise<{ known: boolean; name: string | null }> {
  const walked = await withDeadline(walkWithinBound($, sessionId), await sideReadBoundMs($))
  return isDegradedPass(walked) ? { known: false, name: null } : { known: walked.known, name: walked.name }
}

// The role of the session: the name its row holds, else the name its walk reads.
export async function sessionRole($: any, sessionId: string): Promise<string | null> {
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
  return roleOf(row?.name ?? (await walkWithinBound($, sessionId)).name ?? null)
}

// Whether the session is an orchestrator.
export async function isOrchestratorSession($: any, sessionId: string): Promise<boolean> {
  return (await sessionRole($, sessionId)) === 'orchestrator'
}

// An orchestrator's turn ended on a machine line other than the wait an open entry of its own
// holds: that entry is no longer what it waits on, so it is withdrawn by the sender, leaves the
// pane and its count, and its fingerprint is forgotten. A turn with no machine line says nothing
// of its wait and withdraws nothing. The same withdrawal closes every open entry of a session
// that ended, or that handed over (`current` null).
// `current` is the id of the entry this turn's wait has, kept open; `why` the withdrawal's answer
// text; `kept` the entries left open besides. An entry the
// coordinator on this machine was shown is closed instead, its answer « withdrawn: <why> », and returned so the caller tells it once
// every write is done. Each withdrawal is one log line; one that cannot be written is one too,
// and the relay goes on.
async function withdrawStale($: any, sessionId: string, current: string | null, why: string, kept?: (entry: RoundEntry) => boolean): Promise<Settled[]> {
  const settled: Settled[] = []
  for (const { path, entry } of await readRound($)) {
    if (entry.session !== sessionId || entry.status !== 'open' || entry.id === current || kept?.(entry)) continue
    try {
      const shown = await closesItself($, entry.id)
      const at = new Date().toISOString()
      // Read again under the lock: a move to a successor or an answer in between is never overwritten.
      const done = await closeRound($, path, current => {
        const fresh = parseRoundEntry(current ?? '')
        return !fresh || fresh.status !== 'open' || fresh.session !== sessionId ? null : planWithdrawal(fresh as never, why, at, shown)
      }, { session: sessionId, name: entry.from, role: 'orchestrator' }, at, () => logLine($, 'supervision', `round: withdrawn by the sender: ${entry.id}`))
      if (done === null || 'error' in done) continue
      if (shown) settled.push({ entry, answer: done.plan.entry['answer'] as RoundAnswer })
    } catch (err) {
      await logLine($, 'supervision', `round: ${(err as Error).message}`)
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
  let listed: readonly { name: string; kind: string; mtimeMs?: number }[]
  try {
    listed = await $.fs.list(dir)
  } catch (err) {
    if (await $.fs.exists(dir).catch(() => true)) await logLine($, 'supervision', `round: cannot list ${dir}: ${(err as Error).message}`)
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

const ROUND_STATUSES: readonly string[] = ['open', 'answered', 'withdrawn', 'closed']

// An entry file read back: the JSON of one entry, each field of its type, or nothing.
export function parseRoundEntry(text: string): RoundEntry | null {
  try {
    const e = JSON.parse(text)
    if (!e || typeof e !== 'object') return null
    const texts = [e.id, e.from, e.session, e.since, e.question, e.at].every(field => typeof field === 'string')
    const choices = Array.isArray(e.choices) && e.choices.every((c: any) => typeof c?.letter === 'string' && typeof c?.text === 'string')
    const nullable = [e.blocks, e.recommendation].every(field => field === null || typeof field === 'string')
    const known = (e.kind === 'operator' || e.kind === 'done') && ROUND_STATUSES.includes(e.status)
    const consent = e.consent === undefined || parseConsentSubject(e.consent) !== undefined
    return texts && choices && nullable && known && consent && deliveryRead(e) ? e as RoundEntry : null
  } catch {
    return null
  }
}

// An entry's delivery, when it carries one, its fields of their type and no other, the reason a
// text: beside an origin, its state one of a remote answer's and no answer stamp; without one, its
// state one of an answer's on this machine and the stamp of the answer it carries.
const DELIVERY_STATES: readonly string[] = ['pending', 'sent', 'acked', 'failed']
const LOCAL_DELIVERY_STATES: readonly string[] = ['pending', 'delivered', 'failed']
function deliveryRead(e: any): boolean {
  if (e.delivery === undefined) return true
  const d = e.delivery
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false
  const remote = e.origin !== undefined
  if (remote && (!e.origin || typeof e.origin !== 'object')) return false
  const keys = Object.keys(d)
  const shaped = remote
    ? DELIVERY_STATES.includes(d.state) && d.answerAt === undefined
    : LOCAL_DELIVERY_STATES.includes(d.state) && typeof d.answerAt === 'string'
  return shaped && typeof d.at === 'string' && Number.isInteger(d.attempts) && d.attempts >= 0
    && (d.reason === undefined || typeof d.reason === 'string') && keys.every(key => ['state', 'at', 'attempts', 'answerAt', 'reason'].includes(key))
}

// Where an orchestrator's reports go: the coordinator registered on this machine first
// (coordinator.sh's record), else the one a peer delivery taught this machine — its
// address as the envelope gave it, else its name. Null when neither names one. A name recorded
// without its reference may be another session's too, one the host keeps for its remote control
// say, and the host refuses a send to a name several carry: the coordinator on this machine is
// then addressed by the session id the host's registry gives it.
export type CoordinatorTo = string | { sessionId: string }
export async function coordinatorAddress($: any): Promise<{ to: CoordinatorTo; name: string; local: boolean } | null> {
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
async function registeredSession($: any, name: string, recordText: string, options: { exclude?: string; pid?: string | null } = {}): Promise<{ sessionId: string } | null> {
  let pid: string | null = options.pid ?? null
  try {
    const recorded = JSON.parse(recordText)?.pid
    if (pid === null && recorded !== undefined && recorded !== null && String(recorded) !== '') pid = String(recorded)
  } catch { /* coordinatorOf read it already */ }
  const dir = `${await configDir($)}/sessions`
  const named: { pid: string; sessionId: string }[] = []
  try {
    for (const file of await $.fs.list(dir)) {
      if (!file || file.kind !== 'file' || !file.name.endsWith('.json')) continue
      try {
        const record = JSON.parse(String(await $.fs.read(`${dir}/${file.name}`)))
        if (record?.name === name && typeof record.sessionId === 'string' && record.sessionId !== '' && record.sessionId !== options.exclude) named.push({ pid: String(record.pid ?? ''), sessionId: record.sessionId })
      } catch { /* a record being written, or gone: not this one */ }
    }
  } catch {
    return null
  }
  const chosen = named.length > 1 && pid !== null ? named.filter(record => record.pid === pid) : named
  return chosen.length === 1 ? { sessionId: chosen[0].sessionId } : null
}

// A send to the coordinator. A name the host refuses as several sessions' is sent once more to
// the one the refusal places on this machine, by its reference, when it names exactly one.
export async function sendToCoordinator($: any, to: CoordinatorTo, text: string): Promise<any> {
  const sent = await $.session.send({ to, text })
  if (sent?.isDelivered || typeof to !== 'string') return sent
  const here = String(sent?.reason ?? '').split('\n').map(line => line.match(/^\s*(.+ \[[^\]\s]+\]) — .*\bon this machine\b/)?.[1]).filter(Boolean)
  return here.length === 1 && here[0] !== to ? $.session.send({ to: here[0], text }) : sent
}

// A consent subject as a log line names it: the pull request of a waiver, the repository of auto-merge.
function subjectLabel(consent: ConsentSubject): string {
  return 'pr' in consent ? `${consent.kind} ${consent.repo}#${consent.pr}` : `${consent.kind} ${consent.repo}`
}

// A recipient as a log line names it.
function addressLabel(to: CoordinatorTo): string {
  return typeof to === 'string' ? to : `session ${to.sessionId}`
}

async function learnCoordinator($: any, learnt: { name: string; from: string | null; at: string }): Promise<void> {
  const path = `${await storeOf($)}/coordinator-learnt`
  const known = parseLearnt(String(await $.fs.read(path).catch(() => '')))
  if (known && known.name === learnt.name && known.from === learnt.from) return
  await writeAtomic($, path, JSON.stringify(learnt) + '\n')
}

// A successor's « takeover confirmed », recorded by an orchestrator only, over any successor
// recorded before it: its session id when this machine's registry names it alone, else its name
// and address. At « takeover confirmed » the predecessor and its successor carry one name, so
// the receiving session's own record is left out of the candidates, and the process id the
// reply address carries (`uds:/…/<pid>.sock`) chooses among the several that remain.
async function learnSuccessor($: any, learnt: LearntSuccessor): Promise<void> {
  const sessionId = await $.session.id()
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
  if (roleOf(row?.name ?? null) !== 'orchestrator') return
  const session = (await registeredSession($, learnt.name, '', { exclude: sessionId, pid: successorPid(learnt) }))?.sessionId ?? null
  await writeAtomic($, `${await storeOf($)}/${successorKey(sessionId)}`, JSON.stringify({ ...learnt, session }) + '\n')
  await logLine($, 'supervision', `round: successor learnt: ${learnt.name}${session ? ` (session ${session})` : ''}`)
}

// The process id a successor's reply address carries (`uds:/…/<pid>.sock`), or none.
function successorPid(successor: LearntSuccessor): string | null {
  return successor.from?.match(/\/(\d+)\.sock$/)?.[1] ?? null
}

async function readSuccessor($: any, sessionId: string): Promise<LearntSuccessor | null> {
  return parseSuccessor(String(await $.fs.read(`${await storeOf($)}/${successorKey(sessionId)}`).catch(() => '')))
}

// The session's open entries rewritten in place for its successor: its session and name become
// theirs and the status stays open. The successor's own fingerprint is left as it is. Each move
// is one log line; one that cannot be written is one too, and the others go on. Nothing is
// settled: the coordinator is told nothing.
async function moveToSuccessor($: any, sessionId: string, successor: LearntSuccessor): Promise<Settled[]> {
  // A successor the registry did not name alone at its « takeover confirmed » is looked up again:
  // its record may have landed since. One still unnamed is drawn on its name (hostedSuccessors).
  const session = successor.session ?? (await registeredSession($, successor.name, '', { exclude: sessionId, pid: successorPid(successor) }))?.sessionId ?? ''
  for (const { path, entry } of await readRound($)) {
    if (entry.session !== sessionId || entry.status !== 'open') continue
    try {
      const written = await changeEntry($, path, fresh =>
        !fresh || fresh.status !== 'open' || fresh.session !== sessionId ? null : { ...fresh, session, from: successor.name, movedFrom: sessionId })
      if (written) await logLine($, 'supervision', `round: moved to the successor ${successor.name}: ${entry.id}`)
    } catch (err) {
      await logLine($, 'supervision', `round: ${(err as Error).message}`)
    }
  }
  // The questions asked with `ask` follow, their asker now the successor.
  await moveAsked($, sessionId, { session, name: successor.name })
  return []
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
  const waitText = String(await $.fs.read(`${store}/${waitKey(sessionId)}`).catch(() => ''))
  const row = remoteRowOf(withWait(read, waitText), await machineOf($), prs, openQuestions(parseWaitRecord(waitText)))
  if (!row) return
  const now = Date.now()
  const path = `${store}/${rowKey(sessionId)}`
  if (!rowIsNews(row, parseRowSent(String(await $.fs.read(path).catch(() => ''))), now)) return
  let sent = await sendToCoordinator($, to.to, rowText(row))
  if (!sent?.isDelivered && to.to !== to.name) sent = await sendToCoordinator($, to.name, rowText(row))
  if (sent?.isDelivered) await writeAtomic($, path, JSON.stringify(rowSent(row, now)) + '\n')
  else await logLine($, 'supervision', `row: not delivered to ${to.name}: ${sent?.reason ?? 'no answer'}`)
}

// A remote orchestrator's ask (remote-round.ts), consumed whatever it holds. In the coordinator's
// session alone, one that passes every check is entered in the round with where it came from, and
// acknowledged to its sender. The same entry sent again, its wait's start unchanged, is never
// entered twice, whatever became of it since: it is acknowledged again, its first acknowledgment
// having been lost. Anything else is one log line.
async function receiveAsk($: any, delivery: Delivery, asked: ReturnType<typeof parseAsk>, byEvent: boolean): Promise<{ consumed: string }> {
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
      const line = byEvent ? qAnswerLine : answerLine
      const sent = await $.session.send({ to: from, text: line(asked.entry.id, asked.entry.since, 'refused', at, readable) })
      if (!sent?.isDelivered) await logLine($, 'supervision', `receive: the refusal of ${asked.entry.id} was not delivered to ${from}: ${sent?.reason ?? 'no answer'}`)
      return { consumed: 'orchestrator: a remote operator question of an older release, refused' }
    }
    step = 'the entry read'
    const path = roundPath(await stateDir($), asked.entry.id)
    const known = parseRoundEntry(String(await $.fs.read(path).catch(() => '')))
    // The same ask by the other line, sent beside the one it was entered by: the first was
    // taken and acknowledged, this one changes nothing and is acknowledged nowhere.
    if (known?.since === asked.entry.since && known.origin && (known.origin.line === 'q') !== byEvent) {
      return { consumed: 'orchestrator: a remote question received by its other line, ignored' }
    }
    if (known?.since !== asked.entry.since) {
      const entry: RoundEntry = { ...asked.entry, origin: { machine: asked.machine, address: from, ...(byEvent ? { line: 'q' as const } : {}) } }
      step = 'the entry write'
      await changeEntry($, path, () => entry)
      await logLine($, 'supervision', `round: entered from ${asked.machine}: ${entry.id}`)
      step = 'the deck refresh'
      await refreshDeck($)
      step = 'the pane redraw'
      $.ui.invalidate('ui.render')
    }
    step = 'the acknowledgment'
    const ack = byEvent ? qAckLine({ id: asked.entry.id, seq: seqOf(asked.entry.since), of: 'ask' }) : ackLine(asked.entry.id, asked.entry.since)
    const sent = await $.session.send({ to: from, text: ack })
    if (!sent?.isDelivered) await logLine($, 'supervision', `receive: the acknowledgment of ${asked.entry.id} was not delivered to ${from}: ${sent?.reason ?? 'no answer'}`)
  } catch (err) {
    await logLine($, 'supervision', `receive: a remote question failed at ${step} (${asked.entry.id}): ${(err as Error).message}`)
  }
  return { consumed: 'orchestrator: a remote question, entered' }
}

// A coordinator's acknowledgment, consumed whatever it holds: the one of the entry this session's
// wait holds as pending, and of the very ask it holds (the same start), keeps its fingerprint, as
// a delivery's, and clears it. An older ask's, late, matches nothing: the newer one stays pending
// and is sent again. The wait is read again just before, a turn's end may have written it. Any
// other is one log line.
async function receiveAck($: any, ack: QAck | null): Promise<{ consumed: string }> {
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
    await logLine($, 'supervision', `receive: an acknowledgment failed at ${step}${ack ? ` (${ack.id})` : ''}: ${(err as Error).message}`)
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
async function receiveAnswer($: any, delivery: Delivery, answer: ReturnType<typeof parseAnswer>, byEvent: boolean): Promise<{ consumed: string } | { readable: string }> {
  if (!answer) {
    await logLine($, 'supervision', `receive: an answer was refused (${delivery.body.length} characters)`)
    return { consumed: 'orchestrator: a malformed answer, refused' }
  }
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
      // « Already » rides on the event line's acknowledgment alone: an old line's answer that crossed
      // the tab's is acked by it too, never as delivered, so the pane says it failed. A coordinator of
      // an older release reads no such acknowledgment: its answer stays unacked and fails there.
      const ack = byEvent || already ? qAckLine({ id: answer.id, seq: seqOf(answer.since), of: 'answer', ...(already ? { already: true as const } : {}) }) : answerAckLine(answer.id, answer.since)
      const sent = await $.session.send({ to: from, text: ack })
      if (!sent?.isDelivered) await logLine($, 'supervision', `receive: the acknowledgment of the answer to ${answer.id} was not delivered to ${from}: ${sent?.reason ?? 'no answer'}`)
    }
    if (already) return { consumed: 'orchestrator: an answer to a question answered in its tab first, said already answered' }
    if (again) return { consumed: 'orchestrator: an answer received already, acknowledged again' }
  } catch (err) {
    await logLine($, 'supervision', `receive: an answer failed at ${step} (${answer.id}): ${(err as Error).message}`)
  }
  return { readable: answer.readable }
}

// The last answer taken, as answeredKey's file holds it: null when it holds no id and start.
function parseAnswered(text: string): { id: string; since: string; by?: 'tab' } | null {
  try {
    const read = JSON.parse(text)
    return read && typeof read.id === 'string' && typeof read.since === 'string' ? { id: read.id, since: read.since, ...(read.by === 'tab' ? { by: 'tab' as const } : {}) } : null
  } catch {
    return null
  }
}

// A remote sender's acknowledgment of the answer sent to it, consumed whatever it holds: the
// entry of that id and start, its answer pending, sent or failed, is acknowledged and closed, and
// the pane drawn again. Any other is one log line.
async function receiveAnswerAck($: any, ack: QAck | null): Promise<{ consumed: string }> {
  let step = 'the entry read'
  try {
    if (!ack) {
      await logLine($, 'supervision', "receive: an answer's acknowledgment was refused")
      return { consumed: "orchestrator: an answer's acknowledgment, refused" }
    }
    const path = roundPath(await stateDir($), ack.id)
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
    await logLine($, 'supervision', `receive: an answer's acknowledgment failed at ${step}${ack ? ` (${ack.id})` : ''}: ${(err as Error).message}`)
  }
  return { consumed: "orchestrator: an answer's acknowledgment, recorded" }
}

// An event line's acknowledgment (remote-round.ts), dispatched by the event it takes.
async function receiveQAck($: any, ack: QAck | null, from: string | null): Promise<{ consumed: string }> {
  if (ack?.of === 'asked') return receiveAskedAck($, from, ack)
  if (ack?.of === 'reply') return receiveReplyAck($, from, ack)
  return ack?.of === 'answer' ? receiveAnswerAck($, ack) : receiveAck($, ack)
}

// An old line's acknowledgment, read as the event line's: its start as the seq.
function oldAck(ack: { id: string; since: string } | null, of: QAck['of']): QAck | null {
  return ack && { id: ack.id, seq: seqOf(ack.since), of }
}

// What the pane says of an answer its sender's tab had settled first.
export const ALREADY_ANSWERED = 'already answered in its own tab'

// A peer's address as its envelope gave it, when it is one a send can reach.
function peerAddress(delivery: Delivery): string | null {
  return delivery.from && delivery.from.length <= 200 && /^(?:uds|bridge):\S+$/.test(delivery.from) ? delivery.from : null
}

// This session's role, by the name its row carries, else by a walk of its own.

async function ownRole($: any): Promise<SessionRow['role']> {
  const sessionId = await $.session.id()
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
  if (row?.name) return roleOf(row.name)
  const walked = await walkWithinBound($, sessionId)
  return walked.known ? roleOf(walked.name) : null
}

// A marked delivery: consumed whatever it holds — the marker is the module's own, never a
// message for the model — and written as a remote row only when it passes every check.
async function receiveRow($: any, body: string): Promise<{ consumed: string }> {
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
    await logLine($, 'supervision', `receive: a remote row of ${row.name} was not stored: ${(err as Error).message}`)
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
async function receiveWithdrawal($: any, withdrawal: NonNullable<ReturnType<typeof parseWithdrawal>>, from: string | null): Promise<{ consumed: string } | null> {
  if (await ownRole($) !== 'coordinator') return null
  try {
    const blocks = cleanBlocks(withdrawal.blocks)
    for (const { entry } of await readRound($)) {
      if (entry.status !== 'open' || entry.kind !== 'operator' || !entry.origin || entry.origin.address !== from || entry.from !== withdrawal.name || entry.since !== withdrawal.since || entry.blocks !== blocks) continue
      await tellSettled($, await withdrawEntry($, entry.session, entry.from, { blocks, since: entry.since }), Date.now() + RELAY_BOUND_MS)
    }
    $.ui.invalidate('ui.render')
  } catch (err) {
    await logLine($, 'supervision', `receive: a withdrawal failed (${withdrawal.name}): ${(err as Error).message}`)
  }
  return { consumed: 'coordinator: a remote withdrawal, applied' }
}

// The rows received from other machines, each checked again as it is read; a stale or
// malformed one is removed, so the directory never outgrows the live set. A row met dead is read
// again under the lock its writer takes (receiveRow), and removed only when it is still dead: a
// sender's newer row landing between the first read and the removal, or a read that failed once,
// never loses a live row.
const REMOTE_READ_CAP = 64
export async function readRemoteRows($: any): Promise<RemoteRow[]> {
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
// asked with `ask`), the chains and the sleepers read once and written to the state directory's
// deck.json, only when it is news against
// the file as it stands, whichever session wrote it last: every session of the machine computes
// the same view of the same store, so a view another one already wrote is not written again, and
// the stamp's refresh (DECK_REFRESH_MS) is the machine's, not each session's. Bounded by its
// callers and never a failure of theirs: a deck that cannot be written is one log line, and the
// next change writes it.
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
    // The relay's entries and the questions asked with `ask`, each its own object in the round; one
    // his prompt claimed in its asker's tab is gone from the round, as the pane and the wake read it.
    round: [...(await readRound($)).map(read => read.entry), ...(await readAsked($)).filter(entry => !entry.claimed).map(askedAsEntry)],
    sleepingText: String(await $.fs.read(`${state}/sleeping.json`).catch(() => '')),
    gate: await gateEnv($),
  })
  const path = `${state}/${DECK_FILE}`
  if (!deckIsNews(deck, writtenDeck(String(await $.fs.read(path).catch(() => ''))), now)) return
  await writeAtomic($, path, deckText(deck))
}

// The deck a file holds, with the time it was generated, or null when it holds none of this version.
function writtenDeck(text: string): { deck: Deck; at: number } | null {
  try {
    const deck = JSON.parse(text) as Deck
    const at = Date.parse(String(deck?.generated_at))
    return deck && deck.version === DECK_VERSION && Number.isFinite(at) ? { deck, at } : null
  } catch {
    return null
  }
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
export function refreshUsage($: any, clock: () => number = Date.now): Promise<void> {
  if (!usageRead) {
    usageRead = readOwnUsage($, clock)
      .then(async published => { if (published) await writeDeck($) })
      .catch(err => logLine($, 'supervision', `deck: usage: ${(err as Error).message}`))
      .finally(() => { usageRead = null })
  }
  return usageRead
}

// One read: the session's row says whether the deck lists it (its role); its transcript is
// found once, and a miss is looked for again at most once per TRANSCRIPT_RETRY_MS, so a read
// in between never lists the projects directory. True when the row was written.
async function readOwnUsage($: any, clock: () => number): Promise<boolean> {
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
async function bookOwn($: any, own: OwnBook, main: string): Promise<DeckUsage | null> {
  const now = Date.now()
  const { prices, text } = await readPrices($)
  try {
    const size = (await $.fs.stat(main)).size
    if (typeof size !== 'number') throw new Error('no size')
  } catch (err) {
    await logOnce($, `main ${own.id}`, main, `deck: the transcript ${main} cannot be read (${(err as Error).message}): its usage is null`)
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
      const message = (err as Error).message
      await logOnce($, `file ${path}`, message, `deck: usage of ${path}: ${message}`)
    }
  }
  if (book.malformed > 0) await logOnce($, `malformed ${own.id}`, String(book.malformed), `deck: ${book.malformed} malformed lines dropped from the transcripts of session ${own.id}`)
  return usageOf(book, now)
}

// routing/prices.json under the state directory. Missing or no JSON object: no prices, every
// period's cost null and its tokens still counted, said once per text the file holds.
async function readPrices($: any): Promise<{ prices: Prices; text: string }> {
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
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      logged.delete('prices')
      return { prices: parsed, text }
    }
  } catch { /* said below */ }
  await logOnce($, 'prices', text, `deck: ${path} is no JSON object: every cost is null`)
  return { prices: {}, text }
}

// What the usage read last said per topic: a condition is logged when it starts or changes,
// never again on every read while it lasts, and forgotten when it ends.
const logged = new Map<string, string>()
async function logOnce($: any, topic: string, fingerprint: string, message: string): Promise<void> {
  if (logged.get(topic) === fingerprint) return
  logged.set(topic, fingerprint)
  await logLine($, 'supervision', message)
}

// The lines appended to one transcript since the book's offset; a file shorter than it was
// rewritten and is read again from its first byte.
async function readAppended($: any, book: UsageBook, path: string): Promise<void> {
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

async function refreshDeck($: any, bound = RELAY_BOUND_MS): Promise<void> {
  // Detached: the hook goes on, and the read writes the row and the deck again when it is done.
  void refreshUsage($)
  try {
    const done = await withDeadline(writeDeck($), bound)
    if (isDegradedPass(done)) await logLine($, 'supervision', `deck: did not finish within ${bound} ms`)
  } catch (err) {
    await logLine($, 'supervision', `deck: ${(err as Error).message}`)
  }
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
export async function orchestratorOn($: any, tty: string | null, agent: string, what: string): Promise<CoordinatorTo | null> {
  const dir = `${await stateDir($)}/chains`
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
        const record = JSON.parse(String(await $.fs.read(`${registry}/${file.name}`)))
        if (record?.name !== bare || typeof record.sessionId !== 'string' || record.sessionId === '') continue
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
  const to = await orchestratorOn($, tty, name, 'gate')
  if (!to) {
    await logLine($, 'supervision', `gate: no orchestrator found for ${name} on ${tty}`)
    return
  }
  const sent = await $.session.send({ to, text: gateText(name, reading.context_tokens, reading.context_percent) })
  if (sent?.isDelivered) await $.fs.write(path, 'reported\n')
  else await logLine($, 'supervision', `gate: not delivered to ${addressLabel(to)}: ${sent?.reason ?? 'no answer'}`)
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
async function tabOf($: any): Promise<{ target: TabTarget; bin: string; memory: TabMemory } | null> {
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
      await tabFailure($, memory, (err as Error).message)
      return null
    }
  }
  return memory.home ? { target, bin, memory } : null
}

async function tabFailure($: any, memory: TabMemory, message: string): Promise<void> {
  if (memory.said) return
  memory.said = true
  await logLine($, 'supervision', `tab-state: ${message}`)
}

// The state written on the window, only when it is not the one already shown.
async function showTabState($: any, state: TabState): Promise<void> {
  const tab = await tabOf($).catch(() => null)
  if (!tab || tab.memory.shown === state) return
  try {
    const set = await $.process.run(stateArgv(tab.bin, tab.target, state), { timeoutMs: TMUX_TIMEOUT_MS })
    if (!set || set.exitCode !== 0) throw new Error(`tmux exited ${set?.exitCode ?? 'without answer'} writing ${state}`)
    tab.memory.shown = state
    tab.memory.said = false
  } catch (err) {
    tab.memory.shown = null
    await tabFailure($, tab.memory, (err as Error).message)
  }
}

// The address of this session's window when it runs in a home session, else null.
async function windowAddress($: any): Promise<string | null> {
  try {
    return (await tabOf($))?.memory.window ?? null
  } catch {
    return null
  }
}

// A turn ended: the wait it left in the session's wait file, else the gate, else rest.
async function showTurnEnd($: any): Promise<void> {
  try {
    const tab = await tabOf($)
    if (!tab) return
    const wait = await readWait($, await $.session.id())
    await showTabState($, stateAfterTurn(wait?.waiting, tab.memory.past))
  } catch (err) {
    await logLine($, 'supervision', `tab-state: ${(err as Error).message}`)
  }
}

// A measure: the gate's side remembered for the turn's end, and shown at once on a window at rest.
async function showGate($: any, reading: { context_percent: number; context_tokens: number; context_window: number }): Promise<void> {
  try {
    const tab = await tabOf($)
    if (!tab) return
    tab.memory.past = tripGate(reading.context_percent, reading.context_tokens, reading.context_window, await gateEnv($)).tripped
    const next = stateAfterMeasure(tab.memory.shown, tab.memory.past)
    if (next) await showTabState($, next)
  } catch (err) {
    await logLine($, 'supervision', `tab-state: ${(err as Error).message}`)
  }
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
// repository, never a failure. Bounded (REPO_READ_MS): it runs in the pane's
// render, and a git that hangs held the render for the host's default 30 s.
// Undefined when git gave no answer — it could not run, or was ended at its bound
// before it said anything — a value the render does not keep. No origin, or no checkout, is git's
// own answer: its `error:` or `fatal:` line.
async function repoRead($: any): Promise<string | null | undefined> {
  try {
    const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: REPO_READ_MS })
    if (remote.exitCode !== 0) return /^(?:error|fatal):/m.test(String(remote.stderr ?? '')) ? null : undefined
    return /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(String(remote.stdout ?? '').trim())?.[1] ?? null
  } catch {
    return undefined
  }
}
