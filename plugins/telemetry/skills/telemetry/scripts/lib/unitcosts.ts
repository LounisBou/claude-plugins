// The unit costs of the weekly report: per Paris day, what an agent session and a review reader
// cost, how many readers a merged pull request had, how many closed dispatch rows were reviewed in
// two rounds or more, and which `escape` events name a pull request a reader had read. Computed from
// the events the report's reading hands to `add`, and from the operator's price file (the cost rule
// is core's `usage-cost.ts`); a figure no source holds prints `n/a` and why, never an estimate. A
// unit cost that moved more than `JUMP` against the previous day, with at least `MIN_COUNT`
// sessions or readers on both days, is flagged. Pure: nothing is read from the disk here but
// `readPrices`'s file.
import { readFileSync } from 'node:fs'
import { messageCost, recordOfEntry, type Price, type Prices } from '../../../../core/usage-cost.ts'
import { num, record, text } from './manifest.ts'

/** A unit cost is flagged when it moved by more than this share of the previous day's. */
export const JUMP = 0.5
/** A day's unit cost is compared only when it holds at least this many sessions or readers, on both days. */
export const MIN_COUNT = 5
/** What a session or a reader prints under when its events do not name the tier, the effort or the model. */
export const UNKNOWN = 'unknown'

const NA = (why: string): string => `n/a — ${why}`
const figure = (x: number): string => x.toFixed(x < 0.1 ? 3 : 2)
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** The price file's entries by model, or why there are none. */
export function readPrices(path: string): { prices: Prices } | { why: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { why: `${path} is not readable (${code ?? (error instanceof Error ? error.message : String(error))})` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { why: `${path} holds no JSON object` }
  return { prices: Object.fromEntries(Object.entries(parsed).filter(([, price]) => typeof price === 'object' && price !== null)) as Prices }
}

/** The closed dispatch rows the report read: when each closed (ms) and how many review rounds it had. */
export interface ClosedRow {
  readonly closed: number
  /** Undefined when the row records none: it is neither reviewed nor not reviewed. */
  readonly rounds: number | undefined
}

/** What the report knows of the pull requests merged: their count per Paris day, or why it does not. */
export type Merged = { readonly byDay: ReadonlyMap<string, number>; readonly unlisted: number } | { readonly why: string }

export interface UnitInput {
  /** The report's seven Paris days. */
  readonly days: readonly string[]
  readonly prices: Prices | undefined
  /** Why there are no prices, when there are none. */
  readonly noPrices: string
  readonly merged: Merged
  /** The closed rows of the dispatch records, undefined when none is readable. */
  readonly rows: readonly ClosedRow[] | undefined
  /** The Paris day of a time in ms. */
  readonly dayOf: (ms: number) => string
}

interface Facts {
  role?: string | undefined
  tier?: string | undefined
  effort?: string | undefined
}
interface Reader {
  day: string
  at: number
  session: string
  child: string
  models: string[]
  effort: string | undefined
  repo: string | undefined
  pr: number | undefined
  head: string | undefined
  cost: number
  /** A call of it was on a model the price file does not hold, or none was recorded. */
  unpriced: boolean
  calls: Set<string>
}
interface Escape {
  day: string
  names: string[]
  repo: string | undefined
}
interface Cell {
  cost: number
  n: number
}

/** The reader a subagent's run end names, or undefined when it is no review reader. */
const isReader = (e: Record<string, unknown>): boolean => e['kind'] === 'subagent' && text(e['lens']) !== undefined

export class UnitCosts {
  private readonly facts = new Map<string, Facts>()
  /** A session's cost per day: `<day>|<session>` → the sum of its turns' own costs. */
  private readonly spent = new Map<string, number>()
  /** The session days with a turn that carried no cost of its own: their sum is partial. */
  private readonly partial = new Set<string>()
  private readonly readers = new Map<string, Reader>()
  private readonly escapes = new Map<string, Escape>()
  /** Costs of the calls of a reader seen before the run end that names it. */
  private readonly early = new Map<string, { cost: number; unpriced: boolean; calls: Set<string> }>()

  private readonly prices: Prices | undefined
  private readonly from: string
  private readonly to: string

  /** `prices` price a reader's calls; the costs of the days from `from` to `to` are kept (a reader's and an escape's are kept whatever the day). */
  constructor(prices: Prices | undefined, from: string, to: string) {
    this.prices = prices
    this.from = from
    this.to = to
  }

  /** One event of the store, with its Paris day. */
  add(e: Record<string, unknown>, day: string): void {
    const kind = text(e['event'])
    const session = text(e['session'])
    if (kind === undefined || session === undefined) return
    const facts = this.facts.get(session) ?? {}
    this.facts.set(session, facts)
    facts.role = text(e['role']) ?? facts.role
    facts.tier = text(e['launch_tier']) ?? facts.tier
    if (e['agent'] === undefined) facts.effort = text(e['effort']) ?? facts.effort
    if (kind === 'turn_end') {
      const cost = num(e['turn_cost_usd'])
      if (day >= this.from && day <= this.to) {
        if (cost === undefined) this.partial.add(`${day}|${session}`)
        else this.spent.set(`${day}|${session}`, (this.spent.get(`${day}|${session}`) ?? 0) + cost)
      }
    } else if (kind === 'api_call') {
      const child = text(e['agent'])
      if (child !== undefined && day >= this.from && day <= this.to) this.call(session, child, e)
    } else if (kind === 'agent_closed' && isReader(e)) {
      this.reader(session, e, day)
    } else if (kind === 'escape') {
      const names = Array.isArray(e['names']) ? e['names'].filter((n): n is string => typeof n === 'string') : []
      // The same fix written twice (the call and its result) is one escape.
      this.escapes.set(`${session}|${text(e['ts'])}|${names.join(',')}`, { day, names, repo: text(record(e['target'])['repo']) })
    }
  }

  private call(session: string, child: string, e: Record<string, unknown>): void {
    const key = `${session}/${child}`
    const message = text(e['message'])
    const entry = this.readers.get(key) ?? this.early.get(key) ?? { cost: 0, unpriced: false, calls: new Set<string>() }
    if (!this.readers.has(key)) this.early.set(key, entry)
    // A call read by the live writer and again by a backfill is one, keyed by its message.
    if (message === undefined) {
      entry.unpriced = true
      return
    }
    if (entry.calls.has(message)) return
    entry.calls.add(message)
    const usage = recordOfEntry({ type: 'assistant', timestamp: text(e['ts']), message: { id: message, model: text(e['model']), usage: e['usage'] } })
    if (usage === null) {
      entry.unpriced = true
      return
    }
    const price: Price | undefined = this.prices?.[usage.record.model]
    const cost = price === undefined ? null : messageCost(usage.record, price)
    if (cost === null) entry.unpriced = true
    else entry.cost += cost
  }

  private reader(session: string, e: Record<string, unknown>, day: string): void {
    const child = text(e['child'])
    if (child === undefined) return
    const key = `${session}/${child}`
    const target = record(e['target'])
    const range = text(e['range'])
    const before = this.readers.get(key)
    const gathered = this.early.get(key)
    this.early.delete(key)
    const models = Array.isArray(e['models']) ? e['models'].filter((m): m is string => typeof m === 'string').sort() : []
    const at = Date.parse(text(e['ts']) ?? '')
    this.readers.set(key, {
      // A reader counts on the day of its first run's end; a later run changes its model and effort, not its day.
      day: before?.day ?? day,
      at: Number.isFinite(at) ? at : before?.at ?? 0,
      session,
      child,
      models: models.length > 0 ? models : before?.models ?? [],
      effort: text(e['effort']) ?? before?.effort,
      repo: text(target['repo']) ?? before?.repo,
      pr: num(target['pr']) ?? before?.pr,
      head: range?.split('..')[1] ?? before?.head,
      cost: before?.cost ?? gathered?.cost ?? 0,
      unpriced: before?.unpriced ?? gathered?.unpriced ?? false,
      calls: before?.calls ?? gathered?.calls ?? new Set<string>(),
    })
  }

  /** Sessions of the role `agent`, by day then `tier/effort`. */
  private sessionCells(): { cells: Map<string, Map<string, Cell>>; partial: Map<string, number> } {
    const days = new Map<string, Map<string, Cell>>()
    const partial = new Map<string, number>()
    for (const key of this.partial) {
      const [day = '', session = ''] = key.split('|')
      if (this.facts.get(session)?.role === 'agent') partial.set(day, (partial.get(day) ?? 0) + 1)
    }
    for (const [key, cost] of this.spent) {
      const [day = '', session = ''] = key.split('|')
      const facts = this.facts.get(session)
      if (facts?.role !== 'agent' || this.partial.has(key)) continue
      const cells = days.get(day) ?? new Map<string, Cell>()
      days.set(day, cells)
      const cell = `${facts.tier ?? UNKNOWN}/${facts.effort ?? UNKNOWN}`
      const was = cells.get(cell) ?? { cost: 0, n: 0 }
      cells.set(cell, { cost: was.cost + cost, n: was.n + 1 })
    }
    return { cells: days, partial }
  }

  /** The priced readers, by day then `model/effort`; the readers with a call no price covers, or no call, counted apart. */
  private readerCells(): { cells: Map<string, Map<string, Cell>>; count: Map<string, number>; unpriced: Map<string, number> } {
    const cells = new Map<string, Map<string, Cell>>()
    const count = new Map<string, number>()
    const unpriced = new Map<string, number>()
    for (const r of this.readers.values()) {
      if (r.day < this.from || r.day > this.to) continue
      count.set(r.day, (count.get(r.day) ?? 0) + 1)
      if (r.unpriced || r.calls.size === 0) {
        unpriced.set(r.day, (unpriced.get(r.day) ?? 0) + 1)
        continue
      }
      const byDay = cells.get(r.day) ?? new Map<string, Cell>()
      cells.set(r.day, byDay)
      const cell = `${r.models.join('+') || UNKNOWN}/${r.effort ?? UNKNOWN}`
      const was = byDay.get(cell) ?? { cost: 0, n: 0 }
      byDay.set(cell, { cost: was.cost + r.cost, n: was.n + 1 })
    }
    return { cells, count, unpriced }
  }

  /** The cells that moved by more than `JUMP` against the previous day, with at least `MIN_COUNT` on both days, as flag lines. */
  private flags(what: string, unit: string, cells: ReadonlyMap<string, ReadonlyMap<string, Cell>>, days: readonly string[]): string[] {
    const lines: string[] = []
    for (const day of days) {
      for (const [name, after] of cells.get(day)?.entries() ?? []) {
        const before = cells.get(addDays(day, -1))?.get(name)
        if (before === undefined || before.n < MIN_COUNT || after.n < MIN_COUNT) continue
        const [was, now] = [before.cost / before.n, after.cost / after.n]
        if (was > 0 && Math.abs(now - was) / was > JUMP) lines.push(`  ${what} ${name} on ${day}: ${figure(was)} → ${figure(now)} USD (${after.n} ${unit})`)
      }
    }
    return lines
  }

  /** The `escape` events of the window joined to the readers that read the pull request they name. */
  private escapeLines(days: readonly string[]): string[] {
    const known = new Set([...this.readers.values()].flatMap(r => (r.repo === undefined ? [] : [r.repo.toLowerCase()])))
    const byPr = new Map<string, Reader[]>()
    for (const r of this.readers.values()) if (r.repo !== undefined && r.pr !== undefined) byPr.set(`${r.repo.toLowerCase()}#${r.pr}`, [...(byPr.get(`${r.repo.toLowerCase()}#${r.pr}`) ?? []), r])
    const resolve = (name: string, repo: string | undefined): string | undefined => {
      const match = /^(.*)#(\d+)$/.exec(name)
      const [, owner = '', number = ''] = match ?? []
      if (match === null) return undefined
      if (owner === '') return repo === undefined ? undefined : `${repo.toLowerCase()}#${number}`
      if (owner.includes('/')) return `${owner.toLowerCase()}#${number}`
      const full = [...known].filter(k => k.endsWith(`/${owner.toLowerCase()}`))
      return full.length === 1 ? `${full[0]}#${number}` : undefined
    }
    const lines: string[] = []
    for (const day of days) {
      const today = [...this.escapes.values()].filter(x => x.day === day)
      // A pull request a day's fixes name more than once is one line.
      const details = new Map<string, { joined: boolean; text: string }>()
      for (const escape of today) {
        for (const name of escape.names) {
          const resolved = resolve(name, escape.repo)
          const readers = resolved === undefined ? undefined : byPr.get(resolved)
          if (resolved === undefined || readers === undefined) {
            details.set(resolved ?? `${escape.repo ?? ''}|${name}`, details.get(resolved ?? `${escape.repo ?? ''}|${name}`) ?? { joined: false, text: `      ${name}: ${resolved === undefined ? 'names no repository the readers read, so it is not joined' : 'no review reader of it in the store'}` })
            continue
          }
          // The review that read it last: its head and what its readers ran on.
          const last = readers.reduce((a, b) => (b.at >= a.at ? b : a))
          const same = readers.filter(r => r.head === last.head)
          const ran = [...new Set(same.map(r => `${r.models.join('+') || UNKNOWN}/${r.effort ?? UNKNOWN}`))].join(', ')
          if (!details.has(resolved)) details.set(resolved, { joined: true, text: `      ${name}: read at ${last.head?.slice(0, 12) ?? UNKNOWN} by ${same.length} reader(s) on ${ran}` })
        }
      }
      const joined = [...details.values()].filter(d => d.joined).length
      lines.push(`  ${day}  ${today.length} escape(s) naming ${details.size} pull request(s), ${joined} joined to a review`, ...[...details.values()].map(d => d.text))
    }
    return lines
  }

  /** The report's section, and the flag lines after it. */
  lines(input: UnitInput): string[] {
    const out: string[] = []
    const { days } = input
    const joinCells = (cells: ReadonlyMap<string, Cell> | undefined, unit: string): string =>
      cells === undefined || cells.size === 0 ? 'none' : [...cells].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, c]) => `${name} $${figure(c.cost / c.n)} (${c.n} ${unit})`).join('; ')

    out.push('', 'unit costs per day (API list prices, an equivalent and never a bill; Paris days)')
    out.push('  agent sessions: USD per session by tier/effort, the sessions that spent that day (a session spanning days counts on each)')
    const { cells: sessions, partial } = this.sessionCells()
    for (const day of days) {
      const left = partial.get(day) ?? 0
      out.push(`  ${day}  ${joinCells(sessions.get(day), 'sessions')}${left > 0 ? `; ${left} session(s) with a turn of no recorded cost, left out` : ''}`)
    }

    const readers = this.readerCells()
    if (input.prices === undefined) {
      out.push('  review readers: ' + NA(input.noPrices))
    } else {
      out.push('  review readers: USD per reader by model/effort')
      for (const day of days) {
        const skipped = readers.unpriced.get(day) ?? 0
        out.push(`  ${day}  ${joinCells(readers.cells.get(day), 'readers')}${skipped > 0 ? `; ${skipped} reader(s) with no price or no recorded call, left out` : ''}`)
      }
    }
    out.push('  readers per merged pull request: the readers that ended that day (any repository) over the pull requests merged that day (the repositories listed)')
    for (const day of days) {
      const count = readers.count.get(day) ?? 0
      if ('why' in input.merged) out.push(`  ${day}  ${count} readers, merged pull requests: ${NA(input.merged.why)}`)
      else if (input.merged.unlisted > 0) out.push(`  ${day}  ${count} readers, merged pull requests: ${NA(`${input.merged.unlisted} repository listing(s) failed, the merges are partial`)}`)
      else {
        const merged = input.merged.byDay.get(day) ?? 0
        out.push(`  ${day}  ${count} readers, ${merged} merged${merged > 0 ? ` = ${(count / merged).toFixed(1)} per pull request` : ''}`)
      }
    }

    out.push('  dispatch rows closed that day, reviewed in two rounds or more (of those reviewed at least once)')
    if (input.rows === undefined) out.push('  ' + NA('no closed row in any readable dispatch record (no record registry, or none of its paths exists)'))
    else {
      for (const day of days) {
        const closed = input.rows.filter(r => input.dayOf(r.closed) === day)
        const reviewed = closed.filter(r => (r.rounds ?? 0) >= 1)
        const twice = reviewed.filter(r => (r.rounds ?? 0) >= 2).length
        const unrecorded = closed.filter(r => r.rounds === undefined).length
        out.push(`  ${day}  ${reviewed.length === 0 ? 'no reviewed row closed' : `${twice} of ${reviewed.length} (${Math.round((100 * twice) / reviewed.length)} %)`}${unrecorded > 0 ? `; ${unrecorded} row(s) with no recorded rounds, left out` : ''}`)
      }
    }

    out.push('  escapes (a fix naming pull requests), each name joined to the review that read it last: its head and its readers\' model/effort')
    out.push(...this.escapeLines(days))

    const flagged = [
      ...this.flags('agent sessions', 'sessions', sessions, days),
      ...(input.prices === undefined ? [] : this.flags('readers', 'readers', readers.cells, days)),
    ]
    out.push(`  unit cost moved more than ${Math.round(JUMP * 100)} % against the previous day (at least ${MIN_COUNT} sessions or readers on both days)`)
    out.push(...(flagged.length === 0 ? ['  none'] : flagged))
    return out
  }
}
