// hooks/tests/remote-view.test.ts
// The coordinator's views of the remote orchestrators (remote-view.ts): one view per remote home
// server, opened when none is live, reused when one is, opened again when it dropped, a second one
// closed, a live one kept whatever the rows say; one opening of a view at a time, in a module or
// across sessions; a machine the file does not map is a line, never a guess; a view names
// its socket and its session always, attaches and nothing else, and its close only ends this Mac's ssh.
// The fakes play ssh, the process table and iTerm2.
import { expect, test } from 'claude-code/testing'
import {
  LIST_EVERY_MS, candidatesFor, envLogins, listArgv, listedHomes, machinesText, namesMatch, probeArgv, sshAliases,
  MACHINES_FILE, VIEW_RETRY_MS, VIEW_RETRY_CAP_MS, checkArgv, clientsArgv, launchScript, liveViews, newViewsMemory, parseMachines, planViews,
  syncViews, tried, viewArgv, viewCommand, wantedViews, type Backoff, type LiveView, type ViewsMemory,
} from '../remote-view.ts'
import { HOME_SHAPE, homeOf, parseRemoteRow, remoteRowOf, rowIsNews, rowSent, rowText, type RemoteRow } from '../remote-row.ts'
import { lockRun, logLineOf } from './fakes.ts'
import { hostOf } from '../../core/capture.ts'
import type { SessionRow } from '../supervision.ts'

const HOME = '/tmp/h'
const STATE = `${HOME}/.claude/claude-orchestrator`
const FILE = `${STATE}/${MACHINES_FILE}`
const SOCKET = 'orch-cdc52505'
const OTHER = 'orch-5af6af6f'
const NOW = Date.parse('2026-11-27T15:00:00Z')

function row(over: Partial<RemoteRow> = {}): RemoteRow {
  return {
    name: 'Orch: far', role: 'orchestrator', context_tokens: 1, context_percent: 1, window: 100,
    waiting: null, blocks: null, waiting_since: null, updated_at: new Date(NOW).toISOString(), machine: 'IznoServer',
    repo: null, prs: [], held: null, account: null, agents: null, home: SOCKET, ...over,
  }
}

const machines = (map: Record<string, string> = { iznoserver: 'izno', Minitech: 'me@minitech' }) => JSON.stringify({ version: 1, machines: map })

// A process table line of a view as ps prints it: the argv joined by spaces.
const psLine = (pid: number, dest: string, socket: string) => `${pid} ${viewArgv(dest, socket).join(' ')}`

// `opensShow`: an opening puts its view's ssh in the table, as iTerm2 does once it runs the file.
// `hold`: the check of that socket waits until `release` is called. `rejects`: the check of that
// socket rejects (a run that timed out). `failWrite`: the launch file of that socket is not renamed.
// `clients`: what the server's client list prints, nobody attached by default. `clientsRead`: that
// list's run exits as a dead link does, or rejects.
type World = {
  live: string[]; servers: Set<string>; unreachable: Set<string>; psFails?: boolean; osaFails?: boolean
  opensShow?: boolean; hold?: string; rejects?: string; failWrite?: string
  clients?: string; clientsRead?: 'fails' | 'rejects'
  // What `hostname -s` prints through each destination (none: out of reach), and what the listing
  // of each destination's home servers prints (none: out of reach).
  hosts?: Record<string, string>; homes?: Record<string, string>
}

function fake(world: Partial<World> = {}, file: string | null = machines(), env: Record<string, string> = {}, shared?: Map<string, string>) {
  const w: World = { live: [], servers: new Set([`izno|${SOCKET}`, `me@minitech|${OTHER}`]), unreachable: new Set(), ...world }
  const files = shared ?? new Map<string, string>()
  const state = env['ORCHESTRATOR_STATE_DIR'] ?? STATE
  if (file !== null) files.set(`${state}/${MACHINES_FILE}`, file)
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => { release = resolve })
  let pid = 900
  const runs: string[][] = []
  const logged: string[] = []
  const dollar = hostOf({
    env: { get: async (name: string) => ({ HOME, ...env } as Record<string, string>)[name] },
    plugin: { root: '/plugins/orch-root' },
    clock: { after: () => ({ cancel: () => undefined }), sleep: async () => undefined },
    fs: {
      read: async (p: string) => {
        const text = files.get(p)
        if (text === undefined) throw new Error(`ENOENT: ${p}`)
        return text
      },
      write: async (p: string, text: string) => { files.set(p, text) },
      exists: async (p: string) => files.has(p),
      list: async () => [],
      stat: async (p: string) => { throw new Error(`ENOENT: ${p}`) },
    },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf(argv)
        if (line !== null) {
          logged.push(line)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        const locked = lockRun(argv, files)
        if (locked) return locked
        runs.push([...argv])
        const ok = { exitCode: 0, stdout: '', stderr: '' }
        if (argv[0] === 'rm') {
          for (const p of argv.slice(2)) files.delete(p)
          return ok
        }
        if (argv[0] === 'ps') return w.psFails ? { exitCode: 1, stdout: '', stderr: 'no' } : { exitCode: 0, stdout: ['1 /sbin/launchd', '77 ssh izno', ...w.live].join('\n') + '\n', stderr: '' }
        if (argv[0] === '/usr/bin/ssh') {
          const dest = argv[argv.length - 2]!
          const remote = argv[argv.length - 1]!
          const answer = (text: string | undefined) => text === undefined ? { exitCode: 255, stdout: '', stderr: 'timeout' } : { ...ok, stdout: text }
          if (remote === 'hostname -s') return answer(w.hosts?.[dest] === undefined ? undefined : `${w.hosts[dest]}\n`)
          if (remote.includes('orch-*(N)')) return answer(w.homes?.[dest])
          const socket = /-L (\S+)/.exec(remote)![1]!
          if (w.hold === socket) await held
          if (w.rejects === socket) throw new Error('timed out')
          if (w.unreachable.has(dest)) return { exitCode: 255, stdout: '', stderr: 'timeout' }
          if (!w.servers.has(`${dest}|${socket}`)) return { exitCode: 1, stdout: '', stderr: 'no server running' }
          if (!argv[argv.length - 1]!.includes(' list-clients ')) return ok
          if (w.clientsRead === 'rejects') throw new Error('timed out')
          if (w.clientsRead === 'fails') return { exitCode: 255, stdout: '', stderr: 'timeout' }
          return { ...ok, stdout: w.clients ?? '' }
        }
        if (argv[0] === 'mv') {
          if (w.failWrite && argv[3]!.includes(w.failWrite)) return { exitCode: 1, stdout: '', stderr: 'denied' }
          files.set(argv[3]!, files.get(argv[2]!)!)
          files.delete(argv[2]!)
          return ok
        }
        if (argv[0] === 'osascript') {
          if (w.osaFails) return { exitCode: 1, stdout: '', stderr: 'iTerm2 got an error' }
          const launched = /views\/[^-]+-(\S+)\.sh"/.exec(argv[2]!)
          const text = launched ? files.get(`${state}/views/IznoServer-${launched[1]}.sh`) ?? files.get(`${state}/views/Minitech-${launched[1]}.sh`) : undefined
          const dest = text ? /'(izno|me@minitech)'/.exec(text)?.[1] : undefined
          if (w.opensShow && launched && dest) w.live.push(psLine(pid++, dest, launched[1]!))
          return ok
        }
        return ok
      },
    },
  })
  return { dollar, files, runs, logged, world: w, release: () => release() }
}

const opens = (runs: string[][]) => runs.filter(argv => argv[0] === 'osascript')
const kills = (runs: string[][]) => runs.filter(argv => argv[0] === 'kill')
// Whether an ssh run is the client list asked right after the check of the same server.
const listsWhatWasChecked = (argv: string[], before: string[] | undefined) => {
  const socket = /-L (\S+)/.exec(before?.[before.length - 1] ?? '')?.[1]
  if (before === undefined || socket === undefined) return false
  const dest = before[before.length - 2]!
  return before.join(' ') === checkArgv(dest, socket).join(' ') && argv.join(' ') === clientsArgv(dest, socket).join(' ')
}
// Every ssh run, so that none goes unseen. An opening asks its server twice: the client list that
// directly follows its server's check counts with it, any other one counts of its own.
const checks = (runs: string[][]) => {
  const ssh = runs.filter(argv => argv[0] === '/usr/bin/ssh')
  return ssh.filter((argv, i) => !listsWhatWasChecked(argv, ssh[i - 1]))
}

// --- the command -------------------------------------------------------------------------

test('a view names its socket and its session, attaches and nothing else, and lends the remote nothing', () => {
  const argv = viewArgv('izno', SOCKET)
  expect(argv[0]).toBe('/usr/bin/ssh')
  expect(argv[argv.length - 1]).toBe(`zsh -lc "tmux -L ${SOCKET} -CC attach -t home"`)
  expect(argv[argv.length - 2]).toBe('izno')
  for (const option of ['BatchMode=yes', 'ForwardAgent=no', 'ClearAllForwardings=yes']) expect(argv).toContain(option)
  for (const word of ['new-session', '-A', 'kill-session', 'kill-server']) expect(argv.join(' ')).not.toContain(word)
  expect(checkArgv('izno', SOCKET)[checkArgv('izno', SOCKET).length - 1]).toBe(`zsh -lc "tmux -L ${SOCKET} has-session -t home"`)
  expect(launchScript('me@minitech', SOCKET)).toBe(`#!/bin/sh\nexec ${viewArgv('me@minitech', SOCKET).map(w => `'${w}'`).join(' ')}\n`)
  expect(viewCommand(SOCKET)).not.toMatch(/tmux (?!-L)/)
})

test('both ssh runs carry every option, the view the dead-link bound too', () => {
  const options = ['-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3']
  expect(viewArgv('izno', SOCKET)).toEqual(['/usr/bin/ssh', '-t', ...options, 'izno', `zsh -lc "tmux -L ${SOCKET} -CC attach -t home"`])
  expect(checkArgv('izno', SOCKET)).toEqual(['/usr/bin/ssh', ...options, '-o', 'ConnectTimeout=10', 'izno', `zsh -lc "tmux -L ${SOCKET} has-session -t home"`])
})

test('the machine file maps labels to destinations, and refuses what is no destination', () => {
  const ok = parseMachines(machines())
  expect(typeof ok).toBe('object')
  expect((ok as Map<string, string>).get('minitech')).toBe('me@minitech')
  for (const dest of ['-oProxyCommand=x', 'me@-oProxyCommand=x', 'a b', 'izno;rm', '', 'x'.repeat(121)]) {
    expect(typeof parseMachines(machines({ izno: dest }))).toBe('string')
  }
  expect(typeof parseMachines('{')).toBe('string')
  expect(typeof parseMachines(JSON.stringify({ version: 2, machines: {} }))).toBe('string')
  expect(typeof parseMachines(JSON.stringify({ version: 1 }))).toBe('string')
  expect(typeof parseMachines(JSON.stringify({ version: 1, machines: { 'a b': 'izno' } }))).toBe('string')
})

test('the process table shows the views alone, and no other ssh', () => {
  const table = [psLine(10, 'izno', SOCKET), '11 ssh -t izno zsh -lc "tmux -L orch-cdc52505 -CC attach -t home"', '12 /usr/bin/ssh izno', psLine(13, 'izno', 'nothome')].join('\n')
  expect(liveViews(table)).toEqual([{ pid: '10', dest: 'izno', socket: SOCKET }])
})

// --- the decision ------------------------------------------------------------------------

test('one view per home server: two rows of one server want one view, and a second live view is closed', () => {
  const machinesMap = parseMachines(machines()) as Map<string, string>
  const { wanted } = wantedViews([row(), row({ name: 'Orch: far2' })], machinesMap)
  expect(wanted.length).toBe(1)
  const live: LiveView[] = [{ pid: '30', dest: 'izno', socket: SOCKET }, { pid: '20', dest: 'izno', socket: SOCKET }]
  const plan = planViews(wanted, live, new Map(), NOW)
  expect(plan.reuse.length).toBe(1)
  expect(plan.check).toEqual([])
  expect(plan.close).toEqual([{ pid: '30', dest: 'izno', socket: SOCKET }])
})

test('a row without a home, or with a home of another shape, wants no view', () => {
  const machinesMap = parseMachines(machines()) as Map<string, string>
  const bare = row()
  delete bare.home
  expect(wantedViews([bare, row({ home: 'orch-../x' })], machinesMap).wanted).toEqual([])
})

test('a retry bound not passed holds the check back, and one passed lets it run', () => {
  const memory = newViewsMemory()
  const wanted = wantedViews([row()], parseMachines(machines()) as Map<string, string>).wanted
  expect(planViews(wanted, [], memory.backoff, NOW).check.length).toBe(1)
  memory.backoff.set(`izno|${SOCKET}`, { tries: 1, nextAt: NOW + VIEW_RETRY_MS })
  expect(planViews(wanted, [], memory.backoff, NOW + VIEW_RETRY_MS - 1).check.length).toBe(0)
  expect(planViews(wanted, [], memory.backoff, NOW + VIEW_RETRY_MS).check.length).toBe(1)
  expect(VIEW_RETRY_CAP_MS).toBeGreaterThan(VIEW_RETRY_MS)
})

// --- the sync ----------------------------------------------------------------------------

test('a row with no live view opens one, its launch file the view and the front application put back', async () => {
  const fx = fake()
  await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
  expect(opens(fx.runs).length).toBe(1)
  const script = opens(fx.runs)[0]![2]!
  const path = `${STATE}/views/IznoServer-${SOCKET}.sh`
  expect(script).toContain(`create window with default profile command "/bin/sh ${path}"`)
  expect(script).toContain('tell application frontPath to activate')
  expect(fx.files.get(path)).toBe(launchScript('izno', SOCKET))
  expect(fx.logged.some(line => line.includes(`opened a view of ${SOCKET}`))).toBe(true)
})

test('a live view is reused: nothing is checked, opened or closed', async () => {
  const fx = fake({ live: [psLine(40, 'izno', SOCKET)] })
  await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
  expect(checks(fx.runs)).toEqual([])
  expect(opens(fx.runs)).toEqual([])
  expect(kills(fx.runs)).toEqual([])
})

test('a view that dropped is opened again on the next tick its bound allows, and never twice while it lives', async () => {
  const fx = fake({ live: [psLine(40, 'izno', SOCKET)] })
  const memory = newViewsMemory()
  await syncViews(fx.dollar, [row()], memory, { now: NOW })
  fx.world.live = []
  await syncViews(fx.dollar, [row()], memory, { now: NOW + 30000 })
  expect(opens(fx.runs).length).toBe(1)
  // Its ssh shows in the table now: the next tick reuses it.
  fx.world.live = [psLine(41, 'izno', SOCKET)]
  await syncViews(fx.dollar, [row()], memory, { now: NOW + 60000 })
  expect(opens(fx.runs).length).toBe(1)
  // Dropped again: opened again at once, its bound reset by the live view, however long it was.
  memory.backoff.set(`izno|${SOCKET}`, { tries: 6, nextAt: NOW + VIEW_RETRY_CAP_MS })
  await syncViews(fx.dollar, [row()], memory, { now: NOW + 61000 })
  fx.world.live = []
  await syncViews(fx.dollar, [row()], memory, { now: NOW + 62000 })
  expect(opens(fx.runs).length).toBe(2)
})

test('an opening the table does not show yet is not opened again before its bound', async () => {
  const fx = fake()
  const memory = newViewsMemory()
  await syncViews(fx.dollar, [row()], memory, { now: NOW })
  await syncViews(fx.dollar, [row()], memory, { now: NOW + 1000 })
  expect(opens(fx.runs).length).toBe(1)
  await syncViews(fx.dollar, [row()], memory, { now: NOW + VIEW_RETRY_MS })
  expect(opens(fx.runs).length).toBe(2)
  await syncViews(fx.dollar, [row()], memory, { now: NOW + 2 * VIEW_RETRY_MS })
  expect(opens(fx.runs).length).toBe(2)
})

test('a live view no row wants is kept: a row past its stale bound says nothing of its orchestrator\'s end', async () => {
  const fx = fake({ live: [psLine(50, 'izno', SOCKET), psLine(51, 'me@minitech', OTHER)] })
  await syncViews(fx.dollar, [], newViewsMemory(), { now: NOW })
  expect(kills(fx.runs)).toEqual([])
  expect(checks(fx.runs)).toEqual([])
  expect(opens(fx.runs)).toEqual([])
})

test('a view that dropped is opened again with no fresh row, while its server runs', async () => {
  const fx = fake({ live: [psLine(40, 'izno', SOCKET)] })
  const memory = newViewsMemory()
  await syncViews(fx.dollar, [row()], memory, { now: NOW })
  // The row passed its stale bound and is gone, then the Mac slept and the ssh died.
  fx.world.live = []
  await syncViews(fx.dollar, [], memory, { now: NOW + 25 * 60 * 60 * 1000 })
  expect(opens(fx.runs).length).toBe(1)
  expect(fx.files.get(`${STATE}/views/IznoServer-${SOCKET}.sh`)).toBe(launchScript('izno', SOCKET))
})

test('with no row, a server out of reach is tried again, and one that answers it runs no more is forgotten', async () => {
  const fx = fake({ unreachable: new Set(['izno']) })
  const memory = newViewsMemory()
  await syncViews(fx.dollar, [row()], memory, { now: NOW })
  await syncViews(fx.dollar, [], memory, { now: NOW + VIEW_RETRY_CAP_MS })
  expect(checks(fx.runs).length).toBe(2)
  fx.world.unreachable.clear()
  fx.world.servers.clear()
  await syncViews(fx.dollar, [], memory, { now: NOW + 2 * VIEW_RETRY_CAP_MS })
  expect(checks(fx.runs).length).toBe(3)
  await syncViews(fx.dollar, [], memory, { now: NOW + 3 * VIEW_RETRY_CAP_MS })
  expect(checks(fx.runs).length).toBe(3)
  expect(opens(fx.runs)).toEqual([])
})

test('a second view of a server is closed by ending its ssh alone, never by a tmux command, on each server', async () => {
  const fx = fake({ live: [psLine(50, 'izno', SOCKET), psLine(52, 'izno', SOCKET), psLine(51, 'me@minitech', OTHER), psLine(53, 'me@minitech', OTHER)] })
  await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
  expect(kills(fx.runs)).toEqual([['kill', '-TERM', '52'], ['kill', '-TERM', '53']])
  expect(fx.runs.some(argv => argv.join(' ').includes('kill-'))).toBe(false)
  expect(checks(fx.runs)).toEqual([])
})

test('each live orchestrator gets its view: two rows on two servers open two', async () => {
  const fx = fake()
  await syncViews(fx.dollar, [row(), row({ name: 'Orch: mini', machine: 'Minitech', home: OTHER })], newViewsMemory(), { now: NOW })
  expect(opens(fx.runs).length).toBe(2)
  expect(fx.files.get(`${STATE}/views/IznoServer-${SOCKET}.sh`)).toBe(launchScript('izno', SOCKET))
  expect(fx.files.get(`${STATE}/views/Minitech-${OTHER}.sh`)).toBe(launchScript('me@minitech', OTHER))
})

test('a tick that comes while a sync runs opens no second view: one opening per server', async () => {
  const fx = fake({ hold: SOCKET, opensShow: true })
  const memory = newViewsMemory()
  const rows = [row(), row({ name: 'Orch: mini', machine: 'Minitech', home: OTHER })]
  const first = syncViews(fx.dollar, rows, memory, { now: NOW })
  await new Promise(resolve => setTimeout(resolve, 5))
  await syncViews(fx.dollar, rows, memory, { now: NOW + 31000 })
  fx.release()
  await first
  await syncViews(fx.dollar, rows, memory, { now: NOW + 62000 })
  expect(opens(fx.runs).length).toBe(2)
  expect(kills(fx.runs)).toEqual([])
})

test('every server to check has its bound set before the first wait', async () => {
  const fx = fake({ hold: SOCKET })
  const memory = newViewsMemory()
  const first = syncViews(fx.dollar, [row(), row({ name: 'Orch: mini', machine: 'Minitech', home: OTHER })], memory, { now: NOW })
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(memory.backoff.get(`me@minitech|${OTHER}`)?.nextAt).toBe(NOW + VIEW_RETRY_MS)
  fx.release()
  await first
})

test('two sessions\' modules open one view: the second waits on the view\'s lock, then finds the first one\'s view live', async () => {
  const files = new Map<string, string>()
  const world = { live: [] as string[], opensShow: true, hold: SOCKET }
  const a = fake(world, machines(), {}, files)
  const b = fake({}, machines(), {}, files)
  b.world.live = a.world.live
  const first = syncViews(a.dollar, [row()], newViewsMemory(), { now: NOW })
  await new Promise(resolve => setTimeout(resolve, 5))
  await syncViews(b.dollar, [row()], newViewsMemory(), { now: NOW })
  expect(b.logged.some(line => line.includes('is being opened by another session'))).toBe(true)
  a.release()
  await first
  await syncViews(b.dollar, [row()], newViewsMemory(), { now: NOW + 1000 })
  expect(opens(a.runs).length + opens(b.runs).length).toBe(1)
})

test('a view another session opened between the table read and the lock is kept, not doubled', async () => {
  const fx = fake()
  const read = fx.dollar.process.run
  let tables = 0
  Object.assign(fx.dollar.process, {
    run: async (argv: readonly string[], init?: object) => {
      if (argv[0] === 'ps' && ++tables === 2) fx.world.live.push(psLine(70, 'izno', SOCKET))
      return read(argv, init)
    },
  })
  await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
  expect(checks(fx.runs)).toEqual([])
  expect(opens(fx.runs)).toEqual([])
})

// A view's lock left in place, `age` ms old.
function lockedFor(age: number) {
  const fx = fake()
  const lock = `${STATE}/views/IznoServer-${SOCKET}.sh.lock`
  fx.files.set(lock, '1\n')
  const since = Date.now() - age
  Object.assign(fx.dollar.fs, { stat: async (p: string) => { if (p !== lock) throw new Error(`ENOENT: ${p}`); return { kind: 'file', size: 2, mtimeMs: since } } })
  return fx
}

// 45 s: past core's own 30 s, within the holder's bounds summed (a table read, a check, a client
// list, an opening).
test('a lock its holder may still hold is left to it: nothing is opened', async () => {
  const fx = lockedFor(45000)
  await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
  expect(checks(fx.runs)).toEqual([])
  expect(opens(fx.runs)).toEqual([])
  expect(fx.logged.filter(line => line.includes('is being opened by another session')).length).toBe(1)
})

test('every run under the lock is bounded, and a lock aged by the bounds through the opening is left to its holder', async () => {
  const holder = fake()
  const lock = `${STATE}/views/IznoServer-${SOCKET}.sh.lock`
  const run = holder.dollar.process.run
  const under: { program: string; timeoutMs: number | undefined }[] = []
  Object.assign(holder.dollar.process, {
    run: async (argv: readonly string[], init?: { timeoutMs?: number }) => {
      if (holder.files.has(lock)) under.push({ program: argv[0]!, timeoutMs: init?.timeoutMs })
      return run(argv, init)
    },
  })
  await syncViews(holder.dollar, [row()], newViewsMemory(), { now: NOW })
  const opening = under.slice(0, under.findIndex(u => u.program === 'osascript') + 1)
  expect(opening.map(u => u.program)).toEqual(['ps', '/usr/bin/ssh', '/usr/bin/ssh', 'mv', 'osascript'])
  expect(under.filter(u => !(u.timeoutMs! > 0))).toEqual([])
  const fx = lockedFor(opening.reduce((sum, u) => sum + u.timeoutMs!, 0))
  await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
  expect(checks(fx.runs)).toEqual([])
  expect(opens(fx.runs)).toEqual([])
})

test('a lock a killed holder left is taken over, and its view opened', async () => {
  const fx = lockedFor(61000)
  await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
  expect(opens(fx.runs).length).toBe(1)
})

test('a process table that cannot be read again under the lock opens nothing, and is said', async () => {
  for (const second of ['fails', 'rejects']) {
    const fx = fake()
    const run = fx.dollar.process.run
    let tables = 0
    Object.assign(fx.dollar.process, {
      run: async (argv: readonly string[], init?: object) => {
        if (argv[0] === 'ps' && ++tables === 2) {
          if (second === 'rejects') throw new Error('timed out')
          return { exitCode: 1, stdout: '', stderr: 'no' }
        }
        return run(argv, init)
      },
    })
    await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
    expect(tables).toBe(2)
    expect(checks(fx.runs)).toEqual([])
    expect(opens(fx.runs)).toEqual([])
    expect(fx.logged.filter(line => line.includes('the process table could not be read again')).length).toBe(1)
  }
})

test('a home server that runs no more opens no view, said once', async () => {
  const fx = fake({ servers: new Set() })
  const memory = newViewsMemory()
  await syncViews(fx.dollar, [row()], memory, { now: NOW })
  await syncViews(fx.dollar, [row()], memory, { now: NOW + VIEW_RETRY_MS })
  expect(checks(fx.runs).length).toBe(2)
  expect(opens(fx.runs)).toEqual([])
  expect(fx.logged.filter(line => line.includes('runs no more')).length).toBe(1)
})

test('a machine out of reach opens nothing, and is tried again after its bound', async () => {
  const fx = fake({ unreachable: new Set(['izno']) })
  const memory: ViewsMemory = newViewsMemory()
  await syncViews(fx.dollar, [row()], memory, { now: NOW })
  await syncViews(fx.dollar, [row()], memory, { now: NOW + 1000 })
  expect(checks(fx.runs).length).toBe(1)
  expect(opens(fx.runs)).toEqual([])
  expect(fx.logged.some(line => line.includes('could not be reached'))).toBe(true)
})

test('a machine the file does not map is a line, said once, and no ssh is run', async () => {
  const fx = fake()
  const memory = newViewsMemory()
  await syncViews(fx.dollar, [row({ machine: 'Elsewhere' })], memory, { now: NOW })
  await syncViews(fx.dollar, [row({ machine: 'Elsewhere' })], memory, { now: NOW + 30000 })
  expect(checks(fx.runs)).toEqual([])
  expect(fx.logged.filter(line => line.includes('the machine Elsewhere of Orch: far is not in')).length).toBe(1)
})

test('no machine file, or a refused one, opens and closes nothing', async () => {
  for (const file of [null, '{']) {
    const fx = fake({ live: [psLine(60, 'izno', OTHER)] }, file)
    await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
    expect(fx.runs).toEqual([])
    expect(fx.logged.length).toBe(1)
  }
})

test('a process table that cannot be read opens and closes nothing', async () => {
  const fx = fake({ psFails: true })
  await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
  expect(checks(fx.runs)).toEqual([])
  expect(opens(fx.runs)).toEqual([])
})

test('an opening iTerm2 refused is said and tried again after its bound', async () => {
  const fx = fake({ osaFails: true })
  const memory = newViewsMemory()
  await syncViews(fx.dollar, [row()], memory, { now: NOW })
  expect(fx.logged.some(line => line.includes('iTerm2 did not open the view'))).toBe(true)
  await syncViews(fx.dollar, [row()], memory, { now: NOW + 1000 })
  expect(opens(fx.runs).length).toBe(1)
})

test('a bench names its own socket shape: a test server is opened, a home server of that bench is not', async () => {
  const fx = fake({ servers: new Set(['izno|remoteview-b-e2e']) })
  await syncViews(fx.dollar, [row({ home: 'remoteview-b-e2e' }), row({ name: 'Orch: other' })], newViewsMemory(), { now: NOW, socketShape: /^remoteview-b-[0-9a-z]+$/ })
  expect(opens(fx.runs).length).toBe(1)
  expect(checks(fx.runs).length).toBe(1)
})

test('the opening runs the launcher\'s osascript stand-in when one is named', async () => {
  const fx = fake({}, machines(), { ORCHESTRATOR_OSASCRIPT: '/usr/bin/false' })
  await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
  expect(opens(fx.runs)).toEqual([])
  expect(fx.runs.filter(argv => argv[0] === '/usr/bin/false').length).toBe(1)
})

test('a launch file\'s path iTerm2 would split is refused: nothing handed to it, one line', async () => {
  const fx = fake({}, machines(), { ORCHESTRATOR_STATE_DIR: '/tmp/a b/state' })
  await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
  expect(opens(fx.runs)).toEqual([])
  expect(fx.logged.filter(line => line.includes('cannot be handed to iTerm2')).length).toBe(1)
})

test('one view that fails leaves the next to open, and waits for its own bound', async () => {
  const fx = fake({ failWrite: SOCKET })
  const memory = newViewsMemory()
  const rows = [row(), row({ name: 'Orch: mini', machine: 'Minitech', home: OTHER })]
  await syncViews(fx.dollar, rows, memory, { now: NOW })
  expect(opens(fx.runs).length).toBe(1)
  expect(opens(fx.runs)[0]![2]).toContain(OTHER)
  delete fx.world.failWrite
  await syncViews(fx.dollar, rows, memory, { now: NOW + 1000 })
  expect(checks(fx.runs).length).toBe(2)
  await syncViews(fx.dollar, rows, memory, { now: NOW + VIEW_RETRY_MS })
  expect(opens(fx.runs).length).toBe(3)
})

test('a check with no answer opens nothing, and sets its bound', async () => {
  const fx = fake({ rejects: SOCKET })
  const memory = newViewsMemory()
  await syncViews(fx.dollar, [row()], memory, { now: NOW })
  expect(opens(fx.runs)).toEqual([])
  expect([...fx.files.keys()].some(p => p.endsWith('.sh'))).toBe(false)
  expect(fx.logged.filter(line => line.includes('no answer')).length).toBe(1)
  expect(memory.backoff.get(`izno|${SOCKET}`)?.nextAt).toBe(NOW + VIEW_RETRY_MS)
})

test('the retry bound doubles at each try and stops at its cap', () => {
  const backoff: Backoff = new Map()
  const bounds: number[] = []
  for (let i = 0; i < 10; i++) {
    tried(backoff, 'k', NOW)
    bounds.push(backoff.get('k')!.nextAt - NOW)
  }
  expect(bounds.slice(0, 4)).toEqual([VIEW_RETRY_MS, 2 * VIEW_RETRY_MS, 4 * VIEW_RETRY_MS, 8 * VIEW_RETRY_MS])
  expect(bounds[9]).toBe(VIEW_RETRY_CAP_MS)
  expect(VIEW_RETRY_CAP_MS).toBe(10 * 60 * 1000)
})

// --- a view already attached --------------------------------------------------------------

// A client's flags as the server lists them: a control-mode client's, and a plain terminal's.
const CONTROL = 'attached,focused,control-mode,UTF-8\n'
const PLAIN = 'attached,focused,UTF-8\n'
const launched = (files: Map<string, string>) => [...files.keys()].some(p => p.endsWith('.sh'))

test('the client list is read with the options of the check, each client\'s flags and nothing else', () => {
  expect(clientsArgv('izno', SOCKET)).toEqual([...checkArgv('izno', SOCKET).slice(0, -1), `zsh -lc "tmux -L ${SOCKET} list-clients -F '#{client_flags}'"`])
})

test('a server with a control-mode client gets no open though the table shows no view, until that client leaves', async () => {
  const fx = fake({ clients: PLAIN + CONTROL })
  const memory = newViewsMemory()
  await syncViews(fx.dollar, [row()], memory, { now: NOW })
  expect(opens(fx.runs)).toEqual([])
  expect(launched(fx.files)).toBe(false)
  expect(fx.logged.filter(line => line.includes('a control-mode client is attached')).length).toBe(1)
  fx.world.clients = ''
  await syncViews(fx.dollar, [row()], memory, { now: NOW + VIEW_RETRY_MS })
  expect(opens(fx.runs).length).toBe(1)
})

test('a client that is not in control mode holds no open back, and the list is read last before it', async () => {
  const fx = fake({ clients: PLAIN })
  await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
  const asked = fx.runs.filter(argv => argv[0] === '/usr/bin/ssh' || argv[0] === 'osascript')
  expect(asked.slice(0, 2)).toEqual([checkArgv('izno', SOCKET), clientsArgv('izno', SOCKET)])
  expect(asked.map(argv => argv[0])).toEqual(['/usr/bin/ssh', '/usr/bin/ssh', 'osascript'])
})

test('a client list that fails, gets no answer or is not one opens nothing, and says why', async () => {
  const cases: [Partial<World>, string][] = [
    [{ clientsRead: 'fails' }, 'exit 255'],
    [{ clientsRead: 'rejects' }, 'no answer'],
    [{ clients: 'a login banner\n' }, 'a line is not a client\'s flags'],
    [{ clients: PLAIN + '\n' }, 'a line is not a client\'s flags'],
  ]
  for (const [world, why] of cases) {
    const fx = fake(world)
    await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
    expect(opens(fx.runs)).toEqual([])
    expect(launched(fx.files)).toBe(false)
    expect(fx.logged.filter(line => line.includes(`the clients of ${SOCKET} on izno could not be read (${why})`)).length).toBe(1)
  }
})

// --- the row's home ----------------------------------------------------------------------

const sessionRow: SessionRow = {
  role: 'orchestrator', name: 'Orch: belt', repo: null, context_percent: 1, context_tokens: 1, window: 100,
  model: '', busy: false, updated_at: new Date(NOW).toISOString(), waiting: null, blocks: null, waiting_since: null,
}

test('the row carries the home server its orchestrator runs in, and none outside one', () => {
  expect(homeOf(`/private/tmp/tmux-501/${SOCKET},123,0`)).toBe(SOCKET)
  expect(homeOf('/private/tmp/tmux-501/default,123,0')).toBeNull()
  expect(homeOf(undefined)).toBeNull()
  const carried = remoteRowOf(sessionRow, 'iznoserver', [], null, undefined, homeOf(`/tmp/tmux-501/${SOCKET},1,0`))!
  expect(parseRemoteRow(rowText(carried))!.home).toBe(SOCKET)
  const none = remoteRowOf(sessionRow, 'iznoserver', [], null, undefined, null)!
  expect('home' in none).toBe(false)
  expect('home' in parseRemoteRow(rowText(none))!).toBe(false)
})

test('a row whose home is not a home server is refused whole', () => {
  const carried = remoteRowOf(sessionRow, 'iznoserver', [], null, undefined, SOCKET)!
  for (const home of ['orch-../../x', 'default', 'orch-CDC52505', 1, `${SOCKET};x`, `x${SOCKET}`, `${SOCKET}0`, `${SOCKET}\n`]) {
    expect(parseRemoteRow(rowText({ ...carried, home } as unknown as RemoteRow))).toBeNull()
  }
  expect(HOME_SHAPE.test(SOCKET)).toBe(true)
  for (const home of [`${SOCKET};x`, `x${SOCKET}`, `${SOCKET}0`]) expect('home' in remoteRowOf(sessionRow, 'iznoserver', [], null, undefined, home)!).toBe(false)
  expect(homeOf(`/tmp/tmux-501/x${SOCKET},1,0`)).toBeNull()
})

test('a row with a home carries its account and agent count too, each still checked', () => {
  const carried = remoteRowOf(sessionRow, 'iznoserver', [], null, { account: 'plan 2', agents: 3 }, SOCKET)!
  expect(parseRemoteRow(rowText(carried))).toEqual(carried)
  expect(parseRemoteRow(rowText({ ...carried, account: 'a;b' }))).toBeNull()
  expect(parseRemoteRow(rowText({ ...carried, agents: -1 }))).toBeNull()
})

test('a home the last send did not carry is news', () => {
  const carried = remoteRowOf(sessionRow, 'iznoserver', [], null, undefined, SOCKET)!
  const without = remoteRowOf(sessionRow, 'iznoserver', [], null, undefined, null)!
  expect(rowIsNews(carried, rowSent(without, NOW), NOW)).toBe(true)
  expect(rowIsNews(carried, rowSent(carried, NOW), NOW)).toBe(false)
})

// --- the machine file written by the module, the home servers listed ------------------------

const FAR = 'mini-tech2'
const FAR_DEST = 'me@203.0.113.7'
const probes = (runs: string[][]) => runs.filter(argv => argv[0] === '/usr/bin/ssh' && argv.at(-1) === 'hostname -s').map(argv => argv.at(-2))
const listings = (runs: string[][]) => runs.filter(argv => argv[0] === '/usr/bin/ssh' && argv.at(-1)!.includes('orch-*(N)'))
const DISCOVER = { now: NOW, discover: true, listHomes: true }

test('no machine file: the destination a row publishes, proved by its host name, is written in it, and the view opens', async () => {
  const fx = fake({ servers: new Set([`${FAR_DEST}|${SOCKET}`]), hosts: { 'me@198.51.100.9': 'other-mac', [FAR_DEST]: `${FAR}.home` } }, null)
  await syncViews(fx.dollar, [row({ machine: FAR, reach: ['me@198.51.100.9', FAR_DEST] })], newViewsMemory(), DISCOVER)
  expect(probes(fx.runs)).toEqual(['me@198.51.100.9', FAR_DEST])
  expect(parseMachines(fx.files.get(FILE)!)).toEqual(new Map([[FAR, FAR_DEST]]))
  expect(opens(fx.runs).length).toBe(1)
  expect(fx.logged.some(line => line.includes(`the machine ${FAR} answers as ${FAR_DEST}`))).toBe(true)
})

test('a machine the file lacks is added beside the others, found by an alias or a login whose name is the machine\'s, never by another host', async () => {
  const fx = fake({ hosts: { izno: 'IznoServer', 'geo@mini-tech2.local': FAR } }, machines({ minitech: 'me@minitech' }))
  fx.files.set(`${HOME}/.ssh/config`, 'Host *\n  ServerAliveInterval 60\nHost prod01 geo-prod01\n  HostName 192.0.2.1\nHost izno\n  User izno\n')
  fx.files.set(`${HOME}/.env`, 'MINITECH_LOGIN=geo\nMINITECH_HOST=not-a-login\nPROD_LOGIN=root\n')
  await syncViews(fx.dollar, [row(), row({ name: 'Orch: two', machine: FAR, home: OTHER })], newViewsMemory(), { now: NOW, discover: true })
  expect(probes(fx.runs)).toEqual(['izno', 'geo@mini-tech2', 'geo@mini-tech2.local'])
  expect(parseMachines(fx.files.get(FILE)!)).toEqual(new Map([['iznoserver', 'izno'], ['minitech', 'me@minitech'], [FAR, 'geo@mini-tech2.local']]))
  expect(fx.runs.flat().some(word => word.includes('not-a-login') || word.includes('prod'))).toBe(false)
})

test('a machine no candidate proves is a line, the file is left absent, and it is looked for again only after its bound', async () => {
  const fx = fake({ hosts: { [FAR_DEST]: 'someone-else' } }, null)
  const memory = newViewsMemory()
  await syncViews(fx.dollar, [row({ machine: FAR, reach: [FAR_DEST] })], memory, DISCOVER)
  await syncViews(fx.dollar, [row({ machine: FAR, reach: [FAR_DEST] })], memory, { ...DISCOVER, now: NOW + 1000 })
  expect(probes(fx.runs)).toEqual([FAR_DEST])
  expect(fx.files.has(FILE)).toBe(false)
  expect(fx.logged.some(line => line.includes(`no destination answers as ${FAR} (1 tried)`))).toBe(true)
  await syncViews(fx.dollar, [row({ machine: FAR, reach: [FAR_DEST] })], memory, { ...DISCOVER, now: NOW + VIEW_RETRY_MS })
  expect(probes(fx.runs).length).toBe(2)
})

test('a refused machine file is never written over, and no destination is probed for it', async () => {
  const fx = fake({ hosts: { [FAR_DEST]: FAR } }, '{')
  await syncViews(fx.dollar, [row({ machine: FAR, reach: [FAR_DEST] })], newViewsMemory(), DISCOVER)
  expect(fx.files.get(FILE)).toBe('{')
  expect(probes(fx.runs)).toEqual([])
})

test('a machine of the file shows its home servers with no row at all: an idle orchestrator stays visible', async () => {
  const fx = fake({ homes: { izno: `${SOCKET}\nnot-a-home\n` } }, machines({ iznoserver: 'izno' }))
  const memory = newViewsMemory()
  await syncViews(fx.dollar, [], memory, DISCOVER)
  expect(listings(fx.runs).length).toBe(1)
  expect(opens(fx.runs).length).toBe(1)
  expect(fx.runs.some(argv => argv.join(' ') === checkArgv('izno', SOCKET).join(' '))).toBe(true)
  // Listed again only once its bound has passed.
  await syncViews(fx.dollar, [], memory, { ...DISCOVER, now: NOW + 1000 })
  expect(listings(fx.runs).length).toBe(1)
  await syncViews(fx.dollar, [], memory, { ...DISCOVER, now: NOW + LIST_EVERY_MS })
  expect(listings(fx.runs).length).toBe(2)
})

test('a listing that fails is a line and is tried again after its bound; without listHomes no listing runs', async () => {
  const fx = fake({}, machines({ iznoserver: 'izno' }))
  const memory = newViewsMemory()
  await syncViews(fx.dollar, [], memory, DISCOVER)
  await syncViews(fx.dollar, [], memory, { ...DISCOVER, now: NOW + 1000 })
  expect(listings(fx.runs).length).toBe(1)
  expect(opens(fx.runs)).toEqual([])
  expect(fx.logged.some(line => line.includes('the home servers of iznoserver could not be listed on izno (exit 255)'))).toBe(true)
  const quiet = fake({ homes: { izno: `${SOCKET}\n` } }, machines({ iznoserver: 'izno' }))
  await syncViews(quiet.dollar, [], newViewsMemory(), { now: NOW })
  expect(listings(quiet.runs)).toEqual([])
})

test('the probe and the listing ask for no password, start nothing and read the remote only', () => {
  expect(probeArgv('izno')).toEqual(['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=8', 'izno', 'hostname -s'])
  const listing = listArgv('izno').at(-1)!
  expect(listing).toContain('has-session -t home')
  // Each dollar escaped from the login shell that hands the line to zsh: expanded there, not before.
  expect(listing).toContain('for s in \\${TMUX_TMPDIR:-/tmp}/tmux-\\$(id -u)/orch-*(N); do tmux -L \\${s:t} ')
  expect(listing.match(/(?<!\\)\$/g)).toBeNull()
  expect(listing).not.toMatch(/new-session|kill|attach/)
  expect(listedHomes(`${SOCKET}\n${OTHER}\n${SOCKET}\n-oProxyCommand=x\n`)).toEqual([SOCKET, OTHER])
})

test('the sources of the candidates: aliases without patterns, logins only, names matched on their letters', () => {
  expect(sshAliases('Host *\nHost staging geo-staging api.example.dev\n  HostName x\nhost izno\nHost !bad -oX\n')).toEqual(['staging', 'geo-staging', 'api.example.dev', 'izno'])
  expect(envLogins('export A_LOGIN="ann"\nB_PORT=2222\nC_LOGIN=bad value\nD_LOGIN=dee\n')).toEqual([{ name: 'A', login: 'ann' }, { name: 'D', login: 'dee' }])
  expect([namesMatch('izno', 'IznoServer'), namesMatch('MINITECH', 'mini-tech2'), namesMatch('prod01', 'mini-tech2'), namesMatch('mi', 'mini-tech2')]).toEqual([true, true, false, false])
  expect(candidatesFor(FAR, [FAR_DEST, '-oProxy'], ['minitech', 'izno'], [{ name: 'MINITECH', login: 'geo' }])).toEqual([FAR_DEST, 'minitech', 'geo@mini-tech2', 'geo@mini-tech2.local'])
  expect(machinesText(new Map([['b', 'y'], ['a', 'x']]))).toBe('{\n  "version": 1,\n  "machines": {\n    "a": "x",\n    "b": "y"\n  }\n}\n')
})
