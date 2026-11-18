// The spend flag: the machine's token spend over the last hour at API list prices, and whether it
// is past the threshold that exhausts the subscription window before its reset. Telemetry's
// writer computes it from the `api_call` events of every session (subagents included) and writes
// `spend-flag.json` under its state directory; statusbar shows its line, and the orchestrator
// tells it to the coordinator and each orchestrator. A signal, never a refusal. A change of the
// format raises SPEND_FLAG_VERSION; `npm run core` writes the data half as `spend-reader.json`
// into the plugins that name it (statusbar's `statusline.sh`).

export const SPEND_FLAG_VERSION = 1

/** The telemetry module's state directory under the host's configuration directory, and the file in it. */
export const SPEND_FLAG_DIR = 'telemetry'
export const SPEND_FLAG_FILE = 'spend-flag.json'

/** The writer recomputes the flag at most this often, so a flag older than twice that is a frozen one. */
export const SPEND_FLAG_EVERY_MS = 5 * 60 * 1000
export const SPEND_FLAG_STALE_AFTER_MS = 2 * SPEND_FLAG_EVERY_MS

/** At most this many spenders are named. */
export const SPEND_TOP_MAX = 3

export type Spender = { session: string; name: string; usd: number }
export type SpendFlag = {
  version: typeof SPEND_FLAG_VERSION
  /** When the flag was computed, ms since the epoch. */
  at: number
  /** The span of events it sums, ms. */
  window_ms: number
  /** The spend over the window, in US dollars an hour (an equivalent at API list prices, never a bill). */
  rate_usd_per_hour: number
  threshold_usd_per_hour: number
  over: boolean
  /** When the rate went over, ms; null while it is not. The same value across the flag's rewrites while it stays over. */
  since: number | null
  /** The calls summed, and those left out for want of a price. */
  calls: number
  unpriced: number
  /** The biggest spenders over the window, most first, by session (a session's subagents are its own). */
  top: Spender[]
  /** The one line statusbar shows and the orchestrator says, as the writer composed it. */
  line: string
}

/** What a reader in another language needs: the file, its version and how old its stamp may be. */
export const SPEND_READER_CONTRACT = {
  version: 1,
  dir: SPEND_FLAG_DIR,
  file: SPEND_FLAG_FILE,
  flag_version: SPEND_FLAG_VERSION,
  stale_after_ms: SPEND_FLAG_STALE_AFTER_MS,
} as const

const figure = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function spender(value: unknown): value is Spender {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return typeof s['session'] === 'string' && typeof s['name'] === 'string' && figure(s['usd'])
}

/** The flag a file's text holds, or null: no JSON (a file caught mid-write), another version, or a field of another shape. */
export function parseSpendFlag(text: string): SpendFlag | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const f = value as Record<string, unknown>
  const ok = f['version'] === SPEND_FLAG_VERSION
    && figure(f['at']) && figure(f['window_ms']) && figure(f['rate_usd_per_hour']) && figure(f['threshold_usd_per_hour'])
    && typeof f['over'] === 'boolean' && (f['since'] === null || figure(f['since']))
    && figure(f['calls']) && figure(f['unpriced']) && typeof f['line'] === 'string'
    && Array.isArray(f['top']) && f['top'].every(spender)
  return ok ? (value as SpendFlag) : null
}

/** The flag when it says the spend is over and was computed within SPEND_FLAG_STALE_AFTER_MS of `now`; else null. */
export function raisedFlag(flag: SpendFlag | null, now: number): SpendFlag | null {
  if (flag === null || !flag.over) return null
  return now - flag.at <= SPEND_FLAG_STALE_AFTER_MS && flag.at - now <= SPEND_FLAG_STALE_AFTER_MS ? flag : null
}
