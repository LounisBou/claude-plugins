// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// `deck.json`: the machine's supervision as one file a program outside the host reads (the Stream
// Deck draws its keys from it), and the repository's own readers with it. The orchestrator's
// module writes it (hooks/deck.ts, a view of its state store); a reader parses it here, never the
// module's internals. A change of the format raises DECK_VERSION.
import type { WaitKind } from './orchestration.ts'

export const DECK_VERSION = 3

/** The file's name under the orchestrator's state directory. */
export const DECK_FILE = 'deck.json'

export type DeckContext = { percent: number; tokens: number; window: number; past_gate: boolean }
export type DeckWait = { kind: Extract<WaitKind, 'operator' | 'done'>; blocks: string | null; since: string | null; urgent: boolean }
// Token counts and their cost at API list prices in US dollars: an equivalent, since the machine
// runs on a subscription. cost_usd is null when a message of the period ran on a model with no price.
export type DeckTokens = { input: number; output: number; cache_read: number; cache_write: number }
export type DeckPeriod = { from: string; tokens: DeckTokens; cost_usd: number | null }   // from: the period's start, ISO UTC
export type DeckUsage = { day: DeckPeriod; week: DeckPeriod; at: string }                // at: when the sums were read, ISO UTC
export type DeckSession = {
  key: string                   // the store key, stable for the session's life
  name: string
  tty: string | null            // null for a remote session: no tab here to focus
  tmux: string | null           // `<session>:@N.%N`, the window of a session in a home session: null elsewhere
  repo: string | null
  context: DeckContext
  waiting: DeckWait | null
  updated_at: string
  usage: DeckUsage | null       // null for a remote session, or a local one whose transcript is not found
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
  // Every listed session's usage summed, the remote ones excepted.
  usage_totals: DeckUsage
  usage_basis: { currency: 'USD'; prices: 'api-list-equivalent'; timezone: 'Europe/Paris' }
}

type Check<T> = (value: unknown) => value is T

const text: Check<string> = (v): v is string => typeof v === 'string'
const figure: Check<number> = (v): v is number => typeof v === 'number' && Number.isFinite(v)
const flag: Check<boolean> = (v): v is boolean => typeof v === 'boolean'
const one = <const T>(...values: readonly T[]): Check<T> => (v): v is T => values.some(value => value === v)
const orNull = <T>(check: Check<T>): Check<T | null> => (v): v is T | null => v === null || check(v)
const list = <T>(check: Check<T>): Check<T[]> => (v): v is T[] => Array.isArray(v) && v.every(check)
const shape = <T>(checks: { [K in keyof T]: Check<T[K]> }): Check<T> => (v): v is T =>
  typeof v === 'object' && v !== null && Object.entries<Check<unknown>>(checks).every(([key, check]) => check((v as Record<string, unknown>)[key]))

const period = shape<DeckPeriod>({
  from: text, tokens: shape<DeckTokens>({ input: figure, output: figure, cache_read: figure, cache_write: figure }), cost_usd: orNull(figure),
})
const usage = shape<DeckUsage>({ day: period, week: period, at: text })
const session = {
  key: text, name: text, tty: orNull(text), tmux: orNull(text), repo: orNull(text),
  context: shape<DeckContext>({ percent: figure, tokens: figure, window: figure, past_gate: flag }),
  waiting: orNull(shape<DeckWait>({ kind: one('operator', 'done'), blocks: orNull(text), since: orNull(text), urgent: flag })),
  updated_at: text, usage: orNull(usage),
}
const deck = shape<Deck>({
  version: one(DECK_VERSION), generated_at: text, machine: text,
  coordinator: orNull(shape<DeckSession>(session)),
  orchestrators: list(shape<DeckOrchestrator>({ ...session, machine: orNull(text), prs: list(text), agents: list(shape<DeckAgent>(session)) })),
  unattached_agents: list(shape<DeckAgent>(session)),
  sleeping: list(shape<DeckSleeping>({ name: text, since: orNull(text), dir: orNull(text), prs: list(text) })),
  round: shape<DeckRound>({ open: figure, urgent: figure, oldest_since: orNull(text) }),
  usage_totals: usage,
  usage_basis: shape<Deck['usage_basis']>({ currency: one('USD'), prices: one('api-list-equivalent'), timezone: one('Europe/Paris') }),
})

/** Whether a value is a period's usage as the deck holds it: a session row carries one. */
export function isDeckUsage(value: unknown): value is DeckUsage {
  return usage(value)
}

/** The deck a file's text holds, or null: no JSON (a file caught mid-write), another version, or a field of another shape. */
export function parseDeck(fileText: string): Deck | null {
  try {
    const value: unknown = JSON.parse(fileText)
    return deck(value) ? value : null
  } catch {
    return null
  }
}

/** Every session a deck lists: the coordinator, the orchestrators, their agents and the unattached ones. */
export function deckSessions(read: Deck): DeckSession[] {
  return [...(read.coordinator ? [read.coordinator] : []), ...read.orchestrators.flatMap(o => [o, ...o.agents]), ...read.unattached_agents]
}
