// lens-model — the model a review's readers run at, from the class of the diff they read.
//
//   lens-model.sh [--base <ref>] [--head <ref>] [--dir <checkout>]
//
// Prints one word: the model the operator's tier map binds to the readers' tier, or `host-default`
// when that tier is unbound (the readers are launched with no `model`). The tier is the diff's class
// over `<base>...<head>` (`origin/main` and `HEAD` by default): documentation and prose alone read at
// `light`; a diff that touches a security boundary, a guard, a consent, data or a migration reads at
// `deep`; every other diff reads at `standard`. A diff that cannot be read, or an empty one, is the
// default class. The review brief's `{{LENS_MODEL}}` is this same answer.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isEntry, processIo, type Io } from './lib/process.ts'
import { modelsMapOf, Refused, resolveTierPair } from '../../iterm-agents/scripts/tier.ts'

export const USAGE = 'usage: lens-model.sh [--base <ref>] [--head <ref>] [--dir <checkout>]'

export type Tier = 'light' | 'standard' | 'deep'

/** What a launch is told when the tier map binds the tier to no model. */
export const UNBOUND = 'host-default'

/** The model the operator's tier map binds to `tier`, or `host-default`; a map that does not read is refused by the map's own reader. */
export function modelOf(tier: Tier, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }
  return resolveTierPair(tier, modelsMapOf(env, homedir()), { env, read, warn: () => {} }).model || UNBOUND
}

/** A path whose change is a security boundary, a guard, a consent, data or a migration. */
const CRITICAL = /(^|[/._-])(guard|secur|auth(?!or)|permission|secret|credential|consent|migrat|schema|sql$)/i
/** A path of prose: documents and top-level notes, never a prompt a session loads (skills, agents, commands, templates). */
const PROSE = /(^|\/)(docs|doc)\/|(^|\/)(README|CHANGELOG|LICENSE)[^/]*$|\.(txt|rst)$/i
const PROMPT_DIR = /(^|\/)(skills|agents|commands|templates)\//
const isProse = (file: string): boolean => PROSE.test(file) || (/\.md$/i.test(file) && !PROMPT_DIR.test(file))

/** The tier of readers a diff's files call for. */
export function tierOf(files: readonly string[]): Tier {
  if (files.length === 0) return 'standard'
  if (files.some(file => CRITICAL.test(file))) return 'deep'
  return files.every(isProse) ? 'light' : 'standard'
}

/** The files `base...head` changes in `dir`, or none when git cannot say. */
export function diffFiles(dir: string, base: string, head: string): string[] {
  try {
    const out = execFileSync('git', ['-C', dir, 'diff', '--name-only', `${base}...${head}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n').filter(line => line !== '')
  } catch {
    return []
  }
}

export function main(argv: readonly string[], io: Io): number {
  const values = new Map<string, string>()
  for (let k = 0; k < argv.length; k += 2) {
    const name = (argv[k] ?? '').slice(2)
    const value = argv[k + 1]
    if (!(argv[k] ?? '').startsWith('--') || !['base', 'head', 'dir'].includes(name) || value === undefined || value.startsWith('--')) {
      io.err(`lens-model: bad argument ${argv[k] ?? ''} (${USAGE})\n`)
      return 2
    }
    values.set(name, value)
  }
  try {
    io.out(`${modelOf(tierOf(diffFiles(values.get('dir') ?? '.', values.get('base') ?? 'origin/main', values.get('head') ?? 'HEAD')))}\n`)
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    io.err(`lens-model: ${error.message}\n`)
    return 1
  }
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2), processIo)
