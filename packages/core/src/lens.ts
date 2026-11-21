// The review readers' contract (the orchestrator's `orchestrator:lens` agent): the description its
// launcher gives it, which names its lens, pull request and range as facts, and the finding lines it
// answers, `[severity] file:line — claim — evidence`. Each finding has a stable id over its lens,
// file, line and claim, which the orchestrator's module writes at the end of the reader's line, the
// review index carries, and the review's decision on it names. Read by the orchestrator (the ids, the
// decisions) and telemetry (a reader's counts by severity and its ids, at its end). Pure: no node module.

export const LENS_SEVERITIES = ['critical', 'important', 'minor'] as const
export type LensSeverity = (typeof LENS_SEVERITIES)[number]

export interface LensFinding {
  readonly severity: LensSeverity
  readonly file: string
  readonly line: number
  readonly claim: string
}

export interface LensFacts {
  readonly lens: string
  readonly repo: string
  readonly pr: number
  readonly base: string
  readonly head: string
}

/** A head is named by this many characters in a description. */
export const LENS_HEAD_CHARS = 12

const SLUG = /^[a-z0-9][a-z0-9-]{0,29}$/
const DESCRIPTION = /^lens ([a-z0-9][a-z0-9-]{0,29}) ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*) (\S+)\.\.([0-9a-f]{7,40})$/
const FINDING = /^\s*(?:[-*]\s+)?\[(critical|important|minor)\]\s+`?([^\s`:]+):(\d+)(?:[-:]\d+)?`?\s+—\s+(.*)$/i
/*
 * The finding lines real readers write beside the contract's own: the severity bare and followed by a
 * dash, a pipe or a space (`important | file:line | claim`), the line given as `~120` or a range, words
 * between the location and the dash (`file:12 and 14`, `file:12 (symbol)`), a bold severity. The
 * contract's shape is tried first, so a line it reads keeps its reading, and so its id.
 */
const LENIENT = /^\s*(?:[-*]\s+)?\**(?:\[(critical|important|minor)\]|(critical|important|minor)(?=[\s|]))\**\s*\|?\s*`?([^\s`:|()]+):~?(\d+)[^—|\n]*?\s[—|]\s+(.*)$/i
const ID = /\b([a-z0-9][a-z0-9-]{0,29}):([0-9a-f]{10})\b/
const MARK = / — id [a-z0-9][a-z0-9-]{0,29}:[0-9a-f]{10}$/

/** A lens's name as the contract writes it: lower case, its words joined by a dash; undefined when nothing is left. */
export function lensSlug(name: string): string | undefined {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '')
  return SLUG.test(slug) ? slug : undefined
}

/** The description a launcher gives a reader: `lens <lens> <owner/name>#<pr> <base>..<head>`. */
export function lensDescription(facts: LensFacts): string {
  return `lens ${lensSlug(facts.lens) ?? 'review'} ${facts.repo}#${facts.pr} ${facts.base}..${facts.head.slice(0, LENS_HEAD_CHARS).toLowerCase()}`
}

/** The facts a reader's description names, or undefined for a description of another shape. */
export function parseLensDescription(text: string): LensFacts | undefined {
  const m = DESCRIPTION.exec(text.trim())
  if (m === null) return undefined
  return { lens: m[1] ?? '', repo: m[2] ?? '', pr: Number(m[3]), base: m[4] ?? '', head: m[5] ?? '' }
}

/** The finding lines of a reader's answer, in order; a line of another shape is none. */
export function parseLensFindings(text: string): LensFinding[] {
  const found: LensFinding[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(MARK, '')
    const strict = FINDING.exec(line)
    const m = strict ?? LENIENT.exec(line)
    if (m === null) continue
    // The strict form's groups are severity, file, line, claim; the lenient form's severity is in the first or the second.
    const [severity, file, no, rest] = strict === null ? [m[1] ?? m[2], m[3], m[4], m[5]] : [m[1], m[2], m[3], m[4]]
    const claim = (rest ?? '').split(strict === null ? / [—|] / : ' — ')[0]?.trim() ?? ''
    if (claim === '') continue
    found.push({ severity: (severity ?? '').toLowerCase() as LensSeverity, file: file ?? '', line: Number(no), claim })
  }
  return found
}

/** How many findings of each severity. */
export function findingCounts(findings: readonly LensFinding[]): Record<LensSeverity, number> {
  const counts = { critical: 0, important: 0, minor: 0 }
  for (const finding of findings) counts[finding.severity]++
  return counts
}

/** FNV-1a, 64 bits, over the text's UTF-16 code units. */
function fnv64(text: string): bigint {
  let hash = 0xcbf29ce484222325n
  for (let k = 0; k < text.length; k++) {
    hash ^= BigInt(text.charCodeAt(k))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash
}

/** A finding's stable id, `<lens>:<10 hex>`, over its lens, file, line and claim (its case and spacing aside). */
export function findingId(lens: string, file: string, line: number, claim: string): string {
  const slug = lensSlug(lens) ?? 'review'
  const key = [slug, file, String(line), claim.toLowerCase().replace(/\s+/g, ' ').trim()].join('\u0000')
  return `${slug}:${fnv64(key).toString(16).padStart(16, '0').slice(0, 10)}`
}

/** The first finding id a text names, with its lens. */
export function parseFindingId(text: string): { id: string; lens: string } | undefined {
  const m = ID.exec(text)
  return m === null ? undefined : { id: `${m[1]}:${m[2]}`, lens: m[1] ?? '' }
}

/** A reader's answer with ` — id <id>` at the end of each finding line, once; every other line as it came. */
export function withFindingIds(text: string, lens: string): string {
  return text.split('\n').map(raw => {
    const line = raw.replace(MARK, '')
    const [finding] = parseLensFindings(line)
    return finding === undefined ? raw : `${line} — id ${findingId(lens, finding.file, finding.line, finding.claim)}`
  }).join('\n')
}
