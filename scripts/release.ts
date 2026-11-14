// The release: one commit raises the version of every plugin that changed since its last release,
// lowers the prompt budgets to what is measured, then regenerates the catalogue. A feature pull
// request raises no version and lowers no budget (CI still refuses one exceeded).
//
//   npm run release                       patch for each plugin changed since its last release; commits
//   npm run release -- --minor a,b        those plugins get a MINOR; `--major c` a MAJOR
//   npm run release -- --dry-run          prints the plan, writes and commits nothing
//
// A plugin's last release is the last commit that changed the version in its manifest.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { processIo, type Io } from './lib/io.ts'
import { isEntry, manifestPath, readPlugins } from './lib/plugins.ts'
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

/** The paths changed under the plugin since the last commit that changed its version; none when it never had one. */
function changedSinceRelease(root: string, dir: string): string[] {
  const manifest = manifestPath('', dir)
  const last = git(root, ['log', '-1', '--format=%H', '-G"version"', '--', manifest]).trim()
  if (last === '') return []
  return git(root, ['diff', '--name-only', last, 'HEAD', '--', `plugins/${dir}`]).split('\n').filter(Boolean)
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
  const bumps = releasePlan(versions, dir => changedSinceRelease(root, dir), levels)
  if (bumps.length === 0) {
    io.out('no plugin changed since its last release')
    return 0
  }
  for (const bump of bumps) io.out(`${bump.dir}: ${bump.from} -> ${bump.to}`)
  if (args.includes('--dry-run')) return 0
  if (lowerBudgets(root, ['--lower'], { ...io, out: () => {} }) !== 0) throw new Error(`a prompt budget is exceeded: fix it before the release lowers ${CEILINGS_PATH}`)
  for (const bump of bumps) {
    const path = manifestPath(root, bump.dir)
    const text = readFileSync(path, 'utf8')
    const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${bump.to}$2`)
    if (next === text) throw new Error(`${path}: no version to raise`)
    writeFileSync(path, next)
  }
  writeCatalogue(root, [], io)
  git(root, ['add', '.claude-plugin/marketplace.json', CEILINGS_PATH, ...bumps.map(bump => manifestPath('', bump.dir))])
  git(root, ['commit', '-q', '-m', `chore(release): ${bumps.map(bump => `${bump.dir} ${bump.to}`).join(', ')}`])
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
