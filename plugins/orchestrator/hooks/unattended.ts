// hooks/unattended.ts
// The pull requests of an orchestration's own record that nobody attends (core's pr-ledger.ts, docs/contracts.md): read against the
// machine's pull request file (pr-file.ts) at each orchestrator turn end, said in its next turn's
// context, published on its row for the pane and the coordinator's facts, and read again when it
// declares itself done or deferred, the one refusal they make, and by the module's tick, which wakes
// the orchestrator on a pull request merged, closed or entering the anomaly. Every read is bounded;
// one that fails is said, never a refusal.
import {
  archiveOf, ledgerLines, prKey, readyRows, readyRowsLine, unattended, unattendedLine, withArchived, withoutLines,
  type LedgerLine, type OpenPr, type ReadyRow, type Unattended,
} from '../core/pr-ledger.ts'
import { updateOver } from '../core/store-io.ts'
import { launcherOf, recordsRegistryPath } from '../core/orchestration.ts'
import { isDegradedPass, isOwnRecord, listing, liveNames, orchestrationOf, ownerOf, withDeadline, type DeclaredWait } from './stop-gate.ts'
import { parseSessionRow, publishUnattended, sessionKey, storeOf } from './supervision.ts'
import { messageOf, type Host, type On } from './host.ts'
import { logLine, stateDir, storeIo } from './module-io.ts'
import { fileWanted, readPrFile, refreshPrFile } from './pr-file.ts'
import { prsOfRepo, type PrFile } from './pr-file-format.ts'
import type { RecordText } from './row-owner.ts'

// The nouns a reading holds.
type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'session' | 'clock'>

// The bound of one reading: the machine file's refresh, the launcher's list, the records and the archive writes.
export const UNATTENDED_BOUND_MS = 20_000

// `ready`: the open rows whose blocker has fallen (`none`, or an `until` past) that no live agent and no open pull request holds; `readyLine` says them.
// `ended`: the session's own lines whose pull request the file reads merged or closed, each with its record; `kept`: its lines still open; `records`: its records, each with its path and its text.
// `live`: the names of the agents the launcher lists running, among those a line names (every one when its listing could not be read).
// `wanted`: whether the sweep asks the file to hold a repository (`prs.wanted`).
export type Reading = {
  list: Unattended[]; unread: string[]; line: string | null; ready: ReadyRow[]; readyLine: string | null
  ended: Ended[]; kept: LedgerLine[]; records: RecordText[]; live: ReadonlySet<string>; wanted: boolean
}
export type Ended = { line: LedgerLine; state: 'MERGED' | 'CLOSED'; path: string }

// The open pull requests of a repository as the machine's file holds them, for their labels and their
// merge state (`Ready`, `On Hold`, `CONFLICTING`): the reading looks its own lines up in them, and lists
// no other. Undefined when the file holds no current reading of the repository.
export function openOf(file: PrFile | undefined, repo: string, now: number): OpenPr[] | undefined {
  return prsOfRepo(file, repo, now)?.filter(pr => pr.state === 'OPEN').map(pr => ({
    repo, pr: pr.pr, labels: pr.labels, ...(pr.mergeable === null ? {} : { mergeable: pr.mergeable }),
  }))
}

// The refusal of a done or deferred wait while a pull request is in anomaly: what to do instead.
export function unattendedRefusal(line: string): string {
  return `Not done: ${line}. Put an agent on each and record it (dispatch-record.sh pr <record> <owner/name>#<n> --working "<agent>"), `
    + 'record what it waits on (--waiting "<what>"), or the operator\'s ruling that parks it (--parked "<his words, dated>").'
}

export async function readOr($: Host<'fs'>, path: string): Promise<string> {
  return String(await $.fs.read(path).catch(() => ''))
}

// The records a session registered (`<state>/records/<id>`, one path a line).
export async function registered($: Host<'fs'>, state: string, sessionId: string): Promise<string[]> {
  return (await readOr($, recordsRegistryPath(state, sessionId))).split('\n').map(line => line.trim()).filter(Boolean)
}

// The lines of the records a session registered, each with its record and its text; `own` keeps only
// those its orchestration owns, as the stop gate reads them.
async function linesOf($: Host<'fs'>, records: readonly string[], own: string | null): Promise<{ path: string; text: string; lines: LedgerLine[] }[]> {
  const read: { path: string; text: string; lines: LedgerLine[] }[] = []
  for (const path of records) {
    if (!isOwnRecord(ownerOf(await readOr($, `${path}.owner`)), own)) continue
    const text = await readOr($, path)
    read.push({ path, text, lines: ledgerLines(text) })
  }
  return read
}

// Moves lines to the archive beside their record: the archive written first, so a move cut short
// leaves the line in both, never in neither.
export async function archive($: Held, path: string, lines: readonly LedgerLine[]): Promise<void> {
  const io = storeIo($)
  await updateOver(io, archiveOf(path), current => withArchived(current ?? '', lines, new Date()))
  await updateOver(io, path, current => withoutLines(current ?? '', lines.map(line => prKey(line.repo, line.pr))))
}

// The reading of an orchestrator session; null for any other session.
export async function readUnattended($: Held, sessionId: string, now: number = Date.now()): Promise<Reading | null> {
  const row = parseSessionRow(await readOr($, `${await storeOf($)}/${sessionKey(sessionId)}`))
  if (row?.role !== 'orchestrator' || !row.name) return null
  const state = await stateDir($)
  const own = await linesOf($, await registered($, state, sessionId), orchestrationOf(row.name))
  // Only the repositories the session's dispatch record names, read in the machine's file, refreshed
  // first when it is older than its interval; a turn end refreshes it too when the sweep wants
  // repositories read (`prs.wanted`), whatever its own record holds.
  // The session's own lines are the only pull requests listed (core's `unattended`): any other is nobody's.
  const repos = [...new Set(own.flatMap(record => record.lines.map(line => line.repo)))]
  const wanted = await fileWanted($, state, now)
  if (repos.length > 0 || wanted) await refreshPrFile($, now)
  const file = repos.length > 0 ? await readPrFile($) : undefined
  const open: OpenPr[] = []
  const unread: string[] = []
  for (const repo of repos) {
    // A file whose last refresh failed holds the pull requests of an earlier read: unknown now.
    const listed = openOf(file, repo, now)
    if (listed === undefined) unread.push(repo)
    else open.push(...listed)
  }
  // A failed refresh is said once by the file's own log line; a repository not in it yet, here.
  if (unread.length > 0 && file?.error === undefined) await logLine($, 'unattended', `pull requests unread for ${unread.join(', ')}: not in the machine's file yet`)
  // A line whose pull request the file reads merged or closed has ended: told and archived by the module's tick.
  const states = new Map((file?.prs ?? []).map(pr => [prKey(pr.repo, pr.pr), pr.state]))
  const ended: Ended[] = []
  const kept: LedgerLine[] = []
  for (const record of own) {
    for (const line of record.lines) {
      const state = states.get(prKey(line.repo, line.pr))
      if (state === 'MERGED' || state === 'CLOSED') ended.push({ line, state, path: record.path })
      else kept.push(line)
    }
  }
  // The launcher's listing names the agents running, read once and only when a line names one or a
  // row is ready; one that cannot be read takes every agent a line names for running, so no pull
  // request is called unattended on a read that failed, and names no row ready.
  let seen: ReadonlySet<string> | null | undefined
  const running = async (): Promise<ReadonlySet<string> | null> => {
    if (seen !== undefined) return seen
    const launched = await $.process.run(['bash', launcherOf($.plugin.root), 'list'], { timeoutMs: UNATTENDED_BOUND_MS }).catch(() => null)
    seen = launched && launched.exitCode === 0 ? liveNames(listing(String(launched.stdout ?? ''))) : null
    if (seen === null) await logLine($, 'unattended', "the launcher's listing unread: every agent a line names is taken for running, no row is named ready")
    return seen
  }
  const named = new Set([...kept, ...ended.map(e => e.line)].flatMap(line => (line.status === 'working' && line.agent ? [line.agent] : [])))
  const live = named.size > 0 ? await running() ?? named : named
  const list = unattended({ open, lines: kept, live, now })
  const texts = own.map(record => record.text)
  let ready: ReadyRow[] = []
  if (readyRows({ texts, lines: kept, live: new Set(), now }).length > 0) {
    const agents = await running()
    if (agents !== null) ready = readyRows({ texts, lines: kept, live: agents, now })
  }
  return { list, unread, line: unattendedLine(list, unread), ready, readyLine: readyRowsLine(ready), ended, kept, records: own, live, wanted }
}

// The reading within its bound; null when it ran out or broke, said in the log.
export async function boundedReading($: Held, sessionId: string, now: number = Date.now()): Promise<Reading | null> {
  try {
    const done = await withDeadline(readUnattended($, sessionId, now), UNATTENDED_BOUND_MS)
    if (!isDegradedPass(done)) return done
    await logLine($, 'unattended', `the reading did not finish within ${UNATTENDED_BOUND_MS} ms`)
  } catch (err) {
    await logLine($, 'unattended', `the reading failed: ${messageOf(err)}`)
  }
  return null
}

// What the declared wait asks before it takes a done or a deferred: the refusal while a pull request
// is in anomaly (no agent, not Ready, no wait of its own, or in conflict), else null: what rests on the operator
// holds nothing. Handed to wait.ts by register.ts.
export async function holdsDone($: Held, wait: DeclaredWait): Promise<string | null> {
  if (wait.kind !== 'done' && wait.kind !== 'deferred') return null
  const reading = await boundedReading($, await $.session.id())
  const anomalies = reading?.list.filter(u => u.waits === undefined) ?? []
  return anomalies.length > 0 ? unattendedRefusal(unattendedLine(anomalies, []) ?? '') : null
}

// The lines each turn end leaves for the next turn's context, by session.
const pending = new Map<string, string[]>()

export function register(on: On<Held>): void {
  // The lines the last reading of each session had: a line met again is no news, the pane and the
  // refusal of a done still carry it, so the context says only what changed since the turn before.
  const lastRead = new Map<string, string[]>()
  on('turn.complete', {}, async ($, e, next) => {
    if (e.agentId) return next(e)
    try {
      const sessionId = await $.session.id()
      const reading = await boundedReading($, sessionId)
      if (reading !== null) {
        // Each line is told apart: a change of one never says the others again.
        const read = [reading.line, reading.readyLine].flatMap(text => (text ?? '').split('\n').filter(said => said !== ''))
        const before = lastRead.get(sessionId) ?? []
        lastRead.set(sessionId, read)
        // A change leaves the new lines only, beside the lines an earlier turn end left that no prompt has said yet and that still hold.
        const owed = [...(pending.get(sessionId) ?? []).filter(text => read.includes(text)), ...read.filter(text => !before.includes(text))]
        if (owed.length === 0) pending.delete(sessionId)
        else pending.set(sessionId, owed)
        await publishUnattended($, sessionId, { at: new Date().toISOString(), line: reading.line, prs: reading.list, unread: reading.unread })
      }
    } catch (err) {
      await logLine($, 'unattended', messageOf(err))
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'unattended', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The line the last turn end left, said once beside the next prompt.
  on('prompt.submit', {}, async ($, e, next) => {
    try {
      const sessionId = await $.session.id()
      const said = pending.get(sessionId)
      if (said !== undefined) {
        pending.delete(sessionId)
        return next({ ...e, context: [...(e.context ?? []), ...said] })
      }
    } catch (err) {
      await logLine($, 'unattended', messageOf(err))
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'unattended', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}
