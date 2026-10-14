// hooks/supervision.ts
// The shared store: one row per live session — the figures the gauge measured,
// the name the walk read, the repository of the working directory — written by
// this file's own session.measure handler and removed by its session.end, one
// file per key under the module's state root. The supervision pane below reads
// the same rows, opened only when the person types /orchestrator:supervision —
// never on a start: the operator wants nothing placed on screen unasked. In a
// coordinator session it lists the orchestrators; in an orchestrator session,
// that orchestrator's own agents, read from the launcher's chain and the host's
// session records; in any other role it opens nothing. The commands hold no $ of
// the writing side and read the same files through their own $.fs calls plus
// the pure row parser and the urgency sort below.
//
// The engine fences $ to the file that received it — never passed across an
// import — so this file spells its own env resolution, its own log stamp, its
// own origin read and its own transcript-window reader, while the figures
// cross as a plain import (currentReading, no $ argument) and the name runs
// over the walk's pure core with readers built here.
import { currentReading } from './gauge.ts'
import { tripGate } from './gauge-core.ts'
import {
  roleOf, walkName, hostBasenames, hostRecordOf, blockArgv, bytesOfBase64,
  type ReadRecord, type HostNames,
} from './session-name.ts'
import { withDeadline, isDegradedPass, chainEntries } from './stop-gate.ts'
import { logArgv, LOG_TIMEOUT_MS } from './module-log.ts'
import {
  parseWait, parseStatus, waitPatch, clearedWait, fingerprint, relayText, gateText, coordinatorOf, chainOwnerTty, waitLabel,
  type WaitKind,
} from './relay.ts'

// One row per live session, the store's whole schema. `pid` is the session's host
// process — the row lives while it does.
export type SessionRow = {
  role: 'orchestrator' | 'agent' | 'auditor' | 'coordinator' | null
  name: string | null
  pid?: string | null
  // The session's tty, the walk's: an agent's orchestrator is the chain naming it.
  tty?: string | null
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
}

// A row lives while its session's host process does: a session idle for hours —
// waiting on a long agent phase, on a CI watch — is still there, and one that
// ended without its end event (a crash, a kill) is gone the moment its pid is.
// A row written before rows carried a pid falls back to the old rule: no
// measure for an hour, no row.
const STALE_AFTER_MS = 60 * 60 * 1000

// The rule above as a function, pure and exported: the commands read the same
// store through their own $ (the fence forbids sharing the reader) and judge
// every row by this same rule. `alive` is the set of live pids the caller read
// (livePidsArgv, livePids); null when that read failed, and a read that failed
// knows nothing of any pid: the row is kept, never judged dead on no evidence.
export function isStale(row: SessionRow, now: number, alive: ReadonlySet<string> | null = new Set()): boolean {
  if (row.pid) return alive !== null && !alive.has(String(row.pid))
  const at = Date.parse(row.updated_at)
  return !Number.isFinite(at) || now - at > STALE_AFTER_MS
}

// One ps listing every live pid on the machine, run when a row names a pid at
// all; the caller intersects. Never `ps -p <the rows' pids>`: its exit and its
// output depend on the pids asked — one it refuses (macOS: « process id too
// large ») fails the whole call with nothing printed — so a single bad row
// made every live row read as dead, and the store reader removed them all.
export function livePidsArgv(pids: readonly string[]): string[] | null {
  return pids.some(pid => /^\d+$/.test(pid)) ? ['ps', '-A', '-o', 'pid='] : null
}

// The live pids out of that ps's result, or null when the read failed: no
// result (it rejected, it timed out), a degraded pass, a non-zero exit, or a
// listing with no pid in it — ps lists itself, so an honest one is never empty.
// Null is « unknown », never « none alive »: a caller deletes nothing on it.
export function livePids(result: unknown): Set<string> | null {
  if (typeof result !== 'object' || result === null) return null
  const { exitCode, stdout } = result as { exitCode?: unknown; stdout?: unknown }
  if (exitCode !== 0) return null
  const pids = new Set(String(stdout ?? '').split('\n').map(line => line.trim()).filter(pid => /^\d+$/.test(pid)))
  return pids.size === 0 ? null : pids
}

// The supervision pane: the id names it at the engine (the open, the render's
// requestId), the title its tab while more than one pane is open — what it
// lists, by the role it was opened in. The id's spelling is the shipped type's
// own contract — letters, digits, `_` and `-`.
const PANE_ID = 'supervision'
const PANE_TITLES = { coordinator: 'Orchestrators', orchestrator: 'Agents' } as const

// The sort's one law: a row past the rotation gate outranks every row below
// it, however full each side is; within a side, the fill descends. The floor
// is any number no honest fill reaches, added to the fill so the order stays
// one comparison.
const GATE_URGENCY_FLOOR = 1000

// How often an open pane redraws on its own. A render is raised by a measure of
// this session, and a supervisor mostly waits: without a clock its rows — the
// others' fills, their ages — froze at its own last turn.
const PANE_REFRESH_MS = 20000

// The config dir, this file's own resolution: $ never crosses an import, so
// each domain that needs it spells the same two env reads itself.
async function configDir($: any): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
}

// The scripts' state root (the launcher's chains, the coordinator's record): the
// override first, else the config dir's claude-orchestrator.
async function stateDir($: any): Promise<string> {
  return (await $.env.get('ORCHESTRATOR_STATE_DIR')) ?? `${await configDir($)}/claude-orchestrator`
}

// The store's root under the module's state dir: one file per key.
function storeDir(config: string): string {
  return `${config}/claude-orchestrator/store`
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
export type WaitRecord = Pick<SessionRow, 'waiting' | 'blocks' | 'waiting_since' | 'relayed'> & { name: string | null; pid: string | null; last_waiting?: WaitKind | null }

export function waitKey(id: string): string {
  return `waits/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

// An agent's gate crossing reported (`gates/<id>`, « reported » or empty): the measure
// handler is its one writer, so it never races the relay's wait file.
export function gateKey(id: string): string {
  return `gates/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
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
  return parseWaitRecord(String(await $.fs.read(`${storeDir(await configDir($))}/${waitKey(id)}`).catch(() => '')))
}

// Written atomically: a temporary file beside it, then one rename — $.fs.write is not
// atomic, and a wait caught mid-write would read as none.
async function writeWait($: any, id: string, record: WaitRecord): Promise<void> {
  const path = `${storeDir(await configDir($))}/${waitKey(id)}`
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await $.fs.write(tmp, JSON.stringify(record) + '\n')
  const moved = await $.process.run(['mv', '-f', tmp, path], { timeoutMs: 5000 })
  if (!moved || moved.exitCode !== 0) {
    await $.process.run(['rm', '-f', tmp], { timeoutMs: 5000 }).catch(() => undefined)
    throw new Error(`the wait file ${path} could not be renamed into place`)
  }
}

// writeSession reads the key's file, merges the patch over what it finds and
// writes it back stamped: per-key writes do not collide across sessions, and
// the stamp the row is judged stale by is the write's own unless the patch
// carries one (the measure handler passes the reading's own time). The
// measure handler is the only writer of a key: a same-key race is last-writer-wins,
// at most one measure of freshness. The relay writes its own file (writeWait).
export async function writeSession($: any, id: string, patch: Partial<SessionRow>): Promise<void> {
  const path = `${storeDir(await configDir($))}/${sessionKey(id)}`
  const base: SessionRow = parseSessionRow(String(await $.fs.read(path).catch(() => ''))) ?? {
    role: null, name: null, repo: null,
    context_percent: 0, context_tokens: 0, window: 0,
    model: '', busy: false, updated_at: '',
  }
  const row: SessionRow = { ...base, ...patch, updated_at: patch.updated_at ?? new Date().toISOString() }
  await $.fs.write(path, JSON.stringify(row) + '\n')
}

// One row per live session: every file under the store's sessions directory,
// minus the dead (isStale) and the unreadable (a line caught mid-write). The
// files of the dead and the empty ones are removed as they are met — $.fs has
// no remove, rm does — so the store does not grow with every session the
// machine ever ran.
export async function readSessions($: any): Promise<Record<string, SessionRow>> {
  const dir = `${storeDir(await configDir($))}/sessions`
  let entries: { name: string; kind: string }[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return {}   // no store yet: nothing was ever written
  }
  const read: [string, string, SessionRow | null][] = []
  for (const entry of entries) {
    if (!entry || entry.kind !== 'file') continue
    const text = String(await $.fs.read(`${dir}/${entry.name}`).catch(() => ''))
    const row = parseSessionRow(text)
    const waits = `${storeDir(await configDir($))}/waits/${entry.name}`
    read.push([entry.name, text, row && withWait(row, String(await $.fs.read(waits).catch(() => '')))])
  }
  const argv = livePidsArgv(read.map(([, , row]) => String(row?.pid ?? '')))
  const alive = argv ? livePids(await $.process.run(argv, { timeoutMs: 5000 }).catch(() => null)) : new Set<string>()
  const rows: Record<string, SessionRow> = {}
  const dead: string[] = []
  const now = Date.now()
  for (const [name, text, row] of read) {
    if (row && !isStale(row, now, alive)) rows[`sessions/${name}`] = row
    else if (text === '' || row) dead.push(`${dir}/${name}`, `${storeDir(await configDir($))}/waits/${name}`, `${storeDir(await configDir($))}/gates/${name}`)
  }
  // A liveness read that failed removes nothing: its rows are drawn as alive
  // and the next read that answers sweeps the dead. Removing on it wiped the
  // whole store at every render the pane drew.
  if (alive !== null && dead.length > 0) await $.process.run(['rm', '-f', ...dead], { timeoutMs: 5000 }).catch(() => undefined)
  return rows
}

// The session's own row goes with it: removed, or — rm failing — truncated to
// empty, which the row parser reads as no row and the next read removes.
export async function deleteSession($: any, id: string): Promise<void> {
  const path = `${storeDir(await configDir($))}/${sessionKey(id)}`
  const store = storeDir(await configDir($))
  const done = await $.process.run(['rm', '-f', path, `${store}/${waitKey(id)}`, `${store}/${gateKey(id)}`], { timeoutMs: 5000 }).catch(() => null)
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

// The pane's rows, the store read end to end and sorted by rotation urgency:
// the sessions past the gate first (they are the rotation's next moves), then
// the rest, each side by fill descending. The label carries what the design
// names — the name, the role, the fill against the gate, the reading's age —
// with the gate the gauge's own double gate, so a session past it by tokens
// alone on a wide window is marked past it here too.
export function paneRows(rows: Record<string, SessionRow>): { label: string; urgency: number }[] {
  const now = Date.now()
  return Object.values(rows)
    .map(row => {
      const past = tripGate(row.context_percent, row.context_tokens, row.window).tripped
      const parts = [
        row.name ?? 'unnamed',
        row.role ?? 'no role',
        `${row.context_percent}%${past ? ' past the gate' : ''}`,
      ]
      const age = ageLabel(row.updated_at, now)
      if (age !== null) parts.push(age)
      const wait = waitLabel(row)
      if (wait !== null) parts.push(wait)
      return { label: parts.join(' · '), urgency: (past ? GATE_URGENCY_FLOOR : 0) + row.context_percent }
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
export function agentPaneRows(agents: readonly AgentView[]): { label: string; urgency: number }[] {
  const now = Date.now()
  return agents
    .map(agent => {
      const parts = [agent.name ?? agent.row?.name ?? 'unnamed', agent.status ?? 'status unknown']
      if (!agent.row) return { label: [...parts, 'not measured yet'].join(' · '), urgency: -1 }
      const past = tripGate(agent.row.context_percent, agent.row.context_tokens, agent.row.window).tripped
      parts.push(`${agent.row.context_percent}%${past ? ' past the gate' : ''}`)
      const age = ageLabel(agent.row.updated_at, now)
      if (age !== null) parts.push(age)
      return { label: parts.join(' · '), urgency: (past ? GATE_URGENCY_FLOOR : 0) + agent.row.context_percent }
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
  const terminal = String((await $.env.get('ITERM_SESSION_ID')) ?? '')
  const owner = terminal.includes(':') ? terminal.slice(terminal.lastIndexOf(':') + 1) : ''
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
      const row = parseSessionRow(String(await $.fs.read(`${storeDir(config)}/${sessionKey(record.sessionId)}`).catch(() => '')))
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

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  // Module memory: the role the pane was opened in, and the tty its agents are
  // read from — the render lists what the open asked for. A reload forgets it,
  // and the pane then asks to be opened again.
  let opened: { role: 'coordinator' | 'orchestrator'; tty: string | null } | null = null
  // The open pane's clock: started by the open, cancelled by any close.
  let ticker: { cancel(): void } | null = null
  const stopTicker = () => {
    ticker?.cancel()
    ticker = null
  }

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
        const origin = await withDeadline(repoOf($), await sideReadBoundMs($))
        await writeSession($, sessionId, {
          // A walk that did not finish leaves the row's name, role and pid as they were.
          ...(walked.known ? { role: roleOf(walked.name), name: walked.name } : {}),
          ...(walked.pid ? { pid: walked.pid } : {}),
          ...(walked.tty ? { tty: walked.tty } : {}),
          repo: isDegradedPass(origin) ? null : origin,
          context_percent: reading.context_percent,
          context_tokens: reading.context_tokens,
          window: reading.context_window,
          model: reading.model,
          busy: false,
          updated_at: reading.updated_at,
        })
        // An agent's measure past its gate: its orchestrator told once per crossing.
        if (walked.known && walked.tty && roleOf(walked.name) === 'agent') {
          const done = await withDeadline(reportGate($, sessionId, walked.name!, walked.tty, reading), RELAY_BOUND_MS)
          if (isDegradedPass(done)) await logLine($, `gate: did not finish within ${RELAY_BOUND_MS} ms`)
        }
      }
    } catch (err) {
      // A row that cannot be written, or a gate report that failed, never blocks the
      // measure: the next one writes it.
      await logLine($, (err as Error).message)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    // The registered net the plan's every-handler rule asks validate to see:
    // the measure is let through, the state dir says why, and next is
    // replay-safe in a catch, called or not.
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('session.end', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      await deleteSession($, e.sessionId ?? await $.session.id())
    } catch (err) {
      // The end is never held on the store's own failure; it is said.
      await logLine($, (err as Error).message)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The end of a main-loop turn that answered: an orchestrator's wait written to its
  // row and, once per wait, reported to a running coordinator — an agent's state to its
  // orchestrator (relayTurnEnd). Here
  // rather than at classic.Stop: a stop the gate refuses goes on in the same turn, so
  // the message a stop carries is not always the turn's last word, and the gate's own
  // deadline is not this report's to spend; turn.complete fires once the turn is over,
  // with its final answer. Bounded, and never holds the turn's end.
  on('turn.complete', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      if (!e.agentId && e.reason === 'answer') {
        const done = await withDeadline(relayTurnEnd($, String(e.answer ?? '')), RELAY_BOUND_MS)
        if (isDegradedPass(done)) await logLine($, `relay: did not finish within ${RELAY_BOUND_MS} ms`)
      }
    } catch (err) {
      await logLine($, `relay: ${(err as Error).message}`)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // A turn starts: the session works again, and a wait its row carried is over.
  on('turn.start', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      const sessionId = await $.session.id()
      const wait = await readWait($, sessionId)
      if (wait?.waiting) await writeWait($, sessionId, clearedWait(wait))
    } catch (err) {
      await logLine($, `relay: ${(err as Error).message}`)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The pane opens on the person's own command alone — the shipped types' «
  // asked » open, placed at any width — in the two supervising roles: a
  // coordinator's lists the orchestrators, an orchestrator's its own agents.
  // Anywhere else the command says so and opens nothing.
  on('command.run', { command: 'orchestrator:supervision' }, async ($: any) => {
    const { tty, name } = await walkWithinBound($, await $.session.id())
    const role = roleOf(name)
    if (role !== 'coordinator' && role !== 'orchestrator') {
      return { text: 'The supervision pane opens in a coordinator session (« Coord : … »), listing the orchestrators, or in an orchestrator session (« Orch : … »), listing its agents; /orchestrator:status lists the sessions here.' }
    }
    // A toggle: the same command closes the pane it opened (Escape does not —
    // the pane holds no focus), beside the pane's own ✕.
    const panes: readonly { id: string }[] = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE_ID)) {
      stopTicker()
      await $.ui.close({ id: PANE_ID })
      return { text: 'Supervision pane closed.' }
    }
    opened = { role, tty }
    await $.ui.open({ id: PANE_ID, title: PANE_TITLES[role] })
    stopTicker()
    ticker = $.clock.every(PANE_REFRESH_MS, () => $.ui.invalidate('ui.render'))
    return { text: 'Supervision pane opened; type /orchestrator:supervision again, or click its ✕, to close it.' }
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The pane closed by its ✕ or its key: its clock stops with it.
  on('ui.close', { id: PANE_ID }, async ($: any, e: any, next: (e: any) => any) => {
    stopTicker()
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The pane's own render: the matcher names the render envelope's component
  // and requestId — the pane's id — so the rows are drawn in this plugin's pane
  // alone and never in another plugin's.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($: any, e: any, next: (e: any) => any) => {
    try {
      // The store at draw time: the gauge's invalidate after every measure and
      // the pane's own clock re-raise this render. Display only.
      let rows: { label: string; urgency: number }[] = []
      let none = 'type /orchestrator:supervision to open the pane again'
      if (opened?.role === 'coordinator') {
        rows = paneRows(Object.fromEntries(Object.entries(await readSessions($)).filter(([, row]) => row.role === 'orchestrator')))
        none = 'no live orchestrator'
      } else if (opened?.role === 'orchestrator') {
        // Bounded like every side read: an agent list that cannot be read in
        // time draws as none, never a held render.
        const views = opened.tty ? await withDeadline(agentViews($, opened.tty), await sideReadBoundMs($)) : []
        rows = isDegradedPass(views) ? [] : agentPaneRows(views)
        none = isDegradedPass(views) ? 'the agents could not be read in time' : 'no agent running'
      }
      const el = $.ui.resolve(e)
      return el.Box({
        flexDirection: 'column',
        children: rows.length === 0
          ? [el.Text({ color: 'subtle', children: none })]
          : rows.map(row =>
            el.Text({ color: row.urgency >= GATE_URGENCY_FLOOR ? 'warning' : 'subtle', children: row.label })
          ),
      })
    } catch (err) {
      // A pane that fails to draw never blocks the render: the engine draws its own.
      await logLine($, (err as Error).message)
      return next(e)
    }
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// The bound on the whole relay at a turn's end: the row and wait reads, the wait's
// write, the coordinator's record and the send queued. Well inside a handler's ten seconds.
const RELAY_BOUND_MS = 5000

// A turn's end, read and reported. The role comes from the session's row (the measure's
// walk named it), else from a walk of its own. An orchestrator's machine line goes to the
// registered coordinator; an agent's status line to its orchestrator, found in the
// launcher's chains (orchestratorOn), never in the turn's text; any other role, nothing.
// No line: a wait the session carried is cleared, nothing is sent. A line: written to the
// session's wait file, then reported unless this very one was already — the fingerprint
// is kept only once the send is delivered. Nobody to send to: nothing is sent. A send
// refused is one log line; the turn's end is never held on it. The row itself is never
// written here: the measure is its one writer.
export async function relayTurnEnd($: any, answer: string): Promise<void> {
  const sessionId = await $.session.id()
  const row = parseSessionRow(String(await $.fs.read(`${storeDir(await configDir($))}/${sessionKey(sessionId)}`).catch(() => '')))
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
  if (!name || (role !== 'orchestrator' && role !== 'agent')) return
  const before = await readWait($, sessionId)
  const relayed = before?.relayed ?? null
  const wait = role === 'orchestrator' ? parseWait(answer) : parseStatus(answer)
  if (!wait) {
    if (before?.waiting) await writeWait($, sessionId, { ...clearedWait(before), name, pid })
    return
  }
  const patch = waitPatch(before, wait, new Date().toISOString())
  await writeWait($, sessionId, { ...patch, relayed, name, pid })
  const key = fingerprint(wait)
  if (relayed === key) return
  const to = role === 'orchestrator'
    ? coordinatorOf(String(await $.fs.read(`${await stateDir($)}/coordinator.json`).catch(() => '')))
    : tty ? await orchestratorOn($, tty) : null
  if (!to) {
    if (role === 'agent') await logLine($, `relay: no orchestrator found for ${name} on ${tty ?? 'an unknown tty'}`)
    return
  }
  const context = row && row.context_tokens > 0 ? `${row.context_tokens.toLocaleString('en-US')} (${row.context_percent}%)` : null
  const sent = await $.session.send({ to, text: relayText(name, wait, patch.waiting_since!, context) })
  if (sent?.isDelivered) {
    await writeWait($, sessionId, { ...patch, relayed: key, name, pid })
  } else {
    await logLine($, `relay: not delivered to ${to}: ${sent?.reason ?? 'no answer'}`)
  }
}

// The orchestrator an agent on `tty` reports to: the chain that names the tty
// (chainOwnerTty), then the live orchestrator row measured on that chain's tty, the
// latest if two. Null when no chain names it or no orchestrator sits there.
export async function orchestratorOn($: any, tty: string): Promise<string | null> {
  const dir = `${await stateDir($)}/chains`
  const listed: readonly { name: string; kind: string; mtimeMs?: number }[] = await $.fs.list(dir).catch(() => [])
  const chains = []
  for (const entry of listed) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
    chains.push({ name: entry.name, mtimeMs: entry.mtimeMs ?? 0, text: String(await $.fs.read(`${dir}/${entry.name}`).catch(() => '')) })
  }
  const owner = chainOwnerTty(chains, tty)
  if (!owner) return null
  const rows = `${storeDir(await configDir($))}/sessions`
  let found: SessionRow | null = null
  for (const entry of await $.fs.list(rows).catch(() => [])) {
    const row = parseSessionRow(String(await $.fs.read(`${rows}/${entry.name}`).catch(() => '')))
    if (row?.role === 'orchestrator' && row.tty === owner && row.name && (!found || row.updated_at > found.updated_at)) found = row
  }
  return found?.name ?? null
}

// An agent's measure against the gate its session runs under (the gauge's thresholds,
// read from this session's environment): past it and not yet reported, its orchestrator
// is sent the figures once; back under it, the mark is cleared for the next crossing.
export async function reportGate($: any, sessionId: string, name: string, tty: string,
  reading: { context_tokens: number; context_percent: number; context_window: number }): Promise<void> {
  const path = `${storeDir(await configDir($))}/${gateKey(sessionId)}`
  const past = tripGate(reading.context_percent, reading.context_tokens, reading.context_window, await gateEnv($)).tripped
  const reported = String(await $.fs.read(path).catch(() => '')).trim() === 'reported'
  if (past === reported) return
  if (!past) {
    await $.fs.write(path, '')
    return
  }
  const to = await orchestratorOn($, tty)
  if (!to) {
    await logLine($, `gate: no orchestrator found for ${name} on ${tty}`)
    return
  }
  const sent = await $.session.send({ to, text: gateText(name, reading.context_tokens, reading.context_percent) })
  if (sent?.isDelivered) await $.fs.write(path, 'reported\n')
  else await logLine($, `gate: not delivered to ${to}: ${sent?.reason ?? 'no answer'}`)
}

// The gate's thresholds from the environment, the gauge's own reading spelled again here
// (the $ fence): a value that is no positive number stays undefined, and tripGate applies
// the default itself.
async function gateEnv($: any): Promise<{ gate?: number; gateTokens?: number; largeWindow?: number }> {
  const threshold = (raw: string | undefined) => {
    const n = raw === undefined ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  return {
    gate: threshold(await $.env.get('ORCHESTRATOR_CONTEXT_GATE')),
    gateTokens: threshold(await $.env.get('ORCHESTRATOR_CONTEXT_GATE_TOKENS')),
    largeWindow: threshold(await $.env.get('ORCHESTRATOR_LARGE_WINDOW')),
  }
}

// One line appended to the module's log (module-log.ts): the stamp names the
// half that failed. Never throws, never blocks the handler it serves.
async function logLine($: any, message: string): Promise<void> {
  try {
    const config = await configDir($)
    await $.process.run(logArgv($.plugin.root, config, 'supervision', message), { timeoutMs: LOG_TIMEOUT_MS })
  } catch { /* the log itself never blocks the handler that failed */ }
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
// repository, never a failure.
async function repoOf($: any): Promise<string | null> {
  try {
    const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'])
    if (remote.exitCode !== 0) return null
    return /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(String(remote.stdout ?? '').trim())?.[1] ?? null
  } catch {
    return null
  }
}
