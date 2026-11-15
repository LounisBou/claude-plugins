// goals — the spec's goals of one build, one file, read by the stop gate.
//
//   goals.sh init      <goals.md> --spec <path>|none [--aim "<text>"] [--goal "<text>"]... [--repo <dir>] [--replace]
//   goals.sh status    <goals.md>
//   goals.sh line      <goals.md>
//   goals.sh unplanned <goals.md>
//   goals.sh plan      <goals.md> <G> --phase "<text>"
//   goals.sh met       <goals.md> <G> --evidence "<token>"...
//   goals.sh rule-out  <goals.md> <G> --ruling "<the operator's words>"
//   goals.sh defer     <goals.md> <G> --ruling "<the operator's words>"
//   goals.sh reopen    <goals.md> <G>
//   goals.sh check     <goals.md> [--json]
//
// Run through `dispatch-record.sh goals <record> <subcommand> ...`, which names the file beside
// the record (`<record's directory>/goals.md`) and registers the record under the session.
//
// Why it exists: a build was declared done against its plan while three of its spec's five goals
// had been moved « after the build » by the plan itself. The spec's goals live here, once, with
// their status: `open`, `met` (with evidence a local read can verify), `ruled-out` (with the
// operator's own words), or `deferred` (open work the operator put off, with his words: the goal
// stays unmet, and the stop gate takes the ending `waiting: deferred`). The file's format is
// `lib/goals-file.ts`.
//
// The grammar, checked here and nowhere else:
// - `met` needs at least one token a local read verifies: a path (absolute, `~/`, or relative to
//   `repo:`) that exists, or `commit:<sha>` that git resolves in `repo:`. `pr:#<n>` and
//   `run:<cmd>` may stand beside those, never alone: no network is read at a stop. Tokens are
//   `;`-separated, and every path or commit token must verify.
// - `ruled-out` and `deferred` need `operator: « <his words> »`, not empty.
// - An `open` goal with an empty `plan` is in no phase: `unplanned`.
// - With `spec:` a path whose `## Goals` lists numbered items, the rows match those items one for
//   one, each goal's text equal to one item's after whitespace is collapsed, and `aim:` appears
//   verbatim in the spec. A spec that has moved skips that match, and says so.
//
// `check` exits 0 when every goal holds, 1 when one is held (open, deferred, or a fault), 2 when
// the file cannot be read. `--json` prints `{ok, open, deferred, unplanned, faults, notes, rows,
// met, ruled_out, aim, spec, table}` for the stop gate. Any other refusal is one `ERROR:` line on
// stderr and exit 1.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { getSystemErrorMap } from 'node:util'
import {
  collapse, GoalsFault, goalsTable, parseGoals, renderGoals, STATUSES,
  type GoalRow, type GoalsFile, type GoalsHead,
} from './lib/goals-file.ts'
import { isEntry, processIo, type Io } from './lib/process.ts'

/** How long one git call is given. */
export const GIT_MS = 5_000

const RULING = /^operator:\s*«\s*([\s\S]*?)\s*»\s*$/

/** The end of the command: its exit code, the reason already written. */
class Exit {
  readonly code: number

  constructor(code: number) {
    this.code = code
  }
}

interface Context {
  readonly io: Io
  readonly env: NodeJS.ProcessEnv
}

function die(ctx: Context, message: string): never {
  ctx.io.err(`ERROR: ${message}\n`)
  throw new Exit(1)
}

function say(ctx: Context, line: string): void {
  ctx.io.out(`${line}\n`)
}

/** `~` and `~/…` under the home directory; any other path as given. */
export function expandUser(path: string, env: NodeJS.ProcessEnv): string {
  if (path !== '~' && !path.startsWith('~/')) return path
  return (env['HOME'] || homedir()) + path.slice(1)
}

/** The system's words for a failed read, as the C library spells them (libuv words otherwise). */
function strerror(error: unknown): string {
  const errno = error instanceof Error && 'errno' in error && typeof error.errno === 'number' ? error.errno : undefined
  const [name, words] = errno === undefined ? [] : getSystemErrorMap().get(errno) ?? []
  if (name === 'EISDIR') return 'Is a directory'
  return words === undefined ? String(error) : words.charAt(0).toUpperCase() + words.slice(1)
}

// --- the spec ----------------------------------------------------------------------------------

/** The lines under the `## <title>` heading, up to the next heading of level 1 or 2; null without it. */
export function section(text: string, title: string): string[] | null {
  const heading = new RegExp(`^##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i')
  const out: string[] = []
  let inside = false
  for (const line of text.split('\n')) {
    if (/^#{1,2}\s/.test(line)) {
      if (inside) break
      inside = heading.test(line)
      continue
    }
    if (inside) out.push(line)
  }
  return inside ? out : null
}

/** The numbered items under the spec's `## Goals`, each collapsed; null without one. */
export function specGoals(text: string): string[] | null {
  const lines = section(text, 'Goals')
  if (lines === null) return null
  const items: string[] = []
  let current: string | null = null
  for (const line of lines) {
    const item = /^\s{0,3}\d+[.)]\s+(.*)$/s.exec(line)
    if (item) {
      if (current !== null) items.push(collapse(current))
      current = item[1] ?? ''
    } else if (current !== null && line.trim() !== '' && (line.startsWith(' ') || line.startsWith('\t'))) {
      current += ` ${line.trim()}`
    } else if (current !== null && line.trim() !== '') {
      items.push(collapse(current))
      current = null
    }
  }
  if (current !== null) items.push(collapse(current))
  return items.length > 0 ? items : null
}

/** The first paragraph under the spec's `## Why`, collapsed, or ''. */
export function specAim(text: string): string {
  const para: string[] = []
  for (const line of section(text, 'Why') ?? []) {
    if (line.trim() !== '') para.push(line)
    else if (para.length > 0) break
  }
  return collapse(para.join(' '))
}

// --- the file ----------------------------------------------------------------------------------

function readGoals(path: string): GoalsFile {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new GoalsFault(`cannot read ${path}: ${strerror(error)}`)
  }
  return parseGoals(text, path)
}

function writeGoals(path: string, file: GoalsFile): void {
  const tmp = `${path}.tmp${process.pid}`
  writeFileSync(tmp, renderGoals(file), 'utf8')
  renameSync(tmp, path)
}

// --- evidence ----------------------------------------------------------------------------------

export function tokens(cell: string): string[] {
  return cell.split(';').map(token => token.trim()).filter(token => token !== '')
}

const unread = (token: string): boolean => token.startsWith('pr:') || token.startsWith('run:')

/** Null when the token holds, else why it does not. `pr:` and `run:` hold unread. */
export function tokenFault(token: string, repo: string, env: NodeJS.ProcessEnv): string | null {
  if (unread(token)) return null
  if (token.startsWith('commit:')) {
    const sha = token.slice('commit:'.length).trim()
    if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) return `${token} is no commit sha`
    const done = spawnSync('git', ['-C', repo || '.', 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore', timeout: GIT_MS })
    if (done.error !== undefined) return `${token} could not be resolved`
    return done.status === 0 ? null : `${token} does not resolve in ${repo || '.'}`
  }
  let path = expandUser(token, env)
  if (!isAbsolute(path)) path = join(repo || '.', path)
  return existsSync(path) ? null : `${token} does not exist`
}

export function evidenceFaults(cell: string, repo: string, env: NodeJS.ProcessEnv): string[] {
  const found = tokens(cell)
  if (!found.some(token => !unread(token))) return ['no path or commit']
  return found.map(token => tokenFault(token, repo, env)).filter((fault): fault is string => fault !== null)
}

export function rulingOf(cell: string): string {
  return RULING.exec(cell.trim())?.[1]?.trim() ?? ''
}

// --- the reading -------------------------------------------------------------------------------

export interface Assessment {
  readonly ok: boolean
  readonly open: string[]
  readonly deferred: string[]
  readonly unplanned: string[]
  readonly faults: string[]
  readonly notes: string[]
  readonly rows: number
  readonly met: number
  readonly ruled_out: number
  readonly aim: string
  readonly spec: string
  readonly table: string
}

export function assess(path: string, env: NodeJS.ProcessEnv): Assessment {
  const { head, rows } = readGoals(path)
  const faults: string[] = []
  const notes: string[] = []
  const ids = (keep: (row: GoalRow) => boolean): string[] => rows.filter(keep).map(row => row.id)
  for (const row of rows) {
    if (!(STATUSES as readonly string[]).includes(row.status)) {
      faults.push(`${row.id} has no status of open, met, ruled-out or deferred: ${row.status || 'empty'}`)
    } else if (row.status === 'met') {
      for (const fault of evidenceFaults(row.evidence, head.repo, env)) faults.push(`${row.id} met without evidence on disk: ${fault}`)
    } else if (row.status === 'ruled-out' && rulingOf(row.evidence) === '') {
      faults.push(`${row.id} ruled out without the operator's words`)
    } else if (row.status === 'deferred' && rulingOf(row.evidence) === '') {
      faults.push(`${row.id} deferred without the operator's words`)
    }
  }
  if (head.spec !== 'none') {
    let spec: string | null = null
    try {
      spec = readFileSync(expandUser(head.spec, env), 'utf8')
    } catch {
      notes.push(`the spec ${head.spec} cannot be read: its goals were not matched`)
    }
    if (spec !== null) {
      const listed = specGoals(spec)
      if (listed !== null) {
        if (rows.length !== listed.length) faults.push(`${rows.length} rows, the spec's Goals list ${listed.length}`)
        const left = [...listed]
        for (const row of rows) {
          const at = left.indexOf(collapse(row.goal))
          if (at >= 0) left.splice(at, 1)
          else faults.push(`${row.id} is not the spec's text`)
        }
      }
      if (head.aim !== '' && !collapse(spec).includes(collapse(head.aim))) faults.push('the aim is not the spec\'s text')
    }
  }
  const open = ids(row => row.status === 'open')
  const deferred = ids(row => row.status === 'deferred')
  return {
    ok: open.length === 0 && deferred.length === 0 && faults.length === 0,
    open, deferred, unplanned: ids(row => row.status === 'open' && row.plan.trim() === ''), faults, notes,
    rows: rows.length, met: ids(row => row.status === 'met').length, ruled_out: ids(row => row.status === 'ruled-out').length,
    aim: head.aim, spec: head.spec, table: goalsTable(rows),
  }
}

export function summaryLine(a: Assessment): string {
  const list = (ids: readonly string[]): string => ids.join(',') || 'none'
  const line = `goals met=${a.met}/${a.rows} ruled_out=${a.ruled_out} open=${list(a.open)} unplanned=${list(a.unplanned)}`
  return a.deferred.length > 0 ? `${line} deferred=${a.deferred.join(',')}` : line
}

// --- the commands ------------------------------------------------------------------------------

type Kind = 'one' | 'many' | 'flag'
interface Parsed {
  readonly one: Record<string, string | undefined>
  readonly many: Record<string, string[]>
  readonly flag: Record<string, boolean>
}

/** argv parsed against {name: kind}; a positional argument is refused. */
function options(ctx: Context, argv: readonly string[], spec: Readonly<Record<string, Kind>>): Parsed {
  const parsed: Parsed = { one: {}, many: {}, flag: {} }
  for (const [name, kind] of Object.entries(spec)) if (kind === 'many') parsed.many[name] = []
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k] ?? ''
    const name = arg.startsWith('--') ? arg.slice(2) : undefined
    const kind = name === undefined || !Object.hasOwn(spec, name) ? undefined : spec[name]
    if (name === undefined || kind === undefined) die(ctx, `unknown argument ${arg}`)
    if (kind === 'flag') {
      parsed.flag[name] = true
      continue
    }
    const value = argv[k + 1]
    if (value === undefined) die(ctx, `--${name} needs a value`)
    if (kind === 'many') parsed.many[name]?.push(value)
    else parsed.one[name] = value
    k++
  }
  return parsed
}

function repoOf(specPath: string | null, given: string | undefined, env: NodeJS.ProcessEnv): string {
  if (given) return resolve(expandUser(given, env))
  const base = specPath ? dirname(resolve(specPath)) : process.cwd()
  const done = spawnSync('git', ['-C', base, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_MS })
  const top = typeof done.stdout === 'string' ? done.stdout.trim() : ''
  return done.status === 0 && top !== '' ? top : base
}

function cmdInit(ctx: Context, path: string, argv: readonly string[]): void {
  const o = options(ctx, argv, { spec: 'one', aim: 'one', goal: 'many', repo: 'one', replace: 'flag' })
  const given = o.many['goal'] ?? []
  if (!o.one['spec']) die(ctx, 'init: --spec <path> or --spec none is required')
  const specPath = o.one['spec'] === 'none' ? null : resolve(expandUser(o.one['spec'], ctx.env))
  let aim = collapse(o.one['aim'] ?? '')
  let goals: string[]
  if (specPath !== null) {
    let spec: string
    try {
      spec = readFileSync(specPath, 'utf8')
    } catch {
      die(ctx, `init: cannot read the spec ${specPath}`)
    }
    const listed = specGoals(spec)
    if (listed === null && given.length === 0) die(ctx, `init: ${specPath} has no numbered list under « ## Goals »: add one, or give each goal with --goal`)
    if (listed !== null && given.length > 0) die(ctx, 'init: the spec lists its goals; --goal is only for a spec with no Goals list')
    goals = listed ?? given.map(collapse)
    if (aim !== '' && !collapse(spec).includes(aim)) die(ctx, 'init: the aim is not the spec\'s text: copy it verbatim')
    aim = aim || specAim(spec)
  } else goals = given.map(collapse)
  if (goals.some(goal => goal === '')) die(ctx, 'init: a goal is empty')
  if (existsSync(path)) {
    let old: string
    try {
      old = readGoals(path).head.spec
    } catch (error) {
      if (!(error instanceof GoalsFault)) throw error
      old = 'unreadable'
    }
    if (!o.flag['replace']) die(ctx, `init: ${path} already holds the goals of spec ${old}: give --replace to archive it and start over`)
    const stem = old === 'none' || old === 'unreadable' ? 'none' : basename(old, extname(old))
    const archive = join(dirname(path), `goals-${stem}.md`)
    renameSync(path, archive)
    say(ctx, `goals: the previous file is kept as ${archive}`)
  }
  mkdirSync(dirname(resolve(path)), { recursive: true })
  const head: GoalsHead = { spec: specPath ?? 'none', repo: repoOf(specPath, o.one['repo'], ctx.env), aim }
  const rows = goals.map((goal, k): GoalRow => ({ id: `G${k + 1}`, status: 'open', goal, plan: '', evidence: '' }))
  writeGoals(path, { head, rows })
  say(ctx, `goals: ${rows.length} goal(s) written to ${path}`)
}

function assessOrDie(ctx: Context, path: string): Assessment {
  try {
    return assess(path, ctx.env)
  } catch (error) {
    if (error instanceof GoalsFault) die(ctx, error.message)
    throw error
  }
}

function cmdStatus(ctx: Context, path: string): void {
  const a = assessOrDie(ctx, path)
  say(ctx, `aim: ${a.aim || 'none'}`)
  say(ctx, `spec: ${a.spec}`)
  say(ctx, a.table)
  for (const fault of a.faults) say(ctx, `fault: ${fault}`)
  for (const note of a.notes) say(ctx, `note: ${note}`)
  say(ctx, summaryLine(a))
}

/** Reads the file, hands the goal's row to `change`, writes the file back. */
function edit(ctx: Context, path: string, id: string, change: (head: GoalsHead, row: GoalRow) => void): void {
  let file: GoalsFile
  try {
    file = readGoals(path)
  } catch (error) {
    if (error instanceof GoalsFault) die(ctx, error.message)
    throw error
  }
  const row = file.rows.find(r => r.id === id)
  if (row === undefined) die(ctx, `no goal ${id} (goals: ${file.rows.map(r => r.id).join(', ') || 'none'})`)
  change(file.head, row)
  writeGoals(path, file)
}

function goalId(ctx: Context, argv: readonly string[], command: string): string {
  return argv[0] ?? die(ctx, `${command}: a goal id is required`)
}

/** The operator's words out of --ruling, quotes dropped; refused when there are none. */
function rulingWords(ctx: Context, given: string | undefined, command: string): string {
  let words = (given ?? '').trim()
  words = RULING.exec(words)?.[1] ?? words
  words = collapse(words.trim().replace(/^[«»"']+|[«»"']+$/g, '').trim())
  if (words === '') die(ctx, `${command}: --ruling needs the operator's own words, verbatim and not empty`)
  return words
}

const COMMANDS: Readonly<Record<string, (ctx: Context, path: string, argv: readonly string[]) => void>> = {
  init: cmdInit,
  status: (ctx, path) => cmdStatus(ctx, path),
  line: (ctx, path) => say(ctx, summaryLine(assessOrDie(ctx, path))),
  unplanned: (ctx, path) => { for (const id of assessOrDie(ctx, path).unplanned) say(ctx, id) },
  plan: (ctx, path, argv) => {
    const id = goalId(ctx, argv, 'plan')
    const phase = options(ctx, argv.slice(1), { phase: 'one' }).one['phase'] ?? ''
    if (phase.trim() === '') die(ctx, 'plan: --phase <text> is required')
    edit(ctx, path, id, (_, row) => { row.plan = collapse(phase) })
  },
  met: (ctx, path, argv) => {
    const id = goalId(ctx, argv, 'met')
    const found = (options(ctx, argv.slice(1), { evidence: 'many' }).many['evidence'] ?? []).flatMap(tokens)
    if (found.length === 0) die(ctx, 'met: --evidence <path|commit:<sha>> is required')
    edit(ctx, path, id, (head, row) => {
      const faults = evidenceFaults(found.join('; '), head.repo, ctx.env)
      if (faults.length > 0) die(ctx, `met: ${id} not recorded: ${faults.join('; ')}`)
      row.status = 'met'
      row.evidence = found.join('; ')
    })
  },
  'rule-out': (ctx, path, argv) => {
    const id = goalId(ctx, argv, 'rule-out')
    const words = rulingWords(ctx, options(ctx, argv.slice(1), { ruling: 'one' }).one['ruling'], 'rule-out')
    edit(ctx, path, id, (_, row) => {
      row.status = 'ruled-out'
      row.evidence = `operator: « ${words} »`
    })
  },
  defer: (ctx, path, argv) => {
    const id = goalId(ctx, argv, 'defer')
    const words = rulingWords(ctx, options(ctx, argv.slice(1), { ruling: 'one' }).one['ruling'], 'defer')
    edit(ctx, path, id, (_, row) => {
      if (row.status !== 'open') die(ctx, `defer: ${id} is ${row.status}, not open`)
      row.status = 'deferred'
      row.evidence = `operator: « ${words} »`
    })
  },
  reopen: (ctx, path, argv) => {
    edit(ctx, path, goalId(ctx, argv, 'reopen'), (_, row) => {
      row.status = 'open'
      row.evidence = ''
    })
  },
  check: cmdCheck,
}

function cmdCheck(ctx: Context, path: string, argv: readonly string[]): void {
  const asJson = argv.length === 1 && argv[0] === '--json'
  if (argv.length > 0 && !asJson) die(ctx, `check: unknown argument ${argv[0]}`)
  let a: Assessment
  try {
    a = assess(path, ctx.env)
  } catch (error) {
    if (!(error instanceof GoalsFault)) throw error
    if (asJson) say(ctx, JSON.stringify({ ok: false, error: error.message }))
    else ctx.io.err(`ERROR: ${error.message}\n`)
    throw new Exit(2)
  }
  if (asJson) say(ctx, JSON.stringify(a))
  else {
    if (a.open.length > 0) say(ctx, `open: ${a.open.join(', ')}`)
    if (a.deferred.length > 0) say(ctx, `deferred: ${a.deferred.join(', ')}`)
    for (const fault of a.faults) say(ctx, `fault: ${fault}`)
    for (const note of a.notes) say(ctx, `note: ${note}`)
    say(ctx, summaryLine(a))
  }
  throw new Exit(a.ok ? 0 : 1)
}

/** Runs one command line; the exit code. */
export function main(argv: readonly string[], io: Io = processIo, env: NodeJS.ProcessEnv = process.env): number {
  const ctx: Context = { io, env }
  try {
    const [command = '', path = '', ...rest] = argv
    const run = COMMANDS[command]
    if (argv.length < 2 || run === undefined) die(ctx, `usage: goals.sh {${Object.keys(COMMANDS).join('|')}} <goals.md> [...] (see header)`)
    if (command !== 'init' && !existsSync(path)) {
      if (command === 'check') cmdCheck(ctx, path, rest)
      die(ctx, `no goals file at ${path}: dispatch-record.sh goals <record> init --spec <path>|none`)
    }
    run(ctx, path, rest)
    return 0
  } catch (error) {
    if (error instanceof Exit) return error.code
    throw error
  }
}

/* node:coverage ignore next 3 */
if (isEntry(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
