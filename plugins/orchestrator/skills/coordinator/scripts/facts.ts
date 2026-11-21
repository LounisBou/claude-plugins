// What the machine shows now: `facts` (the sessions, checkouts and heavy runs of every repository a
// session works in, then the collisions among them) and `owners` (each open pull request of those
// repositories, traced to its orchestrator). coordinator.sh's header documents both lines and sources.
import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ROLES } from '../../../core/names.ts'
import type { WaitKind } from '../../../core/orchestration.ts'
import { setting } from '../../../core/paths.ts'
import { parseQuota, planOfConfig, QUOTA_DIR, quotaLine, type Quota } from '../../../core/quota.ts'
import { writeAtomic } from '../../../core/store.ts'
import { parsePrFile, prFilePath, prsOfRepo, repoOfOrigin } from '../../../hooks/pr-file-format.ts'
import { dataOf, die, moduleOf, Refusal, say, stateOf, type Context } from './context.ts'
import { fieldsOf, readSleeping } from './sleeping.ts'

/** A remote row is kept for a day after its updated_at (REMOTE_STALE_AFTER_MS in hooks/remote-row.ts). */
export const REMOTE_STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** The waits a turn's end shows: on the operator, or done. */
const SHOWN_WAITS: readonly WaitKind[] = ['operator', 'done']

/** The orchestrator's prefix, core's. */
export const ORCH = Object.entries(ROLES).find(([, role]) => role === 'orchestrator')?.[0] ?? 'Orch'

export interface Session {
  readonly pid: string
  readonly tty: string
  readonly title: string
  readonly orch: string
  readonly repo: string
  readonly branch: string
  readonly top: string
  readonly why: string
  /** The plan the session runs on (`plan1`, `plan2`, else its configuration directory), « - » when its environment was not read. */
  readonly plan: string
}

export interface Place {
  readonly top: string
  readonly repo: string
  readonly branch: string
}

export interface Heavy {
  readonly pid: string
  readonly dir: string
  readonly command: string
}

export interface Pr {
  readonly repo: string
  readonly num: string
  readonly branch: string
  readonly head: string
}

export interface Remote {
  readonly name: string
  readonly machine: string
  readonly updatedAt: string
  readonly tokens: string
  readonly percent: string
  readonly repo: string
  /** The pull requests it lists, joined by one blank. */
  readonly prs: string
  readonly waiting: string
  readonly blocks: string
  readonly since: string
}

export interface RemotePr {
  readonly key: string
  readonly num: string
  readonly branch: string
  readonly name: string
  readonly machine: string
  readonly at: string
}

export interface Facts {
  readonly unread: string[]
  /** The process table's text, as read. */
  table: string
  readonly sessions: Session[]
  places: Place[]
  readonly heavy: Heavy[]
  readonly prs: Pr[]
  readonly readRepos: string[]
  readonly remote: Remote[]
  readonly remotePrs: RemotePr[]
}

type Json = Record<string, unknown>

/** Strings in byte order, whatever the locale. */
export function sorted(lines: readonly string[]): string[] {
  return [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

const firstLine = (text: string): string => text.split('\n')[0] ?? ''
const trimEnd = (text: string): string => text.replace(/\n+$/, '')

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function readFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function realOr(path: string, fallback: string): string {
  try {
    return realpathSync(path)
  } catch {
    return fallback
  }
}

/** `a // b`: b when a is absent, null or false. */
function or(value: unknown, fallback: unknown): unknown {
  return value === undefined || value === null || value === false ? fallback : value
}

/** A scalar as a cell of a row: null is empty; an object or an array is no cell. */
function cell(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new Error('not a scalar')
}

/** A UTC time to the second, a fraction allowed, as seconds since the epoch; undefined when it is none. */
export function utcSeconds(text: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(text.replace(/\.[0-9]+Z$/, 'Z'))
  if (m === null) return undefined
  const [, y, mo, d, h, mi, s] = m.map(Number)
  return Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 0, h ?? 0, mi ?? 0, s ?? 0) / 1000
}

/** The regular files directly under `dir` (or under every level with `deep`), as paths, in byte order. */
function filesOf(dir: string, deep = false): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const files: string[] = []
  for (const name of sorted(names)) {
    const path = join(dir, name)
    try {
      const stat = statSync(path, { throwIfNoEntry: false })
      if (stat?.isFile() === true) files.push(path)
      else if (deep && stat?.isDirectory() === true) files.push(...filesOf(path, true))
    } catch {
      // Gone meanwhile: no file.
    }
  }
  return files
}

/** A path named `<key>.tmp-*` is a write in flight, never a row. */
const isTemporary = (path: string): boolean => basename(path).includes('.tmp-')

// --- The trees. ----------------------------------------------------------------------------

export type Tree = { readonly kind: 'tree'; readonly top: string; readonly repo: string; readonly branch: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'error'; readonly message: string }

/** An origin's address with its scheme, user and `.git` removed: one remote reached two ways is one repository. */
export function repositoryOf(url: string): string {
  return url.replace(/^[A-Za-z+]+:\/\//, '').replace(/^[^@/]*@/, '').replace(/^([^/:]+):/, '$1/').replace(/\.git$/, '').replace(/\/+$/, '')
}

/**
 * The git tree holding `dir`: its top under its real name, its repository (the origin's address,
 * else the top) and its branch (HEAD when detached). `none` when the directory is in no tree; a
 * tree git could not read is an error, since it is on a branch nobody knows.
 */
export function treeOf(ctx: Context, dir: string): Tree {
  const env = { ...ctx.env, LC_ALL: 'C' }
  const git = (at: string, ...args: string[]) => ctx.run('git', ['-C', at, ...args], { env })
  const shown = git(dir, 'rev-parse', '--show-toplevel')
  if (shown.status !== 0) {
    if (shown.stderr.includes('not a git repository')) return { kind: 'none' }
    return { kind: 'error', message: `git failed on ${dir}: ${firstLine(shown.stderr)}` }
  }
  let top: string
  try {
    top = realpathSync(trimEnd(shown.stdout))
  } catch {
    return { kind: 'error', message: `cannot enter ${dir}` }
  }
  const head = git(top, 'symbolic-ref', '--short', '-q', 'HEAD')
  if (head.status > 1) return { kind: 'error', message: `git failed on ${top}: ${firstLine(head.stderr)}` }
  const branch = head.status === 0 ? trimEnd(head.stdout) : 'HEAD'
  const origin = git(top, 'remote', 'get-url', 'origin')
  if (origin.status !== 0 && origin.status !== 2) return { kind: 'error', message: `git failed on ${top}: ${firstLine(origin.stderr)}` }
  return { kind: 'tree', top, repo: origin.status === 0 ? repositoryOf(trimEnd(origin.stdout)) : top, branch }
}

// --- The sessions. -------------------------------------------------------------------------

/** The host's name: ORCHESTRATOR_HOST_CLI, else the launcher's own default. */
export function hostCli(ctx: Context): string {
  let name = setting(ctx.env, 'ORCHESTRATOR_HOST_CLI')
  if (name === undefined) {
    const launcher = readFile(join(ctx.here, '..', '..', 'iterm-agents', 'scripts', 'iterm_agent.py')) ?? ''
    for (const line of launcher.split('\n')) {
      const m = /^HOST_CLI = os\.environ\.get\("ORCHESTRATOR_HOST_CLI", "([^"]*)"\)$/.exec(line)
      if (m !== null) {
        name = m[1]
        break
      }
    }
  }
  if (name === undefined || name === '') return die("the host's name is unknown: set ORCHESTRATOR_HOST_CLI")
  return basename(name)
}

/** A name of the former shape, `Orch : x`, written the current way; any other name as given. */
export function currentOrch(name: string): string {
  return name.startsWith(`${ORCH} : `) ? `${ORCH}: ${name.slice(ORCH.length + 3)}` : name
}

export interface Proc {
  readonly kind: 'H' | 'S'
  readonly pid: string
  readonly tty: string
  readonly command: string
}

const base = (word: string): string => word.replace(/.*\//, '')

/**
 * The host sessions and the heavy runs of a process table, lines `<pid> <ppid> <tty> <command>`.
 * A session: the first word of the command is the host CLI, a terminal holds it, and it is no
 * evaluation run's. A heavy run: a suite or an evaluation run, counted once at its top process,
 * since a suite's subshells and an evaluation's host process carry its command line too.
 */
export function procsOf(table: string, host: string): Proc[] {
  const heavy = new Map<string, boolean>()
  const parent = new Map<string, string>()
  const line = new Map<string, string>()
  const session = new Map<string, boolean>()
  const ttyOf = new Map<string, string>()
  const order: string[] = []
  const rows = table.split('\n')
  if (rows.at(-1) === '') rows.pop()
  for (const row of rows) {
    const fields = row.trim().split(/[ \t]+/)
    const pid = fields[0] ?? ''
    const tty = fields[2] ?? ''
    const command = row.replace(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]+[^ \t]+[ \t]+/, '')
    // What runs, past a `timeout <n>` and a shell given a script: a wrapper `sh -c` that only
    // names a suite in its text, or a `pgrep` looking for one, runs none.
    const w = command.split(/[ \t]+/)
    const at = (i: number): string => w[i] ?? ''
    let i = 0
    if (base(at(i)) === 'timeout') i += 2
    if (/^(ba|z)?sh$/.test(base(at(i))) && !at(i + 1).startsWith('-')) i++
    heavy.set(pid, /(^|\/)(run-tests|e2e)[.]sh$/.test(at(i)) || (base(at(i)) === host && at(i + 1) === 'plugin' && at(i + 2) === 'eval'))
    parent.set(pid, fields[1] ?? '')
    line.set(pid, command)
    order.push(pid)
    const first = base(command.replace(/[ \t].*/, ''))
    session.set(pid, first === host && tty !== '??' && tty !== '-')
    ttyOf.set(pid, tty)
  }
  const procs: Proc[] = []
  for (const pid of order) {
    const isHeavy = heavy.get(pid) === true
    if (isHeavy && heavy.get(parent.get(pid) ?? '') !== true) procs.push({ kind: 'H', pid, tty: '', command: line.get(pid) ?? '' })
    else if (session.get(pid) === true && !isHeavy) procs.push({ kind: 'S', pid, tty: ttyOf.get(pid) ?? '', command: line.get(pid) ?? '' })
  }
  return procs
}

/** The orchestrator a session names, else « unknown » with why. */
export interface Named {
  readonly orch: string
  readonly why: string
}

/**
 * The orchestrator a session's brief names, else the one its startup prompt names, else
 * « unknown ». A relative brief is the session's own, read from its directory; a brief that exists
 * and cannot be read is unread, never a brief that names nobody.
 */
export function briefOrchestrator(command: string, dir: string, unread: string[]): Named {
  let why = 'names no orchestrator'
  let brief = (/.*Read and execute ([^ ]*).*/.exec(command)?.[1] ?? '').replace(/\.$/, '')
  if (brief !== '' && !brief.startsWith('/')) {
    if (dir !== '') brief = `${dir}/${brief}`
    else {
      why = `its brief ${brief} is relative to a directory not read`
      brief = ''
    }
  }
  const stat = brief === '' ? undefined : statSync(brief, { throwIfNoEntry: false })
  if (stat !== undefined) {
    let text: string | undefined
    try {
      accessSync(brief, constants.R_OK)
      text = stat.isFile() ? readFileSync(brief, 'utf8') : undefined
    } catch {
      text = undefined
    }
    if (text === undefined) {
      unread.push(`brief ${brief}: cannot be read`)
      why = `brief ${brief} cannot be read`
    } else {
      for (const line of text.split('\n')) {
        const found = /rchestrator is the session \*\*`([^`]*)`/.exec(line)
        if (found === null) continue
        if (found[1] !== '') return { orch: currentOrch(found[1] ?? ''), why }
        break
      }
    }
  }
  const prompt = new RegExp(`.*[Yy]our orchestrator is (${ORCH} ?: [^\\][]*\\[[0-9A-Za-z]*\\]).*`).exec(command)?.[1]
  return { orch: prompt === undefined ? 'unknown' : currentOrch(prompt), why }
}

function onPath(env: Context['env'], name: string): boolean {
  for (const dir of (env['PATH'] ?? '').split(':')) {
    if (dir === '') continue
    try {
      accessSync(join(dir, name), constants.X_OK)
      if (statSync(join(dir, name)).isFile()) return true
    } catch {
      // Not there.
    }
  }
  return false
}

/** The working directory of each pid, `<pid>\t<path>` pairs as read. */
function cwdsOf(ctx: Context, pids: readonly string[], unread: string[]): Map<string, string> {
  const cwds = new Map<string, string>()
  const add = (pid: string, path: string) => {
    if (!cwds.has(pid)) cwds.set(pid, path)
  }
  if (pids.length === 0) return cwds
  const given = setting(ctx.env, 'COORDINATOR_CWDS')
  if (given !== undefined) {
    const text = readFile(given)
    if (text === undefined) unread.push(`directories: ${given} cannot be read`)
    for (const row of (text ?? '').split('\n')) {
      if (row === '') continue
      const pid = row.trim().split(/[ \t]+/)[0] ?? ''
      add(pid, row.replace(/^[0-9]+[ \t]+/, '').split('\t')[0] ?? '')
    }
  } else if (onPath(ctx.env, 'lsof')) {
    const listed = ctx.run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'])
    let pid = ''
    for (const row of listed.stdout.split('\n')) {
      if (row.startsWith('p')) pid = row.slice(1)
      else if (row.startsWith('n')) add(pid, row.slice(1).split('\t')[0] ?? '')
    }
    if (listed.status !== 0) unread.push(`directories: lsof failed: ${firstLine(listed.stderr) || `exit ${listed.status}`}`)
  } else {
    unread.push('directories: lsof is missing')
  }
  return cwds
}

/** The process table: COORDINATOR_PS_TABLE when the suite gives one, else `ps`. */
function tableOf(ctx: Context, unread: string[]): string {
  const given = setting(ctx.env, 'COORDINATOR_PS_TABLE')
  if (given !== undefined) {
    const text = readFile(given)
    if (text === undefined) unread.push(`processes: ${given} cannot be read`)
    return text ?? ''
  }
  const ps = ctx.run('ps', ['-Ao', 'pid=,ppid=,tty=,command='])
  if (ps.status !== 0) unread.push('processes: ps failed')
  return ps.status === 0 ? ps.stdout : ''
}

/**
 * The configuration directory in each session's own environment, by pid: « » when it has none (plan 1).
 * `ps eww` shows a process's environment after its words; COORDINATOR_PS_ENV, `<pid> <words and environment>`
 * rows, stands in for it when the suite gives a process table of its own. A pid it did not read is not in the map.
 */
function configsOf(ctx: Context, pids: readonly string[], unread: string[]): Map<string, string> {
  const configs = new Map<string, string>()
  if (pids.length === 0) return configs
  const given = setting(ctx.env, 'COORDINATOR_PS_ENV')
  let text: string | undefined
  if (given !== undefined) {
    text = readFile(given)
    if (text === undefined) unread.push(`plans: ${given} cannot be read`)
  } else if (setting(ctx.env, 'COORDINATOR_PS_TABLE') === undefined) {
    const ps = ctx.run('ps', ['eww', '-o', 'pid=,command=', '-p', pids.join(',')])
    if (ps.status === 0) text = ps.stdout
    else unread.push('plans: ps failed')
  }
  for (const row of (text ?? '').split('\n')) {
    const pid = /^\s*([0-9]+)\s/.exec(row)?.[1]
    if (pid === undefined) continue
    // The environment follows the words: the last assignment is the process's own.
    const found = [...row.matchAll(/(?:^|\s)CLAUDE_CONFIG_DIR=(\S*)/g)]
    configs.set(pid, found.at(-1)?.[1] ?? '')
  }
  return configs
}

/** Reads the sessions, places (checkouts and session trees), heavy runs, pull requests and remote rows. */
export function readFacts(ctx: Context): Facts {
  const facts: Facts = { unread: [], table: '', sessions: [], places: [], heavy: [], prs: [], readRepos: [], remote: [], remotePrs: [] }
  const { unread } = facts
  // With no host name no process is a session, and an empty list reads as « no collision ».
  let host = ''
  try {
    host = hostCli(ctx)
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    unread.push(`sessions: ${error.message}`)
  }
  facts.table = tableOf(ctx, unread)
  const procs = procsOf(facts.table, host)
  const cwds = cwdsOf(ctx, procs.map(p => p.pid), unread)
  const home = ctx.env['HOME'] ?? ''
  const configs = configsOf(ctx, procs.filter(p => p.kind !== 'H').map(p => p.pid), unread)

  // A pid with no directory, or a directory git could not read, is on no branch and would drop
  // out of every collision unsaid: each one is an unread line.
  const places: Place[] = []
  for (const proc of procs) {
    const cwd = cwds.get(proc.pid) ?? ''
    if (proc.kind === 'H') {
      let dir = cwd
      if (cwd !== '') {
        const tree = treeOf(ctx, cwd)
        if (tree.kind === 'tree') dir = tree.top
      } else unread.push(`directory of heavy run ${proc.pid}: no working directory read`)
      facts.heavy.push({ pid: proc.pid, dir: dir === '' ? '-' : dir, command: proc.command })
      continue
    }
    let top = cwd === '' ? '-' : cwd
    let repo = '-'
    let branch = '-'
    if (cwd === '') unread.push(`directory of session ${proc.pid}: no working directory read`)
    else {
      const tree = treeOf(ctx, cwd)
      if (tree.kind === 'tree') ({ top, repo, branch } = tree)
      else if (tree.kind === 'none') repo = 'not a git tree'
      else unread.push(`directory of session ${proc.pid}: ${tree.message}`)
    }
    const at = proc.command.lastIndexOf(' --name ')
    const title = at < 0 ? '' : proc.command.slice(at + 8).replace(/ --remote-control .*/, '')
    const named = title.startsWith(`${ORCH}: `) || title.startsWith(`${ORCH} : `)
      ? { orch: currentOrch(title), why: '-' }
      : briefOrchestrator(proc.command, cwd, unread)
    const config = configs.get(proc.pid)
    const plan = config === undefined ? '-' : config === '' ? 'plan1' : planOfConfig(config, home)
    facts.sessions.push({ pid: proc.pid, tty: proc.tty, title: title === '' ? '-' : title, orch: named.orch, repo, branch, top, why: named.why, plan })
    if (branch !== '-') places.push({ top, repo, branch })
  }

  // The checkouts, of the repositories a session works in only: a checkout left over in a
  // repository nobody works in steps on nobody.
  const listing = ctx.run('bash', [join(ctx.here, '..', '..', 'orchestrator', 'scripts', 'workspace.sh'), 'list'])
  if (listing.status === 0) {
    const repos = new Set(facts.sessions.map(s => s.repo))
    for (const row of trimEnd(listing.stdout).split('\n')) {
      const given = (row.split('|')[0] ?? '').replace(/\s+$/, '')
      if (given === '') continue
      // The listing may spell a path through a symbolic link (/var for /private/var): read under
      // its real name, as a session's directory is.
      const path = isDir(given) ? realOr(given, given) : given
      const tree = treeOf(ctx, path)
      if (tree.kind === 'none') unread.push(`checkout ${path}: not a git tree`)
      else if (tree.kind === 'error') unread.push(`checkout ${path}: ${tree.message}`)
      else if (repos.has(tree.repo)) places.push({ top: tree.top, repo: tree.repo, branch: tree.branch })
    }
  } else unread.push(`checkouts: ${firstLine(listing.stderr)}`)
  const line = (p: Place): string => `${p.top}\t${p.repo}\t${p.branch}`
  const unique = new Map(places.map(p => [line(p), p]))
  facts.places = sorted([...unique.keys()]).map(k => unique.get(k) as Place)

  // The open pull requests, as the machine's pull request file holds them (the hooks module
  // refreshes it, one forge call a minute for the whole machine): a repository it holds no current
  // reading of is unread. The file reads the repositories the records and the sweep name.
  const state = dataOf(ctx.env)
  const file = parsePrFile(readFile(prFilePath(state)) ?? '')
  for (const repo of new Set(facts.places.map(p => p.repo))) {
    const named = repoOfOrigin(repo)
    if (named === undefined) {
      unread.push(`forge ${repo}: not a GitHub repository, which the machine's pull request file holds alone`)
      continue
    }
    const held = prsOfRepo(file, named, ctx.now().getTime())
    if (held === undefined) {
      unread.push(`forge ${repo}: no current reading in the machine's pull request file`)
      continue
    }
    facts.readRepos.push(repo)
    for (const pr of held) {
      if (pr.state === 'OPEN') facts.prs.push({ repo, num: String(pr.pr), branch: pr.head, head: pr.fork === null ? 'same' : `fork:${pr.fork}` })
    }
  }
  remoteRows(ctx, facts)
  return facts
}

/** A remote row of the module's store, or undefined when its file is empty; throws when it is no JSON row. */
export function remoteRow(text: string): (Remote & { readonly at: number | undefined }) | undefined {
  if (text.trim() === '') return undefined
  const row = parseJson(text)
  if (!isObject(row) || typeof row['name'] !== 'string' || typeof row['updated_at'] !== 'string') throw new Error('not a JSON row')
  const prs = or(row['prs'], [])
  if (!Array.isArray(prs)) throw new Error('not a JSON row')
  return {
    name: row['name'],
    machine: cell(or(row['machine'], '')),
    updatedAt: row['updated_at'],
    tokens: cell(or(row['context_tokens'], 0)),
    percent: cell(or(row['context_percent'], 0)),
    repo: cell(or(row['repo'], '')),
    prs: prs.map(cell).join(' '),
    waiting: cell(or(row['waiting'], '')),
    blocks: cell(or(row['blocks'], '')),
    since: cell(or(row['waiting_since'], '')),
    at: utcSeconds(row['updated_at']),
  }
}

/**
 * The rows the hooks module received from orchestrators on other machines, one JSON row per file
 * in store/remote under the module's directory. A row is kept while its updated_at is at most a
 * day old and no local session names it as title or orchestrator (local wins); a stale row is
 * skipped silently, since the module deletes it and this script never does. Its pull requests are
 * matched to a repository read here by its address without the host, and kept only when that
 * repository's open list has them; one in a repository not read here keeps branch « - ».
 */
function remoteRows(ctx: Context, facts: Facts): void {
  const store = join(moduleOf(ctx.env), 'store', 'remote')
  if (!isDir(store)) return
  const now = Math.floor(ctx.now().getTime() / 1000)
  const names = new Set(facts.sessions.flatMap(s => [s.title, s.orch]))
  for (const file of filesOf(store)) {
    if (isTemporary(file)) continue
    let row
    try {
      row = remoteRow(readFile(file) ?? '')
    } catch {
      facts.unread.push(`remote ${file}: not a JSON row`)
      continue
    }
    if (row === undefined || row.at === undefined || now - row.at > REMOTE_STALE_AFTER_MS / 1000 || names.has(row.name)) continue
    facts.remote.push(row)
  }
  const ownerName = (repo: string): string => repo.replace(/^[^/]+\//, '')
  const on = new Map<string, string>()
  for (const repo of facts.readRepos) if (!on.has(ownerName(repo))) on.set(ownerName(repo), repo)
  const open = new Map(facts.prs.map(p => [`${p.repo}\t${p.num}`, p.branch]))
  for (const row of facts.remote) {
    for (const item of row.prs.split(/\s+/).filter(x => x !== '')) {
      const h = item.indexOf('#')
      const repo = h < 0 ? '' : item.slice(0, h)
      const num = item.slice(h + 1)
      const read = on.get(repo)
      let key = repo
      let branch = '-'
      if (read !== undefined) {
        const found = open.get(`${read}\t${num}`)
        if (found === undefined) continue
        key = read
        branch = found
      }
      facts.remotePrs.push({ key, num, branch, name: row.name, machine: row.machine, at: row.updatedAt })
    }
  }
}

// --- The lines. ----------------------------------------------------------------------------

/** The first word of each line of the process table: the pids still running. */
function livePids(table: string): Set<string> {
  const rows = table.split('\n')
  if (rows.at(-1) === '') rows.pop()
  return new Set(rows.map(row => row.trim().split(/[ \t]+/)[0] ?? ''))
}

/** Each JSON object, one per line, of the files under the module's store directory `name`; a temporary file is none. */
function storeObjects(ctx: Context, name: string): Json[] {
  const objects: Json[] = []
  for (const file of filesOf(join(moduleOf(ctx.env), 'store', name), true)) {
    if (isTemporary(file)) continue
    for (const line of (readFile(file) ?? '').split('\n')) {
      const value = parseJson(line)
      if (isObject(value)) objects.push(value)
    }
  }
  return objects
}

const pidCell = (value: unknown): string => {
  const pid = or(value, '')
  return typeof pid === 'string' ? pid : JSON.stringify(pid)
}

/** The orchestrators waiting at the end of their turn, from the module's waits, each while its pid runs. */
export function waitingLines(ctx: Context, table: string): string[] {
  const live = livePids(table)
  const lines: string[] = []
  for (const wait of storeObjects(ctx, 'waits')) {
    const waiting = wait['waiting']
    if (!SHOWN_WAITS.some(kind => kind === waiting)) continue
    try {
      if (!live.has(pidCell(wait['pid']))) continue
      const name = cell(or(wait['name'], 'unnamed'))
      const since = cell(or(wait['waiting_since'], '?'))
      lines.push(waiting === 'operator' ? `waiting ${name} | operator since ${since} | blocks: ${cell(or(wait['blocks'], ''))}` : `waiting ${name} | done since ${since}`)
    } catch {
      // A field that is no scalar: no line.
    }
  }
  return lines
}

/** The pull requests nobody attends, as each live orchestrator's module last wrote them on its row. */
export function unattendedLines(ctx: Context, table: string): string[] {
  const live = livePids(table)
  const lines: string[] = []
  for (const row of storeObjects(ctx, 'sessions')) {
    const unattended = row['unattended']
    const line = isObject(unattended) ? unattended['line'] : undefined
    if (row['role'] !== 'orchestrator' || typeof line !== 'string' || !live.has(pidCell(row['pid']))) continue
    try {
      // One fact line per line the module wrote: « Attend ton geste » and « En anomalie » each stand alone.
      for (const said of line.split('\n')) if (said.trim() !== '') lines.push(`unattended ${cell(or(row['name'], 'unnamed'))} | ${said}`)
    } catch {
      // A name that is no scalar: no line.
    }
  }
  return lines
}

export function remoteLine(row: Remote): string {
  const since = row.since === '' ? '?' : row.since
  const wait = row.waiting === 'operator' ? `operator since ${since} | blocks: ${row.blocks}` : row.waiting === 'done' ? `done since ${since}` : 'working'
  const prs = row.prs === '' ? 'none' : row.prs.replaceAll(' ', ', ')
  return `remote ${row.name} | on ${row.machine} | updated ${row.updatedAt} | context ${row.tokens} (${row.percent}%) | repository ${row.repo === '' ? 'none' : row.repo} | prs ${prs} | ${wait}`
}

/** Each key's values, in the order met, for the keys met more than once. */
function groupsOf<T>(items: readonly T[], key: (item: T) => string | undefined, value: (item: T) => string): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const item of items) {
    const k = key(item)
    if (k === undefined) continue
    groups.set(k, [...(groups.get(k) ?? []), value(item)])
  }
  return groups
}

/**
 * A pull request of ours whose branch sessions of two orchestrators are on, read from the sessions
 * themselves, so an « unknown » owner never hides it. A remote row listing it counts as one more
 * orchestrator; a pull request of a repository not read here has no branch, so only the remote
 * rows count on it. Names are counted once.
 */
export function prCollisions(facts: Facts): string[] {
  const on = groupsOf(facts.sessions, s => (s.orch === 'unknown' ? undefined : `${s.repo}\t${s.branch}`), s => s.orch)
  const rows: string[] = []
  for (const pr of facts.prs) {
    if (pr.head !== 'same') continue
    for (const orch of on.get(`${pr.repo}\t${pr.branch}`) ?? []) rows.push(`${pr.repo}#${pr.num}\t${pr.branch}\t${orch}`)
  }
  for (const r of facts.remotePrs) rows.push(`${r.key}#${r.num}\t${r.branch}\t${r.name}`)
  const groups = new Map<string, { branch: string; names: string[] }>()
  for (const row of sorted([...new Set(rows)])) {
    const [pr = '', branch = '', name = ''] = row.split('\t')
    const group = groups.get(pr) ?? { branch, names: [] }
    group.names.push(name)
    groups.set(pr, group)
  }
  return sorted([...groups].filter(([, g]) => g.names.length > 1).map(([pr, g]) => `collision pr | ${pr} | ${g.branch} | ${g.names.join(', ')}`))
}

/** The collisions: checkouts, sessions and heavy runs at once, and pull requests. */
export function collisions(facts: Facts): string[] {
  const pair = (k: string): [string, string] => {
    const [a = '', b = ''] = k.split('\t')
    return [a, b]
  }
  const many = (groups: Map<string, string[]>, kind: string): string[] =>
    sorted([...groups].filter(([, l]) => l.length > 1).map(([k, l]) => `collision ${kind} | ${pair(k).join(' | ')} | ${l.join(', ')}`))
  const lines = [
    ...many(groupsOf(facts.places, p => (p.branch === 'HEAD' || p.branch === '-' ? undefined : `${p.repo}\t${p.branch}`), p => p.top), 'checkouts'),
    ...many(groupsOf(facts.sessions, s => (s.repo === '-' || s.branch === 'HEAD' || s.branch === '-' ? undefined : `${s.repo}\t${s.branch}`), s => `${s.pid} ${s.title}`), 'sessions'),
  ]
  if (facts.heavy.length > 1) lines.push(`collision heavy | ${facts.heavy.map(h => h.pid).join(', ')}`)
  return [...lines, ...prCollisions(facts)]
}

/** Each plan's quota, as the status lines keep it under `<state>/quota/`: a file that is no reading is skipped, the plans in order. */
export function quotaLines(ctx: Context): string[] {
  const home = ctx.env['HOME'] ?? ''
  const readings: Quota[] = []
  for (const file of filesOf(join(dataOf(ctx.env), QUOTA_DIR))) {
    if (isTemporary(file) || !file.endsWith('.json')) continue
    const quota = parseQuota(parseJson(readFile(file) ?? ''))
    if (quota !== null) readings.push(quota)
  }
  return readings.map(quota => quotaLine(quota, home, ctx.now().getTime())).sort()
}

/** The real path of the workspaces' root, empty when it cannot be entered. */
function workspacesRoot(ctx: Context): string {
  return realOr(setting(ctx.env, 'ORCHESTRATOR_WORKSPACES') ?? `${ctx.env['HOME'] ?? ''}/dev/workspaces`, '')
}

/** The unread lines, then the exit: 2 when a source was not read, else `code`. */
function finish(ctx: Context, facts: Facts, code: number): number {
  for (const line of facts.unread) ctx.out(`unread ${line}`)
  return facts.unread.length > 0 ? 2 : code
}

export function factsCommand(ctx: Context, args: readonly string[]): number {
  if (args.length > 0) die(`facts: unexpected argument ${args[0]}`)
  const facts = readFacts(ctx)
  for (const s of facts.sessions) ctx.out(`session ${s.pid} | ${s.tty} | ${s.title} | ${s.orch} | ${s.repo} | ${s.branch} | ${s.top} | ${s.plan}`)
  // The checkout lines are the workspace's trees; a session's own clone is on its line.
  const root = workspacesRoot(ctx)
  for (const p of facts.places) if (root !== '' && p.top.startsWith(`${root}/`)) ctx.out(`checkout ${p.top} | ${p.repo} | ${p.branch}`)
  for (const h of facts.heavy) ctx.out(`heavy ${h.pid} | ${h.dir} | ${h.command}`)
  for (const line of waitingLines(ctx, facts.table)) ctx.out(line)
  for (const line of unattendedLines(ctx, facts.table)) ctx.out(line)
  for (const line of quotaLines(ctx)) ctx.out(line)
  for (const row of facts.remote) ctx.out(remoteLine(row))
  const found = collisions(facts)
  for (const line of found) ctx.out(line)
  return finish(ctx, facts, found.length > 0 ? 1 : 0)
}

/** What a check reports: each orchestrator's name (a successor under it is no newcomer), each collision and each source not read, one line each. */
export function findings(facts: Facts): string[] {
  return [
    ...new Set(facts.sessions.filter(s => s.title.startsWith(`${ORCH}:`)).map(s => `newcomer ${s.title}`)),
    ...collisions(facts),
    ...facts.unread.map(line => `unread ${line}`),
  ]
}

/**
 * The findings not reported at the last check, kept in <state>/coordinator-check.json; the first
 * check reports none. With --every <seconds> it reads again at that pace until it has one: run in
 * the background, it wakes its session only on a finding.
 */
export function checkCommand(ctx: Context, args: readonly string[]): number {
  const every = args[0] === '--every' && args.length === 2 ? Number(args[1]) : args.length === 0 ? 0 : NaN
  if (!Number.isInteger(every) || every < 0) die(`check: usage: check [--every <seconds>]`)
  const path = join(dataOf(ctx.env), 'coordinator-check.json')
  for (;;) {
    const was = parseJson(readFile(path) ?? '')
    const now = findings(readFacts(ctx))
    try {
      writeAtomic(path, `${JSON.stringify(now)}\n`)
    } catch {
      say(ctx, `check: cannot record the findings in ${path}`)
    }
    const fresh = Array.isArray(was) ? now.filter(line => !was.includes(line)) : []
    for (const line of fresh) ctx.out(line)
    if (fresh.length > 0 || every === 0) return 0
    ctx.sleep(every * 1000)
  }
}

/** One owner row: the pull request, its branch, the orchestrator or « unknown », and the evidence. */
export interface Owner {
  readonly pr: Pr
  readonly orch: string
  readonly evidence: string
}

/**
 * One row per pull request and session found on its branch, or one « unknown » row where the
 * chain breaks or allows two answers: a head in a fork (its branch name is no branch of ours), a
 * checkout on the branch with no session beside one with a session, two orchestrators named in
 * one checkout.
 */
export function ownersTable(facts: Facts): Owner[] {
  const owners: Owner[] = []
  for (const pr of facts.prs) {
    const unknown = (evidence: string) => owners.push({ pr, orch: 'unknown', evidence })
    if (pr.head.startsWith('fork:')) {
      unknown(`head branch in a fork, owned by ${pr.head.slice(5)}`)
      continue
    }
    const tops = facts.places.filter(p => p.repo === pr.repo && p.branch === pr.branch).map(p => p.top)
    const there = (top: string) => facts.sessions.filter(s => s.top === top && s.repo === pr.repo && s.branch === pr.branch)
    const busy = tops.filter(t => there(t).length > 0)
    const idle = tops.filter(t => there(t).length === 0)
    if (busy.length === 0) {
      unknown(idle.length === 0 ? `no checkout on ${pr.branch}` : `no session in ${idle.join(', ')}`)
      continue
    }
    if (idle.length > 0) {
      unknown(`no session in ${idle.join(', ')}, beside a session in ${busy.join(', ')}`)
      continue
    }
    for (const top of tops) {
      const sessions = there(top)
      const orchs = [...new Set(sessions.map(s => s.orch))]
      if (orchs.length > 1) {
        unknown(`sessions ${sessions.map(s => s.pid).join(', ')} in ${top} name different orchestrators: ${orchs.join(', ')}`)
        continue
      }
      for (const s of sessions) {
        if (s.orch === 'unknown') unknown(`session ${s.pid} in ${top}${s.why.startsWith('names ') ? ' ' : ': '}${s.why}`)
        else owners.push({ pr, orch: s.orch, evidence: `session ${s.pid} in ${top}` })
      }
    }
  }
  return owners
}

/** The sleeping orchestrators' pull requests, `<repository>#<n>` to its name and since when it sleeps. */
function asleepOf(ctx: Context, unread: string[]): Map<string, { name: string; since: string }> {
  const asleep = new Map<string, { name: string; since: string }>()
  let records: unknown[] = []
  try {
    records = readSleeping(stateOf(ctx.env))
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    unread.push(`sleeping: ${error.message}`)
  }
  for (const record of records) {
    const one = fieldsOf(record)
    const prs = one['prs']
    if (!Array.isArray(prs)) continue
    for (const pr of prs) {
      if (typeof pr !== 'string') continue
      try {
        asleep.set(pr.split(' ')[0] ?? '', { name: cell(one['name']), since: cell(one['slept']) })
      } catch {
        // A name that is no scalar: not its own.
      }
    }
  }
  return asleep
}

export function ownersCommand(ctx: Context, args: readonly string[]): number {
  if (args.length > 0) die(`owners: unexpected argument ${args[0]}`)
  const facts = readFacts(ctx)
  // A sleeping orchestrator has no session, so the chain breaks on each of its pull requests:
  // the ones its record lists are its own, never « unknown » and never chased.
  const asleep = asleepOf(ctx, facts.unread)
  // A remote row listing an « unknown » pull request names its orchestrator, before a sleeping
  // record would; a pull request the remote rows list in a repository not read here comes last.
  const remote = groupsOf(facts.remotePrs, r => (r.branch === '-' ? undefined : `${r.key}#${r.num}`),
    r => `pr ${r.key}#${r.num} | ${r.branch} | ${r.name} | remote on ${r.machine}, updated ${r.at}`)
  const said = new Set<string>()
  for (const { pr, orch, evidence } of ownersTable(facts)) {
    const k = `${pr.repo}#${pr.num}`
    const rows = remote.get(k)
    const sleeper = asleep.get(k)
    if (orch === 'unknown' && rows !== undefined) {
      if (!said.has(k)) rows.forEach(row => ctx.out(row))
      said.add(k)
    } else if (orch === 'unknown' && sleeper !== undefined) {
      if (!said.has(k)) ctx.out(`pr ${k} | ${pr.branch} | ${sleeper.name} | sleeping since ${sleeper.since}`)
      said.add(k)
    } else ctx.out(`pr ${k} | ${pr.branch} | ${orch} | ${evidence}`)
  }
  for (const r of facts.remotePrs) {
    if (r.branch === '-') ctx.out(`pr ${r.key}#${r.num} | - | ${r.name} | remote on ${r.machine}, updated ${r.at}, not read on the forge here`)
  }
  return finish(ctx, facts, 0)
}
