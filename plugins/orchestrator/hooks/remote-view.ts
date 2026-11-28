// hooks/remote-view.ts
// A view on this Mac of each remote orchestrator the coordinator knows: one iTerm2 window per
// remote home server, `ssh <destination> 'zsh -lc "tmux -L <socket> -CC attach -t home"'`, which
// iTerm2 draws as native tabs. A view is a tmux client and nothing else: it attaches, never
// starts a server or a session, and closing it only detaches. The coordinator's reading
// (supervision.ts wakeTick) syncs the views on each tick: a row with no live view opens one, a live
// view is reused, a view that dropped is opened again while its server runs, with a fresh row or
// none, a second view of one server is closed. A
// view is live when this Mac's process table holds its ssh; that same table is what keeps one view
// per home server, and no view opens while the server lists a control-mode client. The machines
// are mapped to an ssh destination by one file of the protected root (stateDir), beside the launch
// files it decides, and written by the module itself: a machine the rows name and the file does not
// is looked for among the destinations its rows publish, this Mac's ssh aliases and the logins of
// ~/.env, each kept only once ssh to it answers with that machine's host name; a machine none
// proves is a logged line, never a guess. The home servers of every machine the file maps are listed
// over ssh, so a view rests on its server, not on a fresh row.
import { DEST_SHAPE, destShaped, HOME_SHAPE, machineLabel, type RemoteRow } from './remote-row.ts'
import { logLine, stateDir, storeIo, writeAtomic } from './module-io.ts'
import { updateOver, withLockOver } from '../core/store-io.ts'
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

// A launch file's path as iTerm2 is handed it: iTerm2 splits a command into words itself, so the
// path holds no character a word break or a quote could change.
const PATH_SHAPE = /^[A-Za-z0-9._/-]+$/

// How long the check that a home server still runs may take, its client list, and the window's
// opening.
const CHECK_TIMEOUT_MS = 15000
const CLIENTS_TIMEOUT_MS = 10000
const OPEN_TIMEOUT_MS = 20000
const PS_TIMEOUT_MS = 5000
// A view's lock is held across one table read, one check, one client list and one opening: past
// their bounds together, its holder was killed.
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
    if (!destShaped(dest)) return `the destination of ${label} is not an ssh destination`
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

// An ssh that reads the home server's tmux, through a login shell as the view's.
function readArgv(dest: string, command: string): string[] {
  return [SSH, ...SSH_OPTIONS, '-o', 'ConnectTimeout=10', dest, `zsh -lc "${command}"`]
}

// Whether the home server still runs: has-session starts nothing on the remote.
export function checkArgv(dest: string, socket: string): string[] {
  return readArgv(dest, `tmux -L ${socket} has-session -t ${VIEW_SESSION}`)
}

// The home server's clients, each by its flags: list-clients starts nothing on the remote either.
export function clientsArgv(dest: string, socket: string): string[] {
  return readArgv(dest, `tmux -L ${socket} list-clients -F '#{client_flags}'`)
}

// The home servers a machine runs, each socket name on a line: every `orch-*` tmux server of the
// user's that holds a `home` session. Listing and has-session start nothing on the remote. Each
// dollar is escaped from the login shell that hands zsh the line, so that zsh expands it.
export const LIST_HOMES = 'for s in \\${TMUX_TMPDIR:-/tmp}/tmux-\\$(id -u)/orch-*(N); do tmux -L \\${s:t} has-session -t ' + VIEW_SESSION + ' 2>/dev/null && echo \\${s:t}; done; true'

export function listArgv(dest: string): string[] {
  return readArgv(dest, LIST_HOMES)
}

// The home servers a listing names: the lines of a home server's shape, any other line none.
export function listedHomes(stdout: string, socketShape: RegExp = HOME_SHAPE): string[] {
  return [...new Set(stdout.split('\n').map(line => line.trim()).filter(line => socketShape.test(line)))]
}

// The probe of a destination: its host name, through no login shell, with no password asked.
export function probeArgv(dest: string): string[] {
  return [SSH, ...SSH_OPTIONS, '-o', 'ConnectTimeout=8', dest, 'hostname -s']
}

// The Host aliases of an ssh configuration: each word of a `Host` line that names one host, a
// pattern (`*`, `?`, `!`) none.
export function sshAliases(text: string): string[] {
  const aliases: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*Host\s+(.+?)\s*$/i.exec(line)
    if (!m) continue
    for (const word of m[1]!.split(/\s+/)) if (!/[*?!]/.test(word) && destShaped(word)) aliases.push(word)
  }
  return [...new Set(aliases)]
}

// The logins of the credential store: each `<NAME>_LOGIN=<login>` whose login is a user's shape. Its
// other lines are read for nothing and kept nowhere.
export function envLogins(text: string): { name: string; login: string }[] {
  const logins: { name: string; login: string }[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z][A-Za-z0-9]*)_LOGIN=(.*)$/.exec(line)
    if (!m) continue
    const login = m[2]!.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(login)) logins.push({ name: m[1]!, login })
  }
  return logins
}

// Whether a name may be a machine's: their letters and digits, one the start of the other, three at
// least (`izno` and IznoServer, MINITECH and mini-tech2). Only such names are probed, never the
// other hosts this Mac reaches.
export function namesMatch(name: string, label: string): boolean {
  const a = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  const b = label.toLowerCase().replace(/[^a-z0-9]/g, '')
  return a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))
}

// The destinations tried for a machine, in order: those its rows publish, then the aliases whose
// name is the machine's, then each such login at the machine's name and at its `.local` name.
export function candidatesFor(label: string, reach: readonly string[], aliases: readonly string[], logins: readonly { name: string; login: string }[]): string[] {
  const out = [
    ...reach,
    ...aliases.filter(alias => namesMatch(alias, label)),
    ...logins.filter(({ name }) => namesMatch(name, label)).flatMap(({ login }) => [`${login}@${label}`, `${login}@${label}.local`]),
  ]
  return [...new Set(out.filter(destShaped))]
}

// The machine file's text, its labels in order.
export function machinesText(machines: Machines): string {
  return JSON.stringify({ version: 1, machines: Object.fromEntries([...machines].sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + '\n'
}

// A client's flags as the server prints them: words, some with a value, joined by commas.
const FLAGS_SHAPE = /^[A-Za-z0-9=_-]+(?:,[A-Za-z0-9=_-]+)*$/

// Whether the client list holds a control-mode client: one line of flags per client, nothing when
// none is attached; null when a line is not a client's flags.
function controlAttached(stdout: string): boolean | null {
  if (stdout === '') return false
  const lines = stdout.replace(/\n$/, '').split('\n')
  if (!lines.every(line => FLAGS_SHAPE.test(line))) return null
  return lines.some(line => line.split(',').includes('control-mode'))
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

// How long after a listing of a machine's home servers the next one waits, when it answered.
export const LIST_EVERY_MS = 60000
const PROBE_TIMEOUT_MS = 12000
const LIST_TIMEOUT_MS = 15000

// What a sync is given beside the rows. `socketShape` is a bench's own: a test server that is not
// a home server and that nothing else on the remote takes for one. `discover` writes the machine
// file for a machine the rows name and it does not; `listHomes` lists each mapped machine's home
// servers. The coordinator's wake sets both.
export type ViewsOptions = { now?: number; socketShape?: RegExp; discover?: boolean; listHomes?: boolean }

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
  let text = await $.fs.read(file).then(String, () => null)
  if (options.discover && (text === null || typeof parseMachines(text) !== 'string')) {
    if (await discoverMachines($, file, rows, text === null ? new Map() : parseMachines(text) as Machines, memory, now)) text = await $.fs.read(file).then(String, () => null)
  }
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
  if (options.listHomes) await listHomes($, machines, memory, now, shape)
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

// Each machine the rows name and the file does not, looked for once per bound: the first candidate
// whose host name is that machine's is added to the file, under its lock, over what the file holds
// then; a file refused meanwhile is left as it is. Whether the file was written.
async function discoverMachines($: ViewHost, file: string, rows: readonly RemoteRow[], machines: Machines, memory: ViewsMemory, now: number): Promise<boolean> {
  const labels = new Map<string, { label: string; reach: string[] }>()
  for (const row of rows) {
    const key = row.machine.toLowerCase()
    if (machines.has(key)) continue
    const known = labels.get(key) ?? { label: row.machine, reach: [] }
    known.reach.push(...(row.reach ?? []))
    labels.set(key, known)
  }
  const due = [...labels].filter(([key]) => (memory.backoff.get(`find|${key}`)?.nextAt ?? 0) <= now)
  if (due.length === 0) return false
  const home = (await $.env.get('HOME') ?? '').replace(/\/+$/, '')
  const aliases = sshAliases(String(await $.fs.read(`${home}/.ssh/config`).catch(() => '')))
  const logins = envLogins(String(await $.fs.read(`${home}/.env`).catch(() => '')))
  let written = false
  for (const [key, { label, reach }] of due) {
    tried(memory.backoff, `find|${key}`, now)
    const candidates = candidatesFor(label, reach, aliases, logins)
    let found: string | null = null
    for (const dest of candidates) {
      const probed = await $.process.run(probeArgv(dest), { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null)
      if (probed?.exitCode === 0 && machineLabel(String(probed.stdout ?? '')).toLowerCase() === key) {
        found = dest
        break
      }
    }
    if (found === null) {
      await logLine($, 'views', `no destination answers as ${label} (${candidates.length} tried): tried again later`)
      continue
    }
    const dest = found
    const wrote = await updateOver(storeIo($), file, current => {
      const held = current === undefined ? new Map<string, string>() : parseMachines(current)
      if (typeof held === 'string' || held.has(key)) return undefined
      return machinesText(new Map([...held, [key, dest]]))
    }, { tries: 5 }).catch((err: unknown) => {
      void logLine($, 'views', `the machine file ${file} could not be written: ${messageOf(err)}`)
      return undefined
    })
    if (wrote === undefined) continue
    memory.backoff.delete(`find|${key}`)
    written = true
    await logLine($, 'views', `the machine ${label} answers as ${dest}: written in ${file}`)
  }
  return written
}

// The home servers of each mapped machine, listed once per bound: each one listed is remembered,
// as a row's is, and forgotten the same way, when its check answers that it runs no more
// (openChecked). A machine out of reach is tried again after its bound.
async function listHomes($: ViewHost, machines: Machines, memory: ViewsMemory, now: number, shape: RegExp): Promise<void> {
  for (const [label, dest] of machines) {
    const key = `list|${dest}`
    if ((memory.backoff.get(key)?.nextAt ?? 0) > now) continue
    const listed = await $.process.run(listArgv(dest), { timeoutMs: LIST_TIMEOUT_MS }).catch(() => null)
    if (listed?.exitCode !== 0) {
      tried(memory.backoff, key, now)
      await logLine($, 'views', `the home servers of ${label} could not be listed on ${dest} (${listed ? `exit ${listed.exitCode}` : 'no answer'}): tried again later`)
      continue
    }
    memory.backoff.set(key, { tries: 0, nextAt: now + LIST_EVERY_MS })
    for (const socket of listedHomes(String(listed.stdout ?? ''), shape)) {
      if (!memory.homes.has(homeKey(label, socket))) memory.homes.set(homeKey(label, socket), { name: socket, machine: label, home: socket })
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
  if (await heldBack($, view)) return
  await writeAtomic($, path, launchScript(view.dest, view.socket))
  // ORCHESTRATOR_OSASCRIPT, the launcher's own stand-in (iterm_agent.py OSASCRIPT): a run that must
  // never move the operator's screen names one that opens nothing.
  const osascript = (await $.env.get('ORCHESTRATOR_OSASCRIPT')) || 'osascript'
  const opened = await $.process.run([osascript, '-e', openScript(path)], { timeoutMs: OPEN_TIMEOUT_MS }).catch(() => null)
  await logLine($, 'views', opened?.exitCode === 0
    ? `opened a view of ${view.socket} (${view.name}) on ${view.dest}`
    : `iTerm2 did not open the view of ${view.socket} on ${view.dest}${opened?.stderr ? `: ${String(opened.stderr).trim().slice(0, 200)}` : ''}`)
}

// iTerm2 refuses a second control-mode attach to a server it holds, with a modal that waits for a
// hand. The process table does not show every view that holds one, so the server is asked for its
// clients before an opening; a list that cannot be read opens nothing either.
async function heldBack($: ViewHost, view: Wanted): Promise<boolean> {
  const listed = await $.process.run(clientsArgv(view.dest, view.socket), { timeoutMs: CLIENTS_TIMEOUT_MS }).catch(() => null)
  const control = listed?.exitCode === 0 ? controlAttached(String(listed.stdout ?? '')) : null
  if (control === false) return false
  const why = !listed ? 'no answer' : listed.exitCode !== 0 ? `exit ${listed.exitCode}` : 'a line is not a client\'s flags'
  await logLine($, 'views', control
    ? `a control-mode client is attached to ${view.socket} on ${view.dest}: no second view is opened, tried again later`
    : `the clients of ${view.socket} on ${view.dest} could not be read (${why}): no view is opened, tried again later`)
  return true
}
