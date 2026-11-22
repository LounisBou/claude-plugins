// The weekly report: what a week of the machine cost and delivered, computed from what is recorded
// and nothing else. Read-only. It reads the day files of the store, the orchestrator's dispatch
// records, round files and measure files, GitHub through `gh`, and the tooling checkout's own
// `npm run prompts` and `npm run rules` (their `--json`); a figure none of them holds
// prints `n/a` and says why, never an estimate. Days are Paris days (the operator's), the store's
// are UTC. Time is injected.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { journalDir, JOURNAL_FOLD_FILE, LEARNING_CONTRACT, parseJournalEvent } from '../../../../core/learning.ts'
import { ROLES } from '../../../../core/names.ts'
import { MEASURE_DIR, MODULE_DIR, parseMeasure, RECORDS_DIR, ROUND_ARCHIVE_DIR, ROUND_DIR } from '../../../../core/orchestration.ts'
import { setting } from '../../../../core/env.ts'
import { moduleDirUnder } from '../../../../core/roots.ts'
import { parseRoundQuestion } from '../../../../core/round-question.ts'
import { num, record, text } from './manifest.ts'
import { dayFiles, eventsDir } from './store.ts'
import { readPrices, UnitCosts, type ClosedRow, type Merged } from './unitcosts.ts'


/** What each figure of the target is held to. */
export const TARGETS = { contextTokens: 200_000, generationMs: 2 * 3_600_000, firstTurnTokens: 60_000, lineToMergeMs: 3_600_000, toolSpendPercent: 20 } as const

/** A cold rewrite: a turn's first call, after an idle gap, that wrote at least this many tokens to the prompt cache and wrote more than it read. */
export const COLD_REWRITE = { minWriteTokens: 10_000 } as const
/** The idle-gap buckets a cold rewrite is counted in, in minutes: under the first bound, up to the second included, above it. Around the cache's one-hour lifetime. */
export const IDLE_BUCKETS_MIN = [55, 65] as const

export interface GhResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}
export type Gh = (args: readonly string[]) => GhResult
/** `npm run -s <script> -- --json` run in a checkout: its status and what it printed. */
export type Check = (checkout: string, script: string) => GhResult

export interface ReportInput {
  readonly config: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly now: number
  /** The first of the seven Paris days; the seven ending today when absent. */
  readonly week: string | undefined
  /** The repositories the tool is made in; the working directory's when empty. */
  readonly tools: readonly string[]
  readonly cwd: string
  readonly gh: Gh
  /** Runs one of the tooling checkout's report scripts; the checkout is `cwd`. */
  readonly check: Check
  /** The `owner/name` a directory's git remote names. */
  readonly repositoryAt: (dir: string) => string | undefined
}

/** The options of `report`, or what is wrong with them. */
export function parseOptions(args: readonly string[]): { week: string | undefined; tools: string[] } | string {
  const tools: string[] = []
  let week: string | undefined
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    const value = args[i + 1]
    if (flag === '--week' && value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && addDays(value, 0) === value) week = value
    else if (flag === '--tool' && value !== undefined && /^[\w.-]+\/[\w.-]+$/.test(value)) tools.push(value)
    else return `${[flag, value].filter(x => x !== undefined).join(' ')}: expected --week <YYYY-MM-DD> or --tool <owner/name>`
  }
  return { week, tools }
}

const PARIS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' })
const parisDay = (ms: number): string => PARIS.format(ms)
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const dayOf = (iso: string | undefined): string | undefined => (iso === undefined || !Number.isFinite(Date.parse(iso)) ? undefined : parisDay(Date.parse(iso)))

const median = (xs: readonly number[]): number | undefined => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? undefined : s.length % 2 === 1 ? s[(s.length - 1) / 2] : ((s[s.length / 2 - 1] ?? 0) + (s[s.length / 2] ?? 0)) / 2
}
const pct = (part: number, whole: number): string => `${whole > 0 ? Math.round((100 * part) / whole) : 0} %`
const usd = (x: number): string => `$${x.toFixed(2)}`
const tok = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`)
const span = (ms: number): string => (ms < 2 * 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`)
const NA = (why: string): string => `n/a — ${why}`
const sum = (o: unknown): number => Object.values(record(o)).reduce<number>((n, v) => n + (num(v) ?? 0), 0)

interface Pending {
  day: string
  plugin: boolean
  /** What decided it: `plugin:<name>`, `hook`, `user`, and so on. */
  by: string | undefined
}
interface Session {
  cwd: string | undefined
  project: string | undefined
  role: string | undefined
  /** The highest cumulative cost seen before the window, and up to its end. */
  before: number
  upTo: number | undefined
  /** The highest cumulative cost seen so far and when: a later event below it is a restart (a resumed session). */
  peak: { cost: number; at: number } | undefined
  restarted: boolean
  /** The per-turn costs of the window's turns: their sum, how many carried one, and whether one carried none. */
  turnCost: number
  turnCosted: number
  turnUncosted: boolean
  /** An event of the session fell in the window. */
  inside: boolean
  tokens: number
  life: number | undefined
  firstContext: number | undefined
  /** The session began in the window, or an event of it came before. */
  began: boolean
  seenBefore: boolean
  live: boolean
  targets: Set<string>
  refused: Pending[]
  summarized: { day: string; all: number; plugin: number; by: string[] } | undefined
}

const isPlugin = (decider: string | undefined): boolean => decider === 'hook' || (decider ?? '').startsWith('plugin')

/** The roles a refusal is counted under, in the order the report prints them: the session names' roles, then `other` for any session of another role or of none. */
export const REFUSAL_ROLES: readonly string[] = [...Object.values(ROLES), 'other']
const roleOfRefusal = (role: string | undefined): string => REFUSAL_ROLES.find(r => r === role) ?? 'other'
const PLUGIN_NAME = new RegExp(LEARNING_CONTRACT.patterns.plugin)

/** The events of the store, folded into what the report needs. */
function gather(input: ReportInput, start: string, end: string, skipped: { n: number }, unit: UnitCosts) {
  const sessions = new Map<string, Session>()
  const questions = new Map<string, number>()
  const turns: { session: string; tokens: number }[] = []
  const calls = new Map<string, Map<string, Call>>()
  for (const name of dayFiles(eventsDir(join(input.config, 'telemetry')))) {
    for (const line of readFileSync(join(eventsDir(join(input.config, 'telemetry')), name), 'utf8').split('\n')) {
      let e: Record<string, unknown>
      try {
        e = record(JSON.parse(line))
      } catch {
        if (line.trim() !== '') skipped.n++
        continue
      }
      const kind = text(e['event'])
      const id = text(e['session'])
      const day = dayOf(text(e['ts']))
      if (kind === undefined || id === undefined || day === undefined) continue
      unit.add(e, day)
      const s = sessions.get(id) ?? { cwd: undefined, project: undefined, role: undefined, before: 0, upTo: undefined, peak: undefined, restarted: false, turnCost: 0, turnCosted: 0, turnUncosted: false, inside: false, tokens: 0, life: undefined, firstContext: undefined, began: false, seenBefore: false, live: false, targets: new Set<string>(), refused: [], summarized: undefined }
      sessions.set(id, s)
      s.cwd = text(e['cwd']) ?? s.cwd
      s.project = text(e['project']) ?? s.project
      s.role = text(e['role']) ?? s.role
      if (kind === 'api_call') {
        // A subagent's call is its own loop's: it makes no turn of the session.
        if (e['agent'] !== undefined) continue
        // A call read by the live writer and again by a backfill is one: it is keyed by its message.
        const call = callOf(e)
        if (call !== undefined) (calls.get(id) ?? calls.set(id, new Map()).get(id))?.set(call.message, call)
        continue
      }
      const inWindow = day >= start && day <= end
      if (day < start) s.seenBefore = true
      if (kind === 'tool_call') s.live = true
      const cost = num(e['cost_usd'])
      if (cost !== undefined && day <= end) {
        const at = Date.parse(text(e['ts']) ?? '')
        // A later event under the highest cost so far is a restart of the host's cumulative figure, not a late line.
        // A host that reads turns ending together out of order may look like one: the session is then summed from
        // its per-turn costs, which are exact, or n/a, never a wrong figure.
        if (s.peak !== undefined && cost < s.peak.cost && at > s.peak.at) s.restarted = true
        if (s.peak === undefined || cost >= s.peak.cost) s.peak = { cost, at }
        if (day < start) s.before = Math.max(s.before, cost)
        s.upTo = Math.max(s.upTo ?? 0, cost)
      }
      if (!inWindow) continue
      s.inside = true
      if (kind === 'session_start') s.began = true
      if (kind === 'turn_end') {
        // A turn with no figure of its own (the host gave none) leaves a sum of the window's turns incomplete.
        const turnCost = num(e['turn_cost_usd'])
        if (turnCost === undefined) s.turnUncosted = true
        else {
          s.turnCost += turnCost
          s.turnCosted++
        }
        const context = num(e['context_tokens'])
        if (context !== undefined) turns.push({ session: id, tokens: context })
        s.firstContext ??= context
      } else if (kind === 'tool_call') {
        if (e['outcome'] === 'refused') s.refused.push({ day, plugin: isPlugin(text(e['decided_by'])), by: text(e['decided_by']) })
        const target = record(e['target'])
        if (text(target['repo']) !== undefined && num(target['pr']) !== undefined) s.targets.add(`${text(target['repo'])}#${num(target['pr'])}`.toLowerCase())
      } else if (kind === 'question' && e['source'] === 'ask_user') {
        questions.set(day, (questions.get(day) ?? 0) + 1)
      } else if (kind === 'session_end' || kind === 'session_summary') {
        s.tokens = Math.max(s.tokens, sum(e['totals']))
        const started = Date.parse(text(e['started']) ?? '')
        const life = kind === 'session_end' ? num(e['duration_ms']) : Date.parse(text(e['ended']) ?? '') - started
        if (life !== undefined && Number.isFinite(life)) s.life = life
        if (kind === 'session_summary') {
          const refusals = Object.entries(record(e['refusals']))
          s.summarized = { day, all: refusals.reduce((n, [, v]) => n + (num(v) ?? 0), 0), plugin: refusals.reduce((n, [k, v]) => n + (isPlugin(k) ? (num(v) ?? 0) : 0), 0), by: refusals.filter(([, v]) => (num(v) ?? 0) > 0).map(([k]) => k) }
        }
      }
    }
  }
  return { sessions, questions, turns, calls }
}

/** What the report reads of an `api_call` event: when it began, its prompt, and what it read and wrote of the prompt cache. */
interface Call {
  message: string
  prompt: string
  start: number
  end: number
  read: number
  write: number
}

function callOf(e: Record<string, unknown>): Call | undefined {
  const [message, prompt, start] = [text(e['message']), text(e['prompt']), Date.parse(text(e['ts']) ?? '')]
  if (message === undefined || prompt === undefined || !Number.isFinite(start)) return undefined
  const usage = record(e['usage'])
  const end = Date.parse(text(e['end']) ?? '')
  return { message, prompt, start, end: Number.isFinite(end) ? Math.max(start, end) : start, read: num(usage['cache_read_input_tokens']) ?? 0, write: num(usage['cache_creation_input_tokens']) ?? 0 }
}

/**
 * The cold-rewrite line, computed from the calls' times: a turn is the calls of a session under one
 * prompt, its first call's idle gap runs from the end of the session's previous call to its start
 * (the session's first call has none), and the first calls of the window that wrote at least
 * `COLD_REWRITE.minWriteTokens` and more than they read are counted per session role with the tokens
 * they wrote, by the gap's bucket.
 */
function coldRewrites(calls: ReadonlyMap<string, ReadonlyMap<string, Call>>, roleOf: (session: string) => string, inWindow: (start: number) => boolean): string {
  const [low, high] = IDLE_BUCKETS_MIN
  const bucket = (ms: number): number => (ms < low * 60_000 ? 0 : ms <= high * 60_000 ? 1 : 2)
  const labels = [`<${low} min`, `${low}-${high} min`, `>${high} min`]
  const roles = new Map<string, { firsts: number; cold: { count: number; tokens: number }[] }>()
  for (const [session, byMessage] of calls) {
    let previous: Call | undefined
    for (const call of [...byMessage.values()].sort((a, b) => a.start - b.start)) {
      if (previous !== undefined && previous.prompt !== call.prompt && inWindow(call.start)) {
        const role = roleOf(session)
        const r = roles.get(role) ?? { firsts: 0, cold: labels.map(() => ({ count: 0, tokens: 0 })) }
        roles.set(role, r)
        r.firsts++
        const cold = r.cold[bucket(Math.max(0, call.start - previous.end))]
        if (cold !== undefined && call.write >= COLD_REWRITE.minWriteTokens && call.write > call.read) {
          cold.count++
          cold.tokens += call.write
        }
      }
      previous = call
    }
  }
  if (roles.size === 0) return NA('no api_call event in the week holds a turn after an idle gap (a past week: `telemetry.ts backfill --calls <transcript>...`)')
  const parts = [...roles].sort(([a], [b]) => (a < b ? -1 : 1)).map(([role, r]) => {
    const count = r.cold.reduce((n, c) => n + c.count, 0)
    const written = r.cold.reduce((n, c) => n + c.tokens, 0)
    return `${role} ${count} of ${r.firsts} (${tok(written)} written; ${r.cold.map((c, i) => `${labels[i]} ${c.count} (${tok(c.tokens)})`).join(', ')})`
  })
  return `${parts.join('; ')} — a turn's first call after an idle gap that wrote ≥ ${tok(COLD_REWRITE.minWriteTokens)} and more than it read, per session role`
}

/** The files of a directory of the orchestrator's module, read by `parse`; a file `parse` refuses is left out. */
function filesOf<T>(dir: string, parse: (body: string) => T, skipped: { n: number }): { name: string; value: T }[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.flatMap(name => {
    try {
      const body = readFileSync(join(dir, name), 'utf8')
      // The module empties the measure file of a closed session: that is no damage.
      return body.trim() === '' ? [] : [{ name, value: parse(body) }]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EISDIR') skipped.n++
      return []
    }
  })
}
const json = (body: string): unknown => JSON.parse(body)

/** The refusals the learning journals hold, each with its guard source and its Paris day: `<config>/<plugin>/journal/*.json`, read as the learning plugin reads them. */
function journalRefusals(config: string, skipped: { n: number }): { found: { plugin: string; code: string; day: string | undefined }[]; journals: Set<string> } {
  const found: { plugin: string; code: string; day: string | undefined }[] = []
  const journals = new Set<string>()
  let plugins: string[]
  try {
    plugins = readdirSync(config)
  } catch (error) {
    // No configuration directory holds no journal; one that cannot be read is a gap the heading counts.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') skipped.n++
    return { found, journals }
  }
  for (const name of plugins.filter(n => PLUGIN_NAME.test(n))) {
    const dir = journalDir(config, name)
    if (!existsSync(dir)) continue
    journals.add(name)
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      skipped.n++
      continue
    }
    for (const file of files.filter(f => f.endsWith('.json') && f !== JOURNAL_FOLD_FILE)) {
      try {
        const event = parseJournalEvent(JSON.parse(readFileSync(join(dir, file), 'utf8')))
        if (event === undefined) skipped.n++
        else if (!('fact' in event) && event.kind === 'refusal') found.push({ plugin: event.source.plugin, code: event.source.code, day: dayOf(event.at) })
      } catch {
        skipped.n++
      }
    }
  }
  return { found, journals }
}

/** The closed rows of every dispatch record the registry points at: `{opened, closed}` in ms, and the review rounds the row had. */
function dispatchLines(module: string, skipped: { n: number }): (ClosedRow & { opened: number })[] {
  const paths = new Set<string>()
  for (const { value } of filesOf(join(module, RECORDS_DIR), body => body, skipped)) {
    for (const path of value.split('\n')) if (path.trim() !== '') paths.add(path.trim())
  }
  const rows: (ClosedRow & { opened: number })[] = []
  for (const path of paths) {
    let body = ''
    try {
      body = readFileSync(path, 'utf8')
    } catch { /* a record that is gone holds no row */ }
    for (const line of body.split('\n')) {
      try {
        const row = record(JSON.parse(line))
        const [opened, closed] = [Date.parse(text(row['opened']) ?? ''), Date.parse(text(row['closed']) ?? '')]
        if (row['state'] === 'closed' && Number.isFinite(opened) && Number.isFinite(closed)) rows.push({ opened, closed, rounds: num(row['rounds']) })
      } catch { /* a line that is no row */ }
    }
  }
  return rows
}

function ghJson(gh: Gh, args: readonly string[], limit: number): unknown[] | string {
  const r = gh([...args, '--limit', String(limit)])
  if (r.status !== 0) return `gh ${args.slice(0, 2).join(' ')} ${args[3] ?? ''} failed: ${r.stderr.trim().split('\n')[0] ?? ''}`.trim()
  try {
    const value: unknown = JSON.parse(r.stdout)
    if (!Array.isArray(value)) return 'gh answered something else than a list'
    return value.length >= limit ? `the listing reached its limit of ${limit}, the week may be cut` : value
  } catch {
    return 'gh answered no JSON'
  }
}

/** The JSON a script of the checkout printed, or why there is none. A script that fails with figures still prints them: only a missing or unparsable answer is n/a. */
function checkJson(input: ReportInput, script: string): Record<string, unknown> | string {
  const r = input.check(input.cwd, script)
  try {
    const value: unknown = JSON.parse(r.stdout)
    if (Array.isArray(value) || typeof value !== 'object' || value === null) return `npm run ${script} answered something else than an object`
    return record(value)
  } catch {
    return `npm run ${script} in ${input.cwd} printed no JSON${r.stderr.trim() === '' ? '' : `: ${r.stderr.trim().split('\n')[0]}`}`
  }
}

/** The three lines the checks that report, not block, add to the week: prompt budgets, duplicates, rules held by prose alone. */
function checkLines(input: ReportInput): string[] {
  const prompts = checkJson(input, 'prompts')
  const rules = checkJson(input, 'rules')
  const lines: string[] = []
  const budgets = typeof prompts === 'string' ? undefined : Object.entries(record(prompts['budgets'])).map(([plugin, b]) => ({ plugin, tokens: num(record(b)['tokens']), budget: num(record(b)['budget']) }))
  if (typeof prompts === 'string') lines.push(`prompt budgets: ${NA(prompts)}`)
  else if (budgets === undefined || budgets.length === 0 || budgets.some(b => b.tokens === undefined)) lines.push(`prompt budgets: ${NA('npm run prompts listed no plugin or a plugin without its tokens')}`)
  else {
    const figure = (b: (typeof budgets)[number]): string => `${b.plugin} ${b.tokens}/${b.budget ?? 'no budget'}`
    const over = budgets.filter(b => b.budget === undefined || (b.tokens ?? 0) > b.budget)
    const within = budgets.filter(b => !over.includes(b))
    lines.push(`prompt budgets: ${over.length === 0 ? `all ${budgets.length} ${budgets.length === 1 ? 'plugin' : 'plugins'} within their budget` : `${over.length} of ${budgets.length} ${budgets.length === 1 ? 'plugin' : 'plugins'} over their budget (${over.map(figure).join(', ')})`}${within.length === 0 ? '' : `${over.length === 0 ? ' ' : '; within: '}(${within.map(figure).join(', ')})`}`)
  }
  const dupes = typeof prompts === 'string' ? undefined : record(prompts['duplicates'])
  const [count, ceiling] = [num(dupes?.['count']), num(dupes?.['ceiling'])]
  if (typeof prompts === 'string') lines.push(`duplicates: ${NA(prompts)}`)
  else if (count === undefined || ceiling === undefined) lines.push(`duplicates: ${NA('npm run prompts gave no count or no ceiling')}`)
  else lines.push(`duplicates: ${count} ${count === 1 ? 'sentence' : 'sentences'} said more than once, ceiling ${ceiling}: ${count > ceiling ? 'over' : 'within'}`)
  const plugins = typeof rules === 'string' ? undefined : (Array.isArray(rules['plugins']) ? rules['plugins'].map(record) : undefined)
  if (typeof rules === 'string') lines.push(`rules held by prose alone: ${NA(rules)}`)
  else if (plugins === undefined || plugins.length === 0 || plugins.some(p => num(p['rules']) === undefined || num(p['left']) === undefined)) lines.push(`rules held by prose alone: ${NA('npm run rules gave no counts per plugin')}`)
  else {
    const total = (key: string): number => plugins.reduce((n, p) => n + (num(p[key]) ?? 0), 0)
    const left = plugins.filter(p => (num(p['left']) ?? 0) > 0).map(p => `${text(p['plugin']) ?? '?'} ${num(p['left'])}`)
    lines.push(`rules held by prose alone: ${total('left')} of ${total('rules')} (held by code ${total('byCode')}, named by an eval ${total('byEval')})${left.length === 0 ? '' : `; by plugin: ${left.join(', ')}`}`)
  }
  return lines
}

export function report(input: ReportInput): string[] {
  const start = input.week ?? addDays(parisDay(input.now), -6)
  const end = addDays(start, 6)
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i))
  const inWindow = (day: string | undefined): boolean => day !== undefined && day >= start && day <= end
  const module = moduleDirUnder(input.config, input.env['ORCHESTRATOR_MODULE_DIR'])
  const tools = input.tools.length > 0 ? input.tools : [input.repositoryAt(input.cwd)].filter((r): r is string => r !== undefined)
  const skipped = { n: 0 }
  // The prices are the orchestrator's (its protected root's routing/prices.json): the cost rule is core's usage-cost.ts.
  const priceFile = join(setting(input.env, 'ORCHESTRATOR_STATE_DIR') ?? join(input.config, MODULE_DIR), 'routing', 'prices.json')
  const priced = readPrices(priceFile)
  const unit = new UnitCosts('prices' in priced ? priced.prices : undefined, addDays(start, -1), end)
  const { sessions, questions, turns, calls } = gather(input, start, end, skipped, unit)
  const isTool = (name: string): boolean => tools.some(t => t.toLowerCase() === name.toLowerCase())
  const remotes = new Map<string, string | undefined>()
  const repositoryAt = (dir: string): string | undefined => (remotes.has(dir) ? remotes.get(dir) : remotes.set(dir, input.repositoryAt(dir)).get(dir))
  const out: string[] = [`weekly report ${start} → ${end} (Europe/Paris), tool: ${tools.join(', ') || NA('not run in a repository and no --tool')}`]

  // Spend: a session's cost in the week is its cumulative cost at the week's end less before it; a
  // resumed session whose cumulative cost restarted lower is summed from its per-turn costs, else n/a.
  const kept: { s: Session; cost: number | undefined }[] = []
  let restartedSummed = 0
  let restartedUnknown = 0
  for (const s of sessions.values()) {
    let cost: number | undefined
    // A session whose cumulative cost restarted lower: its spend is real, only unknown, so it stays counted.
    if (s.restarted) cost = s.turnCosted > 0 && !s.turnUncosted ? s.turnCost : undefined
    // A session seen before the week with no cost before it has no baseline: its cost is unknown, not all of the week's.
    else cost = s.upTo === undefined || (s.seenBefore && s.before === 0) ? undefined : s.upTo - s.before
    if (s.tokens === 0 && (cost ?? 0) === 0 && !(s.restarted && s.inside)) continue
    if (s.restarted && cost === undefined) restartedUnknown++
    else if (s.restarted) restartedSummed++
    kept.push({ s, cost })
  }
  // The checkouts that exist: the directories of the kept sessions that name a repository through git.
  const checkouts = new Map<string, string>()
  for (const { s } of kept) {
    const repo = s.cwd === undefined ? undefined : repositoryAt(s.cwd)
    if (s.cwd !== undefined && repo !== undefined) checkouts.set(s.cwd, repo)
  }
  const unattributed = { gone: 0, ambiguous: 0, none: 0 }
  let byAncestry = 0
  const attribute = (s: Session): string | undefined => {
    if (s.project?.includes('/')) return s.project
    if (s.cwd === undefined) {
      unattributed.none++
      return undefined
    }
    const direct = checkouts.get(s.cwd)
    if (direct !== undefined) return direct
    // A directory that names no repository (a deleted worktree): the repository of the nearest known checkout
    // above it; else of the checkouts below the nearest directory that holds some, when they all agree.
    const ancestors: string[] = []
    for (let dir = dirname(s.cwd); dir !== dirname(dir); dir = dirname(dir)) ancestors.push(dir)
    const above = ancestors.map(dir => checkouts.get(dir)).find(repo => repo !== undefined)
    if (above !== undefined) {
      byAncestry++
      return above
    }
    for (const dir of ancestors) {
      const below = new Set([...checkouts].filter(([path]) => path.startsWith(`${dir}/`)).map(([, repo]) => repo))
      if (below.size === 0) continue
      if (below.size > 1) {
        unattributed.ambiguous++
        return undefined
      }
      byAncestry++
      return [...below][0]
    }
    unattributed.gone++
    return undefined
  }
  const groups = new Map<string, { cost: number; tokens: number }>()
  const prCost = new Map<string, number>()
  let known = 0
  let unnamed = 0
  for (const { s, cost } of kept) {
    if (cost !== undefined) known++
    const project = attribute(s)
    const g = groups.get(project ?? 'unattributed') ?? { cost: 0, tokens: 0 }
    groups.set(project ?? 'unattributed', { cost: g.cost + (cost ?? 0), tokens: g.tokens + s.tokens })
    const [only, ...more] = s.targets
    if (cost === undefined) continue
    if (only !== undefined && more.length === 0) prCost.set(only, (prCost.get(only) ?? 0) + cost)
    else unnamed += cost
  }
  const active = kept.length
  const share = (pick: (g: { cost: number; tokens: number }) => number): string => {
    const all = [...groups.values()].reduce((n, g) => n + pick(g), 0)
    if (all === 0) return NA('none known in the week')
    const of = (keep: (name: string) => boolean): number => [...groups].reduce((n, [name, g]) => n + (keep(name) ? pick(g) : 0), 0)
    const [tool, other] = [of(isTool), of(name => name !== 'unattributed' && !isTool(name))]
    return `tool ${pct(tool, all)}, product ${pct(other, all)}, unattributed ${pct(all - tool - other, all)}`
  }
  out.push('', `spend (cost known for ${known} of ${active} sessions; tokens are the whole-session totals of those that ended in the week)`)
  out.push(`  cost    ${share(g => g.cost)}`, `  tokens  ${share(g => g.tokens)}`)
  const spent = [...groups.values()].reduce((n, g) => n + g.cost, 0)
  const toolShare = (100 * [...groups].reduce((n, [name, g]) => n + (isTool(name) ? g.cost : 0), 0)) / spent
  const unattributedShare = (100 * (groups.get('unattributed')?.cost ?? 0)) / spent
  // The tool's real share lies between what is attributed to it and that plus everything unattributed. The cap is suspended: the line informs.
  const [low, upper] = [Math.round(toolShare), Math.round(toolShare + unattributedShare)]
  const cap = `${TARGETS.toolSpendPercent} % cap (suspended)`
  const verdict = low > TARGETS.toolSpendPercent ? `above the ${cap}` : upper <= TARGETS.toolSpendPercent ? `within the ${cap}` : `the range straddles the ${cap}`
  out.push(spent === 0 || tools.length === 0 ? `  cap     ${NA(tools.length === 0 ? 'no tool repository' : 'no cost known in the week')}` : `  cap     tool ${low} % of the week's spend (range ${low}–${upper} %: ${Math.round(unattributedShare)} % unattributed), cost known for ${known} of ${active} sessions: ${verdict}`)
  const left = unattributed.gone + unattributed.ambiguous + unattributed.none
  if (left > 0 || byAncestry > 0) {
    const why = [[unattributed.gone, 'directory names no repository, no known checkout around it'], [unattributed.ambiguous, 'directory names no repository, the checkouts around it name several'], [unattributed.none, 'no directory and no project']] as const
    out.push(`  attribution: ${byAncestry} by the ancestry of a directory that names no repository; ${left} left unattributed${left > 0 ? ` (${why.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`).join('; ')})` : ''}`)
  }
  if (restartedSummed + restartedUnknown > 0) out.push(`  restarted: ${restartedSummed + restartedUnknown} resumed sessions whose cumulative cost restarted lower: ${restartedSummed} summed from their per-turn costs, ${restartedUnknown} n/a`)
  for (const [name, g] of [...groups].sort(([, a], [, b]) => b.cost - a.cost || b.tokens - a.tokens)) {
    out.push(`  ${name.padEnd(36)} ${(isTool(name) ? 'tool' : name === 'unattributed' ? 'unattributed' : 'product').padEnd(12)} ${usd(g.cost).padStart(9)} ${tok(g.tokens).padStart(7)}`)
  }

  // Pull requests merged in the week: delay from GitHub, cost from the sessions that name only that one.
  // GitHub names ignore case, and a pull request target is kept in lower case: a repository spelt two ways is listed once,
  // as the first of the tools, the groups and the targets spells it.
  const repos: string[] = []
  for (const r of [...tools, ...[...groups.keys()].filter(g => g.includes('/')), ...[...prCost.keys()].map(k => k.split('#')[0] ?? '')]) {
    if (r !== '' && !repos.some(known => known.toLowerCase() === r.toLowerCase())) repos.push(r)
  }
  const delays: number[] = []
  const mergedByDay = new Map<string, number>()
  let unlisted = 0
  out.push('', 'pull requests merged (created → merged, cost of the sessions that name that one pull request)')
  for (const repo of repos) {
    const listed = ghJson(input.gh, ['pr', 'list', '-R', repo, '--state', 'merged', '--search', `merged:>=${addDays(start, -1)}`, '--json', 'number,createdAt,mergedAt'], 1000)
    if (typeof listed === 'string') {
      unlisted++
      out.push(`  ${repo}: ${NA(listed)}`)
      continue
    }
    for (const row of listed.map(record).filter(r => inWindow(dayOf(text(r['mergedAt'])))).sort((a, b) => (num(a['number']) ?? 0) - (num(b['number']) ?? 0))) {
      const delay = Date.parse(text(row['mergedAt']) ?? '') - Date.parse(text(row['createdAt']) ?? '')
      if (Number.isFinite(delay)) delays.push(delay)
      const mergedDay = dayOf(text(row['mergedAt']))
      if (mergedDay !== undefined) mergedByDay.set(mergedDay, (mergedByDay.get(mergedDay) ?? 0) + 1)
      const spent = prCost.get(`${repo}#${num(row['number'])}`.toLowerCase())
      out.push(`  ${repo}#${num(row['number'])}  ${(Number.isFinite(delay) ? span(delay) : 'n/a').padStart(8)}  ${spent === undefined ? 'cost n/a' : usd(spent)}`)
    }
  }
  if (delays.length === 0) out.push('  none listed')
  out.push(`  cost of sessions that name no pull request or several: ${usd(unnamed)}${prCost.size === 0 ? ' (no tool call of the week names its pull request: the per-pull-request cost is n/a)' : ''}`)

  // Questions and refusals per day.
  // Both forms of a round file, by core's reader: the one `ask` writes and the one the relay writes.
  const round = [...filesOf(join(module, ROUND_DIR), json, skipped), ...filesOf(join(module, ROUND_DIR, ROUND_ARCHIVE_DIR), json, skipped)]
    .flatMap(f => { const question = parseRoundQuestion(f.value); return question?.kind === 'operator' && inWindow(dayOf(question.at)) ? [{ at: question.at, blocks: text(record(f.value)['blocks']) }] : [] })
  const refusals = new Map<string, { all: number; plugin: number }>()
  /** The plugins the events name as having refused a call. */
  const deciders = new Set<string>()
  const byRole = new Map<string, { all: number; plugin: number }>(REFUSAL_ROLES.map(role => [role, { all: 0, plugin: 0 }]))
  for (const s of sessions.values()) {
    // A session with live calls counts them on their days; one with only a summary counts its lifetime refusals on the day it ended.
    const counted = s.live || s.summarized === undefined ? s.refused.map(r => ({ day: r.day, all: 1, plugin: r.plugin ? 1 : 0, by: r.by === undefined ? [] : [r.by] })) : [s.summarized]
    const role = byRole.get(roleOfRefusal(s.role)) ?? { all: 0, plugin: 0 }
    for (const c of counted) {
      const d = refusals.get(c.day) ?? { all: 0, plugin: 0 }
      refusals.set(c.day, { all: d.all + c.all, plugin: d.plugin + c.plugin })
      role.all += c.all
      role.plugin += c.plugin
      for (const by of c.by) if (by.startsWith('plugin:')) deciders.add(by.slice('plugin:'.length))
    }
  }
  out.push('', 'day         questions  refusals  of them by a plugin')
  for (const day of days) {
    const asked = round.filter(r => dayOf(r.at) === day).length + (questions.get(day) ?? 0)
    out.push(`${day}  ${String(asked).padStart(9)}  ${String(refusals.get(day)?.all ?? 0).padStart(8)}  ${String(refusals.get(day)?.plugin ?? 0).padStart(19)}`)
  }

  // Refusals per guard source, from the learning journals (the only place a guard's code is kept), and per role, from the events.
  const sources = new Map<string, { plugin: string; code: string; count: number }>()
  const journaled = journalRefusals(input.config, skipped)
  for (const r of journaled.found) {
    if (!inWindow(r.day)) continue
    const key = `${r.plugin} ${r.code}`
    sources.set(key, { plugin: r.plugin, code: r.code, count: (sources.get(key)?.count ?? 0) + 1 })
  }
  out.push('', 'refusals by guard source (the learning journals: plugin and guard code)')
  for (const { plugin, code, count } of [...sources.values()].sort((a, b) => b.count - a.count || (a.plugin + a.code < b.plugin + b.code ? -1 : 1))) {
    out.push(`  ${plugin.padEnd(14)} ${code.padEnd(44)} ${String(count).padStart(5)}`)
  }
  if (sources.size === 0) out.push('  none in the journals for the week')
  // Coverage: a plugin keeps a journal or not, so the table holds the codes of those that do; the role table counts every refusal the events hold.
  const noJournal = [...deciders].filter(name => !journaled.journals.has(name)).sort()
  out.push(`  coverage: this table counts ${[...sources.values()].reduce((n, c) => n + c.count, 0)} refusals, the role table ${[...byRole.values()].reduce((n, d) => n + d.all, 0)}; no journal for ${noJournal.length === 0 ? 'any plugin that refused' : noJournal.join(', ')}`)
  out.push('', 'role          refusals  of them by a plugin')
  for (const [role, d] of byRole) out.push(`${role.padEnd(12)}  ${String(d.all).padStart(8)}  ${String(d.plugin).padStart(19)}`)

  out.push('', `cold rewrites: ${coldRewrites(calls, session => sessions.get(session)?.role ?? 'other', start => inWindow(parisDay(start)))}`)

  const closedRows = dispatchLines(module, skipped)
  const mergedPrs: Merged = repos.length === 0 ? { why: 'no repository to list the pull requests of' } : unlisted === repos.length ? { why: 'gh listed no repository\'s pull requests' } : { byDay: mergedByDay, unlisted }
  out.push(...unit.lines({ days, prices: 'prices' in priced ? priced.prices : undefined, noPrices: 'why' in priced ? priced.why : '', merged: mergedPrs, rows: closedRows.length === 0 ? undefined : closedRows, dayOf: parisDay }))

  // The figures of the target, in its order.
  const roleTurns = new Map<string, number[]>()
  for (const t of turns) {
    const role = sessions.get(t.session)?.role ?? 'other'
    roleTurns.set(role, [...(roleTurns.get(role) ?? []), t.tokens])
  }
  const high = turns.filter(t => t.tokens > TARGETS.contextTokens).length
  const orchestrators = [...sessions].filter(([, s]) => s.role === 'orchestrator')
  const lives = orchestrators.flatMap(([, s]) => (s.life !== undefined && Number.isFinite(s.life) ? [s.life] : []))
  const starts = new Map<string, number>()
  for (const { name, value } of filesOf(join(module, MEASURE_DIR), json, skipped)) {
    const measured = parseMeasure(JSON.stringify(value))
    if (measured?.start !== undefined && inWindow(dayOf(measured.start.at))) starts.set(name.replace(/\.json$/, ''), measured.start.tokens)
  }
  const firsts = orchestrators.flatMap(([id, s]) => { const f = starts.get(id) ?? (s.began ? s.firstContext : undefined); return f === undefined ? [] : [f] })
  const lines = closedRows.filter(l => inWindow(parisDay(l.closed))).map(l => l.closed - l.opened)
  const asked = round.flatMap(r => (r.blocks === undefined ? [] : [r.blocks]))
  const repeated = asked.filter((b, i) => asked.indexOf(b) < i).length
  const merged = median(delays)
  const lineMedian = median(lines)
  const runs = tools.map(repo => [repo, ghJson(input.gh, ['run', 'list', '-R', repo, '--branch', 'main', '--created', `>=${addDays(start, -1)}`, '--json', 'conclusion,createdAt'], 500)] as const)
  const failed = runs.find(([, r]) => typeof r === 'string')
  const rows = runs.flatMap(([, r]) => (typeof r === 'string' ? [] : r.map(record).filter(x => inWindow(dayOf(text(x['createdAt']))))))
  const figures: string[] = [
    turns.length === 0 ? NA('no turn_end event with a context fill in the week') : `${high} of ${turns.length} turns above ${tok(TARGETS.contextTokens)} (${pct(high, turns.length)}), peak ${tok(turns.reduce((n, t) => Math.max(n, t.tokens), 0))}; ${[...roleTurns].map(([role, xs]) => `${role} ${xs.filter(x => x > TARGETS.contextTokens).length}/${xs.length}`).join(', ')}`,
    lives.length === 0 ? NA('no orchestrator session ended in the week') : `median ${span(median(lives) ?? 0)} over ${lives.length} orchestrator sessions (target ≥ ${span(TARGETS.generationMs)})`,
    firsts.length === 0 ? NA('no orchestrator start in a measure file and no turn_end of one') : `median ${tok(median(firsts) ?? 0)} over ${firsts.length} orchestrator sessions (target ≤ ${tok(TARGETS.firstTurnTokens)})`,
    merged === undefined && lineMedian === undefined ? NA('no pull request merged and no line closed in the week') : `pull request ${merged === undefined ? NA('none merged') : `median ${span(merged)} over ${delays.length}${unlisted > 0 ? `, ${unlisted} repository listing(s) n/a` : ''}`}; line ${lineMedian === undefined ? NA('none closed') : `median ${span(lineMedian)} over ${lines.length}`} (target ≤ ${span(TARGETS.lineToMergeMs)})`,
    round.length === 0 ? NA('no operator question in round/ for the week') : `${repeated} of ${round.length} questions repeat an earlier one's blocks line, exact match (a floor; target 0)`,
    tools.length === 0 ? NA('no tool repository') : failed !== undefined && typeof failed[1] === 'string' ? NA(`${failed[0]}: ${failed[1]}`) : rows.length === 0 ? NA('no run of main in the week') : `${rows.filter(x => x['conclusion'] === 'success').length} green, ${rows.filter(x => x['conclusion'] === 'failure').length} red runs on main (target 0 red)`,
  ]
  const names = ['context height', 'life of an orchestrator session', 'first turn of a new session', 'delay line → merge', 'a question reaches him once', 'main green']
  out.push('', ...figures.map((f, i) => `${i + 1} ${names[i] ?? ''}: ${f}`))
  out.push('', ...checkLines(input))
  if (skipped.n > 0) out[0] += ` (${skipped.n} unreadable event lines or files left out)`
  return out
}
