// hooks/unattended.ts
// The pull requests nobody attends (core's pr-ledger.ts, docs/contracts.md): read against the forge
// at each orchestrator turn end, said in its next turn's context, published on its row for the pane
// and the coordinator's facts, and read again when it declares itself done or deferred, the one
// refusal they make. The lines of the pull requests the forge no longer lists open go to the archive
// beside their record as they are met. Every read is bounded; one that fails is said, never a refusal.
import {
  archiveOf, endedLines, ledgerLines, prKey, unattended, unattendedLine, withArchived, withoutLines,
  type LedgerLine, type OpenPr, type Unattended,
} from '../core/pr-ledger.ts'
import { updateOver } from '../core/store-io.ts'
import { launcherOf } from '../core/orchestration.ts'
import { isDegradedPass, isOwnRecord, listing, liveNames, orchestrationOf, ownerOf, withDeadline, type DeclaredWait } from './stop-gate.ts'
import { isStale, livePids, livePidsArgv, parseSessionRow, publishUnattended, sessionKey, storeOf, type ProcessTable, type SessionRow } from './supervision.ts'
import { logLine, stateDir, storeIo } from './module-io.ts'

// The bound of one reading: the forge's lists, the launcher's, the records and the archive writes.
export const UNATTENDED_BOUND_MS = 20_000
// The open pull requests read per repository: more than one orchestration ever holds open.
export const FORGE_LIMIT = 200

export type Reading = { list: Unattended[]; unread: string[]; line: string | null }

// The forge's open pull requests of a repository opened under the operator's account: the work of
// the orchestrations, never a teammate's.
export function forgeArgv(repo: string): string[] {
  return ['gh', 'pr', 'list', '-R', repo, '--state', 'open', '--author', '@me', '--limit', String(FORGE_LIMIT), '--json', 'number,createdAt']
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
    const { number, createdAt } = (item ?? {}) as { number?: unknown; createdAt?: unknown }
    return typeof number === 'number' && Number.isInteger(number) && number > 0
      ? [{ repo, pr: number, createdAt: typeof createdAt === 'string' ? createdAt : null }]
      : []
  })
}

// The refusal of a done or deferred wait while a pull request is unattended: what to do instead.
export function unattendedRefusal(line: string): string {
  return `Not done: ${line}. Put an agent on each and record it (dispatch-record.sh pr <record> <owner/name>#<n> --working "<agent>"), `
    + 'record what it waits on (--waiting "<what>"), or the operator\'s ruling that parks it (--parked "<his words, dated>").'
}

export const safe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '_')

export async function readOr($: any, path: string): Promise<string> {
  return String(await $.fs.read(path).catch(() => ''))
}

// The records a session registered (`<state>/records/<id>`, one path a line).
async function registered($: any, state: string, sessionId: string): Promise<string[]> {
  return (await readOr($, `${state}/records/${safe(sessionId)}`)).split('\n').map(line => line.trim()).filter(Boolean)
}

// The lines of the records a session registered, each with its record; `own` keeps only those its
// orchestration owns, as the stop gate reads them.
async function linesOf($: any, records: readonly string[], own?: string | null): Promise<{ path: string; lines: LedgerLine[] }[]> {
  const read: { path: string; lines: LedgerLine[] }[] = []
  for (const path of records) {
    if (own !== undefined && !isOwnRecord(ownerOf(await readOr($, `${path}.owner`)), own)) continue
    read.push({ path, lines: ledgerLines(await readOr($, path)) })
  }
  return read
}

// Whether another orchestrator's line still claims its pull request: its session is live (the store's
// own rule, isStale), or the line is a wait set again within the age the module reads for its own
// lines, through unattended() with no agent running. A dead session's stale line claims nothing.
function claims(line: LedgerLine, sessionLive: boolean, now: number): boolean {
  if (sessionLive) return true
  return line.status === 'waiting' && unattended({ open: [{ repo: line.repo, pr: line.pr, createdAt: null }], lines: [line], live: new Set(), now }).length === 0
}

// The pull requests the other orchestrators on this machine record, while their claim is alive: theirs to attend.
async function othersClaims($: any, state: string, sessionId: string, now: number): Promise<Set<string>> {
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
async function archive($: any, path: string, lines: readonly LedgerLine[]): Promise<void> {
  const io = storeIo($)
  await updateOver(io, archiveOf(path), current => withArchived(current ?? '', lines, new Date()))
  await updateOver(io, path, current => withoutLines(current ?? '', lines.map(line => prKey(line.repo, line.pr))))
}

// The reading of an orchestrator session; null for any other session.
export async function readUnattended($: any, sessionId: string, now: number = Date.now()): Promise<Reading | null> {
  const row = parseSessionRow(await readOr($, `${await storeOf($)}/${sessionKey(sessionId)}`))
  if (row?.role !== 'orchestrator' || !row.name) return null
  const state = await stateDir($)
  const own = await linesOf($, await registered($, state, sessionId), orchestrationOf(row.name))
  const repos = [...new Set([...(row.repo ? [row.repo] : []), ...own.flatMap(record => record.lines.map(line => line.repo))])]
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
        await logLine($, 'unattended', `archive of ${record.path} failed: ${(err as Error).message}`)
      }
    }
    kept.push(...record.lines.filter(line => !ended.includes(line)))
  }
  // The launcher's listing names the agents running, read only when a line names one; one that cannot
  // be read takes every agent a line names for running, so no pull request is called unattended on a
  // read that failed.
  const named = new Set(kept.flatMap(line => (line.status === 'working' && line.agent ? [line.agent] : [])))
  let live: ReadonlySet<string> = named
  if (named.size > 0) {
    const launched = await $.process.run(['bash', launcherOf($.plugin.root), 'list'], { timeoutMs: UNATTENDED_BOUND_MS }).catch(() => null)
    if (launched && launched.exitCode === 0) live = liveNames(listing(String(launched.stdout ?? '')))
    else await logLine($, 'unattended', "the launcher's listing unread: every agent a line names is taken for running")
  }
  const list = unattended({ open, lines: kept, live, now, claimed: await othersClaims($, state, sessionId, now) })
  return { list, unread, line: unattendedLine(list, unread) }
}

// The reading within its bound; null when it ran out or broke, said in the log.
export async function boundedReading($: any, sessionId: string): Promise<Reading | null> {
  try {
    const done = await withDeadline(readUnattended($, sessionId), UNATTENDED_BOUND_MS)
    if (!isDegradedPass(done)) return done
    await logLine($, 'unattended', `the reading did not finish within ${UNATTENDED_BOUND_MS} ms`)
  } catch (err) {
    await logLine($, 'unattended', `the reading failed: ${(err as Error).message}`)
  }
  return null
}

// What the declared wait asks before it takes a done or a deferred: the refusal while a pull request
// is unattended, else null. Handed to wait.ts by register.ts.
export async function holdsDone($: any, wait: DeclaredWait): Promise<string | null> {
  if (wait.kind !== 'done' && wait.kind !== 'deferred') return null
  const reading = await boundedReading($, await $.session.id())
  return reading !== null && reading.list.length > 0 ? unattendedRefusal(unattendedLine(reading.list, []) ?? '') : null
}

// The line each turn end leaves for the next turn's context, by session.
const pending = new Map<string, string>()

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  on('turn.complete', {}, async ($: any, e: any, next: (e: any) => any) => {
    if (e.agentId) return next(e)
    try {
      const sessionId = await $.session.id()
      const reading = await boundedReading($, sessionId)
      if (reading !== null) {
        if (reading.line === null) pending.delete(sessionId)
        else pending.set(sessionId, reading.line)
        await publishUnattended($, sessionId, { at: new Date().toISOString(), line: reading.line, prs: reading.list, unread: reading.unread })
      }
    } catch (err) {
      await logLine($, 'unattended', (err as Error).message)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'unattended', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The line the last turn end left, said once beside the next prompt.
  on('prompt.submit', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      const sessionId = await $.session.id()
      const line = pending.get(sessionId)
      if (line !== undefined) {
        pending.delete(sessionId)
        return next({ ...e, context: [...(e.context ?? []), line] })
      }
    } catch (err) {
      await logLine($, 'unattended', (err as Error).message)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'unattended', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}
