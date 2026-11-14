// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The learning event contract, read by the learning plugin only and written by each plugin into its
// own journal, one file per event under <config>/<plugin>/journal/. An event records a fact that
// would vanish with the session (a guard's refusal, a review's finding, the operator's structured
// answer, an orchestrator's escape) and points at the durable records that hold the rest: never a
// command line, a prompt's words, a finding's summary or a figure a model passed to a tool. Every
// field is a name, a number, a pattern-bound path or a code, and the reader refuses any field the
// contract does not name. Defined here once; `npm run core` writes it as learning.json beside each
// plugin's copy, which a writer in Python loads. Version 1 is the first field list, not the last:
// a kind or a field added later (an audit trail's timestamps, decisions or waits, say) is a new
// version of the contract, read beside this one, and never a field slipped into version 1. The
// window, the retention and the count of a journal are held here once, on the recommendation of
// the design's question 9 (30 days, 180 days, 2,000 events) while the operator has not answered it.

import { PR_RECORD_CONTRACT } from './pr-record.ts'

export const LEARNING_CONTRACT = {
  version: 1,
  kinds: ['refusal', 'finding', 'answer', 'escape'],
  trusts: ['computed', 'operator', 'review', 'external'],
  severities: ['critical', 'important'],
  evidence_types: ['record', 'check', 'finding', 'ruling', 'refusal'],
  // What a journal keeps: the days a retrospective looks back over, the days an event stays, the
  // events a plugin's journal holds. A writer prunes its own directory past the last two.
  window_days: 30,
  max_age_days: 180,
  max_events: 2000,
  // The directory under a plugin's state directory.
  journal_dir: 'journal',
  paths_max: 20,
  path_max: 200,
  evidence_max: 8,
  check_name_max: 100,
  // The programming languages a path's extension names; the one table `languages` is computed from.
  languages: {
    c: ['.c', '.h'],
    cpp: ['.cc', '.cpp', '.cxx', '.hpp'],
    csharp: ['.cs'],
    go: ['.go'],
    java: ['.java'],
    javascript: ['.js', '.jsx', '.mjs', '.cjs'],
    kotlin: ['.kt', '.kts'],
    php: ['.php'],
    python: ['.py'],
    ruby: ['.rb'],
    rust: ['.rs'],
    shell: ['.sh', '.bash'],
    sql: ['.sql'],
    swift: ['.swift'],
    typescript: ['.ts', '.tsx', '.mts', '.cts'],
  },
  patterns: {
    id: String.raw`^\d{8}T\d{6}Z-[0-9a-f]{8}$`,
    at: String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`,
    random: '^[0-9a-f]{8}$',
    plugin: '^[a-z0-9][a-z0-9-]*$',
    code: String.raw`^[a-z0-9-]+(?:\.[a-z0-9-]+)+$`,
    role: '^[a-z0-9][a-z0-9-]{0,31}$',
    session: String.raw`^[A-Za-z0-9._-]{1,80}$`,
    // A repository-relative path: no blank, no shell character, no `.` or `..` segment, not absolute.
    path: String.raw`^(?!(?:.*/)?\.\.?(?:/|$))[A-Za-z0-9_@+.-]+(?:/[A-Za-z0-9_@+.-]+)*$`,
    check_name: String.raw`^[A-Za-z0-9._/() ,:-]+$`,
    head: PR_RECORD_CONTRACT.patterns.head,
    repo_part: PR_RECORD_CONTRACT.patterns.repo_part,
  },
} as const

const contract = LEARNING_CONTRACT

export type LearningKind = 'refusal' | 'finding' | 'answer' | 'escape'
export type Trust = 'computed' | 'operator' | 'review' | 'external'
export type Severity = 'critical' | 'important'

/** What an event points at: a record, a check at a head, a finding's severity and file, a ruling's line, a refusal's code. */
export type Evidence =
  | { readonly type: 'record'; readonly path: string }
  | { readonly type: 'check'; readonly name: string; readonly head: string }
  | { readonly type: 'finding'; readonly severity: Severity; readonly file: string }
  | { readonly type: 'ruling'; readonly path: string; readonly line: number }
  | { readonly type: 'refusal'; readonly code: string }

export interface LearningEvent {
  readonly v: number
  readonly id: string
  readonly at: string
  readonly kind: LearningKind
  readonly source: { readonly plugin: string; readonly code: string }
  readonly subject: { readonly repo: string | null; readonly pr: number | null; readonly head: string | null }
  readonly context: {
    readonly role: string | null
    readonly mode: string | null
    readonly paths: readonly string[]
    readonly languages: readonly string[]
    readonly session: string | null
  }
  readonly evidence: readonly Evidence[]
  readonly trust: Trust
}

export const LEARNING_VERSION = contract.version
export const LEARNING_WINDOW_DAYS = contract.window_days
export const JOURNAL_MAX_AGE_DAYS = contract.max_age_days
export const JOURNAL_MAX_EVENTS = contract.max_events

const PATTERNS = {
  id: new RegExp(contract.patterns.id),
  at: new RegExp(contract.patterns.at),
  random: new RegExp(contract.patterns.random),
  plugin: new RegExp(contract.patterns.plugin),
  code: new RegExp(contract.patterns.code),
  role: new RegExp(contract.patterns.role),
  session: new RegExp(contract.patterns.session),
  path: new RegExp(contract.patterns.path),
  checkName: new RegExp(contract.patterns.check_name),
  head: new RegExp(contract.patterns.head),
  repoPart: new RegExp(contract.patterns.repo_part),
}

const DAY_MS = 86_400_000
const LANGUAGE_OF: ReadonlyMap<string, string> = new Map(Object.entries(contract.languages).flatMap(([language, extensions]) => extensions.map(ext => [ext, language] as const)))

type Fields = Record<string, unknown>

function fieldsOf(raw: unknown, names: readonly string[]): Fields | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const keys = Object.keys(raw)
  if (keys.length !== names.length || !names.every(name => keys.includes(name))) return undefined
  return raw as Fields
}

function matches(pattern: RegExp, value: unknown, max = Infinity): value is string {
  return typeof value === 'string' && value.length <= max && pattern.test(value)
}

function isTime(value: unknown): value is string {
  return matches(PATTERNS.at, value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value
}

function isRepo(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split('/')
  return parts.length === 2 && parts.every(part => PATTERNS.repoPart.test(part) && part !== '.' && part !== '..')
}

function isPath(value: unknown): value is string {
  return matches(PATTERNS.path, value, contract.path_max)
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function nullable<T>(value: unknown, isT: (v: unknown) => v is T): value is T | null {
  return value === null || isT(value)
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some(v => v === value)
}

function evidenceOf(raw: unknown): Evidence | undefined {
  const type = typeof raw === 'object' && raw !== null ? (raw as Fields)['type'] : undefined
  if (type === 'record') {
    const { path } = fieldsOf(raw, ['type', 'path']) ?? {}
    return isPath(path) ? { type, path } : undefined
  }
  if (type === 'check') {
    const { name, head } = fieldsOf(raw, ['type', 'name', 'head']) ?? {}
    return matches(PATTERNS.checkName, name, contract.check_name_max) && matches(PATTERNS.head, head) ? { type, name, head } : undefined
  }
  if (type === 'finding') {
    const { severity, file } = fieldsOf(raw, ['type', 'severity', 'file']) ?? {}
    return isOneOf(contract.severities, severity) && isPath(file) ? { type, severity, file } : undefined
  }
  if (type === 'ruling') {
    const { path, line } = fieldsOf(raw, ['type', 'path', 'line']) ?? {}
    return isPath(path) && isLine(line) ? { type, path, line } : undefined
  }
  if (type === 'refusal') {
    const { code } = fieldsOf(raw, ['type', 'code']) ?? {}
    return matches(PATTERNS.code, code) ? { type, code } : undefined
  }
  return undefined
}

/** The programming languages the extensions of `paths` name, each once, in alphabetical order. */
export function languagesOf(paths: readonly string[]): string[] {
  const found = new Set<string>()
  for (const path of paths) {
    const base = path.slice(path.lastIndexOf('/') + 1)
    const dot = base.lastIndexOf('.')
    const language = dot > 0 ? LANGUAGE_OF.get(base.slice(dot).toLowerCase()) : undefined
    if (language !== undefined) found.add(language)
  }
  return [...found].sort()
}

/** The identifier of an event: its time, compact, then a random part (8 lowercase hex digits), so a name sorts by time; undefined when either does not fit. */
export function eventId(at: string, random: string): string | undefined {
  if (!isTime(at) || !PATTERNS.random.test(random)) return undefined
  return `${at.replace(/[-:]/g, '')}-${random}`
}

/**
 * The event `raw` holds, or undefined when a field breaks the contract's shape or a field the
 * contract does not name is present. The identifier must be the one its time gives and the languages
 * the ones its paths give, so a writer cannot pass either in by hand.
 */
export function parseLearningEvent(raw: unknown): LearningEvent | undefined {
  const top = fieldsOf(raw, ['v', 'id', 'at', 'kind', 'source', 'subject', 'context', 'evidence', 'trust'])
  if (!top) return undefined
  const { v, id, at, kind, trust, evidence: rawEvidence } = top
  if (v !== LEARNING_VERSION || !isTime(at) || !matches(PATTERNS.id, id) || eventId(at, id.slice(-8)) !== id) return undefined
  if (!isOneOf(contract.kinds, kind) || !isOneOf(contract.trusts, trust)) return undefined
  const { plugin, code } = fieldsOf(top['source'], ['plugin', 'code']) ?? {}
  const { repo, pr, head } = fieldsOf(top['subject'], ['repo', 'pr', 'head']) ?? {}
  const { role, mode, paths, languages, session } = fieldsOf(top['context'], ['role', 'mode', 'paths', 'languages', 'session']) ?? {}
  if (!matches(PATTERNS.plugin, plugin) || !matches(PATTERNS.code, code)) return undefined
  if (!nullable(repo, isRepo) || !nullable(pr, isLine) || !nullable(head, (h): h is string => matches(PATTERNS.head, h))) return undefined
  if (!nullable(role, (r): r is string => matches(PATTERNS.role, r)) || !nullable(mode, (m): m is string => matches(PATTERNS.role, m))) return undefined
  if (!nullable(session, (n): n is string => matches(PATTERNS.session, n))) return undefined
  if (!Array.isArray(paths) || paths.length > contract.paths_max || !paths.every(isPath)) return undefined
  if (!Array.isArray(languages) || JSON.stringify(languages) !== JSON.stringify(languagesOf(paths))) return undefined
  if (!Array.isArray(rawEvidence) || rawEvidence.length > contract.evidence_max) return undefined
  const evidence = rawEvidence.map(evidenceOf)
  if (!evidence.every((e): e is Evidence => e !== undefined)) return undefined
  return {
    v, id, at, kind, trust, evidence,
    source: { plugin, code },
    subject: { repo, pr, head },
    context: { role, mode, paths, languages, session },
  }
}

/** A plugin's journal: a directory of its own under its state directory, where only it writes. */
export function journalDir(configDir: string, plugin: string): string {
  if (!PATTERNS.plugin.test(plugin)) throw new Error(`not a plugin name: ${JSON.stringify(plugin)}`)
  return `${configDir}/${plugin}/${contract.journal_dir}`
}

/**
 * The ids a writer removes from its journal at `now`: the events older than the retention, then the
 * oldest of the rest past the count. An entry whose time cannot be read is left alone: the writer
 * did not write it.
 */
export function prunable(events: ReadonlyArray<{ readonly id: string; readonly at: string }>, now: string): string[] {
  const nowMs = Date.parse(now)
  const dated = events.map(e => ({ id: e.id, ms: Date.parse(e.at) })).filter(e => !Number.isNaN(e.ms))
  const isAged = (e: { ms: number }) => nowMs - e.ms > contract.max_age_days * DAY_MS
  const aged = dated.filter(isAged)
  const kept = dated.filter(e => !isAged(e)).sort((a, b) => a.ms - b.ms || (a.id < b.id ? -1 : 1))
  const over = kept.slice(0, Math.max(0, kept.length - contract.max_events))
  return [...aged, ...over].map(e => e.id)
}
