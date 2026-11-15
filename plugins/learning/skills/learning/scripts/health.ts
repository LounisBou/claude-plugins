// learning — the health report, answered by code with no model turn.
//
//   health.ts --config <dir>    the journals under <dir>, summarized over the contract's window
//
// <dir> is the host's configuration directory; each plugin's journal is <dir>/<plugin>/journal
// (core/learning.ts). The report counts what the journals hold: refusals per guard code,
// findings by severity (the norms agents' own severities apart), answers and escapes, and the guard codes that refused before the window
// and not in it. It prints, and refuses nothing.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { journalDir, JOURNAL_FOLD_FILE, LEARNING_CONTRACT, LEARNING_WINDOW_DAYS, parseAuditEvent, parseFolded, parseLearningEvent, type AuditEvent, type LearningEvent } from '../../../core/learning.ts'

export const HEALTH_USAGE = 'usage: health.ts --config <dir>'

const DAY_MS = 86_400_000
const PLUGIN_NAME = new RegExp(LEARNING_CONTRACT.patterns.plugin)

export interface Journal {
  readonly plugin: string
  readonly events: readonly LearningEvent[]
  /** The audit trail's events, version 2 of the contract, counted apart. */
  readonly audit?: readonly AuditEvent[]
  /** The events the writer dropped past its retention, held as weekly counts in the fold file. */
  readonly folded?: number
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

export interface Summary {
  readonly plugins: number
  /** The events inside the window. */
  readonly events: number
  /** The events older than the window, still kept by their writer. */
  readonly older: number
  /** The audit trail's events inside the window. */
  readonly audit: number
  /** The events the journals dropped past their retention, held as weekly counts. */
  readonly folded: number
  readonly unreadable: number
  readonly kinds: Readonly<Record<LearningEvent['kind'], number>>
  /** Refusals per code, most first, then by name. */
  readonly refusals: ReadonlyArray<readonly [string, number]>
  /** Guard codes whose last refusal is older than the window, longest silent first, then by name. */
  readonly silent: readonly SilentGuard[]
  readonly findings: Readonly<Record<'critical' | 'important', number>>
  /** The norms agents' findings by the severity they reported, read from the event's code (`norms.<agent>.<severity>`). */
  readonly norms: Readonly<Record<NormsSeverity, number>>
}

/** The severities a norms agent reports; the contract's finding pointer holds none of them, the code does. */
export const NORMS_SEVERITIES = ['error', 'warning', 'info'] as const
type NormsSeverity = (typeof NORMS_SEVERITIES)[number]
const isNormsSeverity = (value: string | undefined): value is NormsSeverity => NORMS_SEVERITIES.some(s => s === value)

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
    let folded = 0
    for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
      if (file === JOURNAL_FOLD_FILE) {
        const counts = parseFolded(readFileSync(join(dir, file), 'utf8'))
        if (counts === undefined) unreadable++
        else folded = counts.reduce((sum, line) => sum + line.count, 0)
        continue
      }
      const parsed = parseFile(join(dir, file))
      if (parsed === undefined) unreadable++
      else if ('fact' in parsed) audit.push(parsed)
      else events.push(parsed)
    }
    journals.push({ plugin: name, events, audit, folded, unreadable })
  }
  return journals
}

/** The journals' figures over the window that ends at `now`; an event exactly a window old is inside it. */
export function summarize(journals: readonly Journal[], now: number): Summary {
  const kinds = { refusal: 0, finding: 0, answer: 0, escape: 0 }
  const codes = new Map<string, number>()
  const last = new Map<string, { readonly plugin: string; readonly ms: number }>()
  const findings = { critical: 0, important: 0 }
  const norms = { error: 0, warning: 0, info: 0 }
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
      const severity = e.source.code.split('.').at(-1)
      if (e.kind === 'finding' && e.source.plugin === 'norms' && isNormsSeverity(severity)) norms[severity]++
    }
  }
  const refusals = [...codes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const silent = [...last]
    .filter(([code]) => !codes.has(code))
    .map(([code, { plugin, ms }]) => ({ code, plugin, days: Math.floor((now - ms) / DAY_MS) }))
    .sort((a, b) => b.days - a.days || (a.code < b.code ? -1 : 1))
  return { plugins: journals.length, events, older, audit, unreadable: journals.reduce((n, j) => n + j.unreadable, 0), kinds, refusals, silent, findings, norms, folded: journals.reduce((n, j) => n + (j.folded ?? 0), 0) }
}

/** The report, in lines. */
export function render(s: Summary): string {
  if (s.plugins === 0) return 'learning health: no journal found, no plugin writes learning events yet.'
  const lines = [
    `learning health, window of ${LEARNING_WINDOW_DAYS} days: ${s.events} events from ${s.plugins} journal${s.plugins === 1 ? '' : 's'}${s.older > 0 ? `, ${s.older} older` : ''}`,
    `kinds: ${s.kinds.refusal} refusals, ${s.kinds.finding} findings, ${s.kinds.answer} answers, ${s.kinds.escape} escapes`,
    'refusals per code:',
    ...(s.refusals.length === 0 ? ['  none'] : s.refusals.map(([code, count]) => `  ${code.padEnd(40)} ${count}`)),
    `findings: ${s.findings.critical} critical, ${s.findings.important} important`,
    `norms findings: ${NORMS_SEVERITIES.map(severity => `${s.norms[severity]} ${severity}`).join(', ')}`,
    `silent guards, proposed for removal (no refusal in the ${LEARNING_WINDOW_DAYS} days):`,
    ...(s.silent.length === 0 ? ['  none'] : s.silent.map(g => `  ${g.code.padEnd(40)} ${g.plugin} ${g.days} days silent`)),
  ]
  if (s.audit > 0) lines.push(`${s.audit} audit events`)
  if (s.folded > 0) lines.push(`${s.folded} older events folded into weekly counts (${JOURNAL_FOLD_FILE} of each journal)`)
  if (s.unreadable > 0) lines.push(`${s.unreadable} file${s.unreadable === 1 ? '' : 's'} in the journals ${s.unreadable === 1 ? 'is' : 'are'} not ${s.unreadable === 1 ? 'an event' : 'events'} of the contract.`)
  lines.push('not read yet: review rounds and escapes of the dispatch records, check runs, cost, eval baselines.')
  return lines.join('\n')
}

export interface Deps {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly now: () => number
}

/** The command line; the exit status. */
export function run(args: readonly string[], deps: Deps): number {
  const [flag, config, ...rest] = args
  if (flag !== '--config' || config === undefined || rest.length > 0) {
    deps.err(HEALTH_USAGE)
    return 2
  }
  deps.out(render(summarize(readJournals(config), deps.now())))
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
