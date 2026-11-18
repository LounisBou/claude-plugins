// The ledger of the checkouts: one line per checkout `workspace.sh` made under the workspaces root,
// every project's, naming its repository, its branch (a pin: its commit), the orchestrator that made
// it and the last agent seen working in it, and, once neither lives, why it is still there. The one
// source of truth for « which checkouts exist and whose they are », as the pull request ledger is for
// the pull requests: `create` and `pin` open a line, `delete` closes it (the line moves to the
// archive beside it, with how it ended), the sweep adopts a checkout no line names and writes the
// reason one stays. It lives in the root itself, beside what it describes, a dot file no loop over
// the root reads as a checkout. Read and written by `workspace.ts` alone.
import { appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readText, update } from '../../../../core/store.ts'

export const WORKSPACE_LEDGER = {
  version: 1,
  file: '.workspaces.jsonl',
  archive: '.workspaces.archive.jsonl',
} as const

/*
 * How long a checkout stays its maker's after its birth, whoever lives: the time an orchestrator
 * takes between `create` and its agent's launch, and the time a checkout made by a session with no
 * name (a shell, an older script) is given before it is judged on its owners.
 */
export const GRACE_MS = 60 * 60 * 1000

export interface WorkspaceEntry {
  readonly v: number
  /** The checkout's real path. */
  readonly path: string
  readonly kind: 'clone' | 'pin'
  /** `owner/name` for a GitHub origin, else the origin as git has it, else ''. */
  readonly repo: string
  /** A clone's branch ('' on a detached head); a pin's commit. */
  readonly branch: string
  /** The orchestrator's session name, without its reference; null when none is known. */
  readonly orchestrator: string | null
  /** The last agent seen working in it; null until one is. */
  readonly agent: string | null
  readonly created: string
  /** True when the sweep found the checkout with no line and wrote one. */
  readonly adopted?: boolean
  /** Why it is still there while no orchestrator and no agent of it lives. */
  readonly reason?: string
  readonly reason_at?: string
}

export interface ClosedEntry extends WorkspaceEntry {
  readonly closed: string
  /** `removed`, `pushed and removed`, `discarded`. */
  readonly end: string
}

const isText = (v: unknown): v is string => typeof v === 'string'
const isTextOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

/** One line, or null when it is no entry of this version. */
export function parseEntry(line: string): WorkspaceEntry | null {
  let read: unknown
  try {
    read = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof read !== 'object' || read === null || Array.isArray(read)) return null
  const r = read as Record<string, unknown>
  if (r['v'] !== WORKSPACE_LEDGER.version || !isText(r['path']) || r['path'] === '') return null
  if (r['kind'] !== 'clone' && r['kind'] !== 'pin') return null
  if (!isText(r['repo']) || !isText(r['branch']) || !isText(r['created'])) return null
  if (!isTextOrNull(r['orchestrator']) || !isTextOrNull(r['agent'])) return null
  if (r['reason'] !== undefined && !isText(r['reason'])) return null
  return read as WorkspaceEntry
}

/** Every entry of the ledger's text, a line that does not parse left out. */
export function parseLedger(text: string): WorkspaceEntry[] {
  return text.split('\n').flatMap(l => {
    const e = l.trim() === '' ? null : parseEntry(l)
    return e === null ? [] : [e]
  })
}

/** The ledger's text: one line per entry, in path order. */
export function ledgerText(entries: readonly WorkspaceEntry[]): string {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(e => `${JSON.stringify(e)}\n`).join('')
}

export const ledgerPath = (root: string): string => join(root, WORKSPACE_LEDGER.file)
export const archivePath = (root: string): string => join(root, WORKSPACE_LEDGER.archive)

/** The entries the ledger holds now. */
export function readLedger(root: string): WorkspaceEntry[] {
  return parseLedger(readText(ledgerPath(root)) ?? '')
}

/** Writes `entry`, replacing the one of the same path. */
export function putEntry(root: string, entry: WorkspaceEntry): void {
  update(ledgerPath(root), current => ledgerText([...parseLedger(current ?? '').filter(e => e.path !== entry.path), entry]), { waitMs: 2000 })
}

/** Changes the entry of `path` through `change`; nothing when the ledger has none. */
export function changeEntry(root: string, path: string, change: (e: WorkspaceEntry) => WorkspaceEntry): void {
  update(ledgerPath(root), current => ledgerText(parseLedger(current ?? '').map(e => (e.path === path ? change(e) : e))), { waitMs: 2000 })
}

/** Closes the entry of `path`: out of the ledger, into the archive with how it ended. */
export function closeEntry(root: string, path: string, end: string, at: string): void {
  let closed: WorkspaceEntry | undefined
  update(ledgerPath(root), current => {
    const all = parseLedger(current ?? '')
    closed = all.find(e => e.path === path)
    return ledgerText(all.filter(e => e.path !== path))
  }, { waitMs: 2000 })
  if (closed === undefined) return
  const line: ClosedEntry = { ...closed, closed: at, end }
  appendFileSync(archivePath(root), `${JSON.stringify(line)}\n`)
}

/** A session name without the ` [ref]` a listing of the agents appends to it. */
export function bareName(name: string): string {
  return name.replace(/\s*\[[0-9A-Za-z]+\]\s*$/, '').trim()
}

/** A live session of the host: its name, its id, the directory it started in, its process. */
export interface LiveSession {
  readonly name: string
  readonly session: string
  readonly cwd: string
  readonly pid: number
}

/**
 * The host's sessions whose process lives, read in its registry (`<config>/sessions/<pid>.json`,
 * `name`, `sessionId`, `cwd`, `pid`). A record that does not parse, names no session or whose process is gone is
 * left out: a crashed session leaves its file behind.
 */
export function liveSessions(config: string, alive: (pid: number) => boolean): LiveSession[] {
  let names: string[]
  try {
    names = readdirSync(join(config, 'sessions')).filter(n => /^[0-9]+\.json$/.test(n))
  } catch {
    return []
  }
  const found: LiveSession[] = []
  for (const n of names) {
    let read: unknown
    try {
      read = JSON.parse(readText(join(config, 'sessions', n)) ?? '')
    } catch {
      continue
    }
    if (typeof read !== 'object' || read === null) continue
    const r = read as Record<string, unknown>
    const pid = typeof r['pid'] === 'number' ? r['pid'] : Number.parseInt(n, 10)
    if (!isText(r['name']) || r['name'] === '' || !isText(r['cwd']) || !Number.isInteger(pid) || !alive(pid)) continue
    found.push({ name: bareName(r['name']), session: isText(r['sessionId']) ? r['sessionId'] : '', cwd: r['cwd'], pid })
  }
  return found
}

/** Whether a process lives, by the signal 0 the system answers without sending anything. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The session of the caller, by the session id the host exports to its commands, or null. */
export function callerOf(sessions: readonly LiveSession[], id: string | undefined): LiveSession | null {
  if (id === undefined || id === '') return null
  return sessions.find(s => s.session === id) ?? null
}

/**
 * Who makes a checkout: an orchestrator (or any session that is no agent) is its own orchestrator;
 * an agent names the orchestrator it reports to (`ORCHESTRATOR_REPORTS_TO`) and is the checkout's
 * first agent; no session named, neither is known.
 */
export function makerOf(caller: LiveSession | null, reportsTo: string | undefined): { orchestrator: string | null; agent: string | null } {
  const to = reportsTo === undefined || reportsTo.trim() === '' ? null : bareName(reportsTo)
  if (caller === null) return { orchestrator: to, agent: null }
  if (caller.name.startsWith('Agent:')) return { orchestrator: to, agent: caller.name }
  return { orchestrator: caller.name, agent: null }
}
