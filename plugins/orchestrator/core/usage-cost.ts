// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The cost rule: what a message's usage costs at API list prices, as data (COST_RULE) and the
// arithmetic that reads it. The orchestrator's deck (hooks/usage.ts) and telemetry's spend flag
// price a message by it; routing.py's `cost` reads COST_RULE from the plugin's copy of this file
// (docs/conventions.md, « One rule, one place »). Pure, importing nothing: the machine runs on a
// subscription, so the figure is an equivalent, never a bill. Everything from the brace after the
// marker `COST_RULE: CostRule = ` to its closing brace is JSON. The prices are the operator's, in
// routing/prices.json under the orchestrator's state directory.

// The counts a record keeps, each read at a path of the message's usage.
export type TokenName = 'input' | 'output' | 'cache_read' | 'cache_write' | 'hour'
export type RateName = 'input' | 'output' | 'cache_read' | 'cache_write_5m' | 'cache_write_1h'
export type CostRule = {
  version: 1
  // Rates are per this many tokens.
  per: number
  tokens: Record<TokenName, string[]>
  // A message whose counts here are all zero is the host's placeholder, not a model's work.
  counted: TokenName[]
  // Each rate times the sum of `plus` less the sum of `minus`.
  terms: { rate: RateName; plus: TokenName[]; minus: TokenName[] }[]
  // A tiered price switches to its upper rates when these counts pass its threshold.
  prompt: TokenName[]
}

export const COST_RULE: CostRule = {
  "version": 1,
  "per": 1000000,
  "tokens": {
    "input": ["input_tokens"],
    "output": ["output_tokens"],
    "cache_read": ["cache_read_input_tokens"],
    "cache_write": ["cache_creation_input_tokens"],
    "hour": ["cache_creation", "ephemeral_1h_input_tokens"]
  },
  "counted": ["input", "output", "cache_read", "cache_write"],
  "terms": [
    { "rate": "input", "plus": ["input"], "minus": [] },
    { "rate": "output", "plus": ["output"], "minus": [] },
    { "rate": "cache_read", "plus": ["cache_read"], "minus": [] },
    { "rate": "cache_write_5m", "plus": ["cache_write"], "minus": ["hour"] },
    { "rate": "cache_write_1h", "plus": ["hour"], "minus": [] }
  ],
  "prompt": ["input", "cache_read", "cache_write"]
}

export type Rates = Record<RateName, number>
export type Price = Rates & { above?: Rates & { tokens: number } }
// routing/prices.json under the state directory: model identifier → its rates per million tokens.
export type Prices = Record<string, Price>

// One message's usage, the counts COST_RULE names: `cache_write` holds both durations, `hour`
// the 1-hour share of it.
export type UsageRecord = Record<TokenName, number> & {
  model: string
  at: number                    // the entry's timestamp in ms; NaN when it has none, in no period
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

// A field of a value read from outside: undefined unless the value is an object.
const fieldOf = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined

// The count at a path of the usage object: 0 where any step is missing or no finite number.
function countAt(usage: unknown, path: string[]): number {
  let value = usage
  for (const key of path) value = fieldOf(value, key)
  return count(value)
}

const TOKENS = Object.keys(COST_RULE.tokens) as TokenName[]
const sumOf = (record: UsageRecord, names: TokenName[]): number => names.reduce((total, name) => total + record[name], 0)

// The record a transcript line carries, with the message id it is kept under (null when the
// message has none: each such line is a message of its own). The host writes one line per
// content block and every one repeats the whole message's usage; a message whose counted
// tokens are all zero is the host's placeholder, not a model's work.
export function recordOf(line: string): { id: string | null; record: UsageRecord } | null {
  try {
    return recordOfEntry(JSON.parse(line))
  } catch {
    return null
  }
}

export function recordOfEntry(entry: unknown): { id: string | null; record: UsageRecord } | null {
  const message = fieldOf(entry, 'message')
  if (!message || typeof message !== 'object' || Array.isArray(message) || fieldOf(entry, 'type') !== 'assistant') return null
  const usage = fieldOf(message, 'usage')
  const model = fieldOf(message, 'model')
  if (!usage || typeof usage !== 'object' || typeof model !== 'string' || model === '') return null
  const timestamp = fieldOf(entry, 'timestamp')
  const record = { model, at: typeof timestamp === 'string' ? Date.parse(timestamp) : NaN } as UsageRecord
  for (const name of TOKENS) record[name] = countAt(usage, COST_RULE.tokens[name])
  if (COST_RULE.counted.every(name => !record[name])) return null
  const messageId = fieldOf(message, 'id')
  const id = typeof messageId === 'string' && messageId !== '' ? messageId : null
  return { id, record }
}

const RATES = COST_RULE.terms.map(term => term.rate)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

// A price entry the rule can price: every base rate a finite number and, when it is tiered,
// a finite threshold and finite upper rates. Anything else prices nothing: null, never NaN.
function isPrice(price: Price): boolean {
  if (!price || typeof price !== 'object' || !RATES.every(name => finite(price[name]))) return false
  const above: unknown = price.above
  if (above === undefined || above === null) return true
  return typeof above === 'object' && finite(fieldOf(above, 'tokens'))
    && RATES.every(name => fieldOf(above, name) === undefined || finite(fieldOf(above, name)))
}

// A tiered price switches to its upper rates when the message's prompt passes the threshold;
// a rate the upper tier leaves out is the base one.
export function messageCost(record: UsageRecord, price: Price): number | null {
  if (!isPrice(price)) return null
  const rate: Rates = price.above && sumOf(record, COST_RULE.prompt) > price.above.tokens ? { ...price, ...price.above } : price
  let cost = 0
  for (const term of COST_RULE.terms) cost += (sumOf(record, term.plus) - sumOf(record, term.minus)) * rate[term.rate]
  return cost / COST_RULE.per
}
