// dispatch-record — one row per dispatch, and the signal the routing rule needs. Its subcommands,
// what each records and refuses, and why, are documented in the header of dispatch-record.sh, the
// launcher every caller runs.
//
// Every write of the record, the registry and the exemption goes through core's store: a lock,
// one rename, no temporary file left behind. The session-name shape is core's (names.ts).
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLES, parseSessionName, type Prefix } from '../../../core/names.ts'
import { configDir, setting, stateDir, type Env } from '../../../core/paths.ts'
import { readText, update, writeAtomic } from '../../../core/store.ts'
import { isEntry, processIo, run, type Io, type Run } from './lib/process.ts'
import { goalsFileOf, ownerFileOf } from './lib/record-paths.ts'

export const USAGE =
  'usage: dispatch-record.sh {open|round|review|fixed|surface|audit|ready|exempt|close|defer|undefer|escaped|cost|summary|goals} <record> [...] (see header)'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// A waiver or an exemption is the operator's words with their date, or it is nobody's.
const DATED = /[0-9]{4}-[0-9]{2}-[0-9]{2}/
const WRITES = new Set(['open', 'round', 'review', 'fixed', 'surface', 'audit', 'ready', 'exempt', 'close', 'defer', 'undefer', 'escaped', 'cost'])
const GOAL_WRITES = new Set(['init', 'plan', 'met', 'rule-out', 'defer', 'reopen'])
const GOAL_SUBS = ['init', 'status', 'plan', 'met', 'rule-out', 'defer', 'reopen', 'check']

/** The command is over, with this exit code; what it had to say is already said. */
export class Exit {
  readonly code: number

  constructor(code: number) {
    this.code = code
  }
}

export interface Deps {
  readonly io: Io
  readonly env: Env
  /** Runs `gh` and `python3`; `stderr: 'inherit'` passes their own messages through. */
  readonly run: Run
  /** Runs a child on this process's own streams and returns its exit status (`goals`). */
  readonly passThrough: (argv: readonly [string, ...string[]]) => Promise<number>
  readonly now: () => Date
  readonly goalsPy: string
  readonly routingPy: string
}

export type Row = Record<string, unknown>

// ----- values read the way jq reads them -----

/** jq's truthiness: everything but null and false (and a key that is absent). */
const truthy = (value: unknown): boolean => value !== undefined && value !== null && value !== false

/** `a // b`. */
const or = <T>(value: unknown, fallback: T): unknown => (truthy(value) ? value : fallback)

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row)[key] : undefined

/** A value as `jq -r` prints it, and as `\(…)` interpolates it. */
export function text(value: unknown): string {
  if (typeof value === 'string') return value
  return value === undefined ? 'null' : JSON.stringify(value)
}

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asNumber = (value: unknown): number => (typeof value === 'number' ? value : 0)

/** jq's order of values, enough for the keys a summary sorts on: null, booleans, numbers, strings. */
export function order(a: unknown, b: unknown): number {
  const rank = (v: unknown): number => (v === undefined || v === null ? 0 : v === false ? 1 : v === true ? 2 : typeof v === 'number' ? 3 : typeof v === 'string' ? 4 : Array.isArray(v) ? 5 : 6)
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  return 0
}

/** jq's `round`, half away from zero. */
const round = (n: number): number => Math.sign(n) * Math.round(Math.abs(n))
const tenth = (n: number): number => round(n * 10) / 10

/** jq's `a + b` on the strings and nulls a key is built of. */
const plus = (...parts: unknown[]): string => parts.map(p => (p === undefined || p === null ? '' : text(p))).join('')

/** `group_by(f)`: groups in the order of their keys, rows in their own order within one. */
export function groupBy<T>(rows: readonly T[], key: (row: T) => unknown): T[][] {
  const groups: { key: unknown; rows: T[] }[] = []
  for (const row of rows) {
    const k = key(row)
    const group = groups.find(g => order(g.key, k) === 0 && text(g.key) === text(k))
    if (group === undefined) groups.push({ key: k, rows: [row] })
    else group.rows.push(row)
  }
  return groups.sort((a, b) => order(a.key, b.key)).map(g => g.rows)
}

// ----- the record -----

/** The rows of a record's text, one JSON object per line; throws on a line that is none. */
export function parseRecord(content: string): Row[] {
  return content.split('\n').filter(line => line.trim() !== '').map(line => {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('a record line that is no object')
    return value as Row
  })
}

const serialize = (rows: readonly Row[]): string => rows.map(row => `${JSON.stringify(row)}\n`).join('')

/** A row id as `--argjson` reads it: a JSON number, else no id of any row. */
export function parseId(id: string): number | undefined {
  try {
    const value: unknown = JSON.parse(id)
    return typeof value === 'number' ? value : undefined
  } catch {
    return undefined
  }
}

/** The next row id: one above the highest. */
export function nextId(rows: readonly Row[]): number {
  return rows.length === 0 ? 1 : Math.max(...rows.map(row => asNumber(row['id']))) + 1
}

// ----- the session's orchestration -----

const ORCH: Prefix = (Object.keys(ROLES) as Prefix[]).find(prefix => ROLES[prefix] === 'orchestrator') ?? 'Orch'

/**
 * A session name in the house shape: blanks and the ` [reference]` the host appends left off, a
 * hand-typed « Orch: x » spelled « Orch : x ». The shape itself is core's (names.ts): a name it
 * does not read as an orchestrator's stays as it was given.
 */
export function orchForm(raw: string): string {
  const name = raw.replace(/^\s+/, '').replace(/\s+$/, '').replace(/ \[[^\]\s]+\]$/, '').replace(/\s+$/, '')
  const typed = new RegExp(`^${ORCH} ?: *(\\S.*)$`, 's').exec(name)
  if (typed?.[1] !== undefined) {
    const canonical = `${ORCH} : ${typed[1]}`
    if (parseSessionName(canonical)?.role === 'orchestrator') return canonical
  }
  return name
}

/** Whether a name in the house shape is an orchestration's. */
const isOrchestration = (name: string): boolean => parseSessionName(name)?.role === 'orchestrator'

/**
 * The orchestration this session belongs to, as the host's record of the session names it
 * (`<config dir>/sessions/<pid>.json`, the newest record carrying this session id). Empty for a
 * shell outside any session, a session the host kept no record of, and one that is no orchestrator.
 */
export function sessionOrchestration(env: Env): string {
  const session = setting(env, 'CLAUDE_CODE_SESSION_ID')
  if (session === undefined) return ''
  const dir = join(configDir(env, setting(env, 'HOME')), 'sessions')
  let names: string[]
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.json')).sort()
  } catch {
    return ''
  }
  let newest: { at: string; name: string } | undefined
  for (const file of names) {
    let value: unknown
    try {
      if (!statSync(join(dir, file)).isFile()) continue
      value = JSON.parse(readText(join(dir, file)) ?? '')
    } catch {
      continue
    }
    const name = field(value, 'name')
    if (field(value, 'sessionId') !== session || typeof name !== 'string') continue
    const at = text(or(field(value, 'updatedAt'), 0))
    // As `[ newest -ge line ]`: a reading that is no integer never keeps the earlier one.
    const integer = /^-?[0-9]+$/
    if (newest !== undefined && integer.test(newest.at) && integer.test(at) && BigInt(newest.at) >= BigInt(at)) continue
    newest = { at, name }
  }
  if (newest === undefined) return ''
  const name = orchForm(newest.name)
  return isOrchestration(name) ? name : ''
}

/** The first line of a file, '' when it cannot be read. */
function firstLine(path: string): string {
  try {
    return (readText(path) ?? '').split('\n')[0] ?? ''
  } catch {
    return ''
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Creates `path` holding `content` only when nothing is there: of two first writers, one claim
 * stands. The content is written beside it first and linked into place, so the file is never
 * seen empty: another writer that read an empty owner file would take it over.
 */
function createOnly(path: string, content: string): boolean {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    const fd = openSync(tmp, 'wx', 0o644)
    try {
      writeSync(fd, content)
    } finally {
      closeSync(fd)
    }
    linkSync(tmp, path)
    return true
  } catch {
    return false
  } finally {
    rmSync(tmp, { force: true })
  }
}

// ----- Markdown, minus its code -----

/** The length of the run of `ch` at `i` (0-based). */
function runOf(s: string, i: number, ch: string): number {
  let j = i
  while (s.charAt(j) === ch) j++
  return j - i
}

/** A line without its inline code spans, each replaced by a blank; an unmatched run stays literal. */
function stripSpans(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    // A backtick preceded by a backslash is an escaped literal, and opens no span.
    if (s.charAt(i) !== '`' || (i > 0 && s.charAt(i - 1) === '\\')) {
      out += s.charAt(i)
      i++
      continue
    }
    const n = runOf(s, i, '`')
    let k = i + n
    let found = false
    while (k < s.length) {
      if (s.charAt(k) === '`') {
        const m = runOf(s, k, '`')
        if (m === n) {
          found = true
          break
        }
        k += m
      } else k++
    }
    if (found) {
      out += ' '
      i = k + n
    } else {
      out += s.slice(i, i + n)
      i += n
    }
  }
  return out
}

/**
 * The text minus what Markdown renders as code: fenced blocks (``` or ~~~, closed by a fence of
 * the same character at least as long, or by the end of the text) and inline code spans. Indented
 * code blocks are not handled, nor a fence inside a list item or a blockquote, nor a code span
 * running over two lines: an `<img` in those still counts.
 */
export function withoutCode(markdown: string): string[] {
  const out: string[] = []
  let fence: { ch: string; len: number } | undefined
  for (const line of markdown.split('\n')) {
    const t = line.replace(/^ ? ? ?/, '')
    const c = t.charAt(0)
    if (fence !== undefined) {
      const n = runOf(t, 0, fence.ch)
      if (c === fence.ch && n >= fence.len && /^[ \t\r]*$/.test(t.slice(n))) fence = undefined
      continue
    }
    if (c === '`' || c === '~') {
      const n = runOf(t, 0, c)
      if (n >= 3 && !(c === '`' && t.slice(n).includes('`'))) {
        fence = { ch: c, len: n }
        continue
      }
    }
    out.push(stripSpans(line))
  }
  return out
}

/** The images a pull request's description carries: Markdown ones and HTML ones, code left out. */
export function countShots(body: string): number {
  const image = /!\[[^\]\n]*\]\([^)\n]+\)|<img[ \t\r\v\f]/gi
  return withoutCode(body).reduce((n, line) => n + (line.match(image)?.length ?? 0), 0)
}

// ----- the command -----

interface Context {
  readonly cmd: string
  readonly record: string
  readonly deps: Deps
  readonly goalsFile: string
  readonly ownerFile: string
  readonly exemptFile: string
  writing: boolean
  claimed: boolean
  registerAbsent: boolean
}

function die(ctx: Context, message: string): never {
  ctx.deps.io.err(`ERROR: ${message}\n`)
  throw new Exit(1)
}

const warn = (ctx: Context, message: string): void => ctx.deps.io.err(`WARNING: ${message}\n`)
const say = (ctx: Context, line: string): void => ctx.deps.io.out(`${line}\n`)
const stamp = (ctx: Context): string => ctx.deps.now().toISOString().replace(/\.[0-9]{3}Z$/, 'Z')

function readRows(ctx: Context): Row[] {
  try {
    return parseRecord(readText(ctx.record) ?? '')
  } catch {
    return die(ctx, `could not read ${ctx.record}`)
  }
}

/** The row `id` names, after `requireRow` said there is exactly one. */
function rowOf(ctx: Context, id: string): Row {
  const n = parseId(id)
  return readRows(ctx).find(row => row['id'] === n) ?? {}
}

function requireRow(ctx: Context, sub: string, id: string): void {
  if (!isFile(ctx.record)) die(ctx, `${sub}: no such record: ${ctx.record}`)
  const n = parseId(id)
  if (n === undefined || readRows(ctx).filter(row => row['id'] === n).length !== 1) die(ctx, `${sub}: no row with id ${id} in ${ctx.record}`)
}

/**
 * Rewriting the whole file keeps ONE row per dispatch: a record appending an event per round would
 * make every read a reduction over history, and the history is not the fact. Under the record's
 * lock, in one rename.
 */
function rewrite(ctx: Context, id: string, change: (row: Row) => void): void {
  const n = parseId(id)
  try {
    update(ctx.record, current => {
      const rows = parseRecord(current ?? '')
      for (const row of rows) if (row['id'] === n) change(row)
      return serialize(rows)
    })
  } catch {
    die(ctx, `could not update ${ctx.record}`)
  }
}

/** The options of a subcommand: each flag in `valued` takes the next word, each in `bare` none. */
function options(ctx: Context, sub: string, args: readonly string[], valued: readonly string[], bare: readonly string[] = []): [string, string][] {
  const found: [string, string][] = []
  for (let k = 0; k < args.length; k++) {
    const flag = args[k] ?? ''
    if (bare.includes(flag)) found.push([flag, ''])
    else if (valued.includes(flag)) found.push([flag, args[++k] ?? ''])
    else die(ctx, `${sub}: unknown option ${flag}`)
  }
  return found
}

const last = (found: readonly [string, string][], flag: string): string => found.filter(([f]) => f === flag).at(-1)?.[1] ?? ''

/** Either side may abbreviate the other; the shorter one must still identify a commit. */
function sameCommit(ctx: Context, a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.length < 7) die(ctx, `ready: head ${short} is too short to identify a commit (7 characters at least)`)
  return long.startsWith(short)
}

/**
 * A write is refused when the record belongs to another orchestration: rows and goals are read
 * back by the stop gate as the session's own, and a session made to answer for another's work
 * ends on a question that is not its own. Outside any session (the operator's own shell) a write
 * is accepted; inside one, only the owner's.
 */
function guardOwner(ctx: Context): void {
  if (setting(ctx.deps.env, 'CLAUDE_CODE_SESSION_ID') !== undefined) {
    const me = sessionOrchestration(ctx.deps.env)
    let owner = orchForm(firstLine(ctx.ownerFile))
    if (owner === '' && me !== '' && isDir(dirname(ctx.record))) {
      // No owner yet, or an empty file: claim now, before the write, so of two first writers one
      // claim stands and the other reads the winner back and is refused.
      if (createOnly(ctx.ownerFile, `${me}\n`)) ctx.claimed = true
      else if (!nonEmpty(ctx.ownerFile)) {
        try {
          writeAtomic(ctx.ownerFile, `${me}\n`, 0o644)
          ctx.claimed = true
        } catch {
          // Unclaimed: the owner read below decides.
        }
      }
      owner = orchForm(firstLine(ctx.ownerFile))
    }
    if (owner !== '' && me !== owner) {
      die(ctx, `${ctx.cmd}: ${ctx.record} belongs to ${owner}, and this session is ${me || 'no orchestration it can tell'}: a record belongs to one orchestration, so open your own beside your briefs and hand ${owner} the work by message`)
    }
  }
  ctx.writing = true
}

function nonEmpty(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

/** Whether this session belongs to the orchestration that owns the record: the owner's successor too. */
function readsOwnRecord(ctx: Context): boolean {
  if (!isFile(ctx.ownerFile)) return false
  const owner = orchForm(firstLine(ctx.ownerFile))
  return owner !== '' && sessionOrchestration(ctx.deps.env) === owner
}

const recordThere = (ctx: Context): boolean => isFile(ctx.record) || (ctx.registerAbsent && isDir(dirname(ctx.record)))

/**
 * A write registers the record under the session, and so does a read by its owner (a successor
 * taking over reads it first); a read by anyone else leaves the register alone, so a summary never
 * makes a session answer for rows it did not write. Never fails the command.
 */
function registerRecord(ctx: Context): void {
  if (!ctx.writing && !readsOwnRecord(ctx)) return
  const session = setting(ctx.deps.env, 'CLAUDE_CODE_SESSION_ID')
  if (session === undefined || !recordThere(ctx)) return
  try {
    const abs = join(realpathSync(dirname(ctx.record)), basename(ctx.record))
    const list = join(stateRoot(ctx.deps.env), 'records', session.replace(/[^A-Za-z0-9._-]/g, '_'))
    update(list, current => {
      const text = current ?? ''
      return text.split('\n').includes(abs) ? text : `${text}${abs}\n`
    })
  } catch {
    // Registering never fails a command.
  }
}

/** The first write that succeeds names the record's owner; the file is created or left alone. */
function claimRecord(ctx: Context): void {
  if (!ctx.writing || existsSync(ctx.ownerFile) || !recordThere(ctx)) return
  const me = sessionOrchestration(ctx.deps.env)
  if (me !== '') createOnly(ctx.ownerFile, `${me}\n`)
}

/** On every exit: a failed write gives back the claim it made; the record is registered, then claimed. */
function finish(ctx: Context, code: number): void {
  if (code !== 0 && ctx.claimed && orchForm(firstLine(ctx.ownerFile)) === sessionOrchestration(ctx.deps.env)) rmSync(ctx.ownerFile, { force: true })
  registerRecord(ctx)
  if (code === 0) claimRecord(ctx)
}

/**
 * The stop gate's state root, the one the module's gate resolves too: the override first, else the
 * config dir's claude-orchestrator, so the registry the gate reads and this script writes agree.
 */
export function stateRoot(env: Env): string {
  return setting(env, 'ORCHESTRATOR_STATE_DIR') ?? stateDir('claude-orchestrator', env, setting(env, 'HOME'))
}

async function open(ctx: Context, args: readonly string[]): Promise<void> {
  const found = options(ctx, 'open', args, ['--class', '--tier', '--model', '--effort', '--label'], ['--cascade', '--explore'])
  const klass = last(found, '--class')
  const tier = last(found, '--tier')
  const model = last(found, '--model')
  const effort = last(found, '--effort')
  const label = last(found, '--label')
  // A deliberate bet one tier below the table's row, or one notch below the class's pair: marked,
  // so the summary tells an economy from a cost on the row itself.
  const cascade = found.some(([f]) => f === '--cascade')
  const explore = found.some(([f]) => f === '--explore')
  if (klass === '') die(ctx, 'open: --class is required')
  if (tier === '' && model === '') die(ctx, 'open: --tier or --model is required')
  if (tier !== '' && !['deep', 'standard', 'light'].includes(tier)) die(ctx, `open: unknown tier: ${tier} (expected deep, standard or light)`)
  if (effort !== '' && !EFFORTS.includes(effort)) die(ctx, `open: unknown effort: ${effort} (expected low, medium, high, xhigh or max)`)
  if (effort !== '' && model === '') die(ctx, 'open: --effort needs --model')
  if (explore && model === '') die(ctx, 'open: --explore needs --model')
  // The spec's goals are written before the first dispatch, or done is measured against the plan alone.
  if (!isFile(ctx.goalsFile)) die(ctx, `open: no goals.md beside ${ctx.record}: write the spec's goals first, dispatch-record.sh goals ${ctx.record} init --spec <path>|none`)
  const unplanned = (await ctx.deps.run(['python3', ctx.deps.goalsPy, 'unplanned', ctx.goalsFile])).stdout.split('\n').filter(g => g !== '')
  for (const goal of unplanned) warn(ctx, `${goal} is in no phase and not ruled out: plan it or put it to the operator`)
  if (unplanned.length > 0) warn(ctx, (await ctx.deps.run(['python3', ctx.deps.goalsPy, 'line', ctx.goalsFile])).stdout.replace(/\n+$/, ''))
  let id = 0
  try {
    update(ctx.record, current => {
      const content = current ?? ''
      id = nextId(parseRecord(content))
      const row: Row = { id, opened: stamp(ctx), class: klass, tier, label, rounds: 0, state: 'open', verdict: '', cascade }
      if (model !== '') Object.assign(row, { model, effort, explore, cost_usd: 0, sessions: [], cost_incomplete: false })
      return `${content}${content === '' || content.endsWith('\n') ? '' : '\n'}${JSON.stringify(row)}\n`
    })
  } catch {
    die(ctx, `could not update ${ctx.record}`)
  }
  say(ctx, String(id))
}

function review(ctx: Context, id: string, args: readonly string[]): void {
  const found = options(ctx, 'review', args, ['--head', '--norms'])
  const head = last(found, '--head')
  const norms = last(found, '--norms')
  if (head === '') die(ctx, 'review: --head is required')
  // `tool` or `none`, and nothing else: `none` is a fact about the PROJECT - it ships no norms
  // check - never a round's verdict that reading the file by hand was enough.
  if (norms === '') die(ctx, 'review: --norms is required (tool when the project\'s norms check ran, none when it ships none)')
  if (norms !== 'tool' && norms !== 'none') die(ctx, `review: unknown norms value: ${norms} (expected tool, or none when the project ships no norms check)`)
  // Only the LAST review is kept: the question `ready` asks is about the head in front of it now.
  const at = stamp(ctx)
  rewrite(ctx, id, row => {
    row['rounds'] = asNumber(row['rounds']) + 1
    row['review'] = { head, norms, at }
  })
}

function fixed(ctx: Context, id: string, args: readonly string[]): void {
  const head = last(options(ctx, 'fixed', args, ['--head']), '--head')
  if (head === '') die(ctx, 'fixed: --head is required')
  const row = rowOf(ctx, id)
  if (text(or(field(row['review'], 'head'), '')) === '') warn(ctx, `fixed: row ${id} has no review recorded: the correction round should answer a review round, recording it anyway`)
  const previous = text(or(field(field(row['review'], 'fixed'), 'head'), ''))
  if (previous !== '') warn(ctx, `fixed: row ${id} already has its correction round at ${previous}: recording a second one anyway`)
  const at = stamp(ctx)
  rewrite(ctx, id, r => {
    r['rounds'] = asNumber(r['rounds']) + 1
    const reviewed = field(r, 'review')
    const object = typeof reviewed === 'object' && reviewed !== null && !Array.isArray(reviewed) ? (reviewed as Row) : {}
    object['fixed'] = { head, at }
    r['review'] = object
  })
}

function surface(ctx: Context, id: string, args: readonly string[]): void {
  let kind = ''
  let pr = ''
  let reason = ''
  for (let k = 0; k < args.length; k++) {
    const flag = args[k] ?? ''
    if (flag !== '--ui' && flag !== '--minor' && flag !== '--none') die(ctx, `surface: unknown option ${flag}`)
    if (kind !== '') die(ctx, 'surface: give one of --ui, --minor or --none')
    if (flag === '--ui') [kind, pr] = ['ui', args[++k] ?? '']
    else if (flag === '--minor') [kind, reason] = ['minor', args[++k] ?? '']
    else kind = 'none'
  }
  if (kind === '') die(ctx, 'surface: give one of --ui <owner/repo>#<n>, --minor <reason> or --none')
  if (kind === 'ui' && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[0-9]+$/.test(pr)) die(ctx, `surface: --ui takes the pull request as <owner/repo>#<number>, got: ${pr || 'nothing'}`)
  if (kind === 'minor' && reason === '') die(ctx, 'surface: --minor needs the reason the operator will read')
  const at = stamp(ctx)
  rewrite(ctx, id, row => { row['surface'] = { kind, pr, reason, at } })
}

function audit(ctx: Context, id: string, args: readonly string[]): void {
  let head = ''
  let images = ''
  const defects: string[] = []
  for (let k = 0; k < args.length; k++) {
    const flag = args[k] ?? ''
    const value = args[k + 1] ?? ''
    if (flag === '--head') head = value
    else if (flag === '--images') images = value
    else if (flag === '--defect') {
      if (value === '') die(ctx, 'audit: --defect needs the defect, as the operator will read it')
      defects.push(value)
    } else die(ctx, `audit: unknown option ${flag}`)
    k++
  }
  if (head === '') die(ctx, 'audit: --head is required')
  if (head.length < 7) die(ctx, `audit: head ${head} is too short to identify a commit (7 characters at least)`)
  if (!/^[1-9][0-9]*$/.test(images)) die(ctx, `audit: --images takes the number of images the screenshots agent audited, got: ${images || 'nothing'}`)
  const at = stamp(ctx)
  rewrite(ctx, id, row => { row['audit'] = { head, images: Number(images), defects, at } })
}

const E2E_SHAPE = '`--e2e "E2E: <test path(s)> — <command> — passed"` or `--e2e "E2E: none — <reason>"`'

async function ready(ctx: Context, id: string, args: readonly string[]): Promise<void> {
  const found = options(ctx, 'ready', args, ['--head', '--e2e', '--e2e-waiver'])
  const head = last(found, '--head')
  const e2eGiven = found.some(([f]) => f === '--e2e')
  const e2e = last(found, '--e2e')
  const waiver = last(found, '--e2e-waiver')
  if (head === '') die(ctx, 'ready: --head is required')
  const row = rowOf(ctx, id)
  const reviewed = text(or(field(row['review'], 'head'), ''))
  const fixedHead = text(or(field(field(row['review'], 'fixed'), 'head'), ''))
  // The surface first, before any reading of the heads: a pull request with no screenshot is not
  // ready whatever was reviewed, and the no-review warning below must not let it by.
  const surfaceOf = row['surface']
  const kind = text(or(field(surfaceOf, 'kind'), ''))
  const pr = text(field(surfaceOf, 'pr'))
  let surfaceLine = ''
  if (kind === '') die(ctx, `ready: row ${id} does not say whether its pull request changes a frontend surface: record it with \`surface\` (--ui <owner/repo>#<n>, --minor <reason> or --none)`)
  if (kind === 'ui') {
    const at = pr.lastIndexOf('#')
    const read = await ctx.deps.run(['gh', 'pr', 'view', pr.slice(at + 1), '-R', at === -1 ? pr : pr.slice(0, at), '--json', 'body', '-q', '.body'])
    if (read.status !== 0) die(ctx, `ready: could not read the description of ${pr}: its screenshots are unverified, not ready`)
    // A markdown image or an HTML one, which is what an uploaded attachment becomes; code is text.
    const shots = countShots(read.stdout.replace(/\n+$/, ''))
    if (shots === 0) die(ctx, `ready: ${pr} changes a frontend surface and its description carries no screenshot: not ready`)
    // Counted is not looked at: the screenshots agent's audit of every image, at a head the rules
    // below accept, with no defect seen.
    const recorded = row['audit']
    if (!truthy(recorded)) die(ctx, `ready: no audit of the images on ${pr} is recorded: the screenshots agent audits each one, and the audit is recorded with \`audit <record> ${id} --head <sha> --images <n>\`: not ready`)
    const aHead = text(field(recorded, 'head'))
    const aImages = asNumber(field(recorded, 'images'))
    if (![head, reviewed, fixedHead].some(h => h !== '' && sameCommit(ctx, aHead, h))) {
      die(ctx, `ready: the images on ${pr} were audited at ${aHead}, head is ${head}: audit them again at the head in front of you`)
    }
    if (aImages < shots) die(ctx, `ready: the audit covers ${aImages} image(s), the description of ${pr} carries ${shots}: audit every image`)
    const defects = asList(field(recorded, 'defects'))
    if (defects.length > 0) die(ctx, `ready: the audit of ${pr} recorded ${defects.length} defect(s): ${defects.map(text).join('; ')}. Fix each one, retake the capture, and audit again: not ready`)
    surfaceLine = `${shots} screenshot(s) on ${pr}, audited clean at ${aHead}`
  } else if (kind === 'minor') {
    surfaceLine = `frontend change ruled minor: ${text(field(surfaceOf, 'reason'))} - tell the operator this reason with the ready`
  } else if (kind === 'none') {
    surfaceLine = 'no frontend surface'
  }
  // The E2E line, on every row, after the surface and before the heads, so that neither the
  // no-review warning nor a reviewed head lets a pull request through on silence.
  if (!e2eGiven) die(ctx, `ready: row ${id} gives no E2E line: pass the implementer's report line, ${E2E_SHAPE}; silence is not ready`)
  if (!/^E2E:\s*\S/.test(e2e)) die(ctx, `ready: the E2E line must start with \`E2E:\` and say something, got: ${e2e || 'nothing'}; ${E2E_SHAPE}`)
  let e2eKind = 'test'
  let exemptWords = ''
  let e2eLine = e2e
  if (/^E2E:\s*none([^\p{L}\p{N}]|$)/iu.test(e2e)) {
    e2eKind = 'none'
    if (!/^E2E:\s*none\s*[—–:-]\s*\S/iu.test(e2e)) die(ctx, 'ready: `E2E: none` needs its reason: `E2E: none — <reason>`')
  }
  if (e2eKind === 'none') {
    if (isFile(ctx.exemptFile)) {
      try {
        exemptWords = text(or(field(JSON.parse(readText(ctx.exemptFile) ?? ''), 'words'), ''))
      } catch {
        exemptWords = ''
      }
    }
    if (waiver !== '') {
      if (!DATED.test(waiver)) die(ctx, `ready: --e2e-waiver takes the operator's words with their date (YYYY-MM-DD), got: ${waiver}`)
      e2eLine = `${e2e} (the operator validated it ready without E2E: ${waiver})`
    } else if (exemptWords !== '') {
      e2eLine = `${e2e} (this session's pull requests exempted from E2E by the operator: ${exemptWords})`
    } else {
      die(ctx, `ready: row ${id} has no E2E test and the operator has not validated it ready without one: tell him « ${e2e} », then record his validation with --e2e-waiver "<his words, dated>": not ready`)
    }
  } else if (waiver !== '') {
    die(ctx, `ready: --e2e-waiver is for a pull request with no E2E test, and this line names one: ${e2e}`)
  }
  // The github ready gate needs a review at the head; a row no review has touched is not ready.
  if (reviewed === '') die(ctx, `ready: no review recorded on row ${id}: dispatch a review round and record it with \`review\`: not ready`)
  const at = stamp(ctx)
  rewrite(ctx, id, r => { r['e2e'] = { line: e2e, kind: e2eKind, waiver, exempt: exemptWords, head, at } })
  surfaceLine = `${surfaceLine}; ${e2eLine}`
  // The label is the orchestrator's to put, with the github tool, in the same move as its ready:
  // this prints the command and calls nothing.
  const hash = pr.lastIndexOf('#')
  const labelCmd = kind === 'ui' ? `pr-readiness ${pr.slice(hash + 1)} ready on ${hash === -1 ? pr : pr.slice(0, hash)}` : 'pr-readiness <n> ready on <owner/repo>'
  const norms = text(or(field(row['review'], 'norms'), ''))
  if (sameCommit(ctx, reviewed, head)) {
    say(ctx, `ready: row ${id} reviewed at ${head}, norms check ${norms}; ${surfaceLine}`)
    say(ctx, labelCmd)
  } else if (fixedHead !== '' && sameCommit(ctx, fixedHead, head)) {
    say(ctx, `ready: row ${id} reviewed at ${reviewed}, corrected and verified at ${head}, norms check ${norms}; ${surfaceLine}`)
    say(ctx, labelCmd)
  } else if (fixedHead !== '') {
    die(ctx, `ready: last review read ${reviewed}, its correction ${fixedHead}, head is ${head}: the head in front of you has been neither read nor verified`)
  } else {
    die(ctx, `ready: last review read ${reviewed}, head is ${head}: the head in front of you has not been read`)
  }
}

function exempt(ctx: Context, args: readonly string[]): void {
  const words = last(options(ctx, 'exempt', args, ['--e2e']), '--e2e')
  if (words === '') die(ctx, 'exempt: --e2e "<the operator\'s words, dated>" is required')
  if (!DATED.test(words)) die(ctx, `exempt: --e2e takes the operator's words with their date (YYYY-MM-DD), got: ${words}`)
  if (!isFile(ctx.record)) die(ctx, `exempt: no such record: ${ctx.record}`)
  try {
    writeAtomic(ctx.exemptFile, `${JSON.stringify({ words, at: stamp(ctx) })}\n`)
  } catch {
    die(ctx, `exempt: could not write ${ctx.exemptFile}`)
  }
  say(ctx, `exempt: every pull request of this session's record is exempted from E2E: ${words}`)
}

async function cost(ctx: Context, id: string, args: readonly string[]): Promise<void> {
  const found = options(ctx, 'cost', args, ['--session'], ['--recount'])
  const session = last(found, '--session')
  // A row written before the `unpriced` list, incomplete with a figure already counted, cannot say
  // which of its sessions was the unpriced one: the caller names it.
  const force = found.some(([f]) => f === '--recount')
  if (session === '') die(ctx, 'cost: --session is required')
  const row = rowOf(ctx, id)
  const sessions = asList(or(row['sessions'], []))
  const legacyUnpriced = row['unpriced'] === undefined || row['unpriced'] === null
  // A session counted while its model had no price is counted again once it has one; a session
  // counted with a figure is never counted twice.
  let recount = !sessions.includes(session) ? 'new'
    : asList(or(row['unpriced'], [])).includes(session) ? 'recount'
    : legacyUnpriced && row['cost_incomplete'] === true && or(row['cost_usd'], 0) === 0 ? 'recount'
    : 'counted'
  if (force) {
    if (!(legacyUnpriced && row['cost_incomplete'] === true && sessions.includes(session))) {
      die(ctx, `cost: --recount is for a row written before the unpriced list, incomplete, that counts session ${session}; row ${id} is not one`)
    }
    recount = 'named'
  }
  if (recount === 'counted') {
    warn(ctx, `cost: session ${session} is already counted on row ${id} (a row written before the unpriced list takes --recount naming its unpriced session)`)
    return
  }
  const alias = text(or(row['model'], ''))
  const measured = await ctx.deps.run(['python3', ctx.deps.routingPy, 'cost', '--session', session, ...(alias === '' ? [] : ['--alias', alias]), '--json'], { stderr: 'inherit' })
  if (measured.status !== 0) die(ctx, `cost: could not measure session ${session}`)
  let usd: unknown
  try {
    usd = or(field(JSON.parse(measured.stdout), 'cost_usd'), null)
  } catch {
    die(ctx, `could not update ${ctx.record}`)
  }
  if (usd !== null && typeof usd !== 'number') die(ctx, `could not update ${ctx.record}`)
  if (usd === null) warn(ctx, `cost: session ${session} has an unpriced model: row ${id} is marked cost_incomplete`)
  rewrite(ctx, id, r => {
    // The legacy reading (incomplete, nothing counted, no list) names every counted session
    // unpriced, so the list is seeded from the sessions on the first recount; --recount names it.
    const seeded = recount === 'named' ? [session]
      : asList(or(r['unpriced'], r['cost_incomplete'] === true && or(r['cost_usd'], 0) === 0 ? asList(or(r['sessions'], [])) : []))
    r['unpriced'] = seeded
    r['sessions'] = [...asList(or(r['sessions'], [])).filter(s => s !== session), session]
    const others = seeded.filter(s => s !== session)
    if (usd === null) {
      r['unpriced'] = [...others, session]
      r['cost_incomplete'] = true
    } else {
      r['unpriced'] = others
      r['cost_usd'] = asNumber(or(r['cost_usd'], 0)) + usd
      r['cost_incomplete'] = others.length > 0
    }
  })
  say(ctx, `cost: row ${id} +${text(usd)} (session ${session})`)
}

/** A row still open, as a successor reads it: deferred with the ruling it waits on, or open. */
export function openLine(row: Row): string {
  return truthy(row['deferred'])
    ? `deferred=${text(row['id'])} label=${text(row['label'])} ruling=${text(row['deferred'])}`
    : `open=${text(row['id'])} label=${text(row['label'])}`
}

const isOpen = (row: Row): boolean => row['state'] === 'open'

/** A row's group: its pair when it has one, its tier otherwise, so tier rows read as they did. */
export function keyOf(row: Row): string {
  if (truthy(row['model'])) {
    const effort = text(or(row['effort'], ''))
    return plus('pair=', row['model'], '/', effort === '' ? 'default' : effort)
  }
  return plus('tier=', row['tier'])
}

const bare = (key: string): string => key.replace(/^(tier|pair)=/, '')

interface Group {
  readonly klass: unknown
  readonly key: string
  readonly rows: Row[]
}

function groups(rows: readonly Row[]): Group[] {
  return groupBy(rows, row => plus(row['class'], ' ', keyOf(row)))
    .map(g => ({ klass: g[0]?.['class'], key: keyOf(g[0] ?? {}), rows: g }))
    .sort((a, b) => order(a.klass, b.klass) || order(a.key, b.key))
}

/** The statistics of a record: per class and key, escapes, cascades, explorations, then the open rows. */
export function summaryLines(rows: readonly Row[]): string[] {
  const lines: string[] = []
  const all = groups(rows).map(g => {
    const n = g.rows.length
    const avg = n === 0 ? 0 : g.rows.reduce((sum, row) => sum + asNumber(row['rounds']), 0) / n
    const costs = g.rows.filter(row => row['state'] === 'closed' && !truthy(row['cost_incomplete']) && asNumber(or(row['cost_usd'], 0)) > 0).map(row => asNumber(row['cost_usd']))
    return { ...g, n, avg, costs, closed: g.rows.filter(row => row['state'] === 'closed').length }
  })
  for (const g of all) {
    const costAvg = g.costs.length > 0 ? ` cost_avg=${round((g.costs.reduce((a, b) => a + b, 0) / g.costs.length) * 10000) / 10000}` : ''
    lines.push(`class=${text(g.klass)} ${g.key} dispatches=${g.n} closed=${g.closed} rounds_avg=${tenth(g.avg)}${costAvg}`)
  }
  for (const g of all.filter(g => g.avg > 1)) lines.push(`signal=${text(g.klass)} at ${bare(g.key)} averages ${tenth(g.avg)} rounds: the drop did not pay, revert it for this class`)
  const escapes = groups(rows.filter(row => row['escaped'] === true))
  for (const g of escapes) lines.push(`escapes=${text(g.klass)} at ${bare(g.key)}: ${g.rows.length} of ${g.rows.length} approved rows had a defect found later`)
  for (const g of escapes) lines.push(`signal=double-read ${text(g.klass)} at ${bare(g.key)}: an approval missed a defect. Give the next round a SECOND reader with a different lens, and keep a finding only when both see it`)
  // A cascade pays when it closes in one round: the attempt cost nothing beyond itself. Below
  // half, the retries cost more than the tier they saved, which is the whole test.
  const cascades = groups(rows.filter(row => row['cascade'] === true)).map(g => ({ ...g, paid: g.rows.filter(row => row['rounds'] === 0).length }))
  for (const g of cascades) lines.push(`cascade=${text(g.klass)} at ${bare(g.key)}: ${g.paid} of ${g.rows.length} paid`)
  for (const g of cascades.filter(g => g.rows.length >= 2 && g.paid * 2 < g.rows.length)) {
    lines.push(`signal=stop cascading ${text(g.klass)} at ${bare(g.key)}: ${g.paid} of ${g.rows.length} paid, the retries cost more than the tier saved`)
  }
  // Exploration: one that cost a corrective round or let a defect escape freezes its class for
  // the build; three that closed in one round promote the lower pair.
  const explored = groupBy(rows.filter(row => row['explore'] === true && row['state'] === 'closed'), row => row['class'])
  const costly = (row: Row): boolean => asNumber(row['rounds']) > 1 || row['escaped'] === true
  for (const g of explored.filter(g => g.some(costly))) lines.push(`frozen=${text(g[0]?.['class'])}`)
  for (const g of explored.filter(g => !g.some(costly))) {
    for (const pair of groupBy(g, keyOf).filter(p => p.length >= 3)) lines.push(`promote=${text(pair[0]?.['class'])} ${keyOf(pair[0] ?? {}).replace(/^pair=/, '')}`)
  }
  // The rows still open are work: deferred, in flight, or lost. A successor reads them as such.
  lines.push(...rows.filter(isOpen).map(openLine))
  return lines
}

function summary(ctx: Context, args: readonly string[]): void {
  let onlyOpen = false
  let idsOnly = false
  let labelIds = ''
  for (let k = 0; k < args.length; k++) {
    const flag = args[k] ?? ''
    if (flag === '--open') onlyOpen = true
    else if (flag === '--ids') idsOnly = true
    else if (flag === '--label') {
      const value = args[k + 1] ?? ''
      if (!/^[0-9]+(,[0-9]+)*$/.test(value)) die(ctx, 'summary: --label needs the row ids, comma-separated (--label 3,7)')
      labelIds = value
      k++
    } else die(ctx, `summary: unknown argument ${flag} (expected --open, --ids or --label <id>[,<id>...])`)
  }
  if ((idsOnly || labelIds !== '') && !onlyOpen) die(ctx, 'summary: --ids and --label read the open rows: add --open')
  if (idsOnly && labelIds !== '') die(ctx, 'summary: --ids and --label are two readings: run one, then the other')
  if (!isFile(ctx.record)) {
    say(ctx, `dispatch-record: no record at ${ctx.record}`)
    return
  }
  const rows = readRows(ctx)
  const open = rows.filter(isOpen)
  if (idsOnly) {
    say(ctx, `open=${open.filter(row => !truthy(row['deferred'])).length}`)
    say(ctx, `deferred=${open.filter(row => truthy(row['deferred'])).length}`)
    say(ctx, `ids: ${open.map(row => text(row['id'])).join(' ')}`)
    return
  }
  if (labelIds !== '') {
    const ids = labelIds.split(',').map(Number)
    for (const row of rows.filter(row => ids.includes(asNumber(row['id'])) && typeof row['id'] === 'number' && isOpen(row))) say(ctx, openLine(row))
    // A row asked for that is closed or absent is a stale hand-over: said, never printed.
    for (const gone of ids.filter(i => !open.some(row => row['id'] === i))) warn(ctx, `summary: row ${gone} is not open in ${ctx.record}`)
    return
  }
  for (const line of onlyOpen ? open.map(openLine) : summaryLines(rows)) say(ctx, line)
}

async function goals(ctx: Context, args: readonly string[]): Promise<void> {
  const sub = args[0] ?? ''
  if (sub === '') die(ctx, 'goals: a subcommand is required (init, status, plan, met, rule-out, defer, reopen or check)')
  if (!GOAL_SUBS.includes(sub)) die(ctx, `goals: unknown subcommand: ${sub} (expected init, status, plan, met, rule-out, defer, reopen or check)`)
  ctx.registerAbsent = true
  if (sub === 'init') mkdirSync(dirname(ctx.record), { recursive: true })
  throw new Exit(await ctx.deps.passThrough(['python3', ctx.deps.goalsPy, sub, ctx.goalsFile, ...args.slice(1)]))
}

/** Rows that change by one fixed step. */
const STEPS: Readonly<Record<string, (row: Row) => void>> = {
  round: row => { row['rounds'] = asNumber(row['rounds']) + 1 },
  undefer: row => { delete row['deferred'] },
  escaped: row => { row['escaped'] = true },
}

async function dispatch(ctx: Context, argv: readonly string[]): Promise<void> {
  const { cmd } = ctx
  if (WRITES.has(cmd) || (cmd === 'goals' && GOAL_WRITES.has(argv[2] ?? ''))) guardOwner(ctx)
  const rest = argv.slice(2)
  if (cmd === 'open') return open(ctx, rest)
  if (cmd === 'exempt') return exempt(ctx, rest)
  if (cmd === 'summary') return summary(ctx, rest)
  if (cmd === 'goals') return goals(ctx, rest)
  if (!WRITES.has(cmd)) die(ctx, `unknown subcommand: ${cmd} (expected open, round, review, fixed, surface, audit, ready, exempt, close, defer, undefer, escaped, cost, summary or goals)`)
  const id = argv[2] ?? ''
  if (id === '') die(ctx, `${cmd}: a row id is required`)
  requireRow(ctx, cmd, id)
  const args = argv.slice(3)
  const step = STEPS[cmd]
  if (step !== undefined) return rewrite(ctx, id, step)
  if (cmd === 'review') return review(ctx, id, args)
  if (cmd === 'fixed') return fixed(ctx, id, args)
  if (cmd === 'surface') return surface(ctx, id, args)
  if (cmd === 'audit') return audit(ctx, id, args)
  if (cmd === 'ready') return ready(ctx, id, args)
  if (cmd === 'cost') return cost(ctx, id, args)
  if (cmd === 'close') {
    const verdict = last(options(ctx, 'close', args, ['--verdict']), '--verdict')
    if (verdict === '') die(ctx, 'close: --verdict is required')
    const closed = stamp(ctx)
    return rewrite(ctx, id, row => Object.assign(row, { state: 'closed', verdict, closed }))
  }
  // defer: the operator ruled « later » on an open row: it stays open, with his words.
  if (rowOf(ctx, id)['state'] !== 'open') die(ctx, `defer: row ${id} is not open`)
  const ruling = last(options(ctx, 'defer', args, ['--ruling']), '--ruling')
  if (ruling.replace(/\s/g, '') === '') die(ctx, 'defer: --ruling "<the operator\'s words, dated>" is required')
  return rewrite(ctx, id, row => { row['deferred'] = ruling })
}

/** Runs `argv`; returns the exit code. */
export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const cmd = argv[0] ?? ''
  const record = argv[1] ?? ''
  if (cmd === '') {
    deps.io.err(`ERROR: ${USAGE}\n`)
    return 1
  }
  if (record === '') {
    deps.io.err(`ERROR: ${cmd}: a record path is required\n`)
    return 1
  }
  const ctx: Context = {
    cmd, record, deps,
    goalsFile: goalsFileOf(record),
    ownerFile: ownerFileOf(record),
    exemptFile: `${record}.e2e-exempt`,
    writing: false, claimed: false, registerAbsent: false,
  }
  let code = 0
  try {
    await dispatch(ctx, argv)
  } catch (error) {
    if (!(error instanceof Exit)) throw error
    code = error.code
  }
  finish(ctx, code)
  return code
}

/* node:coverage ignore next 15 */
if (isEntry(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url))
  const { spawn } = await import('node:child_process')
  process.exitCode = await main(process.argv.slice(2), {
    io: processIo,
    env: process.env,
    run,
    passThrough: ([command, ...args]) => new Promise(done => {
      spawn(command, args, { stdio: 'inherit' }).on('error', () => done(127)).on('close', status => done(status ?? 1))
    }),
    now: () => new Date(),
    goalsPy: join(here, 'goals.py'),
    routingPy: resolve(here, '../../model-routing/scripts/routing.py'),
  })
}
