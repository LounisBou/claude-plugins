// hooks/ledger.ts
// The pull request ledger line written where the pull request is born (core's pr-ledger.ts,
// docs/contracts.md): a pull request opened through the github tool (`pr-create`) or by a Bash
// `gh pr create`, in any repository, takes its line in the dispatch record of the orchestration the
// creating session belongs to: the session's own when it is an orchestrator's, its orchestrator's
// when it is an agent's (orchestratorOn, the one mapping the relay uses). No model, no refusal, no
// gate: the call has already succeeded, so a write that fails is one log line and the answer goes on.
// A pull request of the orchestration merged or closed, wherever it was (the machine's pull request
// file, pr-file.ts), one that became Ready (its agent closes), and one entering the anomaly, wake the orchestrator once each: the module's tick
// (guards.ts) submits the lines prWake gives, the ended lines then archived.
import { prRefsOf } from '../core/learning.ts'
import { isLedgerMarked, ledgerLineOf, ledgerLines, minuteOf, prKey, withLine, type LedgerLine, type Unattended } from '../core/pr-ledger.ts'
import { simpleCommands, unwrapPath } from '../core/shell.ts'
import { updateOver } from '../core/store-io.ts'
import { answerText, PULL_URL } from './audit-events.ts'
import { isDegradedPass, orchestrationOf, ownerOf, withDeadline } from './stop-gate.ts'
import { orchestratorOn, parseSessionRow, REFERENCED, sessionKey, storeOf } from './supervision.ts'
import { messageOf, type CatchHook, type Events, type FsEntry, type Host, type Next, type On } from './host.ts'
import { logLine, stateDir, storeIo } from './module-io.ts'
import { briefOfLaunch, dirOf, newestLaunch, rowOfBrief, rowsOwnedBy, type HeldRow, type RecordText } from './row-owner.ts'
import { archive, boundedReading, readOr, registered } from './unattended.ts'

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

// The open rows an agent owns in any record of the orchestration, as the takeover reads them: the row its
// launch brief was printed for, in the record beside that brief, else the rows whose note names it.
async function rowsHeldBy($: Held, agent: string, records: readonly RecordText[]): Promise<HeldRow[]> {
  const dir = `${await stateDir($)}/prompts`
  const launch = newestLaunch((await $.fs.list(dir).catch((): FsEntry[] => [])).map(entry => entry.name), agent)
  const brief = launch === undefined ? undefined : briefOfLaunch(await readOr($, `${dir}/${launch}`))
  const row = brief === undefined ? undefined : rowOfBrief(await readOr($, brief))
  return rowsOwnedBy(agent, brief === undefined || row === undefined ? undefined : { row: Number(row), dir: dirOf(brief) }, records)
}

// The line a pull request of the orchestration merged or closed wakes it with: its agent to close when it
// runs and holds nothing else; when it still holds something (`holds`: rows, other pull requests), to be told.
export function endedLine(ended: { repo: string; pr: number; state: 'MERGED' | 'CLOSED'; agent?: string | undefined; holds?: readonly string[] }): string {
  const key = prKey(ended.repo, ended.pr)
  const what = ended.state === 'MERGED' ? 'merged' : 'closed unmerged'
  if (ended.agent === undefined) return `[module] ${key} ${what}.`
  const holds = ended.holds ?? []
  return `[module] ${key} ${what}: its agent ${ended.agent} ${holds.length > 0 ? `still holds ${holds.join(', ')}; tell it, do not close it` : 'is done with it, close it'}.`
}

// The line a pull request that became Ready wakes its orchestrator with: its agent is done with it and closes now, its
// session id (`session`, read where the agent is still running) kept on the row to resume it from; when the agent still
// holds another pull request (`holds`), to be told.
export function readyAgentLine(ready: { repo: string; pr: number; agent: string; session?: string | undefined; holds?: readonly string[] }): string {
  const head = `[module] ${prKey(ready.repo, ready.pr)} is Ready: its agent ${ready.agent}`
  const holds = ready.holds ?? []
  if (holds.length > 0) return `${head} still holds ${holds.join(', ')}; tell it, do not close it.`
  return `${head} is done with it${ready.session === undefined ? '' : ` (session ${ready.session})`}, close it.`
}

// The session id of the agent a line names, from its row in the module's store: the newest row of that name.
async function sessionOf($: Held, agent: string): Promise<string | undefined> {
  const store = await storeOf($)
  let found: { id: string; at: string } | undefined
  for (const entry of await $.fs.list(`${store}/sessions`).catch((): FsEntry[] => [])) {
    if (entry.kind !== 'file' || entry.name.includes('.tmp-')) continue
    const held = parseSessionRow(await readOr($, `${store}/sessions/${entry.name}`))
    if (held?.role !== 'agent' || (held.name ?? '').replace(REFERENCED, '').trim() !== agent) continue
    if (found === undefined || held.updated_at > found.at) found = { id: entry.name, at: held.updated_at }
  }
  return found?.id
}

// The line a pull request entering the anomaly wakes its orchestrator with.
export function anomalyLine(u: Unattended): string {
  return `[module] ${prKey(u.repo, u.pr)} en anomalie (${u.conflict ? 'en conflit' : `sans agent depuis ${minuteOf(u.since)}`}) — reattach an agent, refresh its wait, or ask`
}

/*
 * The orchestrator's wake on its pull requests, read in the machine's file (no forge call of its own
 * beyond the file's refresh): a line for each pull request merged or closed, with the open rows waiting
 * on a merged one (mergeRelayLine), and one for each entering the anomaly, each once (`told`, what
 * was told, updated here: one that leaves the anomaly is dropped, so a re-entry is told again). `settle`
 * archives the ended lines once their wake is delivered; `watching`, whether a line is still open or
 * a reader wants the file: the tick keeps it current while either holds.
 * A reading that failed tells nothing and keeps watching.
 */
export async function prWake($: Held, told: Set<string>, now: number = Date.now()): Promise<{ lines: string[]; watching: boolean; settle: () => Promise<void> }> {
  const reading = await boundedReading($, await $.session.id(), now)
  if (reading === null) return { lines: [], watching: true, settle: async () => undefined }
  const lines: string[] = []
  // What is told now: the anomalies and the ended pull requests, the latter keyed apart so an
  // archive that failed is not told again at every tick; what is no longer either is dropped.
  // The reading holds only the orchestration's own pull requests: one no record names is nobody's.
  const anomalies = reading.list.filter(u => u.waits === undefined)
  const current = new Set([...anomalies.map(u => prKey(u.repo, u.pr)), ...reading.ended.map(e => `${prKey(e.line.repo, e.line.pr)} ended`),
    ...[...reading.readyHeads].map(([key, sha]) => `${key} ready ${sha}`)])
  // A repository the file could not read this time keeps what was told of it: no wake again on its return.
  const unread = (key: string): boolean => reading.unread.some(repo => key.startsWith(`${repo}#`))
  for (const key of [...told]) if (!current.has(key) && !unread(key)) told.delete(key)
  const waitingOn = (ended: (typeof reading.ended)[number]) => ended.state === 'MERGED'
    ? reading.records.flatMap(record => waitingRows(record.text, { repo: ended.line.repo.toLowerCase(), pr: ended.line.pr }))
    : []
  for (const ended of reading.ended) {
    const key = `${prKey(ended.line.repo, ended.line.pr)} ended`
    if (told.has(key)) continue
    told.add(key)
    const { repo, pr, agent } = ended.line
    // Its agent is named only while it runs (the launcher's listing, where the close command ends it) and holds nothing else.
    const named = ended.line.status === 'working' && agent !== undefined && reading.live.has(agent) ? agent : undefined
    const holds = named === undefined ? [] : [
      ...(await rowsHeldBy($, named, reading.records)).map(row => `row ${row.id} (${dirOf(row.path).split('/').pop()})`),
      ...reading.kept.filter(line => line.status === 'working' && line.agent === named).map(line => prKey(line.repo, line.pr)),
    ]
    lines.push(endedLine({ repo, pr, state: ended.state, agent: named, holds }))
    const relay = mergeRelayLine({ repo, pr }, waitingOn(ended))
    if (relay !== null) lines.push(relay)
  }
  // A Ready pull request's agent is done: told once per Ready head, so an agent resumed for a fix is told again only at the next head.
  for (const line of reading.atReady) {
    const key = `${prKey(line.repo, line.pr)} ready ${reading.readyHeads.get(prKey(line.repo, line.pr)) ?? ''}`
    if (told.has(key)) continue
    told.add(key)
    const agent = line.agent ?? ''
    const holds = reading.kept.filter(other => other.status === 'working' && other.agent === agent && !reading.readyHeads.has(prKey(other.repo, other.pr))).map(other => prKey(other.repo, other.pr))
    lines.push(readyAgentLine({ repo: line.repo, pr: line.pr, agent, session: await sessionOf($, agent), holds }))
  }
  for (const u of anomalies) {
    if (told.has(prKey(u.repo, u.pr))) continue
    told.add(prKey(u.repo, u.pr))
    lines.push(anomalyLine(u))
  }
  const settle = async (): Promise<void> => {
    const byRecord = new Map<string, LedgerLine[]>()
    for (const ended of reading.ended) byRecord.set(ended.path, [...(byRecord.get(ended.path) ?? []), ended.line])
    for (const [path, ended] of byRecord) {
      try {
        await archive($, path, ended)
      } catch (err) {
        await logLine($, 'ledger', `archive of ${path} failed: ${messageOf(err)}`)
      }
    }
  }
  return { lines, watching: reading.kept.length > 0 || reading.wanted, settle }
}
