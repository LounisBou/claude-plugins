// hooks/usage.ts
// A session's token use and what it would cost at API list prices, for the deck (deck.ts):
// the machine runs on a subscription, so the figure is an equivalent, never a bill. The cost
// rule is core's (usage-cost.ts, which routing.py's `cost` reads too); the code here only
// keeps the sums. Pure on purpose, and importing nothing but core: the suite runs it outside
// the host.
//
// The sums are kept current by a book per session: per transcript file the offset already
// read, and one record per message, so a deck write reads only the lines appended since the
// last one and a period boundary passed is summed again from the records, never re-read.
import type { DeckPeriod, DeckTokens, DeckUsage } from '../core/deck.ts'
import { COST_RULE, messageCost, recordOf, recordOfEntry, type Price, type Prices, type UsageRecord } from '../core/usage-cost.ts'

// What the module and its tests read of the cost rule through this file.
export { COST_RULE, messageCost, recordOf }
export type { Price, Prices, UsageRecord }

export const USAGE_TIMEZONE = 'Europe/Paris'

type Sums = { from: number; tokens: DeckTokens; cost: number; unpriced: number }
type FileState = { offset: number; keys: Set<string> }
export type UsageBook = {
  files: Map<string, FileState>
  records: Map<string, UsageRecord>
  // The files carrying each record: a message id the main transcript and a subagent's both
  // carry stays while either one still does.
  holders: Map<string, Set<string>>
  // The lines dropped as no JSON, the reader's partial last line never among them.
  malformed: number
  prices: Prices
  pricesText: string | null
  day: Sums
  week: Sums
}

function emptySums(from: number): Sums {
  return { from, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, cost: 0, unpriced: 0 }
}

function addTo(sums: Sums, record: UsageRecord, prices: Prices, sign: 1 | -1): void {
  if (sums.from !== -Infinity && !(record.at >= sums.from)) return
  sums.tokens.input += sign * record.input
  sums.tokens.output += sign * record.output
  sums.tokens.cache_read += sign * record.cache_read
  sums.tokens.cache_write += sign * record.cache_write
  const price = Object.prototype.hasOwnProperty.call(prices, record.model) ? prices[record.model] : undefined
  const cost = price ? messageCost(record, price) : null
  if (cost === null) sums.unpriced += sign
  else sums.cost += sign * cost
}

function summed(records: Iterable<UsageRecord>, prices: Prices, from: number): Sums {
  const sums = emptySums(from)
  for (const record of records) addTo(sums, record, prices, 1)
  return sums
}

// The records from `from` on, summed: the cost is null when any of them has no price. A
// `from` of -Infinity takes every record, one without a timestamp included.
export function sumsOf(records: Iterable<UsageRecord>, prices: Prices, from: number): { tokens: DeckTokens; cost: number | null } {
  const sums = summed(records, prices, from)
  return { tokens: sums.tokens, cost: sums.unpriced > 0 ? null : sums.cost }
}

// --- the periods ----------------------------------------------------------------------

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: USAGE_TIMEZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})

// The Paris wall clock at `ms`, read as if it were UTC.
function wallOf(ms: number): number {
  const parts = new Map<string, number>()
  for (const part of PARTS.formatToParts(new Date(ms))) if (part.type !== 'literal') parts.set(part.type, Number(part.value))
  const at = (type: string) => parts.get(type) ?? NaN
  return Date.UTC(at('year'), at('month') - 1, at('day'), at('hour'), at('minute'), at('second'))
}

// The instant Paris reads 00:00 on that calendar day (month from 0, day may overflow). The
// offset is taken twice: once at the naive guess, then at the instant it gives, so a day
// whose midnight and noon sit on two sides of a change still lands on its own midnight.
function parisMidnight(year: number, month: number, day: number): number {
  const naive = Date.UTC(year, month, day)
  const guess = naive - (wallOf(naive) - naive)
  return naive - (wallOf(guess) - guess)
}

// The current day's and the current ISO week's starts in Paris, as instants.
export function periodStarts(now: number): { day: number; week: number } {
  const wall = new Date(wallOf(Math.floor(now / 1000) * 1000))
  const year = wall.getUTCFullYear(), month = wall.getUTCMonth(), date = wall.getUTCDate()
  const back = (wall.getUTCDay() + 6) % 7
  return { day: parisMidnight(year, month, date), week: parisMidnight(year, month, date - back) }
}

// --- the book -------------------------------------------------------------------------

export function newBook(): UsageBook {
  return { files: new Map(), records: new Map(), holders: new Map(), prices: {}, pricesText: null, malformed: 0, day: emptySums(NaN), week: emptySums(NaN) }
}

// Before a read: the prices in force and the periods of `now`. The records older than the
// current week are in no period any more and are dropped; a period whose start moved, or new
// prices, is summed again from the records the book keeps.
export function settle(book: UsageBook, now: number, prices: Prices, pricesText: string): void {
  const starts = periodStarts(now)
  for (const [key, record] of book.records) {
    if (!(record.at < starts.week)) continue
    for (const path of book.holders.get(key) ?? []) book.files.get(path)?.keys.delete(key)
    book.records.delete(key)
    book.holders.delete(key)
  }
  const repriced = book.pricesText !== pricesText
  book.prices = prices
  book.pricesText = pricesText
  if (repriced || book.day.from !== starts.day) book.day = summed(book.records.values(), prices, starts.day)
  if (repriced || book.week.from !== starts.week) book.week = summed(book.records.values(), prices, starts.week)
}

// The lines read from `path` at `offset` (complete lines only), and the bytes they spanned.
export function ingest(book: UsageBook, path: string, offset: number, text: string, consumed: number): void {
  let file = book.files.get(path)
  if (!file) book.files.set(path, file = { offset: 0, keys: new Set() })
  let index = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      book.malformed++
      continue
    }
    const read = recordOfEntry(entry)
    if (!read) continue
    const key = read.id ?? `${path}\n${offset}\n${index++}`
    const previous = book.records.get(key)
    if (previous) {
      addTo(book.day, previous, book.prices, -1)
      addTo(book.week, previous, book.prices, -1)
    }
    book.records.set(key, read.record)
    let holders = book.holders.get(key)
    if (!holders) book.holders.set(key, holders = new Set())
    holders.add(path)
    file.keys.add(key)
    addTo(book.day, read.record, book.prices, 1)
    addTo(book.week, read.record, book.prices, 1)
  }
  file.offset = offset + consumed
}

// A file shorter than its offset was rewritten: what it gave is forgotten, the sums are taken
// again from the records left, and the next read starts at its first byte.
export function rewind(book: UsageBook, path: string): void {
  if (!book.files.has(path)) return
  forget(book, path)
  book.files.set(path, { offset: 0, keys: new Set() })
}

// A file gone (a subagent transcript removed): what it gave alone is no longer the session's.
export function forget(book: UsageBook, path: string): void {
  const file = book.files.get(path)
  if (!file) return
  for (const key of file.keys) {
    const holders = book.holders.get(key)
    holders?.delete(path)
    if (holders && holders.size > 0) continue
    book.records.delete(key)
    book.holders.delete(key)
  }
  book.files.delete(path)
  book.day = summed(book.records.values(), book.prices, book.day.from)
  book.week = summed(book.records.values(), book.prices, book.week.from)
}

function periodOf(sums: Sums): DeckPeriod {
  return { from: new Date(sums.from).toISOString(), tokens: { ...sums.tokens }, cost_usd: sums.unpriced > 0 ? null : sums.cost }
}

export function usageOf(book: UsageBook, now: number): DeckUsage {
  return { day: periodOf(book.day), week: periodOf(book.week), at: new Date(now).toISOString() }
}

// --- the reader -----------------------------------------------------------------------

// The lines appended to `path` from byte `offset` on, `length` bytes of them: only the lines
// a usage can be read from (the filter is loose, recordOf decides), then one line holding the
// record separator and the bytes the complete lines spanned. A separator is appended after
// the window, so the line it closes, the one still being written, is neither printed nor
// counted; JSON escapes every control character, so no transcript line carries it. Bytes are
// counted in the C locale, where awk's length is a byte count.
export function appendedArgv(path: string, offset: number, length: number): string[] {
  const awk = '/\\036$/ { exit } { n += length($0) + 1 } index($0, "\\"usage\\"") && index($0, "assistant") { print } END { printf "\\036%d\\n", n }'
  return ['sh', '-c', `{ tail -c +"$2" "$1" | head -c "$3"; printf '\\036'; } | LC_ALL=C awk '${awk}'`, 'sh', path, String(offset + 1), String(length)]
}

// The reader's answer back: the matched lines and the bytes consumed; null when it is no
// answer of the reader's (its last line is not the separator's).
export function consumedOf(stdout: string): { text: string; consumed: number } | null {
  const end = stdout.lastIndexOf('\x1e')
  if (end < 0 || (end > 0 && stdout[end - 1] !== '\n')) return null
  const consumed = Number(stdout.slice(end + 1).trim())
  if (!Number.isInteger(consumed) || consumed < 0) return null
  return { text: stdout.slice(0, end), consumed }
}
