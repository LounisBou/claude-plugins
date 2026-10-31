// hooks/tests/remote-row.test.ts
// An orchestrator's row carried to a coordinator on another machine (remote-row.ts, wired
// in supervision.ts): sent on a wait change and on a band crossing, never on a repeat,
// refreshed at most once per bound, addressed to the coordinator a peer delivery taught
// when none is registered here; received silently — a marked delivery consumed and
// written, an unmarked one passed, a malformed or oversized one refused — and drawn in
// the pane, stale rows dropped, a live local row beating a remote one.
import { expect, test } from 'claude-code/testing'
import {
  ROW_MARKER, ROW_REFRESH_MS, ROW_TEXT_CAP, REMOTE_STALE_AFTER_MS, PRS_CAP, parseRemoteRow, rowText, deliveryOf, remoteRowOf, withRemote,
  prsInFlight, rowIsNews, rowSent, type RemoteRow,
} from '../remote-row.ts'
import { paneRows, sendRow, readRemoteRows, type SessionRow } from '../supervision.ts'
import { register } from '../register.ts'
import { ASK_MARKER, parseAsk } from '../remote-round.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/h'
const STORE = `${HOME}/.claude/claude-orchestrator/store`
const ROW = `${STORE}/sessions/s-one`
const WAIT = `${STORE}/waits/s-one`
const SENT = `${STORE}/rows/s-one`
const LEARNT = `${STORE}/coordinator-learnt`
const RECORD = `${HOME}/.claude/claude-orchestrator/coordinator.json`
const COORD_FROM = 'bridge:session_01AbCdEf'

function storeRow(over: Partial<SessionRow> = {}): string {
  return JSON.stringify({
    role: 'orchestrator', name: 'Orch : belt', pid: '501', repo: 'acme/app', tty: '/dev/ttys3',
    context_percent: 21, context_tokens: 210000, window: 1000000, model: 'a-model', busy: false,
    updated_at: new Date().toISOString(), ...over,
  }) + '\n'
}

function fake(over: { learnt?: boolean; local?: boolean; refuseAddress?: boolean } = {}) {
  const files = new Map<string, string>()
  const sent: { to: unknown; text: string }[] = []
  const logged: string[] = []
  const mtimes = new Map<string, number>()
  files.set(ROW, storeRow())
  if (over.learnt !== false) files.set(LEARNT, JSON.stringify({ name: 'Coord : ops', from: COORD_FROM, at: 'T' }) + '\n')
  if (over.local) files.set(RECORD, JSON.stringify({ name: 'Coord : here', tty: '/dev/ttys9' }))
  const dollar = {
    session: {
      id: async () => 's-one',
      send: async (args: { to: unknown; text: string }) => {
        if (over.refuseAddress && args.to === COORD_FROM) return { isDelivered: false, reason: 'gone' }
        sent.push(args)
        return { isDelivered: true }
      },
    },
    env: { get: async (name: string) => ({ HOME } as Record<string, string>)[name] },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        return files.get(p)
      },
      write: async (p: string, text: string) => { files.set(p, text) },
      exists: async (p: string) => files.has(p),
      list: async (dir: string) => {
        const names = [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        if (names.length === 0) throw new Error(`ENOENT: ${dir}`)
        return names.map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 0, mtimeMs: mtimes.get(p) ?? 0, isLink: false }))
      },
      stat: async (p: string) => { throw new Error(`ENOENT: ${p}`) },
    },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf(argv)
        if (line !== null) logged.push(line)
        if (argv[0] === 'hostname') return { exitCode: 0, stdout: 'bench-mac.local\n', stderr: '' }
        if (argv[0] === 'mv' && files.has(argv[2])) {
          files.set(argv[3], files.get(argv[2])!)
          files.delete(argv[2])
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'rm') {
          for (const p of argv.slice(2)) files.delete(p)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'ps') return { exitCode: 0, stdout: '1\n501\n', stderr: '' }
        return { exitCode: 1, stdout: '', stderr: '' }
      },
    },
    ui: {
      resolve: () => ({
        Box: (props: any) => ({ box: props }),
        Text: (props: any) => props.children,
      }),
    },
  }
  return { dollar, files, sent, logged, mtimes }
}

function mounted(): Record<string, Function[]> {
  const chains: Record<string, Function[]> = {}
  register((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    ;(chains[args[0]] ??= []).push(args[args.length - 1] as Function)
    return { catch: () => undefined }
  })
  return chains
}

async function receive(chains: Record<string, Function[]>, dollar: any, text: string, kind = 'peer') {
  const queued: string[] = []
  const handlers = chains['session.receive'] ?? []
  const run = async (i: number, ev: any): Promise<any> => {
    if (i >= handlers.length) {
      queued.push(ev.text)
      return { text: ev.text }
    }
    return handlers[i](dollar, ev, (x: any) => run(i + 1, x))
  }
  const result = await run(0, { origin: { kind, plugin: 'orchestrator' }, text })
  return { result, queued }
}

const envelope = (body: string, name = 'Orch : belt', from = 'bridge:session_02Xy') =>
  `<cross-session-message from="${from}" from-name="${name}" from-mode="prompting">\n${body}\n</cross-session-message>`

function remote(over: Partial<RemoteRow> = {}): RemoteRow {
  return {
    name: 'Orch : far', role: 'orchestrator', context_tokens: 120000, context_percent: 12, window: 1000000,
    waiting: null, blocks: null, waiting_since: null, updated_at: new Date().toISOString(), machine: 'bench-mac',
    repo: null, prs: [], ...over,
  }
}

// The row as 0.58 and 0.59 sent it: the ten fields, no repository and no pull request.
function oldRowText(row: RemoteRow): string {
  const { repo: _repo, prs: _prs, ...ten } = row
  return ROW_MARKER + JSON.stringify(ten)
}

// --- the send --------------------------------------------------------------------------

test('the row goes to the learnt coordinator once, and a repeat sends nothing', async () => {
  const fx = fake()
  await sendRow(fx.dollar, 's-one')
  await sendRow(fx.dollar, 's-one')
  expect(fx.sent.length).toBe(1)
  expect(fx.sent[0].to).toBe(COORD_FROM)
  expect(fx.sent[0].text.startsWith(ROW_MARKER)).toBe(true)
  const row = parseRemoteRow(fx.sent[0].text)!
  expect(row.name).toBe('Orch : belt')
  expect(row.machine).toBe('bench-mac')
  // Only the pane's fields, the repository and its pull requests travel: no path, no tty, no pid, no model.
  expect(row.repo).toBe('acme/app')
  expect(fx.sent[0].text).not.toContain('ttys3')
  expect(fx.sent[0].text).not.toContain('a-model')
  expect([...fx.files.keys()].some(p => p.includes('.tmp-'))).toBe(false)
})

test('a wait change is sent, and so is a band crossing; a move inside the band is not', async () => {
  const fx = fake()
  await sendRow(fx.dollar, 's-one')
  fx.files.set(ROW, storeRow({ context_percent: 24, context_tokens: 240000 }))
  await sendRow(fx.dollar, 's-one')
  expect(fx.sent.length).toBe(1)
  fx.files.set(ROW, storeRow({ context_percent: 27, context_tokens: 270000 }))
  await sendRow(fx.dollar, 's-one')
  expect(fx.sent.length).toBe(2)
  fx.files.set(WAIT, JSON.stringify({ waiting: 'operator', blocks: 'phase 3', waiting_since: new Date().toISOString(), relayed: null, name: 'Orch : belt', pid: '501' }) + '\n')
  await sendRow(fx.dollar, 's-one')
  expect(fx.sent.length).toBe(3)
  expect(parseRemoteRow(fx.sent[2].text)!.waiting).toBe('operator')
  expect(parseRemoteRow(fx.sent[2].text)!.blocks).toBe('phase 3')
  await sendRow(fx.dollar, 's-one')
  expect(fx.sent.length).toBe(3)
})

test('with nothing new, the row is refreshed once the bound has passed, not before', async () => {
  const fx = fake()
  await sendRow(fx.dollar, 's-one')
  const last = JSON.parse(fx.files.get(SENT)!)
  fx.files.set(SENT, JSON.stringify({ ...last, sent_at: new Date(Date.now() - ROW_REFRESH_MS + 60000).toISOString() }))
  await sendRow(fx.dollar, 's-one')
  expect(fx.sent.length).toBe(1)
  fx.files.set(SENT, JSON.stringify({ ...last, sent_at: new Date(Date.now() - ROW_REFRESH_MS - 1000).toISOString() }))
  await sendRow(fx.dollar, 's-one')
  expect(fx.sent.length).toBe(2)
})

test('a coordinator on this machine reads the store itself: no row is sent', async () => {
  const fx = fake({ local: true })
  await sendRow(fx.dollar, 's-one')
  expect(fx.sent.length).toBe(0)
})

test('no coordinator known: nothing is sent; an address that refuses falls back to the name', async () => {
  const none = fake({ learnt: false })
  await sendRow(none.dollar, 's-one')
  expect(none.sent.length).toBe(0)
  const fx = fake({ refuseAddress: true })
  await sendRow(fx.dollar, 's-one')
  expect(fx.sent.map(s => s.to)).toEqual(['Coord : ops'])
})

test('the wait relay uses the learnt coordinator when none is registered here', async () => {
  const chains = mounted()
  const fx = fake()
  for (const handler of chains['turn.complete']) {
    await handler(fx.dollar, { answer: 'Merge #12?\n\nwaiting: operator — blocks: phase 3\n', reason: 'answer', isAborted: false, durationMs: 1, turnId: 't' }, (e: any) => e)
  }
  const report = fx.sent.find(s => s.text.startsWith(ASK_MARKER))
  expect(report?.to).toBe(COORD_FROM)
  expect(parseAsk(report!.text)!.entry.blocks).toBe('phase 3')
  // The same turn's end carried the row, its wait included.
  const row = fx.sent.find(s => s.text.startsWith(ROW_MARKER))
  expect(parseRemoteRow(row!.text)!.waiting).toBe('operator')
})

// --- the receive -----------------------------------------------------------------------

test('a coordinator message teaches its address; a message from anyone else does not', async () => {
  const chains = mounted()
  const fx = fake({ learnt: false })
  const other = await receive(chains, fx.dollar, envelope('hello', 'Orch : peer'))
  expect(other.queued.length).toBe(1)
  expect(fx.files.has(LEARNT)).toBe(false)
  const from = await receive(chains, fx.dollar, envelope('your next step', 'Coord : ops', COORD_FROM))
  expect(from.queued).toEqual([envelope('your next step', 'Coord : ops', COORD_FROM)])
  const learnt = JSON.parse(fx.files.get(LEARNT)!)
  expect([learnt.name, learnt.from]).toEqual(['Coord : ops', COORD_FROM])
  // A person's own prompt, even shaped as one, teaches nothing.
  fx.files.delete(LEARNT)
  await receive(chains, fx.dollar, envelope('x', 'Coord : evil', 'bridge:session_x'), 'bridge')
  expect(fx.files.has(LEARNT)).toBe(false)
})

test('a marked delivery is consumed and written as a remote row; an unmarked one passes untouched', async () => {
  const chains = mounted()
  const fx = fake()
  const marked = await receive(chains, fx.dollar, envelope(rowText(remote())))
  expect(typeof marked.result.consumed).toBe('string')
  expect(marked.queued.length).toBe(0)
  expect(JSON.parse(fx.files.get(`${STORE}/remote/Orch___far`)!).name).toBe('Orch : far')
  const bare = await receive(chains, fx.dollar, rowText(remote({ name: 'Orch : bare' })))
  expect(bare.queued.length).toBe(0)
  expect(fx.files.has(`${STORE}/remote/Orch___bare`)).toBe(true)
  const plain = await receive(chains, fx.dollar, envelope('a [module-row] mention inside a sentence'))
  expect(plain.queued).toEqual([envelope('a [module-row] mention inside a sentence')])
})

for (const [label, body] of [
  ['not JSON', `${ROW_MARKER}{oops`],
  ['an extra field', `${ROW_MARKER}${JSON.stringify({ ...remote(), path: '/srv/x' })}`],
  ['no orchestrator prefix', rowText(remote({ name: 'Coord : ops' }))],
  ['a machine with a slash', rowText(remote({ machine: 'a/b' }))],
  ['a percent past 100', rowText(remote({ context_percent: 101 }))],
  // Valid JSON, valid fields: only the size cap refuses it.
  ['oversized', rowText(remote()).replace('{', `{${' '.repeat(ROW_TEXT_CAP)}`)],
] as const) {
  test(`a marked delivery that is malformed (${label}) is refused: consumed, nothing written`, async () => {
    const chains = mounted()
    const fx = fake()
    const { result, queued } = await receive(chains, fx.dollar, envelope(body))
    expect(typeof result.consumed).toBe('string')
    expect(queued.length).toBe(0)
    expect([...fx.files.keys()].some(p => p.startsWith(`${STORE}/remote/`))).toBe(false)
    expect(fx.logged.some(l => l.includes('receive: a marked row was refused'))).toBe(true)
  })
}

test('the envelope is read for its sender, and a text without one is its own body', () => {
  expect(deliveryOf(envelope('hi', 'Coord : ops', COORD_FROM))).toEqual({ from: COORD_FROM, fromName: 'Coord : ops', body: 'hi' })
  expect(deliveryOf('hi')).toEqual({ from: null, fromName: null, body: 'hi' })
})

// --- the pane --------------------------------------------------------------------------

test('the pane shows a remote row with its machine and drops a stale one', () => {
  const now = Date.now()
  const old = remote({ name: 'Orch : old', updated_at: new Date(now - REMOTE_STALE_AFTER_MS - 60000).toISOString() })
  const rows = paneRows(withRemote({}, [remote(), old], now, REMOTE_STALE_AFTER_MS))
  expect(rows.length).toBe(1)
  expect(rows[0].label).toContain('Orch : far · orchestrator · remote bench-mac · 12%')
})

test('a live local row beats a remote one of the same name', () => {
  const local = JSON.parse(storeRow({ name: 'Orch : far', context_percent: 40 })) as SessionRow
  const rows = paneRows(withRemote({ 'sessions/x': local }, [remote()], Date.now(), REMOTE_STALE_AFTER_MS))
  expect(rows.length).toBe(1)
  expect(rows[0].label).toContain('40%')
  expect(rows[0].label).not.toContain('remote')
})

test('a received row is read back from the store, and a stale one is swept as it is met', async () => {
  const chains = mounted()
  const fx = fake()
  await receive(chains, fx.dollar, envelope(rowText(remote())))
  const read = await readRemoteRows(fx.dollar)
  expect(read.map(r => r.name)).toEqual(['Orch : far'])
  fx.files.set(`${STORE}/remote/Orch___old`, JSON.stringify(remote({ name: 'Orch : old', updated_at: '2020-01-01T00:00:00.000Z' })))
  expect((await readRemoteRows(fx.dollar)).map(r => r.name)).toEqual(['Orch : far'])
  expect(fx.files.has(`${STORE}/remote/Orch___old`)).toBe(false)
})

test('the row out of a store row: an orchestrator only, its waits only when shown', () => {
  expect(remoteRowOf(JSON.parse(storeRow({ role: 'agent', name: 'Agent : x' })), 'm')).toBeNull()
  const row = remoteRowOf({ ...JSON.parse(storeRow()), waiting: 'delivered', blocks: 'x' }, 'm.local')!
  expect(row.waiting).toBeNull()
  expect(row.blocks).toBeNull()
  expect(row.machine).toBe('m')
})

test('a remote orchestrator waiting on the operator stays drawn for hours; past a day it is dropped and swept', async () => {
  const hour = 60 * 60 * 1000
  const fx = fake()
  const waiting = { waiting: 'operator' as const, blocks: 'phase 3', waiting_since: new Date(Date.now() - 3 * hour).toISOString() }
  fx.files.set(`${STORE}/remote/Orch___waits`, JSON.stringify(remote({ name: 'Orch : waits', ...waiting, updated_at: new Date(Date.now() - 3 * hour).toISOString() })))
  fx.files.set(`${STORE}/remote/Orch___gone`, JSON.stringify(remote({ name: 'Orch : gone', ...waiting, updated_at: new Date(Date.now() - 25 * hour).toISOString() })))
  const read = await readRemoteRows(fx.dollar)
  expect(read.map(r => r.name)).toEqual(['Orch : waits'])
  expect(fx.files.has(`${STORE}/remote/Orch___gone`)).toBe(false)
  const rows = paneRows(withRemote({}, read, Date.now(), REMOTE_STALE_AFTER_MS))
  expect(rows.length).toBe(1)
  expect(rows[0].label).toContain('Orch : waits · orchestrator · remote bench-mac')
  expect(rows[0].label).toContain('3h')
  expect(rows[0].label).toContain('waiting for the operator')
})

// --- the repository and the pull requests in flight ------------------------------------

const CI_WATCH = `${HOME}/.claude/claude-orchestrator/ci-watch`
const ME = 's-one'

test('prsInFlight keeps only the watches this session armed, and drops one merged to its base', () => {
  const owners = new Map([
    ['acme_app-pr7.log', ME],
    ['acme_app-pr8.log', 'S-OTHER'],
    ['acme_app-pr9.log', ME],
    ['acme_app-pr9-base.log', ME],
  ])
  const names = ['acme_app-pr7.log', 'acme_app-pr7.log.session', 'acme_app-pr8.log', 'acme_app-pr9.log', 'acme_app-pr9-base.log']
  expect(prsInFlight(names, owners, ME, 'acme/app')).toEqual(['acme/app#7'])
})

test('prsInFlight keeps nothing for a log with no owner file', () => {
  expect(prsInFlight(['acme_app-pr5.log'], new Map(), ME, 'acme/app')).toEqual([])
})

test('prsInFlight names a here log by the repository argument, and none without one', () => {
  const owners = new Map([['here-pr3.log', ME]])
  expect(prsInFlight(['here-pr3.log'], owners, ME, 'acme/app')).toEqual(['acme/app#3'])
  expect(prsInFlight(['here-pr3.log'], owners, ME, null)).toEqual([])
})

test('prsInFlight splits a slug at its first underscore, so a repository name holding one survives', () => {
  const owners = new Map([['acme_app_v2-pr4.log', ME]])
  expect(prsInFlight(['acme_app_v2-pr4.log'], owners, ME, null)).toEqual(['acme/app_v2#4'])
})

test('prsInFlight drops an entry the receiver would refuse, so one bad name never refuses the row', () => {
  const owners = new Map([['acme.x_app-pr2.log', ME]])
  expect(prsInFlight(['acme.x_app-pr2.log'], owners, ME, null)).toEqual([])
})

test('prsInFlight is unique, sorted and cut to the cap', () => {
  const names: string[] = []
  const owners = new Map<string, string>()
  for (let n = 1; n <= 25; n++) {
    names.push(`acme_app-pr${n}.log`)
    owners.set(`acme_app-pr${n}.log`, ME)
  }
  names.push('here-pr1.log')
  owners.set('here-pr1.log', ME)
  const all = Array.from({ length: 25 }, (_, i) => `acme/app#${i + 1}`).sort()
  expect(prsInFlight(names, owners, ME, 'acme/app')).toEqual(all.slice(0, PRS_CAP))
})

test('the receiver takes the new field set and reads the repository and its pull requests back', () => {
  const row = remote({ repo: 'acme/app', prs: ['acme/app#7', 'acme/app_v2#12'] })
  expect(parseRemoteRow(rowText(row))).toEqual(row)
})

test('the ten fields of 0.58 and 0.59 are accepted as no repository and no pull request', () => {
  const row = remote()
  expect(parseRemoteRow(oldRowText(row))).toEqual({ ...row, repo: null, prs: [] })
})

test('a row carrying exactly one of the two new fields is refused', () => {
  const ten = JSON.parse(oldRowText(remote()).slice(ROW_MARKER.length))
  expect(parseRemoteRow(ROW_MARKER + JSON.stringify({ ...ten, repo: 'acme/app' }))).toBeNull()
  expect(parseRemoteRow(ROW_MARKER + JSON.stringify({ ...ten, prs: [] }))).toBeNull()
})

test('twenty pull requests are the most a row carries', () => {
  const twenty = Array.from({ length: PRS_CAP }, (_, i) => `acme/app#${i + 1}`)
  expect(parseRemoteRow(rowText(remote({ repo: 'acme/app', prs: twenty })))!.prs.length).toBe(PRS_CAP)
})

for (const [label, prs] of [
  ['a missing hash', ['acme/app7']],
  ['a zero number', ['acme/app#0']],
  ['a leading zero', ['acme/app#07']],
  ['no owner', ['app#7']],
  ['a space', ['acme/app #7']],
  ['not an array', 'acme/app#7'],
  ['21 entries', Array.from({ length: PRS_CAP + 1 }, (_, i) => `acme/app#${i + 1}`)],
] as const) {
  test(`a row whose pull requests are malformed (${label}) is refused`, () => {
    expect(parseRemoteRow(rowText(remote({ repo: 'acme/app', prs: prs as unknown as string[] })))).toBeNull()
  })
}

for (const [label, repo] of [['a path', '/srv/x'], ['a space', 'acme app'], ['no name', 'acme/']] as const) {
  test(`a row whose repository is malformed (${label}) is refused`, () => {
    expect(parseRemoteRow(rowText(remote({ repo, prs: [] })))).toBeNull()
  })
}

test('a change of repository or pull requests is news, and a sent record without the fields is news once', () => {
  const now = Date.now()
  const row = remote({ repo: 'acme/app', prs: ['acme/app#7'] })
  expect(rowIsNews(row, rowSent(remote({ repo: 'acme/app' }), now), now)).toBe(true)
  expect(rowIsNews(row, rowSent(row, now), now)).toBe(false)
  expect(rowIsNews(remote({ repo: 'acme/other', prs: ['acme/app#7'] }), rowSent(row, now), now)).toBe(true)
  const before = { band: 2, waiting: null, blocks: null, sent_at: new Date(now).toISOString() }
  expect(rowIsNews(row, before, now)).toBe(true)
})

test('the row sent carries the pull requests this session watches, read from the ci-watch directory', async () => {
  const fx = fake()
  fx.files.set(`${CI_WATCH}/acme_app-pr7.log`, '')
  fx.files.set(`${CI_WATCH}/acme_app-pr7.log.session`, `${ME}\n`)
  fx.files.set(`${CI_WATCH}/acme_app-pr8.log`, '')
  fx.files.set(`${CI_WATCH}/acme_app-pr8.log.session`, 'S-OTHER\n')
  fx.files.set(`${CI_WATCH}/here-pr3.log`, '')
  fx.files.set(`${CI_WATCH}/here-pr3.log.session`, `${ME}\n`)
  await sendRow(fx.dollar, ME)
  expect(fx.sent.length).toBe(1)
  const row = parseRemoteRow(fx.sent[0].text)!
  expect(row.repo).toBe('acme/app')
  expect(row.prs).toEqual(['acme/app#3', 'acme/app#7'])
})

test('a watch armed later sends the row again at once, with its pull request added', async () => {
  const fx = fake()
  fx.files.set(`${CI_WATCH}/acme_app-pr7.log`, '')
  fx.files.set(`${CI_WATCH}/acme_app-pr7.log.session`, `${ME}\n`)
  await sendRow(fx.dollar, ME)
  fx.files.set(`${CI_WATCH}/acme_app-pr9.log`, '')
  fx.files.set(`${CI_WATCH}/acme_app-pr9.log.session`, `${ME}\n`)
  await sendRow(fx.dollar, ME)
  expect(fx.sent.length).toBe(2)
  expect(parseRemoteRow(fx.sent[1].text)!.prs).toEqual(['acme/app#7', 'acme/app#9'])
})

test('a ci-watch directory that cannot be read means no pull request, never a failure', async () => {
  const fx = fake()
  await sendRow(fx.dollar, ME)
  expect(fx.sent.length).toBe(1)
  expect(parseRemoteRow(fx.sent[0].text)!.prs).toEqual([])
})

test('a ci-watch listing that rejects, not only a missing directory, means no pull request and the row is still sent', async () => {
  const fx = fake()
  fx.files.set(`${CI_WATCH}/acme_app-pr7.log`, '')
  fx.files.set(`${CI_WATCH}/acme_app-pr7.log.session`, `${ME}\n`)
  const list = fx.dollar.fs.list
  fx.dollar.fs.list = async (dir: string) => {
    if (dir === CI_WATCH) throw new Error('EACCES: permission denied')
    return list(dir)
  }
  await sendRow(fx.dollar, ME)
  expect(fx.sent.length).toBe(1)
  expect(parseRemoteRow(fx.sent[0].text)!.prs).toEqual([])
})

test('a store row whose repository is not the receiver\'s shape is sent with none', async () => {
  const fx = fake()
  fx.files.set(ROW, storeRow({ repo: '/srv/app' }))
  await sendRow(fx.dollar, ME)
  expect(fx.sent.length).toBe(1)
  expect(parseRemoteRow(fx.sent[0].text)!.repo).toBeNull()
})

test('a received row keeps its repository and pull requests, and an old row is stored with none', async () => {
  const chains = mounted()
  const fx = fake()
  await receive(chains, fx.dollar, envelope(rowText(remote({ name: 'Orch : far', repo: 'acme/app', prs: ['acme/app#7'] }))))
  await receive(chains, fx.dollar, envelope(oldRowText(remote({ name: 'Orch : old' }))))
  const stored = JSON.parse(fx.files.get(`${STORE}/remote/Orch___far`)!)
  expect([stored.repo, stored.prs]).toEqual(['acme/app', ['acme/app#7']])
  const old = JSON.parse(fx.files.get(`${STORE}/remote/Orch___old`)!)
  expect([old.repo, old.prs]).toEqual([null, []])
})

test('twenty maximum-length pull requests: the row is cut from the end to fit the cap, sent, and parses', async () => {
  const fx = fake()
  const slugs: string[] = []
  for (let i = 0; i < PRS_CAP; i++) {
    const slug = `acme_${'r'.repeat(130)}-${String(i).padStart(2, '0')}`
    const log = `${slug}-pr${100000000 + i}.log`
    slugs.push(log)
    fx.files.set(`${CI_WATCH}/${log}`, '')
    fx.files.set(`${CI_WATCH}/${log}.session`, `${ME}\n`)
  }
  await sendRow(fx.dollar, ME)
  expect(fx.sent.length).toBe(1)
  expect(fx.sent[0].text.length).toBeLessThanOrEqual(ROW_TEXT_CAP)
  const row = parseRemoteRow(fx.sent[0].text)!
  expect(row).not.toBeNull()
  expect(row.prs.length).toBeGreaterThan(0)
  expect(row.prs.length).toBeLessThan(PRS_CAP)
  const sorted = Array.from({ length: PRS_CAP }, (_, i) => `acme/${'r'.repeat(130)}-${String(i).padStart(2, '0')}#${100000000 + i}`).sort()
  expect(row.prs).toEqual(sorted.slice(0, row.prs.length))
})

test('past 256 listed entries, the newest watches are still read and a base log is seen wherever it sits', async () => {
  const fx = fake()
  for (let i = 1; i <= 254; i++) {
    fx.files.set(`${CI_WATCH}/acme_app-pr${i}.log`, '')
    fx.mtimes.set(`${CI_WATCH}/acme_app-pr${i}.log`, 1000)
  }
  // Listed in this order: 254 older watches; pull request 1001, its owner file within the first
  // 256 entries; its base log at entry 257, past the cut, so it is merged; then pull request
  // 1000, still in flight, at entry 258, also past the cut.
  fx.files.set(`${CI_WATCH}/acme_app-pr1001.log`, '')
  fx.files.set(`${CI_WATCH}/acme_app-pr1001.log.session`, `${ME}\n`)
  fx.files.set(`${CI_WATCH}/acme_app-pr1001-base.log`, '')
  fx.files.set(`${CI_WATCH}/acme_app-pr1000.log`, '')
  fx.files.set(`${CI_WATCH}/acme_app-pr1000.log.session`, `${ME}\n`)
  fx.mtimes.set(`${CI_WATCH}/acme_app-pr1001.log`, 4000)
  fx.mtimes.set(`${CI_WATCH}/acme_app-pr1000.log`, 5000)
  await sendRow(fx.dollar, ME)
  expect(fx.sent.length).toBe(1)
  expect(parseRemoteRow(fx.sent[0].text)!.prs).toEqual(['acme/app#1000'])
})
