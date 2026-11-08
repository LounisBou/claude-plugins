// The CI matrix of plugin suites, from ci/plugins.json: every plugin runs its suite
// (`plugins/<name>/tests/run-tests.sh`) on every platform, and fails the build only on the
// platforms listed as blocking for it. A platform joins a plugin's list the day its suite is
// green there, and never leaves it (docs/conventions.md, « Ratchets »).
//
//   npm run plugin-matrix   prints the matrix; appends it to $GITHUB_OUTPUT when set
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { processIo, type Io } from './lib/io.ts'
import { isEntry, isRecord, readPlugins } from './lib/plugins.ts'

export const PLATFORMS = ['ubuntu-latest', 'macos-latest'] as const
export type Platform = (typeof PLATFORMS)[number]

function isPlatform(value: unknown): value is Platform {
  return PLATFORMS.some(platform => platform === value)
}

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

export function run(root: string, _args: readonly string[], io: Io): number {
  const plugins = readPlugins(root).map(plugin => plugin.dir)
  const matrix = matrixOf(parseBlocking(JSON.parse(readFileSync(join(root, 'ci', 'plugins.json'), 'utf8')), plugins))
  const line = JSON.stringify({ include: matrix })
  io.out(line)
  const output = io.env['GITHUB_OUTPUT']
  if (output !== undefined) appendFileSync(output, `matrix=${line}\n`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
