// hooks/tests/supervision.test.ts
// The shared store: the key per session id, the merge that keeps two sessions
// writing at once from losing a row (Review Focus 4 — the keys are per session
// id, one file each, so a concurrent write to another key cannot be lost), the
// end that removes the row, and the wiring over a faked $ — the figures from
// the gauge's own module memory through the composed register (the gauge
// mounted first, or the row runs one measure behind), the name through the
// walk's core over this test's own readers, the repository through its own
// origin read.
import { expect, test } from 'claude-code/testing'
import {
  writeSession, readSessions, deleteSession, sessionKey, parseSessionRow, parseRoundEntry, runsLive, livePids, livePidsArgv, sweepTemporaries, mergeWait,
} from '../supervision.ts'
import { STALE_MS } from '../../core/store-io.ts'
import { register } from '../register.ts'
import { roundEntry } from '../round.ts'
import { logLineOf, blockOf, lockRun } from './fakes.ts'

const HOME = '/tmp/h'
const STATE = `${HOME}/.claude/claude-orchestrator`
const SESSIONS = `${STATE}/store/sessions`
const PROJECTS = `${HOME}/.claude/projects`

// --- the store's mechanics ----------------------------------------------------------------

test('the key is per session id', () => {
  expect(sessionKey('abc')).toBe('sessions/abc')
})

// The harness hands a test a $ of its own, reduced — neither fs nor process
// among its nouns — so the store is exercised over a complete fake: an
// in-memory file map (one file per key, the store's own layout) and recorded
// runs, the convention every wiring test in this suite follows.
type Fx = {
  dollar: any
  files: Map<string, string>
  // A file's modification time when a test sets one; any other is written now.
  mtimes: Map<string, number>
  ran: string[]
  written: string[]
  usage: { context: { tokens: number; window: number; percent: number } }
  env: Record<string, string>
}

function fakeDollar(over: {
  launchName?: string | null
  origin?: string
  transcript?: string
  alive?: string[]
  psFails?: 'reject' | 'exit' | 'empty'
  // The machine's listing as `ps -A -o pid=,stat=,tty=` prints it, in place of the pids alone.
  table?: string
} = {}): Fx {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const ran: string[] = []
  const written: string[] = []
  const usage = { context: { tokens: 30000, window: 100000, percent: 30 } }
  const env: Record<string, string> = { HOME, ORCHESTRATOR_HOST_CLI: 'hostcli' }
  if (over.transcript !== undefined) files.set(`${PROJECTS}/-a-project/s-one.jsonl`, over.transcript)
  const dollar = {
    session: {
      id: async () => 's-one',
      usage: async () => usage,
      model: async () => 'a-model',
      surfaces: async () => [],
    },
    env: { get: async (name: string) => env[name] },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        return files.get(p)
      },
      write: async (p: string, text: string) => {
        files.set(p, text)
      },
      stat: async (p: string) => {
        const text = files.get(p)
        if (text === undefined) throw new Error(`ENOENT: ${p}`)
        return { kind: 'file', size: text.length, mtimeMs: 0, isLink: false }
      },
      list: async (dir: string) => {
        const names = new Set<string>()
        for (const p of files.keys()) {
          if (!p.startsWith(`${dir}/`)) continue
          const rest = p.slice(dir.length + 1)
          if (rest) names.add(rest.split('/')[0])
        }
        return [...names].map(name => {
          const text = files.get(`${dir}/${name}`)
          return text !== undefined
            ? { name, kind: 'file', size: text.length, mtimeMs: mtimes.get(`${dir}/${name}`) ?? Date.now(), isLink: false }
            : { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
        })
      },
      exists: async (p: string) => files.has(p),
    },
    process: {
      run: async (argv: readonly string[]) => {
        const locked = lockRun(argv, files)
        if (locked) return locked
        const line = logLineOf(argv)
        if (line !== null) {
          written.push(line)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        const block = blockOf(argv, (p: string) => files.get(p) ?? over.transcript ?? '')
        if (block !== null) return { exitCode: 0, stdout: block, stderr: '' }
        ran.push(argv.join(' '))
        if (argv[0] === 'rm') {
          for (const p of argv.slice(2)) files.delete(p)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'mv' && files.has(argv[2])) {
          files.set(argv[3], files.get(argv[2])!)
          files.delete(argv[2])
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        const alive = over.alive ?? ['501']
        if (argv[0] === 'ps' && argv[1] === '-A') {
          // Every live pid on the machine: the session's own host, 501, the
          // fake's other living ones, and pid 1 — or the failure asked for.
          if (over.psFails === 'reject') throw new Error('ps did not answer in time')
          if (over.psFails === 'exit') return { exitCode: 1, stdout: '', stderr: 'ps: failed' }
          if (over.psFails === 'empty') return { exitCode: 0, stdout: '', stderr: '' }
          if (over.table !== undefined) return { exitCode: 0, stdout: over.table, stderr: '' }
          return { exitCode: 0, stdout: ['1', ...alive].map(pid => `  ${pid}\n`).join(''), stderr: '' }
        }
        if (argv[0] === 'ps' && argv[1] === '-o' && argv[3] === '-p') {
          // The pid-list form, as the machine answers it: one pid it refuses
          // (macOS: « process id too large ») fails the whole call, exit 1 and
          // nothing printed, the live ones with it.
          const asked = String(argv[4]).split(',')
          if (asked.some(pid => !alive.includes(pid))) return { exitCode: 1, stdout: '', stderr: 'ps: process id too large' }
          return { exitCode: 0, stdout: asked.map(pid => `  ${pid}\n`).join(''), stderr: '' }
        }
        if (argv[0] === 'sh') return { exitCode: 0, stdout: '123 ttys001\n', stderr: '' }
        if (argv[0] === 'ps' && argv[1] === '-t') {
          // The session's own process, as the listing prints it.
          const name = over.launchName === null ? null : (over.launchName ?? 'Agent: belt-p3')
          return { exitCode: 0, stdout: name ? `  501 hostcli --name ${name}\n` : '  501 hostcli\n', stderr: '' }
        }
        if (argv[0] === 'git' && argv[1] === 'remote') {
          return over.origin ? { exitCode: 0, stdout: `${over.origin}\n`, stderr: '' } : { exitCode: 128, stdout: '', stderr: 'no origin' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    ui: { toast: () => undefined, invalidate: () => undefined },
  }
  return { dollar, files, mtimes, ran, written, usage, env }
}

test('two sessions writing at once keep both rows', async () => {
  // Review Focus 4: the writes go to two keys — two files — so neither merge
  // can read, overwrite or lose the other's row, whatever the interleaving.
  const { dollar } = fakeDollar()
  await Promise.all([
    writeSession(dollar, 'first', { role: 'agent', context_percent: 40 }),
    writeSession(dollar, 'second', { role: 'agent', context_percent: 55 }),
  ])
  const rows = await readSessions(dollar)
  expect(rows['sessions/first'].context_percent).toBe(40)
  expect(rows['sessions/second'].context_percent).toBe(55)
})

test('a session end removes its row, the file with it', async () => {
  const { dollar, files } = fakeDollar()
  await writeSession(dollar, 'gone', { role: 'agent', context_percent: 10 })
  await deleteSession(dollar, 'gone')
  expect((await readSessions(dollar))['sessions/gone']).toBeUndefined()
  expect(files.has(`${SESSIONS}/gone`)).toBe(false)
})

test('a patch merges into the row it finds, and the write stamps it', async () => {
  const { dollar } = fakeDollar()
  await writeSession(dollar, 's', {
    role: 'agent', name: 'Agent: one', context_percent: 30,
    context_tokens: 30000, window: 100000, model: 'a-model', busy: false,
  })
  await writeSession(dollar, 's', { context_percent: 55 })
  const row = (await readSessions(dollar))['sessions/s']
  expect(row.context_percent).toBe(55)
  expect(row.name).toBe('Agent: one')
  expect(Date.now() - Date.parse(row.updated_at)).toBeLessThan(60000)
})

test('a row lives while its host pid does, however long since its last measure', async () => {
  // An orchestrator waiting hours on a CI watch or a long agent phase measures nothing,
  // and is alive: its row stays. A row whose pid is gone is dropped, its file removed.
  const { dollar, files } = fakeDollar({ alive: ['501'] })
  const long = new Date(Date.now() - 5 * 3600000).toISOString()
  await writeSession(dollar, 'waiting', { role: 'orchestrator', pid: '501', updated_at: long })
  await writeSession(dollar, 'crashed', { role: 'agent', pid: '502', updated_at: new Date().toISOString() })
  files.set(`${SESSIONS}/ended`, '')
  const rows = await readSessions(dollar)
  expect(rows['sessions/waiting']).toBeDefined()
  expect(rows['sessions/crashed']).toBeUndefined()
  expect(files.has(`${SESSIONS}/crashed`)).toBe(false)
  expect(files.has(`${SESSIONS}/ended`)).toBe(false)
  expect(files.has(`${SESSIONS}/waiting`)).toBe(true)
})

// The live defect: one dead pid among live ones, and a ps that fails, each
// emptied the whole store — the pane read no live orchestrator while five ran.

async function liveStore(over: Parameters<typeof fakeDollar>[0]): Promise<Fx> {
  const fx = fakeDollar(over)
  for (const [id, pid] of [['orch-a', '501'], ['orch-b', '601'], ['orch-c', '701']]) {
    await writeSession(fx.dollar, id, { role: 'orchestrator', name: `Orch: ${id}`, pid })
  }
  return fx
}

test('one dead pid among live ones removes its own row alone, at every render', async () => {
  const { dollar, files } = await liveStore({ alive: ['501', '601', '701'] })
  await writeSession(dollar, 'crashed', { role: 'orchestrator', name: 'Orch: crashed', pid: '99999' })
  // Two reads in a row: the pane's render, then its next one (a resize, a clock tick).
  for (const pass of [1, 2]) {
    const rows = await readSessions(dollar)
    expect([pass, Object.keys(rows).sort()]).toEqual([pass, ['sessions/orch-a', 'sessions/orch-b', 'sessions/orch-c']])
    for (const id of ['orch-a', 'orch-b', 'orch-c']) expect([pass, files.has(`${SESSIONS}/${id}`)]).toEqual([pass, true])
    expect(files.has(`${SESSIONS}/crashed`)).toBe(false)
  }
})

for (const psFails of ['reject', 'exit', 'empty'] as const) {
  test(`a liveness read that fails (${psFails}) removes nothing and keeps the rows drawn`, async () => {
    const { dollar, files, ran } = await liveStore({ alive: ['501', '601', '701'], psFails })
    await writeSession(dollar, 'crashed', { role: 'orchestrator', name: 'Orch: crashed', pid: '99999' })
    const rows = await readSessions(dollar)
    expect(Object.keys(rows).sort()).toEqual(['sessions/crashed', 'sessions/orch-a', 'sessions/orch-b', 'sessions/orch-c'])
    for (const id of ['orch-a', 'orch-b', 'orch-c', 'crashed']) expect(files.has(`${SESSIONS}/${id}`)).toBe(true)
    expect(ran.filter(line => line.startsWith('rm '))).toEqual([])
  })
}

// The ghost: a tab closed under the terminal's session-keeping daemon left its host in the
// table for hours, exiting and never reaped (`?Es`, tty `??`), and the pane drew it as a live
// orchestrator past the gate, nine hours stale. Listed is not live.
const GHOST_TABLE = [
  '    1 Ss   ??',
  '  501 Ss+  ttys001',
  '56717 ?Es  ??',
  '  602 Z+   ttys002',
  '  603 Ss+  ??',
  '  604 Ss+  ttys020',
  '  605 S    ??',
  '  606 UE   ttys006',
].join('\n') + '\n'

test('a listed pid that is exiting, a zombie, off its tty or on another one is not live', () => {
  const table = livePids({ exitCode: 0, stdout: GHOST_TABLE })!
  expect(runsLive(table, '501', '/dev/ttys001')).toBe(true)
  expect(runsLive(table, '56717', '/dev/ttys014')).toBe(false)
  expect(runsLive(table, '56717', null)).toBe(false)
  expect(runsLive(table, '602', '/dev/ttys002')).toBe(false)
  expect(runsLive(table, '606', '/dev/ttys006')).toBe(false)
  // The tty the row recorded is gone: the process lost it (`??`) or the pid runs elsewhere.
  expect(runsLive(table, '603', '/dev/ttys003')).toBe(false)
  expect(runsLive(table, '604', '/dev/ttys014')).toBe(false)
  // A row that recorded no tty is not judged on one: a session started off a terminal has none.
  expect(runsLive(table, '605', null)).toBe(true)
  expect(runsLive(table, '9999', null)).toBe(false)
  // A listing of the pids alone says nothing of state or tty: the pid is the whole reading.
  expect(runsLive(livePids({ exitCode: 0, stdout: '  1\n  501\n' })!, '501', '/dev/ttys001')).toBe(true)
})

test('the store reads one listing with each process state and tty, and drops the ghost rows', async () => {
  expect(livePidsArgv(['501'])).toEqual(['ps', '-A', '-o', 'pid=,stat=,tty='])
  const { dollar, files } = fakeDollar({ table: GHOST_TABLE })
  const stale = new Date(Date.now() - 9 * 3600000).toISOString()
  await writeSession(dollar, 'live', { role: 'orchestrator', name: 'Orch: live', pid: '501', tty: '/dev/ttys001' })
  await writeSession(dollar, 'ghost', { role: 'orchestrator', name: 'Orch: ghost', pid: '56717', tty: '/dev/ttys014', updated_at: stale })
  await writeSession(dollar, 'zombie', { role: 'agent', name: 'Agent: zombie', pid: '602', tty: '/dev/ttys002' })
  await writeSession(dollar, 'tty-lost', { role: 'agent', name: 'Agent: lost', pid: '603', tty: '/dev/ttys003' })
  await writeSession(dollar, 'tty-gone', { role: 'agent', name: 'Agent: gone', pid: '604', tty: '/dev/ttys014' })
  const rows = await readSessions(dollar)
  expect(Object.keys(rows)).toEqual(['sessions/live'])
  for (const id of ['ghost', 'zombie', 'tty-lost', 'tty-gone']) expect([id, files.has(`${SESSIONS}/${id}`)]).toEqual([id, false])
})

test('a row written before rows carried a pid: older than one hour is dropped, a fresh one kept', async () => {
  const { dollar } = fakeDollar()
  await writeSession(dollar, 'old', { role: 'agent', updated_at: new Date(Date.now() - 3600000 - 5000).toISOString() })
  await writeSession(dollar, 'new', { role: 'agent' })
  const rows = await readSessions(dollar)
  expect(rows['sessions/old']).toBeUndefined()
  expect(rows['sessions/new']).toBeDefined()
})

test('an absent, empty or unparseable row file is no row', async () => {
  // The measure-file doctrine, the store's own: a partial write is data that
  // parses to nothing, and the end handler's truncated files read as absent.
  expect(parseSessionRow('')).toBeNull()
  expect(parseSessionRow('{"role":"agent","context_perc')).toBeNull()
  expect(parseSessionRow('not json')).toBeNull()
  expect(parseSessionRow(JSON.stringify({ role: 'agent' }))).toBeNull()
  const { dollar, files } = fakeDollar()
  files.set(`${SESSIONS}/broken`, 'not json\n')
  files.set(`${SESSIONS}/empty`, '')
  const rows = await readSessions(dollar)
  expect(rows['sessions/broken']).toBeUndefined()
  expect(rows['sessions/empty']).toBeUndefined()
})

// The row is written the way the launcher writes it (iterm_agent.py row_write): a temporary
// file beside it, then one rename, so a reader never meets a row caught mid-write.
test('the row is written to a temporary file beside it, then renamed into place', async () => {
  const { dollar, files, ran } = fakeDollar()
  await writeSession(dollar, 's', { role: 'agent', name: 'Agent: one' })
  const moves = ran.filter(line => line.startsWith('mv '))
  expect(moves.length).toBe(1)
  expect(new RegExp(`^mv -f ${SESSIONS}/s\\.tmp-\\d+-[0-9a-z]+ ${SESSIONS}/s$`).test(moves[0])).toBe(true)
  expect(parseSessionRow(files.get(`${SESSIONS}/s`)!)?.name).toBe('Agent: one')
  expect([...files.keys()].some(k => k.includes('.tmp-'))).toBe(false)
})

test('a rename that fails leaves the row as it was, and its temporary file removed', async () => {
  const fx = fakeDollar()
  await writeSession(fx.dollar, 's', { role: 'agent', name: 'Agent: one' })
  const before = fx.files.get(`${SESSIONS}/s`)
  const real = fx.dollar.process.run
  fx.dollar.process.run = async (argv: readonly string[]) => argv[0] === 'mv' ? { exitCode: 1, stdout: '', stderr: 'refused' } : real(argv)
  let failed = false
  try {
    await writeSession(fx.dollar, 's', { name: 'Agent: two' })
  } catch {
    failed = true
  }
  expect(failed).toBe(true)
  expect(fx.files.get(`${SESSIONS}/s`)).toBe(before)
  expect([...fx.files.keys()].some(k => k.includes('.tmp-'))).toBe(false)
})

// A temporary file is a write in flight, or one whose rename never came: never a second row,
// and never removed by a reader — removing a writer's temporary file fails its rename.
test('a temporary file beside the rows is no row, and the read leaves a fresh one in place', async () => {
  const { dollar, files } = fakeDollar({ alive: ['501'] })
  await writeSession(dollar, 'live', { role: 'agent', name: 'Agent: live', pid: '501' })
  files.set(`${SESSIONS}/live.tmp-1-abcdef`, files.get(`${SESSIONS}/live`)!)
  files.set(`${SESSIONS}/fresh.tmp-2-abcdef`, '')
  const rows = await readSessions(dollar)
  expect(Object.keys(rows)).toEqual(['sessions/live'])
  expect(files.has(`${SESSIONS}/live.tmp-1-abcdef`)).toBe(true)
  expect(files.has(`${SESSIONS}/fresh.tmp-2-abcdef`)).toBe(true)
})

test('a temporary file a killed writer left beside the rows is removed by the next read', async () => {
  // A process killed between its write and its rename leaves its temporary file: one older than
  // any write takes is no write in flight, and the read removes it, even when the liveness read fails.
  const { dollar, files, mtimes } = fakeDollar({ psFails: 'exit' })
  await writeSession(dollar, 'live', { role: 'agent', name: 'Agent: live', pid: '501' })
  files.set(`${SESSIONS}/live.tmp-1-dead`, '{}')
  mtimes.set(`${SESSIONS}/live.tmp-1-dead`, Date.now() - STALE_MS - 1000)
  await readSessions(dollar)
  expect(files.has(`${SESSIONS}/live.tmp-1-dead`)).toBe(false)
  expect(files.has(`${SESSIONS}/live`)).toBe(true)
})

test('a session start removes the temporary files killed writers left in every directory the module writes', async () => {
  const { dollar, files, mtimes, ran } = fakeDollar()
  const old = Date.now() - STALE_MS - 1000
  const left = [`${STATE}/store/waits/s.tmp-1-x`, `${STATE}/round/e.json.tmp-2-y`, `${STATE}/deck.json.tmp-3-z`]
  for (const path of left) {
    files.set(path, '{}')
    mtimes.set(path, old)
  }
  files.set(`${STATE}/store/waits/s.tmp-4-fresh`, '{}')
  files.set(`${STATE}/store/waits/s`, '{}')
  expect((await sweepTemporaries(dollar)).sort()).toEqual([...left].sort())
  expect(left.some(path => files.has(path))).toBe(false)
  expect(files.has(`${STATE}/store/waits/s.tmp-4-fresh`)).toBe(true)
  expect(files.has(`${STATE}/store/waits/s`)).toBe(true)
  // Nothing left, nothing run.
  ran.length = 0
  expect(await sweepTemporaries(dollar)).toEqual([])
  expect(ran).toEqual([])
})

// --- the wiring ---------------------------------------------------------------------------

// The composed chain, one list per event: a domain's handler answers after the
// ones registered before it, the engine's own order, so driving the list in
// registration order is driving the chain the host drives.
function mounted(registerAll: (on: any) => void): Record<string, Function[]> {
  const chains: Record<string, Function[]> = {}
  registerAll((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    ;(chains[args[0]] ??= []).push(args[args.length - 1] as Function)
    return { catch: () => undefined }
  })
  return chains
}

async function drive(chains: Record<string, Function[]>, event: string, dollar: any, e: object) {
  const run = async (i: number, ev: any): Promise<any> =>
    i >= (chains[event] ?? []).length ? ev : chains[event][i](dollar, ev, (x: any) => run(i + 1, x))
  return run(0, e)
}

test('the composed register writes the row the gauge just measured', async () => {
  // Two measures, 30 then 55: the row carries the second figure only because
  // register mounts the gauge before the supervision — reversed, its handler
  // would answer first and read the reading one measure behind (nothing, then
  // 30). The order is pinned here, not by courtesy.
  const chains = mounted(register)
  const fx = fakeDollar({ origin: 'git@github.com:me/belt.git' })
  await drive(chains, 'session.measure', fx.dollar, {})
  fx.usage.context.percent = 55
  fx.usage.context.tokens = 55000
  await drive(chains, 'session.measure', fx.dollar, {})
  const row = (await readSessions(fx.dollar))['sessions/s-one']
  expect(row.context_percent).toBe(55)
  expect(row.context_tokens).toBe(55000)
  expect(row.window).toBe(100000)
  expect(row.model).toBe('a-model')
  expect(row.busy).toBe(false)
  expect(row.role).toBe('agent')
  expect(row.name).toBe('Agent: belt-p3')
  expect(row.repo).toBe('me/belt')
  expect(row.pid).toBe('501')
})

// The processes a measure spawns once the session is known: the walk's two reads of its own
// process, the row's rename, the liveness reads and the deck's rename. The repository is read at
// the first measure and kept, as the pane keeps it: a steady measure runs no git (at 0.98.10 it
// ran one at every measure, eight processes in this case where seven run now).
test('a steady measure reads the repository no more', async () => {
  const chains = mounted(register)
  const fx = fakeDollar({ origin: 'git@github.com:me/belt.git', launchName: 'Orch: belt' })
  await drive(chains, 'session.measure', fx.dollar, {})
  expect(fx.ran.filter(r => r.startsWith('git '))).toHaveLength(1)
  fx.ran.length = 0
  fx.usage.context.percent = 56
  await drive(chains, 'session.measure', fx.dollar, {})
  expect(fx.ran.filter(r => r.startsWith('git '))).toEqual([])
  expect(fx.ran.filter(r => r.startsWith('mv ')).length).toBe(2)
  expect(fx.ran.length).toBe(7)
  expect((await readSessions(fx.dollar))['sessions/s-one'].repo).toBe('me/belt')
})

test('a walk that does not finish keeps the name and role the row already had', async () => {
  // The walk loses its bound: the figures land, the name the previous measure read
  // stays — the coordinator's pane filters on the role, and a null would drop the row.
  const chains = mounted(register)
  const fx = fakeDollar({ origin: 'git@github.com:me/belt.git' })
  await drive(chains, 'session.measure', fx.dollar, {})
  fx.env.ORCHESTRATOR_SIDE_READ_MS = '30'
  const hang = fx.dollar.process.run
  fx.dollar.process.run = async (argv: readonly string[], init?: object) =>
    argv[0] === 'sh' && argv[2] === 'ps -o ppid=,tty= -p $$' ? new Promise(() => undefined) : hang(argv, init)
  fx.usage.context.percent = 61
  await drive(chains, 'session.measure', fx.dollar, {})
  const row = (await readSessions(fx.dollar))['sessions/s-one']
  expect(row.context_percent).toBe(61)
  expect(row.name).toBe('Agent: belt-p3')
  expect(row.role).toBe('agent')
})

test('without a launch name the row is named by the transcript\'s last rename', async () => {
  const renamed = [
    '{"type":"assistant","message":{"role":"assistant","content":"an answer"}}',
    '{"type":"custom-title","customTitle":"Agent: renamed"}',
  ].join('\n') + '\n'
  const chains = mounted(register)
  const fx = fakeDollar({ launchName: null, transcript: renamed })
  await drive(chains, 'session.measure', fx.dollar, {})
  const row = (await readSessions(fx.dollar))['sessions/s-one']
  expect(row.name).toBe('Agent: renamed')
  expect(row.role).toBe('agent')
})

test('the end handler removes the row through the store', async () => {
  const chains = mounted(register)
  const fx = fakeDollar()
  await writeSession(fx.dollar, 's-one', { role: 'agent' })
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })
  expect(fx.files.has(`${SESSIONS}/s-one`)).toBe(false)
  expect((await readSessions(fx.dollar))['sessions/s-one']).toBeUndefined()
})

test('a row that cannot be written never blocks the measure, and is said', async () => {
  const chains = mounted(register)
  const fx = fakeDollar()
  await drive(chains, 'session.measure', fx.dollar, {})
  const good = fx.dollar.fs.write
  fx.dollar.fs.write = async (p: string, text: string) => {
    if (p.startsWith(SESSIONS)) throw new Error('EIO: the store cannot be written')
    return good(p, text)
  }
  const e = {}
  const answer = await drive(chains, 'session.measure', fx.dollar, e)
  expect(answer).toBe(e)
  expect(fx.written.some(l => l.includes('| supervision |') && l.includes('EIO'))).toBe(true)
})

// --- the round's entries of a sender that is gone --------------------------------------------

const ROUND = `${STATE}/round`
const SENT = '2026-11-03T10:00:00.000Z'

function openEntry(files: Map<string, string>, session: string, kind: 'operator' | 'done', over: Record<string, unknown> = {}): string {
  const entry = { ...roundEntry(session, `Orch: ${session}`, { kind, blocks: kind === 'operator' ? 'a phase' : null, question: 'which one?' } as any, SENT, SENT), ...over }
  files.set(`${ROUND}/${entry.id}.json`, JSON.stringify(entry) + '\n')
  return entry.id
}

const statusOf = (files: Map<string, string>, id: string) => parseRoundEntry(files.get(`${ROUND}/${id}.json`) ?? '')?.status

test('a read of the store closes the open entries of a sender whose row it removes, and leaves the others open', async () => {
  const { dollar, files } = fakeDollar({ alive: ['501'] })
  await writeSession(dollar, 'alive', { role: 'orchestrator', name: 'Orch: alive', pid: '501' })
  await writeSession(dollar, 'killed', { role: 'orchestrator', name: 'Orch: killed', pid: '502' })
  files.set(`${SESSIONS}/emptied`, '')
  const live = openEntry(files, 'alive', 'operator')
  const killed = openEntry(files, 'killed', 'operator')
  const emptied = openEntry(files, 'emptied', 'done')
  const unmeasured = openEntry(files, 'successor-not-measured', 'operator', { movedFrom: 'old' })
  const unnamed = openEntry(files, 'x', 'operator', { session: '' })
  const remote = openEntry(files, 'far', 'operator', { origin: { machine: 'Elsewhere', address: 'x' } })
  await readSessions(dollar)
  expect(statusOf(files, live)).toBe('open')
  expect(statusOf(files, killed)).toBe('withdrawn')
  expect(statusOf(files, emptied)).toBe('withdrawn')
  expect(statusOf(files, unmeasured)).toBe('open')
  expect(statusOf(files, unnamed)).toBe('open')
  expect(statusOf(files, remote)).toBe('open')
  expect(JSON.parse(files.get(`${ROUND}/${killed}.json`)!).answer.by).toBe('sender')
})

// A sender that learnt its successor and was killed before its hand-over or its session end: the
// read that removes its row moves its open entries to the successor, as its end would have.
test('a read of the store moves the open entries of a removed sender that learnt its successor, and withdraws none', async () => {
  const { dollar, files } = fakeDollar({ alive: ['501'] })
  await writeSession(dollar, 'killed', { role: 'orchestrator', name: 'Orch: killed', pid: '502' })
  files.set(`${STATE}/store/successors/killed`, JSON.stringify({ name: 'Orch: next', from: null, session: 'next', at: SENT }) + '\n')
  const id = openEntry(files, 'killed', 'operator')
  await readSessions(dollar)
  const after = parseRoundEntry(files.get(`${ROUND}/${id}.json`)!)
  expect([after?.status, after?.session, after?.from, after?.movedFrom]).toEqual(['open', 'next', 'Orch: next', 'killed'])
  expect(files.has(`${STATE}/store/successors/killed`)).toBe(false)
})

test('a liveness read that fails does not close the entry of a row it keeps', async () => {
  const { dollar, files } = fakeDollar({ alive: ['501'], psFails: 'exit' })
  await writeSession(dollar, 'kept', { role: 'orchestrator', name: 'Orch: kept', pid: '502' })
  const id = openEntry(files, 'kept', 'operator')
  await readSessions(dollar)
  expect(statusOf(files, id)).toBe('open')
})

test('a row idle past the stale bound with no pid is removed, and its sender keeps its open entries', async () => {
  const { dollar, files } = fakeDollar({ alive: ['501'] })
  const idle = new Date(Date.now() - 2 * 3600000).toISOString()
  await writeSession(dollar, 'idle', { role: 'orchestrator', name: 'Orch: idle', updated_at: idle })
  const id = openEntry(files, 'idle', 'operator')
  await readSessions(dollar)
  expect(files.has(`${SESSIONS}/idle`)).toBe(false)
  expect(statusOf(files, id)).toBe('open')
})

// D1 of the round-2 verdict: the idle row's removal keeps the successor its session learnt, so
// that session, living on and ending later, moves its questions to the successor.
test('a row removed for idleness alone keeps its learnt successor, and its later end moves its entries', async () => {
  const chains = mounted(register)
  const { dollar, files } = fakeDollar({ alive: ['501'] })
  const idle = new Date(Date.now() - 2 * 3600000).toISOString()
  await writeSession(dollar, 'idle', { role: 'orchestrator', name: 'Orch: idle', updated_at: idle })
  files.set(`${STATE}/store/successors/idle`, JSON.stringify({ name: 'Orch: next', from: null, session: 'next', at: SENT }) + '\n')
  const id = openEntry(files, 'idle', 'operator')
  await readSessions(dollar)
  expect(files.has(`${SESSIONS}/idle`)).toBe(false)
  expect(files.has(`${STATE}/store/successors/idle`)).toBe(true)
  await drive(chains, 'session.end', dollar, { sessionId: 'idle' })
  const after = parseRoundEntry(files.get(`${ROUND}/${id}.json`)!)
  expect([after?.status, after?.session, after?.from, after?.movedFrom]).toEqual(['open', 'next', 'Orch: next', 'idle'])
})

test('an entry moved to a successor between the read and the withdraw is not overwritten', async () => {
  const { dollar, files } = fakeDollar({ alive: ['501'] })
  await writeSession(dollar, 'killed', { role: 'orchestrator', name: 'Orch: killed', pid: '502' })
  const id = openEntry(files, 'killed', 'operator')
  const path = `${ROUND}/${id}.json`
  const read = dollar.fs.read
  let reads = 0
  dollar.fs.read = async (p: string) => {
    const text = await read(p)
    // The sweep's two round reads see the entry under the dead sender; the move lands right after the second.
    if (p === path && ++reads === 2) files.set(path, JSON.stringify({ ...JSON.parse(text), session: 'successor', from: 'Orch: next', movedFrom: 'killed' }) + '\n')
    return text
  }
  await readSessions(dollar)
  const after = parseRoundEntry(files.get(path)!)
  expect(after?.status).toBe('open')
  expect(after?.session).toBe('successor')
})

test('an entry naming no session, or from another machine, stays open though a row of that name is removed', async () => {
  const { dollar, files } = fakeDollar({ alive: ['501'] })
  // A row file named « » and one named « far », both emptied: this pass removes both.
  files.set(`${SESSIONS}/`, '')
  files.set(`${SESSIONS}/far`, '')
  const list = dollar.fs.list
  dollar.fs.list = async (dir: string) => {
    const listed = await list(dir)
    return dir === SESSIONS ? [...listed, { name: '', kind: 'file' }] : listed
  }
  const unnamed = openEntry(files, 'x', 'operator', { session: '' })
  const remote = openEntry(files, 'far', 'operator', { origin: { machine: 'Elsewhere', address: 'x' } })
  await readSessions(dollar)
  expect(files.has(`${SESSIONS}/far`)).toBe(false)
  expect(statusOf(files, unnamed)).toBe('open')
  expect(statusOf(files, remote)).toBe('open')
})

// The wait file's writers live in several processes: the session's relay, the coordinator's hooks
// forgetting a fingerprint, round-close. A relay write computed from what it read before the
// coordinator forgot the fingerprint put the fingerprint back, and the same question was never
// relayed again; a field the relay leaves as it read it keeps what the file holds now.
test('a wait written from an older read keeps what another process changed since', () => {
  const seen = { waiting: 'operator' as const, blocks: 'b', waiting_since: 't0', relayed: 'K', name: 'Orch: a', pid: '1', typed: { blocks: 'b', since: 't0' } }
  const now = { ...seen, relayed: null }
  delete (now as { typed?: unknown }).typed
  const written = mergeWait(seen, now, { ...seen, waiting: 'done', waiting_since: 't1' })
  expect(written.relayed).toBe(null)
  expect('typed' in written).toBe(false)
  expect(written.waiting).toBe('done')
  expect(written.waiting_since).toBe('t1')
  // A field this write changes is its own, whatever the file holds.
  expect(mergeWait(seen, now, { ...seen, relayed: 'K2' }).relayed).toBe('K2')
  // Nothing read before, or nothing there now: the write as it is.
  expect(mergeWait(undefined, now, { ...seen })).toEqual(seen)
  expect(mergeWait(seen, null, { ...seen })).toEqual(seen)
})
