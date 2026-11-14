// learning — the health report, answered by code with no model turn.
//
//   health.ts --config <dir>    the journals under <dir>, summarized over the contract's window
//
// <dir> is the host's configuration directory; each plugin's journal is <dir>/<plugin>/journal
// (core/learning.ts). The report counts what the journals hold: refusals per guard code,
// findings by severity, answers and escapes, and the guard codes that refused before the window
// and not in it. It also reads the rulings of <dir>/claude-orchestrator/briefs/*/rulings.md for
// the removals the operator decided (README, « Decided removals ») that the repository of the
// working directory still holds. It prints, and refuses nothing.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { journalDir, LEARNING_CONTRACT, LEARNING_WINDOW_DAYS, parseAuditEvent, parseLearningEvent, type AuditEvent, type LearningEvent } from '../../../core/learning.ts'

export const HEALTH_USAGE = 'usage: health.ts --config <dir>'

const DAY_MS = 86_400_000
const PLUGIN_NAME = new RegExp(LEARNING_CONTRACT.patterns.plugin)
const REPO_PATH = new RegExp(LEARNING_CONTRACT.patterns.path)
const SYMBOL = /^[A-Za-z0-9_$.-]+$/
/** `- <ISO UTC> « <his words> » — removal: <repo path>[::<symbol>]`, the one fixed form of a decided removal. */
const REMOVAL_LINE = /^- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) « .* » — removal: (\S+)\s*$/

export interface Journal {
  readonly plugin: string
  readonly events: readonly LearningEvent[]
  /** The audit trail's events, version 2 of the contract, counted apart. */
  readonly audit?: readonly AuditEvent[]
  /** The `.json` files that are not an event of the contract: unparseable, or naming a field it does not. */
  readonly unreadable: number
}

/** A guard code that refused before the window and not in it. */
export interface SilentGuard {
  readonly code: string
  readonly plugin: string
  /** Whole days since its last refusal. */
  readonly days: number
}

/** A removal the operator decided, as one fixed-form line of a rulings file states it. */
export interface Removal {
  /** The project directory under `claude-orchestrator/briefs` whose rulings state it. */
  readonly project: string
  readonly at: string
  /** Repository-relative. */
  readonly path: string
  readonly symbol: string | null
}

export interface Summary {
  readonly plugins: number
  /** The events inside the window. */
  readonly events: number
  /** The events older than the window, still kept by their writer. */
  readonly older: number
  /** The audit trail's events inside the window. */
  readonly audit: number
  readonly unreadable: number
  readonly kinds: Readonly<Record<LearningEvent['kind'], number>>
  /** Refusals per code, most first, then by name. */
  readonly refusals: ReadonlyArray<readonly [string, number]>
  /** Guard codes whose last refusal is older than the window, longest silent first, then by name. */
  readonly silent: readonly SilentGuard[]
  readonly findings: Readonly<Record<'critical' | 'important', number>>
}

function parseFile(path: string): LearningEvent | AuditEvent | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parseLearningEvent(raw) ?? parseAuditEvent(raw)
  } catch {
    return undefined
  }
}

/** The journals under a configuration directory: one per plugin directory that holds a `journal`, sorted by plugin. */
export function readJournals(config: string): Journal[] {
  if (!existsSync(config)) return []
  const journals: Journal[] = []
  for (const name of readdirSync(config).sort()) {
    const dir = PLUGIN_NAME.test(name) ? journalDir(config, name) : ''
    if (dir === '' || !existsSync(dir)) continue
    const events: LearningEvent[] = []
    const audit: AuditEvent[] = []
    let unreadable = 0
    for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
      const parsed = parseFile(join(dir, file))
      if (parsed === undefined) unreadable++
      else if ('fact' in parsed) audit.push(parsed)
      else events.push(parsed)
    }
    journals.push({ plugin: name, events, audit, unreadable })
  }
  return journals
}

/** The journals' figures over the window that ends at `now`; an event exactly a window old is inside it. */
export function summarize(journals: readonly Journal[], now: number): Summary {
  const kinds = { refusal: 0, finding: 0, answer: 0, escape: 0 }
  const codes = new Map<string, number>()
  const last = new Map<string, { readonly plugin: string; readonly ms: number }>()
  const findings = { critical: 0, important: 0 }
  let events = 0
  let older = 0
  let audit = 0
  for (const journal of journals) {
    for (const e of journal.audit ?? []) {
      if (now - Date.parse(e.at) > LEARNING_WINDOW_DAYS * DAY_MS) older++
      else audit++
    }
    for (const e of journal.events) {
      if (e.kind === 'refusal' && Date.parse(e.at) > (last.get(e.source.code)?.ms ?? -Infinity)) last.set(e.source.code, { plugin: e.source.plugin, ms: Date.parse(e.at) })
      if (now - Date.parse(e.at) > LEARNING_WINDOW_DAYS * DAY_MS) {
        older++
        continue
      }
      events++
      kinds[e.kind]++
      if (e.kind === 'refusal') codes.set(e.source.code, (codes.get(e.source.code) ?? 0) + 1)
      for (const pointer of e.evidence) if (pointer.type === 'finding') findings[pointer.severity]++
    }
  }
  const refusals = [...codes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const silent = [...last]
    .filter(([code]) => !codes.has(code))
    .map(([code, { plugin, ms }]) => ({ code, plugin, days: Math.floor((now - ms) / DAY_MS) }))
    .sort((a, b) => b.days - a.days || (a.code < b.code ? -1 : 1))
  return { plugins: journals.length, events, older, audit, unreadable: journals.reduce((n, j) => n + j.unreadable, 0), kinds, refusals, silent, findings }
}

/** The removals the rulings of every project under `<config>/claude-orchestrator/briefs` state in the fixed form, in project then line order. */
export function readRemovals(config: string): Removal[] {
  const briefs = join(config, 'claude-orchestrator', 'briefs')
  if (!existsSync(briefs)) return []
  const removals: Removal[] = []
  for (const project of readdirSync(briefs).sort()) {
    const file = join(briefs, project, 'rulings.md')
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const found = REMOVAL_LINE.exec(line)
      const [path, symbol, ...more] = (found?.[2] ?? '').split('::')
      if (found?.[1] === undefined || path === undefined || more.length > 0) continue
      if (!REPO_PATH.test(path) || (symbol !== undefined && !SYMBOL.test(symbol))) continue
      removals.push({ project, at: found[1], path, symbol: symbol ?? null })
    }
  }
  return removals
}

/** The repository `dir` is in: the nearest directory up from it that holds a `.git`. */
export function repoRootOf(dir: string): string | undefined {
  for (let here = dir; ; here = dirname(here)) {
    if (existsSync(join(here, '.git'))) return here
    if (dirname(here) === here) return undefined
  }
}

/** The removals still undelivered in the repository at `repo`: the path exists, and with a symbol, the file still holds it as a whole word. */
export function undelivered(removals: readonly Removal[], repo: string): Removal[] {
  return removals.filter(({ path, symbol }) => {
    const target = join(repo, path)
    if (!existsSync(target)) return false
    if (symbol === null) return true
    if (!statSync(target).isFile()) return false
    const word = new RegExp(`(?<![\\w$])${symbol.replace(/[$.]/g, '\\$&')}(?![\\w$])`)
    return word.test(readFileSync(target, 'utf8'))
  })
}

function removalLines(removals: readonly Removal[]): string[] {
  const lines = ['undelivered removals, decided and still in the code:']
  if (removals.length === 0) return [...lines, '  none']
  return [...lines, ...removals.map(r => `  ${(r.symbol === null ? r.path : `${r.path}::${r.symbol}`).padEnd(40)} decided ${r.at} (${r.project})`)]
}

/** The report, in lines; `removals` are the undelivered ones, and none given leaves their section out. */
export function render(s: Summary, removals?: readonly Removal[]): string {
  if (s.plugins === 0) {
    const none = 'learning health: no journal found, no plugin writes learning events yet.'
    return removals === undefined || removals.length === 0 ? none : [none, ...removalLines(removals)].join('\n')
  }
  const lines = [
    `learning health, window of ${LEARNING_WINDOW_DAYS} days: ${s.events} events from ${s.plugins} journal${s.plugins === 1 ? '' : 's'}${s.older > 0 ? `, ${s.older} older` : ''}`,
    `kinds: ${s.kinds.refusal} refusals, ${s.kinds.finding} findings, ${s.kinds.answer} answers, ${s.kinds.escape} escapes`,
    'refusals per code:',
    ...(s.refusals.length === 0 ? ['  none'] : s.refusals.map(([code, count]) => `  ${code.padEnd(40)} ${count}`)),
    `findings: ${s.findings.critical} critical, ${s.findings.important} important`,
    `silent guards, proposed for removal (no refusal in the ${LEARNING_WINDOW_DAYS} days):`,
    ...(s.silent.length === 0 ? ['  none'] : s.silent.map(g => `  ${g.code.padEnd(40)} ${g.plugin} ${g.days} days silent`)),
  ]
  if (removals !== undefined) lines.push(...removalLines(removals))
  if (s.audit > 0) lines.push(`${s.audit} audit events`)
  if (s.unreadable > 0) lines.push(`${s.unreadable} file${s.unreadable === 1 ? '' : 's'} in the journals ${s.unreadable === 1 ? 'is' : 'are'} not ${s.unreadable === 1 ? 'an event' : 'events'} of the contract.`)
  lines.push('not read yet: review rounds and escapes of the dispatch records, check runs, cost, eval baselines.')
  return lines.join('\n')
}

export interface Deps {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly now: () => number
  /** The working directory; the process's when omitted. */
  readonly cwd?: () => string
}

/** The command line; the exit status. */
export function run(args: readonly string[], deps: Deps): number {
  const [flag, config, ...rest] = args
  if (flag !== '--config' || config === undefined || rest.length > 0) {
    deps.err(HEALTH_USAGE)
    return 2
  }
  const repo = repoRootOf((deps.cwd ?? process.cwd)())
  const open = repo === undefined ? [] : undelivered(readRemovals(config), repo)
  deps.out(render(summarize(readJournals(config), deps.now()), open))
  return 0
}

/* node:coverage ignore next 7 */
const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = run(process.argv.slice(2), {
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
    now: Date.now,
  })
}
