// workspace — a checkout per phase, with the project's local material.
//
//   workspace.sh create <source-repo> <name> [--base <branch|origin/branch>]   prints the checkout's path; --base <branch> starts from origin/<branch>, the local branch only when origin has none
//   workspace.sh pin <source-repo> <name> <ref> [--pr <n>]     a detached worktree at that commit, of the local material only the global excludes' files; prints its path
//   workspace.sh delete <path> [--discard] [--push] [--by <close|sweep|delete>]   refuses unpushed work unless told; --push pushes its branches
//                                                              first; also removes the host's temporary directory of the
//                                                              path when no live process uses it; the archive line names
//                                                              the command or sweep that made the deletion (`by`)
//   workspace.sh keep <path>                                   the sweep never ends this checkout of a dead orchestrator and agent
//                                                              (`close --keep-checkout` says so); once its orchestrator and agent are gone only a `delete` does
//   workspace.sh sweep [--deadline <seconds>] [--dry-run]      the leftovers, decided on facts: one line per item,
//                                                              "deleted <path>" | "kept <path>: <reason>" (a dry run says "would delete"),
//                                                              "pushed <branch> of <path>" before a checkout no one lives in goes
//   workspace.sh list [<repo>]                                 one line per checkout under the root (a pin reads HEAD … pinned);
//                                                              given a repository (its name or `owner/name`), only its checkouts
//   workspace.sh ledger                                        the ledger: one line per checkout, its owners alive or gone,
//                                                              the reason it stays; a checkout it does not name, said
//
// Ledger: <root>/.workspaces.jsonl (lib/workspace-ledger.ts), one line per checkout, its
// orchestrator and its agent; `create` and `pin` open it, `delete` closes it into the archive
// beside it, the sweep adopts a checkout it does not name. A checkout past its first hour whose
// orchestrator and agent no longer live is ended by the sweep: its branches pushed, then removed;
// what cannot be is kept with its reason written on its line, and said again once a day.
//
// What a removal leaves behind goes with it: `delete` (so `close` and the sweep) takes the parent
// directories it leaves empty, never the root nor a directory holding anything; the sweep takes the
// empty directories already at the top of the root (past their first hour). A clone is never removed
// while a pin hangs from it (`git worktree list`); a pin whose clone is gone is ended by the sweep.
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
import { ENV } from '../../../core/env.ts'
import { configDir, setting, type Env } from '../../../core/paths.ts'
import { orchestratorRoots } from '../../../core/roots.ts'
import { readText, update } from '../../../core/store.ts'
import { parsePrFile, prFilePath, prsOfRepo, prWantedPath, repoOfOrigin, withWanted, type FilePr, type PrFile } from '../../../hooks/pr-file-format.ts'
import { isEntry, processIo, run, type Io, type Ran, type Run } from './lib/process.ts'
import {
  adoptEntry, callerOf, changeEntry, closeEntry, endOf, GRACE_MS, liveSessions, makerOf, pidAlive, putEntry, readLedger, RESAY_MS,
  type LiveSession, type WorkspaceEntry,
} from './lib/workspace-ledger.ts'

export const USAGE = 'usage: workspace.sh {create|pin|delete|keep|sweep|list|ledger} ... (see header)'

/** How long the process table is given to answer. */
export const LSOF_MS = 20_000
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
  /** Whether a process lives; the system's answer when not given. */
  readonly alive?: (pid: number) => boolean
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
  sessions?: readonly LiveSession[] | null
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

async function git(ctx: Context, dir: string, args: readonly string[], signal?: AbortSignal, env?: Readonly<Record<string, string>>): Promise<Ran> {
  const s = signal ?? ctx.signal
  return ctx.deps.run(['git', '-C', dir, ...args], { stderr: 'pipe', ...(s === undefined ? {} : { signal: s }), ...(env === undefined ? {} : { env }) })
}

/*
 * A git read in a checkout an agent may have written: its own settings run no command here, so
 * neither a `core.fsmonitor` nor a hook it set runs in this process.
 */
const READ_ONLY = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'] as const

async function gitRead(ctx: Context, dir: string, args: readonly string[], signal?: AbortSignal, env?: Readonly<Record<string, string>>): Promise<Ran> {
  return git(ctx, dir, [...READ_ONLY, ...args], signal, env)
}

/** The output of a git read that succeeded, else undefined. */
async function gitOut(ctx: Context, dir: string, args: readonly string[]): Promise<string | undefined> {
  const r = await gitRead(ctx, dir, args)
  return r.status === 0 ? chomp(r.stdout) : undefined
}

/** The NUL-separated listing of a git read; an empty one when the read fails, as a shell's process substitution reads it. */
async function gitList(ctx: Context, dir: string, args: readonly string[]): Promise<string[]> {
  const r = await gitRead(ctx, dir, args)
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
export async function refusal(ctx: Context, real: string, pushable = false): Promise<string> {
  const read = async (args: readonly string[]): Promise<string | { readonly why: string }> => {
    const r = await gitRead(ctx, real, args)
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
    // A dry run's reading of a checkout whose branches it would push first: only what is on no
    // branch at all (a detached head's own commits) stays unpushed then.
    const lost = pushable ? await read(['log', 'HEAD', '--not', '--branches', '--remotes', '--oneline']) : unpushed
    if (typeof lost !== 'string') return lost.why
    if (lost !== '') return 'commits on no remote branch'
    const stash = await read(['for-each-ref', '--count=1', 'refs/stash'])
    if (typeof stash !== 'string') return stash.why
    if (stash !== '') return 'a stash is held'
    // A clone is the source of its pins' worktree metadata: without it they read as no checkout at all.
    const pin = await openPin(ctx, real)
    if (typeof pin !== 'string') return pin.why
    if (pin !== '') return `a pin is open on it: ${pin}`
  }
  return liveHold(ctx, real)
}

/** Why a live process holds the directory, or '' when none does. */
async function liveHold(ctx: Context, real: string): Promise<string> {
  const inside = await liveInside(ctx, real)
  if (inside === null) return 'the process table cannot be read'
  return inside ? 'a live process has its working directory inside' : ''
}

/** The first worktree still on disk that hangs from the clone at `real`, '' when none, or why git cannot say. */
async function openPin(ctx: Context, real: string): Promise<string | { readonly why: string }> {
  const r = await gitRead(ctx, real, ['worktree', 'list', '--porcelain'])
  if (r.status !== 0) return { why: `git cannot read the checkout: ${r.stderr.split('\n')[0] ?? 'git worktree failed'}` }
  // The first block is the clone itself; a block marked prunable is a worktree whose directory is gone.
  const pins = r.stdout.split('\n\n').slice(1).filter(b => !/^prunable/m.test(b))
  for (const block of pins) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (path !== undefined && isDir(path)) return path
  }
  return ''
}

/** How a checkout's end, by `workspace.sh`, shows its clone gone and not merely out of reach. */
const REMOVED_ENDS: readonly string[] = ['removed', 'pushed and removed', 'discarded']

/** Whether nothing is at `path` for a plain reason: the system says it is not there, not that it cannot say. */
function absent(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/**
 * A pin whose source no longer holds its worktree: its `.git` names a directory that is gone.
 * `proven` when its clone is shown removed (absent, and the archive says
 * `workspace.sh` removed it); otherwise `why` it is not (moved, on a volume out of reach, removed by
 * hand). Undefined for a pin that reads, a clone, or a `.git` file that says nothing.
 */
function orphanPin(ctx: Context, real: string): { readonly proven: true } | { readonly proven: false; readonly why: string } | undefined {
  const file = join(real, '.git')
  if (!isFile(file)) return undefined
  let named: string | undefined
  try {
    named = /^gitdir: (.+)$/m.exec(readFileSync(file, 'utf8'))?.[1]
  } catch {
    return undefined
  }
  if (named === undefined) return undefined
  const gitdir = resolve(real, named.trim())
  if (present(gitdir)) return undefined
  const clone = /^(.+)\/\.git\/worktrees\/[^/]+$/.exec(gitdir)?.[1]
  const unproven = (why: string): { readonly proven: false; readonly why: string } => ({ proven: false, why: `its source worktree entry is gone, but ${why}` })
  if (clone === undefined) return unproven('its clone cannot be named')
  if (!absent(clone)) return unproven(`its clone ${clone} is still there or out of reach`)
  const end = endOf(ctx.root, clone)
  return end !== undefined && REMOVED_ENDS.includes(end) ? { proven: true } : unproven(`its clone ${clone} was not removed by workspace.sh (moved, or removed by hand)`)
}

// --- the ledger: one line per checkout, its owners, and why it stays ----------------------------

/** The host's live sessions, read once per run; null when its registry cannot be read. */
function sessionsOf(ctx: Context): readonly LiveSession[] | null {
  if (ctx.sessions !== undefined) return ctx.sessions
  ctx.sessions = liveSessions(configDir(ctx.deps.env, setting(ctx.deps.env, 'HOME')), ctx.deps.alive ?? pidAlive)
  return ctx.sessions
}

/** The live session working in the checkout at `real`, by the directory it started in. */
function agentIn(ctx: Context, real: string): LiveSession | undefined {
  return (sessionsOf(ctx) ?? []).find(s => {
    const cwd = realOf(s.cwd)
    return cwd === real || cwd.startsWith(`${real}/`)
  })
}

/** Whether a live session carries the name: an orchestrator's successor carries it too. */
function namedLive(ctx: Context, name: string | null): boolean {
  return name !== null && (sessionsOf(ctx) ?? []).some(s => s.name === name)
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** The repository a checkout's origin names: `owner/name` on GitHub, else the origin itself. */
async function repoOfCheckout(ctx: Context, real: string): Promise<string> {
  const url = (await gitOut(ctx, real, ['remote', 'get-url', 'origin'])) ?? ''
  return repoOfOrigin(url) ?? url
}

/** A ledger write that fails is said, never a failure of the command. */
function ledgerWrite(ctx: Context, what: string, write: () => void): void {
  try {
    write()
  } catch (error) {
    say(ctx, `ledger: ${what} not written: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The line `create` or `pin` opens for the checkout it made, naming its maker. */
async function openEntry(ctx: Context, target: string, kind: 'clone' | 'pin', branch: string): Promise<void> {
  const real = realOf(target)
  const env = ctx.deps.env
  const maker = makerOf(callerOf(sessionsOf(ctx) ?? [], setting(env, 'CLAUDE_CODE_SESSION_ID')), setting(env, ENV.reportsTo))
  const entry: WorkspaceEntry = {
    v: 1, path: real, kind, repo: await repoOfCheckout(ctx, real), branch, ...maker, created: iso(ctx.deps.now()),
  }
  ledgerWrite(ctx, `the line of ${real}`, () => putEntry(ctx.root, entry))
}

/** The line of a checkout the ledger does not name, born when its directory was. */
async function adoptedEntry(ctx: Context, real: string): Promise<WorkspaceEntry> {
  const pin = isFile(join(real, '.git'))
  const branch = pin
    ? (await gitOut(ctx, real, ['rev-parse', 'HEAD'])) ?? ''
    : (await gitOut(ctx, real, ['symbolic-ref', '--short', '-q', 'HEAD'])) ?? ''
  let born = ctx.deps.now()
  try {
    const st = statSync(real)
    born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs
  } catch {
    // Unreadable: born now, so the grace keeps it.
  }
  return {
    v: 1, path: real, kind: pin ? 'pin' : 'clone', repo: await repoOfCheckout(ctx, real), branch,
    orchestrator: null, agent: null, created: iso(born), adopted: true,
  }
}

/** Branches never pushed by a sweep: a commit there is the operator's to publish. */
async function protectedBranch(ctx: Context, real: string, branch: string): Promise<boolean> {
  if ((LONG_LIVED as readonly string[]).includes(branch)) return true
  return (await gitOut(ctx, real, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])) === `origin/${branch}`
}

/** How long one push is given. */
export const PUSH_MS = 60_000

/**
 * The checkout's work put on its origin before it goes: every local branch holding a commit no
 * remote branch holds, and that the origin does not hold yet, is pushed under its own name, never
 * forced, with no hook of the checkout's run. A pin carries no branch of its own. A dry run pushes nothing and names what it would push.
 * The reason is '' when nothing stands in the way, else why the work cannot reach the origin.
 */
export async function pushWork(ctx: Context, real: string, dry: boolean): Promise<{ readonly pushed: readonly string[]; readonly reason: string }> {
  if (isFile(join(real, '.git'))) return { pushed: [], reason: '' }
  const heads = await gitRead(ctx, real, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  if (heads.status !== 0) return { pushed: [], reason: `git cannot read the checkout: ${heads.stderr.split('\n')[0] ?? ''}` }
  const ahead: string[] = []
  for (const b of chomp(heads.stdout).split('\n').filter(l => l !== '')) {
    if (((await gitOut(ctx, real, ['rev-list', '-1', `refs/heads/${b}`, '--not', '--remotes'])) ?? '') !== '') ahead.push(b)
  }
  if (ahead.length === 0) return { pushed: [], reason: '' }
  if ((await gitOut(ctx, real, ['remote', 'get-url', 'origin'])) === undefined) {
    return { pushed: [], reason: 'commits on no remote branch, and no origin to push them to' }
  }
  for (const b of ahead) {
    if (await protectedBranch(ctx, real, b)) return { pushed: [], reason: `commits on ${b}, a long-lived branch the sweep never pushes` }
    // A branch the origin holds may carry an open pull request: its head is moved by its agent,
    // never by a sweep that would publish commits no one asked to.
    if ((await gitRead(ctx, real, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`])).status === 0) {
      return { pushed: [], reason: `commits past origin/${b}, a branch the origin holds: only its agent moves it` }
    }
  }
  if (dry) return { pushed: ahead, reason: '' }
  const pushed: string[] = []
  for (const b of ahead) {
    const signals = [AbortSignal.timeout(PUSH_MS), ...(ctx.signal === undefined ? [] : [ctx.signal])]
    // The empty lease makes the push a creation: a branch the origin took since the last fetch refuses it.
    const r = await gitRead(ctx, real, ['push', '--quiet', `--force-with-lease=refs/heads/${b}:`, 'origin', `refs/heads/${b}:refs/heads/${b}`], AbortSignal.any(signals), { GIT_TERMINAL_PROMPT: '0' })
    if (r.status !== 0) {
      const why = r.status === null ? 'no answer in time' : (r.stderr.trim().split('\n')[0] ?? '') || `git exited ${r.status}`
      return { pushed, reason: `cannot push ${b}: ${why}` }
    }
    pushed.push(b)
    out(ctx, `pushed ${b} of ${real}`)
  }
  return { pushed, reason: '' }
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

/** Whether a directory holds nothing but the file Finder leaves in it. */
function holdsNothing(dir: string): boolean {
  try {
    return readdirSync(dir).every(n => n === '.DS_Store')
  } catch {
    return false
  }
}

/** How long ago the directory last changed; zero when it cannot be read, so it counts as young. */
function ageOf(path: string, now: number): number {
  try {
    return now - statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** Removes an empty directory (Finder's own file aside); false when it holds anything else. */
function removeEmptyDir(dir: string): boolean {
  if (isSymlink(dir) || !isDir(dir) || !holdsNothing(dir)) return false
  try {
    rmSync(join(dir, '.DS_Store'), { force: true })
    rmdirSync(dir)
    return true
  } catch {
    return false
  }
}

/** The directories a removal left empty above it, up to but never the root: each is taken only while it holds nothing. */
function pruneParents(root: string, from: string): void {
  let dir = from
  while (dir.startsWith(`${root}/`) && removeEmptyDir(dir)) dir = dirname(dir)
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
  const local = (await gitRead(ctx, src, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`])).status === 0
  const unknown = new Refused(`create: the source has no branch or origin/ remote-tracking ref ${base}`)
  let remoteBranch = ''
  let unreadable: string | undefined
  if (!local && base.startsWith('origin/') && (await gitRead(ctx, src, ['rev-parse', '--verify', '--quiet', `refs/remotes/${base}`])).status === 0) {
    remoteBranch = base.slice('origin/'.length)
  } else if (explicit && origin !== '') {
    // `origin/<b>` names the origin's branch <b> when the source holds no such local branch, even
    // as a remote-tracking ref it never fetched; the probe asks for the bare name. It never
    // prompts for a credential: an origin that wants one is unreadable.
    const asked = !local && base.startsWith('origin/') ? base.slice('origin/'.length) : base
    const probe = await gitRead(ctx, src, ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${asked}`], AbortSignal.timeout(PROBE_MS), { GIT_TERMINAL_PROMPT: '0' })
    const why = probe.status === null ? `no answer within ${PROBE_MS / 1000} s` : probe.stderr.trim() || `git exited ${probe.status}`
    if (probe.status === 0) remoteBranch = asked
    else if (probe.status === 2) {
      if (!local) throw unknown
    } else if (local) {
      unreadable = why.split('\n')[0] ?? ''
    } else {
      throw new Refused(`create: cannot read origin to resolve ${base}: ${why}`)
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
      const listed = await gitRead(ctx, src, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--ignored', '--directory', `--exclude-from=${rules}`, '--', dir])
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
  await openEntry(ctx, target, 'clone', (await gitOut(ctx, target, ['symbolic-ref', '--short', '-q', 'HEAD'])) ?? '')
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
  const resolve = (): Promise<string | undefined> => gitOut(ctx, src, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  let sha = await resolve()
  if (sha === undefined && pr === undefined) throw new Refused(`pin: the source does not know ${ref} (--pr <n> makes pin fetch that pull request's head)`)
  if (sha === undefined) {
    // The head of the pull request may not be fetched yet: one fetch, written to FETCH_HEAD only.
    const f = await git(ctx, src, ['fetch', '--quiet', 'origin', `refs/pull/${pr}/head`])
    sha = await resolve()
    if (sha === undefined) {
      const why = f.status === 0 ? `the head of pull request ${pr} does not contain it` : `fetch of pull request ${pr} failed: ${chomp(f.stderr)}`
      throw new Refused(`pin: the source does not know ${ref}; ${why}`)
    }
  }
  const target = `${ctx.root}/${basename(src)}/${name}`
  makeParent('pin', target)
  // A detached worktree: a reader's copy carries the code at the head and none of the
  // orchestrator's local material — its settings directory, what the source's own exclude file
  // keeps out, least of all its briefs — and writes nothing but its metadata
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
  await openEntry(ctx, target, 'pin', sha)
  out(ctx, target)
}

/** Whether `real` is a checkout's place, `<root>/<project>/<name>` or below it. */
export function underRoot(real: string, root: string): boolean {
  return real.startsWith(`${root}/`) && real.slice(root.length + 1).includes('/')
}

export async function remove(ctx: Context, argv: readonly string[]): Promise<void> {
  const { pos, opts } = parseLine(argv, 'delete', ['--by'], ['--discard', '--push'], 1)
  const [path = ''] = pos
  if (path === '') throw new Refused('delete: usage: delete <path> [--discard]')
  // Who asks, written on the archive line: `close` (a session's end), `sweep`, or `delete` (by hand).
  const by = opts.get('--by') ?? 'delete'
  if (!['close', 'sweep', 'delete'].includes(by)) throw new Refused(`delete: --by names close, sweep or delete, not '${by}'`)
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
  // --push: the work goes to the origin first, so the guard below finds nothing unpushed.
  let pushed: readonly string[] = []
  if (opts.has('--push') && opts.has('--discard')) throw new Refused('delete: --push and --discard do not go together')
  if (opts.has('--push')) {
    // What holds the checkout whatever is pushed (a dirty tree, a stash, a live process) is read
    // before anything is published.
    const held = await refusal(ctx, real, true)
    if (held !== '') throw new Refused(`delete: ${held} (pass --discard to remove it anyway): ${path}`)
    const work = await pushWork(ctx, real, false)
    pushed = work.pushed
    if (work.reason !== '') throw new Refused(`delete: ${work.reason} (pass --discard to remove it anyway): ${path}`)
  }
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
  pruneParents(root, dirname(real))
  const end = opts.has('--discard') ? 'discarded' : pushed.length > 0 ? 'pushed and removed' : 'removed'
  ledgerWrite(ctx, `the close of ${real}`, () => closeEntry(ctx.root, real, end, iso(ctx.deps.now()), by))
  out(ctx, `deleted ${real}`)
  await removeHostTmp(ctx, [real, logical])
}

/**
 * `keep <path>`: the checkout is marked on its ledger line (adopted first when it has none), so the sweep
 * never ends it. A line that cannot be written is a refusal, never a mark that was not made.
 */
export async function markKept(ctx: Context, argv: readonly string[]): Promise<void> {
  const { pos } = parseLine(argv, 'keep', [], [], 1)
  const [path = ''] = pos
  if (path === '') throw new Refused('keep: usage: keep <path>')
  const logical = resolve(ctx.deps.cwd, path)
  if (!isDir(logical)) throw new Refused(`keep: no such checkout: ${path}`)
  const real = realpathSync(logical)
  let root: string
  try {
    root = realpathSync(ctx.root)
  } catch {
    throw new Refused(`keep: cannot read the root ${ctx.root}`)
  }
  if (!underRoot(real, root)) throw new Refused(`keep: refusing a path outside ${root}: ${path}`)
  try {
    const held = adoptEntry(ctx.root, await adoptedEntry(ctx, real))
    if (held.kept === undefined) changeEntry(ctx.root, real, e => ({ ...e, kept: iso(ctx.deps.now()) }))
  } catch (error) {
    throw new Refused(`keep: the ledger line of ${real} cannot be written: ${error instanceof Error ? error.message : String(error)}`)
  }
  out(ctx, `kept ${real}`)
}

export async function list(ctx: Context, argv: readonly string[] = []): Promise<void> {
  if (argv.length > 1) throw new Refused('list: usage: list [<repo>]')
  // A repository reads as its directory's name: `owner/name` and `name` name the same checkouts.
  let repo = basename((argv[0] ?? '').replace(/\/+$/, ''))
  const dirs = isDir(ctx.root) ? checkoutDirs(ctx.root) : []
  // A name no checkout directory carries (a clone kept under another name) lists everything, said, so that « no line » never reads as « no checkout ».
  if (repo !== '' && !dirs.some(d => basename(dirname(d)) === repo)) {
    say(ctx, `list: no directory ${repo} under ${ctx.root}; every checkout follows`)
    repo = ''
  }
  for (const d of dirs) {
    if (repo !== '' && basename(dirname(d)) !== repo) continue
    if (!present(join(d, '.git'))) continue
    const br = chomp((await gitRead(ctx, d, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout)
    const head = chomp((await gitRead(ctx, d, ['rev-parse', '--short', 'HEAD'])).stdout)
    const state = chomp((await gitRead(ctx, d, ['status', '--porcelain'])).stdout) === '' ? 'clean' : 'dirty'
    const pushed = isFile(join(d, '.git'))
      ? 'pinned'
      : chomp((await gitRead(ctx, d, ['log', '--branches', '--not', '--remotes', '--oneline'])).stdout) === '' ? 'pushed' : 'unpushed'
    out(ctx, `${d} | ${br} | ${head} | ${state} | ${pushed}`)
  }
}

/**
 * The ledger as it stands: one line per checkout it names, `<path> | <repo> | <branch> |
 * orchestrator <name> (live|gone) | agent <name> (live|gone) | <reason>`, then each checkout under
 * the root it does not name (`<path> | no line: the next sweep adopts it`).
 */
export async function ledger(ctx: Context, argv: readonly string[] = []): Promise<void> {
  if (argv.length > 0) throw new Refused('ledger: usage: ledger')
  const entries = readLedger(ctx.root)
  const named = new Set(entries.map(e => e.path))
  const owner = (role: string, name: string | null, live: boolean): string => (name === null ? `${role} none` : `${role} ${name} (${live ? 'live' : 'gone'})`)
  for (const e of entries) {
    const agent = agentIn(ctx, e.path)
    const agentName = agent?.name ?? e.agent
    out(ctx, [
      e.path, e.repo === '' ? '-' : e.repo, e.branch === '' ? '-' : e.branch,
      owner('orchestrator', e.orchestrator, namedLive(ctx, e.orchestrator)),
      owner('agent', agentName, agent !== undefined || namedLive(ctx, agentName)),
      e.reason ?? '',
    ].join(' | '))
  }
  for (const d of isDir(ctx.root) ? checkoutDirs(ctx.root) : []) {
    if (present(join(d, '.git')) && !named.has(realOf(d))) out(ctx, `${realOf(d)} | no line: the next sweep adopts it`)
  }
}

// --- sweep: the leftovers, decided on facts (design §61) ------------------------------------

export type BranchFacts =
  | { readonly kind: 'none' }
  | { readonly kind: 'open'; readonly number: number }
  | { readonly kind: 'over'; readonly number: number; readonly state: string; readonly heads: readonly string[] }

/** What the pull requests of a branch say: none, one open (the lowest), or all over (the last). */
export function branchFacts(prs: readonly FilePr[], branch: string): BranchFacts {
  const mine = prs.filter(p => p.head === branch)
  if (mine.length === 0) return { kind: 'none' }
  const open = mine.filter(p => p.state === 'OPEN')
  if (open.length > 0) return { kind: 'open', number: Math.min(...open.map(p => p.pr)) }
  const last = mine.reduce((a, b) => (b.pr > a.pr ? b : a))
  return { kind: 'over', number: last.pr, state: last.state, heads: mine.map(p => p.sha).filter(h => h !== '') }
}

interface Sweep {
  readonly ctx: Context
  readonly dry: boolean
  readonly deadline: number | undefined
  readonly t0: number
  /** The machine's pull request file, read once per run, and the repositories the sweep asked it for. */
  readonly file: PrFile | undefined
  readonly wanted: Set<string>
  /** Each repository's list, or the reason it cannot be read, once per run. */
  readonly prs: Map<string, readonly FilePr[] | { readonly why: string }>
  /** The ledger's lines by path, read once per run. */
  readonly ledger: ReadonlyMap<string, WorkspaceEntry>
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
 * The repository's pull requests, as the machine's pull request file holds them (the hooks module
 * refreshes it, one forge call a minute for the whole machine): its open ones and those merged or
 * closed within a week. A repository the file holds no current reading of is said once and nothing
 * is deleted for it; the sweep asks the file to read it from then on (`prs.wanted`).
 */
function loadPrs(s: Sweep, url: string | undefined): readonly FilePr[] | { readonly why: string } {
  if (url === undefined) return { why: 'the checkout has no origin to ask' }
  const repo = repoOfOrigin(url)
  if (repo === undefined) return { why: `${url} is no GitHub repository` }
  const known = s.prs.get(repo)
  if (known !== undefined) return known
  s.wanted.add(repo)
  const held = prsOfRepo(s.file, repo, s.ctx.deps.now())
  const read = held ?? { why: `${repo} is not in the machine's pull request file yet` }
  if ('why' in read) say(s.ctx, `sweep: cannot read the pull requests of ${repo} (${read.why}); nothing is deleted for it`)
  s.prs.set(repo, read)
  return read
}

/** Whether the pull request is about this commit: its head, or a descendant of it the clone can see. */
async function about(ctx: Context, real: string, heads: readonly string[]): Promise<boolean> {
  const head = (await gitOut(ctx, real, ['rev-parse', 'HEAD'])) ?? ''
  for (const oid of heads) {
    if (oid === head) return true
    if ((await gitRead(ctx, real, ['cat-file', '-e', `${oid}^{commit}`])).status === 0
      && (await gitRead(ctx, real, ['merge-base', '--is-ancestor', head, oid])).status === 0) return true
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
    const prs = loadPrs(s, await gitOut(ctx, real, ['remote', 'get-url', 'origin']))
    if ('why' in prs) return keepIt(`pull requests unreadable: ${prs.why}`)
    const pr = prs.find(p => String(p.pr) === rec)
    if (pr === undefined) return keepIt(`pull request #${rec} is not in the repository's list`)
    if (pr.state !== 'OPEN') return deleteIt(`pull request #${rec} is ${pr.state}`)
    const head = (await gitOut(ctx, real, ['rev-parse', 'HEAD'])) ?? ''
    return pr.sha === head
      ? keepIt(`pinned to the current head of open pull request #${rec}`)
      : deleteIt(`the head of pull request #${rec} moved off the pinned commit`)
  }
  const br = (await gitOut(ctx, real, ['symbolic-ref', '--short', '-q', 'HEAD'])) ?? ''
  if (br === '') return keepIt('no branch checked out, so no pull request to match')
  // A long-lived branch is matched by name by pull requests that are not about it (a fork's own
  // `main`): it is never swept on a name. The default branch is read from origin/HEAD alone: no
  // network and no guess, since a branch guessed wrong would be kept as the default when it is not.
  const defaultBranch = (await gitOut(ctx, real, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])) ?? ''
  if ((LONG_LIVED as readonly string[]).includes(br)) return keepIt(`on ${br}, a long-lived branch`)
  if (`origin/${br}` === defaultBranch) return keepIt(`on ${br}, the repository's default branch`)
  const prs = loadPrs(s, await gitOut(ctx, real, ['remote', 'get-url', 'origin']))
  if ('why' in prs) return keepIt(`pull requests unreadable: ${prs.why}`)
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
  }
}

/** A removal run inside the sweep: its lines held, said once it is known whether it completed. */
async function removeInSweep(s: Sweep, real: string, flags: readonly string[] = []): Promise<{ readonly done: boolean; readonly lines: string; readonly err: string }> {
  const ctx = s.ctx
  const lines: string[] = []
  const errs: string[] = []
  const inner: Context = { ...ctx, deps: { ...ctx.deps, io: { out: t => lines.push(t), err: t => errs.push(t) } } }
  let done = true
  try {
    await remove(inner, [real, '--by', 'sweep', ...flags])
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
  return { done: done && !present(real), lines: lines.join(''), err }
}

/** The first line a refused removal said, without its prefixes and the --discard hint. */
const refusedWhy = (err: string): string =>
  (err.split('\n')[0] ?? '').replace(/^workspace: (delete: )?/, '').replace(/ \(pass --discard.*$/, '')

/** Decide, then delete (or say what would be) and prove it. */
async function sweepOne(s: Sweep, d: string): Promise<void> {
  const ctx = s.ctx
  const real = realOf(d)
  // The ledger's line: the checkout's own, or one adopted for a checkout it does not name.
  let entry = s.ledger.get(real)
  if (entry === undefined) {
    const adopted = await adoptedEntry(ctx, real)
    entry = adopted
    // A line `create` wrote since the ledger was read wins over the adoption.
    if (!s.dry) ledgerWrite(ctx, `the line of ${real}`, () => { entry = adoptEntry(ctx.root, adopted) })
  }
  const agent = agentIn(ctx, real)
  if (agent !== undefined) {
    if (!s.dry && entry.agent !== agent.name) ledgerWrite(ctx, `the agent of ${real}`, () => changeEntry(ctx.root, real, e => ({ ...e, agent: agent.name })))
    return keep(ctx, real, `agent ${agent.name} works in it`)
  }
  // A date that does not read keeps the grace: the safe side.
  const born = Date.parse(entry.created)
  const young = Number.isNaN(born) || ctx.deps.now() - born < GRACE_MS
  // A pin whose clone is gone reads as no checkout at all and has no purpose left, its orchestrator
  // alive or not. Only a clone shown removed counts as gone, and its first hour and its agent hold it.
  const orphan = orphanPin(ctx, real)
  if (orphan !== undefined) {
    if (!orphan.proven) return keep(ctx, real, orphan.why)
    if (young) return keep(ctx, real, 'its clone is gone, kept within its first hour')
    if (namedLive(ctx, entry.agent)) return keep(ctx, real, `its clone is gone, kept while its agent ${entry.agent ?? ''} lives`)
    return sweepOrphanPin(s, d, real)
  }
  if (young || namedLive(ctx, entry.orchestrator) || namedLive(ctx, entry.agent)) {
    if (!s.dry && entry.reason !== undefined) {
      ledgerWrite(ctx, `the reason of ${real}`, () => changeEntry(ctx.root, real, ({ reason: _r, reason_at: _a, said: _s, ...e }) => e))
    }
    return sweepOwned(s, real)
  }
  // A checkout kept by `close --keep-checkout` stays whoever made it: a sweep once ended one its dead
  // maker left, minutes after the close that said to keep it. An orchestrator that lives still lets its
  // pull request's end take the checkout (the path above), which the hooks module's routine closes rely on.
  if (entry.kept !== undefined) return keep(ctx, real, `kept since ${entry.kept} by close --keep-checkout: only delete ends it`)
  return sweepEnded(s, real, entry)
}

/**
 * A pin whose clone is gone: nothing git can read is left of it, so no commit or stash can be lost
 * with it, and `delete` cannot take it (it reads the source). Removed, its line closed, its host
 * directory taken; kept only while a live process works in it.
 */
async function sweepOrphanPin(s: Sweep, d: string, real: string): Promise<void> {
  const ctx = s.ctx
  // `delete` never leaves the root, and neither does this: a link to a directory outside it is no checkout of it.
  if (isSymlink(d) || !underRoot(real, realOf(ctx.root))) return keep(ctx, real, 'its clone is gone, but it is a link or lies outside the root: left alone')
  const held = await liveHold(ctx, real)
  if (held !== '') return keep(ctx, real, held)
  if (s.dry) return out(ctx, `would delete ${real}: its clone is gone`)
  if (!trashRemove(ctx, real, rootTrash(ctx)) || present(real)) return keep(ctx, real, 'its clone is gone, and the removal did not complete')
  ledgerWrite(ctx, `the close of ${real}`, () => closeEntry(ctx.root, real, 'removed', iso(ctx.deps.now()), 'sweep'))
  pruneParents(realOf(ctx.root), dirname(real))
  out(ctx, `deleted ${real}`)
  await removeHostTmp(ctx, [real])
}

/** A checkout its orchestrator still holds, or in its first hour: it goes once its pull request is over. */
async function sweepOwned(s: Sweep, real: string): Promise<void> {
  const ctx = s.ctx
  const verdict = await decide(s, real)
  if (!verdict.delete) return keep(ctx, real, verdict.reason)
  const reason = await refusal(ctx, real)
  if (reason !== '') return keep(ctx, real, reason)
  if (s.dry) return out(ctx, `would delete ${real}: ${verdict.reason}`)
  const removed = await removeInSweep(s, real)
  if (!removed.done) return keep(ctx, real, `the delete did not complete (${(removed.err.split('\n')[0] ?? '').replace(/^workspace: /, '')})`)
  ctx.deps.io.out(removed.lines)
}

/**
 * A checkout whose orchestrator and agent no longer live: its use is over. Its work goes to the
 * origin, then the checkout goes; the next session recreates it from git. What holds it — work
 * that cannot be pushed, uncommitted changes, a live process — is its line's reason, said.
 */
async function sweepEnded(s: Sweep, real: string, entry: WorkspaceEntry): Promise<void> {
  const ctx = s.ctx
  const stays = (reason: string): void => {
    const now = ctx.deps.now()
    const at = iso(now)
    const owners = `(orchestrator ${entry.orchestrator ?? 'unknown'}, agent ${entry.agent ?? 'none'})`
    if (!s.dry && entry.reason !== reason) {
      ledgerWrite(ctx, `the reason of ${real}`, () => changeEntry(ctx.root, real, e => ({ ...e, reason, reason_at: at, said: at })))
      // Said when first recorded: the stop gate logs it for whoever reads the module's log.
      say(ctx, `ledger: ${real} stays: ${reason} ${owners}`)
    } else if (!s.dry && !(now - Date.parse(entry.said ?? entry.reason_at ?? '') < RESAY_MS)) {
      // And once a day after, so a checkout kept for lack of an owner is never kept in silence.
      ledgerWrite(ctx, `the reason of ${real}`, () => changeEntry(ctx.root, real, e => ({ ...e, said: at })))
      say(ctx, `ledger: ${real} still stays since ${entry.reason_at ?? 'an unknown date'}: ${reason} ${owners}`)
    }
    keep(ctx, real, `${reason} (no live orchestrator or agent)`)
  }
  // Who lives is read in the registry: one that cannot be read ends nothing.
  if (sessionsOf(ctx) === null) return keep(ctx, real, 'the session registry cannot be read')
  if (s.dry) {
    const work = await pushWork(ctx, real, true)
    if (work.reason !== '') return stays(work.reason)
    const reason = await refusal(ctx, real, work.pushed.length > 0)
    if (reason !== '') return stays(reason)
    const push = work.pushed.length > 0 ? `, after pushing ${work.pushed.join(' ')}` : ''
    return out(ctx, `would delete ${real}: no live orchestrator or agent${push}`)
  }
  // `delete --push`: what it pushed is said whether the removal completes or not.
  const removed = await removeInSweep(s, real, ['--push'])
  ctx.deps.io.out(removed.lines)
  if (!removed.done) return stays(refusedWhy(removed.err))
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

/**
 * The empty directories already at the top of the root, left by checkouts removed before their
 * parents went with them. One made within the hour is a `create` under way, and stays. False when
 * the deadline cut it.
 */
function sweepEmptyDirs(s: Sweep): boolean {
  const ctx = s.ctx
  for (const d of subdirs(ctx.root)) {
    if (isSymlink(d) || !holdsNothing(d) || ageOf(d, ctx.deps.now()) < GRACE_MS) continue
    if (spent(s)) {
      sayDeadline(s)
      return false
    }
    const at = `${realOf(ctx.root)}/${basename(d)}`
    if (s.dry) out(ctx, `would delete ${at}: empty`)
    else if (removeEmptyDir(d)) out(ctx, `deleted ${at}`)
    else keep(ctx, at, 'empty, and it could not be removed')
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
  const state = orchestratorRoots(env, setting(env, 'HOME')).dataRoot
  const s: Sweep = { ctx: sctx, dry, deadline, t0, file: parsePrFile(readText(prFilePath(state)) ?? ''), wanted: new Set(), prs: new Map(), ledger: new Map(readLedger(ctx.root).map(e => [e.path, e])) }
  try {
    // The trashes, then the orphans — local and cheap — then the checkouts, which read the pull
    // requests: a sweep cut by its deadline has done the cheap part first.
    if (!(await sweepTrash(s))) return
    if (!(await sweepOrphans(s, root))) return
    if (!sweepEmptyDirs(s)) return
    // A line whose checkout is no longer there (removed by hand) is closed: the ledger names what exists.
    if (!dry) {
      for (const e of s.ledger.values()) {
        if (!present(e.path)) ledgerWrite(ctx, `the close of ${e.path}`, () => closeEntry(ctx.root, e.path, 'gone', iso(ctx.deps.now()), 'sweep'))
      }
    }
    for (const d of checkoutDirs(ctx.root)) {
      if (!present(join(d, '.git'))) continue
      if (spent(s)) return sayDeadline(s)
      await sweepOne(s, d)
    }
  } finally {
    if (s.wanted.size > 0) {
      try {
        update(prWantedPath(state), current => withWanted(current ?? '', [...s.wanted], ctx.deps.now()), { waitMs: 2000 })
      } catch (error) {
        say(ctx, `sweep: the repositories wanted in the pull request file not written: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
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
    else if (cmd === 'keep') await markKept(ctx, rest)
    else if (cmd === 'sweep') await sweep(ctx, rest)
    else if (cmd === 'list') await list(ctx, rest)
    else if (cmd === 'ledger') await ledger(ctx, rest)
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
