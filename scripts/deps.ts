// The dependency rules of docs/architecture.md, checked: a plugin of this repository is named
// with its marketplace and a version range its current version satisfies, the graph has no
// cycle, no TypeScript file imports a path outside its own plugin, and a shared environment
// variable is read only by a name core declares.
//
//   npm run deps
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { processIo, type Io } from './lib/io.ts'
import { ENV } from '../packages/core/src/env.ts'
import { compareVersions, isEntry, isRecord, manifestPath, PLUGINS_DIR, readPlugins } from './lib/plugins.ts'

export const MARKETPLACE = 'lounisbou'

export interface Dependency {
  readonly name: string
  readonly marketplace: string
  readonly range: string | undefined
}

// A bound may omit its patch (`>=0.49`), as the host allows; it reads as `.0`.
const VERSION = String.raw`\d+\.\d+(?:\.\d+)?`
const RANGE = new RegExp(`^>=(${VERSION})(?: <(${VERSION}))?$`)

/** The dependencies a manifest declares, in either of the host's two forms. */
export function dependenciesOf(manifest: unknown, origin: string): Dependency[] {
  const raw = isRecord(manifest) ? manifest['dependencies'] : undefined
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`${origin}: "dependencies" must be a list`)
  return raw.map((entry: unknown) => {
    if (typeof entry === 'string') {
      const [name = '', marketplace = ''] = entry.split('@')
      return { name, marketplace, range: undefined }
    }
    if (isRecord(entry) && typeof entry['name'] === 'string' && typeof entry['marketplace'] === 'string') {
      const version = entry['version']
      return { name: entry['name'], marketplace: entry['marketplace'], range: typeof version === 'string' ? version : undefined }
    }
    throw new Error(`${origin}: a dependency is neither "name@marketplace" nor { name, marketplace, version }`)
  })
}

/** Whether `version` falls in `range` (">=a.b.c", optionally followed by " <x.y.z"); undefined for no range. */
export function satisfies(version: string, range: string): boolean | undefined {
  const match = RANGE.exec(range)
  const low = match?.[1]
  if (low === undefined) return undefined
  const high = match?.[2]
  return compareVersions(version, full(low)) >= 0 && (high === undefined || compareVersions(version, full(high)) < 0)
}

const full = (bound: string): string => (bound.split('.').length === 2 ? `${bound}.0` : bound)

/** One line per broken rule among the plugins' dependencies; empty when they all hold. */
export function dependencyFaults(graph: ReadonlyMap<string, { readonly version: string; readonly dependencies: readonly Dependency[] }>): string[] {
  const faults: string[] = []
  for (const [plugin, { dependencies }] of graph) {
    for (const dependency of dependencies) {
      if (dependency.marketplace !== MARKETPLACE) continue
      const target = graph.get(dependency.name)
      if (target === undefined) faults.push(`${plugin}: depends on ${dependency.name}, which is not a plugin of this repository`)
      else if (dependency.range === undefined) faults.push(`${plugin}: depends on ${dependency.name} without a version range`)
      else if (satisfies(target.version, dependency.range) === undefined) faults.push(`${plugin}: "${dependency.range}" is not a version range (">=a.b.c" or ">=a.b.c <x.y.z")`)
      else if (!satisfies(target.version, dependency.range)) faults.push(`${plugin}: depends on ${dependency.name} ${dependency.range}, which its version ${target.version} does not satisfy`)
    }
  }
  const cycle = findCycle(graph)
  if (cycle !== undefined) faults.push(`dependency cycle: ${cycle.join(' -> ')}`)
  return faults
}

function findCycle(graph: ReadonlyMap<string, { readonly dependencies: readonly Dependency[] }>): string[] | undefined {
  const done = new Set<string>()
  const visit = (plugin: string, path: readonly string[]): string[] | undefined => {
    if (path.includes(plugin)) return [...path.slice(path.indexOf(plugin)), plugin]
    if (done.has(plugin)) return undefined
    for (const dependency of graph.get(plugin)?.dependencies ?? []) {
      if (dependency.marketplace !== MARKETPLACE || !graph.has(dependency.name)) continue
      const cycle = visit(dependency.name, [...path, plugin])
      if (cycle !== undefined) return cycle
    }
    done.add(plugin)
    return undefined
  }
  for (const plugin of graph.keys()) {
    const cycle = visit(plugin, [])
    if (cycle !== undefined) return cycle
  }
  return undefined
}

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"`]*?from\s+['"]([^'"]+)['"]/g

/** The relative imports in `source` that leave `pluginRoot`, from the file at `file`. */
export function escapingImports(source: string, file: string, pluginRoot: string): string[] {
  const escaping: string[] = []
  for (const match of source.matchAll(IMPORT)) {
    const specifier = match[1] ?? ''
    if (!specifier.startsWith('.')) continue
    const target = resolve(dirname(file), specifier)
    const inside = relative(pluginRoot, target)
    if (inside.startsWith(`..${sep}`) || inside === '..') escaping.push(specifier)
  }
  return escaping
}

// Each family of variables belongs to the plugin that sets them; another plugin reads one only
// by a name core's ENV declares.
const FAMILIES: Readonly<Record<string, string>> = { ORCHESTRATOR_: 'orchestrator', CLAUDE_GITHUB_: 'github' }
const VARIABLE = /\$\.env\.get\(\s*['"]([A-Z0-9_]+)['"]/g
const DECLARED: readonly string[] = Object.values(ENV)

/** The variables of another plugin's family that `source`, in `plugin`, reads undeclared. */
export function undeclaredVariables(source: string, plugin: string): string[] {
  return [...source.matchAll(VARIABLE)]
    .map(match => match[1] ?? '')
    .filter(name => Object.entries(FAMILIES).some(([prefix, owner]) => name.startsWith(prefix) && owner !== plugin))
    .filter(name => !DECLARED.includes(name))
}

function typescriptFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !join(entry.parentPath, entry.name).includes(`${sep}node_modules${sep}`))
    .map(entry => join(entry.parentPath, entry.name))
}

export function run(root: string, _args: readonly string[], io: Io): number {
  const graph = new Map<string, { version: string; dependencies: Dependency[] }>()
  const faults: string[] = []
  for (const { dir, manifest } of readPlugins(root)) {
    const raw: unknown = JSON.parse(readFileSync(manifestPath(root, dir), 'utf8'))
    graph.set(dir, { version: manifest.version, dependencies: dependenciesOf(raw, dir) })
    const pluginRoot = resolve(root, PLUGINS_DIR, dir)
    for (const file of typescriptFiles(pluginRoot)) {
      const source = readFileSync(file, 'utf8')
      for (const specifier of escapingImports(source, file, pluginRoot)) {
        faults.push(`${relative(root, file)}: imports ${specifier}, outside its plugin`)
      }
      for (const name of undeclaredVariables(source, dir)) faults.push(`${relative(root, file)}: reads ${name}, another plugin's variable core's ENV does not declare`)
    }
  }
  faults.push(...dependencyFaults(graph))
  for (const fault of faults) io.err(fault)
  return faults.length === 0 ? 0 : 1
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
