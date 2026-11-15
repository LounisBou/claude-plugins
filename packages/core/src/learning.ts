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
// window, the retention and the count of a journal are held here once, as the operator answered the
// design's question 9: 30 days, 90 days, 6,000 events; what a journal drops is folded into one count
// per signature and week (`foldWeekly`).

import { consentAnswer, givenAnswer, grants } from './consent-record.ts'
import { WAIT_KINDS } from './orchestration.ts'
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
  max_age_days: 90,
  max_events: 6000,
  // The one file of a journal's directory that holds what the writer dropped, as counts.
  fold_file: 'folded.json',
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
  /*
   * The class of a path, the one table a signature's classes are computed from: the first class one
   * of whose directory names is a segment of the path, one of whose marks is in its file name, or one
   * of whose extensions ends it; a path of no class is `source`.
   */
  path_classes: {
    test: { segments: ['test', 'tests', '__tests__', 'spec', 'specs', 'e2e'], marks: ['.test.', '.spec.', '_test.'], extensions: [] },
    docs: { segments: ['doc', 'docs'], marks: [], extensions: ['.md', '.mdx', '.rst', '.txt', '.adoc'] },
    configuration: { segments: [], marks: [], extensions: ['.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.lock', '.xml'] },
  },
  path_class_default: 'source',
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
export const JOURNAL_FOLD_FILE = contract.fold_file

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

export type PathClass = keyof typeof contract.path_classes | typeof contract.path_class_default

interface ClassRule { readonly segments: readonly string[]; readonly marks: readonly string[]; readonly extensions: readonly string[] }
const CLASS_RULES = Object.entries(contract.path_classes) as ReadonlyArray<readonly [PathClass, ClassRule]>

/** The classes of `paths` (test, docs, configuration, source), each once, in alphabetical order. */
export function pathClassesOf(paths: readonly string[]): PathClass[] {
  const found = new Set<PathClass>()
  for (const path of paths) {
    const segments = path.toLowerCase().split('/')
    const base = segments.pop() ?? ''
    const rule = CLASS_RULES.find(([, r]) => r.segments.some(s => segments.includes(s)) || r.marks.some(m => base.includes(m)) || r.extensions.some(e => base.endsWith(e)))
    found.add(rule?.[0] ?? contract.path_class_default)
  }
  return [...found].sort()
}

/** The identifier of an event: its time, compact, then a random part (8 lowercase hex digits), so a name sorts by time; undefined when either does not fit. */
export function eventId(at: string, random: string): string | undefined {
  if (!isTime(at) || !PATTERNS.random.test(random)) return undefined
  return `${at.replace(/[-:]/g, '')}-${random}`
}

type Envelope = Omit<LearningEvent, 'v' | 'kind'>

/**
 * The fields every version shares, read from `raw` when it holds exactly them and the `extra` ones:
 * the identifier the time gives, the languages the paths give, pointers for evidence.
 */
function envelopeOf(raw: unknown, version: number, extra: readonly string[]): { top: Fields; envelope: Envelope } | undefined {
  const top = fieldsOf(raw, ['v', 'id', 'at', 'kind', 'source', 'subject', 'context', 'evidence', 'trust', ...extra])
  if (!top) return undefined
  const { v, id, at, trust, evidence: rawEvidence } = top
  if (v !== version || !isTime(at) || !matches(PATTERNS.id, id) || eventId(at, id.slice(-8)) !== id) return undefined
  if (!isOneOf(contract.trusts, trust)) return undefined
  const { plugin, code } = fieldsOf(top['source'], ['plugin', 'code']) ?? {}
  const { repo, pr, head } = fieldsOf(top['subject'], ['repo', 'pr', 'head']) ?? {}
  const { role, mode, paths, languages, session } = fieldsOf(top['context'], ['role', 'mode', 'paths', 'languages', 'session']) ?? {}
  if (!matches(PATTERNS.plugin, plugin) || !matches(PATTERNS.code, code)) return undefined
  if (!nullable(repo, isRepo) || !nullable(pr, isLine) || !nullable(head, (h): h is string => matches(PATTERNS.head, h))) return undefined
  if (!nullable(role, (r): r is string => matches(PATTERNS.role, r)) || !nullable(mode, (m): m is string => matches(PATTERNS.role, m))) return undefined
  if (!nullable(session, isSession)) return undefined
  if (!Array.isArray(paths) || paths.length > contract.paths_max || !paths.every(isPath)) return undefined
  if (!Array.isArray(languages) || JSON.stringify(languages) !== JSON.stringify(languagesOf(paths))) return undefined
  if (!Array.isArray(rawEvidence) || rawEvidence.length > contract.evidence_max) return undefined
  const evidence = rawEvidence.map(evidenceOf)
  if (!evidence.every((e): e is Evidence => e !== undefined)) return undefined
  return {
    top,
    envelope: {
      id, at, trust, evidence,
      source: { plugin, code },
      subject: { repo, pr, head },
      context: { role, mode, paths, languages, session },
    },
  }
}

function isSession(value: unknown): value is string {
  return matches(PATTERNS.session, value)
}

/**
 * The event `raw` holds, or undefined when a field breaks the contract's shape or a field the
 * contract does not name is present. The identifier must be the one its time gives and the languages
 * the ones its paths give, so a writer cannot pass either in by hand.
 */
export function parseLearningEvent(raw: unknown): LearningEvent | undefined {
  const read = envelopeOf(raw, LEARNING_VERSION, [])
  if (!read) return undefined
  const kind = read.top['kind']
  return isOneOf(contract.kinds, kind) ? { v: LEARNING_VERSION, kind, ...read.envelope } : undefined
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

/** What a signature and a fold read of an event, of either version. */
export interface Foldable {
  readonly at: string
  readonly kind: string
  readonly source: { readonly code: string }
  readonly evidence: readonly Evidence[]
  readonly context: { readonly paths: readonly string[]; readonly languages: readonly string[] }
}

/** What a signature is made of. */
export interface SignatureParts {
  readonly kind: string
  readonly code: string
  readonly severity: Severity | null
  readonly classes: readonly PathClass[]
  readonly languages: readonly string[]
}

/** The parts of an event's signature: its kind, the code that raised it, the severity of its first finding, the classes of its paths, its languages. */
export function signaturePartsOf(event: Foldable): SignatureParts {
  const severity = event.evidence.flatMap(e => (e.type === 'finding' ? [e.severity] : []))[0] ?? null
  return { kind: event.kind, code: event.source.code, severity, classes: pathClassesOf(event.context.paths), languages: event.context.languages }
}

/** The signature its parts give: the kind and the code, then the severity, the classes and the languages there are. */
export function signatureFrom(parts: SignatureParts): string {
  return [parts.kind, parts.code, ...(parts.severity ? [parts.severity] : []), ...parts.classes, ...parts.languages].join(':')
}

/**
 * What groups events of one kind of fact: the kind, the code that raised it, then, when the event
 * has them, the severity of its first finding, the classes of its paths and its languages. The same
 * events give the same signature, whoever reads them.
 */
export function signatureOf(event: Foldable): string {
  return signatureFrom(signaturePartsOf(event))
}

export interface FoldedCount {
  readonly signature: string
  /** The Monday, in UTC, of the week the events fall in: `YYYY-MM-DD`. */
  readonly week: string
  readonly count: number
}

/** The Monday of the UTC week of `ms`, as `YYYY-MM-DD`. */
function weekOf(ms: number): string {
  const day = new Date(ms)
  const sinceMonday = (day.getUTCDay() + 6) % 7
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - sinceMonday)).toISOString().slice(0, 10)
}

/**
 * One count per signature and week of `events`, the ones a journal drops, in the order of week then
 * signature: what stays of them once their files are gone. An event whose time cannot be read is not
 * counted.
 */
export function foldWeekly(events: readonly Foldable[]): FoldedCount[] {
  const counts = new Map<string, FoldedCount>()
  for (const event of events) {
    const ms = Date.parse(event.at)
    if (Number.isNaN(ms)) continue
    const signature = signatureOf(event)
    const week = weekOf(ms)
    const key = `${week} ${signature}`
    counts.set(key, { signature, week, count: (counts.get(key)?.count ?? 0) + 1 })
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, folded]) => folded)
}

const FOLD_VERSION = 1
const FOLD_WEEK = /^\d{4}-\d{2}-\d{2}$/
const FOLD_SIGNATURE_MAX = 400

function foldKey(counted: FoldedCount): string {
  return `${counted.week} ${counted.signature}`
}

/** `before` and `added` in one list: counts of one signature and week summed, in the order of week then signature. */
export function mergeFolded(before: readonly FoldedCount[], added: readonly FoldedCount[]): FoldedCount[] {
  const counts = new Map<string, FoldedCount>()
  for (const counted of [...before, ...added]) {
    const key = foldKey(counted)
    counts.set(key, { ...counted, count: (counts.get(key)?.count ?? 0) + counted.count })
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, counted]) => counted)
}

/** What a fold file holds: the counts, and the ids of the events counted whose removal may not have happened. */
export interface Fold {
  readonly counts: readonly FoldedCount[]
  readonly pending: readonly string[]
}

/** The text of a journal's fold file: the counts and the pending ids, whole, on one line. */
export function foldedText(counts: readonly FoldedCount[], pending: readonly string[] = []): string {
  return `${JSON.stringify({ v: FOLD_VERSION, counts, pending })}\n`
}

/** The fold a text holds: an empty one when it is absent (undefined text), undefined when it is not a fold of this contract. */
export function parseFold(text: string | undefined): Fold | undefined {
  if (text === undefined) return { counts: [], pending: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  const top = fieldsOf(raw, ['v', 'counts', 'pending'])
  if (!top || top['v'] !== FOLD_VERSION || !Array.isArray(top['counts']) || !Array.isArray(top['pending'])) return undefined
  if (!top['pending'].every(id => matches(PATTERNS.id, id))) return undefined
  const counts: FoldedCount[] = []
  for (const entry of top['counts'] as unknown[]) {
    const { signature, week, count } = fieldsOf(entry, ['signature', 'week', 'count']) ?? {}
    const sound = typeof signature === 'string' && signature.length > 0 && signature.length <= FOLD_SIGNATURE_MAX
      && typeof week === 'string' && FOLD_WEEK.test(week) && typeof count === 'number' && Number.isInteger(count) && count >= 1
    if (!sound) return undefined
    counts.push({ signature, week, count })
  }
  return { counts, pending: top['pending'] as string[] }
}

/** The counts a fold file holds: none when it is absent (undefined text), undefined when it is not a fold of this contract. */
export function parseFolded(text: string | undefined): FoldedCount[] | undefined {
  return parseFold(text)?.counts.map(counted => counted)
}

/**
 * The text of the fold file once the events about to be dropped (each with its identifier and the text
 * of its file, undefined for one already gone) are counted into `current`; undefined when none is a new
 * event, so nothing is written. An event `current` lists as pending was counted by an earlier prune whose
 * removal did not happen: it is not counted again. The pending ids written are the ones of this batch,
 * which the writer removes right after the write. Throws when `current` is no fold of this contract: a
 * writer never overwrites counts it cannot read, so it drops nothing either.
 */
export function foldDropped(dropped: ReadonlyArray<{ readonly id: string; readonly text: string | undefined }>, current: string | undefined): string | undefined {
  const events: Array<{ readonly id: string; readonly event: Foldable }> = []
  for (const { id, text } of dropped) {
    if (text === undefined) continue
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      continue
    }
    const event = parseJournalEvent(raw)
    if (event) events.push({ id, event })
  }
  if (events.length === 0) return undefined
  const before = parseFold(current)
  if (before === undefined) throw new Error(`the fold file ${JOURNAL_FOLD_FILE} is not readable, so nothing is dropped`)
  const counted = new Set(before.pending)
  const added = events.filter(({ id }) => !counted.has(id))
  if (added.length === 0) return undefined
  return foldedText(mergeFolded(before.counts, foldWeekly(added.map(({ event }) => event))), events.map(({ id }) => id))
}

// ----- the candidate -----
//
// What the distiller computes from the journals, with no model: the version 1 events of one
// signature, inside the window, once they reach the thresholds held here. It carries what code can
// say of the cluster (its signature's parts, the events by identifier, the pull requests and the
// repositories they name) and nothing a session judges: the cause, the remedy and its scope are the
// retrospective's.

export const CANDIDATE_CONTRACT = {
  version: 1,
  // A cluster becomes a candidate at this many events, from this many pull requests, within the window.
  min_events: 3,
  min_prs: 2,
  // The trusts whose events form a cluster: an `external` event is a pointer, never a count.
  trusts: ['computed', 'operator', 'review'],
} as const

export const CANDIDATE_VERSION = CANDIDATE_CONTRACT.version

export interface Candidate extends SignatureParts {
  readonly v: number
  readonly signature: string
  readonly kind: LearningKind
  /** The window the events fall in: its start and its end, the time the distiller ran at. */
  readonly since: string
  readonly until: string
  /** The identifiers of the events, in order. */
  readonly events: readonly string[]
  /** The pull requests the events name, as `owner/name#7`, in order. */
  readonly prs: readonly string[]
  /** The repositories the events name, in order. */
  readonly repos: readonly string[]
}

const CANDIDATE_FIELDS = ['v', 'signature', 'kind', 'code', 'severity', 'classes', 'languages', 'since', 'until', 'events', 'prs', 'repos'] as const
const PATH_CLASSES: readonly PathClass[] = [...CLASS_RULES.map(([name]) => name), contract.path_class_default]

/** A list of `isT` values in strictly rising order, so each is there once and the same set reads the same. */
function isRising<T extends string>(value: unknown, isT: (v: unknown) => v is T): value is T[] {
  return Array.isArray(value) && value.every((v, i) => isT(v) && (i === 0 || value[i - 1] < v))
}

function isPrOf(value: unknown): value is string {
  const [repo, pr, ...more] = typeof value === 'string' ? value.split('#') : []
  return more.length === 0 && isRepo(repo) && pr !== undefined && /^[1-9][0-9]*$/.test(pr)
}

/**
 * The candidate `raw` holds, or undefined: exactly the contract's fields, a signature that is the one
 * its parts give, a window that ends after it starts, the thresholds reached, and every pull request
 * in a repository the candidate names.
 */
export function parseCandidate(raw: unknown): Candidate | undefined {
  const top = fieldsOf(raw, CANDIDATE_FIELDS)
  if (!top) return undefined
  const { v, signature, kind, code, severity, classes, languages, since, until, events, prs, repos } = top
  if (v !== CANDIDATE_VERSION || !isOneOf(contract.kinds, kind) || !matches(PATTERNS.code, code)) return undefined
  if (!nullable(severity, (s): s is Severity => isOneOf(contract.severities, s))) return undefined
  if (!isRising(classes, (c): c is PathClass => isOneOf(PATH_CLASSES, c)) || !isRising(languages, (l): l is string => typeof l === 'string' && Object.hasOwn(contract.languages, l))) return undefined
  if (signature !== signatureFrom({ kind, code, severity, classes, languages })) return undefined
  if (!isTime(since) || !isTime(until) || since >= until) return undefined
  if (!isRising(events, isId) || events.length < CANDIDATE_CONTRACT.min_events) return undefined
  if (!isRising(repos, isRepo) || !isRising(prs, isPrOf) || prs.length < CANDIDATE_CONTRACT.min_prs) return undefined
  if (!prs.every(pr => repos.includes(pr.slice(0, pr.indexOf('#'))))) return undefined
  return { v, signature, kind, code, severity, classes, languages, since, until, events, prs, repos }
}

// ----- version 2: the audit trail -----
//
// The facts an auditor needs to say where a pull request's time went and how the method held,
// written by hooks and scripts, never by a model: which session, dispatch row, pull request and
// spec goal belong together (`link`), when each step began or ended (`step`: implement, review,
// correction, the wait on CI, the merge), each review verdict with its counts (`review`), the
// orchestrator's decision on each finding (`decision`), each declared wait (`wait`), and the
// method's failures (`failure`). The envelope is version 1's; `fact` holds the kind's own fields,
// each present, null when unknown. Version 1's kinds keep version 1: a refusal is still a refusal.

export const AUDIT_CONTRACT = {
  version: 2,
  kinds: ['link', 'step', 'review', 'decision', 'wait', 'failure'],
  steps: ['implement', 'review', 'correction', 'ci-wait', 'merge'],
  edges: ['start', 'end'],
  verdicts: ['pass', 'fail', 'accepted'],
  decisions: ['kept', 'set-aside'],
  finding_severities: ['critical', 'important', 'minor'],
  // The kinds a turn declares, and `tool`, which past journals carry.
  waits: [...WAIT_KINDS, 'tool'],
  wait_on: ['operator', 'tool'],
  failures: ['fix-after-merge', 'verdict-overridden', 'succession-lost-state'],
  prs_max: 8,
  // The fields of each kind's fact, in order.
  facts: {
    link: ['record', 'row', 'session', 'goal', 'prs'],
    step: ['step', 'edge', 'record', 'row', 'result'],
    review: ['verdict', 'kept', 'set_aside'],
    decision: ['decision', 'severity', 'file', 'line'],
    wait: ['wait', 'edge', 'span', 'on'],
    failure: ['failure', 'count', 'prs'],
  },
  patterns: {
    goal: '^G[0-9]{1,4}$',
    result: '^[a-z][a-z-]{0,31}$',
    // A pull request named with its repository: `name#7` or `owner/name#7`.
    pr_ref: String.raw`^(?:[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+#[1-9][0-9]*$`,
  },
} as const

const audit = AUDIT_CONTRACT

export const AUDIT_VERSION = audit.version
export const AUDIT_KINDS = audit.kinds

export type AuditKind = (typeof audit.kinds)[number]
export type Step = (typeof audit.steps)[number]
export type Edge = (typeof audit.edges)[number]
export type Verdict = (typeof audit.verdicts)[number]
export type Decision = (typeof audit.decisions)[number]
export type FindingSeverity = (typeof audit.finding_severities)[number]
export type JournalWaitKind = (typeof audit.waits)[number]
export type WaitOn = (typeof audit.wait_on)[number]
export type Failure = (typeof audit.failures)[number]

export interface Facts {
  readonly link: { readonly record: string | null; readonly row: number | null; readonly session: string | null; readonly goal: string | null; readonly prs: readonly string[] }
  readonly step: { readonly step: Step; readonly edge: Edge; readonly record: string | null; readonly row: number | null; readonly result: string | null }
  readonly review: { readonly verdict: Verdict; readonly kept: number; readonly set_aside: number }
  readonly decision: { readonly decision: Decision; readonly severity: FindingSeverity | null; readonly file: string | null; readonly line: number | null }
  readonly wait: { readonly wait: JournalWaitKind; readonly edge: Edge; readonly span: string | null; readonly on: WaitOn | null }
  readonly failure: { readonly failure: Failure; readonly count: number | null; readonly prs: readonly string[] }
}

export type AuditEvent = { [K in AuditKind]: Envelope & { readonly v: 2; readonly kind: K; readonly fact: Facts[K] } }[AuditKind]

const AUDIT_PATTERNS = {
  goal: new RegExp(audit.patterns.goal),
  result: new RegExp(audit.patterns.result),
  prRef: new RegExp(audit.patterns.pr_ref),
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const isId = (value: unknown): value is string => matches(PATTERNS.id, value)
const isRefs = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= audit.prs_max && value.every(ref => matches(AUDIT_PATTERNS.prRef, ref, contract.path_max))

/** Each fact's fields, checked: the fact, or undefined when one breaks the contract. */
const FACT_CHECKS: { readonly [K in AuditKind]: (fact: Fields) => boolean } = {
  link: f => nullable(f['record'], isPath) && nullable(f['row'], isLine) && nullable(f['session'], isSession)
    && nullable(f['goal'], (g): g is string => matches(AUDIT_PATTERNS.goal, g)) && isRefs(f['prs']),
  step: f => isOneOf(audit.steps, f['step']) && isOneOf(audit.edges, f['edge']) && nullable(f['record'], isPath) && nullable(f['row'], isLine)
    && nullable(f['result'], (r): r is string => matches(AUDIT_PATTERNS.result, r)),
  review: f => isOneOf(audit.verdicts, f['verdict']) && isCount(f['kept']) && isCount(f['set_aside']),
  decision: f => isOneOf(audit.decisions, f['decision']) && nullable(f['severity'], (s): s is FindingSeverity => isOneOf(audit.finding_severities, s))
    && nullable(f['file'], isPath) && nullable(f['line'], isLine),
  wait: f => isOneOf(audit.waits, f['wait']) && isOneOf(audit.edges, f['edge']) && nullable(f['span'], isId)
    && nullable(f['on'], (o): o is WaitOn => isOneOf(audit.wait_on, o)),
  failure: f => isOneOf(audit.failures, f['failure']) && nullable(f['count'], isCount) && isRefs(f['prs']),
}

/** The audit event `raw` holds, or undefined: version 1's envelope, a kind of version 2 and exactly its fact's fields. */
export function parseAuditEvent(raw: unknown): AuditEvent | undefined {
  const read = envelopeOf(raw, AUDIT_VERSION, ['fact'])
  if (!read) return undefined
  const kind = read.top['kind']
  if (!isOneOf(audit.kinds, kind)) return undefined
  const fact = fieldsOf(read.top['fact'], audit.facts[kind])
  if (!fact || !FACT_CHECKS[kind](fact)) return undefined
  return { v: AUDIT_VERSION, kind, ...read.envelope, fact } as AuditEvent
}

/** An entry of a journal, of either version, read by its own version's reader. */
export function parseJournalEvent(raw: unknown): LearningEvent | AuditEvent | undefined {
  return parseLearningEvent(raw) ?? parseAuditEvent(raw)
}

/** What a writer gives: the time and random part of the identifier, and only the fields it knows. */
export interface EventInput {
  readonly at: string
  readonly random: string
  readonly source: { readonly plugin: string; readonly code: string }
  readonly subject?: { readonly repo?: string | null; readonly pr?: number | null; readonly head?: string | null }
  readonly context?: { readonly role?: string | null; readonly mode?: string | null; readonly paths?: readonly string[]; readonly session?: string | null }
  readonly evidence?: readonly Evidence[]
  readonly trust: Trust
}

function envelopeFrom(input: EventInput): Record<string, unknown> {
  const paths = input.context?.paths ?? []
  return {
    id: eventId(input.at, input.random),
    at: input.at,
    source: input.source,
    subject: { repo: input.subject?.repo ?? null, pr: input.subject?.pr ?? null, head: input.subject?.head ?? null },
    context: { role: input.context?.role ?? null, mode: input.context?.mode ?? null, paths, languages: languagesOf(paths), session: input.context?.session ?? null },
    evidence: input.evidence ?? [],
    trust: input.trust,
  }
}

/** A version 1 event from what its writer knows, or undefined when a field breaks the contract. */
export function learningEvent(input: EventInput & { readonly kind: LearningKind }): LearningEvent | undefined {
  return parseLearningEvent({ v: LEARNING_VERSION, kind: input.kind, ...envelopeFrom(input) })
}

/** An audit event from what its writer knows, or undefined when a field breaks the contract. */
export function auditEvent<K extends AuditKind>(input: EventInput & { readonly kind: K; readonly fact: Facts[K] }): AuditEvent | undefined {
  return parseAuditEvent({ v: AUDIT_VERSION, kind: input.kind, ...envelopeFrom(input), fact: input.fact })
}

/**
 * The subject a writer names, from what it read: the repository in lower case (the forge compares
 * names so, and one pull request must read the same from every writer), the pull request and the
 * head, each kept when it fits the contract and null otherwise, so a field the writer could not read
 * never costs the event.
 */
export function subjectOf(raw: { readonly repo?: unknown; readonly pr?: unknown; readonly head?: unknown }): LearningEvent['subject'] {
  const repo = typeof raw.repo === 'string' ? raw.repo.trim().toLowerCase() : null
  const head = typeof raw.head === 'string' ? raw.head.trim().toLowerCase() : null
  return { repo: isRepo(repo) ? repo : null, pr: isLine(raw.pr) ? raw.pr : null, head: matches(PATTERNS.head, head) ? head : null }
}

/**
 * A file as a finding names it, as a path of the repository: a trailing line number and a leading
 * `./` dropped, the checkout's own directory (`root`) cut from an absolute path; undefined for what
 * is still no path of the contract.
 */
export function repoPath(file: string, root?: string): string | undefined {
  const top = root === undefined ? '' : `${root.replace(/\/+$/, '')}/`
  const named = file.trim().replace(/:\d+(?:[-:]\d+)?$/, '')
  const path = (top !== '/' && top !== '' && named.startsWith(top) ? named.slice(top.length) : named).replace(/^(?:\.\/)+/, '')
  return isPath(path) ? path : undefined
}

/** What a writer knows of any event: its time and random part, its plugin, and the subject and context it read. */
export type Known = Pick<EventInput, 'at' | 'random' | 'subject' | 'context'> & { readonly plugin: string }

/**
 * A finding an agent reported, as a version 1 event: the code that names what found it, the file as
 * its one path, and, for a severity of the contract, the pointer a signature reads. A file that is no
 * path of the contract is left out rather than losing the finding. The finding's summary never
 * enters: the event holds where and how severe, not what was said.
 */
export function findingEvent(input: Known & { readonly code: string; readonly severity: string; readonly file: string; readonly root?: string }): LearningEvent | undefined {
  const file = repoPath(input.file, input.root)
  const severity = isOneOf(contract.severities, input.severity) ? input.severity : undefined
  return learningEvent({
    at: input.at, random: input.random, kind: 'finding', trust: 'review',
    source: { plugin: input.plugin, code: input.code },
    ...(input.subject ? { subject: input.subject } : {}),
    context: { ...input.context, paths: file === undefined ? [] : [file] },
    evidence: file !== undefined && severity !== undefined ? [{ type: 'finding', severity, file }] : [],
  })
}

/**
 * How the operator answered a structured question, as code reads it: a grant asked by name (a
 * consent's kind, a push) and whether he gave it; or the letter he chose among the choices, null for
 * words of his own, beside the letter that was recommended.
 */
export type AnswerGiven =
  | { readonly asked: string; readonly granted: boolean }
  | { readonly letter: string | null; readonly recommended: string | null }

/**
 * What an answer to a question of the round gives: for a question that asks a consent, its kind and
 * whether the answer grants it (consent-record.ts reads the answer); for any other, the choice its
 * opening letter names.
 */
export function answerGiven(
  answer: string,
  asked: { readonly consent?: { readonly kind: string } | null; readonly choices?: readonly { readonly letter: string; readonly text: string }[]; readonly recommended?: string | null },
): AnswerGiven {
  const choices = asked.choices ?? []
  if (asked.consent) return { asked: asked.consent.kind, granted: grants(consentAnswer(answer, choices)) }
  return { letter: givenAnswer(answer, choices).letter, recommended: asked.recommended ?? null }
}

/** The code of an answer: the grant asked and its outcome, or how the choice stands to the recommendation. */
function answerCode(plugin: string, given: AnswerGiven): string {
  if ('asked' in given) return `${plugin}.answer.${given.asked}.${given.granted ? 'granted' : 'refused'}`
  if (given.letter === null) return `${plugin}.answer.own-words`
  return `${plugin}.answer.${given.recommended !== null && given.letter.toUpperCase() === given.recommended.toUpperCase() ? 'recommended' : 'other'}`
}

/**
 * The operator's answer to a structured question, as a version 1 event of his trust: what was asked
 * and how he answered as its code, never his words; `ruling` points at the file that keeps them (a
 * path under the configuration directory), left out when it is no path of the contract.
 */
export function answerEvent(input: Known & { readonly given: AnswerGiven; readonly ruling?: string | null }): LearningEvent | undefined {
  return learningEvent({
    at: input.at, random: input.random, kind: 'answer', trust: 'operator',
    source: { plugin: input.plugin, code: answerCode(input.plugin, input.given) },
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.context ? { context: input.context } : {}),
    evidence: isPath(input.ruling) ? [{ type: 'ruling', path: input.ruling, line: 1 }] : [],
  })
}

/** The file an event is written to in its journal: its identifier, so names sort by time. */
export function journalFileOf(id: string): string {
  return `${id}.json`
}

/** The identifier and time of a journal's entry, read from its name; undefined for a name no writer gives. */
export function journalEntryOf(name: string): { id: string; at: string } | undefined {
  const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : ''
  const at = id.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-.*$/, '$1-$2-$3T$4:$5:$6Z')
  return isId(id) && eventId(at, id.slice(-8)) === id ? { id, at } : undefined
}

/** The pull requests a text names with their repository (`name#7`, `owner/name#7`), each once, in order, at most `prs_max`. */
export function prRefsOf(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/(?<![\w./@#-])((?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+#[1-9][0-9]*)(?![\w/#])/g)) {
    const ref = match[1] ?? ''
    if (AUDIT_PATTERNS.prRef.test(ref)) found.add(ref)
  }
  return [...found].slice(0, audit.prs_max)
}
