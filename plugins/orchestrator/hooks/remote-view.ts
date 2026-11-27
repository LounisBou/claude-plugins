// hooks/remote-view.ts
// A view on this Mac of each remote orchestrator the coordinator knows: one iTerm2 window per
// remote home server, `ssh <destination> 'zsh -lc "tmux -L <socket> -CC attach -t home"'`, which
// iTerm2 draws as native tabs. A view is a tmux client and nothing else: it attaches, never
// starts a server or a session, and closing it only detaches. The coordinator's reading
// (supervision.ts wakeTick) syncs the views on each tick: a row with no live view opens one, a live
// view is reused, a view that dropped is opened again while its server runs, with a fresh row or
// none, a second view of one server is closed. A
// view is live when this Mac's process table holds its ssh; that same table is what keeps one view
// per home server. The machines are mapped to an ssh destination by one file
// of the protected root (stateDir), beside the launch files it decides; a machine it does not name
// is a logged line, never a guess.
import { HOME_SHAPE, type RemoteRow } from './remote-row.ts'
import { logLine, stateDir, storeIo, writeAtomic } from './module-io.ts'
import { withLockOver } from '../core/store-io.ts'
import { messageOf, type Host } from './host.ts'

// The file that maps a machine label (a row's `machine`) to its ssh destination:
// `{ "version": 1, "machines": { "<label>": "<alias or user@host>" } }`.
export const MACHINES_FILE = 'remote-machines.json'

// The home session every home server holds (iterm_agent.py HOME_SESSION).
export const VIEW_SESSION = 'home'

// The ssh a view runs, by its absolute path: the process table tells a view from any other ssh.
const SSH = '/usr/bin/ssh'

// A view lends the remote nothing (no agent, no forwarding) and asks for nothing (no password); a
// dead link is given up within a minute and a half, so the next tick opens the view again.
const SSH_OPTIONS = [
  '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
  '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
] as const

// An ssh destination: an alias, or `user@host`, each part starting with a letter or a digit so
// that it can never read as an option.
const DEST_SHAPE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/
const DEST_CAP = 120

// A launch file's path as iTerm2 is handed it: iTerm2 splits a command into words itself, so the
// path holds no character a word break or a quote could change.
const PATH_SHAPE = /^[A-Za-z0-9._/-]+$/

// How long the check that a home server still runs may take, and the window's opening.
const CHECK_TIMEOUT_MS = 15000
const OPEN_TIMEOUT_MS = 20000
const PS_TIMEOUT_MS = 5000
// A view's lock is held across one table read, one check and one opening: past their bounds
// together, its holder was killed.
const LOCK_STALE_MS = 60000

// After an opening, or a check that did not lead to one, the next try waits this long, doubled
// at each try that shows no live view, up to the cap: a machine down or a view that dies at once
// costs one ssh per bound, never a window per tick.
export const VIEW_RETRY_MS = 30000
export const VIEW_RETRY_CAP_MS = 10 * 60 * 1000

export type Machines = ReadonlyMap<string, string>

// The machine file, checked: its version, each label a row's shape, each destination an ssh
// destination's. Labels are matched without their case, as host names are. Anything else is the
// reason it is refused.
export function parseMachines(text: string): Machines | string {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return 'it is not JSON'
  }
  const o = raw as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || Array.isArray(o) || o['version'] !== 1) return 'it is not version 1'
  const machines = o['machines']
  if (!machines || typeof machines !== 'object' || Array.isArray(machines)) return 'it has no `machines` object'
  const out = new Map<string, string>()
  for (const [label, dest] of Object.entries(machines as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(label)) return `the label '${label.slice(0, 64)}' is not a machine's`
    if (typeof dest !== 'string' || dest.length > DEST_CAP || !DEST_SHAPE.test(dest)) return `the destination of ${label} is not an ssh destination`
    out.set(label.toLowerCase(), dest)
  }
  return out
}

// The remote command of a view: the socket and the session named always, an attach and nothing
// else, through a login shell, where tmux is on the PATH.
export function viewCommand(socket: string): string {
  return `zsh -lc "tmux -L ${socket} -CC attach -t ${VIEW_SESSION}"`
}

export function viewArgv(dest: string, socket: string): string[] {
  return [SSH, '-t', ...SSH_OPTIONS, dest, viewCommand(socket)]
}

// Whether the home server still runs: has-session starts nothing on the remote.
export function checkArgv(dest: string, socket: string): string[] {
  return [SSH, ...SSH_OPTIONS, '-o', 'ConnectTimeout=10', dest, `zsh -lc "tmux -L ${socket} has-session -t ${VIEW_SESSION}"`]
}

// The launch file iTerm2 runs: the view's ssh in place of the shell, each word quoted.
export function launchScript(dest: string, socket: string): string {
  return `#!/bin/sh\nexec ${viewArgv(dest, socket).map(word => `'${word.replace(/'/g, `'\\''`)}'`).join(' ')}\n`
}

// The AppleScript that opens the window: iTerm2 runs the launch file, and the application that
// was in front is put back, so a view never takes the focus.
export function openScript(path: string): string {
  return [
    'set frontPath to ""',
    'try',
    '  set frontPath to path to frontmost application as text',
    'end try',
    `tell application "iTerm2" to create window with default profile command "/bin/sh ${path}"`,
    'if frontPath is not "" and frontPath is not (path to application id "com.googlecode.iterm2" as text) then',
    '  tell application frontPath to activate',
    'end if',
  ].join('\n')
}

export const PS_ARGV = ['ps', '-axww', '-o', 'pid=,command='] as const

export type LiveView = { pid: string; dest: string; socket: string }

// The views the process table shows: each ssh whose command is a view's, its pid, destination and
// socket. Any other process, another ssh among them, is none.
export function liveViews(stdout: string, socketShape: RegExp = HOME_SHAPE): LiveView[] {
  const head = `${SSH} -t ${SSH_OPTIONS.join(' ')} `
  const views: LiveView[] = []
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m || !m[2]!.startsWith(head)) continue
    const rest = /^(\S+) zsh -lc "tmux -L (\S+) -CC attach -t (\S+)"\s*$/.exec(m[2]!.slice(head.length))
    if (!rest || rest[3] !== VIEW_SESSION || !DEST_SHAPE.test(rest[1]!) || !socketShape.test(rest[2]!)) continue
    views.push({ pid: m[1]!, dest: rest[1]!, socket: rest[2]! })
  }
  return views
}

export type Wanted = { name: string; machine: string; dest: string; socket: string }

export function viewKey(view: { dest: string; socket: string }): string {
  return `${view.dest}|${view.socket}`
}

// What a view needs of a row.
export type ViewHome = Pick<RemoteRow, 'name' | 'machine' | 'home'>

function homeKey(machine: string, socket: string): string {
  return `${machine.toLowerCase()}|${socket}`
}

// The views the rows want: one per home server, each row that carries a home on a machine the file
// maps. A machine it does not map is returned apart, for its line.
export function wantedViews(rows: readonly ViewHome[], machines: Machines, socketShape: RegExp = HOME_SHAPE): { wanted: Wanted[]; unmapped: { name: string; machine: string }[] } {
  const wanted = new Map<string, Wanted>()
  const unmapped: { name: string; machine: string }[] = []
  for (const row of rows) {
    if (row.home === undefined || !socketShape.test(row.home)) continue
    const dest = machines.get(row.machine.toLowerCase())
    if (dest === undefined) {
      unmapped.push({ name: row.name, machine: row.machine })
      continue
    }
    const view = { name: row.name, machine: row.machine, dest, socket: row.home }
    if (!wanted.has(viewKey(view))) wanted.set(viewKey(view), view)
  }
  return { wanted: [...wanted.values()], unmapped }
}

// When each home server's next try may come: its tries since a live view was last seen.
export type Backoff = Map<string, { tries: number; nextAt: number }>

export type ViewPlan = { reuse: Wanted[]; check: Wanted[]; close: LiveView[] }

// The decision of one tick. Each home server keeps one live view, the first one: any other view
// of it is closed, so there is never two. A live view is kept while its ssh lives, whether a row
// still wants it or not: a server that ends ends its view itself, and a row past its stale bound
// says nothing of an orchestrator idle that long. A wanted server without a live view, its retry
// bound passed, is checked and opened.
export function planViews(wanted: readonly Wanted[], live: readonly LiveView[], backoff: Backoff, now: number): ViewPlan {
  const plan: ViewPlan = { reuse: [], check: [], close: [] }
  const kept = new Set<string>()
  for (const view of [...live].sort((a, b) => Number(a.pid) - Number(b.pid))) {
    const key = viewKey(view)
    if (kept.has(key)) plan.close.push(view)
    else kept.add(key)
  }
  for (const view of wanted) {
    if (kept.has(viewKey(view))) plan.reuse.push(view)
    else if ((backoff.get(viewKey(view))?.nextAt ?? 0) <= now) plan.check.push(view)
  }
  return plan
}

// One more try that showed no live view: the next one waits twice as long, up to the cap.
export function tried(backoff: Backoff, key: string, now: number): void {
  const tries = (backoff.get(key)?.tries ?? 0) + 1
  backoff.set(key, { tries, nextAt: now + Math.min(VIEW_RETRY_MS * 2 ** (tries - 1), VIEW_RETRY_CAP_MS) })
}

// The module's memory of the views: the retries, the lines already said, each said once while
// it holds, and what each view needs, kept apart from its row, which is removed 24 h after its
// last send while an idle orchestrator lives on: forgotten when its server answers that it runs
// no more.
export type ViewsMemory = { backoff: Backoff; said: Set<string>; homes: Map<string, ViewHome> }

export function newViewsMemory(): ViewsMemory {
  return { backoff: new Map(), said: new Set(), homes: new Map() }
}

// What a sync is given beside the rows. `socketShape` is a bench's own: a test server that is not
// a home server and that nothing else on the remote takes for one.
export type ViewsOptions = { now?: number; socketShape?: RegExp }

type ViewHost = Host<'clock' | 'env' | 'fs' | 'plugin' | 'process'>

async function sayOnce($: ViewHost, memory: ViewsMemory, line: string): Promise<void> {
  if (memory.said.has(line)) return
  memory.said.add(line)
  await logLine($, 'views', line)
}

// One tick: the machine file, the rows' home servers, the process table, then the plan run. No file
// or a refused one opens and closes nothing; a process table that cannot be read neither. Two ticks
// that overlap, in one module or two, open one view: each opening holds its view's lock and reads
// the table again under it (checkAndOpen).
export async function syncViews($: ViewHost, rows: readonly RemoteRow[], memory: ViewsMemory, options: ViewsOptions = {}): Promise<void> {
  const now = options.now ?? Date.now()
  const shape = options.socketShape ?? HOME_SHAPE
  const root = await stateDir($)
  const file = `${root}/${MACHINES_FILE}`
  const text = await $.fs.read(file).then(String, () => null)
  if (text === null) {
    await sayOnce($, memory, `no machine file at ${file}: no remote view is opened`)
    return
  }
  const machines = parseMachines(text)
  if (typeof machines === 'string') {
    await sayOnce($, memory, `the machine file ${file} is refused: ${machines}`)
    return
  }
  for (const { name, machine, home } of rows) {
    if (home !== undefined) memory.homes.set(homeKey(machine, home), { name, machine, home })
  }
  const { wanted, unmapped } = wantedViews([...memory.homes.values()], machines, shape)
  for (const row of unmapped) await sayOnce($, memory, `the machine ${row.machine} of ${row.name} is not in ${file}: no view of it is opened`)
  const ps = await $.process.run([...PS_ARGV], { timeoutMs: PS_TIMEOUT_MS }).catch(() => null)
  if (!ps || ps.exitCode !== 0) {
    await logLine($, 'views', 'the process table could not be read: no view is opened or closed')
    return
  }
  const plan = planViews(wanted, liveViews(String(ps.stdout ?? ''), shape), memory.backoff, now)
  for (const view of plan.reuse) memory.backoff.delete(viewKey(view))
  for (const view of plan.close) {
    // The view's ssh ends, and the client with it: the remote session is detached, never ended.
    const killed = await $.process.run(['kill', '-TERM', view.pid], { timeoutMs: PS_TIMEOUT_MS }).catch(() => null)
    await logLine($, 'views', killed?.exitCode === 0
      ? `closed a second view of ${view.socket} on ${view.dest}`
      : `the view of ${view.socket} on ${view.dest} (pid ${view.pid}) could not be closed`)
  }
  // Each try counted before the first wait: whatever runs meanwhile finds its bound set.
  for (const view of plan.check) tried(memory.backoff, viewKey(view), now)
  for (const view of plan.check) {
    try {
      await checkAndOpen($, root, view, memory, shape)
    } catch (err) {
      await logLine($, 'views', `the view of ${view.socket} on ${view.dest}: ${messageOf(err)}`)
    }
  }
}

// A home server with no live view: opened when it still runs; an ended one or a machine out of
// reach is said, and tried again after its bound. Under the view's lock, so that another session's
// module opens none at the same time, the process table is read again first: a view another one
// opened meanwhile is kept, not doubled.
async function checkAndOpen($: ViewHost, root: string, view: Wanted, memory: ViewsMemory, shape: RegExp): Promise<void> {
  const dir = `${root}/views`
  const path = `${dir}/${view.machine}-${view.socket}.sh`
  if (!PATH_SHAPE.test(path)) throw new Error(`the launch file's path ${path} cannot be handed to iTerm2`)
  const made = await $.process.run(['mkdir', '-p', dir], { timeoutMs: PS_TIMEOUT_MS })
  if (made.exitCode !== 0) throw new Error(`${dir} could not be made`)
  let taken = false
  await withLockOver(storeIo($), path, async () => {
    taken = true
    const ps = await $.process.run([...PS_ARGV], { timeoutMs: PS_TIMEOUT_MS }).catch(() => null)
    if (!ps || ps.exitCode !== 0) throw new Error('the process table could not be read again')
    if (liveViews(String(ps.stdout ?? ''), shape).some(live => viewKey(live) === viewKey(view))) return
    await openChecked($, path, view, memory)
  }, { tries: 0, staleMs: LOCK_STALE_MS }).catch((err: unknown) => {
    if (taken) throw err
  })
  if (!taken) await logLine($, 'views', `the view of ${view.socket} on ${view.dest} is being opened by another session`)
}

async function openChecked($: ViewHost, path: string, view: Wanted, memory: ViewsMemory): Promise<void> {
  const ended = `the home server ${view.socket} of ${view.name} runs no more on ${view.dest}: no view is opened`
  const checked = await $.process.run(checkArgv(view.dest, view.socket), { timeoutMs: CHECK_TIMEOUT_MS }).catch(() => null)
  if (checked?.exitCode === 1) {
    memory.homes.delete(homeKey(view.machine, view.socket))
    await sayOnce($, memory, ended)
    return
  }
  if (checked?.exitCode !== 0) {
    await logLine($, 'views', `${view.dest} could not be reached for ${view.socket} (${checked ? `exit ${checked.exitCode}` : 'no answer'}): tried again later`)
    return
  }
  memory.said.delete(ended)
  await writeAtomic($, path, launchScript(view.dest, view.socket))
  // ORCHESTRATOR_OSASCRIPT, the launcher's own stand-in (iterm_agent.py OSASCRIPT): a run that must
  // never move the operator's screen names one that opens nothing.
  const osascript = (await $.env.get('ORCHESTRATOR_OSASCRIPT')) || 'osascript'
  const opened = await $.process.run([osascript, '-e', openScript(path)], { timeoutMs: OPEN_TIMEOUT_MS }).catch(() => null)
  await logLine($, 'views', opened?.exitCode === 0
    ? `opened a view of ${view.socket} (${view.name}) on ${view.dest}`
    : `iTerm2 did not open the view of ${view.socket} on ${view.dest}${opened?.stderr ? `: ${String(opened.stderr).trim().slice(0, 200)}` : ''}`)
}
