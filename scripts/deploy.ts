// Continuous deploy: the newest green commit of `main` installed on this machine.
//
// The host reads a plugin of a directory marketplace in place, from its folder, and caches a copy
// by its version. So each green commit is extracted, once, into a directory of its own that never
// changes, its manifests' versions stamped with the commit (`0.23.2+e458d00`), and the marketplace
// is pointed at it: a new session reads the new directory, a running one keeps the one it loaded,
// and the stamp gives each plugin a new version, so the host's copy (`installPath`) follows.
//
//   npm run deploy                          installs the newest green commit, when not installed yet
//   npm run deploy -- --commit <sha>        installs that commit (a full sha), when green, even an older one
//   npm run deploy -- --rollback            back to the commit installed before; the one left is skipped
//   npm run deploy -- --status [--json]     the installed commit, one line (or the state file)
//
// Under `<config dir>/deploys/lounisbou/`: one directory per commit extracted, `installed.json`, and
// `current`, a link to the installed one (the scheduler runs this script through it). The directory
// installed and the one before are kept, and any extracted within KEEP_MS.
//
// Green is a successful run of the `ci` workflow (WORKFLOW_PATH) for a push to `main`: its Linux
// jobs; the night's macOS run does not hold an install back. `installed.json` (version 1) is what
// another machine reads. Reads GitHub through `gh`, the host through `claude plugin`.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../packages/core/src/paths.ts'
import { readText, withLock, writeAtomic } from '../packages/core/src/store.ts'
import { lockOf } from '../packages/core/src/store-io.ts'
import { processIo, type Io } from './lib/io.ts'
import { isEntry, isRecord } from './lib/plugins.ts'
import { WORKFLOW_PATH } from './tested-tree.ts'

export const REPOSITORY = 'LounisBou/claude-plugins'
/** The catalogue's name (`.claude-plugin/marketplace.json`), which the host keys installs by. */
export const MARKETPLACE = 'lounisbou'
/** Under the host's configuration directory: `<marketplace>/<sha>/`, `installed.json`, `current`. */
export const DEPLOYS_DIR = 'deploys'
export const STATE_VERSION = 1
/** A directory extracted this recently may still be read by a running session; kept. */
export const KEEP_MS = 14 * 24 * 3_600_000
const COMMAND_TIMEOUT_MS = 5 * 60_000
/** Longer than any deploy (the commands of one, each at its timeout): a lock this old was left by one that died. */
const LOCK_STALE_MS = 6 * 60 * 60_000
const SHA = /^[0-9a-f]{40}$/
const REPO = /^[\w.-]+\/[\w.-]+$/
/** A write in flight, left only by a run that died, since a run holds the lock. */
const TEMPORARY = '.tmp-'

export interface Installed {
  readonly commit: string
  /** ISO time of the install. */
  readonly at: string
}

export interface State {
  readonly version: typeof STATE_VERSION
  readonly repo: string
  readonly marketplace: string
  /** Newest first; the first is the installed commit. */
  readonly history: readonly Installed[]
  /** Commits left by a rollback, never deployed again. */
  readonly skipped: readonly string[]
  /** Plugins of the marketplace still to update to the installed commit (an update failed). */
  readonly pending: boolean
  /** Each plugin's version at the installed commit, stamped. */
  readonly plugins: Readonly<Record<string, string>>
}

function installedOf(value: unknown): Installed {
  if (!isRecord(value) || typeof value['commit'] !== 'string' || !SHA.test(value['commit']) || typeof value['at'] !== 'string') {
    throw new Error('installed.json: a history entry is not {commit, at}')
  }
  return { commit: value['commit'], at: value['at'] }
}

/** The state file's text validated, or an error naming what is wrong. */
export function parseState(text: string): State {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw) || raw['version'] !== STATE_VERSION) throw new Error(`installed.json: not version ${STATE_VERSION}`)
  const { repo, marketplace, history, skipped, pending, plugins } = raw
  if (typeof repo !== 'string' || marketplace !== MARKETPLACE) throw new Error(`installed.json: no repo, or a marketplace other than ${MARKETPLACE}`)
  if (!Array.isArray(history) || history.length === 0) throw new Error('installed.json: no history')
  if (typeof pending !== 'boolean') throw new Error('installed.json: pending is not a boolean')
  if (!Array.isArray(skipped) || !skipped.every(sha => typeof sha === 'string' && SHA.test(sha))) throw new Error('installed.json: skipped is not a list of commits')
  if (!isRecord(plugins) || !Object.values(plugins).every(version => typeof version === 'string')) throw new Error('installed.json: plugins is not {name: version}')
  return {
    version: STATE_VERSION,
    repo,
    marketplace,
    history: history.map(installedOf),
    skipped: skipped.filter((sha): sha is string => typeof sha === 'string'),
    pending,
    plugins: Object.fromEntries(Object.entries(plugins).map(([name, version]) => [name, String(version)])),
  }
}

/** The newest commit with a successful push run (`only`, when given), from the API's list of runs, newest first; null when none. */
export function greenCommit(runs: unknown, only?: string): string | null {
  const list = isRecord(runs) ? runs['workflow_runs'] : undefined
  if (!Array.isArray(list)) throw new Error('the API answer carries no workflow_runs')
  for (const run of list) {
    if (!isRecord(run) || run['conclusion'] !== 'success' || run['event'] !== 'push' || run['head_branch'] !== 'main') continue
    const sha = run['head_sha']
    if (typeof sha === 'string' && SHA.test(sha) && (only === undefined || sha === only)) return sha
  }
  return null
}

/** Whether `green` is to be deployed over `state`: never installed before, never rolled back from. */
export function isNew(state: State | undefined, green: string): boolean {
  if (state === undefined) return true
  return !state.history.some(entry => entry.commit === green) && !state.skipped.includes(green)
}

/** `version` stamped with the commit: `1.2.3+abcdef0`, any earlier stamp replaced. */
export function stamped(version: string, commit: string): string {
  return `${version.replace(/\+.*$/, '')}+${commit.slice(0, 7)}`
}

/** The manifest of each plugin of the tree at `root`, by its directory; refuses one that leaves the tree or has no version. */
function manifestsIn(root: string): Map<string, { path: string; manifest: Record<string, unknown>; version: string }> {
  const real = realpathSync(root)
  const manifests = new Map<string, { path: string; manifest: Record<string, unknown>; version: string }>()
  for (const dir of readdirSync(join(root, 'plugins')).sort()) {
    const path = join(root, 'plugins', dir, '.claude-plugin', 'plugin.json')
    if (!existsSync(path)) continue
    if (!realpathSync(path).startsWith(`${real}/`)) throw new Error(`${path} leads out of the tree`)
    const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const version = isRecord(manifest) ? manifest['version'] : undefined
    if (!isRecord(manifest) || typeof version !== 'string') throw new Error(`${path}: no version`)
    manifests.set(dir, { path, manifest, version })
  }
  return manifests
}

/** Stamps the version of every plugin manifest under `root`; returns each plugin's new version. */
export function stampTree(root: string, commit: string): Record<string, string> {
  const versions: Record<string, string> = {}
  for (const [dir, { path, manifest, version }] of manifestsIn(root)) {
    versions[dir] = stamped(version, commit)
    writeFileSync(path, `${JSON.stringify({ ...manifest, version: versions[dir] }, null, 2)}\n`)
  }
  return versions
}

/** Each plugin's version in the tree at `root`, by its directory. */
export function versionsIn(root: string): Record<string, string> {
  return Object.fromEntries([...manifestsIn(root)].map(([dir, { version }]) => [dir, version]))
}

export interface Extracted {
  readonly name: string
  /** When it was extracted (its modification time). */
  readonly at: number
}

/** The commit directories to remove: neither installed nor the one before, nor extracted within KEEP_MS. */
export function prunable(state: State, dirs: readonly Extracted[], now: number): string[] {
  const keep = new Set(state.history.slice(0, 2).map(entry => entry.commit))
  return dirs.filter(dir => SHA.test(dir.name) && !keep.has(dir.name) && now - dir.at >= KEEP_MS).map(dir => dir.name)
}

/** One line: the installed commit, when, the one before, each plugin's version. */
export function statusLine(state: State, timeZone?: string): string {
  const [current, previous] = state.history
  if (current === undefined) return `${state.marketplace}: nothing installed`
  const when = new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(current.at))
  const versions = Object.entries(state.plugins).map(([name, version]) => `${name} ${version}`).join(', ')
  const before = previous === undefined ? '' : `, previous ${previous.commit.slice(0, 7)}`
  const pending = state.pending ? ' (plugin updates pending: run npm run deploy)' : ''
  return `${state.marketplace} ${current.commit.slice(0, 7)} installed ${when}${before}${pending}: ${versions}`
}

/** What the deploy reaches outside: GitHub, the host's plugin commands, the clock. */
export interface Host {
  /** The API's JSON answer at `path`. */
  readonly api: (path: string) => unknown
  /** Extracts the repository's tree at `commit` into the empty directory `into`. */
  readonly extract: (repo: string, commit: string, into: string) => void
  /** Points the marketplace at the directory. */
  readonly repoint: (dir: string) => void
  /** The installed plugins: `<name>@<marketplace>` and the version the host records. */
  readonly installed: () => { id: string; version: string }[]
  /** Updates one installed plugin to the version its marketplace now names. */
  readonly update: (id: string) => void
  readonly now: () => number
}

function commandOf(file: string, args: readonly string[], options: { input?: Buffer; encoding?: 'utf8' } = {}): string | Buffer {
  return execFileSync(file, args, { ...options, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1 << 30 })
}

/* node:coverage disable */
export function processHost(): Host {
  return {
    api: path => JSON.parse(String(commandOf('gh', ['api', path], { encoding: 'utf8' }))),
    extract: (repo, commit, into) => {
      const archive = commandOf('gh', ['api', `repos/${repo}/tarball/${commit}`])
      commandOf('tar', ['-xzf', '-', '-C', into, '--strip-components=1'], { input: Buffer.from(archive) })
    },
    repoint: dir => void commandOf('claude', ['plugin', 'marketplace', 'add', dir]),
    installed: () => {
      const list: unknown = JSON.parse(String(commandOf('claude', ['plugin', 'list', '--json'], { encoding: 'utf8' })))
      if (!Array.isArray(list)) throw new Error('claude plugin list --json is not a list')
      return list.map(entry => {
        if (!isRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['version'] !== 'string') throw new Error('claude plugin list --json: an entry has no id or version')
        return { id: entry['id'], version: entry['version'] }
      })
    },
    update: id => void commandOf('claude', ['plugin', 'update', id]),
    now: Date.now,
  }
}
/* node:coverage enable */

function optionOf(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const value = args[at + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

interface Paths {
  readonly root: string
  readonly state: string
}

/** Removes a file, a directory or a link (`rmSync` keeps a link whose target is gone). */
function remove(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true })
  else if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true) unlinkSync(path)
}

/** Whether the lock at `path` was left by a run that died (older than LOCK_STALE_MS). */
function isStale(path: string, now: number): boolean {
  return now - statSync(path).mtimeMs >= LOCK_STALE_MS
}

function readState(paths: Paths): State | undefined {
  const text = readText(paths.state)
  return text === undefined ? undefined : parseState(text)
}

/** Points the marketplace and the `current` link at `commit`'s directory, then updates every plugin of it. */
function install(paths: Paths, host: Host, state: State, io: Io): State {
  const dir = join(paths.root, state.history[0]?.commit ?? '')
  host.repoint(dir)
  const link = join(paths.root, `current${TEMPORARY}${process.pid}`)
  remove(link)
  symlinkSync(dir, link)
  renameSync(link, join(paths.root, 'current'))
  writeAtomic(paths.state, `${JSON.stringify({ ...state, pending: true }, null, 2)}\n`)
  const ours = (): { id: string; version: string }[] => host.installed().filter(plugin => plugin.id.endsWith(`@${MARKETPLACE}`))
  for (const plugin of ours()) host.update(plugin.id)
  const behind = ours().filter(plugin => plugin.version !== state.plugins[plugin.id.slice(0, -`@${MARKETPLACE}`.length)])
  if (behind.length > 0) throw new Error(`the host did not update ${behind.map(plugin => `${plugin.id} (${plugin.version})`).join(', ')}: run npm run deploy again`)
  const done = { ...state, pending: false }
  writeAtomic(paths.state, `${JSON.stringify(done, null, 2)}\n`)
  io.out(statusLine(done))
  return done
}

function deploy(paths: Paths, host: Host, args: readonly string[], io: Io): number {
  const repo = optionOf(args, '--repo') ?? REPOSITORY
  if (!REPO.test(repo)) throw new Error(`--repo takes owner/name, not ${JSON.stringify(repo)}`)
  const only = optionOf(args, '--commit')
  if (only !== undefined && !SHA.test(only)) throw new Error('--commit takes a full commit sha (40 hexadecimal characters)')
  const state = readState(paths)
  const runs = host.api(`repos/${repo}/actions/workflows/${WORKFLOW_PATH.split('/').pop() ?? ''}/runs?branch=main&status=success&exclude_pull_requests=true&per_page=100`)
  const green = greenCommit(runs, only)
  if (green === null) {
    if (only !== undefined) {
      io.err(`deploy: ${only} has no successful push run on main among the last 100`)
      return 1
    }
    io.out('deploy: no commit of main with a successful push run')
    return 0
  }
  const installed = state?.history[0]?.commit === green
  if (installed || (only === undefined && !isNew(state, green))) {
    if (state?.pending === true) install(paths, host, state, io)
    else io.out(`deploy: ${green.slice(0, 7)}, the newest green commit, is ${installed ? 'installed' : 'not deployed again (rolled back from)'}`)
    return 0
  }
  const dir = join(paths.root, green)
  if (!existsSync(dir)) {
    const temporary = join(paths.root, `${green}${TEMPORARY}${process.pid}`)
    rmSync(temporary, { recursive: true, force: true })
    mkdirSync(temporary, { recursive: true })
    host.extract(repo, green, temporary)
    stampTree(temporary, green)
    renameSync(temporary, dir)
  }
  const catalogue: unknown = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'marketplace.json'), 'utf8'))
  if (!isRecord(catalogue) || catalogue['name'] !== MARKETPLACE) throw new Error(`${dir}: the catalogue is not named ${MARKETPLACE}`)
  const next: State = {
    version: STATE_VERSION,
    repo,
    marketplace: MARKETPLACE,
    history: [{ commit: green, at: new Date(host.now()).toISOString() }, ...(state?.history ?? [])],
    skipped: (state?.skipped ?? []).filter(sha => sha !== green),
    pending: true,
    plugins: versionsIn(dir),
  }
  const done = install(paths, host, next, io)
  try {
    prune(paths, done, host.now())
  } catch (error) {
    io.err(`deploy: installed, but the old directories were not removed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return 0
}

function rollback(paths: Paths, host: Host, io: Io): number {
  const state = readState(paths)
  const [current, previous] = state?.history ?? []
  if (state === undefined || current === undefined || previous === undefined || !existsSync(join(paths.root, previous.commit))) {
    io.err('deploy: no earlier commit installed to roll back to')
    return 1
  }
  install(paths, host, { ...state, history: state.history.slice(1), skipped: [...state.skipped, current.commit], plugins: versionsIn(join(paths.root, previous.commit)) }, io)
  return 0
}

function prune(paths: Paths, state: State, now: number): void {
  const dirs = readdirSync(paths.root).filter(name => SHA.test(name)).map(name => ({ name, at: lstatSync(join(paths.root, name)).mtimeMs }))
  for (const dir of prunable(state, dirs, now)) rmSync(join(paths.root, dir), { recursive: true, force: true })
}

export function run(args: readonly string[], io: Io, host: Host = processHost()): number {
  const root = join(configDir(io.env), DEPLOYS_DIR, MARKETPLACE)
  const paths: Paths = { root, state: join(root, 'installed.json') }
  try {
    if (args.includes('--status')) {
      const state = readState(paths)
      io.out(state === undefined ? `nothing deployed under ${root}` : args.includes('--json') ? JSON.stringify(state) : statusLine(state))
      return 0
    }
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (existsSync(lockOf(paths.state)) && !isStale(lockOf(paths.state), host.now())) {
      io.out('deploy: another deploy is running')
      return 0
    }
    return withLock(paths.state, () => {
      for (const name of readdirSync(root)) if (name.includes(TEMPORARY)) remove(join(root, name))
      return args.includes('--rollback') ? rollback(paths, host, io) : deploy(paths, host, args, io)
    }, { waitMs: 0, staleMs: LOCK_STALE_MS, now: host.now })
  } catch (error) {
    io.err(`deploy: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.argv.slice(2), processIo))
