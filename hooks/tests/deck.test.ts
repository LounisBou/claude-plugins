// hooks/tests/deck.test.ts
// The machine's deck (deck.ts, written by supervision.ts's writeDeck): the coordinator, the
// orchestrators local and remote, each agent under the orchestrator its chain names, the
// round's open questions counted, the sleepers listed; written to the state directory's
// deck.json in one rename, and written again only when it is news.
import { expect, test } from 'claude-code/testing'
import { deckOf, deckIsNews, deckText, DECK_REFRESH_MS, DECK_VERSION, type DeckInput, type DeckUsage } from '../deck.ts'
import { register, refreshUsage, writeDeck, TRANSCRIPT_RETRY_MS, type SessionRow } from '../supervision.ts'
import type { RemoteRow } from '../remote-row.ts'
import type { RoundEntry } from '../round.ts'
import { periodStarts } from '../usage.ts'
import { logLineOf } from './fakes.ts'

const NOW = Date.parse('2026-10-28T14:00:00Z')
const AT = new Date(NOW - 30_000).toISOString()

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    role: 'orchestrator', name: 'Orch : belt', pid: '501', repo: 'acme/app', tty: '/dev/ttys003',
    context_percent: 21, context_tokens: 210000, window: 1000000, model: 'a-model', busy: false,
    updated_at: AT, ...over,
  }
}

function remote(over: Partial<RemoteRow> = {}): RemoteRow {
  return {
    name: 'Orch : far', role: 'orchestrator', context_tokens: 120000, context_percent: 12, window: 1000000,
    waiting: null, blocks: null, waiting_since: null, updated_at: AT, machine: 'mini',
    repo: 'acme/site', prs: ['acme/site#7'], ...over,
  }
}

function entry(over: Partial<RoundEntry> = {}): RoundEntry {
  return {
    id: 'x', from: 'Orch : belt', session: 's-orch', kind: 'operator', since: AT, blocks: 'the schema',
    question: 'Which?', choices: [], recommendation: null, status: 'open', at: AT, answer: null, ...over,
  }
}

const chain = (tty: string) => JSON.stringify({ tab_id: 't1', tty, owner: 'o1' }) + '\n'

function input(over: Partial<DeckInput> = {}): DeckInput {
  return {
    machine: 'mbp', now: NOW,
    local: {
      'sessions/s-coord': row({ role: 'coordinator', name: 'Coord : all', tty: '/dev/ttys001', repo: null }),
      'sessions/s-orch': row({ waiting: 'operator', blocks: 'the schema', waiting_since: AT }),
      'sessions/s-agent': row({ role: 'agent', name: 'Agent : one', tty: '/dev/ttys005', context_tokens: 320000, context_percent: 32 }),
      'sessions/s-loose': row({ role: 'agent', name: 'Agent : loose', tty: '/dev/ttys009' }),
    },
    remote: [remote()],
    round: [entry({ urgent: true }), entry({ id: 'y', status: 'answered' }), entry({ id: 'z', kind: 'done' })],
    chains: [{ name: 'ttys003.jsonl', mtimeMs: 1, text: chain('/dev/ttys005') }],
    prs: new Map([['sessions/s-orch', ['acme/app#12']]]),
    sleepingText: JSON.stringify([{ name: 'Orch : nap', slept: AT, dir: '/w/nap', prs: ['acme/app#3 feat/x'] }]),
    ...over,
  }
}

// --- the shape ------------------------------------------------------------------------

test('the deck names its version, its machine and its coordinator', () => {
  const deck = deckOf(input())
  expect(deck.version).toBe(DECK_VERSION)
  expect(deck.machine).toBe('mbp')
  expect(deck.generated_at).toBe('2026-10-28T14:00:00.000Z')
  expect(deck.coordinator?.name).toBe('Coord : all')
  expect(deck.coordinator?.tty).toBe('/dev/ttys001')
})

test("a session names its window in a home session, null outside one", () => {
  const deck = deckOf(input({
    local: {
      ...input().local,
      'sessions/s-agent': row({ role: 'agent', name: 'Agent : one', tty: '/dev/ttys005', tmux: 'home:@3.%7' }),
    },
  }))
  expect(deck.orchestrators[0].agents[0].tmux).toBe('home:@3.%7')
  expect(deck.orchestrators[0].tmux).toBeNull()
  expect(deck.coordinator?.tmux).toBeNull()
  expect(deck.unattached_agents[0].tmux).toBeNull()
  // A remote session has no window here, whatever its row says.
  expect(deckOf(input()).orchestrators.find(o => o.machine)?.tmux).toBeNull()
  expect(JSON.parse(deckText(deck)).orchestrators[0].agents[0].tmux).toBe('home:@3.%7')
})

test('no coordinator row is a null coordinator', () => {
  const local = { ...input().local }
  delete local['sessions/s-coord']
  expect(deckOf(input({ local })).coordinator).toBeNull()
})

test('orchestrators come sorted by name, the remote one without a tty and with its machine', () => {
  const deck = deckOf(input())
  expect(deck.orchestrators.map(o => o.name)).toEqual(['Orch : belt', 'Orch : far'])
  const far = deck.orchestrators[1]
  expect(far.tty).toBeNull()
  expect(far.machine).toBe('mini')
  expect(far.prs).toEqual(['acme/site#7'])
  expect(far.repo).toBe('acme/site')
  expect(deck.orchestrators[0].machine).toBeNull()
  expect(deck.orchestrators[0].prs).toEqual(['acme/app#12'])
})

test('a remote row a live local row names is dropped: local wins', () => {
  const deck = deckOf(input({ remote: [remote({ name: 'Orch : belt' })] }))
  expect(deck.orchestrators.map(o => o.name)).toEqual(['Orch : belt'])
  expect(deck.orchestrators[0].machine).toBeNull()
})

test('an agent goes under the orchestrator its chain names; one no chain names is unattached', () => {
  const deck = deckOf(input())
  expect(deck.orchestrators[0].agents.map(a => a.name)).toEqual(['Agent : one'])
  expect(deck.unattached_agents.map(a => a.name)).toEqual(['Agent : loose'])
})

test('the gate is the gauge\'s own: tokens past 300,000 on a wide window, the env\'s when given', () => {
  const deck = deckOf(input())
  expect(deck.orchestrators[0].agents[0].context.past_gate).toBe(true)
  expect(deck.orchestrators[0].context.past_gate).toBe(false)
  const raised = deckOf(input({ gate: { gateTokens: 400000 } }))
  expect(raised.orchestrators[0].agents[0].context.past_gate).toBe(false)
})

test('a wait is carried with what it blocks, urgent when its open round entry is', () => {
  const deck = deckOf(input())
  expect(deck.orchestrators[0].waiting).toEqual({ kind: 'operator', blocks: 'the schema', since: AT, urgent: true })
  expect(deck.orchestrators[1].waiting).toBeNull()
  const calm = deckOf(input({ round: [entry()] }))
  expect(calm.orchestrators[0].waiting?.urgent).toBe(false)
})

test('the round counts open operator questions only, the oldest first', () => {
  const older = new Date(NOW - 600_000).toISOString()
  const deck = deckOf(input({ round: [entry({ urgent: true }), entry({ id: 'o', since: older }), entry({ id: 'y', status: 'closed' }), entry({ id: 'z', kind: 'done' })] }))
  expect(deck.round).toEqual({ open: 2, urgent: 1, oldest_since: older })
  expect(deckOf(input({ round: [] })).round).toEqual({ open: 0, urgent: 0, oldest_since: null })
})

test('the sleepers are read from sleeping.json; anything unreadable is none', () => {
  expect(deckOf(input()).sleeping).toEqual([{ name: 'Orch : nap', since: AT, dir: '/w/nap', prs: ['acme/app#3 feat/x'] }])
  expect(deckOf(input({ sleepingText: '' })).sleeping).toEqual([])
  expect(deckOf(input({ sleepingText: '{"name":"x"}' })).sleeping).toEqual([])
})

test('the text is one line of JSON', () => {
  const text = deckText(deckOf(input()))
  expect(text.endsWith('\n')).toBe(true)
  expect(text.trim().includes('\n')).toBe(false)
  expect(JSON.parse(text).version).toBe(DECK_VERSION)
})

// --- the usage ------------------------------------------------------------------------

function usage(input: number, cost: number | null, at = AT): DeckUsage {
  const period = (from: string) => ({ from, tokens: { input, output: 2 * input, cache_read: 3 * input, cache_write: 4 * input }, cost_usd: cost })
  return { day: period('2026-10-27T23:00:00.000Z'), week: period('2026-10-25T23:00:00.000Z'), at }
}

test('the deck is version 3 and names the basis of its costs', () => {
  const deck = deckOf(input())
  expect(DECK_VERSION).toBe(3)
  expect(deck.usage_basis).toEqual({ currency: 'USD', prices: 'api-list-equivalent', timezone: 'Europe/Paris' })
})

// Each session's row carries its own usage (supervision.ts, readOwnUsage): the deck reads it
// from there.
function withUsage(usages: Record<string, DeckUsage | null>): DeckInput['local'] {
  const local = { ...input().local }
  for (const [key, u] of Object.entries(usages)) local[key] = { ...local[key], usage: u }
  return local
}

test('every local session carries the usage its row does; a remote one and a row without usage carry null', () => {
  const deck = deckOf(input({ local: withUsage({ 'sessions/s-coord': usage(1, 0.5), 'sessions/s-orch': usage(10, 1), 'sessions/s-agent': usage(100, 2), 'sessions/s-loose': null }) }))
  expect(deck.coordinator?.usage).toEqual(usage(1, 0.5))
  expect(deck.orchestrators[0].usage).toEqual(usage(10, 1))
  expect(deck.orchestrators[0].agents[0].usage).toEqual(usage(100, 2))
  expect(deck.orchestrators[1].usage).toBeNull()
  expect(deck.unattached_agents[0].usage).toBeNull()
  expect(deckOf(input()).orchestrators[0].usage).toBeNull()
  const far = deckOf(input({ local: { 'sessions/s-far': row({ name: 'Orch : x', machine: 'mini', usage: usage(10, 1) }) } }))
  expect(far.orchestrators[0].usage).toBeNull()
})

test('a period a row read before the boundary is the new one, empty, until the session is read again', () => {
  const deck = deckOf(input({ now: Date.parse('2026-10-29T09:00:00Z'), local: withUsage({ 'sessions/s-orch': usage(10, 1) }) }))
  const read = deck.orchestrators[0].usage!
  expect(read.day).toEqual({ from: '2026-10-28T23:00:00.000Z', tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0 })
  expect(read.week).toEqual(usage(10, 1).week)
  expect(deck.usage_totals.day.tokens.input).toBe(0)
  expect(deck.usage_totals.week.tokens.input).toBe(10)
})

test('the totals sum every listed session, the coordinator included, from the deck\'s own periods', () => {
  const local = withUsage({
    'sessions/s-coord': usage(1, 0.5), 'sessions/s-orch': usage(10, 1),
    'sessions/s-agent': usage(100, 2), 'sessions/s-loose': usage(1000, 0.25),
  })
  const totals = deckOf(input({ local })).usage_totals
  expect(totals.day).toEqual({ from: '2026-10-27T23:00:00.000Z', tokens: { input: 1111, output: 2222, cache_read: 3333, cache_write: 4444 }, cost_usd: 3.75 })
  expect(totals.week.from).toBe('2026-10-25T23:00:00.000Z')
  expect(totals.at).toBe('2026-10-28T14:00:00.000Z')
})

test('a total costs null when one summed period does; no session at all is zero', () => {
  const totals = deckOf(input({ local: withUsage({ 'sessions/s-orch': usage(10, 1), 'sessions/s-agent': usage(100, null) }) })).usage_totals
  expect(totals.day.cost_usd).toBeNull()
  expect(totals.day.tokens.input).toBe(110)
  const none = deckOf(input()).usage_totals
  expect(none.day).toEqual({ from: '2026-10-27T23:00:00.000Z', tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0 })
})

test('a usage read again with the same sums is no news; new sums are', () => {
  const deck = deckOf(input({ local: withUsage({ 'sessions/s-orch': usage(10, 1) }) }))
  const restamped = deckOf(input({ now: NOW + 5000, local: withUsage({ 'sessions/s-orch': usage(10, 1, new Date(NOW + 5000).toISOString()) }) }))
  expect(deckIsNews(restamped, { deck, at: NOW }, NOW + 5000)).toBe(false)
  const grown = deckOf(input({ local: withUsage({ 'sessions/s-orch': usage(11, 1) }) }))
  expect(deckIsNews(grown, { deck, at: NOW }, NOW + 5000)).toBe(true)
})

test('only the usage stamps are stripped: an `at` anywhere else in the deck is news', () => {
  const deck = deckOf(input())
  const stamped = { ...deck, round: { ...deck.round, at: AT } } as any
  const moved = { ...deck, round: { ...deck.round, at: new Date(NOW).toISOString() } } as any
  expect(deckIsNews(moved, { deck: stamped, at: NOW }, NOW + 1000)).toBe(true)
  const restamped = { ...deck, usage_totals: { ...deck.usage_totals, at: new Date(NOW + 1000).toISOString() } }
  expect(deckIsNews(restamped, { deck, at: NOW }, NOW + 1000)).toBe(false)
})

// --- when it is news ------------------------------------------------------------------

test('a deck is news when nothing was written, when it changed, or when the last write is old', () => {
  const deck = deckOf(input())
  expect(deckIsNews(deck, null, NOW)).toBe(true)
  expect(deckIsNews(deck, { deck, at: NOW }, NOW + 1000)).toBe(false)
  const later = deckOf(input({ now: NOW + 5000 }))
  expect(deckIsNews(later, { deck, at: NOW }, NOW + 5000)).toBe(false)
  const changed = deckOf(input({ round: [] }))
  expect(deckIsNews(changed, { deck, at: NOW }, NOW + 1000)).toBe(true)
  expect(deckIsNews(deck, { deck, at: NOW }, NOW + DECK_REFRESH_MS)).toBe(true)
})

// --- the write ------------------------------------------------------------------------

const HOME = '/tmp/h'
const STATE = `${HOME}/.claude/claude-orchestrator`
const STORE = `${STATE}/store`
const DECK = `${STATE}/deck.json`

type Held = { release: () => void }

function fake(id = 's-orch') {
  const files = new Map<string, string>()
  const renames: string[] = []
  const reads: string[] = []
  const touched: string[] = []
  const logged: string[] = []
  const held: Held[] = []
  let hold = false
  const fresh = new Date().toISOString()
  files.set(`${STORE}/sessions/s-orch`, JSON.stringify(row({ updated_at: fresh })) + '\n')
  files.set(`${STORE}/sessions/s-agent`, JSON.stringify(row({ role: 'agent', name: 'Agent : one', pid: '502', tty: '/dev/ttys005', updated_at: fresh })) + '\n')
  files.set(`${STORE}/remote/Orch_far`, JSON.stringify(remote({ updated_at: fresh })) + '\n')
  files.set(`${STATE}/chains/ttys003.jsonl`, chain('/dev/ttys005'))
  files.set(`${STATE}/round/x.json`, JSON.stringify(entry({ session: 's-orch' })) + '\n')
  const dollar = {
    session: { id: async () => id },
    env: { get: async (name: string) => ({ HOME } as Record<string, string>)[name] },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    fs: {
      read: async (p: string) => {
        touched.push(p)
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        return files.get(p)
      },
      write: async (p: string, text: string) => { files.set(p, text) },
      exists: async (p: string) => {
        touched.push(p)
        return files.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`))
      },
      list: async (dir: string) => {
        touched.push(`${dir}/`)
        const below = [...files.keys()].filter(k => k.startsWith(`${dir}/`)).map(k => k.slice(dir.length + 1))
        if (below.length === 0) throw new Error(`ENOENT: ${dir}`)
        const dirs = [...new Set(below.filter(k => k.includes('/')).map(k => k.split('/')[0]))]
        return [
          ...below.filter(k => !k.includes('/')).map(name => ({ name, kind: 'file', mtimeMs: 1 })),
          ...dirs.map(name => ({ name, kind: 'dir', mtimeMs: 1 })),
        ]
      },
      stat: async (p: string) => {
        touched.push(p)
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        return { size: new TextEncoder().encode(files.get(p)!).length, mtimeMs: 1 }
      },
    },
    process: {
      run: async (argv: readonly string[]) => {
        const log = logLineOf(argv)
        if (log !== null) {
          logged.push(log)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        // supervision.ts reads the host name once per module load: the same name as
        // remote-row.test.ts's, so the suite reads alike whichever file loads it first.
        if (argv[0] === 'hostname') return { exitCode: 0, stdout: 'bench-mac.local\n', stderr: '' }
        if (argv[0] === 'mv' && files.has(argv[2])) {
          renames.push(argv[3])
          files.set(argv[3], files.get(argv[2])!)
          files.delete(argv[2])
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'rm') {
          for (const p of argv.slice(2)) files.delete(p)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'ps') return { exitCode: 0, stdout: '501\n502\n', stderr: '' }
        if (argv[0] === 'sh' && argv[2].includes('awk')) {
          reads.push(argv[4])
          touched.push(argv[4])
          const answer = () => appended(files.get(argv[4]) ?? '', Number(argv[5]) - 1, Number(argv[6]))
          if (!hold) return answer()
          return new Promise(done => held.push({ release: () => done(answer()) }))
        }
        return { exitCode: 1, stdout: '', stderr: '' }
      },
    },
  }
  return { dollar, files, renames, reads, touched, logged, held, holdReads: (on: boolean) => { hold = on } }
}

// The transcript reader's answer (usage.ts, appendedArgv), spelled over the fake's files:
// the complete lines of the window that may carry a usage, then the bytes they spanned.
function appended(text: string, offset: number, length: number) {
  const bytes = new TextEncoder().encode(text).slice(offset, offset + length)
  const end = bytes.lastIndexOf(10) + 1
  const lines = new TextDecoder().decode(bytes.slice(0, end)).split('\n').filter(l => l.includes('"usage"') && l.includes('assistant'))
  return { exitCode: 0, stdout: lines.map(l => `${l}\n`).join('') + `\x1e${end}\n`, stderr: '' }
}

const PROJECT = `${HOME}/.claude/projects/-w-app`
const PRICES = JSON.stringify({ 'a-model': { input: 4, output: 20, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2 } })
function said(id: string | null, input: number, model = 'a-model'): string {
  const message: Record<string, unknown> = { model, usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  if (id) message.id = id
  return JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message }) + '\n'
}

test('writeDeck writes deck.json in one rename, with the store, the remote rows and the round', async () => {
  const fx = fake()
  await writeDeck(fx.dollar)
  expect(fx.renames).toEqual([DECK])
  const deck = JSON.parse(fx.files.get(DECK)!)
  expect(deck.machine).toBe('bench-mac')
  expect(deck.orchestrators.map((o: any) => o.name)).toEqual(['Orch : belt', 'Orch : far'])
  expect(deck.orchestrators[0].agents.map((a: any) => a.name)).toEqual(['Agent : one'])
  expect(deck.round.open).toBe(1)
  expect([...fx.files.keys()].some(k => k.includes('.tmp-'))).toBe(false)
})

test('writeDeck writes nothing when the deck is not news', async () => {
  const fx = fake()
  await writeDeck(fx.dollar)
  await writeDeck(fx.dollar)
  expect(fx.renames.length).toBeLessThanOrEqual(1)
})

test('writeDeck reads no transcript: the usage is each row\'s', async () => {
  const fx = fake()
  fx.files.set(`${PROJECT}/s-orch.jsonl`, said('m1', 100))
  const rowPath = `${STORE}/sessions/s-orch`
  const starts = periodStarts(Date.now())
  const current = { ...usage(7, 0.5), day: { ...usage(7, 0.5).day, from: new Date(starts.day).toISOString() }, week: { ...usage(7, 0.5).week, from: new Date(starts.week).toISOString() } }
  fx.files.set(rowPath, JSON.stringify({ ...JSON.parse(fx.files.get(rowPath)!), usage: current }) + '\n')
  await writeDeck(fx.dollar)
  expect(fx.reads).toEqual([])
  expect(fx.touched.some(p => p.startsWith(`${HOME}/.claude/projects`))).toBe(false)
  const deck = JSON.parse(fx.files.get(DECK)!)
  expect(deck.orchestrators[0].usage.day.tokens.input).toBe(7)
  expect(deck.orchestrators[0].agents[0].usage).toBeNull()
})

// Each test runs as its own session: the book is module memory, kept across reads as it is
// across a session's turns, and a session books its own transcripts alone.
function solo(name: string) {
  const fx = fake(name)
  fx.files.set(`${STORE}/sessions/${name}`, JSON.stringify(row({ role: 'agent', name: `Agent : ${name}`, pid: '502', tty: null, updated_at: new Date().toISOString() })) + '\n')
  fx.files.set(`${STATE}/routing/prices.json`, PRICES)
  const mine = () => JSON.parse(fx.files.get(DECK)!).unattached_agents.find((a: any) => a.key === `sessions/${name}`)
  const ownRow = () => JSON.parse(fx.files.get(`${STORE}/sessions/${name}`)!)
  return { fx, mine, ownRow }
}

test('the read books the session\'s own transcript and its subagents\', into its row and the deck', async () => {
  const { fx, mine, ownRow } = solo('s-u1')
  fx.files.set(`${PROJECT}/s-u1.jsonl`, said('m1', 100) + said('m1', 100) + JSON.stringify({ type: 'user' }) + '\n')
  fx.files.set(`${PROJECT}/s-u1/subagents/agent-1.jsonl`, said('m2', 1000))
  await refreshUsage(fx.dollar)
  expect(ownRow().usage.day.tokens).toEqual({ input: 1100, output: 0, cache_read: 0, cache_write: 0 })
  const deck = JSON.parse(fx.files.get(DECK)!)
  expect(deck.version).toBe(3)
  expect(mine().usage.day.tokens).toEqual({ input: 1100, output: 0, cache_read: 0, cache_write: 0 })
  expect(Math.abs(mine().usage.week.cost_usd - 1100 * 4 / 1e6) < 1e-12).toBe(true)
  expect(deck.orchestrators[0].usage).toBeNull()
  expect(deck.orchestrators[1].usage).toBeNull()
  expect(deck.usage_totals.day.tokens.input).toBe(1100)
})

test('a process never opens another session\'s transcript', async () => {
  const { fx, ownRow } = solo('s-u6')
  fx.files.set(`${PROJECT}/s-u6.jsonl`, said('m1', 10))
  fx.files.set(`${PROJECT}/s-orch.jsonl`, said('o1', 500))
  fx.files.set(`${PROJECT}/s-orch/subagents/agent-1.jsonl`, said('o2', 500))
  fx.files.set(`${PROJECT}/s-agent.jsonl`, said('a1', 500))
  await refreshUsage(fx.dollar)
  await refreshUsage(fx.dollar)
  expect(ownRow().usage.day.tokens.input).toBe(10)
  const opened = fx.touched.filter(p => p.startsWith(`${PROJECT}/`))
  expect(opened.length > 0).toBe(true)
  expect(opened.every(p => p.startsWith(`${PROJECT}/s-u6.jsonl`) || p.startsWith(`${PROJECT}/s-u6/`))).toBe(true)
})

test('a hook returns without waiting for the read; the read then writes the row and the deck', async () => {
  const { fx, mine, ownRow } = solo('s-u7')
  fx.files.set(`${PROJECT}/s-u7.jsonl`, said('m1', 42))
  fx.files.set(`${STORE}/waits/s-u7`, JSON.stringify({ waiting: 'operator', blocks: 'x', waiting_since: AT, relayed: null, name: 'Agent : s-u7', pid: '502' }) + '\n')
  const chains: Record<string, Function[]> = {}
  register((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    ;(chains[args[0]] ??= []).push(args[args.length - 1] as Function)
    return { catch: () => undefined }
  })
  fx.holdReads(true)
  const e = { text: '' }
  let passed: unknown = null
  const answer = await chains['turn.start'][0](fx.dollar, e, (x: unknown) => { passed = x; return x })
  expect(passed).toBe(e)
  expect(answer).toBe(e)
  expect(fx.held.length).toBe(1)
  expect(ownRow().usage).toBeUndefined()
  expect(mine().usage).toBeNull()
  expect(mine().waiting).toBeNull()
  const reading = refreshUsage(fx.dollar)
  fx.held[0].release()
  await reading
  expect(ownRow().usage.day.tokens.input).toBe(42)
  expect(mine().usage.day.tokens.input).toBe(42)
})

test('the read takes only what was appended since, and a rewritten transcript from the start', async () => {
  const { fx, mine } = solo('s-u2')
  const main = `${PROJECT}/s-u2.jsonl`
  // A partial last line is left for the next read, not lost.
  fx.files.set(main, said('m1', 10) + said('m2', 20).slice(0, 30))
  await refreshUsage(fx.dollar)
  expect(mine().usage.day.tokens.input).toBe(10)
  fx.files.set(main, said('m1', 10) + said('m2', 20))
  fx.reads.length = 0
  await refreshUsage(fx.dollar)
  expect(fx.reads).toEqual([main])
  expect(mine().usage.day.tokens.input).toBe(30)
  await refreshUsage(fx.dollar)
  expect(fx.reads).toEqual([main])
  fx.files.set(main, said('m3', 5))
  await refreshUsage(fx.dollar)
  expect(mine().usage.day.tokens.input).toBe(5)
})

test('a subagent transcript gone is forgotten with what it gave', async () => {
  const { fx, mine } = solo('s-u4')
  fx.files.set(`${PROJECT}/s-u4.jsonl`, said('m1', 10))
  fx.files.set(`${PROJECT}/s-u4/subagents/agent-1.jsonl`, said('m2', 1000))
  await refreshUsage(fx.dollar)
  expect(mine().usage.day.tokens.input).toBe(1010)
  fx.files.delete(`${PROJECT}/s-u4/subagents/agent-1.jsonl`)
  await refreshUsage(fx.dollar)
  expect(mine().usage.day.tokens.input).toBe(10)
})

test('a model without a price leaves the period\'s cost null and counts its tokens', async () => {
  const { fx, mine } = solo('s-u3')
  fx.files.set(`${PROJECT}/s-u3.jsonl`, said('m1', 100) + said(null, 7, 'c-model'))
  await refreshUsage(fx.dollar)
  const deck = JSON.parse(fx.files.get(DECK)!)
  expect(mine().usage.day.cost_usd).toBeNull()
  expect(mine().usage.day.tokens.input).toBe(107)
  expect(deck.usage_totals.day.cost_usd).toBeNull()
})

test('a main transcript gone is usage null, its book dropped, said once', async () => {
  const { fx, ownRow } = solo('s-u8')
  const main = `${PROJECT}/s-u8.jsonl`
  fx.files.set(main, said('m1', 10))
  fx.files.set(`${PROJECT}/other.jsonl`, '')
  await refreshUsage(fx.dollar)
  expect(ownRow().usage.day.tokens.input).toBe(10)
  // Gone between the search and the read: the cached path no longer answers.
  const stat = fx.dollar.fs.stat
  fx.dollar.fs.stat = async (p: string) => { if (p === main) throw new Error('EACCES'); return stat(p) }
  await refreshUsage(fx.dollar)
  await refreshUsage(fx.dollar)
  expect(ownRow().usage).toBeNull()
  expect(fx.logged.filter(l => l.includes(`the transcript ${main} cannot be read`)).length).toBe(1)
  // Readable again: booked from its first byte, nothing of the old book left over.
  fx.dollar.fs.stat = stat
  fx.files.set(main, said('m3', 4) + said('m4', 2))
  await refreshUsage(fx.dollar)
  expect(ownRow().usage.day.tokens.input).toBe(6)
})

test('a transcript not found is said once, and no later read searches for it again', async () => {
  const { fx, ownRow } = solo('s-u9')
  fx.files.set(`${PROJECT}/other.jsonl`, '')
  await refreshUsage(fx.dollar)
  const searched = fx.touched.filter(p => p === `${HOME}/.claude/projects/`).length
  await refreshUsage(fx.dollar)
  await refreshUsage(fx.dollar)
  expect(ownRow().usage).toBeUndefined()
  expect(searched).toBe(1)
  expect(fx.touched.filter(p => p === `${HOME}/.claude/projects/`).length).toBe(1)
  expect(fx.logged.filter(l => l.includes('no transcript found for session s-u9')).length).toBe(1)
})

test('a transcript written after the first miss is found by a read a minute later, not before', async () => {
  const { fx, ownRow } = solo('s-u12')
  fx.files.set(`${PROJECT}/other.jsonl`, '')
  let at = Date.now()
  const clock = () => at
  await refreshUsage(fx.dollar, clock)
  fx.files.set(`${PROJECT}/s-u12.jsonl`, said('m1', 10))
  at += TRANSCRIPT_RETRY_MS - 1000
  await refreshUsage(fx.dollar, clock)
  expect(ownRow().usage).toBeUndefined()
  at += 1000
  await refreshUsage(fx.dollar, clock)
  expect(ownRow().usage.day.tokens.input).toBe(10)
  expect(fx.logged.filter(l => l.includes('no transcript found for session s-u12')).length).toBe(1)
})

test('prices missing or no JSON are said once per text the file holds', async () => {
  const { fx } = solo('s-u10')
  fx.files.set(`${PROJECT}/s-u10.jsonl`, said('m1', 10))
  const prices = `${STATE}/routing/prices.json`
  await refreshUsage(fx.dollar)
  fx.files.delete(prices)
  await refreshUsage(fx.dollar)
  await refreshUsage(fx.dollar)
  expect(fx.logged.filter(l => l.includes(`no ${prices}`)).length).toBe(1)
  fx.files.set(prices, '{ s-u10')
  await refreshUsage(fx.dollar)
  await refreshUsage(fx.dollar)
  fx.files.set(prices, '{ s-u10 again')
  await refreshUsage(fx.dollar)
  expect(fx.logged.filter(l => l.includes(`${prices} is no JSON object`)).length).toBe(2)
})

test('malformed transcript lines are said once per change of their count', async () => {
  const { fx, ownRow } = solo('s-u11')
  const main = `${PROJECT}/s-u11.jsonl`
  const broken = '{"type":"assistant","message":{"usage":\n'
  fx.files.set(main, said('m1', 10) + broken)
  await refreshUsage(fx.dollar)
  fx.files.set(main, said('m1', 10) + broken + said('m2', 1))
  await refreshUsage(fx.dollar)
  fx.files.set(main, said('m1', 10) + broken + said('m2', 1) + broken)
  await refreshUsage(fx.dollar)
  expect(ownRow().usage.day.tokens.input).toBe(11)
  const said_ = fx.logged.filter(l => l.includes('malformed lines dropped from the transcripts of session s-u11'))
  expect(said_.length).toBe(2)
  expect(said_[0].includes('deck: 1 malformed')).toBe(true)
  expect(said_[1].includes('deck: 2 malformed')).toBe(true)
})
