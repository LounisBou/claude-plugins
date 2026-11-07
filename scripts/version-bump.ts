// The host caches an installed plugin by its version: a change shipped under an unchanged
// version never reaches a running machine. So a pull request that changes what a plugin ships
// raises that plugin's version.
//
//   npm run version-bump -- <base-ref>
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { processIo, type Io } from './lib/io.ts'
import { compareVersions, isEntry, manifestPath, parseManifest, PLUGINS_DIR } from './lib/plugins.ts'

/** Paths inside a plugin that change no behaviour on a machine running it. */
export const NOT_SHIPPED = [/^tests\//, /^evals\//, /^trigger-evals\//, /^docs\//, /^README\.md$/, /^CHANGELOG\.md$/, /^LICENSE$/, /^\.gitignore$/]

/** The plugin directories whose shipped files appear among `changed` (paths from the root). */
export function shippedChanges(changed: readonly string[]): string[] {
  const dirs = new Set<string>()
  for (const path of changed) {
    const match = new RegExp(`^${PLUGINS_DIR}/([^/]+)/(.+)$`).exec(path)
    const dir = match?.[1]
    const rest = match?.[2]
    if (dir === undefined || rest === undefined) continue
    if (!NOT_SHIPPED.some(pattern => pattern.test(rest))) dirs.add(dir)
  }
  return [...dirs].sort()
}

export interface Versions {
  readonly base: string | null
  readonly head: string | null
}

/** One line per plugin that ships a change without a higher version; empty when all hold. */
export function missingBumps(dirs: readonly string[], versionsOf: (dir: string) => Versions): string[] {
  const faults: string[] = []
  for (const dir of dirs) {
    const { base, head } = versionsOf(dir)
    if (base === null || head === null) continue // a plugin added or removed by this change
    if (compareVersions(head, base) <= 0) faults.push(`${dir}: ships a change at ${head}, not above ${base}`)
  }
  return faults
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** The plugin's version at `ref`, or in the working tree when `ref` is null; null where it has none. */
function versionAt(root: string, ref: string | null, dir: string): string | null {
  const path = manifestPath('', dir)
  try {
    const text = ref === null ? readFileSync(manifestPath(root, dir), 'utf8') : git(root, ['show', `${ref}:${path}`])
    return parseManifest(JSON.parse(text), dir).version
  } catch {
    return null
  }
}

export function run(root: string, args: readonly string[], io: Io): number {
  const base = args[0]
  if (base === undefined) {
    io.err('usage: version-bump <base-ref>')
    return 2
  }
  const changed = git(root, ['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean)
  const faults = missingBumps(shippedChanges(changed), dir => ({ base: versionAt(root, base, dir), head: versionAt(root, null, dir) }))
  for (const fault of faults) io.err(fault)
  return faults.length === 0 ? 0 : 1
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
