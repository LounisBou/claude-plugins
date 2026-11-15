// core reaches a plugin as a generated copy (decision 0002): the host's validator and test kit
// refuse a link, so each plugin that holds a `core/` directory gets the part of packages/core/src
// it uses copied into it: the modules its TypeScript imports from `core/`, with the modules those
// import in turn, tests left out, each marked as generated; and the contracts other languages read
// (core's DATA_FILES), as JSON, when a file of the plugin names one. The copy is never edited: CI
// refuses one that differs from what this script writes.
//
//   npm run core            rewrite every plugin's copy
//   npm run core -- --check exit 1 when a copy is not what the source gives
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
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

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g

/** The relative specifiers `source` imports, statically or dynamically. */
export function importsOf(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map(match => match[1] ?? '').filter(specifier => specifier.startsWith('.'))
}

/** The modules of `modules` (name to text) that `roots` reach through their `./` imports, roots included. */
export function closure(roots: Iterable<string>, modules: ReadonlyMap<string, string>): Set<string> {
  const reached = new Set<string>()
  const queue = [...roots]
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    const text = modules.get(name)
    if (text === undefined || reached.has(name)) continue
    reached.add(name)
    for (const specifier of importsOf(text)) if (specifier.startsWith('./') && !specifier.slice(2).includes('/')) queue.push(specifier.slice(2))
  }
  return reached
}

/** Every file of `dir` outside its own `core/` and any `node_modules`, by absolute path. */
function pluginFiles(dir: string): string[] {
  const core = join(dir, 'core') + sep
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .filter(path => !path.startsWith(core) && !path.includes(`${sep}node_modules${sep}`))
}

/**
 * What the plugin at `dir` uses of core: the module names its TypeScript imports from its `core/`,
 * and the data file names any of its files mentions.
 */
export function usedBy(dir: string, dataNames: readonly string[]): { modules: Set<string>; data: Set<string> } {
  const core = resolve(dir, 'core')
  const modules = new Set<string>()
  const data = new Set<string>()
  for (const file of pluginFiles(dir)) {
    const text = readFileSync(file, 'utf8')
    if (file.endsWith('.ts')) {
      for (const specifier of importsOf(text)) {
        const target = resolve(dirname(file), specifier)
        if (dirname(target) === core) modules.add(basename(target))
      }
    }
    for (const name of dataNames) if (text.includes(name)) data.add(name)
  }
  return { modules, data }
}

/** The copy the plugin at `dir` takes from the source's `files` and `data`. */
export function copyFor(dir: string, files: ReadonlyMap<string, string>, data: Readonly<Record<string, object>>): Map<string, string> {
  const modules = new Map([...files].filter(([name]) => name.endsWith('.ts') && !name.endsWith('.test.ts')))
  const used = usedBy(dir, Object.keys(data))
  const kept = closure(used.modules, modules)
  return copyOf(
    new Map([...modules].filter(([name]) => kept.has(name))),
    Object.fromEntries(Object.entries(data).filter(([name]) => used.data.has(name))),
  )
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

export function run(root: string, args: readonly string[], io: Io, data: Readonly<Record<string, object>> = DATA_FILES): number {
  const source = read(join(root, SOURCE))
  let stale = 0
  for (const dir of consumers(root)) {
    const target = join(root, PLUGINS_DIR, dir, 'core')
    const expected = copyFor(join(root, PLUGINS_DIR, dir), source, data)
    if (same(read(target), expected)) continue
    if (args.includes('--check')) {
      io.err(`${relative(root, target)} differs from ${SOURCE}: run \`npm run core\` and commit it`)
      stale++
      continue
    }
    rmSync(target, { recursive: true })
    mkdirSync(target)
    for (const [name, text] of expected) writeFileSync(join(target, name), text)
    io.out(`${relative(root, target)} rewritten`)
  }
  return stale === 0 ? 0 : 1
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
