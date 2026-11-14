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

/** An open pull request as the forge lists it. */
export interface OpenPr {
  readonly repo: string
  readonly pr: number
  readonly createdAt: string | null
}

/** An open pull request nobody attends, and since when: its line's last setting, else its opening. */
export interface Unattended {
  readonly repo: string
  readonly pr: number
  readonly since: string | null
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
  return { v, ledger: 'pr', repo, pr, status, [key]: detail, since, updated }
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
  return { v: LEDGER_VERSION, ledger: 'pr', repo: set.repo, pr: set.pr, status: set.status, [key]: detail, since: same ? previous.since : at, updated: at }
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

/** The archive beside a record: `<record>.archive.jsonl`, the record's own `.jsonl` dropped first. */
export function archiveOf(record: string): string {
  return `${record.replace(/\.jsonl$/, '')}${PR_LEDGER_CONTRACT.archive_suffix}`
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

/**
 * The open pull requests nobody attends: no live agent on it and no wait set again within
 * UNATTENDED_AFTER_MS, and not parked by the operator. One in no record is unattended outright; one
 * another orchestration records (`claimed`, by prKey) is that orchestration's to attend.
 */
export function unattended(input: {
  readonly open: readonly OpenPr[]
  readonly lines: readonly LedgerLine[]
  readonly live: ReadonlySet<string>
  readonly now: number
  readonly claimed?: ReadonlySet<string>
}): Unattended[] {
  const byKey = new Map(input.lines.map(line => [prKey(line.repo, line.pr), line]))
  const left: Unattended[] = []
  for (const open of input.open) {
    const key = prKey(open.repo, open.pr)
    const line = byKey.get(key)
    if (line === undefined) {
      if (!input.claimed?.has(key)) left.push({ repo: open.repo, pr: open.pr, since: open.createdAt })
      continue
    }
    if (line.status === 'parked') continue
    if (line.status === 'working' && input.live.has(line.agent ?? '')) continue
    const updated = Date.parse(line.updated)
    if (line.status === 'waiting' && Number.isFinite(updated) && input.now - updated <= UNATTENDED_AFTER_MS) continue
    left.push({ repo: open.repo, pr: open.pr, since: line.updated })
  }
  return left
}

/**
 * « PR délaissées : <repo>#<n> (sans agent depuis <t>), … », then the repositories whose open pull
 * requests the forge did not list, said unknown; null when there is neither.
 */
export function unattendedLine(list: readonly Unattended[], unread: readonly string[], at: (iso: string | null) => string = minuteOf): string | null {
  const parts: string[] = []
  if (list.length > 0) parts.push(list.map(u => `${prKey(u.repo, u.pr)} (sans agent depuis ${at(u.since)})`).join(', '))
  if (unread.length > 0) parts.push(`inconnues pour ${unread.join(', ')} (forge illisible)`)
  return parts.length === 0 ? null : `PR délaissées : ${parts.join(' ; ')}`
}

/** The lines whose pull request is no longer open, in the repositories the forge listed (`open`, by repository). */
export function endedLines(lines: readonly LedgerLine[], open: ReadonlyMap<string, readonly number[]>): LedgerLine[] {
  return lines.filter(line => open.has(line.repo) && !(open.get(line.repo) ?? []).includes(line.pr))
}
