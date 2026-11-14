// The weekly report: what a week of the machine cost and delivered, computed from what is recorded
// and nothing else. Read-only. It reads the day files of the store, the orchestrator's dispatch
// records, round files and measure files, and GitHub through `gh`; a figure none of them holds
// prints `n/a` and says why, never an estimate. Days are Paris days (the operator's), the store's
// are UTC. Time is injected.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEASURE_DIR, moduleDirOf, parseMeasure } from '../../../../core/orchestration.ts'
import { num, record, text } from './manifest.ts'
import { dayFiles, eventsDir } from './store.ts'

/** The orchestrator's directories under its module directory (docs/contracts.md, « Weekly report reads »). */
export const RECORDS_DIR = 'records'
export const ROUND_DIR = 'round'

/** What each figure of the target is held to. */
export const TARGETS = { contextTokens: 200_000, generationMs: 2 * 3_600_000, firstTurnTokens: 60_000, lineToMergeMs: 3_600_000, toolSpendPercent: 20 } as const

export interface GhResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}
export type Gh = (args: readonly string[]) => GhResult

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
    if (flag === '--week' && value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value)) week = value
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
}
interface Session {
  cwd: string | undefined
  project: string | undefined
  role: string | undefined
  /** The highest cumulative cost seen before the window, and up to its end. */
  before: number
  upTo: number | undefined
  tokens: number
  life: number | undefined
  firstContext: number | undefined
  targets: Set<string>
  refused: Pending[]
  summarized: { day: string; all: number; plugin: number } | undefined
}

const isPlugin = (decider: string | undefined): boolean => decider === 'hook' || (decider ?? '').startsWith('plugin')

/** The events of the store, folded into what the report needs. */
function gather(input: ReportInput, start: string, end: string) {
  const sessions = new Map<string, Session>()
  const questions = new Map<string, number>()
  const turns: { session: string; tokens: number }[] = []
  for (const name of dayFiles(eventsDir(join(input.config, 'telemetry')))) {
    for (const line of readFileSync(join(eventsDir(join(input.config, 'telemetry')), name), 'utf8').split('\n')) {
      let e: Record<string, unknown>
      try {
        e = record(JSON.parse(line))
      } catch {
        continue
      }
      const kind = text(e['event'])
      const id = text(e['session'])
      const day = dayOf(text(e['ts']))
      if (kind === undefined || id === undefined || day === undefined) continue
      const s = sessions.get(id) ?? { cwd: undefined, project: undefined, role: undefined, before: 0, upTo: undefined, tokens: 0, life: undefined, firstContext: undefined, targets: new Set<string>(), refused: [], summarized: undefined }
      sessions.set(id, s)
      s.cwd = text(e['cwd']) ?? s.cwd
      s.project = text(e['project']) ?? s.project
      s.role = text(e['role']) ?? s.role
      const inWindow = day >= start && day <= end
      const cost = num(e['cost_usd'])
      if (cost !== undefined && day <= end) {
        if (day < start) s.before = Math.max(s.before, cost)
        s.upTo = Math.max(s.upTo ?? 0, cost)
      }
      if (!inWindow) continue
      if (kind === 'turn_end') {
        const context = num(e['context_tokens'])
        if (context !== undefined) turns.push({ session: id, tokens: context })
        s.firstContext ??= context
      } else if (kind === 'tool_call') {
        if (e['outcome'] === 'refused') s.refused.push({ day, plugin: isPlugin(text(e['decided_by'])) })
        const target = record(e['target'])
        if (text(target['repo']) !== undefined && num(target['pr']) !== undefined) s.targets.add(`${text(target['repo'])}#${num(target['pr'])}`)
      } else if (kind === 'question' && e['source'] === 'ask_user') {
        questions.set(day, (questions.get(day) ?? 0) + 1)
      } else if (kind === 'session_end' || kind === 'session_summary') {
        s.tokens = Math.max(s.tokens, sum(e['totals']))
        const started = Date.parse(text(e['started']) ?? '')
        s.life = kind === 'session_end' ? num(e['duration_ms']) : Number.isFinite(started) ? Date.parse(text(e['ended']) ?? '') - started : undefined
        if (kind === 'session_summary') {
          const refusals = Object.entries(record(e['refusals']))
          s.summarized = { day, all: refusals.reduce((n, [, v]) => n + (num(v) ?? 0), 0), plugin: refusals.reduce((n, [k, v]) => n + (isPlugin(k) ? (num(v) ?? 0) : 0), 0) }
        }
      }
    }
  }
  return { sessions, questions, turns }
}

/** The files of a directory of the orchestrator's module, read by `parse`; a file `parse` refuses is left out. */
function filesOf<T>(dir: string, parse: (body: string) => T): { name: string; value: T }[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.flatMap(name => {
    try {
      return [{ name, value: parse(readFileSync(join(dir, name), 'utf8')) }]
    } catch {
      return []
    }
  })
}
const json = (body: string): unknown => JSON.parse(body)

/** The closed rows of every dispatch record the registry points at: `{opened, closed}` in ms. */
function dispatchLines(module: string): { opened: number; closed: number }[] {
  const paths = new Set<string>()
  for (const { value } of filesOf(join(module, RECORDS_DIR), body => body)) {
    for (const path of value.split('\n')) if (path.trim() !== '') paths.add(path.trim())
  }
  const rows: { opened: number; closed: number }[] = []
  for (const path of paths) {
    let body = ''
    try {
      body = readFileSync(path, 'utf8')
    } catch { /* a record that is gone holds no row */ }
    for (const line of body.split('\n')) {
      try {
        const row = record(JSON.parse(line))
        const [opened, closed] = [Date.parse(text(row['opened']) ?? ''), Date.parse(text(row['closed']) ?? '')]
        if (row['state'] === 'closed' && Number.isFinite(opened) && Number.isFinite(closed)) rows.push({ opened, closed })
      } catch { /* a line that is no row */ }
    }
  }
  return rows
}

function ghJson(gh: Gh, args: readonly string[]): unknown[] | string {
  const r = gh(args)
  if (r.status !== 0) return `gh ${args.slice(0, 2).join(' ')} ${args[3] ?? ''} failed: ${r.stderr.trim().split('\n')[0] ?? ''}`.trim()
  try {
    const value: unknown = JSON.parse(r.stdout)
    return Array.isArray(value) ? value : 'gh answered something else than a list'
  } catch {
    return 'gh answered no JSON'
  }
}

export function report(input: ReportInput): string[] {
  const start = input.week ?? addDays(parisDay(input.now), -6)
  const end = addDays(start, 6)
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i))
  const inWindow = (day: string | undefined): boolean => day !== undefined && day >= start && day <= end
  const module = moduleDirOf(input.config, input.env['ORCHESTRATOR_MODULE_DIR'])
  const tools = input.tools.length > 0 ? input.tools : [input.repositoryAt(input.cwd)].filter((r): r is string => r !== undefined)
  const { sessions, questions, turns } = gather(input, start, end)
  const out: string[] = [`weekly report ${start} → ${end} (Europe/Paris), tool: ${tools.join(', ') || NA('not run in a repository and no --tool')}`]

  // Spend: a session's cost in the week is its cumulative cost at the week's end less before it.
  const groups = new Map<string, { cost: number; tokens: number }>()
  const prCost = new Map<string, number>()
  let known = 0
  let active = 0
  let unnamed = 0
  for (const s of sessions.values()) {
    const cost = s.upTo === undefined ? undefined : s.upTo - s.before
    if (s.tokens === 0 && (cost ?? 0) === 0) continue
    active++
    if (cost !== undefined) known++
    const project = s.project?.includes('/') ? s.project : s.cwd === undefined ? undefined : input.repositoryAt(s.cwd)
    const g = groups.get(project ?? 'unattributed') ?? { cost: 0, tokens: 0 }
    groups.set(project ?? 'unattributed', { cost: g.cost + (cost ?? 0), tokens: g.tokens + s.tokens })
    const [only, ...more] = s.targets
    if (only !== undefined && more.length === 0) prCost.set(only, (prCost.get(only) ?? 0) + (cost ?? 0))
    else if ((cost ?? 0) > 0) unnamed += cost ?? 0
  }
  const share = (pick: (g: { cost: number; tokens: number }) => number): string => {
    const all = [...groups.values()].reduce((n, g) => n + pick(g), 0)
    const of = (keep: (name: string) => boolean): number => [...groups].reduce((n, [name, g]) => n + (keep(name) ? pick(g) : 0), 0)
    const [tool, other] = [of(name => tools.includes(name)), of(name => name !== 'unattributed' && !tools.includes(name))]
    return `tool ${pct(tool, all)}, product ${pct(other, all)}, unattributed ${pct(all - tool - other, all)}`
  }
  out.push('', `spend (cost known for ${known} of ${active} sessions; tokens are the whole-session totals of those that ended in the week)`)
  out.push(`  cost    ${share(g => g.cost)}`, `  tokens  ${share(g => g.tokens)}`)
  const spent = [...groups.values()].reduce((n, g) => n + g.cost, 0)
  const toolShare = (100 * [...groups].reduce((n, [name, g]) => n + (tools.includes(name) ? g.cost : 0), 0)) / spent
  out.push(spent === 0 ? `  cap     ${NA('no cost known in the week')}` : `  cap     tool ${Math.round(toolShare)} % of the week's spend, cap ${TARGETS.toolSpendPercent} %: ${toolShare > TARGETS.toolSpendPercent ? `OVER by ${Math.round(toolShare - TARGETS.toolSpendPercent)} points, only removal pull requests pass` : 'within'}`)
  for (const [name, g] of [...groups].sort(([, a], [, b]) => b.cost - a.cost || b.tokens - a.tokens)) {
    out.push(`  ${name.padEnd(36)} ${(tools.includes(name) ? 'tool' : name === 'unattributed' ? 'unattributed' : 'product').padEnd(12)} ${usd(g.cost).padStart(9)} ${tok(g.tokens).padStart(7)}`)
  }

  // Pull requests merged in the week: delay from GitHub, cost from the sessions that name only that one.
  const repos = [...new Set([...tools, ...[...groups.keys()].filter(r => r.includes('/')), ...[...prCost.keys()].map(k => k.split('#')[0] ?? '')])].filter(r => r !== '')
  const delays: number[] = []
  out.push('', 'pull requests merged (created → merged, cost of the sessions that name that one pull request)')
  for (const repo of repos) {
    const listed = ghJson(input.gh, ['pr', 'list', '-R', repo, '--state', 'merged', '--search', `merged:>=${addDays(start, -1)}`, '--limit', '1000', '--json', 'number,createdAt,mergedAt'])
    if (typeof listed === 'string') {
      out.push(`  ${repo}: ${NA(listed)}`)
      continue
    }
    for (const row of listed.map(record).filter(r => inWindow(dayOf(text(r['mergedAt'])))).sort((a, b) => (num(a['number']) ?? 0) - (num(b['number']) ?? 0))) {
      const delay = Date.parse(text(row['mergedAt']) ?? '') - Date.parse(text(row['createdAt']) ?? '')
      delays.push(delay)
      const spent = prCost.get(`${repo}#${num(row['number'])}`)
      out.push(`  ${repo}#${num(row['number'])}  ${span(delay).padStart(8)}  ${spent === undefined ? 'cost n/a' : usd(spent)}`)
    }
  }
  if (delays.length === 0) out.push('  none listed')
  out.push(`  cost of sessions that name no pull request or several: ${usd(unnamed)}${prCost.size === 0 ? ' (no tool call of the week names its pull request: the per-pull-request cost is n/a)' : ''}`)

  // Questions and refusals per day.
  const round = filesOf(join(module, ROUND_DIR), json).map(f => record(f.value)).filter(r => r['kind'] === 'operator' && inWindow(dayOf(text(r['since']))))
  const refusals = new Map<string, { all: number; plugin: number }>()
  for (const s of sessions.values()) {
    const counted = s.summarized === undefined ? s.refused.map(r => ({ day: r.day, all: 1, plugin: r.plugin ? 1 : 0 })) : [s.summarized]
    for (const c of counted) {
      const d = refusals.get(c.day) ?? { all: 0, plugin: 0 }
      refusals.set(c.day, { all: d.all + c.all, plugin: d.plugin + c.plugin })
    }
  }
  out.push('', 'day         questions  refusals  of them by a plugin')
  for (const day of days) {
    const asked = round.filter(r => dayOf(text(r['since'])) === day).length + (questions.get(day) ?? 0)
    out.push(`${day}  ${String(asked).padStart(9)}  ${String(refusals.get(day)?.all ?? 0).padStart(8)}  ${String(refusals.get(day)?.plugin ?? 0).padStart(19)}`)
  }

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
  for (const { name, value } of filesOf(join(module, MEASURE_DIR), json)) {
    const measured = parseMeasure(JSON.stringify(value))
    if (measured?.start !== undefined && inWindow(dayOf(measured.start.at))) starts.set(name.replace(/\.json$/, ''), measured.start.tokens)
  }
  const firsts = orchestrators.flatMap(([id, s]) => { const f = starts.get(id) ?? s.firstContext; return f === undefined ? [] : [f] })
  const lines = dispatchLines(module).filter(l => inWindow(parisDay(l.closed))).map(l => l.closed - l.opened)
  const asked = round.map(r => text(r['blocks'])).filter((b): b is string => b !== undefined)
  const repeated = asked.filter((b, i) => asked.indexOf(b) < i).length
  const merged = median(delays)
  const lineMedian = median(lines)
  const runs = tools.map(repo => [repo, ghJson(input.gh, ['run', 'list', '-R', repo, '--branch', 'main', '--limit', '500', '--json', 'conclusion,createdAt'])] as const)
  const failed = runs.find(([, r]) => typeof r === 'string')
  const rows = runs.flatMap(([, r]) => (typeof r === 'string' ? [] : r.map(record).filter(x => inWindow(dayOf(text(x['createdAt']))))))
  const figures: string[] = [
    NA('which lines can run and which agents are alive is host state (ListAgents), never recorded'),
    NA('the time from a merge to its installation needs the plugin cache\'s install times, which nothing records'),
    turns.length === 0 ? NA('no turn_end event with a context fill in the week') : `${high} of ${turns.length} turns above ${tok(TARGETS.contextTokens)} (${pct(high, turns.length)}), peak ${tok(Math.max(...turns.map(t => t.tokens)))}; ${[...roleTurns].map(([role, xs]) => `${role} ${xs.filter(x => x > TARGETS.contextTokens).length}/${xs.length}`).join(', ')}`,
    lives.length === 0 ? NA('no orchestrator session ended in the week') : `median ${span(median(lives) ?? 0)} over ${lives.length} orchestrator sessions (target ≥ ${span(TARGETS.generationMs)})`,
    firsts.length === 0 ? NA('no orchestrator start in a measure file and no turn_end of one') : `median ${tok(median(firsts) ?? 0)} over ${firsts.length} orchestrator sessions (target ≤ ${tok(TARGETS.firstTurnTokens)})`,
    merged === undefined && lineMedian === undefined ? NA('no pull request merged and no line closed in the week') : `pull request ${merged === undefined ? NA('none merged') : `median ${span(merged)} over ${delays.length}`}; line ${lineMedian === undefined ? NA('none closed') : `median ${span(lineMedian)} over ${lines.length}`} (target ≤ ${span(TARGETS.lineToMergeMs)})`,
    round.length === 0 ? NA('no operator question in round/ for the week') : `${repeated} of ${round.length} questions repeat an earlier one's blocks line, exact match (a floor; target 0)`,
    NA('the lines of code per release need the git history of each release, which no source here holds'),
    tools.length === 0 ? NA('no tool repository') : failed !== undefined && typeof failed[1] === 'string' ? NA(`${failed[0]}: ${failed[1]}`) : `${rows.filter(x => x['conclusion'] === 'success').length} green, ${rows.filter(x => x['conclusion'] === 'failure').length} red runs on main (target 0 red)`,
  ]
  const names = ['agents on every runnable line', 'merge → in service', 'context height', 'life of an orchestrator session', 'first turn of a new session', 'delay line → merge', 'a question reaches him once', 'method code per release', 'main green']
  out.push('', ...figures.map((f, i) => `${i + 1} ${names[i] ?? ''}: ${f}`))
  return out
}
