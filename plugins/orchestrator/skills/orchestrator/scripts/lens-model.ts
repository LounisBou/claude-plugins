// lens-model — the model a review's readers run at, from the class of the diff they read.
//
//   lens-model.sh [--base <ref>] [--head <ref>] [--dir <checkout>]
//
// Prints one word, `haiku`, `sonnet` or `opus`: the `model` of each `orchestrator:lens` the session
// launches over `<base>...<head>` (`origin/main` and `HEAD` by default). Documentation and prose
// alone read at haiku; a diff that touches a security boundary, a guard, a consent, data or a
// migration reads at opus; every other diff reads at sonnet. A diff that cannot be read, or an empty
// one, is the default class. The review brief's `{{LENS_MODEL}}` is this same answer.
import { execFileSync } from 'node:child_process'
import { isEntry, processIo, type Io } from './lib/process.ts'

export const USAGE = 'usage: lens-model.sh [--base <ref>] [--head <ref>] [--dir <checkout>]'

export type Tier = 'light' | 'standard' | 'deep'
/** The model each tier of readers runs at, a family of the host's model aliases. */
export const MODELS: Readonly<Record<Tier, string>> = { light: 'haiku', standard: 'sonnet', deep: 'opus' }

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
  io.out(`${MODELS[tierOf(diffFiles(values.get('dir') ?? '.', values.get('base') ?? 'origin/main', values.get('head') ?? 'HEAD'))]}\n`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2), processIo)
