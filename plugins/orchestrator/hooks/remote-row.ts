// hooks/remote-row.ts
// An orchestrator's store row, carried to a coordinator on another machine. The pane
// and /orchestrator-status read the local store alone, so an orchestrator whose session
// runs elsewhere never showed. Its module sends the row as one marked line, and the
// coordinator's module takes that line out of the delivery before any model reads it:
// the row lands in the coordinator's store (`remote/<name>`), and no turn on either side
// spends a token on it. Sent only when what the pane shows changes — the wait, the fill
// crossing a band — plus one refresh per bound so the age stays honest. Pure on purpose:
// the handlers hold the $ (supervision.ts) and pass their reads in here.
import { roleOf } from './session-name.ts'
import { watchNumberOf } from './stop-gate.ts'
import type { SessionRow } from './supervision.ts'
import { confirmsTakeover, type WaitKind } from './relay.ts'

// The line's fixed head: what the receiver keys on, and nothing a person or a model
// writes by chance.
export const ROW_MARKER = '[module-row] '

// The fill is reported by band: a crossing is news, a point is not.
export const ROW_BAND_PERCENT = 5

// How long a remote row is drawn after its last reading. It carries no pid, so its
// session's life cannot be read; an orchestrator waiting on the operator takes no turn and
// sends no refresh, and the store's one-hour rule would drop it exactly while it waits.
// The pane's age says how old the reading is.
export const REMOTE_STALE_AFTER_MS = 24 * 60 * 60 * 1000

// At most one send per this bound while nothing changes: the pane draws the row's age,
// and a row the sender stopped refreshing must age into the stale bound.
export const ROW_REFRESH_MS = 10 * 60 * 1000

// The receiver's caps: a line past them is refused whole, never cut.
export const ROW_TEXT_CAP = 2048
const NAME_CAP = 120
export const BLOCKS_CAP = 200   // what a row's and an ask's blocks are cut to (remote-round.ts)
const MACHINE_CAP = 64
const STAMP_CAP = 40
const NUMBER_CAP = 100_000_000
const REPO_CAP = 140
const PR_CAP = 150

// The pull requests a row lists, at most this many: the sender cuts to it, the receiver
// refuses a row past it.
export const PRS_CAP = 20

// A repository as the store row holds it (`owner/name`), and a pull request in flight
// (`owner/name#<n>`): the receiver's shape, which the sender also checks before it sends.
const REPO_SHAPE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const PR_SHAPE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#[1-9][0-9]{0,8}$/

// The row as it travels: the pane's own fields, the machine it was measured on, and the
// repository and the pull requests in flight its orchestrator watches — no path, no model,
// no pid, no environment value.
export type RemoteRow = {
  name: string
  role: 'orchestrator'
  context_tokens: number
  context_percent: number
  window: number
  waiting: Extract<WaitKind, 'operator' | 'done'> | null
  blocks: string | null
  waiting_since: string | null
  updated_at: string
  machine: string
  repo: string | null
  prs: string[]
}

// The ten fields 0.58 and 0.59 sent, still accepted as no repository and no pull request.
const OLD_FIELDS = ['name', 'role', 'context_tokens', 'context_percent', 'window', 'waiting', 'blocks', 'waiting_since', 'updated_at', 'machine'] as const
const FIELDS = [...OLD_FIELDS, 'repo', 'prs'] as const

// What was last sent (`rows/<id>`, beside the wait file): the deduplication key. A record
// written before the repository and the pull requests were carried has neither field.
export type RowSent = { band: number; waiting: string | null; blocks: string | null; repo?: string | null; prs?: string[]; sent_at: string }

// A machine label as the pane shows it: the host name's own letters, cut, never empty.
export function machineLabel(raw: string): string {
  const label = raw.trim().split('.')[0].replace(/[^A-Za-z0-9_-]/g, '').slice(0, MACHINE_CAP)
  return label || 'unknown'
}

// The row out of the session's store row (its wait merged in) and the pull requests in
// flight (prsInFlight): null for any session that is no named orchestrator — only an
// orchestrator's row travels. The repository is the store row's own, or none when it is not
// the receiver's shape.
export function remoteRowOf(row: SessionRow | null, machine: string, prs: readonly string[] = []): RemoteRow | null {
  if (!row || row.role !== 'orchestrator' || !row.name || roleOf(row.name) !== 'orchestrator') return null
  const on = row.waiting === 'operator' || row.waiting === 'done'
  const out: RemoteRow = {
    name: row.name.slice(0, NAME_CAP),
    role: 'orchestrator',
    context_tokens: clampInt(row.context_tokens),
    context_percent: Math.max(0, Math.min(100, Number(row.context_percent) || 0)),
    window: clampInt(row.window),
    waiting: on ? row.waiting as 'operator' | 'done' : null,
    blocks: on && row.blocks ? String(row.blocks).slice(0, BLOCKS_CAP) : null,
    waiting_since: on && row.waiting_since ? String(row.waiting_since).slice(0, STAMP_CAP) : null,
    updated_at: String(row.updated_at).slice(0, STAMP_CAP),
    machine: machineLabel(machine),
    repo: repoShaped(row.repo) ? row.repo : null,
    prs: prs.filter(prShaped).slice(0, PRS_CAP),
  }
  // The receiver refuses a line past its cap whole, so the pull requests are dropped from the
  // end of the sorted list until the line fits: the row is sent, with fewer of them.
  while (out.prs.length > 0 && rowText(out).length > ROW_TEXT_CAP) out.prs.pop()
  return out
}

function repoShaped(repo: unknown): repo is string {
  return typeof repo === 'string' && repo.length <= REPO_CAP && REPO_SHAPE.test(repo)
}

function prShaped(pr: unknown): pr is string {
  return typeof pr === 'string' && pr.length <= PR_CAP && PR_SHAPE.test(pr)
}

function clampInt(n: unknown): number {
  const v = Math.floor(Number(n) || 0)
  return Math.max(0, Math.min(NUMBER_CAP, v))
}

// The pull requests in flight of one session, from the ci-watch directory's listing: each
// `<slug>-pr<n>.log` whose owner file (its text, trimmed, in `owners`) names the session,
// unless its `<slug>-pr<n>-base.log` is listed too (the watch found the pull request
// merged). A slug is `owner_name` with the repository's own characters; `here` is the
// repository argument, and none leaves the pull request out. Unique, sorted, cut to the cap.
export function prsInFlight(names: readonly string[], owners: ReadonlyMap<string, string>, sessionId: string, repo: string | null): string[] {
  const listed = new Set(names)
  const found = new Set<string>()
  for (const name of names) {
    const n = watchNumberOf(name)
    if (n === null || owners.get(name) !== sessionId) continue
    const slug = name.slice(0, name.length - `-pr${n}.log`.length)
    if (listed.has(`${slug}-pr${n}-base.log`)) continue
    const pr = prOf(slug, n, repo)
    if (pr !== null) found.add(pr)
  }
  return [...found].sort().slice(0, PRS_CAP)
}

// A slug and a number as `owner/name#<n>`, or null when the slug names no repository: the
// owner is what precedes the first underscore, the name what follows it, underscores and all.
function prOf(slug: string, n: string, repo: string | null): string | null {
  let address: string | null = null
  if (slug === 'here') address = repo
  else if (slug.indexOf('_') > 0) address = slug.replace('_', '/')
  const pr = address === null ? null : `${address}#${n}`
  return prShaped(pr) ? pr : null
}

// Whether this row is news against what was last sent: a new wait (kind or blocks), a new
// repository or pull request list, the fill in another band, or the refresh bound passed.
// Nothing sent yet: news; a record that carries neither repository nor pull requests: news once.
export function rowIsNews(row: RemoteRow, last: RowSent | null, now: number): boolean {
  if (!last) return true
  if (last.band !== bandOf(row.context_percent)) return true
  if ((last.waiting ?? null) !== row.waiting || (last.blocks ?? null) !== row.blocks) return true
  if (last.prs === undefined || (last.repo ?? null) !== row.repo || JSON.stringify(last.prs) !== JSON.stringify(row.prs)) return true
  const at = Date.parse(last.sent_at)
  return !Number.isFinite(at) || now - at >= ROW_REFRESH_MS
}

export function bandOf(percent: number): number {
  return Math.floor(percent / ROW_BAND_PERCENT)
}

export function rowSent(row: RemoteRow, now: number): RowSent {
  return {
    band: bandOf(row.context_percent), waiting: row.waiting, blocks: row.blocks,
    repo: row.repo, prs: row.prs, sent_at: new Date(now).toISOString(),
  }
}

export function parseRowSent(text: string): RowSent | null {
  try {
    const sent = JSON.parse(text) as RowSent
    return sent && typeof sent === 'object' && typeof sent.band === 'number' ? sent : null
  } catch {
    return null
  }
}

export function rowText(row: RemoteRow): string {
  return ROW_MARKER + JSON.stringify(row)
}

// A delivery's text as the receiver reads it: the cross-session envelope the host wraps a
// peer's message in, when there is one — its sender's address and name — and the body
// inside it. No envelope: the text is the body, and the sender is unknown.
export type Delivery = { from: string | null; fromName: string | null; body: string }

const ENVELOPE = /^\s*<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>\s*$/

export function deliveryOf(text: string): Delivery {
  const wrapped = ENVELOPE.exec(text)
  if (!wrapped) return { from: null, fromName: null, body: text }
  const attrs: Record<string, string> = {}
  for (const m of wrapped[1].matchAll(/([A-Za-z][\w-]*)="([^"]*)"/g)) attrs[m[1]] = m[2]
  return { from: attrs['from'] || null, fromName: attrs['from-name'] || null, body: wrapped[2] }
}

// The deliveries a peer sends: another session's message, its model's or its module's.
// A person's own prompt, a relay's webhook or a routine is never read as a row, and
// never teaches a coordinator's address.
export function isPeerOrigin(origin: unknown): boolean {
  const kind = (origin as { kind?: unknown } | null)?.kind
  return kind === 'peer' || kind === 'peer-send-message' || kind === 'unclassified'
}

export function isMarked(body: string): boolean {
  return body.trimStart().startsWith(ROW_MARKER)
}

// The receiver's whole check: the marker, the cap, the exact field set (the twelve, or the
// ten of 0.58 and 0.59 read as no repository and no pull request — one of the two new
// fields alone is refused), each field's type and bounds, an orchestrator's name. Anything
// else is null.
export function parseRemoteRow(body: string): RemoteRow | null {
  const text = body.trim()
  if (!text.startsWith(ROW_MARKER) || text.length > ROW_TEXT_CAP) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(ROW_MARKER.length))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const keys = Object.keys(o)
  const carriesPrs = sameKeys(keys, FIELDS)
  if (!carriesPrs && !sameKeys(keys, OLD_FIELDS)) return null
  const str = (v: unknown, cap: number) => typeof v === 'string' && v.length > 0 && v.length <= cap
  const num = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max
  const stamp = (v: unknown) => str(v, STAMP_CAP) && Number.isFinite(Date.parse(v as string))
  if (!str(o.name, NAME_CAP) || roleOf(o.name as string) !== 'orchestrator' || o.role !== 'orchestrator') return null
  if (!num(o.context_tokens, NUMBER_CAP) || !num(o.window, NUMBER_CAP) || !num(o.context_percent, 100)) return null
  if (!str(o.machine, MACHINE_CAP) || !/^[A-Za-z0-9_-]+$/.test(o.machine as string)) return null
  if (!stamp(o.updated_at)) return null
  if (o.waiting === null) {
    if (o.blocks !== null || o.waiting_since !== null) return null
  } else {
    if (o.waiting !== 'operator' && o.waiting !== 'done') return null
    if (o.blocks !== null && !str(o.blocks, BLOCKS_CAP)) return null
    if (o.waiting_since !== null && !stamp(o.waiting_since)) return null
  }
  if (carriesPrs) {
    if (o.repo !== null && !repoShaped(o.repo)) return null
    if (!Array.isArray(o.prs) || o.prs.length > PRS_CAP || !o.prs.every(prShaped)) return null
  }
  if (/[\u0000-\u001f]/.test(String(o.name) + String(o.blocks ?? ''))) return null
  return {
    ...(o as unknown as RemoteRow),
    repo: carriesPrs ? o.repo as string | null : null,
    prs: carriesPrs ? o.prs as string[] : [],
  }
}

function sameKeys(keys: readonly string[], fields: readonly string[]): boolean {
  return keys.length === fields.length && fields.every(f => keys.includes(f))
}

// A remote row's file under the store: `remote/<the name, sanitised>`.
export function remoteKey(name: string): string {
  return `remote/${name.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

// A remote row as a store row the pane draws: no pid, so it is judged by its stamp alone
// (the store's stale rule), and labelled with the machine it runs on.
export function asSessionRow(row: RemoteRow): SessionRow {
  return {
    role: 'orchestrator', name: row.name, repo: null,
    context_percent: row.context_percent, context_tokens: row.context_tokens, window: row.window,
    model: '', busy: false, updated_at: row.updated_at,
    waiting: row.waiting, blocks: row.blocks, waiting_since: row.waiting_since,
    machine: row.machine,
  }
}

// The local rows with the remote ones added: a remote row whose name a live local row
// carries is dropped (local wins), and so is one past the stale bound — never drawn live.
export function withRemote(local: Record<string, SessionRow>, remote: readonly RemoteRow[], now: number, staleAfterMs: number): Record<string, SessionRow> {
  const names = new Set(Object.values(local).map(row => row.name))
  const rows = { ...local }
  for (const row of remote) {
    if (names.has(row.name) || isRemoteStale(row, now, staleAfterMs)) continue
    rows[remoteKey(row.name)] = asSessionRow(row)
  }
  return rows
}

export function isRemoteStale(row: RemoteRow, now: number, staleAfterMs: number): boolean {
  const at = Date.parse(row.updated_at)
  return !Number.isFinite(at) || now - at > staleAfterMs
}

// The coordinator a session learnt from a peer delivery (`store/coordinator-learnt`): the
// sender's address as the envelope gave it, and its name.
export type LearntCoordinator = { name: string; from: string | null; at: string }

export function learntOf(delivery: Delivery, now: number): LearntCoordinator | null {
  const name = delivery.fromName?.trim() ?? ''
  if (!name || name.length > NAME_CAP || roleOf(name) !== 'coordinator') return null
  const from = delivery.from && delivery.from.length <= 200 && /^(?:uds|bridge):\S+$/.test(delivery.from) ? delivery.from : null
  return { name, from, at: new Date(now).toISOString() }
}

// The successor an orchestrator learnt from its « takeover confirmed » (`store/successors/<id>`):
// its name, its address as the envelope gave it, and its session id when this machine's
// registry names it alone.
export type LearntSuccessor = { name: string; from: string | null; session: string | null; at: string }

// A delivery from an orchestrator whose first line confirms the takeover names the successor;
// anything else names none. The session id is resolved by the caller, which holds the $.
export function successorOf(delivery: Delivery, now: number): LearntSuccessor | null {
  const name = delivery.fromName?.trim() ?? ''
  if (!name || name.length > NAME_CAP || roleOf(name) !== 'orchestrator' || !confirmsTakeover(delivery.body)) return null
  const from = delivery.from && delivery.from.length <= 200 && /^(?:uds|bridge):\S+$/.test(delivery.from) ? delivery.from : null
  return { name, from, session: null, at: new Date(now).toISOString() }
}

export function parseSuccessor(text: string): LearntSuccessor | null {
  try {
    const s = JSON.parse(text) as LearntSuccessor
    return s && typeof s.name === 'string' && roleOf(s.name) === 'orchestrator' && (s.session === null || typeof s.session === 'string') ? s : null
  } catch {
    return null
  }
}

export function parseLearnt(text: string): LearntCoordinator | null {
  try {
    const l = JSON.parse(text) as LearntCoordinator
    return l && typeof l.name === 'string' && roleOf(l.name) === 'coordinator' ? l : null
  } catch {
    return null
  }
}
