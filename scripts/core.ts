// core reaches a plugin as a generated copy (decision 0002): the host's validator and test kit
// refuse a link, so each plugin that holds a `core/` directory gets packages/core/src copied into
// it, tests left out, each module marked as generated, and the contracts other languages read
// (core's DATA_FILES) written beside them as JSON. The copy is never edited: CI refuses one
// that differs from what this script writes.
//
//   npm run core            rewrite every plugin's copy
//   npm run core -- --check exit 1 when a copy is not what the source gives
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processIo, type Io } from './lib/io.ts'
import { DATA_FILES } from '../packages/core/src/data.ts'
import { isEntry, PLUGINS_DIR, readPlugins } from './lib/plugins.ts'

export const SOURCE = join('packages', 'core', 'src')
export const MARK = '// Generated from packages/core/src by `npm run core`: edit the source, never this copy.\n'

/** The files a plugin's copy holds, by name: the source's modules, each marked, then the data files. */
export function copyOf(files: ReadonlyMap<string, string>, data: Readonly<Record<string, object>> = {}): Map<string, string> {
  const copy = new Map<string, string>()
  for (const [name, text] of files) if (name.endsWith('.ts') && !name.endsWith('.test.ts')) copy.set(name, MARK + text)
  for (const [name, value] of Object.entries(data)) {
    copy.set(name, `${JSON.stringify({ $comment: `Generated from packages/core/src by \`npm run core\`: edit the source, never this copy.`, ...value }, null, 2)}\n`)
  }
  return copy
}

/** The plugins that take core: those holding a `core/` directory. */
export function consumers(root: string): string[] {
  return readPlugins(root).map(plugin => plugin.dir).filter(dir => existsSync(join(root, PLUGINS_DIR, dir, 'core')))
}

function read(dir: string): Map<string, string> {
  return new Map(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')]))
}

function same(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([name, text]) => b.get(name) === text)
}

export function run(root: string, args: readonly string[], io: Io): number {
  const expected = copyOf(read(join(root, SOURCE)), DATA_FILES)
  let stale = 0
  for (const dir of consumers(root)) {
    const target = join(root, PLUGINS_DIR, dir, 'core')
    if (same(read(target), expected)) continue
    if (args.includes('--check')) {
      io.err(`plugins/${dir}/core differs from ${SOURCE}: run \`npm run core\` and commit it`)
      stale++
      continue
    }
    rmSync(target, { recursive: true })
    mkdirSync(target)
    for (const [name, text] of expected) writeFileSync(join(target, name), text)
    io.out(`plugins/${dir}/core rewritten`)
  }
  return stale === 0 ? 0 : 1
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
