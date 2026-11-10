// What a run is asked: the command line, the project's config file, and where it is found.
import { readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { DEFAULT_HASH_PATTERN, DriftError } from './compare.ts'

export const USAGE = 'usage: drift build [--repo <path>] [--base <ref>] [--head <ref>] [--config <path>] [--out <dir>]'

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
}

const FLAGS = { '--repo': 'repo', '--base': 'base', '--head': 'head', '--config': 'config', '--out': 'out' } as const

export function parseArgs(argv: readonly string[]): Options {
  const [command, ...rest] = argv
  if (command !== 'build') throw new DriftError(USAGE)
  const options: { -readonly [K in keyof Options]: Options[K] } = { repo: '.', base: 'origin/main', head: 'HEAD', config: undefined, out: undefined }
  for (let k = 0; k < rest.length; k += 2) {
    const flag = rest[k] ?? ''
    const value = rest[k + 1]
    if (!Object.hasOwn(FLAGS, flag)) throw new DriftError(`unknown option ${flag}\n${USAGE}`)
    if (value === undefined || value.startsWith('-')) throw new DriftError(`${flag} needs a value`)
    options[FLAGS[flag as keyof typeof FLAGS]] = value
  }
  return options
}

const isArgv = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((item: unknown) => typeof item === 'string' && item !== '')

/** The config's fields, validated; keys this command does not read are left for others. */
export function parseConfig(raw: unknown, origin: string): Config {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new DriftError(`${origin}: expected an object`)
  const record = raw as Record<string, unknown>
  const { install, build, outDir, hashPattern } = { install: record['install'], build: record['build'], outDir: record['outDir'], hashPattern: record['hashPattern'] }
  if (!isArgv(build)) throw new DriftError(`${origin}: "build" must be a non-empty list of strings (the command and its arguments, run without a shell)`)
  if (install !== undefined && !isArgv(install)) throw new DriftError(`${origin}: "install" must be a non-empty list of strings`)
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
  return { install, build, outDir: dir, hashPattern: pattern }
}

/** `<owner>-<repo>` from an origin URL (scp-like, URL or path), or undefined. */
export function slugOf(url: string): string | undefined {
  const match = /([^/:]+)[/:]([^/:]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match === null ? undefined : `${match[1]}-${match[2]}`
}

export const configPathOf = (home: string, slug: string): string => join(home, '.claude', 'drift', `${slug}.json`)

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
