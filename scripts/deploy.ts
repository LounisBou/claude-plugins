// Continuous deploy: the newest green commit of `main` installed on this machine.
//
// The host reads a plugin of a directory marketplace in place, from its folder, and caches a copy
// by its version. So each green commit is extracted, once, into a directory of its own that never
// changes, its manifests' versions stamped with the commit (`0.23.2+e458d00`), and the marketplace
// is pointed at it: a new session reads the new directory, a running one keeps the one it loaded,
// and the stamp gives each plugin a new version, so the host's copy (`installPath`) follows. The
// marketplace is pointed at it in every configuration directory sharing this one's plugins
// (`~/.claude-*` whose `plugins` is a link to it): each keeps its own settings.
//
//   npm run deploy                          installs the newest green commit, when not installed yet
//   npm run deploy -- --commit <sha>        installs that commit (a full sha), when green, even an older one
//   npm run deploy -- --rollback            back to the commit installed before; the one left is skipped
//   npm run deploy -- --status [--json]     the installed commit, one line (or the state file)
//
// Under `<config dir>/deploys/lounisbou/`: one directory per commit extracted, `installed.json`, and
// `current`, a link to the installed one (the scheduler runs this script through it, so a commit
// whose own `deploy.ts --status` fails is refused before the link moves). The directory installed
// and the one before are kept, and any left within KEEP_MS: a running session finishes on its own.
//
// Every run also installs, at the user scope, each plugin of the marketplace `settings.json` enables
// and the host does not have, the run that installs no commit included: settings arrive on their own.
// A plugin of INSTALL_STEPS then has its install script run, while what it installs is not there.
//
// Green is a successful run of the `ci` workflow (WORKFLOW_PATH) for a push to `main`: its Linux
// jobs; the night's macOS run does not hold an install back. `installed.json` (version 1) is what
// another machine reads. Reads GitHub through `gh`, the host through `claude plugin`.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { NotInstalled } from '../packages/core/src/locate.ts'
import { configDir, type Env } from '../packages/core/src/paths.ts'
import { INSTALL_TIMEOUT_MS, locatePlaywright } from '../packages/core/src/playwright.ts'
import { readText, withLock, writeAtomic } from '../packages/core/src/store.ts'
import { lockOf } from '../packages/core/src/store-io.ts'
import { DEPLOY_MARKETPLACE as MARKETPLACE, DEPLOY_STATE_FILE, DEPLOY_STATE_VERSION as STATE_VERSION, DEPLOYS_DIR, parseDeployState as parseState, type DeployState as State } from '../packages/core/src/deploy-state.ts'
import { processIo, type Io } from './lib/io.ts'
import { isEntry, isRecord } from './lib/plugins.ts'
import { WORKFLOW_PATH } from './tested-tree.ts'

export const REPOSITORY = 'LounisBou/claude-plugins'
// The state file's shape, its validator and the layout's names are core's (deploy-state.ts): a running session reads them too.
export { DEPLOYS_DIR, MARKETPLACE, parseState, STATE_VERSION, type State }
/** A directory left this recently (replaced, rolled back from, or extracted) may still be read by a running session; kept. */
export const KEEP_MS = 14 * 24 * 3_600_000
const COMMAND_TIMEOUT_MS = 5 * 60_000
/** Past the install's own deadline, so that it is the one that stops and cleans up. */
const STEP_TIMEOUT_MS = INSTALL_TIMEOUT_MS + 60_000
/** Longer than any deploy (the commands of one, each at its timeout): a lock this old was left by one that died. */
const LOCK_STALE_MS = 6 * 60 * 60_000
const SHA = /^[0-9a-f]{40}$/
const REPO = /^[\w.-]+\/[\w.-]+$/
/** A write in flight, left only by a run that died, since a run holds the lock. */
const TEMPORARY = '.tmp-'

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
  /** Its modification time: when it was extracted, or left by a rollback. */
  readonly at: number
}

/**
 * The commit directories to remove: neither installed nor the one before, nor left within KEEP_MS.
 * A directory was left at its modification time, which a rollback sets on the commit it leaves, or,
 * for a commit of the history, when the next one was installed (that entry's `at`), the later of both.
 */
export function prunable(state: State, dirs: readonly Extracted[], now: number): string[] {
  const keep = new Set(state.history.slice(0, 2).map(entry => entry.commit))
  const left = new Map<string, number>()
  state.history.forEach((entry, at) => {
    const next = state.history[at - 1]
    if (next !== undefined && !left.has(entry.commit)) left.set(entry.commit, Date.parse(next.at))
  })
  return dirs.filter(dir => SHA.test(dir.name) && !keep.has(dir.name) && now - Math.max(left.get(dir.name) ?? dir.at, dir.at) >= KEEP_MS).map(dir => dir.name)
}

/** One line: the installed commit, when, the one before, each plugin's version, the last failure. */
export function statusLine(state: State, timeZone?: string): string {
  const [current, previous] = state.history
  if (current === undefined) return `${state.marketplace}: nothing installed`
  const format = new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'short' })
  const versions = Object.entries(state.plugins).map(([name, version]) => `${name} ${version}`).join(', ')
  const before = previous === undefined ? '' : `, previous ${previous.commit.slice(0, 7)}`
  const pending = state.pending ? ' (plugin updates pending: run npm run deploy)' : ''
  const failure = state.lastError === undefined ? '' : `; last failure ${format.format(new Date(state.lastError.at))}: ${state.lastError.message}`
  return `${state.marketplace} ${current.commit.slice(0, 7)} installed ${format.format(new Date(current.at))}${before}${pending}: ${versions}${failure}`
}

/**
 * The configuration directories whose `plugins` resolve to the same directory as `config`'s, the owner of
 * that directory first (`~/.claude`) and its `<owner>-*` siblings after, whichever of them runs: the
 * ones a marketplace pointed at in one is read from in all. `config` alone when it has no `plugins`.
 */
export function sharingConfigs(config: string): string[] {
  const real = realOf(join(config, 'plugins'))
  if (real === undefined) return [config]
  const home = dirname(real)
  const owner = realOf(join(home, 'plugins')) === real ? home : config
  const parent = dirname(owner)
  const prefix = `${basename(owner)}-`
  const siblings = readdirSync(parent).filter(name => name.startsWith(prefix)).sort().map(name => join(parent, name))
  const sharing = [owner, ...siblings.filter(sibling => realOf(join(sibling, 'plugins')) === real)]
  return sharing.some(each => realOf(each) === realOf(config)) ? sharing : [...sharing, config]
}

function realOf(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** One installation of a plugin: a plugin installed at the user and the project scope has two, each updated on its own. */
export interface Installed {
  readonly id: string
  readonly version: string
  /** `user`, `project`, `local` or `managed`. */
  readonly scope: string
  /** The project a `project` or `local` entry belongs to. */
  readonly projectPath?: string
}

/**
 * The plugins whose install script the deploy runs, which must ask nothing and write no setting. `done`
 * reads whether what the script installs for its pin is there, so a raised pin and a failed run are both
 * taken up again. The pin is the running script's: right after a commit raises it, the next run sees it.
 */
const INSTALL_STEPS: readonly { readonly plugin: string; readonly script: string; readonly done: (env: Env) => boolean }[] = [
  { plugin: 'drift', script: join('plugins', 'drift', 'install.sh'), done: hasPlaywright },
]

function hasPlaywright(env: Env): boolean {
  try {
    locatePlaywright(env, '/drift:install')
    return true
  } catch (error) {
    if (error instanceof NotInstalled) return false
    throw error
  }
}

/** What the deploy reaches outside: GitHub, the host's plugin commands, the clock. */
export interface Host {
  /** The API's JSON answer at `path`. */
  readonly api: (path: string) => unknown
  /** Extracts the repository's tree at `commit` into the empty directory `into`. */
  readonly extract: (repo: string, commit: string, into: string) => void
  /** Runs the tree's own `scripts/deploy.ts --status`, which the scheduler runs once it is installed; throws when it fails. */
  readonly smoke: (dir: string) => void
  /** Points the marketplace of the configuration directory `config` at the directory. */
  readonly repoint: (dir: string, config: string) => void
  /** The installed plugins, one entry per scope a plugin is installed at: `<name>@<marketplace>`, the version the host records, its scope. */
  readonly installed: () => Installed[]
  /** Updates the entry of one installed plugin at `scope` to the version its marketplace now names. */
  readonly update: (id: string, scope: string, projectPath?: string) => void
  /** Installs one plugin of the marketplace at the user scope. */
  readonly installPlugin: (id: string) => void
  /** Runs a plugin's install script for the configuration directory `config`; returns what it printed. */
  readonly installStep: (script: string, config: string) => string
  /** Whether the process `pid` still runs. */
  readonly alive: (pid: number) => boolean
  readonly now: () => number
}

function commandOf(file: string, args: readonly string[], options: { input?: Buffer; encoding?: 'utf8'; env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {}): string | Buffer {
  return execFileSync(file, args, { timeout: COMMAND_TIMEOUT_MS, ...options, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 1 << 30 })
}

/* node:coverage disable */
export function processHost(): Host {
  return {
    api: path => JSON.parse(String(commandOf('gh', ['api', path], { encoding: 'utf8' }))),
    extract: (repo, commit, into) => {
      const archive = commandOf('gh', ['api', `repos/${repo}/tarball/${commit}`])
      commandOf('tar', ['-xzf', '-', '-C', into, '--strip-components=1'], { input: Buffer.from(archive) })
    },
    smoke: dir => void commandOf(process.execPath, ['--experimental-strip-types', '--no-warnings', join(dir, 'scripts', 'deploy.ts'), '--status']),
    repoint: (dir, config) => void commandOf('claude', ['plugin', 'marketplace', 'add', dir], { env: { ...process.env, CLAUDE_CONFIG_DIR: config } }),
    installed: () => {
      const list: unknown = JSON.parse(String(commandOf('claude', ['plugin', 'list', '--json'], { encoding: 'utf8' })))
      if (!Array.isArray(list)) throw new Error('claude plugin list --json is not a list')
      const entries = list.map(entry => {
        if (!isRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['version'] !== 'string') throw new Error('claude plugin list --json: an entry has no id or version')
        if (typeof entry['scope'] !== 'string') throw new Error('claude plugin list --json: an entry has no scope')
        const projectPath = typeof entry['projectPath'] === 'string' ? entry['projectPath'] : undefined
        return { id: entry['id'], version: entry['version'], scope: entry['scope'], ...(projectPath === undefined ? {} : { projectPath }) }
      })
      // The host updates a project's entry from that project's directory: an entry whose directory is gone cannot be, and must not fail every run.
      return entries.filter(plugin => plugin.projectPath === undefined || existsSync(plugin.projectPath))
    },
    // Without `--scope` the host updates the one entry its working directory selects (the project's when the scheduler runs from the project's directory), and the other stays behind.
    update: (id, scope, projectPath) => void commandOf('claude', ['plugin', 'update', id, '--scope', scope], projectPath === undefined ? {} : { cwd: projectPath }),
    installPlugin: id => void commandOf('claude', ['plugin', 'install', id, '--scope', 'user']),
    installStep: (script, config) => String(commandOf('bash', [script], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config }, timeout: STEP_TIMEOUT_MS })),
    alive: pid => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return isRecord(error) && error['code'] === 'EPERM'
      }
    },
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
  /** The configuration directory the run belongs to. */
  readonly config: string
  readonly root: string
  readonly state: string
}

/** Removes a file, a directory or a link (`rmSync` keeps a link whose target is gone). */
function remove(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true })
  else if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true) unlinkSync(path)
}

/** Whether the lock at `path` was left by a run that died: its pid no longer runs, or it is older than LOCK_STALE_MS. */
function isStale(path: string, host: Host): boolean {
  const pid = Number((readText(path) ?? '').trim())
  if (Number.isInteger(pid) && pid > 0 && !host.alive(pid)) return true
  const stat = statSync(path, { throwIfNoEntry: false })
  return stat !== undefined && host.now() - stat.mtimeMs >= LOCK_STALE_MS
}

function writeState(paths: Paths, state: State): void {
  writeAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`)
}

/** The state without its last failure. */
function withoutFailure({ lastError: _failure, ...state }: State): State {
  return state
}

/** Records `message` as the last failure in the state, when there is a state to record it in; the run's own error still reaches stderr. */
function recordFailure(paths: Paths, message: string, now: number, io: Io): void {
  try {
    const state = readState(paths)
    if (state !== undefined) writeState(paths, { ...state, lastError: { at: new Date(now).toISOString(), message: message.replace(/\s+/g, ' ').trim() } })
  } catch (error) {
    io.err(`deploy: the failure was not recorded in installed.json: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readState(paths: Paths): State | undefined {
  const text = readText(paths.state)
  return text === undefined ? undefined : parseState(text)
}

/** Points the marketplace at `dir` in every configuration directory sharing the plugins of `config`, `config` first; one that cannot be pointed fails the run, named. */
function repointAll(host: Host, dir: string, config: string): void {
  const failures: string[] = []
  for (const each of sharingConfigs(config)) {
    try {
      host.repoint(dir, each)
    } catch (error) {
      failures.push(`${each}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(`${failures.join('; ')}: run npm run deploy again`)
}

/** The status bar's launcher in a tree, and where the bar's installer puts its copy in a configuration directory. */
const LAUNCHER_IN_TREE = join('plugins', 'statusbar', 'statusline', 'launcher.sh')
const LAUNCHER_IN_CONFIG = join('statusbar', 'statusline.sh')

/**
 * Writes the launcher of the tree at `dir` over the copy the status bar's installer left in each configuration
 * directory sharing the plugins, where that copy exists and differs: `settings.json` runs the copy, which no
 * plugin update reaches. Written through a link to its target, atomically, mode 755; a file already equal is
 * not rewritten. One failing configuration is told on stderr and does not hold back the others.
 */
function refreshLaunchers(paths: Paths, dir: string, io: Io): void {
  try {
    const wanted = readText(join(dir, LAUNCHER_IN_TREE))
    if (wanted === undefined) return
    for (const config of sharingConfigs(paths.config)) {
      try {
        const copy = realOf(join(config, LAUNCHER_IN_CONFIG))
        if (copy === undefined || readText(copy) === wanted) continue
        writeAtomic(copy, wanted, 0o755)
        chmodSync(copy, 0o755)
        io.out(`deploy: refreshed the status line launcher ${copy}`)
      } catch (error) {
        io.err(`deploy: the status line launcher of ${config} was not refreshed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } catch (error) {
    io.err(`deploy: the status line launcher was not refreshed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Where an installation other than the user's lives, for a message: ` at project /path`; empty for the user scope. */
function atScope(plugin: Installed): string {
  return plugin.scope === 'user' ? '' : ` at ${plugin.scope}${plugin.projectPath === undefined ? '' : ` ${plugin.projectPath}`}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The plugin's name in the id the host knows it by, `<name>@lounisbou`. */
function nameOf(id: string): string {
  return id.slice(0, -`@${MARKETPLACE}`.length)
}

/** Whether the commit of `state` has the plugin `id`. */
function carries(state: State, id: string): boolean {
  return Object.hasOwn(state.plugins, nameOf(id))
}

/** The marketplace's plugins the `settings.json` of `config` enables, by id; none without the file. */
function enabledIn(config: string): string[] {
  const path = join(config, 'settings.json')
  const text = readText(path)
  if (text === undefined) return []
  let settings: unknown
  try {
    settings = JSON.parse(text)
  } catch {
    throw new Error(`${path} is not JSON: the plugins it enables are not known`)
  }
  const enabled = isRecord(settings) ? settings['enabledPlugins'] : undefined
  if (!isRecord(enabled)) return []
  return Object.keys(enabled).filter(id => id.endsWith(`@${MARKETPLACE}`) && enabled[id] === true)
}

/** The plugins `config` enables with no installation at the user scope among those `installed` lists. */
function absent(config: string, installed: () => readonly Installed[]): string[] {
  const enabled = enabledIn(config)
  if (enabled.length === 0) return []
  const atUser = new Set(installed().filter(plugin => plugin.scope === 'user').map(plugin => plugin.id))
  return enabled.filter(id => !atUser.has(id))
}

/** Installs each enabled plugin the host does not have; returns the failures, one never holding back the next. */
function installAbsent(paths: Paths, host: Host, state: State, installed: readonly Installed[], io: Io): string[] {
  const failures: string[] = []
  try {
    for (const id of absent(paths.config, () => installed)) {
      if (!carries(state, id)) {
        io.err(`deploy: ${id} is enabled and not in ${(state.history[0]?.commit ?? '').slice(0, 7)}: not installed`)
        continue
      }
      try {
        host.installPlugin(id)
        io.out(`deploy: installed ${id}, enabled in settings.json`)
      } catch (error) {
        failures.push(`${id}: ${messageOf(error)}`)
      }
    }
  } catch (error) {
    failures.push(messageOf(error))
  }
  return failures
}

/**
 * Runs the install script of each plugin of INSTALL_STEPS that is enabled, installed, in the installed
 * commit and not done, for the configuration directory that owns the plugins (its siblings link what it
 * holds). Run after the plugins, at every run: a failure leaves no update pending and returns here.
 */
function installSteps(paths: Paths, host: Host, io: Io): string[] {
  let state: State | undefined
  try {
    state = readState(paths)
  } catch {
    // The run read it first and has said why it cannot.
    return []
  }
  const commit = state?.history[0]?.commit
  if (state === undefined || commit === undefined) return []
  const owner = sharingConfigs(paths.config)[0] ?? paths.config
  const failures: string[] = []
  for (const step of INSTALL_STEPS) {
    const id = `${step.plugin}@${MARKETPLACE}`
    try {
      if (!carries(state, id) || step.done({ ...io.env, CLAUDE_CONFIG_DIR: owner })) continue
      if (!enabledIn(paths.config).includes(id) || !host.installed().some(plugin => plugin.id === id)) continue
      const said = host.installStep(join(paths.root, commit, step.script), owner)
      io.out(`deploy: ${id} install step: ${said.trim().split('\n').at(-1) ?? ''}`)
    } catch (error) {
      failures.push(`${id} install step: ${messageOf(error)}`)
    }
  }
  return failures
}

/** Points the marketplace and the `current` link at `commit`'s directory, installs the enabled plugins it lacks and updates the others. */
function install(paths: Paths, host: Host, state: State, io: Io): State {
  const commit = state.history[0]?.commit ?? ''
  const dir = join(paths.root, commit)
  try {
    host.smoke(dir)
  } catch (error) {
    throw new Error(`${commit.slice(0, 7)} does not run: ${error instanceof Error ? error.message : String(error)}`)
  }
  repointAll(host, dir, paths.config)
  const link = join(paths.root, `current${TEMPORARY}${process.pid}`)
  remove(link)
  symlinkSync(dir, link)
  renameSync(link, join(paths.root, 'current'))
  writeState(paths, { ...state, pending: true })
  // Before the plugin updates: the launcher does not wait on them, and a plugin that cannot update must not freeze it.
  refreshLaunchers(paths, dir, io)
  const ours = (): Installed[] => host.installed().filter(plugin => plugin.id.endsWith(`@${MARKETPLACE}`))
  // Listed before the installs: a plugin installed now is at the commit's version already.
  const present = ours()
  const failures = installAbsent(paths, host, state, present, io)
  for (const plugin of present) {
    if (!carries(state, plugin.id)) {
      io.err(`deploy: ${plugin.id} is not in ${commit.slice(0, 7)}: left as installed`)
      continue
    }
    try {
      host.update(plugin.id, plugin.scope, plugin.projectPath)
    } catch (error) {
      failures.push(`${plugin.id}${atScope(plugin)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(`${failures.join('; ')}: run npm run deploy again`)
  const behind = ours().filter(plugin => carries(state, plugin.id) && plugin.version !== state.plugins[nameOf(plugin.id)])
  if (behind.length > 0) throw new Error(`the host did not update ${behind.map(plugin => `${plugin.id} (${plugin.version})${atScope(plugin)}`).join(', ')}: run npm run deploy again`)
  const done = { ...state, pending: false }
  writeState(paths, done)
  io.out(statusLine(done))
  return done
}

function deploy(paths: Paths, host: Host, args: readonly string[], io: Io): void {
  const repo = optionOf(args, '--repo') ?? REPOSITORY
  if (!REPO.test(repo)) throw new Error(`--repo takes owner/name, not ${JSON.stringify(repo)}`)
  const only = optionOf(args, '--commit')
  if (only !== undefined && !SHA.test(only)) throw new Error('--commit takes a full commit sha (40 hexadecimal characters)')
  const state = readState(paths)
  const runs = host.api(`repos/${repo}/actions/workflows/${WORKFLOW_PATH.split('/').pop() ?? ''}/runs?branch=main&status=success&exclude_pull_requests=true&per_page=100`)
  const green = greenCommit(runs, only)
  if (green === null) {
    if (only !== undefined) throw new Error(`${only} has no successful push run on main among the last 100`)
    io.out('deploy: no commit of main with a successful push run')
    return
  }
  const installed = state?.history[0]?.commit === green
  if (installed || (only === undefined && !isNew(state, green))) {
    if (state?.pending === true) install(paths, host, state, io)
    else {
      io.out(`deploy: ${green.slice(0, 7)}, the newest green commit, is ${installed ? 'installed' : 'not deployed again (rolled back from)'}`)
      const current = state?.history[0]?.commit
      if (state !== undefined && current !== undefined) {
        refreshLaunchers(paths, join(paths.root, current), io)
        // Settings change without a commit here: a plugin they now enable is installed by this run.
        if (absent(paths.config, host.installed).some(id => carries(state, id))) install(paths, host, state, io)
      }
    }
    return
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
}

function rollback(paths: Paths, host: Host, io: Io): void {
  const state = readState(paths)
  const [current, previous] = state?.history ?? []
  if (state === undefined || current === undefined || previous === undefined || !existsSync(join(paths.root, previous.commit))) {
    throw new Error('no earlier commit installed to roll back to')
  }
  const left = join(paths.root, current.commit)
  if (existsSync(left)) utimesSync(left, new Date(host.now()), new Date(host.now()))
  install(paths, host, { ...state, history: state.history.slice(1), skipped: [...state.skipped, current.commit], plugins: versionsIn(join(paths.root, previous.commit)) }, io)
}

function prune(paths: Paths, state: State, now: number): void {
  const dirs = readdirSync(paths.root).filter(name => SHA.test(name)).map(name => ({ name, at: lstatSync(join(paths.root, name)).mtimeMs }))
  for (const dir of prunable(state, dirs, now)) rmSync(join(paths.root, dir), { recursive: true, force: true })
}

export function run(args: readonly string[], io: Io, host: Host = processHost()): number {
  const config = configDir(io.env)
  const root = join(config, DEPLOYS_DIR, MARKETPLACE)
  const paths: Paths = { config, root, state: join(root, DEPLOY_STATE_FILE) }
  try {
    if (args.includes('--status')) {
      const state = readState(paths)
      io.out(state === undefined ? `nothing deployed under ${root}` : args.includes('--json') ? JSON.stringify(state) : statusLine(state))
      return 0
    }
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const lock = lockOf(paths.state)
    if (existsSync(lock)) {
      const judged = readText(lock)
      if (isStale(lock, host)) {
        // Only the lock judged: a run that took it over meanwhile wrote its own pid.
        if (readText(lock) === judged) rmSync(lock, { force: true })
        io.err('deploy: removed the lock of a run that died')
      } else if (args.includes('--rollback')) {
        io.err('deploy: another deploy is running: roll back once it ends')
        return 1
      } else {
        io.out('deploy: another deploy is running')
        return 0
      }
    }
    return withLock(paths.state, () => {
      for (const name of readdirSync(root)) if (name.includes(TEMPORARY)) remove(join(root, name))
      const failures: string[] = []
      try {
        if (args.includes('--rollback')) rollback(paths, host, io)
        else deploy(paths, host, args, io)
      } catch (error) {
        failures.push(messageOf(error))
      }
      failures.push(...installSteps(paths, host, io))
      if (failures.length > 0) {
        recordFailure(paths, failures.join('; '), host.now(), io)
        throw new Error(failures.join('; '))
      }
      const state = readState(paths)
      if (state?.lastError !== undefined) writeState(paths, withoutFailure(state))
      return 0
    }, { waitMs: 0, staleMs: LOCK_STALE_MS, now: host.now })
  } catch (error) {
    io.err(`deploy: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.argv.slice(2), processIo))
