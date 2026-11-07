// The plugins of the repository, read from their own manifests: the one source of a plugin's
// name, version and description. Everything that lists plugins goes through here.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PLUGINS_DIR = 'plugins'

export interface Author {
  readonly name: string
  readonly email?: string
}

export interface Manifest {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly author: Author
}

export interface Plugin {
  /** The plugin's directory under `plugins/`, equal to its manifest name. */
  readonly dir: string
  readonly manifest: Manifest
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function manifestPath(root: string, dir: string): string {
  return join(root, PLUGINS_DIR, dir, '.claude-plugin', 'plugin.json')
}

/** Every plugin under `plugins/`, sorted by directory, each manifest validated. */
export function readPlugins(root: string): Plugin[] {
  return readdirSync(join(root, PLUGINS_DIR), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
    .map(dir => {
      const manifest = parseManifest(JSON.parse(readFileSync(manifestPath(root, dir), 'utf8')), dir)
      if (manifest.name !== dir) {
        throw new Error(`plugins/${dir}: the manifest is named "${manifest.name}"; the directory must carry the plugin's name`)
      }
      return { dir, manifest }
    })
}

/** Validates the fields the catalogue and the release rules depend on. */
export function parseManifest(raw: unknown, origin: string): Manifest {
  if (!isRecord(raw)) throw new Error(`${origin}: plugin.json is not an object`)
  const name = requireString(raw, 'name', origin)
  const version = requireString(raw, 'version', origin)
  if (!SEMVER.test(version)) throw new Error(`${origin}: version "${version}" is not MAJOR.MINOR.PATCH`)
  const description = requireString(raw, 'description', origin)
  const author = raw['author']
  if (!isRecord(author)) throw new Error(`${origin}: "author" must be an object`)
  const authorName = requireString(author, 'name', `${origin} author`)
  const email = author['email']
  return {
    name,
    version,
    description,
    author: typeof email === 'string' ? { name: authorName, email } : { name: authorName },
  }
}

/** Orders two MAJOR.MINOR.PATCH versions: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const delta = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function parseVersion(version: string): number[] {
  const match = SEMVER.exec(version)
  if (!match) throw new Error(`version "${version}" is not MAJOR.MINOR.PATCH`)
  return match.slice(1, 4).map(Number)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(record: Record<string, unknown>, key: string, origin: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${origin}: "${key}" must be a non-empty string`)
  }
  return value
}

/** True when the module at `moduleUrl` is the script node was started with. */
export function isEntry(moduleUrl: string): boolean {
  const script = process.argv[1]
  return script !== undefined && moduleUrl === pathToFileURL(script).href
}
