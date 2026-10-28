// hooks/deck.ts
// The machine's supervision as one file a program outside the host reads: D3vDeck, the
// Stream Deck plugin, draws its keys from it. The store, the remote rows and the round stay
// the module's own and change shape with it; this file is the one contract, versioned, so a
// reader never parses the module's internals. Written whole and renamed into place by the
// supervision (supervision.ts, writeDeck) on every change the pane would show, and at least
// once per DECK_REFRESH_MS so a reader can tell a live file from a frozen one. Pure on
// purpose, like round.ts: the handler holds the $ and passes its reads in here.
import { tripGate } from './gauge-core.ts'
import { chainOwnerTty } from './relay.ts'
import type { RemoteRow } from './remote-row.ts'
import type { RoundEntry } from './round.ts'
import type { SessionRow } from './supervision.ts'

export const DECK_VERSION = 1

// The file's name under the state directory.
export const DECK_FILE = 'deck.json'

// A file unchanged but for its stamp is written again after this long: the reader's
// freshness proof. Shorter than its own stale bound (D3vDeck greys the keys past 3 minutes).
export const DECK_REFRESH_MS = 60 * 1000

export type DeckContext = { percent: number; tokens: number; window: number; past_gate: boolean }
export type DeckWait = { kind: 'operator' | 'done'; blocks: string | null; since: string | null; urgent: boolean }
export type DeckSession = {
  key: string                   // the store key, stable for the session's life
  name: string
  tty: string | null            // null for a remote session: no tab here to focus
  repo: string | null
  context: DeckContext
  waiting: DeckWait | null
  updated_at: string
}
export type DeckAgent = DeckSession
export type DeckOrchestrator = DeckSession & {
  machine: string | null        // null when local
  prs: string[]
  agents: DeckAgent[]
}
export type DeckSleeping = { name: string; since: string | null; dir: string | null; prs: string[] }
export type DeckRound = { open: number; urgent: number; oldest_since: string | null }
export type Deck = {
  version: number
  generated_at: string
  machine: string
  coordinator: DeckSession | null
  orchestrators: DeckOrchestrator[]
  // Agents whose orchestrator no chain names here (launched by hand, or theirs gone).
  unattached_agents: DeckAgent[]
  sleeping: DeckSleeping[]
  round: DeckRound
}

export type DeckInput = {
  machine: string
  now: number
  local: Record<string, SessionRow>
  remote: readonly RemoteRow[]
  round: readonly RoundEntry[]
  chains: readonly { name: string; mtimeMs: number; text: string }[]
  prs: ReadonlyMap<string, string[]>    // store key of a local orchestrator → its pull requests in flight
  sleepingText: string
  gate?: { gate?: number; gateTokens?: number; largeWindow?: number }
}

// The deck the inputs describe. Orchestrators come sorted by name, a remote one after a
// local one of the same name never (the local row wins, as in the pane); agents follow the
// chain that launched them to the orchestrator measured on that chain's tty.
export function deckOf(input: DeckInput): Deck {
  const urgentOf = new Map<string, boolean>()
  for (const entry of input.round) if (entry.status === 'open' && entry.urgent) urgentOf.set(entry.session, true)
  const session = (key: string, row: SessionRow): DeckSession => ({
    key,
    name: row.name ?? 'unnamed',
    tty: row.machine ? null : row.tty ?? null,
    repo: row.repo ?? null,
    context: contextOf(row, input.gate),
    waiting: row.waiting === 'operator' || row.waiting === 'done'
      ? { kind: row.waiting, blocks: row.blocks ?? null, since: row.waiting_since ?? null, urgent: urgentOf.get(sessionIdOf(key)) ?? false }
      : null,
    updated_at: row.updated_at,
  })

  const entries = Object.entries(input.local)
  const coordinatorRow = entries
    .filter(([, row]) => row.role === 'coordinator')
    .sort(([, a], [, b]) => b.updated_at.localeCompare(a.updated_at))[0]
  const orchestrators: DeckOrchestrator[] = entries
    .filter(([, row]) => row.role === 'orchestrator')
    .map(([key, row]) => ({ ...session(key, row), machine: null, prs: input.prs.get(key) ?? [], agents: [] as DeckAgent[] }))
  const localNames = new Set(orchestrators.map(o => o.name))
  for (const row of input.remote) {
    if (localNames.has(row.name)) continue
    orchestrators.push({
      key: `remote/${row.name}`, name: row.name, tty: null, repo: row.repo, context: contextOf(row, input.gate),
      waiting: row.waiting ? { kind: row.waiting, blocks: row.blocks, since: row.waiting_since, urgent: false } : null,
      updated_at: row.updated_at, machine: row.machine, prs: [...row.prs], agents: [],
    })
  }
  orchestrators.sort((a, b) => a.name.localeCompare(b.name))

  const byTty = new Map<string, DeckOrchestrator>()
  for (const o of orchestrators) {
    if (!o.tty) continue
    const held = byTty.get(o.tty)
    if (!held || o.updated_at > held.updated_at) byTty.set(o.tty, o)
  }
  const unattached: DeckAgent[] = []
  for (const [key, row] of entries.filter(([, row]) => row.role === 'agent').sort(([, a], [, b]) => (a.name ?? '').localeCompare(b.name ?? ''))) {
    const owner = row.tty ? chainOwnerTty(input.chains, row.tty) : null
    const orchestrator = owner ? byTty.get(owner) : undefined
    ;(orchestrator ? orchestrator.agents : unattached).push(session(key, row))
  }

  const open = input.round.filter(entry => entry.status === 'open' && entry.kind === 'operator')
  return {
    version: DECK_VERSION,
    generated_at: new Date(input.now).toISOString(),
    machine: input.machine,
    coordinator: coordinatorRow ? session(coordinatorRow[0], coordinatorRow[1]) : null,
    orchestrators,
    unattached_agents: unattached,
    sleeping: sleepingOf(input.sleepingText),
    round: {
      open: open.length,
      urgent: open.filter(entry => entry.urgent).length,
      oldest_since: open.map(entry => entry.since).sort()[0] ?? null,
    },
  }
}

// The text the file holds: what a reader parses, one line.
export function deckText(deck: Deck): string {
  return JSON.stringify(deck) + '\n'
}

// Whether the deck is worth a write: its content changed, or the last write is old enough
// that the stamp alone must move. `last` is what was written last, null when nothing was.
export function deckIsNews(deck: Deck, last: { deck: Deck; at: number } | null, now: number): boolean {
  if (!last) return true
  if (now - last.at >= DECK_REFRESH_MS) return true
  return JSON.stringify({ ...deck, generated_at: '' }) !== JSON.stringify({ ...last.deck, generated_at: '' })
}

function contextOf(row: { context_percent: number; context_tokens: number; window: number }, gate: DeckInput['gate']): DeckContext {
  return {
    percent: row.context_percent,
    tokens: row.context_tokens,
    window: row.window,
    past_gate: tripGate(row.context_percent, row.context_tokens, row.window, gate ?? {}).tripped,
  }
}

// A store key `sessions/<sanitised id>` back to the id a round entry names; ids are
// host-generated and already in the sanitiser's alphabet, so the two agree.
function sessionIdOf(key: string): string {
  return key.startsWith('sessions/') ? key.slice('sessions/'.length) : key
}

// coordinator.sh's sleeping.json: an array of {"name","brief","dir","model","effort","slept",
// "prs","checkouts"}. Anything else is no sleeper, never a failure.
function sleepingOf(text: string): DeckSleeping[] {
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((s: any) => s && typeof s.name === 'string')
      .map((s: any) => ({
        name: s.name,
        since: typeof s.slept === 'string' ? s.slept : null,
        dir: typeof s.dir === 'string' ? s.dir : null,
        prs: Array.isArray(s.prs) ? s.prs.filter((p: unknown) => typeof p === 'string') : [],
      }))
  } catch {
    return []
  }
}
