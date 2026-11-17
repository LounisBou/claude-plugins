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

import { withDeadline as cancelAtDeadline, DeadlineExceeded } from '../core/deadline.ts'
import type { ConsentSubject } from '../core/consent-record.ts'
import type { WaitKind } from '../core/orchestration.ts'
import { parseSessionName, sessionName } from '../core/names.ts'
import type { ChainEntry } from '../core/chain-entries.ts'
import type { Host } from './host.ts'

// A parsed value that holds fields: an object, an array among them.
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

// --- the decision shapes -----------------------------------------------------------------

// The classic decision `{"decision":"block","reason":…}` answers through the module's own field:
// `block` carries the reason text (the shipped types' ClassicResult documents exactly this mapping,
// and a field of the wrong shape fails the hook, which is skipped: the stop would pass untold).
export function refuse(reason: string): { block: string } {
  return { block: reason }
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
// subagent or agent of its own is read by the gate itself (checkWake), never declared.
// `urgent` marks an operator wait the coordinator presents at once (URGENT_LINE).
// consent: the subject an operator question asks his consent on (core's consent-record.ts), which the
// audit trail names.
// asked: the ids of the questions asked with `ask` (question.ts) an operator wait waits on.
export type DeclaredWait = { kind: WaitKind; blocks: string; urgent?: true; consent?: ConsentSubject; asked?: string[] }

// The one machine line a declaration spells: the form the gate's checks read a declared wait in.
// It is never taught: the model declares, and a line it writes itself decides nothing.
export function waitLine(wait: DeclaredWait): string {
  switch (wait.kind) {
    case 'operator': return `waiting: operator${wait.urgent ? ' (urgent)' : ''} — blocks: ${wait.blocks}`
    case 'deferred': return `waiting: deferred — ${wait.blocks}`
    case 'done': return 'waiting: done'
  }
}

// The sentence every refusal about the ending carries: the call that declares the wait, the only way to state one.
const DECLARE = 'Declare the wait with the `declare_wait` tool, whose description says what each kind takes: a line written in the message decides nothing.'

// --- the refusal texts (stop_gate.py:126-146, verbatim but where the declared wait changed them) -----------------------------------

// The waits that fit a turn, by what will wake it: what the two refusals below name.
const BUSY_FITS = 'An agent of yours is busy: declare no wait, its idle notice wakes you. Past its bound in one turn, the module\'s line on it does.'
const OTHER_FITS = 'If only an irreversible or outward act waits for the operator\'s answer, declare an operator wait; '
  + 'if every goal is met or ruled out, declare done; '
  + 'if the operator deferred it, his ruling recorded, declare a deferred wait; else launch what you announced.'
const runningFits = (what: readonly string[]) =>
  `${what.join(', ')} runs in the background: declare no wait, its end wakes you.`
function fits(busy: boolean, running: readonly string[]): string {
  if (running.length > 0) return runningFits(running)
  return busy ? BUSY_FITS : OTHER_FITS
}
// A turn that declared no wait with nothing in flight, no agent busy and no notice awaited.
const NOTHING = 'Nothing will wake you: nothing of yours runs in the background and no agent of yours is busy. '
  + 'Launch what you announced (an agent, or a command with run_in_background: its end wakes you, with no wait to declare), '
  + `or declare the wait that fits. ${OTHER_FITS} ${DECLARE}`
const blocksNothingReason = (busy: boolean, running: readonly string[]) =>
  'Your wait on the operator blocks nothing: that wait is for a question he must answer. '
  + `${fits(busy, running)} ${DECLARE}`
const NOT_DONE_ONE = 'Not done: %s is still there. Finish it, or say what blocks it.'
const NOT_DONE_MANY = 'Not done: %s are still there. Finish them, or say what blocks them.'
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

function notDoneReasons(left: readonly string[], deferred: readonly string[],
  goals: { open: readonly string[]; faults: readonly string[] } = { open: [], faults: [] }, where: Where = {}): string[] {
  const reasons: string[] = []
  if (left.length > 0) reasons.push((left.length === 1 ? NOT_DONE_ONE : NOT_DONE_MANY).replace('%s', left.join(', ')))
  if (deferred.length > 0) reasons.push(fill(deferred.length === 1 ? ROW_ONE : ROW_MANY, deferred, where.rows))
  if (goals.open.length > 0) reasons.push(fill(GOALS_OPEN, goals.open, where.goals))
  if (goals.faults.length > 0) reasons.push(GOALS_FAULT.replace('%s', goals.faults.join('; ')))
  return reasons
}

// The machine line once normalised: the dash between « operator » and « blocks: » may
// be any a model reaches for, and the spacing around it is free. A hyphen inside the
// reason is the reason's own and is kept. A sender may mark its wait `(urgent)` after
// « operator » (URGENT_LINE tells it): the gate holds both forms alike.
export const MACHINE_LINE = /^waiting:\s*(?:operator\s*(?:\(urgent\)\s*)?(?:—|–|--|-)\s*blocks:\s*(.+)|(done))$/i
// The ending of a turn whose only open work is work the operator deferred: his ruling is
// recorded on each row and goal (dispatch-record.sh defer, goals … defer) and the line lists
// them. It asks him nothing, so the relay never enters it.
const DEFERRED_LINE = /^waiting:\s*deferred\s*(?:—|–|--|-)\s*(.+)$/i
export function deferredIds(line: string): string | null {
  const matched = DEFERRED_LINE.exec(line)
  return matched ? (matched[1] ?? '').trim() : null
}
export const URGENT_LINE = /^waiting:\s*operator\s*\(urgent\)/i
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
// request, or nothing. The one gh read the shell gate paid per idle agent stays one
// read in the handler; this decides what the answer says.
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

// --- the rows and checkouts of a done message (stop_gate.py:315-353) ----------------------

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

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? ''
const dirname = (p: string) => p.split('/').slice(0, -1).join('/') || '/'

// project_checkouts() ported (its git and workspace reads happen in the handler):
// the checkouts workspace.sh made of the session's project, <root>/<project>/<name>.
export function projectCheckouts(top: string, listOut: string): string[] {
  const project = basename(top)
  const found: string[] = []
  for (const line of listOut.split('\n')) {
    const path = (line.split(' | ', 1)[0] ?? '').trim()
    if (path && path !== top && basename(dirname(path)) === project) found.push(path)
  }
  return found
}

// --- check 1 (stop_gate.py:356-392) --------------------------------------------------------

// The work the host itself says is in flight for the session, off the stop's own payload:
// `background_tasks` (background shells, monitors, subagents, workflows — running, pending or
// backgrounded) and `session_crons` (scheduled wake-ups), each named by what it runs. Null when
// the payload carries no task list at all — a host that does not say — so the caller can tell
// « nothing runs » from « not told ».
//
// A task the host lists as settled wakes nothing: its type only promises a string status, so
// the terminal ones it uses for its tasks (`completed`, `failed`, `killed`, and `stopped` on a
// task's end notice) are left out. Any other status, or none, still counts: a wrong list must
// never refuse a real wait. A scheduled wake-up carries no status.
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

// The ids of the open questions a turn's final text copies: a line that is its id line
// (`**Question i of N** (<id>)`) or its `_Question_ : <ask>` line, whole, a quote mark aside. A mention
// by subject, an id inside a sentence or a longer question that starts alike copies nothing. The
// caller hands only the questions asked in an earlier turn.
export function restatedQuestions(message: string, open: readonly { id: string; ask: string }[]): string[] {
  const lines = message.split('\n').map(line => line.replace(/^\s*(?:>\s*)*/, '').trim())
  return open
    .filter(q => lines.some(line => line === `_Question_ : ${q.ask}` || (line.endsWith(`(${q.id})`) && /^\**Question \d+ of \d+\b/.test(line))))
    .map(q => q.id)
}

export const restatedReason = (ids: readonly string[]): string =>
  `Already in the round (${ids.join(', ')}): name it by its subject, do not copy it.`

// A choice or a decision put to the operator in the turn's final message, in prose. The one check of
// the gate that refuses: a question asked this way is shown nowhere (no ✋, no counter) and nothing
// carries his answer back, so letting the turn end on it leaves him with a question he cannot see.
// The refusal is the gate's only one, so it is held to precision over reach: it reads the message's
// tail only, outside fenced code and quotes and without its `waiting:` line, and wants a question's
// structure and a request to rule together, each in the forward or imperative form. Either is
// (1) at least two lettered options (`(A`, `A)`, `**A**`, `option A`) and a request to rule
// (« dès que vous aurez tranché », « please choose », a recommendation inside an option's
// parentheses, or a last line that asks which), or (2) a last line that asks him « should I »,
// « voulez-vous », and the like. A report that names choices already made carries a structure and
// no request (« tranché », « chose », « recommended » alone ask nothing), and passes.
const TAIL_PARAGRAPHS = 3
const OPTION_LABELS = [
  /\(([A-D])(?=[,):.])/g,
  /(?:^|\s)([A-D])\)(?=\s)/g,
  /\*\*([A-D])\*\*/g,
  /\b(?:[Oo]ption|[Cc]hoice|[Vv]ariante)\s+([A-D])\b/g,
  /^\s*(?:[-*]\s*)?([A-D])[.:](?=\s)/gm,
]
const RULING_CUE = new RegExp([
  'aurez (?:tranché|décidé|choisi)', '(?:once|when|until) you (?:have )?(?:decide|choose|rule|pick|confirm)',
  "jusqu'à ce que vous (?:ayez )?(?:tranch|décid|chois)", 'tranchez\\b', 'choisissez\\b', 'décidez\\b',
  'please (?:choose|decide|pick|confirm)', 'à vous de (?:trancher|choisir|décider)',
  'tell me (?:which|whether)', 'dites-moi (?:lequel|laquelle|si)',
  '(?:waiting (?:for|on)|en attente de) (?:your|votre) (?:choice|decision|choix|décision)',
].join('|'), 'i')
// A recommendation written inside an option's own parentheses: « (A, que je recommande) ».
const OPTION_RECOMMENDED = /\(([A-D])\b[^)]*\b(?:que je recommande|je recommande|i recommend|which i recommend)\b/
const WHICH_QUESTION = /\b(?:which (?:one|option)|lequel|laquelle|votre choix|your choice|your call)\b/i
const ASKS_HIM = /\b(?:should i|shall i|do you want|would you like|do you prefer|want me to|dois-je|voulez-vous|souhaitez-vous|préférez-vous|veux-tu)\b/i
// A last line that reports a question someone else asked is no question of the session's own.
const REPORTED = /\b(?:asked|asks|demandé|demandait|said|dit|wrote|écrit)\b/i

function tailOf(message: string): string {
  const kept = message.replace(/```[\s\S]*?(?:```|$)/g, '').split('\n')
    .filter(line => !/^\s*>/.test(line) && !/^\s*waiting:/i.test(line)).join('\n')
  return kept.trim().split(/\n\s*\n/).slice(-TAIL_PARAGRAPHS).join('\n\n')
}

export function putsChoiceToOperator(message: string): boolean {
  const tail = tailOf(message)
  if (tail === '') return false
  const last = tail.split('\n').filter(line => line.trim() !== '').pop() ?? ''
  const asking = /\?[\s"'»)*_]*$/.test(last)
  if (asking && ASKS_HIM.test(last) && !REPORTED.test(last)) return true
  const labels = new Set(OPTION_LABELS.flatMap(pattern => [...tail.matchAll(pattern)].map(found => found[1] ?? '')))
  if (labels.size < 2) return false
  return RULING_CUE.test(tail) || OPTION_RECOMMENDED.test(tail) || (asking && WHICH_QUESTION.test(last))
}

export const PROSE_CHOICE_REASON = 'Your message puts a choice or a decision to the operator in prose, and no question of yours is open in the round: '
  + 'he is shown nothing (no ✋, no counter) and nothing will carry his answer back to you. '
  + 'Ask it with `mcp__orchestrator__ask` (its choices, your recommendation), then declare an operator wait on it. '
  + 'If it asks him nothing, end the message without the question.'

export type Held = { case: string; reason: string }

// check_wake()'s first half: everything decidable before the facts of a done message
// are read. The wait it decides on is the one the turn declared (`declared`, declare_wait):
// a turn that declared none ended on no wait, whatever its last line says. `null` — something
// will wake the orchestrator — releases the stop; a
// `{ blocks }` answer is the release the declared wait grants, kept for the log the
// shell gate writes (its cost figures are read there); 'read-what-is-left' hands the
// decision to the done branch, which needs the checkouts and the records.
//
// Three releases the shell gate did not know, each a state the orchestrator's own
// skill puts it in: the predecessor of a succession, a session that has handed over
// (`handedOver`: it spawned its successor, or asked to end) ending on a declared done,
// its agents and rows now the successor's; a declared
// block, honoured before the « stand it down » refusal — an idle agent may be waiting
// on the very answer the block names; and a ci-watch this session started, still
// running (`watching`), whose exit wakes it as an agent's idle notice would — and since,
// any command or monitor it started in the background and that still runs (`background`,
// what each runs): a monitor's events wake it too. Such a turn declares no wait: the gate
// reads what runs, and `declare_wait` is for the operator's question and the ending alone.
//
// The loop this ends: only a ci-watch counted, so a turn waiting on a monitor was refused
// every stop until it ended on a wait for the operator, and every monitor event woke a turn
// that ended on that same false wait. A wait on the operator that blocks nothing is now
// refused, and the relay never enters it.
//
// Two more, from a live succession where each side waited on the other and both were
// told nothing would wake them: a peer's idle notice the session subscribed to
// (`awaiting`: a SendMessage with notify_when_idle, its notice not arrived yet) wakes
// it as a busy agent's would; and a session that handed over is never told nothing
// will wake it — its successor's « takeover confirmed » will.
//
// A question of the session's still open in the round (`questionOpen`) wakes it too, by its
// answer: a turn that advanced other work meanwhile ends on no line, with nothing else in
// flight, and never puts the question again.
//
// An idle agent of its own whose pull request is open (`awaitingMerge`, by label) is not stood
// down: the executor lives until its pull request merges and receives the kept findings. The log
// names it apart (`awaiting-merge`), never among the idle agents, until the done line reads it. An
// open pull request is no wake source: with nothing else armed (no subscription, no watch, no task
// of the host, no open question), the turn ends on « nothing will wake you » like any other.
//
// « Nothing will wake you » is decided on the host's own word (`tasks`, hostTasks above): what
// the host holds in flight for the session is what will wake it. The process table walked by
// parent chain only adds work; when the host gives no task list the ending is only logged.
export function checkWake(facts: {
  agents: readonly OwnAgent[]
  resident: boolean
  delivered: readonly string[]
  declared?: DeclaredWait | null
  handedOver?: boolean
  watching?: boolean
  background?: readonly string[]
  awaiting?: boolean
  awaitingMerge?: readonly string[]
  tasks?: readonly string[] | null
  questionOpen?: boolean
}): Held | { blocks: string } | { warn: 'idle-delivered' | 'idle-agents' | 'awaiting-merge' | 'nothing-will-wake'; detail: string } | 'read-what-is-left' | null {
  // The wait is the one the turn declared, spelled as its line: the model's own last line decides nothing.
  const last = facts.declared ? waitLine(facts.declared) : ''
  const matched = MACHINE_LINE.exec(last)
  const busy = facts.agents.some(a => a.state === 'busy')
  const running = facts.background ?? []
  if (facts.handedOver && matched && matched[2]) return null
  // A wait on the operator that blocks nothing asks him nothing: the line that fits is named.
  if (blocksNothing(last)) return { case: 'blocks-nothing', reason: blocksNothingReason(busy, running) }
  if (matched && matched[1]) return { blocks: matched[1] }
  // Before every other release: neither a busy agent beside it nor a running watch lifts it.
  if (facts.delivered.length > 0) {
    // Measured, not refused: the log keeps who was idle with its pull request merged.
    return { warn: 'idle-delivered', detail: facts.delivered.join(', ') }
  }
  if (busy) return null
  if (facts.watching || running.length > 0) return null
  if (facts.awaiting) return null
  if (matched || deferredIds(last) !== null) return 'read-what-is-left'
  // The executor waits for its kept findings and its merge: no stand-down asked of it.
  const merging = facts.awaitingMerge ?? []
  const idle = facts.agents.filter(a => !merging.includes(a.label))
  if (idle.length > 0) {
    return { warn: 'idle-agents', detail: idle.map(a => a.label).join(', ') }
  }
  // The executor's open pull request wakes nothing by itself: it is logged apart only when
  // something else will wake the session, and otherwise the ending is judged like any other.
  const waking = (): null | { warn: 'awaiting-merge'; detail: string } =>
    merging.length > 0 ? { warn: 'awaiting-merge', detail: merging.join(', ') } : null
  // A question still open in the round: its answer wakes the session.
  if (facts.questionOpen) return waking()
  if (facts.resident) {
    // An idle resident agent waits on a background command of its own, and that
    // command wakes it as a running turn would: something will wake the orchestrator.
    return waking()
  }
  if (facts.handedOver) return waking()
  // Refused on the host's own list of work in flight; a host that sends none is only logged.
  if (facts.tasks !== undefined && facts.tasks !== null) {
    if (facts.tasks.length > 0) return waking()
    return { case: 'nothing-will-wake', reason: NOTHING }
  }
  return waking() ?? { warn: 'nothing-will-wake', detail: '' }
}

// How long a subscription to a peer's idle notice counts as something that will wake the
// session: a notice that never comes (a peer that crashed past the host's own exit notice,
// a lost delivery) must not hold the gate open for ever. Two hours covers a takeover's
// verification and an agent's long turn. The same bound holds for a busy own agent, which
// releases the stop: past it in one turn, the orchestrator is woken (busyWake below).
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
    keys.add(m[2] ?? '')
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
  agents: readonly OwnAgent[]
  checkouts: readonly string[]
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
  // The working copies are not read by session, so they only warn (the caller logs them); the agents refuse.
  const stillThere = left.agents.map(a => a.label)
  const putOff = left.deferredRows ?? []
  const rows = left.deferred.filter(row => !putOff.includes(row))
  const goals = { open: left.goalsOpen ?? [], faults: left.goalsFaults ?? [] }
  const putOffGoals = left.goalsDeferred ?? []
  const reasons = notDoneReasons(stillThere, rows, goals, { rows: left.rowRecords, goals: left.goalsRecords })
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

// One goals.md as the gate reads it: the path, and goals.py check --json's answer.
export type GoalsReading = {
  path: string
  ok: boolean
  open: readonly string[]
  deferred: readonly string[]
  faults: readonly string[]
  notes: readonly string[]
}

// goals.py check --json's answer, or null when the text is none: a reading the gate cannot
// parse is a read that failed, and lets the stop pass.
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
      ? new Set((parts[3] ?? '').split(',').map(n => decodeName(n)))
      : new Set<string>()
    heads.set(parts[0] ?? '', [parts[1] ?? '', state, failing])
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
    checks[parts[0]] = parts[1] ?? ''
  }
  return checks
}

// The pull request number a log name carries: core's, where ci-watch's log name is defined.
export { watchNumberOf } from '../core/orchestration.ts'

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
    if (m) rows.push({ pid: m[1] ?? '', ppid: m[2] ?? '', command: m[3] ?? '' })
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

// A command the host's shell runs for the session — a background Bash command, a monitor,
// a ci-watch started either way: the host wraps each in a shell that sources its snapshot
// and evals the command. The hook's own reads run outside that shell, so none is counted.
const HOST_SHELL = /\/shell-snapshots\/snapshot-/
const EVALED = /\beval '((?:[^']|'"'"'|'\\'')*)'/
const SHOWN_CAP = 80

// What a host shell runs, as the operator would read it: the evaled command, its quotes
// undone and its newlines (ps prints them \012) one space, cut past the cap.
function evaled(command: string): string {
  const m = EVALED.exec(command)
  const text = (m ? (m[1] ?? '').replace(/'"'"'|'\\''/g, "'") : command).replace(/\\012/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > SHOWN_CAP ? `${text.slice(0, SHOWN_CAP - 1)}…` : text
}

// The processes this session started in the background and that still run, each named by
// what it runs: a host shell whose chain of parents reaches the session's host process,
// and a ci-watch that does with no such shell above it (one started by other means).
// Whatever ends or speaks of them wakes the session, as a busy agent's idle notice would.
export function ownBackground(rows: readonly ProcessRow[], hostPid: string | null): string[] {
  if (!hostPid) return []
  const parent = new Map(rows.map(r => [r.pid, r.ppid]))
  const command = new Map(rows.map(r => [r.pid, r.command]))
  const ancestors = (pid: string): string[] | null => {
    const chain: string[] = []
    let at: string | undefined = parent.get(pid)
    for (let hops = 0; at && at !== '0' && at !== '1' && hops < 64; hops++) {
      if (at === hostPid) return chain
      chain.push(at)
      at = parent.get(at)
    }
    return null
  }
  const found: string[] = []
  for (const row of rows) {
    const above = ancestors(row.pid)
    if (above === null) continue
    if (HOST_SHELL.test(row.command)) {
      if (!above.some(pid => HOST_SHELL.test(command.get(pid) ?? ''))) found.push(evaled(row.command))
      continue
    }
    const number = [...watchedNumbers(row.command)][0]
    if (number && !above.some(pid => HOST_SHELL.test(command.get(pid) ?? ''))) found.push(`ci-watch.sh ${number}`)
  }
  return found
}

export function watchedNumbers(psOut: string): Set<string> {
  const watched = new Set<string>()
  for (const line of psOut.split('\n')) {
    const m = WATCH_PROCESS.exec(line)
    if (m) watched.add(m[1] ?? '')
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
