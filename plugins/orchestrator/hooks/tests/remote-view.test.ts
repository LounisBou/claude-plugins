// hooks/tests/remote-view.test.ts
// The coordinator's views of the remote orchestrators (remote-view.ts): one view per remote home
// server, opened when none is live, reused when one is, opened again when it dropped, closed when
// no row wants it; a machine the file does not map is a line, never a guess; a view names its
// socket and its session always, attaches and nothing else, and its close only ends this Mac's ssh.
// The fakes play ssh, the process table and iTerm2.
import { expect, test } from 'claude-code/testing'
import {
  MACHINES_FILE, VIEW_RETRY_MS, VIEW_RETRY_CAP_MS, checkArgv, launchScript, liveViews, newViewsMemory, parseMachines, planViews,
  syncViews, viewArgv, viewCommand, wantedViews, type LiveView, type ViewsMemory,
} from '../remote-view.ts'
import { HOME_SHAPE, homeOf, parseRemoteRow, remoteRowOf, rowIsNews, rowSent, rowText, type RemoteRow } from '../remote-row.ts'
import { logLineOf } from './fakes.ts'
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
    repo: null, prs: [], held: null, home: SOCKET, ...over,
  }
}

const machines = (map: Record<string, string> = { iznoserver: 'izno', Minitech: 'me@minitech' }) => JSON.stringify({ version: 1, machines: map })

// A process table line of a view as ps prints it: the argv joined by spaces.
const psLine = (pid: number, dest: string, socket: string) => `${pid} ${viewArgv(dest, socket).join(' ')}`

type World = { live: string[]; servers: Set<string>; unreachable: Set<string>; psFails?: boolean; osaFails?: boolean }

function fake(world: Partial<World> = {}, file: string | null = machines(), env: Record<string, string> = {}) {
  const w: World = { live: [], servers: new Set([`izno|${SOCKET}`, `me@minitech|${OTHER}`]), unreachable: new Set(), ...world }
  const files = new Map<string, string>()
  if (file !== null) files.set(FILE, file)
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
        runs.push([...argv])
        const ok = { exitCode: 0, stdout: '', stderr: '' }
        if (argv[0] === 'ps') return w.psFails ? { exitCode: 1, stdout: '', stderr: 'no' } : { exitCode: 0, stdout: ['1 /sbin/launchd', '77 ssh izno', ...w.live].join('\n') + '\n', stderr: '' }
        if (argv[0] === '/usr/bin/ssh') {
          const dest = argv[argv.length - 2]!
          const socket = /-L (\S+)/.exec(argv[argv.length - 1]!)![1]!
          if (w.unreachable.has(dest)) return { exitCode: 255, stdout: '', stderr: 'timeout' }
          return w.servers.has(`${dest}|${socket}`) ? ok : { exitCode: 1, stdout: '', stderr: 'no server running' }
        }
        if (argv[0] === 'mv') {
          files.set(argv[3]!, files.get(argv[2]!)!)
          files.delete(argv[2]!)
          return ok
        }
        if (argv[0] === 'osascript') return w.osaFails ? { exitCode: 1, stdout: '', stderr: 'iTerm2 got an error' } : ok
        return ok
      },
    },
  })
  return { dollar, files, runs, logged, world: w }
}

const opens = (runs: string[][]) => runs.filter(argv => argv[0] === 'osascript')
const kills = (runs: string[][]) => runs.filter(argv => argv[0] === 'kill')
const checks = (runs: string[][]) => runs.filter(argv => argv[0] === '/usr/bin/ssh')

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

test('the retry doubles at each try that shows no live view, up to its cap, and a live view resets it', () => {
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

test('a view no row wants is closed by ending its ssh alone, never by a tmux command', async () => {
  const fx = fake({ live: [psLine(50, 'izno', SOCKET), psLine(51, 'me@minitech', OTHER)] })
  await syncViews(fx.dollar, [row()], newViewsMemory(), { now: NOW })
  expect(kills(fx.runs)).toEqual([['kill', '-TERM', '51']])
  expect(fx.runs.some(argv => argv.join(' ').includes('kill-'))).toBe(false)
  expect(checks(fx.runs)).toEqual([])
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

// --- the row's home ----------------------------------------------------------------------

const sessionRow: SessionRow = {
  role: 'orchestrator', name: 'Orch: belt', repo: null, context_percent: 1, context_tokens: 1, window: 100,
  model: '', busy: false, updated_at: new Date(NOW).toISOString(), waiting: null, blocks: null, waiting_since: null,
}

test('the row carries the home server its orchestrator runs in, and none outside one', () => {
  expect(homeOf(`/private/tmp/tmux-501/${SOCKET},123,0`)).toBe(SOCKET)
  expect(homeOf('/private/tmp/tmux-501/default,123,0')).toBeNull()
  expect(homeOf(undefined)).toBeNull()
  const carried = remoteRowOf(sessionRow, 'iznoserver', [], null, homeOf(`/tmp/tmux-501/${SOCKET},1,0`))!
  expect(parseRemoteRow(rowText(carried))!.home).toBe(SOCKET)
  const none = remoteRowOf(sessionRow, 'iznoserver', [], null, null)!
  expect('home' in none).toBe(false)
  expect('home' in parseRemoteRow(rowText(none))!).toBe(false)
})

test('a row whose home is not a home server is refused whole', () => {
  const carried = remoteRowOf(sessionRow, 'iznoserver', [], null, SOCKET)!
  for (const home of ['orch-../../x', 'default', 'orch-CDC52505', 1]) {
    expect(parseRemoteRow(rowText({ ...carried, home } as unknown as RemoteRow))).toBeNull()
  }
  expect(HOME_SHAPE.test(SOCKET)).toBe(true)
})

test('a home the last send did not carry is news', () => {
  const carried = remoteRowOf(sessionRow, 'iznoserver', [], null, SOCKET)!
  const without = remoteRowOf(sessionRow, 'iznoserver', [], null, null)!
  expect(rowIsNews(carried, rowSent(without, NOW), NOW)).toBe(true)
  expect(rowIsNews(carried, rowSent(carried, NOW), NOW)).toBe(false)
})
