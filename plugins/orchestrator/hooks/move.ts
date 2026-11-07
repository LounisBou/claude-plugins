// hooks/move.ts
// An orchestrator's files, carried to another machine. An orchestrator asleep on one machine
// is woken on another: the directory of its brief travels from one session's module to
// another's over the host's peer messages, each one a marked line the receiving module takes
// out of the delivery before any model reads it, as the remote rows do (remote-row.ts). The
// sender announces the files in a manifest — each one's size, hash and chunk count, the
// origin's home and config directory — sends every chunk, then says it has sent; the
// receiver joins each file, checks its hash, rewrites the origin's paths into its own,
// acknowledges it, and asks again for what is missing. Code never travels this way: it goes
// by git. Pure on purpose: the handlers hold the $ and pass their reads in here, and the
// files' hashes are computed by a process, outside this file.

// The line's fixed head: what the receiver keys on, and nothing a person or a model writes by
// chance.
export const MOVE_MARKER = '[module-move] '

// The receiver's cap on one marked message.
export const MOVE_TEXT_CAP = 1_048_576        // a longer marked message is refused whole, never cut

// How much of a file one chunk carries until a live probe measures the largest message that
// crosses (a 2048-character row is known to): the sender takes another size when told.
export const MOVE_CHUNK_DEFAULT = 1536        // data characters per chunk

// No file the host cannot read or write whole travels.
export const MOVE_FILE_CAP = 4 * 1024 * 1024  // the host's file read and write limit

// The most one move carries, its files together and their count: a briefs directory holds a
// few hundred kilobytes, and a move past either cap is refused before anything is sent.
export const MOVE_TOTAL_CAP = 16 * 1024 * 1024
export const MOVE_FILES_CAP = 512

// The chunks a move's files take together: the receiver lists what is missing chunk by chunk,
// and a file may claim up to one chunk per byte, so the bytes alone bound nothing useful.
export const MOVE_CHUNKS_CAP = 32_768          // chunks summed over a manifest's files

// No timer: the sender resends what a « missing » answer names, this many answers per move at
// most, then reports the failure. The same send repeated resumes the same move.
export const MOVE_MISSING_ROUNDS = 3

// What a move carries of the orchestrator: the sleeping record's fields, the remote of its
// directory, and the operator's order. Paths are the origin machine's.
export type MoveRecord = {
  name: string                 // "Orch : <subject>", no [ref]
  brief: string                // absolute, origin machine
  dir: string                  // absolute, origin machine
  model: string
  effort: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  prs: string[]
  checkouts: string[]          // absolute, origin machine; code travels by git
  git: { url: string; branch: string } | null   // dir's origin remote and branch; null when dir is no checkout
  order: string                // the operator's order, verbatim and dated
}
export type Origin = { machine: string; home: string; configDir: string }
export type ManifestFile = { name: string; bytes: number; sha256: string; chunks: number }  // name: a base name in dirname(brief)

// A move's messages, one marked line each: the sender's manifest, chunks and « sent »; the
// receiver's acknowledgment of each file, its « missing » list and its « done »; and the
// probe that measures the largest message crossing between two machines, with its answer.
export type MoveMessage =
  | { kind: 'manifest'; move: string; origin: Origin; record: MoveRecord; files: ManifestFile[] }
  | { kind: 'chunk'; move: string; file: number; index: number; data: string }
  | { kind: 'sent'; move: string }
  | { kind: 'ack'; move: string; file: number; ok: boolean; reason: string | null }
  | { kind: 'missing'; move: string; chunks: [number, number][] }
  | { kind: 'done'; move: string; ok: boolean; brief: string | null; reason: string | null }
  | { kind: 'probe'; move: string; size: number; data: string }
  | { kind: 'probe-ack'; move: string; size: number; received: number }

// The exact field set of each kind, and of each object a manifest holds.
const FIELDS: Record<MoveMessage['kind'], readonly string[]> = {
  manifest: ['kind', 'move', 'origin', 'record', 'files'],
  chunk: ['kind', 'move', 'file', 'index', 'data'],
  sent: ['kind', 'move'],
  ack: ['kind', 'move', 'file', 'ok', 'reason'],
  missing: ['kind', 'move', 'chunks'],
  done: ['kind', 'move', 'ok', 'brief', 'reason'],
  probe: ['kind', 'move', 'size', 'data'],
  'probe-ack': ['kind', 'move', 'size', 'received'],
}
const KINDS = Object.keys(FIELDS)
const ORIGIN_FIELDS = ['machine', 'home', 'configDir']
const RECORD_FIELDS = ['name', 'brief', 'dir', 'model', 'effort', 'prs', 'checkouts', 'git', 'order']
const GIT_FIELDS = ['url', 'branch']
const FILE_FIELDS = ['name', 'bytes', 'sha256', 'chunks']

// A move's id, as moveIdOf writes it: it names the move's files in the receiver's store, and
// its subject slug, the id without its hash, names the briefs directory the move lands in.
const MOVE_ID_SHAPE = /^[a-z0-9-]{1,40}-[0-9a-f]{12}$/
const MOVE_ID_HASH = /-[0-9a-f]{12}$/
const SLUG_CAP = 40
const SLUG_FALLBACK = 'move'

// The name the launcher's opening takes and the sleeping record keeps: `Orch : `, a subject of
// at most 25 characters with no space at either end, and no reference after it.
const NAME_SHAPE = /^Orch : \S(?:.{0,23}\S)?$/
const REF_SUFFIX = / \[[0-9A-Za-z]+\]$/

// What the opening command cannot carry between double quotes, nor any line: a quote, a
// dollar, a backtick, a backslash, a control character, a line or paragraph separator, and
// the invisible or direction-changing format characters that make a text read otherwise than
// it runs. Refused in every name and path.
const UNQUOTABLE = /["$`\\\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/
const CONTROL = /[\u0000-\u001f\u007f]/
// The order keeps its line breaks and tabs: it travels verbatim.
const ORDER_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

// A model identifier, with the host's bracketed variant suffix; an effort the launcher knows.
const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(?:\[[A-Za-z0-9]{1,16}\])?$/
const EFFORTS: readonly unknown[] = ['', 'low', 'medium', 'high', 'xhigh', 'max']

// The machine's label, as the remote rows carry it.
const MACHINE_SHAPE = /^[A-Za-z0-9_-]{1,64}$/

// A remote git clones from, and a branch it checks out: a web, ssh or git address, or the
// scp form `user@host:path`. The user and the host of every form start with a letter or a
// digit, so nothing reads as an option, and no space or other transport gets through, since
// a model hands both to git.
const GIT_URL_SHAPE = new RegExp('^(?:'
  + '(?:https?|ssh|git)://(?:[A-Za-z0-9][A-Za-z0-9._~%+=,:-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~:/@%+=,-]*)?'
  + '|[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._~/@%+=,-]+'
  + ')$')
const BRANCH_SHAPE = /^[A-Za-z0-9._+][A-Za-z0-9._/+-]{0,254}$/

// A file's name: one plain base name, so it is written beside the brief and nowhere else.
const FILE_NAME_SHAPE = /^[A-Za-z0-9._-]+$/
const SHA256_SHAPE = /^[0-9a-f]{64}$/

// The receiver's caps on the record's fields: a message past one is refused whole.
const PATH_CAP = 1024
const FILE_NAME_CAP = 255
const PR_CAP = 200
const PRS_CAP = 50
const CHECKOUTS_CAP = 50
const ORDER_CAP = 4000
const REASON_CAP = 2048

// The longest sender's name the arrival notice quotes: a longer one is no session's name, and
// a fixed label stands in its place.
const FROM_NAME_CAP = 120

export function moveText(message: MoveMessage): string {
  return MOVE_MARKER + JSON.stringify(message)
}

export function isMoveMarked(body: string): boolean {
  return body.trimStart().startsWith(MOVE_MARKER)
}

// The receiver's whole check: the marker, the cap, the exact field set of the message's kind
// and of every object inside it, each field's type and bounds. Anything else is null. What a
// manifest's paths mean on the receiving machine is arrivalOf's to judge, with a reason the
// sender is told.
export function parseMoveMessage(body: string): MoveMessage | null {
  const text = body.trim()
  if (!text.startsWith(MOVE_MARKER) || text.length > MOVE_TEXT_CAP) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(MOVE_MARKER.length))
  } catch {
    return null
  }
  if (!isObject(raw) || typeof raw.kind !== 'string' || !KINDS.includes(raw.kind)) return null
  if (!exactly(raw, FIELDS[raw.kind as MoveMessage['kind']])) return null
  if (typeof raw.move !== 'string' || !MOVE_ID_SHAPE.test(raw.move)) return null
  return kindShaped(raw) ? raw as MoveMessage : null
}

function kindShaped(o: Record<string, unknown>): boolean {
  switch (o.kind) {
    case 'manifest': return originShaped(o.origin) && recordShaped(o.record) && filesShaped(o.files)
    case 'chunk': return fileNumber(o.file) && whole(o.index, 0, MOVE_FILE_CAP - 1) && typeof o.data === 'string'
    case 'sent': return true
    case 'ack': return fileNumber(o.file) && typeof o.ok === 'boolean' && (o.ok ? o.reason === null : reasonShaped(o.reason))
    case 'missing': return Array.isArray(o.chunks) && o.chunks.length > 0 && o.chunks.every(pairShaped)
    case 'done':
      if (typeof o.ok !== 'boolean') return false
      return o.ok ? absolute(o.brief) && o.reason === null : (o.brief === null || absolute(o.brief)) && reasonShaped(o.reason)
    case 'probe': return whole(o.size, 1, MOVE_TEXT_CAP) && typeof o.data === 'string'
    case 'probe-ack': return whole(o.size, 1, MOVE_TEXT_CAP) && whole(o.received, 0, MOVE_TEXT_CAP)
  }
  return false
}

function originShaped(v: unknown): boolean {
  return isObject(v) && exactly(v, ORIGIN_FIELDS) && typeof v.machine === 'string' && MACHINE_SHAPE.test(v.machine)
    && homeShaped(v.home) && homeShaped(v.configDir)
}

function recordShaped(v: unknown): boolean {
  if (!isObject(v) || !exactly(v, RECORD_FIELDS)) return false
  if (typeof v.name !== 'string' || !NAME_SHAPE.test(v.name) || REF_SUFFIX.test(v.name) || UNQUOTABLE.test(v.name)) return false
  if (!absolute(v.brief) || !absolute(v.dir)) return false
  if (typeof v.model !== 'string' || !MODEL_SHAPE.test(v.model) || !EFFORTS.includes(v.effort)) return false
  if (!Array.isArray(v.prs) || v.prs.length > PRS_CAP || !v.prs.every(prShaped)) return false
  if (!Array.isArray(v.checkouts) || v.checkouts.length > CHECKOUTS_CAP || !v.checkouts.every(absolute)) return false
  return gitShaped(v.git) && typeof v.order === 'string' && v.order.length > 0 && v.order.length <= ORDER_CAP && !ORDER_CONTROL.test(v.order)
}

function gitShaped(v: unknown): boolean {
  if (v === null) return true
  return isObject(v) && exactly(v, GIT_FIELDS) && typeof v.url === 'string' && v.url.length <= PATH_CAP && GIT_URL_SHAPE.test(v.url)
    && typeof v.branch === 'string' && BRANCH_SHAPE.test(v.branch)
}

// Each file's types and bounds — no more chunks than bytes, since a chunk is never empty but
// for an empty file's one — then the manifest's own checks.
function filesShaped(v: unknown): boolean {
  return Array.isArray(v) && v.every(fileShaped) && checkManifestFiles(v as ManifestFile[]) === null
}

function fileShaped(f: unknown): boolean {
  return isObject(f) && exactly(f, FILE_FIELDS) && typeof f.name === 'string' && f.name.length <= FILE_NAME_CAP
    && typeof f.sha256 === 'string' && whole(f.bytes, 0, MOVE_FILE_CAP) && whole(f.chunks, 1, Math.max(1, f.bytes as number))
}

function pairShaped(p: unknown): boolean {
  return Array.isArray(p) && p.length === 2 && fileNumber(p[0]) && whole(p[1], 0, MOVE_FILE_CAP - 1)
}

function fileNumber(v: unknown): boolean {
  return whole(v, 0, MOVE_FILES_CAP - 1)
}

function whole(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

// An absolute path the opening command can carry; a home or config directory is no root.
function absolute(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('/') && v.length <= PATH_CAP && !UNQUOTABLE.test(v)
}

function homeShaped(v: unknown): boolean {
  return absolute(v) && trimSlashes(v) !== ''
}

function prShaped(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= PR_CAP && !CONTROL.test(v)
}

function reasonShaped(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= REASON_CAP && !CONTROL.test(v)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function exactly(o: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(o)
  return keys.length === fields.length && fields.every(f => keys.includes(f))
}

function trimSlashes(path: string): string {
  return path.replace(/\/+$/, '')
}

// The text's slices, at most `size` UTF-16 units each, a surrogate pair never cut: a slice
// that would end on a pair's high half ends before it, and at size one the pair is the
// slice. An empty text is one empty chunk, so every file has at least one.
export function chunkText(text: string, size: number): string[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunkText: the size must be a whole number of at least 1, got ${size}`)
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + size, text.length)
    if (end < text.length && isHighHalf(text.charCodeAt(end - 1)) && isLowHalf(text.charCodeAt(end))) {
      end = end - 1 > start ? end - 1 : end + 1
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks.length > 0 ? chunks : ['']
}

function isHighHalf(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}

function isLowHalf(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

// The move's id: the same record and files give the same id, so a send repeated resumes the
// move it repeats. The hash runs over the fields in a fixed order, never over the objects'
// own key order.
export function moveIdOf(record: MoveRecord, files: ManifestFile[]): string {
  const canonical = JSON.stringify([
    record.name, record.brief, record.dir, record.model, record.effort, record.prs, record.checkouts,
    record.git ? [record.git.url, record.git.branch] : null, record.order,
    files.map(f => [f.name, f.bytes, f.sha256, f.chunks]),
  ])
  return `${slugOf(record.name)}-${hex48(canonical)}`
}

// The subject after the role's prefix, accents folded, every other run of characters a dash.
function slugOf(name: string): string {
  const subject = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
  const slug = subject.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, SLUG_CAP).replace(/-+$/, '')
  return slug || SLUG_FALLBACK
}

// FNV-1a over the text's UTF-16 units, 64 bits wide, its top 48 bits as twelve hex digits:
// an id, not a proof, so no cryptographic hash is needed.
const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK_64 = (1n << 64n) - 1n

function hex48(text: string): string {
  let hash = FNV_OFFSET
  for (let i = 0; i < text.length; i++) hash = ((hash ^ BigInt(text.charCodeAt(i))) * FNV_PRIME) & MASK_64
  return (hash >> 16n).toString(16).padStart(12, '0')
}

// The manifest's files against the caps and the shapes: null when they hold, else the first
// reason found. A name is checked before anything else of its file, so a reason only ever
// quotes a name of the plain shape.
export function checkManifestFiles(files: ManifestFile[]): string | null {
  if (files.length === 0) return 'no file to move'
  if (files.length > MOVE_FILES_CAP) return `${files.length} files, more than ${MOVE_FILES_CAP}`
  // Names compared lower-cased: a case-insensitive file system writes both to one file.
  const seen = new Set<string>()
  let total = 0
  let chunks = 0
  for (const [i, f] of files.entries()) {
    if (!FILE_NAME_SHAPE.test(f.name) || f.name === '.' || f.name === '..') return `file ${i}: its name is no plain base name`
    if (seen.has(f.name.toLowerCase())) return `${f.name}: a duplicate name`
    seen.add(f.name.toLowerCase())
    if (!(f.bytes <= MOVE_FILE_CAP)) return `${f.name}: ${f.bytes} bytes, more than ${MOVE_FILE_CAP}`
    if (!SHA256_SHAPE.test(f.sha256)) return `${f.name}: its sha256 is not 64 lowercase hex digits`
    if (!(f.chunks >= 1)) return `${f.name}: ${f.chunks} chunks, fewer than one`
    total += f.bytes
    chunks += f.chunks
  }
  if (total > MOVE_TOTAL_CAP) return `${total} bytes in all, more than ${MOVE_TOTAL_CAP}`
  if (chunks > MOVE_CHUNKS_CAP) return `${chunks} chunks in all, more than ${MOVE_CHUNKS_CAP}`
  return null
}

// The origin's paths in a text, rewritten into the target's: every place an origin heads a
// path — at the text's start or after any character a path cannot hold, and ending before a
// slash, at the end, or before any character a name cannot hold. The longest origin that
// matches wins at each place; a longer name that merely starts the same, or a longer path
// that holds the origin after another directory, is left alone. One pass, so a path the
// rewrite wrote is never rewritten.
export function rewritePaths(text: string, pairs: readonly (readonly [from: string, to: string])[]): string {
  const longest = pairs.map(([origin, target]) => [trimSlashes(origin), trimSlashes(target)])
    .filter(([origin]) => origin !== '')
    .sort((a, b) => b[0].length - a[0].length)
  if (longest.length === 0) return text
  const pattern = new RegExp(`(?<![A-Za-z0-9._/~-])(?:${longest.map(([origin]) => escapeRegExp(origin)).join('|')})(?![A-Za-z0-9._-])`, 'g')
  return text.replace(pattern, match => longest.find(([origin]) => origin === match)![1])
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Where a move lands on the receiving machine: the briefs directory that takes every file, the
// brief in it, and the record's paths rewritten.
export type Arrival = { briefDir: string; brief: string; dir: string; checkouts: string[] }

// The arrival, or the reason the move is refused. The move's id is the one its record and
// files give. Every file lands in the target's own briefs directory, named after the move's
// subject, whatever path the origin gave: a manifest says what it carries, never where it is
// written. The brief is one of the files, and the directory and the checkouts are the
// record's, rewritten onto the target, strictly under its home and with no '..'.
export function arrivalOf(manifest: Extract<MoveMessage, { kind: 'manifest' }>, target: { home: string; configDir: string }): Arrival | { refused: string } {
  const { record } = manifest
  if (manifest.move !== moveIdOf(record, manifest.files)) return { refused: `the move id ${manifest.move} is not the one its record and files give` }
  if (!record.brief.startsWith('/')) return { refused: `the brief is no absolute path: ${record.brief}` }
  if (record.brief.endsWith('/')) return { refused: `the brief names a directory, not a file: ${record.brief}` }
  const name = record.brief.slice(record.brief.lastIndexOf('/') + 1)
  if (!manifest.files.some(f => f.name === name)) return { refused: `the brief ${name} is not among the files` }
  const home = trimSlashes(target.home)
  if (home === '') return { refused: 'the target\'s home is empty or the root' }
  const briefDir = `${trimSlashes(target.configDir)}/claude-orchestrator/briefs/${manifest.move.replace(MOVE_ID_HASH, '')}`
  const pairs = pairsOf(manifest, briefDir, target)
  const dir = rewritePaths(record.dir, pairs)
  const checkouts = record.checkouts.map(path => rewritePaths(path, pairs))
  const refusal = [pathRefusal('directory', dir, home), ...checkouts.map(path => pathRefusal('checkout', path, home))].find(r => r !== null)
  if (refusal) return { refused: refusal }
  const files = checkManifestFiles(manifest.files)
  if (files !== null) return { refused: files }
  return { briefDir, brief: `${briefDir}/${name}`, dir, checkouts }
}

// Why a rewritten directory or checkout cannot be the arrival's, or null when it can: the
// launcher opens a session in the one and git reads the other, so neither leaves the home.
function pathRefusal(label: string, path: string, home: string): string | null {
  if (path.split('/').includes('..')) return `the ${label} ${path} climbs with '..'`
  if (!trimSlashes(path).startsWith(`${home}/`)) return `the ${label} ${path} is not strictly under ${home}`
  return null
}

// The pairs rewritePaths applies at arrival, to every arriving file and to the record's paths:
// the brief's directory onto the arrival's, the config directory, then the home. The longest
// origin that matches wins wherever several do, whatever their order here.
export function arrivalPairs(manifest: Extract<MoveMessage, { kind: 'manifest' }>, arrival: Arrival, target: { home: string; configDir: string }): [string, string][] {
  return pairsOf(manifest, arrival.briefDir, target)
}

function pairsOf(manifest: Extract<MoveMessage, { kind: 'manifest' }>, briefDir: string, target: { home: string; configDir: string }): [string, string][] {
  const { record, origin } = manifest
  return [[record.brief.slice(0, record.brief.lastIndexOf('/')) || '/', briefDir], [origin.configDir, target.configDir], [origin.home, target.home]]
}

// What the receiver asks for again: every chunk it does not hold, of every file not yet
// acknowledged, file then index.
export function missingOf(files: ManifestFile[], have: ReadonlySet<string>, acked: readonly boolean[]): [number, number][] {
  const missing: [number, number][] = []
  files.forEach((f, file) => {
    if (acked[file]) return
    for (let index = 0; index < f.chunks; index++) if (!have.has(`${file}:${index}`)) missing.push([file, index])
  })
  return missing
}

// What the receiver's model reads once every file is in: the moved orchestrator's facts, the
// operator's order as it was given, and the launcher's opening in full, last, to be run as it
// is. Its paths are the arrival's, on this machine. Every free-text value is a JSON string, so
// none can open a line of its own and pass for the module.
export function arrivedNotice(manifest: Extract<MoveMessage, { kind: 'manifest' }>, arrival: Arrival, fromName: string, launcher: string): string {
  const { name, model, effort, prs, git, order } = manifest.record
  const count = manifest.files.length
  const from = fromName.length <= FROM_NAME_CAP ? literal(fromName) : `a sender whose name runs past ${FROM_NAME_CAP} characters`
  return [
    `[module] ${name} arrived from ${literal(manifest.origin.machine)}, sent by ${from}: its ${count} ${count === 1 ? 'file is' : 'files are'} written in ${arrival.briefDir}.`,
    `brief: ${arrival.brief}`,
    `dir: ${arrival.dir}`,
    `git: ${git ? `${literal(git.url)}, branch ${literal(git.branch)}, as the sender reports it` : 'none, its directory is no checkout'}`,
    `model: ${model}, effort ${effort || 'default'}`,
    `pull requests: ${prs.length > 0 ? prs.map(literal).join(', ') : 'none'}`,
    `the operator's order, verbatim: ${literal(order)}`,
    'Open it as the order says, with this command alone and nothing before it:',
    `${launcher} spawn --open --title "${name}" --dir ${shellWord(arrival.dir)} --permission-mode auto --model ${shellWord(model)}${effort ? ` --effort ${effort}` : ''} --prompt "Read and execute ${arrival.brief}"`,
  ].join('\n')
}

// A value the opening command carries outside quotes: as it is when the shell reads it as one
// plain word, single-quoted otherwise (a directory with a space, a model's variant suffix).
function shellWord(value: string): string {
  return /^[A-Za-z0-9._/:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

// A free-text value as a JSON string literal, on one line: JSON escapes the C0 controls, and
// the line breaks it keeps as they are (NEL, the line and paragraph separators) are escaped
// here.
function literal(text: string): string {
  return JSON.stringify(text).replace(/[\u0085\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

// What the sender's model reads when the receiver acknowledged every file.
export function acknowledgedNotice(record: MoveRecord, to: string, brief: string): string {
  return `[module] ${record.name} moved to ${to}: every file arrived and was acknowledged, its brief there is ${brief}. Its files here are left as they were.`
}

// What the sender's model reads when the move failed: the receiver's reason, or its own, as a
// JSON string.
export function failedNotice(record: MoveRecord, to: string, reason: string): string {
  return `[module] ${record.name} was not moved to ${to}, its files here are left as they were: ${literal(reason)}`
}
