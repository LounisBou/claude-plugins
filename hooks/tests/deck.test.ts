// hooks/tests/deck.test.ts
// The machine's deck (deck.ts, written by supervision.ts's writeDeck): the coordinator, the
// orchestrators local and remote, each agent under the orchestrator its chain names, the
// round's open questions counted, the sleepers listed; written to the state directory's
// deck.json in one rename, and written again only when it is news.
import { expect, test } from 'claude-code/testing'
import { deckOf, deckIsNews, deckText, DECK_REFRESH_MS, DECK_VERSION, type DeckInput } from '../deck.ts'
import { writeDeck, type SessionRow } from '../supervision.ts'
import type { RemoteRow } from '../remote-row.ts'
import type { RoundEntry } from '../round.ts'
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

function fake() {
  const files = new Map<string, string>()
  const renames: string[] = []
  const fresh = new Date().toISOString()
  files.set(`${STORE}/sessions/s-orch`, JSON.stringify(row({ updated_at: fresh })) + '\n')
  files.set(`${STORE}/sessions/s-agent`, JSON.stringify(row({ role: 'agent', name: 'Agent : one', pid: '502', tty: '/dev/ttys005', updated_at: fresh })) + '\n')
  files.set(`${STORE}/remote/Orch_far`, JSON.stringify(remote({ updated_at: fresh })) + '\n')
  files.set(`${STATE}/chains/ttys003.jsonl`, chain('/dev/ttys005'))
  files.set(`${STATE}/round/x.json`, JSON.stringify(entry({ session: 's-orch' })) + '\n')
  const dollar = {
    session: { id: async () => 's-orch' },
    env: { get: async (name: string) => ({ HOME } as Record<string, string>)[name] },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        return files.get(p)
      },
      write: async (p: string, text: string) => { files.set(p, text) },
      exists: async (p: string) => files.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`)),
      list: async (dir: string) => {
        const names = [...files.keys()].filter(k => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/'))
        if (names.length === 0) throw new Error(`ENOENT: ${dir}`)
        return names.map(k => ({ name: k.slice(dir.length + 1), kind: 'file', mtimeMs: 1 }))
      },
    },
    process: {
      run: async (argv: readonly string[]) => {
        if (logLineOf(argv) !== null) return { exitCode: 0, stdout: '', stderr: '' }
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
        return { exitCode: 1, stdout: '', stderr: '' }
      },
    },
  }
  return { dollar, files, renames }
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
