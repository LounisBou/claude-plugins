// hooks/ledger.ts
// The pull request ledger line written where the pull request is born (core's pr-ledger.ts,
// docs/contracts.md): a pull request opened through the github tool (`pr-create`) or by a Bash
// `gh pr create`, in any repository, takes its line in the dispatch record of the orchestration the
// creating session belongs to: the session's own when it is an orchestrator's, its orchestrator's
// when it is an agent's (orchestratorOn, the one mapping the relay uses). No model, no refusal, no
// gate: the call has already succeeded, so a write that fails is one log line and the answer goes on.
// A pull request of the orchestration merged or closed, wherever it was (the machine's pull request
// file, pr-file.ts), one that became Ready (the module closes its agent once done, close-agent.ts), one entering the anomaly, and one its agent still holds turned conflicting with its base (its agent rebases), wake the orchestrator once each: the module's tick
// (guards.ts) submits the lines prWake gives, the ended lines then archived.
import { prRefsOf } from '../core/learning.ts'
import { agentsOf, isLedgerMarked, ledgerLineOf, ledgerLines, minuteOf, prKey, withLine, type LedgerLine, type Unattended } from '../core/pr-ledger.ts'
import { simpleCommands, unwrapPath } from '../core/shell.ts'
import { updateOver } from '../core/store-io.ts'
import { answerText, PULL_URL } from './audit-events.ts'
import { chainOwner, isDegradedPass, orchestrationOf, ownerOf, withDeadline } from './stop-gate.ts'
import { orchestratorOn, parseSessionRow, REFERENCED, sessionKey, storeOf } from './supervision.ts'
import { messageOf, type CatchHook, type Events, type FsEntry, type Host, type Next, type On } from './host.ts'
import { logLine, stateDir, storeIo } from './module-io.ts'
import { briefOfLaunch, dirOf, newestLaunch, rowOfBrief, rowsOwnedBy, type HeldRow, type RecordText } from './row-owner.ts'
import { agentLine, closeFailedLine, holdsOf } from './ready-agent.ts'
import { closeAgent, closeFacts, type CloseFacts as CloseNow, type ToClose } from './close-agent.ts'
import { chainPath, parseChain } from '../core/chain-entries.ts'
import { archive, boundedReading, readOr, registered, republish } from './unattended.ts'
import type { FilePr } from './pr-file-format.ts'

// The nouns a write holds.
type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'session' | 'clock'>
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

// The line of the pull request, written once into the first record the orchestration owns; none when
// any of its records already holds one.
export async function writeLine($: Held, pr: { repo: string; pr: number }, now: Date, signal: AbortSignal): Promise<void> {
  const sessionId = await $.session.id()
  const row = parseSessionRow(await readOr($, `${await storeOf($)}/${sessionKey(sessionId)}`))
  if (row === null) return
  const belongs = await orchestrationOfSession($, sessionId, row)
  if (belongs === null) return
  const records = await ownRecords($, await stateDir($), belongs.id, belongs.name)
  const held = (text: string) => ledgerLines(text).some(line => line.repo === pr.repo && line.pr === pr.pr)
  const first = records[0]
  if (first === undefined) return
  for (const path of records) if (held(await readOr($, path))) return
  const agent = (row.name ?? '').replace(REFERENCED, '').trim()
  if (agent === '' || signal.aborted) return
  await updateOver(storeIo($), first, current =>
    current === undefined || held(current) ? undefined : withLine(current, ledgerLineOf({ repo: pr.repo, pr: pr.pr, status: 'working', agent }, now)))
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
// note names it. A row the operator deferred has no agent to tell.
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
    const { id, label, state, blocker, note, deferred } = row as Record<string, unknown>
    if (typeof id !== 'number' || state !== 'open' || (typeof deferred === 'string' && deferred.trim() !== '')) continue
    const said = [blocker, note].filter((part): part is string => typeof part === 'string').join(' ')
    if (!prRefsOf(said).some(ref => namesMerged(ref, merged))) continue
    const agent = typeof note === 'string' ? /\bAgent: [^,;()«»]+/.exec(note)?.[0].trim() ?? null : null
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

// The call goes through; its answer is read for a creation and the line written within the bound.
async function afterCall($: Held, e: Call, next: Next<Call>, now: () => Date, bound: number): Promise<unknown> {
  const result = await next(e)
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
async function briefRowOf($: Held, agent: string): Promise<{ row: number; dir: string } | undefined> {
  const dir = `${await stateDir($)}/prompts`
  const launch = newestLaunch((await $.fs.list(dir).catch((): FsEntry[] => [])).map(entry => entry.name), agent)
  const brief = launch === undefined ? undefined : briefOfLaunch(await readOr($, `${dir}/${launch}`))
  const row = brief === undefined ? undefined : rowOfBrief(await readOr($, brief))
  return brief === undefined || row === undefined ? undefined : { row: Number(row), dir: dirOf(brief) }
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
 * The open rows whose note names the agent (`Held by Agent: <name>`, `Dispatched …: Agent: <name>`) besides its own:
 * another subject it was put on, which keeps it open at the Ready or the merge of its pull request. Its own row is the
 * one its brief was printed for, as the takeover reads it (in the record beside that brief, else of that id in any
 * record); an agent whose brief names no row owns the one row its note names that waits on no blocker (one that waits is a
 * follow-up), and of several, none is told apart.
 */
async function otherRowsOf($: Held, agent: string, records: readonly RecordText[]): Promise<HeldRow[]> {
  const bound = await briefRowOf($, agent)
  const named = rowsOwnedBy(agent, undefined, records)
  const own = bound !== undefined ? rowsOwnedBy(agent, bound, records) : named.length === 1 && !blocked(named[0]!, records) ? named : []
  return named.filter(row => !own.some(mine => mine.path === row.path && mine.id === row.id))
}

// How a held row is named in a line.
const rowName = (row: HeldRow): string => `row ${row.id} (${dirOf(row.path).split('/').pop()})`

/** What the module does with an agent done with a pull request that holds nothing else, read on facts (close-agent.ts). */
type Act = { kind: 'close'; session: string; target: ToClose } | { kind: 'refused' | 'later'; why: string; session?: string | undefined }

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
    text = String(await $.fs.read(chainPath(await stateDir($), tty)))
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
async function closeOf($: Held, agent: string, records: readonly RecordText[], tabs: ReadonlyMap<string, readonly { tty: string; idle: boolean }[]>, chain: () => Promise<Chain>): Promise<Act> {
  const listed = tabs.get(agent) ?? []
  if (listed.length === 0) return { kind: 'later', why: 'the launcher does not list it idle' }
  const own = await chain()
  if (!('ttys' in own)) return own
  const ours = listed.filter(tab => own.ttys.has(bareTty(tab.tty)))
  if (ours.length === 0) return { kind: 'refused', why: `its tab on ${listed.map(tab => tab.tty).join(', ')} is on no chain of this orchestration` }
  const tty = ours.find(tab => tab.idle)?.tty
  if (tty === undefined) return { kind: 'later', why: 'the launcher does not list it idle' }
  const session = await sessionOf($, agent, tty)
  if (session === undefined) return { kind: 'later', why: `no session row of it on ${tty}` }
  const bound = await briefRowOf($, agent)
  const record = bound === undefined ? undefined : records.find(r => dirOf(r.path) === bound.dir && holdsRow(r.text, bound.row))
  const target = { agent, tty, session, cost: bound === undefined || record === undefined ? undefined : { record: record.path, row: bound.row } }
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
 * with its base that the anomaly does not say (conflictLine, once per head and base head), each once (`told`, what
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
  // A file a session of an earlier version refreshed reads no base: what was told of the head stays, whatever its base head.
  const unmergedKeys = unmerged.flatMap(([key, pr]) => pr.baseSha !== undefined ? [conflictKey(key, pr)]
    : [...told].filter(toldKey => toldKey.startsWith(`${key} conflict ${pr.sha} `)))
  // An anomaly keeps its bare key while it lasts, and its conflict key while the forge does not read it mergeable:
  // still computing after its base moved, it is not told again without an agent, then again in conflict.
  const anomalyKeys = anomalies.flatMap(u => reading.forge.get(prKey(u.repo, u.pr))?.mergeable === 'MERGEABLE'
    ? [prKey(u.repo, u.pr)] : [prKey(u.repo, u.pr), `${prKey(u.repo, u.pr)} anomaly conflict`])
  const current = new Set([...anomalyKeys, ...reading.ended.flatMap(e => [`${prKey(e.line.repo, e.line.pr)} ended`, `${prKey(e.line.repo, e.line.pr)} ended refused`]),
    ...[...reading.readyHeads].map(([key, sha]) => `${key} ready ${sha}`), ...unmergedKeys])
  // A repository the file could not read this time keeps what was told of it: no wake again on its return.
  const unread = (key: string): boolean => reading.unread.some(repo => key.startsWith(`${repo}#`))
  for (const key of [...told]) if (!current.has(key) && !unread(key)) told.delete(key)
  const waitingOn = (ended: (typeof reading.ended)[number]) => ended.state === 'MERGED'
    ? reading.records.flatMap(record => waitingRows(record.text, { repo: ended.line.repo.toLowerCase(), pr: ended.line.pr }))
    : []
  // The ended lines whose agent's close waits for a later tick: kept out of the archive, and the tick kept running.
  const waiting = new Set<string>()
  // One act per agent and tick: an agent done with two pull requests is closed once, both told. The closes run once
  // the wake that says them is delivered (`settle`), on facts read again then; one that fails then is told at the next
  // tick (`owed …` in `told`). Each close keeps what it was said for: the Ready keys and the ended lines to retry.
  const acts = new Map<string, Act>()
  const closes = new Map<string, { agent: string; key: string; target: ToClose; ready: string[]; ended: string[] }>()
  let chain: Promise<Chain> | undefined
  const ownChain = (): Promise<Chain> => (chain ??= chainTtys($).catch((err: unknown): Chain => ({ kind: 'later', why: `the chain unread: ${messageOf(err)}` })))
  const actOn = async (agent: string, key: string, what: string, at: { ready?: string; ended?: string }): Promise<{ act: Act; said: string | null }> => {
    const act = acts.get(agent) ?? await closeOf($, agent, reading.records, reading.tabs, ownChain)
    acts.set(agent, act)
    if (act.kind === 'close') {
      const close = closes.get(agent) ?? { agent, key, target: act.target, ready: [], ended: [] }
      if (at.ready !== undefined) close.ready.push(at.ready)
      if (at.ended !== undefined) close.ended.push(at.ended)
      closes.set(agent, close)
    }
    const said = act.kind === 'close' ? agentLine({ key, what, agent, session: act.session })
      : act.kind === 'refused' ? agentLine({ key, what, agent, open: act.why }) : null
    return { act, said }
  }
  for (const ended of reading.ended) {
    const pk = prKey(ended.line.repo, ended.line.pr)
    const first = !told.has(`${pk} ended`)
    told.add(`${pk} ended`)
    const { repo, pr } = ended.line
    const what = ended.state === 'MERGED' ? 'merged' : 'closed unmerged'
    // Its agent is named only while it runs (the launcher's listing, where a close ends it): the one put on it last,
    // else one before it still running; closed by the module when it holds nothing else, told when it does.
    const named = agentsOf(ended.line).find(name => reading.live.has(name))
    const rows = named === undefined ? [] : await otherRowsOf($, named, reading.records)
    const holds = named === undefined ? [] : [
      ...new Set(rows.map(rowName)),
      ...reading.kept.filter(line => agentsOf(line).includes(named)).map(line => prKey(line.repo, line.pr)),
    ]
    let said: string | null = null
    if (named !== undefined && holds.length > 0) said = first ? agentLine({ key: pk, what, agent: named, holds }) : null
    else if (named !== undefined) {
      const { act, said: acted } = await actOn(named, pk, what, { ended: pk })
      if (act.kind === 'later') waiting.add(pk)
      // A refusal is told once; a close waiting on the agent is said with the merge itself.
      const refusedKey = `${pk} ended refused`
      said = act.kind === 'later' ? (first ? agentLine({ key: pk, what, agent: named, waits: act.why }) : null)
        : act.kind === 'refused' && told.has(refusedKey) ? null : acted
      if (act.kind === 'refused') told.add(refusedKey)
    }
    if (said === null && first) said = `[module] ${pk} ${what}.`
    if (said !== null) lines.push(said)
    const relay = first ? mergeRelayLine({ repo, pr }, waitingOn(ended)) : null
    if (relay !== null) lines.push(relay)
  }
  // A Ready pull request's agent is done with it: acted on once per Ready head, so an agent resumed for a fix is closed again only at
  // the next head; one not done yet is tried again at the next tick. One the forge reads conflicting is no longer ready to merge.
  // It holds another pull request, or a row its note names besides the row of its brief: told, not closed.
  for (const line of reading.atReady) {
    if (reading.forge.get(prKey(line.repo, line.pr))?.mergeable === 'CONFLICTING') continue
    const pk = prKey(line.repo, line.pr)
    const key = `${pk} ready ${reading.readyHeads.get(pk) ?? ''}`
    if (told.has(key)) continue
    // The agent put on it last that still runs, else one put on it before, as a merge names it.
    const agent = agentsOf(line).find(name => reading.live.has(name)) ?? line.agent ?? ''
    const holds = [...(await otherRowsOf($, agent, reading.records)).map(rowName), ...holdsOf(reading.kept, other => other === agent, key => reading.readyHeads.has(key))]
    const said = holds.length > 0 ? agentLine({ key: pk, what: 'is Ready', agent, holds }) : (await actOn(agent, pk, 'is Ready', { ready: key })).said
    if (said === null) continue
    told.add(key)
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
        told.add(`owed ${closeFailedLine(close.agent, close.key, `left open: ${now.why}`)}`)
        if (now.kind === 'later') {
          for (const key of close.ready) told.delete(key)
          for (const pk of close.ended) waiting.add(pk)
        }
        continue
      }
      const done = await closeAgent($, close.target).catch((err: unknown) => ({ closed: false, why: `its close broke: ${messageOf(err)}` }))
      if (done.why !== null) told.add(`owed ${closeFailedLine(close.agent, close.key, done.why)}`)
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
  return { lines, watching: reading.kept.length > 0 || reading.wanted || waiting.size > 0 || closes.size > 0, moved, settle }
}
