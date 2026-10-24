// hooks/stop-gate.ts
// The stop gate's checks over plain values, hooks/stop_gate.py ported for the
// in-process module: what will wake the orchestrator (check 1) and the real
// state of the pull requests ci-watch watched (check 2). Pure on purpose — the
// engine fences $ to the file that received it, so every read the checks pay
// happens in guards.ts's handler and its answer passes in here. The refusal
// texts are stop_gate.py's verbatim where the data source did not change
// beneath them; where it did, the change is said at the check itself.
//
// The classic events carry the settings payload's own fields beside the
// module's — the shipped types give classic.Stop the transcript path, the cwd
// and the last assistant message — so the handler reads them off the event and
// this file never waits on anything.

// --- the decision shapes -----------------------------------------------------------------

// The classic decision `{"decision":"block","reason":…}` answers through the
// module's own field: `block` carries the reason text (the shipped types'
// ClassicResult documents exactly this mapping, and "a field of the wrong
// shape fails the hook, which is skipped" — a `decision` field would let every
// stop through untold).
export function refuse(reason: string): { block: string } {
  return { block: reason }
}

// The wake decision at the summary level, the composition the done branch of
// check 1 makes when the facts disagree with the message. A busy own agent and
// a declared blocking question both RELEASE the stop — the agent's idle notice
// and the answer are what wake the orchestrator next (stop_gate.py:363-364;
// its wrapper's header names the busy agent first among the releases).
export function wakeDecision(summary: {
  busyOwnAgents: readonly string[]
  blockingQuestion: string | null
  openRows: readonly string[]
  leftBehind?: readonly string[]
}): { decision: 'pass' } | { decision: 'block'; reason: string } {
  if (summary.busyOwnAgents.length > 0) return { decision: 'pass' }
  if (summary.blockingQuestion !== null) return { decision: 'pass' }
  const left = summary.leftBehind ?? []
  const deferred = summary.openRows
  if (left.length === 0 && deferred.length === 0) return { decision: 'pass' }
  return { decision: 'block', reason: notDoneReasons(left, deferred).join(' ') }
}

// One race, the whole gate's own law: stop_gate.py runs under a single deadline
// checked between its external calls, and a read that cannot answer in time
// lets the stop pass. The degraded answer is a value told apart from the work's
// own, so the handler can say so in the log and stand down.
export type DegradedPass = { decision: 'pass'; degraded: true }
const DEGRADED: DegradedPass = { decision: 'pass', degraded: true }

export function isDegradedPass(value: unknown): value is DegradedPass {
  return typeof value === 'object' && value !== null && (value as { degraded?: unknown }).degraded === true
}

export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | DegradedPass> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<DegradedPass>((resolve) => { timer = setTimeout(() => resolve(DEGRADED), ms) })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// --- the refusal texts (stop_gate.py:126-146, verbatim) -----------------------------------

const NOTHING = 'Nothing will wake you: no agent of yours is running. Launch what you announced, '
  + 'or, if a question truly blocks, end with the line '
  + 'waiting: operator — blocks: <what it blocks>, or with waiting: done. '
  + "The line goes as the message's last line, no markup."
const MALFORMED = 'Your last line is not the machine line: end the message with the line '
  + 'waiting: operator — blocks: <what it blocks>, or with waiting: done, '
  + "as the message's last line, no markup."
const idleDelivered = (who: string) =>
  `Idle with its pull request open or merged: ${who}. Stand it down now — or, if it waits on a question you have not answered, answer it.`
const IDLE_ONE = '%s is idle: its notice was spent. Read its report or relaunch it.'
const IDLE_MANY = '%s are idle: their notices were spent. Read their reports or relaunch them.'
const QUESTION = 'Your question blocks nothing declared: advance everything that can advance; its answer will come in a later turn.'
const NOT_DONE_ONE = 'Not done: %s is still there. Finish it, or say what blocks it.'
const NOT_DONE_MANY = 'Not done: %s are still there. Finish them, or say what blocks them.'
const ROW_ONE = 'Not done: row %s is open. Dispatch it, close it, or say what blocks it.'
const ROW_MANY = 'Not done: rows %s are open. Dispatch them, close them, or say what blocks them.'
// The spec's goals (goals.md beside a registered record, read by goals.py check): done is
// measured against what the spec set out to reach, not against the plan alone.
const GOALS_OPEN = 'Not done against the spec: %s open. Dispatch the work that meets it and record its evidence '
  + '(dispatch-record.sh goals <record> met <G> --evidence …), or put it to the operator: '
  + 'waiting: operator — blocks: <G>: <what he must rule>.'
const GOALS_FAULT = 'goals.md is not a record of the spec: %s.'
// The presentation pass: the first done over a goals file's content shows the operator the
// table, because whether a piece of evidence that exists is enough is his to judge.
export const GOALS_SHOW = 'Show the operator this table, each goal with its evidence, then end on waiting: done again.'

function notDoneReasons(left: readonly string[], deferred: readonly string[],
  goals: { open: readonly string[]; faults: readonly string[] } = { open: [], faults: [] }): string[] {
  const reasons: string[] = []
  if (left.length > 0) reasons.push((left.length === 1 ? NOT_DONE_ONE : NOT_DONE_MANY).replace('%s', left.join(', ')))
  if (deferred.length > 0) reasons.push((deferred.length === 1 ? ROW_ONE : ROW_MANY).replace('%s', deferred.join(', ')))
  if (goals.open.length > 0) reasons.push(GOALS_OPEN.replace('%s', goals.open.join(', ')))
  if (goals.faults.length > 0) reasons.push(GOALS_FAULT.replace('%s', goals.faults.join('; ')))
  return reasons
}

// The machine line once normalised: the dash between « operator » and « blocks: » may
// be any a model reaches for, and the spacing around it is free. A hyphen inside the
// reason is the reason's own and is kept. A sender may mark its wait `(urgent)` after
// « operator » (URGENT_LINE tells it): the gate holds both forms alike.
export const MACHINE_LINE = /^waiting:\s*(?:operator\s*(?:\(urgent\)\s*)?(?:—|–|--|-)\s*blocks:\s*(.+)|(done))$/i
export const URGENT_LINE = /^waiting:\s*operator\s*\(urgent\)/i
// The predecessor's last word in a succession (succeed.md): the line itself, nothing else.
const HANDED_OVER = /^handed over$/i
const LOOKS_DECLARED = /\bblocks\b\W*\w/i
const MARKUP = /^[`*_ \t]+/g
const MARKUP_END = /[`*_ \t]+$/g

// normalise() ported (stop_gate.py:291-307): the message's last line as the machine
// line would read, whatever the markup a model wrote it in — backticks, bold or
// italics, a quote or a bullet mark, surrounding spaces, one trailing period.
function normalise(line: string): string {
  line = line.trim()
  for (;;) {
    const before = line
    line = line.replace(MARKUP, '').replace(MARKUP_END, '')
    if (line.startsWith('>')) line = line.slice(1)
    else if (/^[-*]\s/.test(line)) line = line.slice(1)
    else if (line.endsWith('.')) line = line.slice(0, -1)
    if (line === before) return line
  }
}

export function machineLine(message: string): string {
  const lines = message.split('\n').filter(l => l.trim() !== '')
  return lines.length > 0 ? normalise(lines[lines.length - 1]) : ''
}

// --- the launcher's listing (stop_gate.py:187-219) ---------------------------------------

export type Row = { tty: string; title: string; name: string }

// parse_row() ported: `w1/t2 | <tty> | <title> | <name>[ | self][ | hidden]`, the
// launcher's row_for. The title may carry the row's own separator and is rejoined.
function parseRow(line: string): Row | null {
  const parts = line.split(' | ')
  if (parts.length < 4) return null
  while (parts.length > 4 && (parts[parts.length - 1] === 'self' || parts[parts.length - 1] === 'hidden')) parts.pop()
  return { tty: parts[1], title: parts.slice(2, -1).join(' | '), name: parts[parts.length - 1] }
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

export type ChainEntry = { tab_id: unknown; tty: string; owner?: unknown; resident?: unknown }
export type OwnAgent = { label: string; state: 'idle' | 'busy'; tty: string }

// own_agents() ported: the chain entries this session wrote that still run an agent,
// an idle resident agent left out, and whether one such resident was seen. With no
// owner known no entry is counted — a recycled tty's occupant would be (the chain file
// outlives the session that wrote it).
export function ownAgents(rows: readonly Row[], entries: readonly ChainEntry[], owner: string,
  hostStatus: ReadonlyMap<string, 'idle' | 'busy'> = new Map()):
{ agents: OwnAgent[]; resident: boolean } {
  if (!owner) return { agents: [], resident: false }
  const byTty = new Map(rows.map(r => [r.tty, r]))
  const agents: OwnAgent[] = []
  let resident = false
  for (const entry of entries) {
    if (entry.owner !== owner) continue
    const row = byTty.get(entry.tty)
    // The host's own session status first, the title's glyph only without one: the
    // glyph lags the turn — a freshly spawned agent's tab reads ✳, idle, through its
    // first half-minute of work (measured live), and the gate refused a stop on it.
    const state = row ? (hostStatus.get(entry.tty) ?? activity(row.title)) : null
    if (state === 'idle' && entry.resident === true) {
      // Spawned with --resident: idle by design, never one to read or relaunch. Not
      // busy either: it lifts no check but the last fallback.
      resident = true
      continue
    }
    if (state) agents.push({ label: labelOf(row!), state, tty: entry.tty })
  }
  return { agents, resident }
}

// chain_read() ported over an already-read text (iterm_agent.py:1009-1020): entries
// with a tab id and a tty. One line that is no JSON empties the whole file, as the
// launcher's own read does — its writes are atomic, so a bad line means the file is
// not a chain, and the remains of a non-atomic write must not leave a stranger's
// entry anchoring the stop. An entry that parses but is no dict, or carries no tab
// id, is dropped alone.
export function chainEntries(text: string): ChainEntry[] {
  const entries: ChainEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      return []
    }
    if (entry && typeof entry === 'object' && (entry as ChainEntry).tab_id && typeof (entry as ChainEntry).tty === 'string') {
      entries.push(entry as ChainEntry)
    }
  }
  return entries
}

// --- the pull request of an idle agent (stop_gate.py:250-288) ----------------------------

// pull_request_of() ported over the answers the handler read: the branch's pull
// request, or nothing. The one gh read the shell gate paid per idle agent stays one
// read in the handler; this decides what the answer says.
export function pullRequestOf(branch: string | null, answer: string | null): { number: string; state: string } | null {
  if (!branch || !answer) return null
  try {
    const pr = JSON.parse(answer)
    if (pr === null || typeof pr !== 'object' || pr.number === undefined || pr.state === undefined) return null
    return { number: String(pr.number), state: String(pr.state) }
  } catch {
    return null
  }
}

// --- the rows and checkouts of a done message (stop_gate.py:315-353) ----------------------

// open_rows() ported over the already-read record files: `<id> (<label>)` for each
// row still open, no matter which record file carries it.
export function openRows(texts: readonly string[]): string[] {
  const rows: string[] = []
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (row && typeof row === 'object' && row.state === 'open') {
          rows.push(`${row.id} (${row.label || 'no label'})`)
        }
      } catch { /* a line that is no row: no row */ }
    }
  }
  return rows
}

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? ''
const dirname = (p: string) => p.split('/').slice(0, -1).join('/') || '/'

// project_checkouts() ported (its git and workspace reads happen in the handler):
// the checkouts workspace.sh made of the session's project, <root>/<project>/<name>.
export function projectCheckouts(top: string, listOut: string): string[] {
  const project = basename(top)
  const found: string[] = []
  for (const line of listOut.split('\n')) {
    const path = line.split(' | ', 1)[0].trim()
    if (path && path !== top && basename(dirname(path)) === project) found.push(path)
  }
  return found
}

// --- check 1 (stop_gate.py:356-392) --------------------------------------------------------

export type Held = { case: string; reason: string }

// check_wake()'s first half: everything decidable before the facts of a done message
// are read. `null` — something will wake the orchestrator — releases the stop; a
// `{ blocks }` answer is the release the machine line grants, kept for the log the
// shell gate writes (its cost figures are read there); 'read-what-is-left' hands the
// decision to the done branch, which needs the checkouts and the records.
//
// Three releases the shell gate did not know, each a state the orchestrator's own
// skill puts it in: the predecessor of a succession — its last line `handed over`, or
// a session that has handed over (`handedOver`: it spawned its successor, or asked to
// end) ending on `waiting: done`, its agents and rows now the successor's; a declared
// block, honoured before the « stand it down » refusal — an idle agent may be waiting
// on the very answer the block names; and a ci-watch this session started, still
// running (`watching`), whose exit wakes it as an agent's idle notice would.
//
// Two more, from a live succession where each side waited on the other and both were
// told nothing would wake them: a peer's idle notice the session subscribed to
// (`awaiting`: a SendMessage with notify_when_idle, its notice not arrived yet) wakes
// it as a busy agent's would; and a session that handed over is never told nothing
// will wake it — its successor's « takeover confirmed » will.
export function checkWake(facts: {
  agents: readonly OwnAgent[]
  resident: boolean
  delivered: readonly string[]
  message: string
  handedOver?: boolean
  watching?: boolean
  awaiting?: boolean
}): Held | { blocks: string } | 'read-what-is-left' | null {
  const last = machineLine(facts.message)
  const matched = MACHINE_LINE.exec(last)
  if (HANDED_OVER.test(last)) return null
  if (facts.handedOver && matched && matched[2]) return null
  if (matched && matched[1]) return { blocks: matched[1] }
  // Before every other release: neither a busy agent beside it nor a running watch lifts it.
  if (facts.delivered.length > 0) {
    return { case: 'idle-delivered', reason: idleDelivered(facts.delivered.join(', ')) }
  }
  if (facts.agents.some(a => a.state === 'busy')) return null
  if (facts.watching) return null
  if (facts.awaiting) return null
  if (matched) return 'read-what-is-left'
  if (facts.agents.length > 0) {
    const names = facts.agents.map(a => a.label).join(', ')
    return { case: 'idle-agents', reason: (facts.agents.length === 1 ? IDLE_ONE : IDLE_MANY).replace('%s', names) }
  }
  if (last.toLowerCase().startsWith('waiting') && LOOKS_DECLARED.test(last)) {
    return { case: 'malformed-machine-line', reason: MALFORMED }
  }
  if (last.toLowerCase().startsWith('waiting:') || last.endsWith('?')) {
    return { case: 'question-without-blocks', reason: QUESTION }
  }
  if (facts.resident) {
    // An idle resident agent waits on a background command of its own, and that
    // command wakes it as a running turn would: something will wake the orchestrator.
    return null
  }
  if (facts.handedOver) return null
  return { case: 'nothing-will-wake', reason: NOTHING }
}

// How long a subscription to a peer's idle notice counts as something that will wake the
// session: a notice that never comes (a peer that crashed past the host's own exit notice,
// a lost delivery) must not hold the gate open for ever. Two hours covers a takeover's
// verification and an agent's long turn.
export const NOTICE_TTL_MS = 2 * 60 * 60 * 1000

// Whether a subscription still stands at `now`: the ones past their time-to-live are
// dropped from the map as they are read.
export function awaitingAny(peers: Map<string, number>, now: number): boolean {
  for (const [peer, at] of peers) if (now - at > NOTICE_TTL_MS) peers.delete(peer)
  return peers.size > 0
}

// The ways a SendMessage target names its peer: the target as written, the name without
// its bracketed reference, and the reference alone.
function peerKeys(to: string): string[] {
  const keys = new Set<string>([to.trim()])
  const m = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(to.trim())
  if (m) {
    if (m[1]) keys.add(m[1])
    keys.add(m[2])
  }
  return [...keys].filter(k => k !== '')
}

// Whether an incoming prompt is the awaited peer's word: its message (a peer delivery) or
// its idle or exit notice (one the host queues with no stamp). Either names the peer, by
// name or by reference. The operator's own prompt is never it, and neither is a delivery
// receipt: the notice says the peer went idle or exited.
export function noticeFrom(to: string, text: string, kind: string): boolean {
  if (!peerKeys(to).some(key => text.includes(key))) return false
  if (kind === 'peer' || kind === 'peer-send-message') return true
  if (kind === 'unclassified') return /\b(?:idle|exit(?:ed|s)?)\b/i.test(text)
  return false
}

// The successor's spawn, as the session ran it through Bash: the launcher's spawn
// with --successor (its script or the python beneath it). Run without error, it is
// the hand-over the gate releases on.
export function isSuccessorSpawn(command: string): boolean {
  return /\biterm[-_]agent\.(?:sh|py)\b[^\n]*\bspawn\b[^\n]*(?:^|\s)--successor(?:\s|=|$)/m.test(command)
}

// check_wake()'s done branch, over the facts the handler read: what is left of the
// project and the rows still open. Nothing left and nothing open: the message's word
// is taken and the stop passes.
//
// The spec's goals come third: the goals each goals.md beside a registered record still
// holds open, and the faults that make the file no record of the spec (a goal met with no
// evidence on disk, one ruled out without the operator's words, a row count or a text that
// is not the spec's). goals.py check reads them, the one implementation of the grammar.
export function checkWakeDone(left: {
  agents: readonly OwnAgent[]
  checkouts: readonly string[]
  deferred: readonly string[]
  goalsOpen?: readonly string[]
  goalsFaults?: readonly string[]
}): Held | null {
  const stillThere = [...left.checkouts, ...left.agents.map(a => a.label)]
  const goals = { open: left.goalsOpen ?? [], faults: left.goalsFaults ?? [] }
  if (stillThere.length === 0 && left.deferred.length === 0 && goals.open.length === 0 && goals.faults.length === 0) return null
  return { case: 'not-done', reason: notDoneReasons(stillThere, left.deferred, goals).join(' ') }
}

// One goals.md as the gate reads it: the path, and goals.py check --json's answer.
export type GoalsReading = {
  path: string
  ok: boolean
  open: readonly string[]
  faults: readonly string[]
  notes: readonly string[]
  rows: number
  table: string
}

// goals.py check --json's answer, or null when the text is none: a reading the gate cannot
// parse is a read that failed, and lets the stop pass.
export function parseGoalsCheck(path: string, text: string): GoalsReading | null {
  try {
    const a = JSON.parse(text)
    if (!a || typeof a !== 'object' || typeof a.ok !== 'boolean' || !Array.isArray(a.open) || !Array.isArray(a.faults)) return null
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
    return {
      path, ok: a.ok, open: strings(a.open), faults: strings(a.faults), notes: strings(a.notes),
      rows: typeof a.rows === 'number' ? a.rows : 0, table: typeof a.table === 'string' ? a.table : '',
    }
  } catch {
    return null
  }
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

// The presentation pass's memory: one hash per goals.md content it showed, kept per session.
export function goalsShownPath(stateDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${stateDir}/stop-gate/${safe}.goals`
}

// The tell of the goals the operator was shown: every reading's table, hashed together.
export function goalsTell(readings: readonly GoalsReading[]): string {
  return logTell(readings.map(r => `${r.path}\n${r.table}`).join('\n').replace(/\n/g, ' '))
}

// The presentation refusal: the tables of every goals file with at least one goal, when
// their content was not shown yet. Null when there is nothing to show or it was shown.
export function presentGoals(readings: readonly GoalsReading[], shown: string): { tell: string; reason: string } | null {
  const withRows = readings.filter(r => r.rows > 0)
  if (withRows.length === 0) return null
  const tell = goalsTell(withRows)
  if (shown.split('\n').map(l => l.trim()).includes(tell)) return null
  return { tell, reason: [GOALS_SHOW, ...withRows.map(r => `${r.path}\n${r.table}`)].join('\n\n') }
}

// --- the heads record (stop_gate.py:397-435) ----------------------------------------------

// The module's own file: the shell gate keeps `<safe>.heads` for the heads gh read it,
// and the two records' head tokens are not one another's — this one tells a watch, not
// a sha (ci-watch's logs carry none). Same line format otherwise.
export function headsPath(stateDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${stateDir}/stop-gate/${safe}.mheads`
}

export type HeadEntry = readonly [tell: string, state: 'pending' | 'done', failing: ReadonlySet<string>]
export type Heads = Map<string, HeadEntry>

// read_heads() ported: per pull request number, (tell, state, failing names). A line is
// `<number> <tell> <pending|done> [<failing names, quoted, comma-joined>]`; a two-field
// line, written by the previous shape, reads as done.
export function readHeads(text: string): Heads {
  const heads: Heads = new Map()
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2 || parts.length > 4 || parts[0] === '') continue
    const state = parts.length > 2 ? parts[2] : 'done'
    if (state !== 'pending' && state !== 'done') continue
    const failing = parts.length === 4
      ? new Set(parts[3].split(',').map(n => decodeName(n)))
      : new Set<string>()
    heads.set(parts[0], [parts[1], state, failing])
  }
  return heads
}

// write_heads()'s line, over the map the check returns: numbers in numeric order, the
// failing names sorted and quoted so a name carrying the separator cannot split.
export function writeHeads(heads: Heads): string {
  const numbers = [...heads.keys()].sort((a, b) => Number(a) - Number(b))
  return numbers.map(number => {
    const [tell, state, failing] = heads.get(number)!
    let line = `${number} ${tell} ${state}`
    if (failing.size > 0) line += ' ' + [...failing].sort().map(n => encodeName(n)).join(',')
    return line + '\n'
  }).join('')
}

// The names on a heads line are percent-encoded as their UTF-8 bytes — python's
// quote(safe="")/unquote over the unreserved set: a check name carries whatever the
// forge allows, and a code point above latin-1 is several bytes that must survive the
// write/read cycle as one character, or the once-per-tell comparison reads a set that
// never equals the one it recorded and the same failing set is re-told at every stop.
const NAME_ENCODER = new TextEncoder()
const NAME_DECODER = new TextDecoder()

const encodeName = (name: string): string => {
  let out = ''
  for (const ch of name) {
    if (/[A-Za-z0-9._-]/.test(ch)) out += ch
    else for (const b of NAME_ENCODER.encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

const decodeName = (text: string): string => {
  // The escapes are collected as bytes and decoded together: one character is several
  // consecutive escapes, and taking them one at a time re-spells it wrong.
  const escaped = text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  return NAME_DECODER.decode(Uint8Array.from(escaped, ch => ch.charCodeAt(0)))
}

// --- check 2, over ci-watch's precomputed data (stop_gate.py:450-461, 537-592) -------------

// The shell gate read the pull requests and their checks from gh at the stop — a
// synchronous network call the module world refuses. ci-watch has already watched
// them: it appends `name\tbucket\telapsed\tlink` snapshots to
// `<state>/ci-watch/<slug>-pr<n>.log`, truncated at each watch's start, and that file
// is the state the check reads: the logs whose owner file names this session alone.
// Two consequences it lives with, said here: the log
// names no head sha, so the tell a head is told once for is the log's first line
// (logTell) — a new watch truncates the log, a new first line, and the telling starts
// over — and the refusal names the pull request without the sha it sat at.
export type CiWatchLog = { number: string; tell: string; checks: readonly { name: string; bucket: string }[] }

// The tell a watch is told once for: the log's first line, hashed. A watch truncates
// its log when it starts and its first snapshot carries the checks' own links — a new
// head's runs are new runs — so the first line names the watch, and stays put while the
// watch appends: the log's mtime, the tell before this one, moved every interval and
// the same failing set was refused again at every stop.
export function logTell(text: string): string {
  const first = text.split('\n').find(l => l.trim() !== '') ?? ''
  let hash = 0x811c9dc5
  for (const b of new TextEncoder().encode(first)) {
    hash ^= b
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return first ? `h${hash.toString(16).padStart(8, '0')}` : 'empty'
}

// The last bucket each check carries: a snapshot appends, so the final line of a
// check's history is its state.
export function parseCiWatchLog(text: string): Record<string, string> {
  const checks: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const parts = raw.replace(/\r$/, '').split('\t')
    if (parts.length < 2 || !parts[0]) continue
    checks[parts[0]] = parts[1]
  }
  return checks
}

// The pull request number a log name carries: `<slug>-pr<n>.log`, the base-branch
// watches of merged pull requests apart (-base, no number of their own to tell).
export function watchNumberOf(name: string): string | null {
  if (/-pr\d+-base\.log$/.test(name)) return null
  const m = /-pr(\d+)\.log$/.exec(name)
  return m ? m[1] : null
}

// watched_numbers() ported: the pull request numbers a ci-watch process is alive for.
// `ci-watch.sh <n>` as a process's command line: the script run by a shell or by its
// own path, then the number. An editor open on the script, or a `grep ci-watch.sh 12`,
// is no watch.
const WATCH_PROCESS = /^\s*(?:\S*\/)?(?:(?:bash|sh|zsh)\s+(?:-\S+\s+)*)?\S*ci-watch\.sh\s+(\d+)(?:\s|$)/

// The rows of `ps -axo pid=,ppid=,command=`: the process table with each one's parent.
export type ProcessRow = { pid: string; ppid: string; command: string }

export function processTable(out: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)/.exec(line)
    if (m) rows.push({ pid: m[1], ppid: m[2], command: m[3] })
  }
  return rows
}

// The pull request numbers a ci-watch is alive for under `hostPid`: a watch whose
// chain of parents reaches the session's own host process is one this session started
// (a background Bash command is the host's descendant), and its exit will wake it.
export function ownWatches(rows: readonly ProcessRow[], hostPid: string | null): Set<string> {
  const own = new Set<string>()
  if (!hostPid) return own
  const parent = new Map(rows.map(r => [r.pid, r.ppid]))
  for (const row of rows) {
    const number = [...watchedNumbers(row.command)][0]
    if (!number) continue
    let at: string | undefined = row.ppid
    for (let hops = 0; at && at !== '0' && at !== '1' && hops < 64; hops++) {
      if (at === hostPid) {
        own.add(number)
        break
      }
      at = parent.get(at)
    }
  }
  return own
}

export function watchedNumbers(psOut: string): Set<string> {
  const watched = new Set<string>()
  for (const line of psOut.split('\n')) {
    const m = WATCH_PROCESS.exec(line)
    if (m) watched.add(m[1])
  }
  return watched
}

const ciState = (number: string, pending: readonly string[], failing: readonly string[], watchCommand: string) =>
  `#${number}: ${pending.length} checks pending (${pending.join(', ')}), ${failing.length} failing (${failing.join(', ')}). `
  + `Report this state as it is; to wait for the end, start \`${watchCommand} ${number}\` with `
  + '`run_in_background` (timeout 7200000), never in the foreground.'

const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every(x => b.has(x))

// check_ci() ported over ci-watch's logs (stop_gate.py:537-592): the refusal lines, one
// per pull request whose head has checks pending or failing and has not been told for
// that state. A head is told once while pending, again when a check fails (once per
// failing set), and once more when it finished failing for a set not yet told; a moved
// tell starts over. A head waited on in the background is not told and not recorded, so
// a watch that dies is told once; a head whose checks are all ignored, or none read at
// all, is unread: read again at the next stop, recorded only if it already had a record.
//
// Declared deviation: the draft-guard filter is dropped. The shell gate read each
// open pull request's isDraft from gh and let a guard that fails by design while the
// request is a draft stand untold (stop_gate.py:565-567, its draft_guards at :511-534);
// a ci-watch log carries no draft flag and no local read can supply one, so inventing
// the signal would tell a red that is not one, or hide one that is. ignored-checks
// remains the operator's fallback for the drafting window: its listed name goes with
// the guard for as long as the request is a draft.
export function checkCi(input: {
  logs: readonly CiWatchLog[]
  reported: Heads
  watched: ReadonlySet<string>
  ignored: ReadonlySet<string>
  watchCommand: string
}): { lines: string[]; heads: Heads } {
  const heads: Heads = new Map()
  const lines: string[] = []
  for (const log of input.logs) {
    const recorded = input.reported.get(log.number)
    const seen = recorded && recorded[0] === log.tell ? recorded : undefined
    if (seen && seen[1] === 'done') {
      heads.set(log.number, seen)
      continue
    }
    const checks = log.checks.filter(c => !input.ignored.has(c.name))
    if (checks.length === 0) {
      // A push seen before its checks were registered, or a head whose only checks are
      // ignored ones: unread, read again at the next stop.
      if (seen) heads.set(log.number, seen)
      continue
    }
    const pending = checks.filter(c => c.bucket === 'pending').map(c => c.name)
    const failing = checks.filter(c => c.bucket === 'fail' || c.bucket === 'cancel').map(c => c.name)
    const told = seen ? seen[2] : new Set<string>()
    if (pending.length > 0 && !seen && failing.length === 0 && input.watched.has(log.number)) {
      // Waited for in the background, and woken by its end: nothing to refuse, and
      // nothing recorded.
      continue
    }
    const failingSet = new Set(failing)
    if ((pending.length > 0 && !seen) || (failing.length > 0 && !setsEqual(failingSet, told))) {
      lines.push(ciState(log.number, pending, failing, input.watchCommand))
    }
    heads.set(log.number, [log.tell, pending.length > 0 ? 'pending' : 'done', pending.length > 0 ? failingSet : new Set<string>()])
  }
  return { lines, heads }
}
