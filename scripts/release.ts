// The release: one commit raises the version of every plugin that changed since its last release,
// lowers the prompt budgets to what is measured, then regenerates the catalogue. A feature pull
// request raises no version and lowers no budget (`npm run prompts -- --base` refuses one lowered).
//
//   npm run release                       patch for each plugin changed since its last release; commits
//   npm run release -- --minor a,b        those plugins get a MINOR; `--major c` a MAJOR
//   npm run release -- --dry-run          prints the plan, writes and commits nothing
//   npm run release -- --base <ref>       the ref whose history holds the last releases
//
// A plugin's last release is the last commit, in the history of the base, that changed the
// version in its manifest. The base is the merge base with origin/main, else HEAD, so a release
// pull request's own raise is never taken for a release: a plugin whose version already differs
// from its version at its last release was raised by this release, and a re-run leaves it as it
// is. The raise also writes the version into the `marketplace.json` a plugin carries itself.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processIo, type Io } from './lib/io.ts'
import { isEntry, isRecord, manifestPath, parseManifest, PLUGINS_DIR, readPlugins } from './lib/plugins.ts'
import { run as writeCatalogue } from './marketplace.ts'
import { CEILINGS_PATH, run as lowerBudgets } from './prompts.ts'
import { shippedChanges } from './version-bump.ts'

export type Level = 'major' | 'minor' | 'patch'

export interface Bump {
  readonly dir: string
  readonly from: string
  readonly to: string
}

/** `version` raised by `level`. */
export function raise(version: string, level: Level): string {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number)
  if (level === 'major') return `${major + 1}.0.0`
  return level === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
}

/** One bump per plugin whose shipped files changed since its last release; `levels` defaults to patch. */
export function releasePlan(
  versions: ReadonlyMap<string, string>,
  changedSince: (dir: string) => readonly string[],
  levels: ReadonlyMap<string, Level>,
): Bump[] {
  const bumps: Bump[] = []
  for (const [dir, from] of versions) {
    if (shippedChanges(changedSince(dir)).length > 0) bumps.push({ dir, from, to: raise(from, levels.get(dir) ?? 'patch') })
  }
  return bumps
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** The ref whose history holds the last releases: `--base`, else the merge base with origin/main, else HEAD. */
function baseRef(root: string, args: readonly string[]): string {
  const at = args.indexOf('--base')
  if (at >= 0) {
    const ref = args[at + 1]
    if (ref === undefined) throw new Error('--base needs a ref')
    return ref
  }
  try {
    return git(root, ['merge-base', 'HEAD', 'origin/main']).trim()
  } catch {
    return 'HEAD'
  }
}

/**
 * The paths changed under the plugin since its last release, in the history of `base`; none when
 * it never had one, or when its version at HEAD is no longer the one released (already raised).
 */
function changedSinceRelease(root: string, base: string, dir: string): string[] {
  const manifest = manifestPath('', dir)
  const last = git(root, ['log', '-1', '--format=%H', '-G"version"', base, '--', manifest]).trim()
  if (last === '') return []
  const released = parseManifest(JSON.parse(git(root, ['show', `${last}:${manifest}`])), dir).version
  const current = parseManifest(JSON.parse(readFileSync(manifestPath(root, dir), 'utf8')), dir).version
  if (current !== released) return []
  return git(root, ['diff', '--name-only', last, 'HEAD', '--', `${PLUGINS_DIR}/${dir}`]).split('\n').filter(Boolean)
}

/** The path, from the root, of the catalogue a plugin carries itself and which repeats its version; null when none. */
function ownCatalogue(root: string, dir: string): string | null {
  const path = join(PLUGINS_DIR, dir, '.claude-plugin', 'marketplace.json')
  return existsSync(join(root, path)) ? path : null
}

/** The catalogue's text with the version raised in its metadata and in each of its plugins. */
function catalogueRaised(text: string, version: string): string {
  const catalogue: unknown = JSON.parse(text)
  if (!isRecord(catalogue)) throw new Error('a plugin catalogue is not an object')
  const { metadata, plugins } = catalogue
  if (isRecord(metadata) && 'version' in metadata) metadata['version'] = version
  if (Array.isArray(plugins)) {
    for (const entry of plugins) if (isRecord(entry) && 'version' in entry) entry['version'] = version
  }
  return `${JSON.stringify(catalogue, null, 2)}\n`
}

function levelsOf(args: readonly string[]): Map<string, Level> {
  const levels = new Map<string, Level>()
  for (const level of ['minor', 'major'] as const) {
    const at = args.indexOf(`--${level}`)
    const list = at >= 0 ? args[at + 1] : undefined
    if (at >= 0 && list === undefined) throw new Error(`--${level} needs a comma-separated list of plugins`)
    for (const dir of (list ?? '').split(',').filter(Boolean)) levels.set(dir, level)
  }
  return levels
}

export function run(root: string, args: readonly string[], io: Io): number {
  const plugins = readPlugins(root)
  const versions = new Map(plugins.map(plugin => [plugin.dir, plugin.manifest.version]))
  const levels = levelsOf(args)
  for (const dir of levels.keys()) {
    if (!versions.has(dir)) throw new Error(`--minor/--major names "${dir}", which is not a plugin of the repository`)
  }
  const base = baseRef(root, args)
  const bumps = releasePlan(versions, dir => changedSinceRelease(root, base, dir), levels)
  if (bumps.length === 0) {
    io.out('no plugin changed since its last release')
    return 0
  }
  for (const bump of bumps) io.out(`${bump.dir}: ${bump.from} -> ${bump.to}`)
  if (args.includes('--dry-run')) return 0
  if (lowerBudgets(root, ['--lower'], { ...io, out: () => {} }) !== 0) throw new Error(`a prompt budget is exceeded: fix it before the release lowers ${CEILINGS_PATH}`)
  const touched = [CEILINGS_PATH]
  for (const bump of bumps) {
    const path = manifestPath(root, bump.dir)
    const text = readFileSync(path, 'utf8')
    const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${bump.to}$2`)
    if (next === text) throw new Error(`${path}: no version to raise`)
    writeFileSync(path, next)
    touched.push(manifestPath('', bump.dir))
    const own = ownCatalogue(root, bump.dir)
    if (own !== null) {
      writeFileSync(join(root, own), catalogueRaised(readFileSync(join(root, own), 'utf8'), bump.to))
      touched.push(own)
    }
  }
  writeCatalogue(root, [], io)
  git(root, ['add', '.claude-plugin/marketplace.json', ...touched])
  git(root, ['commit', '-q', '-m', `chore(release): ${bumps.map(bump => `${bump.dir} ${bump.to}`).join(', ')}`])
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
