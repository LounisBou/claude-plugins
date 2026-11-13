// workspace — a checkout per phase, with the project's local material.
//
//   workspace.sh create <source-repo> <name> [--base <branch|origin/branch>]   prints the checkout's path; --base <branch> starts from origin/<branch>, the local branch only when origin has none
//   workspace.sh pin <source-repo> <name> <ref> [--pr <n>]     a detached worktree at that commit, of the local material only the global excludes' files; prints its path
//   workspace.sh delete <path> [--discard]                     refuses unpushed work unless told; also removes the host's
//                                                              temporary directory of the path when no live process uses it
//   workspace.sh sweep [--deadline <seconds>] [--dry-run]      the leftovers, decided on facts: one line per item,
//                                                              "deleted <path>" | "kept <path>: <reason>" (a dry run says "would delete")
//   workspace.sh list                                          one line per checkout under the root (a pin reads HEAD … pinned)
//
// Root: ORCHESTRATOR_WORKSPACES, else ~/dev/workspaces. A checkout lives at
// <root>/<basename of the source>/<name>.
//
// Host temporary area: ORCHESTRATOR_HOST_TMP, else /private/tmp/claude-<uid>. The host keeps
// one directory per working directory a session ran in, named after that path with every
// character that is not a letter or a digit turned into `-` (`/a/.b_c` is `-a--b-c`; see
// `encode`); it holds the session's scratch. It leaves with its checkout (design §61).
//
// The one safety rule over every deletion here: never a dirty tree, unpushed commits (on a
// branch or on a detached head) or a stash, a pin whose head is on no branch, or a directory a
// live process has as its working directory (`lsof`, bounded; a process table that cannot be
// read is a refusal, never a « nothing there »; so is a checkout git cannot read).
// `--discard` overrides every guard on the checkout itself, a live process inside it included.
// It never overrides the guard on a host temporary directory, which `delete` and `sweep` both
// keep while a live process works in the directory it is named after or below it (a session's
// host directory is named after the directory the session started in, not after its scratch),
// or inside the host directory itself.
// A file git ignores is not work: it is what the project or the operator keeps out of history
// (build output, caches, the local material `create` copies from the source, which keeps the
// original), and `create` makes the copied material ignored precisely so that it never holds a
// delete. What a phase delivers is committed and pushed, and the guards hold that.
//
// Manifest: <repo>/.claude/workspace-manifest, one repository-relative path per line, `#`
// starts a comment; an absent path is said on stderr and skipped, and a path leaving the
// repository is refused.
//
// Why it exists: a git worktree writes into its source repository, so no single sandbox
// path contains it; a clone does, and a clone per phase makes the one-writer rule a fact
// instead of a queue. But a clone carries what git tracks and nothing else — not the
// project's local settings directory, not what its exclude file keeps out of history, not
// an environment file — so a session in it behaved like a stranger's. The copy is part of
// making the checkout, not a step after it (design §30).
//
// The script never writes the host's trust record (that is `spawn --trust`), never
// launches anything, and never touches the source. A pin writes nothing into the source
// but its worktree metadata.
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, appendFileSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { setting, stateDir, type Env } from '../../../core/paths.ts'
import { writeAtomic } from '../../../core/store.ts'
import { isEntry, processIo, run, type Io, type Ran, type Run } from './lib/process.ts'

export const USAGE = 'usage: workspace.sh {create|pin|delete|sweep|list} ... (see header)'

/** How long the process table is given to answer. */
export const LSOF_MS = 20_000
/** The most a pull-request list is given, in seconds; a sweep's deadline cuts it shorter. */
export const GH_SECONDS = 60
/** A cached pull-request list is asked again past this age. */
export const PRS_FRESH_MS = 30 * 60_000
/** Branches a pull request of another fork shares by name: never swept on a name. */
export const LONG_LIVED = ['main', 'master', 'develop', 'trunk'] as const

export interface Deps {
  readonly io: Io
  readonly env: Env
  readonly run: Run
  readonly now: () => number
  /** The directory relative paths are read against, as the shell's logical `pwd` names it. */
  readonly cwd: string
  readonly uid: number
}

/** A refusal: said on stderr as `workspace: <message>`, exit 1. */
export class Refused extends Error {}

interface Context {
  readonly deps: Deps
  readonly root: string
  readonly hostTmp: string
  /** Aborted at a sweep's deadline: every command a sweep runs is cancelled then. */
  readonly signal?: AbortSignal
  cwds?: readonly string[] | null
  liveNames?: ReadonlySet<string> | null
}

function say(ctx: Context, text: string): void {
  ctx.deps.io.err(`workspace: ${text}\n`)
}

function out(ctx: Context, text: string): void {
  ctx.deps.io.out(`${text}\n`)
}

/** The text a shell's `$(…)` keeps: the output without its trailing newlines. */
function chomp(text: string): string {
  return text.replace(/\n+$/, '')
}

async function git(ctx: Context, dir: string, args: readonly string[], signal?: AbortSignal): Promise<Ran> {
  const s = signal ?? ctx.signal
  return ctx.deps.run(['git', '-C', dir, ...args], { stderr: 'pipe', ...(s === undefined ? {} : { signal: s }) })
}

/** The output of a git read that succeeded, else undefined. */
async function gitOut(ctx: Context, dir: string, args: readonly string[]): Promise<string | undefined> {
  const r = await git(ctx, dir, args)
  return r.status === 0 ? chomp(r.stdout) : undefined
}

/** The NUL-separated listing of a git read; an empty one when the read fails, as a shell's process substitution reads it. */
async function gitList(ctx: Context, dir: string, args: readonly string[]): Promise<string[]> {
  const r = await git(ctx, dir, args)
  if (r.status !== 0) return []
  return r.stdout.split('\0').filter(f => f !== '')
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Whether something is at `path`, a dangling link included. */
function present(path: string): boolean {
  return existsSync(path) || isSymlink(path)
}

function realOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The directories `<dir>/*` names, in order, as a shell glob lists them: no dot entries, links to directories included. */
function subdirs(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.filter(n => !n.startsWith('.')).sort().map(n => join(dir, n)).filter(isDir)
}

/** The checkouts' directories, `<root>/*\/*`, joined as the shell joins them. */
function checkoutDirs(root: string): string[] {
  return subdirs(root).flatMap(project => subdirs(project).map(d => `${root}/${basename(project)}/${basename(d)}`))
}

function rmTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // What could not be removed stays; the caller reads the path's presence.
  }
}

/**
 * The name the host gives a directory's temporary directory: every character that is not a
 * letter or a digit turned into `-`, the host's own rule, read on its live entries
 * (`/srv/me/.cfg` is `-srv-me--cfg`). The one spelling every comparison uses.
 */
export function encode(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * Every directory a working directory lies in, itself first, up to the root. A name with no
 * slash left to cut (a relative name the process table may print) ends the walk.
 */
export function ancestors(path: string): string[] {
  const found: string[] = []
  let p = path
  while (p !== '' && p !== '/') {
    found.push(p)
    const cut = p.lastIndexOf('/')
    if (cut < 0) break
    p = p.slice(0, cut)
  }
  return found
}

/** The working directories `lsof -Fn` prints, or null when the table cannot be read. */
export function parseCwds(ran: Ran): string[] | null {
  if (ran.stdout === '' || ran.status === null || ran.status === 124 || ran.status >= 128) return null
  return ran.stdout.split('\n').filter(l => l.startsWith('n')).map(l => l.slice(1))
}

/** The working directory of every live process, read once per run; null when the table cannot be read. */
async function readCwds(ctx: Context): Promise<readonly string[] | null> {
  if (ctx.cwds !== undefined && ctx.cwds !== null) return ctx.cwds
  const signals = [AbortSignal.timeout(LSOF_MS), ...(ctx.signal === undefined ? [] : [ctx.signal])]
  const cwds = parseCwds(await ctx.deps.run(['lsof', '-a', '-d', 'cwd', '-Fn'], { signal: AbortSignal.any(signals) }))
  ctx.cwds = cwds
  return cwds
}

type Live = { readonly live: true; readonly why: string } | { readonly live: false } | { readonly unreadable: true }

/** Whether a live process works in `dir` or under it. */
async function liveInside(ctx: Context, dir: string): Promise<boolean | null> {
  const cwds = await readCwds(ctx)
  if (cwds === null) return null
  return cwds.some(c => c !== '' && `${c}/`.startsWith(`${dir}/`))
}

/**
 * The host's name of every live process's working directory and of each of its ancestors. A
 * session's host directory is named after the directory the session STARTED in, while its cwd
 * is wherever it works now — that directory or below it — and never the host directory itself.
 */
async function readLiveNames(ctx: Context): Promise<ReadonlySet<string> | null> {
  if (ctx.liveNames !== undefined && ctx.liveNames !== null) return ctx.liveNames
  const cwds = await readCwds(ctx)
  if (cwds === null) return null
  ctx.liveNames = new Set(cwds.flatMap(ancestors).map(encode))
  return ctx.liveNames
}

/** Whether a live process may still use a host temporary directory, and why. */
async function hostDirLive(ctx: Context, dir: string): Promise<Live> {
  const names = await readLiveNames(ctx)
  if (names === null) return { unreadable: true }
  if (names.has(basename(dir))) return { live: true, why: 'a live process works in the directory it is named after' }
  const inside = await liveInside(ctx, realOf(dir))
  if (inside === null) return { unreadable: true }
  return inside ? { live: true, why: 'a live process works inside' } : { live: false }
}

function liveWhy(state: Live): string {
  return 'why' in state ? state.why : 'the process table cannot be read'
}

/** Why the checkout or pin at `real` may not be deleted, or '' when nothing holds it. */
export async function refusal(ctx: Context, real: string): Promise<string> {
  const read = async (args: readonly string[]): Promise<string | { readonly why: string }> => {
    const r = await git(ctx, real, args)
    if (r.status === 0) return chomp(r.stdout)
    const first = r.stderr.split('\n')[0] ?? ''
    return { why: `git cannot read the checkout: ${first === '' ? `git ${args[0] ?? ''} failed` : first}` }
  }
  const status = await read(['status', '--porcelain'])
  if (typeof status !== 'string') return status.why
  if (status !== '') return 'the tree is dirty'
  if (isFile(join(real, '.git'))) {
    const on = await read(['for-each-ref', '--count=1', '--contains', 'HEAD', 'refs/heads', 'refs/remotes'])
    if (typeof on !== 'string') return on.why
    if (on === '') return "the pin's head is on no branch of the source"
  } else {
    // HEAD as well as the branches: a commit on a detached head is on none of them. A stash is
    // on none either. (A pin shares its source's stash, so it is not asked there.)
    const unpushed = await read(['log', 'HEAD', '--branches', '--not', '--remotes', '--oneline'])
    if (typeof unpushed !== 'string') return unpushed.why
    if (unpushed !== '') return 'commits on no remote branch'
    const stash = await read(['for-each-ref', '--count=1', 'refs/stash'])
    if (typeof stash !== 'string') return stash.why
    if (stash !== '') return 'a stash is held'
  }
  const inside = await liveInside(ctx, real)
  if (inside === null) return 'the process table cannot be read'
  return inside ? 'a live process has its working directory inside' : ''
}

// The trashes: a removal first moves its directory into one, in a single rename (each trash
// lives beside what it takes, so on its filesystem), then removes it there. A removal killed
// half way leaves its remains in the trash, never a partial checkout at its path that reads as
// dirty for ever; `sweep` empties the trashes first. Their names start with a dot, so no loop
// over the root or the host's area ever reads them as a checkout or an orphan.
const hostTrash = (ctx: Context): string => join(ctx.hostTmp, '.workspace-trash')
const rootTrash = (ctx: Context): string => join(realOf(ctx.root), '.trash')

/** False when the move failed and nothing was touched; true once the directory has left its path. */
export function trashRemove(ctx: Context, dir: string, trash: string): boolean {
  let t: string
  try {
    mkdirSync(trash, { recursive: true })
    t = mkdtempSync(join(trash, 'x'))
  } catch {
    return false
  }
  try {
    renameSync(dir, join(t, basename(dir)))
  } catch {
    try {
      rmdirSync(t)
    } catch {
      // An empty directory the next sweep empties.
    }
    return false
  }
  rmTree(t)
  if (present(t)) say(ctx, `the trash keeps ${t}: the next sweep empties it`)
  return true
}

/** The host's temporary directory of each spelling of a deleted checkout, unless a live process uses it. */
async function removeHostTmp(ctx: Context, paths: readonly string[]): Promise<void> {
  if (!/^\/./.test(ctx.hostTmp)) return
  const seen = new Set<string>()
  for (const p of paths) {
    const name = encode(p)
    if (name === '' || name === '-' || seen.has(name)) continue
    seen.add(name)
    const dir = `${ctx.hostTmp}/${name}`
    if (!isDir(dir) || isSymlink(dir)) continue
    const state = await hostDirLive(ctx, dir)
    if (!('live' in state) || state.live) {
      say(ctx, `kept host temporary directory ${dir}: ${liveWhy(state)}`)
      continue
    }
    trashRemove(ctx, dir, hostTrash(ctx))
    if (present(dir)) say(ctx, `kept host temporary directory ${dir}: it could not be removed`)
    else out(ctx, `deleted ${dir}`)
  }
}

/** The path a pass stopped at and what the filesystem said. */
export interface CopyFailure {
  readonly path: string
  readonly error: string
}

/**
 * A path the pass may copy: a file or a link. A nested repository or worktree (git lists it as a
 * directory) and anything inside a git directory belong to their own repository, never to this copy.
 */
export function copyable(rel: string): boolean {
  return !rel.endsWith('/') && !rel.split('/').includes('.git')
}

/** Every path in one pass, each kept at its place under the root; the first failure, or undefined. */
export function copyFiles(from: string, to: string, paths: readonly string[]): CopyFailure | undefined {
  for (const rel of paths) {
    try {
      const source = join(from, rel)
      const target = join(to, rel)
      mkdirSync(dirname(target), { recursive: true })
      const info = lstatSync(source)
      if (info.isSymbolicLink()) {
        rmSync(target, { force: true })
        symlinkSync(readlinkSync(source), target)
      } else {
        copyFileSync(source, target)
        chmodSync(target, info.mode & 0o7777)
      }
    } catch (e) {
      return { path: rel, error: e instanceof Error ? e.message : String(e) }
    }
  }
  return undefined
}

/** Every path in one pass, each kept at its place under the root; false when the copy fails. */
export function copyList(from: string, to: string, paths: readonly string[]): boolean {
  return copyFiles(from, to, paths) === undefined
}

/** One manifest path, file or directory: 'absent' when the source has none, 'failed' when the copy fails. */
function copyTree(from: string, to: string, rel: string): 'copied' | 'absent' | 'failed' {
  const source = join(from, rel)
  if (!existsSync(source)) return 'absent'
  try {
    mkdirSync(dirname(join(to, rel)), { recursive: true })
    cpSync(source, join(to, rel), { recursive: true, verbatimSymlinks: true, force: true })
    return 'copied'
  } catch {
    return 'failed'
  }
}

/** The exclude file's lines, less those naming the settings directory whole. */
export function settingsRules(exclude: string): string {
  const lines = exclude.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.filter(line => {
    const l = line.endsWith('/') ? line.slice(0, -1) : line
    const shape = `/${l.startsWith('/') ? l.slice(1) : l}/`
    return shape !== '/.claude/' && shape !== '/**/.claude/'
  }).map(l => `${l}\n`).join('')
}

/** A manifest line's path: the text before `#`, trimmed; '' for none. */
export function manifestPath(line: string): string {
  const hash = line.indexOf('#')
  return (hash < 0 ? line : line.slice(0, hash)).trim()
}

/** Whether a manifest path leaves the repository. */
export function leavesRepository(path: string): boolean {
  return path.startsWith('/') || path === '..' || path.startsWith('../') || path.endsWith('/..') || path.includes('/../')
}

/** Whether a manifest path is a tree that never travels. */
export function neverCopied(path: string): boolean {
  return ['.git', 'node_modules', 'vendor'].some(t => path === t || path.startsWith(`${t}/`))
}

const underSettings = (f: string): boolean => `/${f}`.startsWith('/.claude/')

/** Text with a final newline, so what is appended after it starts a line of its own. */
const asLines = (text: string): string => (text === '' || text.endsWith('\n') ? text : `${text}\n`)

interface GlobalExcluded {
  readonly files: readonly string[]
  /** The operator's global excludes file, '' when there is none. */
  readonly path: string
}

/**
 * What the OPERATOR's global excludes file keeps out of the source (§40), listed by git itself.
 * Never the settings directory, never a path the checkout already holds. With `notLocal`, never
 * a path the source's own exclude file keeps out either: that file holds the orchestrator's own
 * material, which a pin never carries (§37).
 */
async function globalExcluded(ctx: Context, src: string, target: string, notLocal: boolean): Promise<GlobalExcluded> {
  const home = setting(ctx.deps.env, 'HOME') ?? ''
  let path = (await gitOut(ctx, src, ['config', '--get', 'core.excludesFile'])) ?? ''
  if (path === '') path = `${setting(ctx.deps.env, 'XDG_CONFIG_HOME') ?? `${home}/.config`}/git/ignore`
  if (path === '~') path = home
  else if (path.startsWith('~/')) path = `${home}/${path.slice(2)}`
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    size = 0
  }
  if (size === 0) return { files: [], path: '' }
  const exclude = join(src, '.git', 'info', 'exclude')
  const locals = new Set(notLocal && isFile(exclude)
    ? await gitList(ctx, src, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${exclude}`])
    : [])
  const listed = await gitList(ctx, src, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${path}`])
  return { files: listed.filter(f => copyable(f) && !underSettings(f) && !present(join(target, f)) && !locals.has(f)), path }
}

/** How long the read of a branch on the origin may take before the origin counts as unreadable. */
const PROBE_MS = 30_000

const NAME = /^[A-Za-z0-9._-]+$/

/** The positionals and options of a command line; a refusal names what is wrong. */
function parseLine(argv: readonly string[], cmd: string, valued: readonly string[], flags: readonly string[], max: number): { pos: string[]; opts: Map<string, string> } {
  const pos: string[] = []
  const opts = new Map<string, string>()
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k] ?? ''
    if (valued.includes(a)) {
      opts.set(a, argv[k + 1] ?? '')
      k++
    } else if (flags.includes(a)) {
      opts.set(a, '')
    } else if (a.startsWith('--')) {
      throw new Refused(`${cmd}: unknown option ${a}`)
    } else if (pos.length >= max) {
      throw new Refused(`${cmd}: unexpected argument ${a}`)
    } else {
      pos.push(a)
    }
  }
  return { pos, opts }
}

/** A copy pass that stops names the path and the error on stderr, then removes the checkout. */
function copyOrFail(ctx: Context, from: string, to: string, paths: readonly string[], what: string, fail: (text: string) => never): void {
  const failure = copyFiles(from, to, paths)
  if (failure === undefined) return
  say(ctx, `copy failed at ${failure.path}: ${failure.error}`)
  fail(what)
}

async function topLevel(ctx: Context, cmd: string, src: string): Promise<string> {
  const top = await gitOut(ctx, src, ['rev-parse', '--show-toplevel'])
  if (top === undefined) throw new Refused(`${cmd}: not a git repository: ${src}`)
  return top
}

function makeParent(cmd: string, target: string): void {
  if (present(target)) throw new Refused(`${cmd}: already exists, delete it first: ${target}`)
  try {
    mkdirSync(dirname(target), { recursive: true })
  } catch {
    throw new Refused(`${cmd}: cannot create ${dirname(target)}`)
  }
}

export async function create(ctx: Context, argv: readonly string[]): Promise<void> {
  const { pos, opts } = parseLine(argv, 'create', ['--base'], [], 2)
  const [given = '', name = ''] = pos
  if (given === '' || name === '') throw new Refused('create: usage: create <source-repo> <name> [--base <ref>]')
  const src = await topLevel(ctx, 'create', given)
  if (!NAME.test(name)) throw new Refused(`create: name must match [A-Za-z0-9._-]+: ${name}`)
  let base = opts.get('--base') ?? ''
  const explicit = base !== ''
  if (base === '') base = (await gitOut(ctx, src, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? ''
  // An explicit base is read from the source's origin, never from the source's own branch: a
  // local branch that lags its remote would hand the work a stale base, and a branch only the
  // remote holds would be refused (§35). So `--base <branch>` starts from `origin/<branch>`
  // when the origin has it, and from the local branch only when the origin has none; the
  // `origin/<branch>` spelling still names a remote-tracking ref of the source. The head of the
  // remote is fetched into the checkout below, since a clone carries only what the source's
  // local branches reach.
  const origin = (await gitOut(ctx, src, ['remote', 'get-url', 'origin'])) ?? ''
  const local = (await git(ctx, src, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`])).status === 0
  const unknown = new Refused(`create: the source has no branch or origin/ remote-tracking ref ${base}`)
  let remoteBranch = ''
  let unreadable: string | undefined
  if (!local && base.startsWith('origin/') && (await git(ctx, src, ['rev-parse', '--verify', '--quiet', `refs/remotes/${base}`])).status === 0) {
    remoteBranch = base.slice('origin/'.length)
  } else if (explicit && origin !== '') {
    const probe = await git(ctx, src, ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${base}`], AbortSignal.timeout(PROBE_MS))
    if (probe.status === 0) remoteBranch = base
    else if (probe.status === 2) {
      if (!local) throw unknown
    } else if (local) {
      unreadable = probe.stderr.trim().split('\n')[0] ?? ''
    } else {
      throw new Refused(`create: cannot read origin to resolve ${base}: ${probe.stderr.trim()}`)
    }
  } else if (!local) {
    throw unknown
  }
  const target = `${ctx.root}/${basename(src)}/${name}`
  makeParent('create', target)
  const fail = (text: string): never => {
    rmTree(target)
    throw new Refused(`create: ${text}`)
  }
  const cloned = remoteBranch !== ''
    ? await ctx.deps.run(['git', 'clone', '--quiet', '--no-checkout', src, target])
    : await ctx.deps.run(['git', 'clone', '--quiet', '--branch', base, src, target])
  if (cloned.status !== 0) fail(`clone failed from ${src}`)

  // origin is the real remote, so the implementer's push reaches it; a source without one
  // yields a checkout without one, and says so.
  const url = origin
  if (url !== '') {
    if ((await git(ctx, target, ['remote', 'set-url', 'origin', url])).status !== 0) fail(`cannot point origin at ${url}`)
  } else {
    await git(ctx, target, ['remote', 'remove', 'origin'])
    say(ctx, 'the source has no origin; the checkout has none either')
  }

  if (remoteBranch !== '') {
    if (url === '') fail(`--base ${base} needs the source to have an origin`)
    if ((await git(ctx, target, ['fetch', '--quiet', 'origin', remoteBranch])).status !== 0) fail(`cannot fetch ${remoteBranch} from ${url}`)
    // -B, not -b: a --no-checkout clone already made the local branch the source's HEAD names,
    // and -b would refuse it.
    if ((await git(ctx, target, ['checkout', '--quiet', '-B', remoteBranch, `origin/${remoteBranch}`])).status !== 0) {
      fail(`cannot check out ${remoteBranch} from origin/${remoteBranch}`)
    }
  }
  if (explicit) {
    const sha = (await gitOut(ctx, target, ['rev-parse', 'HEAD'])) ?? ''
    say(ctx, remoteBranch !== '' ? `base: origin/${remoteBranch} at ${sha}` : unreadable === undefined ? `base: local branch ${base} at ${sha}, origin has none` : `base: local branch ${base} at ${sha}, origin unreadable (${unreadable})`)
  }

  const exclude = join(src, '.git', 'info', 'exclude')
  const excludeText = isFile(exclude) ? readFileSync(exclude, 'utf8') : undefined
  const settings = isDir(join(src, '.claude'))
  // 1. The project's local settings directory — minus what the source's exclude file names
  //    INSIDE it. The host writes a runtime block into every repository's exclude file
  //    (worktrees, checkpoints, a mailbox), and a copy of the directory whole once carried two
  //    full worktrees, 4 GB, each with a `.git` pointing at the source (§35). A pattern naming
  //    the directory whole is set aside: it says the directory stays out of history, which
  //    every copied file already does. Git reads the reduced file, so the patterns mean what
  //    they mean to git; the listed files are copied in one pass, so what is skipped is never
  //    read. `settings.local.json` is withheld whatever the exclude file says about it: the
  //    permission rules it holds are the operator's own session's, never an agent's, so they
  //    never reach a checkout.
  if (settings) {
    const rules = join(target, '.git', 'workspace-rules')
    let list: string[] = []
    let withheld = 0
    let skipped = 0
    try {
      writeFileSync(rules, excludeText === undefined ? '' : settingsRules(excludeText))
      const dir = `${src}/.claude/`
      for (const f of await gitList(ctx, src, ['ls-files', '-z', '--others', `--exclude-from=${rules}`, '--', dir])) {
        if (`/${f}` === '/.claude/settings.local.json') withheld++
        else if (copyable(f)) list.push(f)
      }
      const listed = await git(ctx, src, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--ignored', '--directory', `--exclude-from=${rules}`, '--', dir])
      skipped = listed.stdout.split('\n').filter(l => l !== '').length
    } finally {
      rmSync(rules, { force: true })
    }
    copyOrFail(ctx, src, target, list, 'copying the local settings directory failed', fail)
    say(ctx, `copied the local settings directory (${list.length} files, ${skipped} skipped by the exclude file, ${withheld} withheld: the operator's own settings.local.json never travels into a checkout)`)
    list = []
  }

  // 2. What the exclude file keeps out of history, listed by git itself so the patterns are
  //    read the way git reads them and only present files are copied.
  let excluded: string[] = []
  if (excludeText !== undefined) {
    excluded = (await gitList(ctx, src, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${exclude}`])).filter(f => !underSettings(f) && copyable(f))
    copyOrFail(ctx, src, target, excluded, 'copying the excluded files failed', fail)
  }
  say(ctx, `copied ${excluded.length} excluded files`)

  // What was copied is kept out of the checkout's own history the way the source keeps it out
  // of its own: otherwise every checkout reads dirty from birth, and `delete` refuses it for
  // work that is not work.
  const own = join(target, '.git', 'info', 'exclude')
  mkdirSync(dirname(own), { recursive: true })
  appendFileSync(own, `# workspace.sh: the source's local material, copied in, never committed\n${asLines(excludeText ?? '')}${settings ? '/.claude/\n' : ''}`)

  // 2b. What the OPERATOR's global excludes file keeps out of the source. The project's own
  //    instruction file is kept out of history by core.excludesFile, not by the repository's
  //    own exclude file, so step 2 never lists it (§40). A path already copied by step 1 or 2
  //    is skipped here so it is copied once and counted once.
  const global = await globalExcluded(ctx, src, target, false)
  copyOrFail(ctx, src, target, global.files, 'copying the files kept out by the global excludes failed', fail)
  if (global.path !== '') appendFileSync(own, `# workspace.sh: the operator's global excludes\n${asLines(readFileSync(global.path, 'utf8'))}`)
  say(ctx, `copied ${global.files.length} files kept out by the global excludes`)

  // 3. The optional manifest: one relative path per line, a file or a directory. Absent is
  //    said and skipped (a manifest serves more than one machine); leaving the repository is
  //    refused; build trees never travel.
  const manifest = join(src, '.claude', 'workspace-manifest')
  if (isFile(manifest)) {
    let copied = 0
    const missing: string[] = []
    for (const line of readFileSync(manifest, 'utf8').split('\n')) {
      const f = manifestPath(line)
      if (f === '') continue
      if (leavesRepository(f)) fail(`manifest path leaves the repository: ${f}`)
      if (neverCopied(f)) {
        say(ctx, `manifest: never copied: ${f}`)
        continue
      }
      if (copyTree(src, target, f) === 'copied') {
        copied++
        appendFileSync(own, `/${f}\n`)
      } else {
        missing.push(f)
      }
    }
    say(ctx, missing.length > 0 ? `manifest: ${copied} copied, missing: ${missing.join(' ')}` : `manifest: ${copied} copied, 0 missing`)
  }
  out(ctx, target)
}

export async function pin(ctx: Context, argv: readonly string[]): Promise<void> {
  const { pos, opts } = parseLine(argv, 'pin', ['--pr'], [], 3)
  const [given = '', name = '', ref = ''] = pos
  if (given === '' || name === '' || ref === '') throw new Refused('pin: usage: pin <source-repo> <name> <ref> [--pr <n>]')
  const pr = opts.get('--pr')
  if (pr !== undefined && !/^[0-9]+$/.test(pr)) throw new Refused(`pin: --pr needs a pull request number: ${pr}`)
  const src = await topLevel(ctx, 'pin', given)
  if (!NAME.test(name)) throw new Refused(`pin: name must match [A-Za-z0-9._-]+: ${name}`)
  const sha = await gitOut(ctx, src, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (sha === undefined) throw new Refused(`pin: the source does not know ${ref}`)
  const target = `${ctx.root}/${basename(src)}/${name}`
  makeParent('pin', target)
  // A detached worktree: a reader's copy carries the code at the head and none of the
  // orchestrator's local material — its settings directory, what the source's own exclude file
  // keeps out, least of all its briefs and state file — and writes nothing but its metadata
  // into the source, which is the orchestrator's own checkout (§37). A worktree shares the
  // source's remotes.
  if ((await git(ctx, src, ['worktree', 'add', '--quiet', '--detach', target, sha])).status !== 0) {
    rmTree(target)
    throw new Refused(`pin: worktree add failed at ${sha}`)
  }
  const unpin = async (text: string): Promise<never> => {
    await git(ctx, src, ['worktree', 'remove', '--force', target])
    rmTree(target)
    throw new Refused(`pin: ${text}`)
  }
  // The one local material it does carry: what the OPERATOR's global excludes keep out of the
  // source, the files `create` copies in its step 2b. The worktree reads the same global
  // excludes, so they read clean there.
  const global = await globalExcluded(ctx, src, target, true)
  if (!copyList(src, target, global.files)) await unpin('copying the files kept out by the global excludes failed')
  say(ctx, `copied ${global.files.length} files kept out by the global excludes`)
  // The pull request this pin reviews, in the worktree's own git dir: `git worktree remove`
  // takes it away with the pin, and `sweep` reads it to know when the review is over.
  if (pr !== undefined) {
    const gd = await gitOut(ctx, target, ['rev-parse', '--absolute-git-dir'])
    try {
      if (gd === undefined) throw new Error('no git dir')
      writeFileSync(join(gd, 'workspace-pr'), `${pr}\n`)
    } catch {
      await unpin(`cannot record pull request ${pr}`)
    }
  }
  say(ctx, `pinned ${(await gitOut(ctx, src, ['rev-parse', '--short', sha])) ?? ''} from ${ref}`)
  out(ctx, target)
}

/** Whether `real` is a checkout's place, `<root>/<project>/<name>` or below it. */
export function underRoot(real: string, root: string): boolean {
  return real.startsWith(`${root}/`) && real.slice(root.length + 1).includes('/')
}

export async function remove(ctx: Context, argv: readonly string[]): Promise<void> {
  const { pos, opts } = parseLine(argv, 'delete', [], ['--discard'], 1)
  const [path = ''] = pos
  if (path === '') throw new Refused('delete: usage: delete <path> [--discard]')
  // A relative path is read against the caller's directory, both ways the shell read it: the
  // real path the guards judge, and the logical one a host directory may be named after.
  const logical = resolve(ctx.deps.cwd, path)
  if (!isDir(logical)) throw new Refused(`delete: no such checkout: ${path}`)
  const real = realpathSync(logical)
  let root: string
  try {
    mkdirSync(ctx.root, { recursive: true })
    root = realpathSync(ctx.root)
  } catch {
    throw new Refused(`delete: cannot read the root ${ctx.root}`)
  }
  if (!underRoot(real, root)) throw new Refused(`delete: refusing a path outside ${root}: ${path}`)
  // The guards, shared with `sweep` (see `refusal`). For a pin (§37) the second one is not
  // « commits on no remote branch » — the shared refs would read the source's — but « a head on
  // no branch of the source »: a reader that committed in its copy is the one way to lose work
  // here, the pinned commit itself living in the source. A live process inside is read last,
  // and `--discard` is the operator's word over all of them.
  if (!opts.has('--discard')) {
    const reason = await refusal(ctx, real)
    if (reason !== '') throw new Refused(`delete: ${reason} (pass --discard to remove it anyway): ${path}`)
  }
  // A pin's source is read before the pin leaves: the source forgets it through git once it is
  // gone (`worktree remove` of a path that no longer exists drops the metadata).
  let common = ''
  if (isFile(join(real, '.git'))) {
    const c = await gitOut(ctx, real, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    if (c === undefined) throw new Refused(`delete: cannot read the pin's source: ${real}`)
    common = c
  }
  if (!trashRemove(ctx, real, join(root, '.trash'))) throw new Refused(`delete: cannot move into the trash: ${real}`)
  if (common !== '' && (await ctx.deps.run(['git', `--git-dir=${common}`, 'worktree', 'remove', '--force', real])).status !== 0) {
    say(ctx, `the source still lists the worktree ${real}; \`git worktree prune\` in it drops it`)
  }
  if (present(real)) throw new Refused(`delete: still there after the removal: ${real}`)
  out(ctx, `deleted ${real}`)
  await removeHostTmp(ctx, [real, logical])
}

export async function list(ctx: Context): Promise<void> {
  if (!isDir(ctx.root)) return
  for (const d of checkoutDirs(ctx.root)) {
    if (!present(join(d, '.git'))) continue
    const br = chomp((await git(ctx, d, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout)
    const head = chomp((await git(ctx, d, ['rev-parse', '--short', 'HEAD'])).stdout)
    const state = chomp((await git(ctx, d, ['status', '--porcelain'])).stdout) === '' ? 'clean' : 'dirty'
    const pushed = isFile(join(d, '.git'))
      ? 'pinned'
      : chomp((await git(ctx, d, ['log', '--branches', '--not', '--remotes', '--oneline'])).stdout) === '' ? 'pushed' : 'unpushed'
    out(ctx, `${d} | ${br} | ${head} | ${state} | ${pushed}`)
  }
}

// --- sweep: the leftovers, decided on facts (design §61) ------------------------------------

/** A pull request as `gh pr list --json headRefName,state,headRefOid,number` prints it. */
export interface Pr {
  readonly number?: number
  readonly state?: string
  readonly headRefName?: string
  readonly headRefOid?: string
}

/** The list `gh` printed, or undefined when it is not one. */
export function parsePrs(text: string): Pr[] | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!Array.isArray(raw)) return undefined
  return raw.map((p: unknown): Pr => {
    if (typeof p !== 'object' || p === null) return {}
    const o = p as Record<string, unknown>
    return {
      ...(typeof o['number'] === 'number' ? { number: o['number'] } : {}),
      ...(typeof o['state'] === 'string' ? { state: o['state'] } : {}),
      ...(typeof o['headRefName'] === 'string' ? { headRefName: o['headRefName'] } : {}),
      ...(typeof o['headRefOid'] === 'string' ? { headRefOid: o['headRefOid'] } : {}),
    }
  })
}

export type BranchFacts =
  | { readonly kind: 'none' }
  | { readonly kind: 'open'; readonly number: number }
  | { readonly kind: 'over'; readonly number: number; readonly state: string; readonly heads: readonly string[] }
  | { readonly kind: 'unknown' }

/** What the pull requests of a branch say: none, one open (the lowest), all over (the last), or no state decided on. */
export function branchFacts(prs: readonly Pr[], branch: string): BranchFacts {
  const mine = prs.filter(p => p.headRefName === branch)
  if (mine.length === 0) return { kind: 'none' }
  const numbers = mine.map(p => p.number)
  if (!numbers.every((n): n is number => n !== undefined)) return { kind: 'unknown' }
  const open = mine.filter(p => p.state === 'OPEN')
  if (open.length > 0) return { kind: 'open', number: Math.min(...open.map(p => p.number ?? 0)) }
  if (!mine.every(p => p.state === 'MERGED' || p.state === 'CLOSED')) return { kind: 'unknown' }
  const last = mine.reduce((a, b) => ((b.number ?? 0) > (a.number ?? 0) ? b : a))
  return { kind: 'over', number: last.number ?? 0, state: last.state ?? '', heads: mine.map(p => p.headRefOid ?? '').filter(h => h !== '') }
}

/** The POSIX `cksum` of a text: the key of an origin's cache file, the same the shell wrote. */
export function cksum(text: string): number {
  const bytes = Buffer.from(text, 'utf8')
  let crc = 0
  const step = (byte: number): void => {
    crc ^= byte << 24
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1
    crc >>>= 0
  }
  for (const b of bytes) step(b)
  for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) step(n & 0xff)
  return ~crc >>> 0
}

interface Sweep {
  readonly ctx: Context
  readonly dry: boolean
  readonly deadline: number | undefined
  readonly t0: number
  readonly cache: string
  /** Each origin's list, or the reason it cannot be read, once per run. */
  readonly prs: Map<string, Pr[] | { readonly why: string }>
}

function spent(s: Sweep): boolean {
  return s.deadline !== undefined && Math.floor((s.ctx.deps.now() - s.t0) / 1000) >= s.deadline
}

function sayDeadline(s: Sweep): void {
  say(s.ctx, `sweep: deadline of ${s.deadline ?? 0}s spent; the rest waits for the next sweep`)
}

function keep(ctx: Context, path: string, reason: string): void {
  out(ctx, `kept ${path}: ${reason}`)
}

/**
 * The repository's pull requests, read once per origin whatever the number of checkouts, and
 * kept in the state directory for thirty minutes: a list is the slow part of a sweep, and a
 * sweep cut by the stop gate's deadline restarted from nothing every time. A failure is said
 * once for the repository, never cached, and nothing is deleted for it.
 */
async function loadPrs(s: Sweep, real: string): Promise<Pr[] | { readonly why: string }> {
  const ctx = s.ctx
  const url = await gitOut(ctx, real, ['remote', 'get-url', 'origin'])
  if (url === undefined) return { why: 'the checkout has no origin to ask' }
  const key = String(cksum(url))
  const known = s.prs.get(key)
  if (known !== undefined) return known
  const cached = join(s.cache, `${key}.json`)
  try {
    if (ctx.deps.now() - statSync(cached).mtimeMs < PRS_FRESH_MS) {
      const prs = parsePrs(readFileSync(cached, 'utf8'))
      if (prs !== undefined) {
        s.prs.set(key, prs)
        return prs
      }
    }
  } catch {
    // No cache, or one that cannot be read: the list is asked.
  }
  let secs = GH_SECONDS
  if (s.deadline !== undefined) secs = Math.min(GH_SECONDS, Math.max(1, s.deadline - Math.floor((ctx.deps.now() - s.t0) / 1000)))
  // --limit: the default lists thirty, and a merged pull request older than that would read as
  // « no pull request » and never be swept. Two hundred, not a thousand: the long list was most
  // of a sweep's time, and a merged pull request past it reads as « no pull request », which
  // keeps the checkout — the safe side.
  const signals = [AbortSignal.timeout(secs * 1000), ...(ctx.signal === undefined ? [] : [ctx.signal])]
  const ran = await ctx.deps.run(['gh', 'pr', 'list', '--state', 'all', '--limit', '200', '--json', 'headRefName,state,headRefOid,number'], {
    cwd: real, stderr: 'pipe', signal: AbortSignal.any(signals),
  })
  const prs = ran.status === 0 ? parsePrs(ran.stdout) : undefined
  if (prs === undefined) {
    const why = ran.stderr.split('\n')[0] || 'no readable answer'
    say(ctx, `sweep: cannot read the pull requests of ${url} (${why}); nothing is deleted for it`)
    const bad = { why }
    s.prs.set(key, bad)
    return bad
  }
  try {
    writeAtomic(cached, ran.stdout, 0o644)
  } catch {
    // A list that cannot be kept is asked again next time.
  }
  s.prs.set(key, prs)
  return prs
}

/** Whether the pull request is about this commit: its head, or a descendant of it the clone can see. */
async function about(ctx: Context, real: string, heads: readonly string[]): Promise<boolean> {
  const head = (await gitOut(ctx, real, ['rev-parse', 'HEAD'])) ?? ''
  for (const oid of heads) {
    if (oid === head) return true
    if ((await git(ctx, real, ['cat-file', '-e', `${oid}^{commit}`])).status === 0
      && (await git(ctx, real, ['merge-base', '--is-ancestor', head, oid])).status === 0) return true
  }
  return false
}

export type Verdict = { readonly delete: boolean; readonly reason: string }

/** Whether a checkout's or pin's purpose is over, read from its pull request. */
export async function decide(s: Sweep, real: string): Promise<Verdict> {
  const ctx = s.ctx
  const keepIt = (reason: string): Verdict => ({ delete: false, reason })
  const deleteIt = (reason: string): Verdict => ({ delete: true, reason })
  if (isFile(join(real, '.git'))) {
    const gd = (await gitOut(ctx, real, ['rev-parse', '--absolute-git-dir'])) ?? ''
    let rec = ''
    try {
      if (gd !== '') rec = readFileSync(join(gd, 'workspace-pr'), 'utf8').replace(/[^0-9]/g, '')
    } catch {
      rec = ''
    }
    if (rec === '') return keepIt('no recorded pull request for this pin')
    const prs = await loadPrs(s, real)
    if (!Array.isArray(prs)) return keepIt(`pull requests unreadable: ${prs.why}`)
    const pr = prs.find(p => String(p.number) === rec)
    if (pr === undefined) return keepIt(`pull request #${rec} is not in the repository's list`)
    const state = pr.state ?? 'None'
    if (state.startsWith('MERGED') || state.startsWith('CLOSED')) return deleteIt(`pull request #${rec} is ${state}`)
    if (state.startsWith('OPEN')) {
      const head = (await gitOut(ctx, real, ['rev-parse', 'HEAD'])) ?? ''
      return (pr.headRefOid ?? '') === head
        ? keepIt(`pinned to the current head of open pull request #${rec}`)
        : deleteIt(`the head of pull request #${rec} moved off the pinned commit`)
    }
    return keepIt(`pull request #${rec} is in state ${state}`)
  }
  const br = (await gitOut(ctx, real, ['symbolic-ref', '--short', '-q', 'HEAD'])) ?? ''
  if (br === '') return keepIt('no branch checked out, so no pull request to match')
  // A long-lived branch is matched by name by pull requests that are not about it (a fork's own
  // `main`): it is never swept on a name. The default branch is read from origin/HEAD alone: no
  // network and no guess, since a branch guessed wrong would be kept as the default when it is not.
  const defaultBranch = (await gitOut(ctx, real, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])) ?? ''
  if ((LONG_LIVED as readonly string[]).includes(br)) return keepIt(`on ${br}, a long-lived branch`)
  if (`origin/${br}` === defaultBranch) return keepIt(`on ${br}, the repository's default branch`)
  const prs = await loadPrs(s, real)
  if (!Array.isArray(prs)) return keepIt(`pull requests unreadable: ${prs.why}`)
  const facts = branchFacts(prs, br)
  switch (facts.kind) {
    case 'none':
      return keepIt(`no pull request for branch ${br}`)
    case 'open':
      return keepIt(`pull request #${facts.number} for branch ${br} is open`)
    case 'over':
      // The pull request must be about THIS commit: a clone past the pull request's head holds
      // work the pull request never carried.
      return (await about(ctx, real, facts.heads))
        ? deleteIt(`the pull request #${facts.number} of branch ${br} is ${facts.state}`)
        : keepIt(`the head is not the one of pull request #${facts.number} (${facts.state}): the branch moved past it`)
    default:
      return keepIt(`the pull requests of branch ${br} are in no state this sweep decides on`)
  }
}

/** Decide, then delete (or say what would be) and prove it. */
async function sweepOne(s: Sweep, d: string): Promise<void> {
  const ctx = s.ctx
  const real = realOf(d)
  const verdict = await decide(s, real)
  if (!verdict.delete) return keep(ctx, real, verdict.reason)
  const reason = await refusal(ctx, real)
  if (reason !== '') return keep(ctx, real, reason)
  if (s.dry) return out(ctx, `would delete ${real}: ${verdict.reason}`)
  const lines: string[] = []
  const errs: string[] = []
  const inner: Context = { ...ctx, deps: { ...ctx.deps, io: { out: t => lines.push(t), err: t => errs.push(t) } } }
  let done = true
  try {
    await remove(inner, [real])
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    errs.push(`workspace: ${error.message}\n`)
    done = false
  }
  // What the delete learned of the process table is the sweep's too.
  if (inner.cwds !== undefined) ctx.cwds = inner.cwds
  if (inner.liveNames !== undefined) ctx.liveNames = inner.liveNames
  const err = errs.join('')
  if (err !== '') ctx.deps.io.err(err)
  if (!done || present(real)) {
    return keep(ctx, real, `the delete did not complete (${(err.split('\n')[0] ?? '').replace(/^workspace: /, '')})`)
  }
  ctx.deps.io.out(lines.join(''))
}

/**
 * Host temporary directories named after a checkout of a project under the root that matches
 * no existing directory and no live process — what was left by checkouts deleted before the
 * host's directory went with them. False when the deadline cut it.
 */
async function sweepOrphans(s: Sweep, root: string): Promise<boolean> {
  const ctx = s.ctx
  // A directory that still exists under the root, a project's own or a checkout, is not an
  // orphan's: only what is named after nothing there is. And only a name under an EXISTING
  // project is a candidate: the encoded root followed by `-` is also the name of a sibling of
  // the root (`<root>-old/x`, `<root>_2/x`), which is not this script's to judge.
  const projects = subdirs(ctx.root).map(d => encode(realOf(d)))
  const known = new Set([...projects, ...checkoutDirs(ctx.root).map(d => encode(realOf(d)))])
  const prefixes = projects.map(p => `${p}-`)
  if (!isDir(ctx.hostTmp) || !/^\/./.test(ctx.hostTmp)) return true
  const start = `${encode(root)}-`
  const names = readdirSync(ctx.hostTmp).filter(n => n.startsWith(start)).sort()
  for (const name of names) {
    const t = `${ctx.hostTmp}/${name}`
    if (!isDir(t) || isSymlink(t)) continue
    if (!prefixes.some(p => name.startsWith(p) && name.length > p.length)) continue
    if (known.has(name)) continue
    if (spent(s)) {
      sayDeadline(s)
      return false
    }
    const state = await hostDirLive(ctx, t)
    if (!('live' in state) || state.live) {
      keep(ctx, t, liveWhy(state))
      continue
    }
    if (s.dry) {
      out(ctx, `would delete ${t}: no checkout, no live process`)
      continue
    }
    trashRemove(ctx, t, hostTrash(ctx))
    if (present(t)) keep(ctx, t, 'it could not be removed')
    else out(ctx, `deleted ${t}`)
  }
  return true
}

/** Makes every entry under `path` writable by its owner, so a removal can take it. */
function ownerWritable(path: string): void {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) return
    chmodSync(path, info.mode | 0o200)
    if (info.isDirectory()) for (const n of readdirSync(path)) ownerWritable(join(path, n))
  } catch {
    // What cannot be made writable is said by the removal that follows.
  }
}

/** What removals cut short left in the trashes, emptied before anything else. False when the deadline cut it. */
async function sweepTrash(s: Sweep): Promise<boolean> {
  const ctx = s.ctx
  for (const trash of [rootTrash(ctx), hostTrash(ctx)]) {
    let names: string[]
    try {
      names = readdirSync(trash).filter(n => !n.startsWith('.')).sort()
    } catch {
      continue
    }
    for (const n of names) {
      const t = join(trash, n)
      if (spent(s)) {
        sayDeadline(s)
        return false
      }
      if (s.dry) {
        out(ctx, `would delete ${t}: left in the trash by a removal cut short`)
        continue
      }
      ownerWritable(t)
      rmTree(t)
      if (present(t)) keep(ctx, t, 'it could not be removed')
      else out(ctx, `deleted ${t}`)
    }
  }
  return true
}

export async function sweep(ctx: Context, argv: readonly string[]): Promise<void> {
  let deadline: number | undefined
  let dry = false
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]
    if (a === '--deadline') {
      const v = argv[k + 1] ?? ''
      k++
      if (!/^[0-9]+(\.[0-9]+)?$/.test(v)) throw new Refused(`sweep: --deadline needs a number of seconds: ${v}`)
      deadline = Number.parseInt(v, 10)
    } else if (a === '--dry-run') {
      dry = true
    } else {
      throw new Refused('sweep: usage: sweep [--deadline <seconds>] [--dry-run]')
    }
  }
  const t0 = ctx.deps.now()
  if (!isDir(ctx.root)) return
  const root = realpathSync(ctx.root)
  // Every command the sweep runs is cancelled at its deadline; what it was reading then reads
  // as unknown, which keeps the item.
  const signal = deadline === undefined ? undefined : AbortSignal.timeout(Math.max(1, deadline * 1000))
  const sctx: Context = { ...ctx, ...(signal === undefined ? {} : { signal }) }
  const env = ctx.deps.env
  const state = setting(env, 'ORCHESTRATOR_STATE_DIR') ?? stateDir('claude-orchestrator', env, setting(env, 'HOME'))
  const s: Sweep = { ctx: sctx, dry, deadline, t0, cache: join(state, 'sweep-prs'), prs: new Map() }
  // The trashes, then the orphans — local and cheap — then the checkouts, which ask the pull
  // requests: a sweep cut by its deadline has done the cheap part first.
  if (!(await sweepTrash(s))) return
  if (!(await sweepOrphans(s, root))) return
  for (const d of checkoutDirs(ctx.root)) {
    if (!present(join(d, '.git'))) continue
    if (spent(s)) return sayDeadline(s)
    await sweepOne(s, d)
  }
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const [cmd = '', ...rest] = argv
  const env = deps.env
  const ctx: Context = {
    deps,
    root: setting(env, 'ORCHESTRATOR_WORKSPACES') ?? `${setting(env, 'HOME') ?? ''}/dev/workspaces`,
    hostTmp: setting(env, 'ORCHESTRATOR_HOST_TMP') ?? `/private/tmp/claude-${deps.uid}`,
  }
  try {
    if (cmd === '') throw new Refused(USAGE)
    if (cmd === 'create') await create(ctx, rest)
    else if (cmd === 'pin') await pin(ctx, rest)
    else if (cmd === 'delete') await remove(ctx, rest)
    else if (cmd === 'sweep') await sweep(ctx, rest)
    else if (cmd === 'list') await list(ctx)
    else throw new Refused(`unknown command: ${cmd}`)
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    deps.io.err(`workspace: ${error.message}\n`)
    return 1
  }
  return 0
}

/* node:coverage ignore next 11 */
if (isEntry(import.meta.url)) {
  const pwd = process.env['PWD']
  process.exitCode = await main(process.argv.slice(2), {
    io: processIo,
    env: process.env,
    run,
    now: Date.now,
    cwd: pwd !== undefined && pwd.startsWith('/') && realOf(pwd) === process.cwd() ? pwd : process.cwd(),
    uid: process.getuid?.() ?? 0,
  })
}
