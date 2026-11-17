// hooks/unattended.ts
// The pull requests nobody attends (core's pr-ledger.ts, docs/contracts.md): read against the forge
// at each orchestrator turn end, said in its next turn's context, published on its row for the pane
// and the coordinator's facts, and read again when it declares itself done or deferred, the one
// refusal they make. The lines of the pull requests the forge no longer lists open go to the archive
// beside their record as they are met. Every read is bounded; one that fails is said, never a refusal.
import {
  archiveOf, endedLines, isFreshWait, ledgerLines, prKey, readyRows, readyRowsLine, unattended, unattendedLine, withArchived, withoutLines,
  type LedgerLine, type OpenPr, type ReadyRow, type Unattended,
} from '../core/pr-ledger.ts'
import { updateOver } from '../core/store-io.ts'
import { launcherOf, recordsRegistryPath } from '../core/orchestration.ts'
import { isDegradedPass, isOwnRecord, listing, liveNames, orchestrationOf, ownerOf, withDeadline, type DeclaredWait } from './stop-gate.ts'
import { isStale, livePids, livePidsArgv, parseSessionRow, publishUnattended, sessionKey, storeOf, type ProcessTable, type SessionRow } from './supervision.ts'
import { messageOf, type Host, type On } from './host.ts'
import { logLine, stateDir, storeIo } from './module-io.ts'

// The nouns a reading holds.
type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'session' | 'clock'>

// The bound of one reading: the forge's lists, the launcher's, the records and the archive writes.
export const UNATTENDED_BOUND_MS = 20_000
// The open pull requests read per repository: more than one orchestration ever holds open.
export const FORGE_LIMIT = 200

// `ready`: the open rows whose blocker has fallen (`none`, or an `until` past) that no live agent and no open pull request holds; `readyLine` says them.
export type Reading = { list: Unattended[]; unread: string[]; line: string | null; ready: ReadyRow[]; readyLine: string | null }

// The forge's open pull requests of a repository opened under the operator's account: the work of
// the orchestrations, never a teammate's. Their labels say what rests on him (`Ready`, `On Hold`).
export function forgeArgv(repo: string): string[] {
  return ['gh', 'pr', 'list', '-R', repo, '--state', 'open', '--author', '@me', '--limit', String(FORGE_LIMIT), '--json', 'number,createdAt,labels,mergeable']
}

// The forge's answer read, or null when it is no list of pull requests.
export function parseOpenPrs(repo: string, stdout: string): OpenPr[] | null {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(value)) return null
  return value.flatMap(item => {
    const { number, createdAt, labels, mergeable } = (item ?? {}) as { number?: unknown; createdAt?: unknown; labels?: unknown; mergeable?: unknown }
    const names = Array.isArray(labels) ? labels.flatMap(label => (typeof (label as { name?: unknown } | null)?.name === 'string' ? [(label as { name: string }).name] : [])) : []
    return typeof number === 'number' && Number.isInteger(number) && number > 0
      ? [{ repo, pr: number, createdAt: typeof createdAt === 'string' ? createdAt : null, labels: names, ...(typeof mergeable === 'string' ? { mergeable } : {}) }]
      : []
  })
}

// The refusal of a done or deferred wait while a pull request is in anomaly: what to do instead.
export function unattendedRefusal(line: string): string {
  return `Not done: ${line}. Put an agent on each and record it (dispatch-record.sh pr <record> <owner/name>#<n> --working "<agent>"), `
    + 'record what it waits on (--waiting "<what>"), or the operator\'s ruling that parks it (--parked "<his words, dated>").'
}

export const safe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '_')

export async function readOr($: Host<'fs'>, path: string): Promise<string> {
  return String(await $.fs.read(path).catch(() => ''))
}

// The records a session registered (`<state>/records/<id>`, one path a line).
export async function registered($: Host<'fs'>, state: string, sessionId: string): Promise<string[]> {
  return (await readOr($, recordsRegistryPath(state, sessionId))).split('\n').map(line => line.trim()).filter(Boolean)
}

// The lines of the records a session registered, each with its record and its text; `own` keeps only
// those its orchestration owns, as the stop gate reads them.
async function linesOf($: Host<'fs'>, records: readonly string[], own?: string | null): Promise<{ path: string; text: string; lines: LedgerLine[] }[]> {
  const read: { path: string; text: string; lines: LedgerLine[] }[] = []
  for (const path of records) {
    if (own !== undefined && !isOwnRecord(ownerOf(await readOr($, `${path}.owner`)), own)) continue
    const text = await readOr($, path)
    read.push({ path, text, lines: ledgerLines(text) })
  }
  return read
}

// Whether another orchestrator's line still claims its pull request: its session is live (the store's
// own rule, isStale), or the line is a wait set again within the age the module reads for its own
// lines (isFreshWait). A dead session's stale line claims nothing.
function claims(line: LedgerLine, sessionLive: boolean, now: number): boolean {
  if (sessionLive) return true
  return isFreshWait(line, now)
}

// The pull requests the other orchestrators on this machine record, while their claim is alive: theirs to attend.
async function othersClaims($: Held, state: string, sessionId: string, now: number): Promise<Set<string>> {
  const store = await storeOf($)
  const entries: { name: string; kind: string }[] = await $.fs.list(`${store}/sessions`).catch(() => [])
  const others: { name: string; row: SessionRow }[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || entry.name.includes('.tmp-') || entry.name === safe(sessionId)) continue
    const row = parseSessionRow(await readOr($, `${store}/sessions/${entry.name}`))
    if (row?.role === 'orchestrator') others.push({ name: entry.name, row })
  }
  // One process listing for every row, as the store's reader takes it; one that failed knows no death.
  const argv = livePidsArgv(others.map(({ row }) => String(row.pid ?? '')))
  const ps = argv ? await $.process.run(argv, { timeoutMs: UNATTENDED_BOUND_MS }).catch(() => null) : null
  const alive: ProcessTable | null = argv ? livePids(ps) : new Map()
  const claimed = new Set<string>()
  for (const { name, row } of others) {
    const live = !isStale(row, now, alive)
    for (const { lines } of await linesOf($, await registered($, state, name))) for (const line of lines) if (claims(line, live, now)) claimed.add(prKey(line.repo, line.pr))
  }
  return claimed
}

// Moves lines to the archive beside their record: the archive written first, so a move cut short
// leaves the line in both, never in neither.
async function archive($: Held, path: string, lines: readonly LedgerLine[]): Promise<void> {
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
  // Only the repositories the session's dispatch record names: the checkout's own repository holds
  // pull requests of the operator's that no orchestration of his records.
  const repos = [...new Set(own.flatMap(record => record.lines.map(line => line.repo)))]
  const open: OpenPr[] = []
  const unread: string[] = []
  const listed = new Map<string, number[]>()
  for (const repo of repos) {
    const answer = await $.process.run(forgeArgv(repo), { timeoutMs: UNATTENDED_BOUND_MS }).catch(() => null)
    const prs = answer && answer.exitCode === 0 ? parseOpenPrs(repo, String(answer.stdout ?? '')) : null
    if (prs === null) {
      unread.push(repo)
      await logLine($, 'unattended', `forge unread for ${repo}: ${answer ? `gh exited ${answer.exitCode}: ${String(answer.stderr ?? '').trim()}` : 'gh did not answer'}`)
      continue
    }
    open.push(...prs)
    listed.set(repo, prs.map(pr => pr.pr))
  }
  const kept: LedgerLine[] = []
  for (const record of own) {
    const ended = endedLines(record.lines, listed)
    if (ended.length > 0) {
      try {
        await archive($, record.path, ended)
      } catch (err) {
        await logLine($, 'unattended', `archive of ${record.path} failed: ${messageOf(err)}`)
      }
    }
    kept.push(...record.lines.filter(line => !ended.includes(line)))
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
  const named = new Set(kept.flatMap(line => (line.status === 'working' && line.agent ? [line.agent] : [])))
  const live = named.size > 0 ? await running() ?? named : named
  const list = unattended({ open, lines: kept, live, now, claimed: await othersClaims($, state, sessionId, now) })
  const texts = own.map(record => record.text)
  let ready: ReadyRow[] = []
  if (readyRows({ texts, lines: kept, live: new Set(), now }).length > 0) {
    const agents = await running()
    if (agents !== null) ready = readyRows({ texts, lines: kept, live: agents, now })
  }
  return { list, unread, line: unattendedLine(list, unread), ready, readyLine: readyRowsLine(ready) }
}

// The reading within its bound; null when it ran out or broke, said in the log.
export async function boundedReading($: Held, sessionId: string): Promise<Reading | null> {
  try {
    const done = await withDeadline(readUnattended($, sessionId), UNATTENDED_BOUND_MS)
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
