// The spend flag's computation: the machine's token spend over the last hour, from the `api_call`
// events of every session (a session's own loop and its subagents'), priced as the orchestrator's
// deck prices a message (core's usage-cost.ts, the prices of the orchestrator's `routing/prices.json`),
// and whether it is past the threshold. The result is core's `SpendFlag`, written beside the
// events for statusbar and the orchestrator to read. A signal: nothing here refuses anything.
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { moduleDirOf } from '../../../../core/orchestration.ts'
import {
  parseSpendFlag, SPEND_FLAG_EVERY_MS, SPEND_FLAG_FILE, SPEND_FLAG_STALE_AFTER_MS, SPEND_FLAG_VERSION, SPEND_TOP_MAX, type SpendFlag, type Spender,
} from '../../../../core/spend-flag.ts'
import { readText, writeAtomic } from '../../../../core/store.ts'
import { messageCost, recordOfEntry, type Price, type Prices } from '../../../../core/usage-cost.ts'
import { titleFromTranscriptHead, TRANSCRIPT_HEAD_BYTES, type Event } from '../../../../hooks/collect.ts'
import type { EnvSecrets } from './redact.ts'
import { parseEvent } from './store.ts'
import { transcriptOf } from './transcript.ts'

/** The span the rate is taken over. */
export const SPEND_WINDOW_MS = 3_600_000

/** The threshold, in US dollars an hour at API list prices: the environment's value, else ~/.env's, else the default. */
export const SPEND_THRESHOLD_VARIABLE = 'TELEMETRY_SPEND_ALERT_USD_PER_HOUR'
export const SPEND_THRESHOLD_DEFAULT = 300

/** A spender's name is cut to this many characters in the line. */
export const SPENDER_NAME_MAX = 40

/** The threshold a value gives: a positive number, else the default. */
export function spendThreshold(env: Readonly<Record<string, string | undefined>>, secrets: EnvSecrets): number {
  const n = Number(env[SPEND_THRESHOLD_VARIABLE] || secrets.get(SPEND_THRESHOLD_VARIABLE))
  return Number.isFinite(n) && n > 0 ? n : SPEND_THRESHOLD_DEFAULT
}

/** The orchestrator's price table (`routing/prices.json` under its module directory): none when it is absent or no JSON object. */
export function readPrices(moduleDir: string): Prices {
  try {
    const value: unknown = JSON.parse(readFileSync(join(moduleDir, 'routing', 'prices.json'), 'utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Prices) : {}
  } catch {
    return {}
  }
}

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10)

/** The `api_call` events of the window ending at `now`, read from the day files that overlap it. */
export function recentCalls(dir: string, now: number, windowMs = SPEND_WINDOW_MS): Event[] {
  const events: Event[] = []
  for (const day of new Set([dayOf(now - windowMs), dayOf(now)])) {
    const file = join(dir, `${day}.jsonl`)
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"api_call"')) continue
      const event = parseEvent(line)
      if (typeof event === 'string' || event.event !== 'api_call') continue
      const at = Date.parse(event.ts)
      if (at > now - windowMs && at <= now) events.push(event)
    }
  }
  return events
}

const object = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** The cost of one `api_call` at its model's price; undefined for the host's placeholder, null when the model has no price. */
function costOf(event: Event, prices: Prices): number | null | undefined {
  const model = event['model']
  const read = recordOfEntry({ type: 'assistant', timestamp: event.ts, message: { id: event['message'], model, usage: object(event['usage']) } })
  if (read === null) return undefined
  const price: Price | undefined = typeof model === 'string' && Object.prototype.hasOwnProperty.call(prices, model) ? prices[model] : undefined
  return price === undefined ? null : messageCost(read.record, price)
}

/** A session's title from the head of its transcript, where the host writes the name it was launched or renamed under; undefined when there is none or it cannot be read. */
export function titleOfSession(config: string, session: string): string | undefined {
  const path = transcriptOf(config, session)
  if (path === undefined) return undefined
  try {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES)
      return titleFromTranscriptHead(buffer.toString('utf8', 0, readSync(fd, buffer, 0, TRANSCRIPT_HEAD_BYTES, 0)))
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

const shorten = (name: string): string => (name.length > SPENDER_NAME_MAX ? `${name.slice(0, SPENDER_NAME_MAX - 1)}…` : name)

/** The one line: the rate against the threshold, and the biggest spenders. */
export function spendLine(rate: number, threshold: number, over: boolean, top: readonly Spender[]): string {
  const head = `spend ${Math.round(rate)} $/h over the last hour, ${over ? 'past' : 'under'} ${Math.round(threshold)} $/h`
  return top.length === 0 || !over ? head : `${head} — top: ${top.map(s => `${shorten(s.name)} ${Math.round(s.usd)} $`).join(', ')}`
}

export interface SpendInput {
  readonly events: readonly Event[]
  readonly prices: Prices
  readonly now: number
  readonly threshold: number
  /** The flag as it stands, for the episode's start. */
  readonly previous: SpendFlag | null
  /** A session's name when no event of the window names it (the biggest spenders only are asked). */
  readonly nameOf?: (session: string) => string | undefined
}

/** The flag over the window ending at `now`. A call is counted once however often it was recorded; a model with no price leaves its calls out and counts them as unpriced. */
export function computeSpend({ events, prices, now, threshold, previous, nameOf }: SpendInput): SpendFlag {
  const seen = new Set<string>()
  const spent = new Map<string, number>()
  const names = new Map<string, { at: number; name: string }>()
  let calls = 0
  let unpriced = 0
  for (const event of events) {
    const key = `${event.session}\n${String(event['message'] ?? `${event.ts}\n${String(event['agent'] ?? '')}`)}`
    if (seen.has(key)) continue
    seen.add(key)
    const cost = costOf(event, prices)
    if (cost === undefined) continue
    calls++
    const title = event['title']
    const at = Date.parse(event.ts)
    if (typeof title === 'string' && title !== '' && at >= (names.get(event.session)?.at ?? -Infinity)) names.set(event.session, { at, name: title })
    if (cost === null) {
      unpriced++
      continue
    }
    spent.set(event.session, (spent.get(event.session) ?? 0) + cost)
  }
  const total = [...spent.values()].reduce((sum, usd) => sum + usd, 0)
  const rate = (total * 3_600_000) / SPEND_WINDOW_MS
  const top = [...spent]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SPEND_TOP_MAX)
    .map(([session, usd]) => ({ session, name: names.get(session)?.name ?? nameOf?.(session) ?? session.slice(0, 8), usd }))
  const over = rate > threshold
  const continued = previous !== null && previous.over && previous.since !== null && now - previous.at <= SPEND_FLAG_STALE_AFTER_MS
  return {
    version: SPEND_FLAG_VERSION, at: now, window_ms: SPEND_WINDOW_MS, rate_usd_per_hour: rate, threshold_usd_per_hour: threshold, over,
    since: over ? (continued ? (previous.since ?? now) : now) : null, calls, unpriced, top, line: spendLine(rate, threshold, over, top),
  }
}

export const spendFlagPath = (stateDir: string): string => join(stateDir, SPEND_FLAG_FILE)

/** The flag on file, or null when there is none or it is no flag. */
export function readSpendFlag(stateDir: string): SpendFlag | null {
  const text = readText(spendFlagPath(stateDir))
  return text === undefined ? null : parseSpendFlag(text)
}

export interface RefreshOptions {
  readonly stateDir: string
  readonly eventsDir: string
  readonly config: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly secrets: EnvSecrets
  readonly now: number
  /** Recompute whatever the flag on file says of its age. */
  readonly force?: boolean
}

/** Recomputes the flag and writes it, unless the one on file is younger than SPEND_FLAG_EVERY_MS; answers the flag written, or undefined when none was. */
export function refreshSpend(options: RefreshOptions): SpendFlag | undefined {
  const { stateDir, now } = options
  const previous = readSpendFlag(stateDir)
  if (options.force !== true && previous !== null && now - previous.at >= 0 && now - previous.at < SPEND_FLAG_EVERY_MS) return undefined
  const flag = computeSpend({
    events: recentCalls(options.eventsDir, now),
    prices: readPrices(moduleDirOf(options.config, options.env['ORCHESTRATOR_MODULE_DIR'])),
    now,
    threshold: spendThreshold(options.env, options.secrets),
    previous,
    nameOf: session => titleOfSession(options.config, session),
  })
  writeAtomic(spendFlagPath(stateDir), `${JSON.stringify(flag)}\n`)
  return flag
}
