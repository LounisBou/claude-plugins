// The pull request ledger, owned by the orchestrator: lines of its dispatch record, beside the
// dispatch rows, one per open pull request, each saying who is on it. The forge stays the source
// of which pull requests are open; the ledger says only whether someone attends each. A line moves
// to the archive beside the record once its pull request is merged or closed. Read by the
// orchestrator's dispatch record, its hooks module (the turn-end line, the declared wait, the
// pane) and the coordinator's facts, through what the module stores.

/** The mark and version a ledger line carries, its three statuses, and the archive's name. */
export const PR_LEDGER_CONTRACT = {
  version: 1,
  mark: 'pr',
  statuses: ['working', 'waiting', 'parked'],
  archive_suffix: '.archive.jsonl',
} as const

export const LEDGER_VERSION = PR_LEDGER_CONTRACT.version

/** How many agents put to work on a pull request before its last one a working line keeps. */
export const LEDGER_EARLIER_KEPT = 8

/** A wait not set again within this long no longer attends its pull request. */
export const UNATTENDED_AFTER_MS = 30 * 60 * 1000

/** working: an agent is on it; waiting: it waits on what `on` names; parked: the operator put it off. */
export type LedgerStatus = 'working' | 'waiting' | 'parked'

export interface LedgerLine {
  readonly v: number
  readonly ledger: 'pr'
  readonly repo: string
  readonly pr: number
  readonly status: LedgerStatus
  /** working: the agent's session name. */
  readonly agent?: string
  /**
   * working: the agents put to work on it before `agent`, the newest first, each once (a reviewer
   * put on the line of an implementer still running leaves the implementer here): while any runs,
   * the pull request is attended.
   */
  readonly earlier?: readonly string[]
  /** waiting: what it waits on. */
  readonly on?: string
  /** parked: the operator's words, dated. */
  readonly ruling?: string
  /** When this status began. */
  readonly since: string
  /** When the line was last set. */
  readonly updated: string
}

/** What a caller sets: the pull request, its status, and the one detail that status takes. */
export type LedgerSet =
  | { readonly repo: string; readonly pr: number; readonly status: 'working'; readonly agent: string }
  | { readonly repo: string; readonly pr: number; readonly status: 'waiting'; readonly on: string }
  | { readonly repo: string; readonly pr: number; readonly status: 'parked'; readonly ruling: string }

/** An open pull request as the forge lists it, with the names of its labels and its `mergeable` state when the caller read them. */
export interface OpenPr {
  readonly repo: string
  readonly pr: number
  readonly labels?: readonly string[]
  readonly mergeable?: string
}

/**
 * What an unattended pull request waits on the operator for: `ready` (it carries `Ready`: his merge),
 * `hold` (it carries `On Hold`: his own pause), `record` (its line says it waits on him, `on` his words).
 */
export interface WaitsOnOperator {
  readonly why: 'ready' | 'hold' | 'record'
  readonly on?: string
}

/**
 * An open pull request of the orchestration's own lines no agent holds, and since when: its line's last setting (a wait on the operator: since the wait began). With
 * `waits` it rests on the operator's gesture; without, it is in anomaly (Not Ready, no agent, no wait, or in conflict: `conflict`).
 */
export interface Unattended {
  readonly repo: string
  readonly pr: number
  readonly since: string | null
  readonly waits?: WaitsOnOperator
  readonly conflict?: true
}

const REPO_PART = /^[A-Za-z0-9_.-]+$/
const DETAIL: Readonly<Record<LedgerStatus, 'agent' | 'on' | 'ruling'>> = { working: 'agent', waiting: 'on', parked: 'ruling' }

function isRepo(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split('/')
  return parts.length === 2 && parts.every(part => REPO_PART.test(part) && part !== '.' && part !== '..')
}

const isStatus = (value: unknown): value is LedgerStatus => PR_LEDGER_CONTRACT.statuses.some(status => status === value)
const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** `<owner/name>#<n>`, the name a pull request goes by in every reading. */
export function prKey(repo: string, pr: number): string {
  return `${repo}#${pr}`
}

/** The pull request a `<owner/name>#<n>` names, or undefined. */
export function parsePrRef(text: string): { repo: string; pr: number } | undefined {
  const match = /^([^#\s]+)#([1-9][0-9]*)$/.exec(text.trim())
  if (match === null || !isRepo(match[1])) return undefined
  return { repo: match[1], pr: Number(match[2]) }
}

/** Whether a record's line carries the ledger's mark: never a dispatch row, even when it breaks the shape. */
export function isLedgerMarked(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && (raw as Record<string, unknown>)['ledger'] === PR_LEDGER_CONTRACT.mark
}

/** The line `raw` holds, or undefined when it breaks the shape. */
export function parseLedgerLine(raw: unknown): LedgerLine | undefined {
  if (!isLedgerMarked(raw)) return undefined
  const r = raw as Record<string, unknown>
  const { v, repo, pr, status, since, updated } = r
  if (v !== LEDGER_VERSION || !isRepo(repo) || typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) return undefined
  if (!isStatus(status) || typeof since !== 'string' || typeof updated !== 'string') return undefined
  const key = DETAIL[status]
  const detail = r[key]
  if (!filled(detail)) return undefined
  const earlier = status === 'working' && Array.isArray(r['earlier']) ? r['earlier'].filter(filled) : []
  return { v, ledger: 'pr', repo, pr, status, [key]: detail, ...(earlier.length > 0 ? { earlier } : {}), since, updated }
}

/** The ledger lines of a record's text, the last one of each pull request standing; rows and broken lines left out. */
export function ledgerLines(text: string): LedgerLine[] {
  const byKey = new Map<string, LedgerLine>()
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      continue
    }
    const read = parseLedgerLine(value)
    if (read === undefined) continue
    const key = prKey(read.repo, read.pr)
    byKey.delete(key)
    byKey.set(key, read)
  }
  return [...byKey.values()]
}

const stamp = (at: Date): string => at.toISOString().replace(/\.[0-9]{3}Z$/, 'Z')

/** The line a setting writes at `now`: its start kept while the same status and detail hold. */
export function ledgerLineOf(set: LedgerSet, now: Date, previous?: LedgerLine): LedgerLine {
  const key = DETAIL[set.status]
  const detail = (set as unknown as Record<string, string>)[key] ?? ''
  const same = previous !== undefined && previous.status === set.status && previous[key] === detail
  const at = stamp(now)
  // A working line put on another agent keeps the one before it, and those it kept, the new one left out.
  const before = previous?.status === 'working' && set.status === 'working' ? [previous.agent ?? '', ...(previous.earlier ?? [])] : []
  const earlier = [...new Set(before.filter(agent => agent !== '' && agent !== detail))].slice(0, LEDGER_EARLIER_KEPT)
  return {
    v: LEDGER_VERSION, ledger: 'pr', repo: set.repo, pr: set.pr, status: set.status, [key]: detail, ...(earlier.length > 0 ? { earlier } : {}),
    since: same ? previous.since : at, updated: at,
  }
}

function keyOfText(raw: string): string | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!isLedgerMarked(value)) return undefined
    const r = value as Record<string, unknown>
    return typeof r['repo'] === 'string' && typeof r['pr'] === 'number' ? prKey(r['repo'], r['pr']) : undefined
  } catch {
    return undefined
  }
}

/** A record's text without the ledger lines of the pull requests named; every other line as it was. */
export function withoutLines(text: string, keys: readonly string[]): string {
  const out = text.split('\n').filter(raw => raw.trim() !== '' && !keys.includes(keyOfText(raw) ?? ''))
  return out.map(raw => `${raw}\n`).join('')
}

/** A record's text with `line` as its pull request's one line, after the rest. */
export function withLine(text: string, line: LedgerLine): string {
  return `${withoutLines(text, [prKey(line.repo, line.pr)])}${JSON.stringify(line)}\n`
}

/*
 * The text with `agent` taken out of every line's earlier list: put to work by the orchestrator on a
 * pull request, it no longer works on the others. Every line keeps its place and its other fields; a
 * list left empty goes.
 */
export function withoutEarlier(text: string, agent: string): string {
  return text.split('\n').map(raw => {
    if (keyOfText(raw) === undefined) return raw
    const line = JSON.parse(raw) as Record<string, unknown>
    const earlier = line['earlier']
    if (!Array.isArray(earlier) || !earlier.includes(agent)) return raw
    const kept = earlier.filter(other => other !== agent)
    if (kept.length > 0) line['earlier'] = kept
    else delete line['earlier']
    return JSON.stringify(line)
  }).join('\n')
}

/** The archive beside a record: `<record>.archive.jsonl`, the record's own `.jsonl` dropped first. */
export function archiveOf(record: string): string {
  return `${record.replace(/\.jsonl$/, '')}${PR_LEDGER_CONTRACT.archive_suffix}`
}

/** An archive's text with `lines` appended, each stamped with the time it was archived. */
export function withArchived(archive: string, lines: readonly LedgerLine[], now: Date): string {
  const head = archive === '' || archive.endsWith('\n') ? archive : `${archive}\n`
  return head + lines.map(line => `${JSON.stringify({ ...line, archived: stamp(now) })}\n`).join('')
}

/** An instant to the minute, in UTC: `2026-11-14T10:00Z`; `?` for none. */
export function minuteOf(iso: string | null): string {
  if (iso === null) return '?'
  const at = Date.parse(iso)
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 16) + 'Z' : '?'
}

/** A line's status in the operator's words. */
export function statusText(line: LedgerLine, at: (iso: string | null) => string = minuteOf): string {
  if (line.status === 'working') return `en cours (agent ${line.agent ?? '?'})`
  if (line.status === 'waiting') return `attend ${line.on ?? '?'} depuis ${at(line.since)}`
  return "en attente par l'opérateur"
}

/** The label of a pull request the operator may merge, and the one he puts to pause it. */
export const READY_LABEL = 'Ready'
export const HOLD_LABEL = 'On Hold'

const hasLabel = (open: OpenPr, label: string): boolean => (open.labels ?? []).some(name => name.trim().toLowerCase() === label.toLowerCase())

/** The agents a working line names: its agent, then those put to work on it before; none for any other status. */
export function agentsOf(line: LedgerLine): string[] {
  return line.status === 'working' ? [line.agent ?? '', ...(line.earlier ?? [])].filter(agent => agent !== '') : []
}

/** Whether a wait's words name the operator: his merge, his gesture, his ruling. */
export function waitsOnOperator(on: string | undefined): boolean {
  return /(?<![\p{L}])(operator|opérateur|operateur|ton|toi|his|him)(?![\p{L}])/iu.test(on ?? '')
}

/** A wait set again within UNATTENDED_AFTER_MS: its pull request is still attended. */
export function isFreshWait(line: LedgerLine, now: number): boolean {
  const updated = Date.parse(line.updated)
  return line.status === 'waiting' && Number.isFinite(updated) && now - updated <= UNATTENDED_AFTER_MS
}

/**
 * The pull requests of the orchestration's own lines that are open and that no agent holds: no live
 * agent on it and no wait set again within UNATTENDED_AFTER_MS, and not parked by the operator. The
 * lines are the only source: an open pull request no line names is nobody's and is not looked at.
 * Each is told apart: one that rests on the operator (carrying `Ready` or `On Hold`, or whose line waits on
 * him, even freshly) comes with `waits`; the rest, Not Ready with no agent and no recorded wait, are in anomaly.
 * One the forge reads `CONFLICTING` (`UNKNOWN`, computed late, counts nothing) is in anomaly whatever it waits on: `conflict`.
 */
export function unattended(input: {
  readonly open: readonly OpenPr[]
  readonly lines: readonly LedgerLine[]
  readonly live: ReadonlySet<string>
  readonly now: number
}): Unattended[] {
  const byKey = new Map(input.open.map(open => [prKey(open.repo, open.pr), open]))
  const left: Unattended[] = []
  for (const line of input.lines) {
    const open = byKey.get(prKey(line.repo, line.pr))
    if (open === undefined || line.status === 'parked') continue
    const onHim = line.status === 'waiting' && waitsOnOperator(line.on)
    if (!onHim) {
      if (line.status === 'working' && agentsOf(line).some(agent => input.live.has(agent))) continue
      if (isFreshWait(line, input.now)) continue
    }
    const conflict = open.mergeable === 'CONFLICTING'
    const why: WaitsOnOperator | undefined = conflict ? undefined : onHim ? { why: 'record', ...(line.on === undefined ? {} : { on: line.on }) }
      : hasLabel(open, HOLD_LABEL) ? { why: 'hold' }
        : hasLabel(open, READY_LABEL) ? { why: 'ready' }
          : undefined
    left.push({ repo: line.repo, pr: line.pr, since: onHim ? line.since : line.updated, ...(why === undefined ? {} : { waits: why }), ...(conflict ? { conflict } : {}) })
  }
  return left
}

/** The start of the line that names what waits on the operator, and of the one that names the anomalies. */
export const WAITS_HEAD = 'Attend ton geste'
export const ANOMALY_HEAD = 'En anomalie'

/** A line of the unattended reading: `anomaly` when it should alarm, else what waits on the operator. */
export interface UnattendedPart {
  readonly anomaly: boolean
  readonly text: string
}

/** What a pull request that rests on the operator waits for, short: `Ready`, `en pause`, `attend <on> depuis <t>`. */
function waitsState(u: Unattended, at: (iso: string | null) => string): string {
  if (u.waits?.why === 'ready') return 'Ready'
  if (u.waits?.why === 'hold') return 'en pause'
  return `attend ${(u.waits?.on ?? '?').replace(/\s+/g, ' ').trim()} depuis ${at(u.since)}`
}

/** What is wrong with a pull request in anomaly, short: `en conflit`, `sans agent depuis <t>`. */
function anomalyState(u: Unattended, at: (iso: string | null) => string): string {
  return u.conflict ? 'en conflit' : `sans agent depuis ${at(u.since)}`
}

/**
 * The reading's lines: « Attend ton geste : <repo>#<n> (Ready), <repo>#<n> (en pause), <repo>#<n> (attend <on> depuis <t>) »
 * for what rests on the operator, « En anomalie : <repo>#<n> (sans agent depuis <t>), … » for the pull requests Not Ready
 * with no agent and no recorded wait (« <repo>#<n> (en conflit) » for one the forge reads in conflict), then the repositories whose open pull requests the forge did not list, said unknown
 * on the anomaly line; none for what is empty.
 */
export function unattendedParts(list: readonly Unattended[], unread: readonly string[], at: (iso: string | null) => string = minuteOf): UnattendedPart[] {
  const waits = list.filter(u => u.waits !== undefined)
  const anomalies = list.filter(u => u.waits === undefined)
  const alarm: string[] = []
  if (anomalies.length > 0) alarm.push(anomalies.map(u => `${prKey(u.repo, u.pr)} (${anomalyState(u, at)})`).join(', '))
  if (unread.length > 0) alarm.push(`inconnues pour ${unread.join(', ')} (forge illisible)`)
  return [
    ...(waits.length === 0 ? [] : [{ anomaly: false, text: `${WAITS_HEAD} : ${waits.map(u => `${prKey(u.repo, u.pr)} (${waitsState(u, at)})`).join(', ')}` }]),
    ...(alarm.length === 0 ? [] : [{ anomaly: true, text: `${ANOMALY_HEAD} : ${alarm.join(' ; ')}` }]),
  ]
}

/**
 * A line of the reading as the pane draws it, under the label of its group (`label` is empty after the
 * group's first line). `anomaly` alarms. `text` is the words of the line: the pull requests of a group
 * (`wraps`: a line too long for its room wraps), or the one pull request of a line (not `wraps`: the
 * caller cuts `on`, what it waits on, to the room left, so `time`, last, always shows).
 */
export interface UnattendedPaneLine {
  readonly anomaly: boolean
  readonly label: string
  readonly text: string
  readonly wraps: boolean
  readonly on?: string
  readonly time?: string
}

/** A pull request as the pane names it, its repository without its owner: `back-office#817`. */
const shortRef = (u: Unattended): string => `${u.repo.slice(u.repo.lastIndexOf('/') + 1)}#${u.pr}`

/**
 * The reading as the pane draws it, grouped by state, each group under its label: `Ready` and `En pause`
 * each name their pull requests on one line, `Attend` one pull request to a line with what it waits on
 * and the time last; then, alarmed, `En conflit` (one line), `Sans agent` (one pull request to a line,
 * the time last) and `Inconnues`, the repositories the forge did not list. None for what is empty.
 */
export function unattendedPaneLines(list: readonly Unattended[], unread: readonly string[], at: (iso: string | null) => string = minuteOf): UnattendedPaneLine[] {
  const by = (pick: (u: Unattended) => boolean): Unattended[] => list.filter(pick)
  const group = (anomaly: boolean, label: string, members: readonly Unattended[]): UnattendedPaneLine[] =>
    members.length === 0 ? [] : [{ anomaly, label, text: members.map(shortRef).join(' · '), wraps: true }]
  const each = (anomaly: boolean, label: string, members: readonly Unattended[], on: (u: Unattended) => string | undefined): UnattendedPaneLine[] =>
    members.map((u, i) => {
      const what = on(u)?.replace(/\s+/g, ' ').trim()
      return { anomaly, label: i === 0 ? label : '', text: shortRef(u), wraps: false, ...(what ? { on: what } : {}), time: at(u.since) }
    })
  const anomalies = by(u => u.waits === undefined)
  return [
    ...group(false, 'Ready', by(u => u.waits?.why === 'ready')),
    ...group(false, 'En pause', by(u => u.waits?.why === 'hold')),
    ...each(false, 'Attend', by(u => u.waits?.why === 'record'), u => u.waits?.on ?? '?'),
    ...group(true, 'En conflit', anomalies.filter(u => u.conflict)),
    ...each(true, 'Sans agent', anomalies.filter(u => !u.conflict), () => undefined),
    ...(unread.length === 0 ? [] : [{ anomaly: true, label: 'Inconnues', text: `${unread.join(', ')} (forge illisible)`, wraps: true }]),
  ]
}

/** The reading's parts as text, one per line; null when there is none. */
export function unattendedLine(list: readonly Unattended[], unread: readonly string[], at: (iso: string | null) => string = minuteOf): string | null {
  const parts = unattendedParts(list, unread, at)
  return parts.length === 0 ? null : parts.map(part => part.text).join('\n')
}

/**
 * An open dispatch row ready to start: its number, its keyword (the label's first word) and its subject,
 * the label said in plain words (`subjectOf`). A row the operator deferred is listed once its `until`
 * date has come (`deferred`): it goes back to him, relaunched or dropped.
 */
export interface ReadyRow {
  readonly id: number
  readonly keyword: string
  readonly subject: string
  readonly deferred?: true
}

/** The most a subject keeps of its label, cut at a word with « … ». */
const SUBJECT_MAX = 90

/** A subject's loose end: spaces and commas, and a dash that stands apart (` —`), never a dash inside a word. */
const LOOSE_END = /(?:\s+[—–-]+)?[\s,]*$/u

/**
 * What a row's label is about, in plain words: past its `KEYWORD:` lead, up to where its detail starts
 * (a `:` before a space or at the end, a `;`, or a `(` after a space; a `:` in a URL or a time stays), at most
 * SUBJECT_MAX characters cut at a word; '' for a label with no words.
 */
export function subjectOf(label: string): string {
  const words = (label.trim().replace(/^[^\s:]+:(?:\s+|$)/u, '').split(/:(?=\s|$)|;|\s\(/u)[0] ?? '').replace(/\s+/g, ' ').trim().replace(LOOSE_END, '')
  const chars = Array.from(words)
  if (chars.length <= SUBJECT_MAX) return words
  const cut = chars.slice(0, SUBJECT_MAX).join('')
  const space = cut.lastIndexOf(' ')
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(LOOSE_END, '')}…`
}

/** The subject of an `Agent: <subject>` session name, lowercased; null for any other name. */
function agentSubject(name: string | undefined): string | null {
  const match = /^Agent ?: (.+?)(?: \[[^\]]*\])?$/u.exec((name ?? '').trim())
  return match?.[1] === undefined ? null : match[1].toLowerCase()
}

/**
 * The instant (ms) a row's blocker `until <ISO UTC time>` waits for, to the second, `Z` only; undefined
 * for any other blocker and for a time that does not exist (`2026-02-30T00:00:00Z`).
 */
export function untilOf(blocker: string): number | undefined {
  const match = /^until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/.exec(blocker)
  if (match === null) return undefined
  const at = Date.parse(match[1] ?? '')
  return Number.isNaN(at) || new Date(at).toISOString() !== match[1]?.replace('Z', '.000Z') ? undefined : at
}

/**
 * Whether a blocker is fallen on the clock alone: `none`, or an `until` whose time has passed. A
 * `measure` never falls by itself, and the forms checked on an artifact (`PR … merged`, `row … closed`,
 * `release installed`) are the takeover's to check, so none of them is fallen here.
 */
export function blockerFallen(blocker: unknown, now: number): boolean {
  if (blocker === 'none') return true
  const at = typeof blocker === 'string' ? untilOf(blocker) : undefined
  return at !== undefined && at <= now
}

/**
 * The open rows ready with nobody on them: a fallen blocker (`blockerFallen`, at `now`), and neither a live
 * agent (`live`, the session names the launcher lists running) nor an open pull request (`lines`, the ledger's)
 * naming the row. A row the operator deferred is listed, flagged `deferred`, only once its `until` blocker has
 * passed; with any other blocker it is never listed. A session or a pull request names a row by the row's keyword in the
 * agent's subject (a whole word of it), or by the row's note: `Agent: <subject>` of a live session, `<repo>#<n>` of a
 * line. `texts` are the dispatch records' texts; the ledger's lines and any other line are no row.
 */
export function readyRows(input: {
  readonly texts: readonly string[]
  readonly lines: readonly LedgerLine[]
  readonly live: ReadonlySet<string>
  readonly now?: number
}): ReadyRow[] {
  const now = input.now ?? Date.now()
  const alive = [...input.live].flatMap(name => agentSubject(name) ?? [])
  const ready: ReadyRow[] = []
  for (const text of input.texts) {
    for (const raw of text.split('\n')) {
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        continue
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value) || isLedgerMarked(value)) continue
      const row = value as Record<string, unknown>
      const { id, state, blocker, deferred, label, note } = row
      if (typeof id !== 'number' || state !== 'open' || !blockerFallen(blocker, now)) continue
      const putOff = typeof deferred === 'string' && deferred.trim() !== ''
      // A deferred row comes back on its date, an `until`: any other blocker is no date.
      if (putOff && (typeof blocker !== 'string' || untilOf(blocker) === undefined)) continue
      const words = typeof label === 'string' ? label.trim() : ''
      const keyword = /^[^\s:]+/u.exec(words)?.[0] ?? ''
      const held = (typeof note === 'string' ? note : '').toLowerCase()
      const wanted = keyword.toLowerCase()
      // A whole word of the agent's subject: `fix` is not held by `address-bug`.
      const spelled = (text: string): string => ` ${text.replace(/[^a-z0-9]+/g, ' ').trim()} `
      const named = (subject: string | null): boolean => subject !== null && wanted !== '' && spelled(subject).includes(spelled(wanted))
      if (alive.some(subject => named(subject) || spelled(held).includes(spelled(`agent: ${subject}`)))) continue
      if (input.lines.some(line => agentsOf(line).some(agent => named(agentSubject(agent))) || new RegExp(`(?<![a-z0-9._-])${(line.repo.split('/')[1] ?? '').replace(/\./g, '\\.')}#${line.pr}(?![0-9])`, 'i').test(held))) continue
      ready.push({ id, keyword: keyword === '' ? 'no keyword' : keyword, subject: subjectOf(words), ...(putOff ? { deferred: true as const } : {}) })
    }
  }
  return ready
}

/**
 * « Sujets prêts sans agent : <subject> (ligne <id>) ; … », then, for the deferred rows whose date has come,
 * « Sujets différés à leur date de réexamen : … — à demander à l'opérateur : relancer ou abandonner »; null when none.
 * Each row leads with its subject, the line the operator is told, its id after it for the session that dispatches it;
 * a label with no words is named by its keyword.
 */
export function readyRowsLine(list: readonly ReadyRow[]): string | null {
  const named = (rows: readonly ReadyRow[]): string =>
    rows.map(row => `${row.subject !== '' ? row.subject : row.keyword} (ligne ${row.id})`).join(' ; ')
  const ready = list.filter(row => row.deferred !== true)
  const due = list.filter(row => row.deferred === true)
  const lines = [
    ...(ready.length === 0 ? [] : [`Sujets prêts sans agent : ${named(ready)}`]),
    ...(due.length === 0 ? [] : [`Sujets différés à leur date de réexamen : ${named(due)} — à demander à l'opérateur : relancer ou abandonner`]),
  ]
  return lines.length === 0 ? null : lines.join('\n')
}

/** The lines whose pull request is no longer open, in the repositories the forge listed (`open`, by repository). */
export function endedLines(lines: readonly LedgerLine[], open: ReadonlyMap<string, readonly number[]>): LedgerLine[] {
  return lines.filter(line => open.has(line.repo) && !(open.get(line.repo) ?? []).includes(line.pr))
}
