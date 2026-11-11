// What a run is asked: the command line, the project's config file, and where it is found.
import { readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, posix } from 'node:path'
import { configDirOf, type Env } from '../../../../core/env.ts'
import { DEFAULT_HASH_PATTERN, DriftError } from './compare.ts'

export const USAGE = [
  'usage: drift build [--repo <path>] [--base <ref>] [--head <ref>] [--config <path>] [--out <dir>]',
  '       drift shots [--repo <path>] [--base <ref>] [--head <ref>] [--config <path>] [--out <dir>] [--threshold <0..1>]',
  '       drift install',
].join('\n')

export interface Options {
  readonly repo: string
  readonly base: string
  readonly head: string
  readonly config: string | undefined
  readonly out: string | undefined
}

export interface Config {
  /** Run in each checkout before the build; none when the project needs no install. */
  readonly install: readonly string[] | undefined
  readonly build: readonly string[]
  /** The build's output directory, relative to the repository root. */
  readonly outDir: string
  readonly hashPattern: string
  /** Added to the environment of the install and the build, on both sides. */
  readonly env?: Readonly<Record<string, string>>
}

export interface ShotsOptions extends Options {
  /** Pixelmatch's per-pixel colour tolerance, 0 (exact) to 1. */
  readonly threshold: number
}

const FLAGS = { '--repo': 'repo', '--base': 'base', '--head': 'head', '--config': 'config', '--out': 'out' } as const

/** The flags after the command word, each with its value; `extra` names the command's own flags. */
function flagsOf(rest: readonly string[], extra: readonly string[] = []): { options: { -readonly [K in keyof Options]: Options[K] }; values: Map<string, string> } {
  const options: { -readonly [K in keyof Options]: Options[K] } = { repo: '.', base: 'origin/main', head: 'HEAD', config: undefined, out: undefined }
  const values = new Map<string, string>()
  for (let k = 0; k < rest.length; k += 2) {
    const flag = rest[k] ?? ''
    const value = rest[k + 1]
    if (!Object.hasOwn(FLAGS, flag) && !extra.includes(flag)) throw new DriftError(`unknown option ${flag}\n${USAGE}`)
    if (value === undefined || value === '' || (value.startsWith('-') && !/^-\d/.test(value))) throw new DriftError(`${flag} needs a value`)
    if (Object.hasOwn(FLAGS, flag)) options[FLAGS[flag as keyof typeof FLAGS]] = value
    else values.set(flag, value)
  }
  return { options, values }
}

export function parseArgs(argv: readonly string[]): Options {
  const [command, ...rest] = argv
  if (command !== 'build') throw new DriftError(USAGE)
  const { options, values } = flagsOf(rest)
  if (values.size > 0) throw new DriftError(USAGE)
  return options
}

export function parseShotsArgs(argv: readonly string[]): ShotsOptions {
  const [command, ...rest] = argv
  if (command !== 'shots') throw new DriftError(USAGE)
  const { options, values } = flagsOf(rest, ['--threshold'])
  const raw = values.get('--threshold')
  const threshold = raw === undefined ? 0 : Number(raw)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new DriftError('--threshold must be a number between 0 and 1')
  return { ...options, threshold }
}

const isArgv = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((item: unknown) => typeof item === 'string' && item !== '')

const isEnv = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.entries(value).every(([name, text]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof text === 'string')

function objectOf(raw: unknown, origin: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new DriftError(`${origin}: expected an object`)
  return raw as Record<string, unknown>
}

/** The fields both commands read: the install run in each checkout, and the variables added to it. */
function common(record: Record<string, unknown>, origin: string): { install: readonly string[] | undefined; env?: Readonly<Record<string, string>> } {
  const { install, env } = { install: record['install'], env: record['env'] }
  if (install !== undefined && !isArgv(install)) throw new DriftError(`${origin}: "install" must be a non-empty list of strings`)
  if (env !== undefined && !isEnv(env)) throw new DriftError(`${origin}: "env" must be an object of strings, by variable name`)
  return { install, ...(env === undefined ? {} : { env: { ...env } }) }
}

/** The config's fields, validated; keys this command does not read are left for others. */
export function parseConfig(raw: unknown, origin: string): Config {
  const record = objectOf(raw, origin)
  const { build, outDir, hashPattern } = { build: record['build'], outDir: record['outDir'], hashPattern: record['hashPattern'] }
  if (!isArgv(build)) throw new DriftError(`${origin}: "build" must be a non-empty list of strings (the command and its arguments, run without a shell)`)
  const { install, env } = common(record, origin)
  const dir = typeof outDir === 'string' ? posix.normalize(outDir).replace(/\/+$/, '') : ''
  if (dir === '' || dir === '.' || dir.startsWith('/') || dir === '..' || dir.startsWith('../')) {
    throw new DriftError(`${origin}: "outDir" must be a relative path inside the repository`)
  }
  if (hashPattern !== undefined && typeof hashPattern !== 'string') throw new DriftError(`${origin}: "hashPattern" must be a string`)
  const pattern = hashPattern ?? DEFAULT_HASH_PATTERN
  try {
    new RegExp(pattern)
  } catch {
    throw new DriftError(`${origin}: "hashPattern" is not a regular expression`)
  }
  return { install, build, outDir: dir, hashPattern: pattern, ...(env === undefined ? {} : { env }) }
}

/** `<owner>-<repo>` from an origin URL (scp-like, URL or path), or undefined. */
export function slugOf(url: string): string | undefined {
  const match = /([^/:]+)[/:]([^/:]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match === null ? undefined : `${match[1]}-${match[2]}`
}

/** The default config: `drift/<slug>.json` under the host's configuration directory. */
export const configPathOf = (home: string, slug: string, env: Env = {}): string => join(configDirOf(env, home), 'drift', `${slug}.json`)

/**
 * The calling session's scratchpad, when the host runs one: `<root>/<project>/<session>/scratchpad`
 * under the host's temp root (`/tmp/claude-<uid>`), found by the session id; else undefined.
 */
export function scratchpadOf(env: Readonly<Record<string, string | undefined>>, root: string): string | undefined {
  const session = env['CLAUDE_CODE_SESSION_ID']
  if (session === undefined || !/^[A-Za-z0-9-]+$/.test(session)) return undefined
  let projects: string[]
  try {
    projects = readdirSync(root).sort()
  } catch {
    return undefined
  }
  for (const project of projects) {
    const dir = join(root, project, session, 'scratchpad')
    try {
      if (statSync(dir).isDirectory()) return dir
    } catch {
      continue
    }
  }
  return undefined
}

export interface Route {
  /** The path opened, from the server's root, query included. */
  readonly path: string
  /** The name its captures are filed under, from the path. */
  readonly name: string
  /** A selector the page shows once ready, waited for before the capture. */
  readonly waitFor?: string
}

export interface Viewport {
  readonly width: number
  readonly height: number
}

/** A region left out of every comparison: an element, or a box in page pixels; on one route, or every one. */
export interface Ignore {
  readonly route?: string
  readonly selector?: string
  readonly box?: readonly [number, number, number, number]
}

export interface ShotsConfig {
  readonly install: readonly string[] | undefined
  readonly env?: Readonly<Record<string, string>>
  /** The server command, run in each checkout once installed. */
  readonly server: readonly string[]
  /** The port it listens on: refused when something else already does. */
  readonly port: number
  /** The server's root URL, without its trailing slash. */
  readonly url: string
  readonly startTimeoutMs: number
  /** How long one page has to load and settle. */
  readonly timeoutMs: number
  readonly routes: readonly Route[]
  readonly viewports: readonly Viewport[]
  /** The directory API responses are answered from, absolute. */
  readonly fixtures: string | undefined
  /** Hosts answered from the fixtures alone: a request with no fixture gets a 404 and is listed. */
  readonly api: readonly string[]
  /** Hosts let through to the network; any other host but the server's is aborted and listed. */
  readonly allow: readonly string[]
  readonly ignore: readonly Ignore[]
  /** The time the pages read, frozen. */
  readonly now: string
  readonly fullPage: boolean
}

export const DEFAULT_VIEWPORTS: readonly Viewport[] = [{ width: 1440, height: 900 }, { width: 390, height: 844 }]
const DEFAULT_HEIGHT = 900
const DEFAULT_NOW = '2026-01-01T09:00:00Z'
const DEFAULT_START_TIMEOUT_S = 120
const DEFAULT_TIMEOUT_S = 30
/** The host names the server's URL may have: it runs on this machine. */
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']
/** The port a URL of each scheme means when it names none. */
const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 }

const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0
const isHosts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item: unknown) => typeof item === 'string' && /^[A-Za-z0-9.-]+(:\d+)?$/.test(item))
const isPath = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/')

/** A route's file name: its path's words joined by dashes, `root` for `/`. */
export const routeName = (path: string): string => path.replace(/[^A-Za-z0-9._]+/g, '-').replace(/^-+|-+$/g, '') || 'root'

function routeOf(raw: unknown): Route | undefined {
  if (isPath(raw)) return { path: raw, name: routeName(raw) }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { path, waitFor } = raw as Record<string, unknown>
  if (!isPath(path) || (waitFor !== undefined && (typeof waitFor !== 'string' || waitFor === ''))) return undefined
  return { path, name: routeName(path), ...(waitFor === undefined ? {} : { waitFor }) }
}

function viewportOf(raw: unknown): Viewport | undefined {
  if (isPositive(raw)) return { width: raw, height: DEFAULT_HEIGHT }
  if (typeof raw !== 'object' || raw === null) return undefined
  const { width, height } = raw as Record<string, unknown>
  return isPositive(width) && isPositive(height) ? { width, height } : undefined
}

function ignoreOf(raw: unknown): Ignore | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { route, selector, box } = raw as Record<string, unknown>
  if (route !== undefined && !isPath(route)) return undefined
  const isBox = Array.isArray(box) && box.length === 4 && box.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
  if (selector !== undefined && (typeof selector !== 'string' || selector === '')) return undefined
  if (box !== undefined && !isBox) return undefined
  if ((selector === undefined) === (box === undefined)) return undefined
  return { ...(route === undefined ? {} : { route }), ...(selector === undefined ? {} : { selector }), ...(isBox ? { box: box as [number, number, number, number] } : {}) }
}

function seconds(value: unknown, fallback: number, field: string, origin: string): number {
  if (value === undefined) return fallback * 1000
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new DriftError(`${origin}: "shots.${field}" must be a positive number of seconds`)
  return value * 1000
}

function listOf<T>(raw: unknown, read: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const items = raw.map(read)
  return items.every((item): item is T => item !== undefined) ? items : undefined
}

/** The fields `drift shots` reads, validated; a relative fixtures directory is read beside the config file. */
export function parseShots(raw: unknown, origin: string): ShotsConfig {
  const record = objectOf(raw, origin)
  const { install, env } = common(record, origin)
  const shots = record['shots']
  if (typeof shots !== 'object' || shots === null || Array.isArray(shots)) throw new DriftError(`${origin}: "shots" must be an object (the server, its port and the routes to capture)`)
  const s = shots as Record<string, unknown>
  const fail = (field: string, what: string): never => {
    throw new DriftError(`${origin}: "shots.${field}" must be ${what}`)
  }
  const server = isArgv(s['server']) ? s['server'] : fail('server', 'a non-empty list of strings (the command and its arguments, run without a shell)')
  const port = isPositive(s['port']) && s['port'] < 65536 ? s['port'] : fail('port', 'a port number')
  const routes = listOf(s['routes'], routeOf)
  if (routes === undefined || routes.length === 0) return fail('routes', 'a non-empty list of paths starting with /, or of { "path", "waitFor" }')
  const names = new Set<string>()
  for (const route of routes) {
    if (names.has(route.name)) throw new DriftError(`${origin}: two routes named ${route.name}: their captures would share a file`)
    names.add(route.name)
  }
  const viewports = s['viewports'] === undefined ? DEFAULT_VIEWPORTS : listOf(s['viewports'], viewportOf)
  if (viewports === undefined || viewports.length === 0) return fail('viewports', 'a non-empty list of widths, or of { "width", "height" }')
  if (new Set(viewports.map(viewport => viewport.width)).size !== viewports.length) throw new DriftError(`${origin}: two viewports of the same width: their captures would share a file`)
  let url = `http://localhost:${port}`
  if (s['url'] !== undefined) {
    let parsed: URL | undefined
    try {
      parsed = typeof s['url'] === 'string' ? new URL(s['url']) : undefined
    } catch {
      parsed = undefined
    }
    if (parsed === undefined || !/^https?:$/.test(parsed.protocol)) return fail('url', 'an http(s) URL')
    if (!LOOPBACK.includes(parsed.hostname)) return fail('url', `a URL of this machine (${LOOPBACK.join(', ')}): the server runs here`)
    const urlPort = parsed.port === '' ? DEFAULT_PORTS[parsed.protocol] : Number(parsed.port)
    if (urlPort !== port) return fail('url', `a URL on "shots.port" (${port}), not ${urlPort ?? 'none'}`)
    url = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
  }
  const fixtures = s['fixtures']
  if (fixtures !== undefined && (typeof fixtures !== 'string' || fixtures === '')) fail('fixtures', 'a directory path')
  const api = s['api'] ?? []
  if (!isHosts(api)) fail('api', 'a list of host names')
  const allow = s['allow'] ?? []
  if (!isHosts(allow)) fail('allow', 'a list of host names')
  const ignore = s['ignore'] === undefined ? [] : listOf(s['ignore'], ignoreOf)
  if (ignore === undefined) return fail('ignore', 'a list of { "selector" } or { "box": [x, y, width, height] }, each with an optional "route"')
  const nowRaw = s['now'] ?? DEFAULT_NOW
  const now = typeof nowRaw === 'string' ? new Date(nowRaw) : undefined
  if (now === undefined || Number.isNaN(now.getTime())) return fail('now', 'a date, as ISO 8601')
  const fullPage = s['fullPage'] ?? true
  if (typeof fullPage !== 'boolean') fail('fullPage', 'true or false')
  return {
    install,
    ...(env === undefined ? {} : { env }),
    server,
    port,
    url,
    startTimeoutMs: seconds(s['startTimeout'], DEFAULT_START_TIMEOUT_S, 'startTimeout', origin),
    timeoutMs: seconds(s['timeout'], DEFAULT_TIMEOUT_S, 'timeout', origin),
    routes,
    viewports,
    fixtures: typeof fixtures === 'string' ? (isAbsolute(fixtures) ? fixtures : join(dirname(origin), fixtures)) : undefined,
    api: api as string[],
    allow: allow as string[],
    ignore,
    now: now.toISOString(),
    fullPage: fullPage as boolean,
  }
}
