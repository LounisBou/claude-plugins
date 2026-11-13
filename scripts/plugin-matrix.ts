// The CI matrix of plugin suites, from ci/plugins.json: every plugin runs its suite
// (`plugins/<name>/tests/run-tests.sh`) on every platform, and fails the build only on the
// platforms listed as blocking for it. A platform joins a plugin's list the day its suite is
// green there, and never leaves it (docs/conventions.md, « Ratchets »).
//
// A pull request runs the Linux cells of the plugins it changes: a change outside plugins/ runs
// every plugin, a change of documentation alone one cell without a suite, which passes (a skipped
// job proves nothing to the gate). macOS runs after the merge, on main.
//
//   npm run plugin-matrix                        prints the matrix; appends it to $GITHUB_OUTPUT when set
//   npm run plugin-matrix -- --pull-request <base>   the matrix of a pull request against <base>
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { processIo, type Io } from './lib/io.ts'
import { isEntry, isRecord, readPlugins } from './lib/plugins.ts'

export const PLATFORMS = ['ubuntu-latest', 'macos-latest'] as const
export type Platform = (typeof PLATFORMS)[number]

function isPlatform(value: unknown): value is Platform {
  return PLATFORMS.some(platform => platform === value)
}

/** The cell a pull request runs when it touches no plugin; the workflow skips its steps. */
export const NO_SUITE = 'no plugin suite'

export interface Cell {
  readonly plugin: string
  readonly os: Platform
  readonly blocking: boolean
}

/** Validates ci/plugins.json against the plugins on disk: one entry per plugin, no stray one. */
export function parseBlocking(raw: unknown, plugins: readonly string[]): Map<string, ReadonlySet<Platform>> {
  if (!isRecord(raw) || !isRecord(raw['blocking'])) throw new Error('ci/plugins.json: expected { "blocking": { <plugin>: [<platform>] } }')
  const table = raw['blocking']
  const result = new Map<string, ReadonlySet<Platform>>()
  for (const plugin of plugins) {
    const listed = table[plugin]
    if (!Array.isArray(listed)) throw new Error(`ci/plugins.json: no entry for plugin "${plugin}"`)
    const platforms = new Set<Platform>()
    for (const value of listed) {
      if (!isPlatform(value)) throw new Error(`ci/plugins.json: "${plugin}" names unknown platform ${JSON.stringify(value)}`)
      platforms.add(value)
    }
    result.set(plugin, platforms)
  }
  for (const name of Object.keys(table)) {
    if (!plugins.includes(name)) throw new Error(`ci/plugins.json: "${name}" is not a plugin of the repository`)
  }
  return result
}

export function matrixOf(blocking: ReadonlyMap<string, ReadonlySet<Platform>>): Cell[] {
  return [...blocking].flatMap(([plugin, platforms]) => PLATFORMS.map(os => ({ plugin, os, blocking: platforms.has(os) })))
}

// Files no plugin reads: their change runs no suite.
const DOCUMENTATION = [/^docs\//, /^[^/]+\.md$/]

/** The plugins a change of `changed` (paths from the root) asks to test. */
export function touchedPlugins(changed: readonly string[], plugins: readonly string[]): string[] {
  const touched = new Set<string>()
  for (const path of changed) {
    if (DOCUMENTATION.some(pattern => pattern.test(path))) continue
    const name = /^plugins\/([^/]+)\//.exec(path)?.[1]
    if (name === undefined) return [...plugins]
    if (plugins.includes(name)) touched.add(name)
  }
  return plugins.filter(plugin => touched.has(plugin))
}

/** The cells a pull request runs: Linux, for the plugins it touches, else the cell without a suite. */
export function pullRequestCells(matrix: readonly Cell[], touched: readonly string[]): Cell[] {
  const cells = matrix.filter(cell => cell.os === 'ubuntu-latest' && touched.includes(cell.plugin))
  return cells.length > 0 ? cells : [{ plugin: NO_SUITE, os: 'ubuntu-latest', blocking: true }]
}

export function run(root: string, args: readonly string[], io: Io): number {
  const plugins = readPlugins(root).map(plugin => plugin.dir)
  let matrix = matrixOf(parseBlocking(JSON.parse(readFileSync(join(root, 'ci', 'plugins.json'), 'utf8')), plugins))
  if (args[0] === '--pull-request') {
    if (args[1] === undefined) throw new Error('--pull-request needs the base ref')
    const changed = execFileSync('git', ['diff', '--name-only', `${args[1]}...HEAD`], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(line => line !== '')
    matrix = pullRequestCells(matrix, touchedPlugins(changed, plugins))
  }
  const line = JSON.stringify({ include: matrix })
  io.out(line)
  const output = io.env['GITHUB_OUTPUT']
  if (output !== undefined) appendFileSync(output, `matrix=${line}\n`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
