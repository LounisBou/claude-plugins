// hooks/ledger.ts
// The pull request ledger line written where the pull request is born (core's pr-ledger.ts,
// docs/contracts.md): a pull request opened through the github tool (`pr-create`) or by a Bash
// `gh pr create`, in any repository, takes its line in the dispatch record of the orchestration the
// creating session belongs to: the session's own when it is an orchestrator's, its orchestrator's
// when it is an agent's (orchestratorOn, the one mapping the relay uses). No model, no refusal, no
// gate: the call has already succeeded, so a write that fails is one log line and the answer goes on.
// A pull request of the orchestration merged or closed, wherever it was (the machine's pull request
// file, pr-file.ts), one that became Ready (the module closes its agent once done, close-agent.ts; a review session, once its round's verdict is recorded, review-close.ts), one entering the anomaly, one its agent still holds turned conflicting with its base (its agent rebases), and one whose check failed at its head (its agent fixes it), wake the orchestrator once each: the module's tick
// (guards.ts) submits the lines prWake gives, the ended lines then archived.
import { prRefsOf } from '../core/learning.ts'
import { roleOf } from '../core/names.ts'
import { agentsOf, everyAgentOf, HOLD_LABEL, isLedgerMarked, ledgerLineOf, ledgerLines, minuteOf, prKey, withLine, type LedgerLine, type Unattended } from '../core/pr-ledger.ts'
import { simpleCommands, unwrapPath } from '../core/shell.ts'
import { updateOver } from '../core/store-io.ts'
import { answerText, PULL_URL } from './audit-events.ts'
import { chainOwner, isDegradedPass, orchestrationOf, ownerOf, withDeadline } from './stop-gate.ts'
import { orchestratorOn, parseSessionRow, REFERENCED, sessionKey, storeOf } from './supervision.ts'
import { messageOf, type CatchHook, type Events, type FsEntry, type Host, type Next, type On } from './host.ts'
import { configDir, dataDir, logLine, stateDir, storeIo, writeAtomic } from './module-io.ts'
import { briefOfLaunch, dirOf, isAgent, newestLaunch, rowOfBrief, rowsOwnedBy, type HeldRow, type RecordText } from './row-owner.ts'
import { agentLine, closeFailedLine, holdsOf, mergeNowLine } from './ready-agent.ts'
import { closeAgent, closeFacts, type CloseFacts as CloseNow, type ToClose } from './close-agent.ts'
import { hasOwed, OWED_MS, owedOf, settleOwed, type Owed } from './review-close.ts'
import { chainPath, parseChain } from '../core/chain-entries.ts'
import { draftGuardArgv, parseGate, type GateCi } from '../core/ci-gate.ts'
import { parseReconcile, reconcilePath } from '../core/pr-reconcile.ts'
import { ciGatePath } from '../core/orchestration.ts'
import { GATE_CI } from './relay.ts'
import { archive, autoMergeOf, boundedReading, readOr, realOf, registered, republish } from './unattended.ts'
import type { FilePr } from './pr-file-format.ts'

// The nouns a write holds.
type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'session' | 'clock' | 'tool'>
type Call = Events['tool.call']

// The bound of one write: the lookups of the mapping and the record's lock.
export const LEDGER_BOUND_MS = 10_000

// Whether the command line runs `gh pr create`, read as the shell reads it (core's shell reader: quotes,
// heredocs, assignments, `time`, `rtk`, `sudo`, `bash -c`): the words after `gh`, past its repository
// option wherever it stands, are `pr create`. A line the reader cannot read creates nothing.
function runsPrCreate(line: string): boolean {
  try {
    return simpleCommands(line).some(command => {
      const argv = unwrapPath(command).argv
      if (!/^(.*\/)?gh$/.test(argv[0] ?? '')) return false
      const named: string[] = []
      for (let k = 1; k < argv.length && named.length < 2; k++) {
        const word = argv[k] ?? ''
        if (word === '-R' || word === '--repo') k++
        else if (!word.startsWith('-R') && !word.startsWith('--repo=')) named.push(word)
      }
      return named[0] === 'pr' && named[1] === 'create'
    })
  } catch {
    return false
  }
}

// The pull request a creation opened, from the call and its answer; null for any other call, a failed
// one, or an answer that names none. A JSON answer is read at its `html_url`, a text one at its last address, the one `gh` prints last.
export function createdPr(e: Readonly<Record<string, unknown>>, result: unknown): { repo: string; pr: number } | null {
  const opens = e['tool'] === 'mcp__github__gh' ? e['command'] === 'pr-create'
    : e['tool'] === 'Bash' && typeof e['command'] === 'string' && runsPrCreate(e['command'])
  const answer = opens ? answerText(result) : null
  if (answer === null) return null
  const last = [...(htmlUrlOf(answer) ?? answer).matchAll(new RegExp(PULL_URL, 'g'))].at(-1)
  return last?.[1] === undefined || last[2] === undefined ? null : { repo: last[1], pr: Number(last[2]) }
}

// The `html_url` of a JSON answer (the forge's pull request), so a body that names other pull requests is never read for one.
function htmlUrlOf(answer: string): string | null {
  try {
    const url = (JSON.parse(answer) as { html_url?: unknown } | null)?.html_url
    return typeof url === 'string' ? url : null
  } catch {
    return null
  }
}

// The orchestration the creating session belongs to: its session and its name. An orchestrator's own,
// an agent's orchestrator found as the relay finds it; null for any other session.
async function orchestrationOfSession($: Held, sessionId: string, row: { role: string | null; name: string | null; tty?: string | null }): Promise<{ id: string; name: string | null } | null> {
  if (row.role === 'orchestrator') return { id: sessionId, name: row.name }
  if (row.role !== 'agent' || !row.name) return null
  const to = await orchestratorOn($, row.tty ?? null, row.name, 'ledger')
  if (to === null) return null
  const store = await storeOf($)
  let id: string | null = typeof to === 'string' ? null : to.sessionId
  if (typeof to === 'string') {
    for (const entry of await $.fs.list(`${store}/sessions`).catch((): FsEntry[] => [])) {
      if (entry.kind !== 'file' || entry.name.includes('.tmp-')) continue
      const held = parseSessionRow(await readOr($, `${store}/sessions/${entry.name}`))
      if (held?.role === 'orchestrator' && held.name === to) id = entry.name
    }
  }
  if (id === null) return null
  // The session the launch record names may be any live one (a coordinator's): only an orchestrator's is an orchestration.
  const held = parseSessionRow(await readOr($, `${store}/${sessionKey(id)}`))
  return held?.role === 'orchestrator' ? { id, name: held.name } : null
}

// The records the orchestration owns that its session registered, each readable.
export async function ownRecords($: Host<'fs'>, state: string, id: string, name: string | null): Promise<string[]> {
  const own = orchestrationOf(name)
  if (own === null) return []
  const found: string[] = []
  for (const path of await registered($, state, id)) {
    if (ownerOf(await readOr($, `${path}.owner`)) === own && await $.fs.exists(path).catch(() => false)) found.push(path)
  }
  return found
}

/*
 * The row of a session the module's store holds none of yet: one that creates its pull request in its first turn, before the
 * first measure writes its row. Its name is the host's record of the session (`<config>/sessions/<pid>.json`, the name it was
 * launched with), its role that name's; its tty unknown, so its orchestrator is found by its launch record.
 */
async function launchedRow($: Held, sessionId: string): Promise<{ role: string | null; name: string; tty: null } | null> {
  const dir = `${await configDir($)}/sessions`
  for (const entry of await $.fs.list(dir).catch((): FsEntry[] => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const read: unknown = JSON.parse(await readOr($, `${dir}/${entry.name}`))
      if (typeof read !== 'object' || read === null) continue
      const { sessionId: id, name } = read as Record<string, unknown>
      if (id === sessionId && typeof name === 'string' && name.trim() !== '') return { role: roleOf(name), name, tty: null }
    } catch {
      continue
    }
  }
  return null
}

/*
 * The line of the pull request, written once into the first record the orchestration owns; none when any of its records
 * already holds one. A session of an orchestration that writes no line says why in the log; any other session (no row and
 * no host record, or of no orchestration and launched for none) is no orchestration's, and says nothing.
 */
export async function writeLine($: Held, pr: { repo: string; pr: number }, now: Date, signal: AbortSignal): Promise<void> {
  const key = prKey(pr.repo, pr.pr)
  const sessionId = await $.session.id()
  const row = parseSessionRow(await readOr($, `${await storeOf($)}/${sessionKey(sessionId)}`)) ?? await launchedRow($, sessionId)
  if (row === null) return
  const belongs = await orchestrationOfSession($, sessionId, row)
  if (belongs === null) {
    const launched = String((await $.env.get('ORCHESTRATOR_REPORTS_TO')) ?? '').trim()
    if (row.role === 'agent' && launched !== '') await logLine($, 'ledger', `no line for ${key}: ${row.name ?? sessionId} was launched for ${launched}, and no orchestrator answers for it`)
    return
  }
  const records = await ownRecords($, await dataDir($), belongs.id, belongs.name)
  const held = (text: string) => ledgerLines(text).some(line => line.repo === pr.repo && line.pr === pr.pr)
  const first = records[0]
  if (first === undefined) {
    await logLine($, 'ledger', `no line for ${key}: ${belongs.name ?? belongs.id} has registered no record it owns`)
    return
  }
  for (const path of records) {
    if (!held(await readOr($, path))) continue
    await logLine($, 'ledger', `no line for ${key}: ${path} already holds one`)
    return
  }
  const agent = (row.name ?? '').replace(REFERENCED, '').trim()
  if (agent === '' || signal.aborted) {
    await logLine($, 'ledger', `no line for ${key}: ${agent === '' ? `session ${sessionId} has no name` : 'its bound was reached'}`)
    return
  }
  const wrote = await updateOver(storeIo($), first, current =>
    current === undefined || held(current) ? undefined : withLine(current, ledgerLineOf({ repo: pr.repo, pr: pr.pr, status: 'working', agent }, now)))
  await logLine($, 'ledger', wrote === undefined ? `no line for ${key}: ${first} gone or given one meanwhile` : `the line of ${key} written in ${first}, its agent ${agent}`)
}

// Whether a reference (`name#7`, `owner/name#7`) names the merged pull request; with no repository
// known, its number alone decides.
function namesMerged(ref: string, merged: { repo: string | null; pr: number }): boolean {
  const [where = '', number = ''] = ref.toLowerCase().split('#')
  if (Number(number) !== merged.pr) return false
  if (merged.repo === null) return true
  return where.includes('/') ? where === merged.repo : where === merged.repo.split('/')[1]
}

// The open rows of a record's text that wait on the merged pull request: their blocker or their
// note names it, each with the agent its `agent` field names. A row the operator deferred has no agent to tell.
export function waitingRows(text: string, merged: { repo: string | null; pr: number }): { id: number; label: string; agent: string | null }[] {
  const found: { id: number; label: string; agent: string | null }[] = []
  for (const line of text.split('\n')) {
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row !== 'object' || row === null || isLedgerMarked(row)) continue
    const { id, label, state, blocker, note, deferred, agent: held } = row as Record<string, unknown>
    if (typeof id !== 'number' || state !== 'open' || (typeof deferred === 'string' && deferred.trim() !== '')) continue
    const said = [blocker, note].filter((part): part is string => typeof part === 'string').join(' ')
    if (!prRefsOf(said).some(ref => namesMerged(ref, merged))) continue
    const agent = typeof held === 'string' && held.trim() !== '' ? held.trim() : null
    found.push({ id, label: typeof label === 'string' ? label : '', agent })
  }
  return found
}

// The line the tick's wake on a merge carries beside it, or null when no open row waits on it.
export function mergeRelayLine(merged: { repo: string | null; pr: number }, rows: readonly { id: number; label: string; agent: string | null }[]): string | null {
  if (rows.length === 0) return null
  const named = rows.map(row => `row ${row.id}${row.label === '' ? '' : ` « ${row.label} »`}${row.agent === null ? '' : ` (${row.agent})`}`)
  return `[module] ${merged.repo ?? ''}#${merged.pr} merged; open rows waiting on it: ${named.join(', ')}. Tell each one's agent now.`
}

/*
 * The pull requests this session's own `pr-merge` merged (`<session> <repo>#<n>`, the repository lower-cased), kept
 * until the tick that tells their end: the session knows of that merge, so the bare « merged. » line is not sent to it.
 * Held beside the tick's `told` keys, in memory as they are: a restart loses both, and the line is then sent as before.
 * One a tick never reads ended (a pull request of no orchestration's ledger) stays: a few bytes per merge of the process.
 */
const mergedHere = new Set<string>()

const mergeKey = (session: string, repo: string, pr: number): string => `${session} ${prKey(repo.toLowerCase(), pr)}`

// The pull request a `pr-merge` of the github tool merged, from the call and its answer; null for any other call, a refused or failed one, or an answer that says it merged nothing.
export function mergedByCall(e: Readonly<Record<string, unknown>>, result: unknown): { repo: string; pr: number } | null {
  if (e['tool'] !== 'mcp__github__gh' || e['command'] !== 'pr-merge' || typeof e['repo'] !== 'string') return null
  const args = typeof e['args'] === 'object' && e['args'] !== null ? e['args'] as Record<string, unknown> : {}
  const pr = Number(String(args['pr'] ?? '').replace('#', ''))
  const answer = answerText(result)
  if (answer === null || !Number.isInteger(pr) || pr < 1) return null
  // The object is read up to its closing brace: the answer may carry a line after it (a notice of the forge).
  const end = answer.indexOf('}')
  if (!answer.trimStart().startsWith('{') || end < 0) return null
  try {
    return (JSON.parse(answer.slice(0, end + 1)) as { merged?: unknown } | null)?.merged === true ? { repo: e['repo'].trim(), pr } : null
  } catch {
    return null
  }
}

// The call goes through; its answer is read for a merge, remembered, and for a creation, the line written within the bound.
async function afterCall($: Held, e: Call, next: Next<Call>, now: () => Date, bound: number): Promise<unknown> {
  const result = await next(e)
  // Bookkeeping only: it never touches the answer. A tick that reads the merge before the call returns sends the bare line, as before.
  try {
    const merged = mergedByCall(e, result)
    if (merged !== null) mergedHere.add(mergeKey(await $.session.id(), merged.repo, merged.pr))
  } catch (err) {
    await logLine($, 'ledger', `a merge by this session not remembered: ${messageOf(err)}`)
  }
  const created = createdPr(e, result)
  if (created === null) return result
  try {
    const done = await withDeadline(signal => writeLine($, created, now(), signal), bound)
    if (isDegradedPass(done)) await logLine($, 'ledger', `the line of ${created.repo}#${created.pr} did not finish within ${bound} ms`)
  } catch (err) {
    await logLine($, 'ledger', `the line of ${created.repo}#${created.pr} not written: ${messageOf(err)}`)
  }
  return result
}

const net: CatchHook<Held, Call> = async ($, e, next) => {
  await logLine($, 'ledger', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
  return next(e)
}

export function register(on: On<Held>, now: () => Date = () => new Date(), bound: number = LEDGER_BOUND_MS): void {
  on('tool.call', { tool: 'mcp__github__gh' }, async ($, e, next) => afterCall($, e, next, now, bound)).catch(net)
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => afterCall($, e, next, now, bound)).catch(net)
}

// The row an agent's launch brief was printed for and that brief's directory; undefined when it names none.
export async function briefRowOf($: Held, agent: string): Promise<{ row: number; dir: string } | undefined> {
  const dir = `${await stateDir($)}/prompts`
  const launch = newestLaunch((await $.fs.list(dir).catch((): FsEntry[] => [])).map(entry => entry.name), agent)
  const brief = launch === undefined ? undefined : briefOfLaunch(await readOr($, `${dir}/${launch}`))
  const row = brief === undefined ? undefined : rowOfBrief(await readOr($, brief))
  return brief === undefined || row === undefined ? undefined : { row: Number(row), dir: dirOf(await realOf($, brief)) }
}

/*
 * The records by their real paths, each once: the brief's directory and a record registered under another spelling of it
 * (a directory reached through a link) are compared on the same side.
 */
async function realRecords($: Held, records: readonly RecordText[]): Promise<RecordText[]> {
  const found: RecordText[] = []
  for (const record of records) {
    const path = await realOf($, record.path)
    if (!found.some(one => one.path === path)) found.push({ path, text: record.text })
  }
  return found
}

// Whether a row waits on a blocker (none but `none`): a follow-up put on the agent, never the row it is working.
const blocked = (row: HeldRow, records: readonly RecordText[]): boolean => (records.find(record => record.path === row.path)?.text ?? '').split('\n').some(line => {
  try {
    const read: unknown = JSON.parse(line)
    if (typeof read !== 'object' || read === null || isLedgerMarked(read) || (read as Record<string, unknown>)['id'] !== row.id) return false
    const blocker = (read as Record<string, unknown>)['blocker']
    return typeof blocker === 'string' && blocker.trim() !== '' && blocker.trim().toLowerCase() !== 'none'
  } catch {
    return false
  }
})

// Whether a record's text holds the row of that id, open or closed.
const holdsRow = (text: string, id: number): boolean => text.split('\n').some(line => {
  try {
    const row: unknown = JSON.parse(line)
    return typeof row === 'object' && row !== null && !isLedgerMarked(row) && (row as Record<string, unknown>)['id'] === id
  } catch {
    return false
  }
})

/*
 * The open rows whose `agent` field names the agent (`dispatch-record.sh agent`) besides its own:
 * another subject it was put on, which keeps it open at the Ready or the merge of its pull request. Its own row is the
 * one its brief was printed for, as the takeover reads it (in the record beside that brief, else of that id in any
 * record); an agent whose brief names no row owns the one row that names it and waits on no blocker (one that waits is a
 * follow-up), and of several, none is told apart.
 */
async function otherRowsOf($: Held, agent: string, records: readonly RecordText[]): Promise<HeldRow[]> {
  const bound = await briefRowOf($, agent)
  const named = rowsOwnedBy(agent, undefined, records)
  const own = bound !== undefined ? rowsOwnedBy(agent, bound, records) : named.length === 1 && !blocked(named[0]!, records) ? named : []
  return named.filter(row => !own.some(mine => mine.path === row.path && mine.id === row.id))
}

/*
 * How many ticks in a row a close may wait on a fact that is no work of the agent's (its host busy or unread while its tab is
 * idle, `stuck`) before the orchestrator is told, once, to close it itself: a quarter of an hour at one tick a minute
 * (PR_FILE_INTERVAL_MS). Counted by orchestrator session and agent, in memory as the merges this session made are.
 */
export const STUCK_TICKS = 15
const stuckTicks = new Map<string, number>()

// The line that tells the orchestrator a close the module could not make within STUCK_TICKS.
export function stuckLine(agent: string, session: string | undefined, why: string): string {
  return `[module] ${agent} still open after ${STUCK_TICKS} ticks (${why}): close it yourself (session ${session ?? '?'}, resumable within the hour).`
}

// The agents of a closed row the backstop told left open, once each, by orchestrator session, agent and row.
const toldClosedRows = new Set<string>()

// The state of the row of that id in a record's text, or undefined when it holds none.
const rowState = (text: string, id: number): unknown => {
  let state: unknown
  for (const line of text.split('\n')) {
    try {
      const row: unknown = JSON.parse(line)
      if (typeof row === 'object' && row !== null && !isLedgerMarked(row) && (row as Record<string, unknown>)['id'] === id) state = (row as Record<string, unknown>)['state']
    } catch {
      continue
    }
  }
  return state
}

/*
 * The closed row an agent was put on, when its work there is over: the row its brief was printed for, in the record beside
 * that brief (else that id in the records of the orchestration), closed; for an agent whose brief names no row, the rows that
 * name it in their `agent` field, all closed. Undefined while any of them is open, or when none is found.
 */
async function closedRowOf($: Held, agent: string, records: readonly RecordText[]): Promise<HeldRow | undefined> {
  const bound = await briefRowOf($, agent)
  if (bound !== undefined) {
    const beside = records.filter(record => dirOf(record.path) === bound.dir && rowState(record.text, bound.row) !== undefined)
    const found = beside.length > 0 ? beside : records.filter(record => rowState(record.text, bound.row) !== undefined)
    const closed = found.filter(record => rowState(record.text, bound.row) === 'closed')
    return found.length > 0 && closed.length === found.length ? { path: closed[0]!.path, id: bound.row } : undefined
  }
  const named: HeldRow[] = []
  for (const record of records) {
    for (const line of record.text.split('\n')) {
      try {
        const row: unknown = JSON.parse(line)
        if (typeof row !== 'object' || row === null || isLedgerMarked(row)) continue
        const { id, state, agent: held } = row as Record<string, unknown>
        if (typeof id !== 'number' || !isAgent(held, agent)) continue
        if (state !== 'closed') return undefined
        named.push({ path: record.path, id })
      } catch {
        continue
      }
    }
  }
  return named[0]
}

// Whether one of these agents stands on a closed row (closedRowOf): the backstop's need, which arms the tick at the turn end with no line.
export async function onClosedRow($: Held, agents: readonly string[], records: readonly RecordText[]): Promise<boolean> {
  const real = await realRecords($, records)
  for (const agent of agents) if (await closedRowOf($, agent, real) !== undefined) return true
  return false
}

// What is told of a pull request's end to an agent of its line, once: a refusal to close it.
const refusedKey = (pk: string, agent: string): string => `${pk} ended refused ${agent}`

// What is told of a Ready head to an agent of its line, once.
const readyKey = (pk: string, head: string, agent: string): string => `${pk} ready ${head} ${agent}`

// How a held row is named in a line.
const rowName = (row: HeldRow): string => `row ${row.id} (${dirOf(row.path).split('/').pop()})`

/** What the module does with an agent done with a pull request that holds nothing else, read on facts (close-agent.ts). */
type Act = { kind: 'close'; session: string; target: ToClose } | { kind: 'refused' | 'later'; why: string; session?: string | undefined; stuck?: true } | { kind: 'gone' }

// A tty as the chains and the listing may spell it, `/dev/ttys001` or `ttys001`.
const bareTty = (tty: string): string => tty.replace(/^\/dev\//, '')

/** This orchestration's chain: the ttys of its agents, or why it cannot be read now (`later`) or ever (`refused`). */
type Chain = { ttys: ReadonlySet<string> } | { kind: 'refused' | 'later'; why: string }

/*
 * The ttys of this orchestration's agents: the entries of the launcher's chain under the session's own tty that this
 * session wrote (its chain owner, the rule of the turn end and the pane). A chain owner unknown refuses every close,
 * as the turn end counts no entry then; a tty or a chain unread waits for a later tick; both are logged.
 */
async function chainTtys($: Held): Promise<Chain> {
  const owner = await chainOwner($)
  if (!owner) {
    await logLine($, 'ledger', 'no chain owner (ITERM_SESSION_ID, or TMUX and TMUX_PANE, unset): no agent is closed')
    return { kind: 'refused', why: 'this session has no chain owner (ITERM_SESSION_ID, or TMUX and TMUX_PANE, unset)' }
  }
  const tty = parseSessionRow(await readOr($, `${await storeOf($)}/${sessionKey(await $.session.id())}`))?.tty
  if (!tty) {
    await logLine($, 'ledger', "the session's tty unread: its chain is read at a later tick")
    return { kind: 'later', why: "this session's tty unread" }
  }
  let text: string
  try {
    text = String(await $.fs.read(chainPath(await dataDir($), tty)))
  } catch (err) {
    if (/ENOENT/.test(messageOf(err))) text = ''
    else {
      await logLine($, 'ledger', `the chain of ${tty} unread: ${messageOf(err)}`)
      return { kind: 'later', why: `the chain of ${tty} unread` }
    }
  }
  return { ttys: new Set(parseChain(text).filter(entry => entry.owner === owner).map(entry => bareTty(entry.tty))) }
}

/*
 * The module's act on such an agent: the session on the tab of this orchestration's chain (`chain`; the listing is the
 * machine's, where another orchestration's agent may bear the same name) the launcher lists idle, closed when the facts
 * allow it, its cost on the row its brief was printed for, in the record beside that brief. An agent whose tab is not
 * idle, or with no session row on that tty, waits for a later tick; one with no tab on the chain is not this
 * orchestration's to close, told once.
 */
async function closeOf($: Held, agent: string, records: readonly RecordText[], tabs: ReadonlyMap<string, readonly { tty: string; idle: boolean }[]>, chain: () => Promise<Chain>, ended: boolean, review?: Owed, read = false): Promise<Act> {
  const listed = tabs.get(agent) ?? []
  // A session the launcher's listing, read, no longer shows is gone: closed already, by hand or otherwise.
  if (listed.length === 0) return read ? { kind: 'gone' } : { kind: 'later', why: 'the launcher does not list it idle' }
  const own = await chain()
  if (!('ttys' in own)) return own
  const ours = listed.filter(tab => own.ttys.has(bareTty(tab.tty)))
  if (ours.length === 0) return { kind: 'refused', why: `its tab on ${listed.map(tab => tab.tty).join(', ')} is on no chain of this orchestration` }
  const tty = ours.find(tab => tab.idle)?.tty
  if (tty === undefined) return { kind: 'later', why: 'the launcher does not list it idle' }
  const session = await sessionOf($, agent, tty)
  if (session === undefined) return { kind: 'later', why: `no session row of it on ${tty}`, stuck: true }
  const bound = await briefRowOf($, agent)
  const record = bound === undefined ? undefined : records.find(r => dirOf(r.path) === bound.dir && holdsRow(r.text, bound.row))
  // A review session's cost goes on the row its verdict counted (review-close.ts); its brief names no row.
  const cost = review !== undefined ? review.cost : bound === undefined || record === undefined ? undefined : { record: record.path, row: bound.row }
  const target = { agent, tty, session, ended, cost }
  const facts = await closeFacts($, target)
  return facts.kind === 'close' ? { kind: 'close', session, target } : { ...facts, session }
}

// The session id of the agent a line names, from its row in the module's store: the newest row of that name, on that tty when one is given.
async function sessionOf($: Held, agent: string, tty?: string): Promise<string | undefined> {
  const store = await storeOf($)
  let found: { id: string; at: string } | undefined
  for (const entry of await $.fs.list(`${store}/sessions`).catch((): FsEntry[] => [])) {
    if (entry.kind !== 'file' || entry.name.includes('.tmp-')) continue
    const held = parseSessionRow(await readOr($, `${store}/sessions/${entry.name}`))
    if (held?.role !== 'agent' || (held.name ?? '').replace(REFERENCED, '').trim() !== agent) continue
    if (tty !== undefined && bareTty(held.tty ?? '') !== bareTty(tty)) continue
    if (found === undefined || held.updated_at > found.at) found = { id: entry.name, at: held.updated_at }
  }
  return found?.id
}

/*
 * The line a pull request of the orchestration turned conflicting with its base wakes its orchestrator
 * with, as a merge does: its agent named to rebase it (references/rebase.md), or none on it.
 */
export function conflictLine(c: { repo: string; pr: number; base: string; agent?: string | undefined; session?: string | undefined }): string {
  const who = c.agent === undefined ? 'no agent on it, put one to rebase it'
    : `its agent ${c.agent}${c.session === undefined ? '' : ` (session ${c.session})`}, rebase it`
  return `[module] ${prKey(c.repo, c.pr)} is conflicting with its base ${c.base === '' ? '?' : c.base}: ${who} (references/rebase.md).`
}

// The key a conflict is told under: once per head and base head.
const conflictKey = (key: string, pr: FilePr): string => `${key} conflict ${pr.sha} ${pr.baseSha ?? ''}`

// The gate's reading ci-watch or this tick kept for a pull request (core's ciGatePath), or null: none, or one unreadable.
async function keptGateOf($: Held, state: string, pr: FilePr): Promise<GateCi | null> {
  const text = await readOr($, ciGatePath(state, pr.repo, String(pr.pr)))
  return text === '' ? null : parseGate(text)
}

const atHead = (gate: GateCi | null, pr: FilePr): gate is GateCi => gate !== null && gate.head?.toLowerCase() === pr.sha.toLowerCase()

// The base branch the kept reading was taken against (its `base`), or undefined: a reading that names none.
function baseOfGate(gate: GateCi): string | undefined {
  try {
    const base = (JSON.parse(gate.raw) as { readonly base?: unknown } | null)?.base
    return typeof base === 'string' ? base : undefined
  } catch {
    return undefined
  }
}

/*
 * A reading the gate will not change at its head and base: it needs no new read. `NONE` and `PENDING` may still become a
 * verdict, and a base retargeted since the reading (the forge's listing and the kept reading both name one, and they differ)
 * changes what the gate says of the same head, so it is read once more. A side that names no base leaves the reading as it is.
 */
function isVerdict(gate: GateCi | null, pr: FilePr): boolean {
  if (!atHead(gate, pr) || (gate.result !== 'SUCCESS' && gate.result !== 'FAILURE')) return false
  const kept = baseOfGate(gate)
  return pr.base === undefined || kept === undefined || kept === pr.base
}

/*
 * The gate's reading kept for each open pull request of the orchestration, taken from github's reconciler (core's
 * pr-reconcile.ts), which reads the gate once each time what it reads changes: kept when the reconciler holds a reading
 * at the pull request's head and base and the kept one is missing, of another head or base, or not yet a verdict. No forge call here.
 */
async function refreshGates($: Held, open: readonly FilePr[]): Promise<void> {
  const state = await dataDir($)
  const config = await configDir($)
  for (const pr of open) {
    const kept = await keptGateOf($, state, pr)
    if (isVerdict(kept, pr)) continue
    const text = await readOr($, reconcilePath(config, pr.repo, pr.pr))
    const reading = parseReconcile(text)
    // A reading of another head, or taken against another base than the forge lists, waits for the reconciler's next.
    if (reading?.head !== pr.sha.toLowerCase() || (pr.base !== undefined && reading.base !== pr.base) || kept?.raw === text) continue
    try {
      await writeAtomic($, ciGatePath(state, pr.repo, String(pr.pr)), text)
    } catch (err) {
      await logLine($, 'ledger', `ci gate of ${prKey(pr.repo, pr.pr)} not kept: ${messageOf(err)}`)
    }
  }
}

// The bound of a draft guard's classification.
const CI_GUARD_MS = 30_000

// A draft's failed checks without its draft guards (a job that fails on purpose while the pull request is a draft), by
// `draft-guard.sh`, the classification `ci-watch` reads too. A classification that cannot be read keeps every failed check:
// a red is reported, never lost.
async function withoutGuards($: Held, gate: GateCi, pr: FilePr): Promise<readonly string[]> {
  try {
    const ran = await $.process.run(draftGuardArgv($.plugin.root, pr.repo, String(pr.pr)), { stdin: gate.raw, timeoutMs: CI_GUARD_MS })
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`)
    return ran.stdout.split('\n').map(name => name.trim()).filter(name => name !== '')
  } catch (err) {
    await logLine($, 'ledger', `draft guards of ${prKey(pr.repo, pr.pr)} not classified: ${messageOf(err)}`)
    return gate.failed
  }
}

// The checks a line names: the first few, the rest counted.
const CHECKS_NAMED = 5
// A check's name is its workflow author's: one line, no control character, cut short, so it forges no line of the wake.
const CHECK_NAME_MAX = 80
const nameText = (name: string): string => name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, CHECK_NAME_MAX)
const checksText = (failed: readonly string[]): string => {
  const names = failed.map(nameText).filter(name => name !== '')
  return names.length === 0 ? 'a check' : names.length <= CHECKS_NAMED ? names.join(', ') : `${names.slice(0, CHECKS_NAMED).join(', ')} (+${names.length - CHECKS_NAMED})`
}

// A recorded wait is told as the operator's record words it: one line, no control character.
const waitText = (on: string | undefined): string => (on ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()

/*
 * The line a pull request of the orchestration whose check failed at its head wakes its orchestrator with, as a conflict
 * does: the failed checks named, its agent to be told, or none on it. With no agent, a line waiting on something names that wait.
 */
export function ciFailingLine(c: { repo: string; pr: number; head: string; failed: readonly string[]; agent?: string | undefined; session?: string | undefined; waits?: string | undefined }): string {
  const wait = waitText(c.waits)
  const who = c.agent !== undefined ? `dis-le à son agent ${c.agent}${c.session === undefined ? '' : ` (session ${c.session})`}`
    : wait !== '' ? `attend ${wait}`
    : 'personne n\'y travaille, mets-y un agent'
  return `[module] ${prKey(c.repo, c.pr)} CI en échec à ${c.head.slice(0, 7)} : ${checksText(c.failed)} ; ${who}.`
}

// The key a failing check is told under: once per head.
const ciFailingKey = (key: string, pr: FilePr): string => `${key} ci-failing ${pr.sha}`
// The key of a draft's failure that was only its draft guards, decided once per head: it is told nothing, and read again as a pull request out of draft.
const ciGuardKey = (key: string, pr: FilePr): string => `${key} ci-guard ${pr.sha}`

// The key an anomaly is told under: by its cause, so one told without an agent is told again on turning conflicting.
const anomalyKey = (u: Unattended): string => u.conflict ? `${prKey(u.repo, u.pr)} anomaly conflict` : prKey(u.repo, u.pr)

// The line a pull request entering the anomaly wakes its orchestrator with.
export function anomalyLine(u: Unattended): string {
  return `[module] ${prKey(u.repo, u.pr)} en anomalie (${u.conflict ? 'en conflit' : `sans agent depuis ${minuteOf(u.since)}`}) — reattach an agent, refresh its wait, or ask`
}

/*
 * The orchestrator's wake on its pull requests, read in the machine's file (no forge call of its own
 * beyond the file's refresh): a line for each pull request merged or closed, with the open rows waiting
 * on a merged one (mergeRelayLine), one for each entering the anomaly, and one for each turned conflicting
 * with its base that the anomaly does not say (conflictLine, once per head and base head), and one for each whose check failed
 * at its head (ciFailingLine, once per head; its CI gate reading refreshed here, refreshGates), each once (`told`, what
 * was told, updated here: one that leaves the anomaly is dropped, so a re-entry is told again). The agent of a
 * pull request Ready or ended that holds nothing else is closed here once done (closeOf), and the act told. `settle`,
 * once the wake is delivered, reads the facts again and closes those agents (one left open is told at the next tick),
 * then archives the ended lines, but those whose agent's close waits; `watching`, whether a
 * line is still open, a close waits or a reader wants the file: the tick keeps it current while one holds; `moved`, whether the session's row
 * took new pull requests from this reading, which the deck and the remote row are then told (guards.ts).
 * A reading that failed tells nothing and keeps watching.
 */
export async function prWake($: Held, told: Set<string>, now: number = Date.now()): Promise<{ lines: string[]; watching: boolean; moved: boolean; settle: () => Promise<void> }> {
  const reading = await boundedReading($, await $.session.id(), now)
  if (reading === null) return { lines: [], watching: true, moved: false, settle: async () => undefined }
  const records = await realRecords($, reading.records)
  // The row's pull requests follow the forge between turn ends: a session waiting on the operator's merge takes no turn.
  const moved = await republish($, await $.session.id(), reading).catch(async err => { await logLine($, 'ledger', `row not republished: ${messageOf(err)}`); return false })
  const lines: string[] = []
  // A close that failed after the wake that said it: told now.
  for (const key of [...told].filter(key => key.startsWith('owed '))) {
    told.delete(key)
    lines.push(key.slice('owed '.length))
  }
  // What is told now: the anomalies and the ended pull requests, the latter keyed apart so an
  // archive that failed is not told again at every tick; what is no longer either is dropped.
  // The reading holds only the orchestration's own pull requests: one no record names is nobody's.
  const anomalies = reading.list.filter(u => u.waits === undefined)
  // A conflict the anomaly does not already say: the pull request its agent still works on, or a fresh wait holds;
  // one the operator parked is his; one a file written before the base was read waits for its next refresh.
  // What was told of a head and base head is kept while the forge does not read it mergeable: still computing
  // (`UNKNOWN`, after its base moved), or in the anomaly for a while.
  const inAnomaly = new Set(anomalies.map(u => prKey(u.repo, u.pr)))
  const parked = new Set(reading.kept.filter(line => line.status === 'parked').map(line => prKey(line.repo, line.pr)))
  const conflicts = [...reading.forge].filter(([key, pr]) => pr.mergeable === 'CONFLICTING' && pr.baseSha !== undefined && !inAnomaly.has(key) && !parked.has(key))
  const unmerged = [...reading.forge].filter(([, pr]) => pr.mergeable !== 'MERGEABLE')
  // A check failed at the head of an open pull request, from the gate's reading kept for it (refreshed here when it is not a verdict):
  // told once per head, whatever the pull request's mergeability, and kept told while the head stands.
  const open = [...reading.forge.values()].filter(pr => pr.state === 'OPEN' && pr.sha !== '')
  await refreshGates($, open)
  const state = await dataDir($)
  const failing: { pr: FilePr; gate: GateCi; names: readonly string[] }[] = []
  for (const pr of open) {
    const gate = await keptGateOf($, state, pr)
    if (!atHead(gate, pr) || GATE_CI.get(gate.result) !== 'failing') continue
    const key = prKey(pr.repo, pr.pr)
    if (told.has(ciFailingKey(key, pr)) || (pr.draft && told.has(ciGuardKey(key, pr)))) continue
    const names = pr.draft ? await withoutGuards($, gate, pr) : gate.failed
    if (names.length > 0 || !pr.draft) failing.push({ pr, gate, names })
    else told.add(ciGuardKey(key, pr))
  }
  // A file a session of an earlier version refreshed reads no base: what was told of the head stays, whatever its base head.
  const unmergedKeys = unmerged.flatMap(([key, pr]) => pr.baseSha !== undefined ? [conflictKey(key, pr)]
    : [...told].filter(toldKey => toldKey.startsWith(`${key} conflict ${pr.sha} `)))
  // An anomaly keeps its bare key while it lasts, and its conflict key while the forge does not read it mergeable:
  // still computing after its base moved, it is not told again without an agent, then again in conflict.
  const anomalyKeys = anomalies.flatMap(u => reading.forge.get(prKey(u.repo, u.pr))?.mergeable === 'MERGEABLE'
    ? [prKey(u.repo, u.pr)] : [prKey(u.repo, u.pr), `${prKey(u.repo, u.pr)} anomaly conflict`])
  // What was told of a Ready head to each agent of an open line stays while the pull request carries that head Ready.
  const readyAgentKeys = reading.kept.flatMap(line => {
    const key = prKey(line.repo, line.pr)
    const head = reading.readyHeads.get(key)
    return head === undefined ? [] : everyAgentOf(line).map(agent => readyKey(key, head, agent))
  })
  const current = new Set([...anomalyKeys, ...reading.ended.flatMap(e => [`${prKey(e.line.repo, e.line.pr)} ended`, ...everyAgentOf(e.line).map(agent => refusedKey(prKey(e.line.repo, e.line.pr), agent))]),
    ...[...reading.readyHeads].map(([key, sha]) => `${key} ready ${sha}`), ...readyAgentKeys,
    ...unmergedKeys, ...open.flatMap(pr => [ciFailingKey(prKey(pr.repo, pr.pr), pr), ciGuardKey(prKey(pr.repo, pr.pr), pr)])])
  // A repository the file could not read this time keeps what was told of it: no wake again on its return.
  const unread = (key: string): boolean => reading.unread.some(repo => key.startsWith(`${repo}#`))
  for (const key of [...told]) if (!current.has(key) && !unread(key)) told.delete(key)
  const session = await $.session.id()
  const waitingOn = (ended: (typeof reading.ended)[number]) => ended.state === 'MERGED'
    ? reading.records.flatMap(record => waitingRows(record.text, { repo: ended.line.repo.toLowerCase(), pr: ended.line.pr }))
    : []
  // The ended lines whose agent's close waits for a later tick: kept out of the archive, and the tick kept running.
  const waiting = new Set<string>()
  // One act per agent and tick: an agent done with two pull requests is closed once, both told. The closes run once
  // the wake that says them is delivered (`settle`), on facts read again then; one that fails then is told at the next
  // tick (`owed …` in `told`). Each close keeps what it was said for: the Ready keys and the ended lines to retry.
  const acts = new Map<string, Act>()
  const closes = new Map<string, { agent: string; key: string; target: ToClose; ready: string[]; ended: string[]; reviews: Owed[] }>()
  let chain: Promise<Chain> | undefined
  const ownChain = (): Promise<Chain> => (chain ??= chainTtys($).catch((err: unknown): Chain => ({ kind: 'later', why: `the chain unread: ${messageOf(err)}` })))
  const actOn = async (agent: string, key: string, what: string, at: { ready?: string; ended?: string; review?: Owed }): Promise<{ act: Act; said: string | null }> => {
    const fresh = !acts.has(agent)
    const act = acts.get(agent) ?? await closeOf($, agent, records, reading.tabs, ownChain, at.ended !== undefined || at.review !== undefined, at.review, reading.listed === true)
    acts.set(agent, act)
    // A close that waits on what is no work of the agent's, tick after tick, is told once at the bound, by name and session.
    const stuckKey = `${session} ${agent}`
    if (fresh && act.kind === 'later' && act.stuck === true) {
      const ticks = (stuckTicks.get(stuckKey) ?? 0) + 1
      stuckTicks.set(stuckKey, ticks)
      if (ticks === STUCK_TICKS) {
        lines.push(stuckLine(agent, act.session, act.why))
        await logLine($, 'ledger', `the close of ${agent} waited ${STUCK_TICKS} ticks (${act.why}): the orchestrator told`)
      }
    } else if (fresh) stuckTicks.delete(stuckKey)
    if (act.kind === 'close') {
      const close = closes.get(agent) ?? { agent, key, target: act.target, ready: [], ended: [], reviews: [] }
      if (at.ready !== undefined) close.ready.push(at.ready)
      if (at.ended !== undefined) close.ended.push(at.ended)
      if (at.review !== undefined) close.reviews.push(at.review)
      closes.set(agent, close)
    }
    const said = act.kind === 'close' ? agentLine({ key, what, agent, session: act.session })
      : act.kind === 'refused' ? agentLine({ key, what, agent, open: act.why }) : null
    return { act, said }
  }
  // The review sessions of a round whose verdict is recorded (review-close.ts) are closed like an agent at Ready, before the lines
  // that name an agent: once, on the facts. The verdict's answer said it, so only a refusal or a failure is told, at its tick.
  for (const one of owedOf(session)) {
    if (now - one.at > OWED_MS) {
      settleOwed(one)
      await logLine($, 'ledger', `the close of ${one.agent} owed at the verdict of ${one.round} given up: its session stayed busy or was gone`)
      continue
    }
    const { act } = await actOn(one.agent, one.round, 'verdict', { review: one })
    if (act.kind === 'gone') {
      settleOwed(one)
      await logLine($, 'ledger', `the close of ${one.agent} owed at the verdict of ${one.round}: its session is gone already, counted closed`)
    } else if (act.kind === 'refused') {
      settleOwed(one)
      lines.push(closeFailedLine(one.agent, one.round, `left open: ${act.why}`))
    }
  }
  for (const ended of reading.ended) {
    const pk = prKey(ended.line.repo, ended.line.pr)
    const first = !told.has(`${pk} ended`)
    told.add(`${pk} ended`)
    const { repo, pr } = ended.line
    const what = ended.state === 'MERGED' ? 'merged' : 'closed unmerged'
    // Its agents are named only while they run (the launcher's listing, where a close ends them): the one put on it last
    // and each one put on it before, each closed by the module when it holds nothing else, told when it does.
    const said: string[] = []
    for (const agent of everyAgentOf(ended.line).filter(name => reading.live.has(name))) {
      const holds = [
        ...new Set((await otherRowsOf($, agent, records)).map(rowName)),
        ...reading.kept.filter(line => agentsOf(line).includes(agent)).map(line => prKey(line.repo, line.pr)),
      ]
      if (holds.length > 0) {
        if (first) said.push(agentLine({ key: pk, what, agent, holds }))
        continue
      }
      const { act, said: acted } = await actOn(agent, pk, what, { ended: pk })
      if (act.kind === 'later') waiting.add(pk)
      // A refusal is told once; a close waiting on the agent is said with the merge itself.
      const refused = refusedKey(pk, agent)
      const line = act.kind === 'later' ? (first ? agentLine({ key: pk, what, agent, waits: act.why }) : null)
        : act.kind === 'refused' && told.has(refused) ? null : acted
      if (act.kind === 'refused') told.add(refused)
      if (line !== null) said.push(line)
    }
    // The bare line tells a session nothing of a merge it made itself through pr-merge: left out, the agent and relay lines stay.
    const own = mergedHere.delete(mergeKey(session, repo, pr)) && ended.state === 'MERGED'
    lines.push(...said.length === 0 && first && !own ? [`[module] ${pk} ${what}.`] : said)
    const relay = first ? mergeRelayLine({ repo, pr }, waitingOn(ended)) : null
    if (relay !== null) lines.push(relay)
  }
  // A Ready pull request's agents are done with it: each acted on once per Ready head, so an agent resumed for a fix is closed again only
  // at the next head; one not done yet is tried again at the next tick. One the forge reads conflicting is no longer ready to merge.
  // An agent that holds another pull request, or a row naming it in its `agent` field besides the row of its brief, is told, not closed.
  // github's list is read with the pull requests; a Ready pull request told with that list empty (a file refresh that failed leaves
  // the readings behind its labels, a list that did not answer) asks it once more, here, before its line is said.
  let again: Promise<ReadonlySet<string>> | undefined
  for (const line of reading.atReady) {
    if (reading.forge.get(prKey(line.repo, line.pr))?.mergeable === 'CONFLICTING') continue
    const pk = prKey(line.repo, line.pr)
    const head = reading.readyHeads.get(pk) ?? ''
    // The agent put on it last that still runs, and each one put on it before, as a merge names them.
    const agents = everyAgentOf(line).filter(name => reading.live.has(name))
    for (const agent of agents.length > 0 ? agents : [line.agent ?? '']) {
      const key = readyKey(pk, head, agent)
      if (told.has(key)) continue
      const holds = [...new Set((await otherRowsOf($, agent, records)).map(rowName)), ...holdsOf(reading.kept, other => other === agent, key => reading.readyHeads.has(key))]
      const said = holds.length > 0 ? agentLine({ key: pk, what: 'is Ready', agent, holds }) : (await actOn(agent, pk, 'is Ready', { ready: key })).said
      if (said === null) continue
      told.add(key)
      // In a repository github's auto-merge list names, the merge is this orchestrator's own: unless the operator holds it (On Hold is his pause).
      // Said with the first agent's line of this head, not again with the next.
      const held = (reading.forge.get(pk)?.labels ?? []).some(name => name.trim().toLowerCase() === HOLD_LABEL.toLowerCase())
      const merging = !told.has(`${pk} ready ${head}`) && !held
      told.add(`${pk} ready ${head}`)
      const autoMerge = !merging ? new Set<string>() : reading.autoMerge.size > 0 ? reading.autoMerge : await (again ??= autoMergeOf($))
      lines.push(autoMerge.has(line.repo.toLowerCase()) ? `${said} ${mergeNowLine(pk)}` : said)
    }
  }
  /*
   * The backstop, whatever the ledger says: an agent of this orchestration's chain, idle, whose row is closed (closedRowOf) and that
   * holds no other row and no working line, is closed as at Ready, once done. One left open is told once.
   */
  const chained = reading.listed === true && reading.tabs.size > 0 ? await ownChain() : undefined
  const ttys = chained !== undefined && 'ttys' in chained ? chained.ttys : new Set<string>()
  // What keeps the tick for the backstop, no line needed: a chain read later, or an agent of it on a closed row not yet closed nor refused.
  let backstop = chained !== undefined && 'kind' in chained && chained.kind === 'later'
  for (const [agent, tabs] of reading.tabs) {
    const ours = tabs.filter(tab => ttys.has(bareTty(tab.tty)))
    if (acts.has(agent) || ours.length === 0) continue
    const row = await closedRowOf($, agent, records)
    if (row === undefined) continue
    if (!ours.some(tab => tab.idle) || (await otherRowsOf($, agent, records)).length > 0 || reading.kept.some(line => agentsOf(line).includes(agent))) {
      backstop = true
      continue
    }
    const toldKey = `${session} ${agent} ${row.path} ${row.id}`
    const { act, said } = await actOn(agent, rowName(row), 'is closed', {})
    if (act.kind === 'later') backstop = true
    if (said === null || toldClosedRows.has(toldKey)) continue
    if (act.kind === 'refused') toldClosedRows.add(toldKey)
    lines.push(said)
  }
  for (const [key, pr] of conflicts) {
    if (told.has(conflictKey(key, pr))) continue
    told.add(conflictKey(key, pr))
    const line = reading.kept.find(kept => prKey(kept.repo, kept.pr) === key)
    // Its agent is named only while the launcher lists it running, as a merge names it: the last one put on it, else one before it still running.
    const agent = line === undefined ? undefined : agentsOf(line).find(name => reading.live.has(name))
    lines.push(conflictLine({ repo: pr.repo, pr: pr.pr, base: pr.base ?? '', agent, session: agent === undefined ? undefined : await sessionOf($, agent) }))
  }
  for (const { pr, names } of failing) {
    const key = prKey(pr.repo, pr.pr)
    if (told.has(ciFailingKey(key, pr))) continue
    told.add(ciFailingKey(key, pr))
    const line = reading.kept.find(kept => prKey(kept.repo, kept.pr) === key)
    const agent = line === undefined ? undefined : agentsOf(line).find(name => reading.live.has(name))
    // A line waiting on something, with no agent on it, names that wait.
    const waits = line?.status === 'waiting' ? line.on : undefined
    lines.push(ciFailingLine({ repo: pr.repo, pr: pr.pr, head: pr.sha, failed: names, agent, session: agent === undefined ? undefined : await sessionOf($, agent), waits }))
  }
  for (const u of anomalies) {
    if (told.has(anomalyKey(u))) continue
    told.add(anomalyKey(u))
    told.add(prKey(u.repo, u.pr))
    lines.push(anomalyLine(u))
  }
  const settle = async (): Promise<void> => {
    for (const close of closes.values()) {
      // The facts read again: a message the agent took since the wake leaves it open, its pull requests acted on again later.
      const now = await closeFacts($, close.target).catch((err: unknown): CloseNow => ({ kind: 'later', why: `its facts unread: ${messageOf(err)}` }))
      if (now.kind !== 'close') {
        // A review session still busy is closed at the end of its turn: tried again at the next tick, said by nothing.
        if (close.reviews.length === 0 || now.kind !== 'later') told.add(`owed ${closeFailedLine(close.agent, close.key, `left open: ${now.why}`)}`)
        if (now.kind === 'later') {
          for (const key of close.ready) told.delete(key)
          for (const pk of close.ended) waiting.add(pk)
        } else for (const one of close.reviews) settleOwed(one)
        continue
      }
      const done = await closeAgent($, close.target).catch((err: unknown) => ({ closed: false, why: `its close broke: ${messageOf(err)}` }))
      if (done.why !== null) told.add(`owed ${closeFailedLine(close.agent, close.key, done.why)}`)
      for (const one of close.reviews) settleOwed(one)
    }
    const byRecord = new Map<string, LedgerLine[]>()
    for (const ended of reading.ended) {
      if (!waiting.has(prKey(ended.line.repo, ended.line.pr))) byRecord.set(ended.path, [...(byRecord.get(ended.path) ?? []), ended.line])
    }
    for (const [path, ended] of byRecord) {
      try {
        await archive($, path, ended)
      } catch (err) {
        await logLine($, 'ledger', `archive of ${path} failed: ${messageOf(err)}`)
      }
    }
  }
  return { lines, watching: reading.kept.length > 0 || reading.wanted || waiting.size > 0 || closes.size > 0 || backstop || hasOwed(session), moved, settle }
}
