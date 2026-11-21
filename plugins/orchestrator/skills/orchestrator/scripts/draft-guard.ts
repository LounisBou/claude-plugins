// draft-guard — which failing checks of a draft pull request are draft guards.
//
//   draft-guard.sh <owner/repo> <pr> [--dependents] < <the pull request's `pr-gate --json` answer>
//
// Some repositories run a job that fails on purpose while a pull request is a draft (a draft
// guard). A failing check of a DRAFT pull request is one when the job that produced it tests the
// draft flag (`pull_request.draft`) in its own definition. `ci-watch.sh` reads a red that is no red
// otherwise; no repository is named anywhere, and every other red of a draft is still reported.
//
// CI is read once, by the github gate: its answer comes on stdin (its `draft`, `ci.failed` and
// `ci.checks`, each counted check with its bucket and link); this script reads no check itself.
//
// As a command: prints the gate's failing names (`ci.failed`) that are NOT draft guards, one per
// line; a pull request that is not a draft prints every failing name. Exit 0, or 5 with one line on
// stderr when the answer is no gate's.
//
// With `--dependents`: on a draft, prints instead the names of the passed checks (bucket `pass`)
// whose job needs a job that is one of the draft's guards, one per line; on a pull request that is
// no draft, nothing. Same exit codes. `ci-watch.sh` reads it to say green on a draft only when a
// job behind its guard ran and passed: a check that does not depend on the guard (a secret
// scanner, say) passes whether or not the real jobs ran.
//
// `guards` classifies per check: the run id of its link (`/actions/runs/<run>/job/<job>`), the
// run's workflow path and head sha, that file at that sha, the job named by the check's first
// segment (`a / b` reads `a`), and, when that job is `uses: ./.github/workflows/<file>` (a local
// reusable workflow), the called file at the same sha and its job named by the second segment. A
// job is a guard when its own block, the called job's block for a reusable one, contains
// `pull_request.draft`. Anything unread, unmatched or unparseable is NOT a guard: the default is
// the red reported, never a red lost.
//
// `dependents` answers the checks in bucket `pass` whose job, in the workflow file of the run's
// head sha, lists in its `needs` (`needs: a`, `needs: [a, b]`, or a block list) the job of a guard
// in the same file. Here the default is the other way round, since a green is at stake: anything
// unread, unmatched or unparseable is NOT a dependent, the green withheld, never invented.
//
// The workflow files are read without a YAML library (the plugin ships no dependency): `jobs:` at
// the left margin, then one key per job at the first indentation below it, a job's block running
// to the next key of that indentation.
//
// The cache lives in `<data root>/draft-guard`, one file per repository, workflow path and head sha
// holding the verdict per check name, so a head already classified costs no call; a run is bound
// to its path and sha for good, and that binding is kept too. Entries older than seven days are
// removed whenever one is written. A verdict that could not be read is never kept.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { setting, type Env } from '../../../core/paths.ts'
import { orchestratorRoots } from '../../../core/roots.ts'
import { writeAtomic } from '../../../core/store.ts'
import { isEntry, processIo, type Io } from './lib/process.ts'

export const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000
export const CALL_TIMEOUT_MS = 30_000
const DRAFT_TEST = 'pull_request.draft'
const LINK_RUN = /\/actions\/runs\/(\d+)(?:\/|$)/
const LOCAL_WORKFLOW = /^\.\/(\.github\/workflows\/[^/\s]+\.ya?ml)$/
const SEGMENT_SEPARATOR = ' / '

/** A read that failed: the caller treats the check as no guard. */
export class Unread extends Error {}

/** `gh` with its arguments: its stdout, or Unread. */
export type Gh = (argv: readonly string[]) => string

/** One check as the gate's `ci.checks` lists it (`name`, `bucket`, `link`); any field may be missing. */
type Check = Readonly<Record<string, unknown>>

/** The stdout of `gh <argv>` (the workflow runs and files it reads); Unread when it cannot run or exits non-zero. */
export function runGh(argv: readonly string[]): string {
  const done = spawnSync('gh', argv, { encoding: 'utf8', timeout: CALL_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
  if (done.error !== undefined) throw new Unread(`gh cannot run: ${done.error.message}`)
  if (done.status === 0) return done.stdout
  throw new Unread(`gh ${argv.slice(0, 2).join(' ')} failed: ${done.stderr.trim().split(/\r?\n/)[0] || 'no answer'}`)
}

// --- the workflow file, read without a YAML library --------------------------------------------

const indent = (line: string): number => line.length - line.replace(/^ +/, '').length

/** The line without its trailing comment; blank when it is only one. */
export function content(line: string): string {
  let quote: string | null = null
  for (let n = 0; n < line.length; n++) {
    const char = line[n] ?? ''
    if (quote !== null) quote = char === quote ? null : quote
    else if (char === '\'' || char === '"') quote = char
    else if (char === '#' && (n === 0 || line[n - 1] === ' ' || line[n - 1] === '\t')) return line.slice(0, n).trimEnd()
  }
  return line.trimEnd()
}

function unquote(value: string): string {
  const bare = value.trim()
  const first = bare[0]
  return bare.length >= 2 && first === bare.at(-1) && (first === '\'' || first === '"') ? bare.slice(1, -1) : bare
}

/** {job id: block lines} of a workflow file: the lines of each job under `jobs:`, comment lines left out. */
export function jobsOf(text: string): Map<string, string[]> {
  const lines = text.split(/\r\n|\r|\n/).map(content)
  const jobs = new Map<string, string[]>()
  const start = lines.findIndex(line => /^jobs\s*:\s*$/.test(line))
  if (start < 0) return jobs
  let keyIndent: number | null = null
  let current: string[] | null = null
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue
    const depth = indent(line)
    if (depth === 0) break // the next top-level key: `jobs:` is over
    keyIndent ??= depth
    if (depth === keyIndent) {
      const key = /^\s*([^\s:#][^:]*?)\s*:/.exec(line)?.[1]
      current = key === undefined ? null : [line]
      if (key !== undefined && current !== null) jobs.set(unquote(key), current)
    } else if (depth > keyIndent && current !== null) current.push(line)
  }
  return jobs
}

/** The value of a direct child key (`name:`, `uses:`) of a job block, or null. */
export function field(block: readonly string[], name: string): string | null {
  const child = block.slice(1).find(line => line.trim() !== '')
  if (child === undefined) return null
  const pattern = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.*)$`)
  for (const line of block.slice(1)) {
    if (indent(line) !== indent(child)) continue
    const match = pattern.exec(line)
    if (match) return unquote(match[1] ?? '')
  }
  return null
}

/** The id of the job whose id, or whose `name:`, is `wanted`; null when no job is. */
export function findJobId(jobs: ReadonlyMap<string, readonly string[]>, wanted: string): string | null {
  if (jobs.has(wanted)) return wanted
  for (const [id, block] of jobs) if (field(block, 'name') === wanted) return id
  return null
}

/**
 * The job ids a job block lists in `needs`: `needs: a`, `needs: [a, b]`, or a block list. A flow
 * list spread over several lines is not read: it lists nothing.
 */
export function needsOf(block: readonly string[]): string[] {
  const value = field(block, 'needs')
  if (value === null) return []
  if (value.startsWith('[')) return value.endsWith(']') ? value.slice(1, -1).split(',').filter(item => item.trim() !== '').map(unquote) : []
  if (value !== '') return [unquote(value)]
  const child = indent(block.slice(1).find(line => line.trim() !== '') ?? '')
  const at = block.findIndex((line, n) => n > 0 && indent(line) === child && /^\s*needs\s*:/.test(line))
  const found: string[] = []
  for (const line of block.slice(at + 1)) {
    if (line.trim() === '') continue
    if (indent(line) < child || !line.trimStart().startsWith('-')) break
    found.push(unquote(line.trimStart().slice(1)))
  }
  return found
}

const testsDraft = (block: readonly string[]): boolean => block.some(line => line.includes(DRAFT_TEST))

/**
 * Is the check `name`, produced by a job of the workflow file `path`, a draft guard? `readFile(path)`
 * returns a workflow file's text, or throws Unread.
 */
export function classify(name: string, readFile: (path: string) => string, path: string): boolean {
  const segments = name.split(SEGMENT_SEPARATOR)
  const jobs = jobsOf(readFile(path))
  const id = findJobId(jobs, (segments[0] ?? '').trim())
  const block = id === null ? undefined : jobs.get(id)
  if (block === undefined) return false
  const uses = field(block, 'uses')
  if (uses === null) return testsDraft(block)
  const local = LOCAL_WORKFLOW.exec(uses)?.[1]
  if (local === undefined || segments.length < 2) return false
  const called = jobsOf(readFile(local))
  const calledId = findJobId(called, (segments[1] ?? '').trim())
  const calledBlock = calledId === null ? undefined : called.get(calledId)
  return calledBlock !== undefined && testsDraft(calledBlock)
}

// --- the cache ---------------------------------------------------------------------------------

function entryPath(cacheDir: string, kind: string, ...parts: string[]): string {
  return join(cacheDir, `${kind}-${createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex').slice(0, 40)}.json`)
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function load(path: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isObject(data) ? data : {}
  } catch {
    return {}
  }
}

function prune(cacheDir: string, now: number): void {
  for (const entry of readdirSync(cacheDir)) {
    const full = join(cacheDir, entry)
    try {
      const stat = statSync(full)
      if (stat.isFile() && stat.mtimeMs < now - CACHE_MAX_AGE_MS) unlinkSync(full)
    } catch {
      // gone, or not ours to remove: the next write tries again
    }
  }
}

/*
 * Written whole under a unique temporary name and renamed in place (core's writeAtomic): a link
 * planted in the data root at a slot or at a temporary name is never written through. A cache that
 * cannot be written is no cache.
 */
function store(cacheDir: string, path: string, data: Readonly<Record<string, unknown>>): void {
  try {
    mkdirSync(cacheDir, { recursive: true })
    prune(cacheDir, Date.now())
    writeAtomic(path, JSON.stringify(data))
  } catch {
    // no cache this time
  }
}

// --- reading a check ---------------------------------------------------------------------------

export function runOf(link: unknown): string | null {
  if (link !== undefined && link !== null && typeof link !== 'string') throw new TypeError('a link that is no string')
  return LINK_RUN.exec(link ?? '')?.[1] ?? null
}

function apiJson(gh: Gh, url: string): Record<string, unknown> {
  let data: unknown
  try {
    data = JSON.parse(gh(['api', url]))
  } catch (error) {
    if (error instanceof Unread) throw error
    throw new Unread(`gh api ${url} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isObject(data)) throw new Unread(`gh api ${url}: no object`)
  return data
}

/** (workflow path, head sha) of a run: a run never changes, so it is kept for good. */
function readRun(repo: string, run: string, cacheDir: string, gh: Gh): [string, string] {
  const slot = entryPath(cacheDir, 'run', repo, run)
  const kept = load(slot)
  if (typeof kept['path'] === 'string' && kept['path'] !== '' && typeof kept['sha'] === 'string' && kept['sha'] !== '') return [kept['path'], kept['sha']]
  const data = apiJson(gh, `repos/${repo}/actions/runs/${run}`)
  const path = data['path']
  const sha = data['head_sha']
  if (typeof path !== 'string' || typeof sha !== 'string' || path === '' || sha === '') throw new Unread(`run ${run}: no path or head sha`)
  const bare = path.split('@')[0] ?? path // a run of a reusable workflow may read `<path>@<ref>`
  store(cacheDir, slot, { path: bare, sha })
  return [bare, sha]
}

/** Python's `urllib.parse.quote`: every byte but letters, digits, `_.-~` and the `safe` ones escaped. */
function quote(text: string, safe: string): string {
  return encodeURIComponent(text)
    .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, match => (safe.includes('/') ? '/' : match))
}

function readFile(repo: string, path: string, sha: string, gh: Gh): string {
  const data = apiJson(gh, `repos/${repo}/contents/${quote(path, '/')}?ref=${quote(sha, '')}`)
  const text = data['content']
  if (typeof text !== 'string') throw new Unread(`${path} at ${sha}: no readable content`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(text, 'base64'))
  } catch {
    throw new Unread(`${path} at ${sha}: no readable content`)
  }
}

/** A function reading a workflow file at a sha, once per call of the caller. */
function reader(repo: string, gh: Gh): (path: string, sha: string) => string {
  const texts = new Map<string, string>()
  return (path, sha) => {
    const key = `${path}\0${sha}`
    const known = texts.get(key)
    if (known !== undefined) return known
    const text = readFile(repo, path, sha, gh)
    texts.set(key, text)
    return text
  }
}

const listOf = (checks: unknown): unknown[] => (Array.isArray(checks) ? checks : [])

/** One check's fields, or null when it is no object. */
const checkOf = (check: unknown): Check | null => (isObject(check) ? check : null)

/**
 * The names of the failing checks (bucket `fail`) of a draft pull request that are draft guards.
 * Anything unread, unmatched or unparseable is not one.
 */
export function guards(repo: string, checks: unknown, cacheDir: string, gh: Gh): Set<string> {
  const found = new Set<string>()
  const readOnce = reader(repo, gh)
  for (const raw of listOf(checks)) {
    try {
      const check = checkOf(raw)
      if (check === null || check['bucket'] !== 'fail') continue
      const name = check['name']
      const run = runOf(check['link'])
      if (typeof name !== 'string' || name === '' || run === null) continue
      const [path, sha] = readRun(repo, run, cacheDir, gh)
      const slot = entryPath(cacheDir, 'workflow', repo, path, sha)
      const verdicts = load(slot)
      if (!Object.hasOwn(verdicts, name)) {
        verdicts[name] = classify(name, p => readOnce(p, sha), path)
        store(cacheDir, slot, verdicts)
      }
      if (verdicts[name] === true) found.add(name)
    } catch {
      // unread, unmatched, unparseable: the red is reported
    }
  }
  return found
}

/**
 * The names of the checks in bucket `pass` whose job needs the job of a guard of the same workflow
 * file at the same sha. Anything unread, unmatched or unparseable is not one.
 */
export function dependents(repo: string, checks: unknown, guardNames: Iterable<string>, cacheDir: string, gh: Gh): string[] {
  const wanted = new Set(guardNames)
  const readOnce = reader(repo, gh)
  const guardJobs = new Set<string>()
  const passed: { name: string; path: string; sha: string; block: string[] }[] = []
  for (const raw of listOf(checks)) {
    try {
      const check = checkOf(raw)
      if (check === null) continue
      const bucket = check['bucket']
      const name = check['name']
      const run = runOf(check['link'])
      if ((bucket !== 'fail' && bucket !== 'pass') || typeof name !== 'string' || name === '' || run === null) continue
      if (bucket === 'fail' && !wanted.has(name)) continue
      const [path, sha] = readRun(repo, run, cacheDir, gh)
      const jobs = jobsOf(readOnce(path, sha))
      const id = findJobId(jobs, (name.split(SEGMENT_SEPARATOR)[0] ?? '').trim())
      const block = id === null ? undefined : jobs.get(id)
      if (id === null || block === undefined) continue
      if (bucket === 'fail') guardJobs.add(`${path}\0${sha}\0${id}`)
      else passed.push({ name, path, sha, block })
    } catch {
      // unread, unmatched, unparseable: not a dependent
    }
  }
  const found: string[] = []
  for (const { name, path, sha, block } of passed) {
    if (!found.includes(name) && needsOf(block).some(id => guardJobs.has(`${path}\0${sha}\0${id}`))) found.push(name)
  }
  return found
}

// --- the command -------------------------------------------------------------------------------

export interface Deps {
  readonly io: Io
  /** `gh` with its arguments: the workflow runs and files it reads. */
  readonly gh: (argv: readonly string[]) => string
  readonly cacheDir: string
  /** The gate's answer the caller gives on stdin. */
  readonly stdin: () => string
}

export const USAGE = 'usage: draft-guard.sh <owner/repo> <pr> [--dependents] < <pr-gate --json answer>'

/** Runs one command line; the exit code. */
export function main(argv: readonly string[], deps: Deps): number {
  const behind = argv.length === 3 && argv[2] === '--dependents'
  const [repo = '', pr = ''] = argv
  if (argv.length !== (behind ? 3 : 2) || !repo.includes('/') || !/^\d+$/.test(pr)) {
    deps.io.err(`${USAGE}\n`)
    return 5
  }
  let draft: boolean
  let failed: string[]
  let checks: unknown[]
  try {
    const gate: unknown = JSON.parse(deps.stdin())
    const ci = isObject(gate) ? gate['ci'] : undefined
    if (!isObject(gate) || typeof gate['draft'] !== 'boolean' || !isObject(ci) || !Array.isArray(ci['failed']) || !Array.isArray(ci['checks'])) throw new TypeError('no gate answer')
    draft = gate['draft']
    failed = ci['failed'].filter((name): name is string => typeof name === 'string' && name !== '')
    checks = ci['checks']
  } catch {
    deps.io.err('draft_guard: stdin holds no pr-gate answer (draft, ci.failed, ci.checks)\n')
    return 5
  }
  const gh: Gh = args => deps.gh(args)
  const dropped = draft ? guards(repo, checks, deps.cacheDir, gh) : new Set<string>()
  const names = behind
    ? (draft ? dependents(repo, checks, dropped, deps.cacheDir, gh) : [])
    : [...new Set(failed)].filter(name => !dropped.has(name))
  for (const name of names) deps.io.out(`${name}\n`)
  return 0
}

/** The cache directory under the orchestrator's data root. */
export function cacheDirOf(env: Env): string {
  return join(orchestratorRoots(env, setting(env, 'HOME')).dataRoot, 'draft-guard')
}

/* node:coverage ignore next 3 */
if (isEntry(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), { io: processIo, gh: runGh, cacheDir: cacheDirOf(process.env), stdin: () => readFileSync(0, 'utf8') })
}
