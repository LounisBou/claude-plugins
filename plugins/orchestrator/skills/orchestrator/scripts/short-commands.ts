// short-commands — writes the plugin's short names as user commands: `/orchestrator-agents`,
// `/orchestrator-status` and the rest, one file per row of short-names.tsv in the host's user
// commands directory.
//
//   short-commands.sh install   [--dry-run] [--dir <path>]   write the absent, rewrite its own
//   short-commands.sh uninstall [--dry-run] [--dir <path>]   remove its own
//   short-commands.sh sync      [--dir <path>]               rewrite its own that differ
//
// Each file is its plugin command copied whole, with the plugin root spelled out where the
// plugin command says ${CLAUDE_PLUGIN_ROOT} (the host expands no plugin variable in a user
// command) and a marker line after the opening `---`. The marker is what makes a file this
// plugin's: a file of the same name without it is the operator's, never written, never removed.
// `sync` is the module's pass at each session start: after a plugin update the copies still name
// the earlier version's root, and it rewrites them, never creating one the operator removed.
// All three remove a marked file that matches no row: a row dropped from the table would
// otherwise leave its copy behind on every machine that installed it.
//
// The directory: --dir, else ORCHESTRATOR_COMMANDS_DIR, else the config dir's commands/.
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isOwnCopy, SHORT_MARKER } from '../../../hooks/short-names.ts'
import { configDir, setting, type Env } from '../../../core/paths.ts'
import { writeAtomic } from '../../../core/store.ts'
import { isEntry, processIo, type Io } from './lib/process.ts'

export const USAGE = 'usage: short-commands.sh install|uninstall|sync [--dry-run] [--dir <path>]'
const MODES = ['install', 'uninstall', 'sync'] as const
type Mode = typeof MODES[number]
const VARIABLE = '${CLAUDE_PLUGIN_ROOT}'

export interface Deps {
  readonly io: Io
  readonly env: Env
  /** The plugin's root, as the launcher names it. */
  readonly root: string
}

/** One plugin command as its user command copy: the marker after the opening line, the root spelled out. */
export function render(text: string, root: string): string {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length >= 2) lines.splice(1, 0, SHORT_MARKER)
  return lines.map(l => `${l.split(VARIABLE).join(root)}\n`).join('')
}

/** The rows of short-names.tsv: the short name, then the plugin command it copies. */
export function rows(text: string): { readonly short: string; readonly file: string }[] {
  return text.split('\n').flatMap(line => {
    const tab = line.indexOf('\t')
    const short = tab < 0 ? line : line.slice(0, tab)
    return short === '' ? [] : [{ short, file: tab < 0 ? '' : line.slice(tab + 1) }]
  })
}

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Whether the file at `path` is this plugin's copy; a file that cannot be read is not. */
function ours(path: string): boolean {
  try {
    return isOwnCopy(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
}

function write(target: string, text: string): void {
  writeAtomic(target, text, 0o644)
  chmodSync(target, 0o644)
}

export function main(argv: readonly string[], deps: Deps): number {
  const [mode = '', ...rest] = argv
  let dry = false
  let dest = setting(deps.env, 'ORCHESTRATOR_COMMANDS_DIR') ?? join(configDir(deps.env, setting(deps.env, 'HOME')), 'commands')
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? ''
    const value = rest[k + 1]
    if (a === '--dry-run') {
      dry = true
    } else if (a === '--dir' && value !== undefined) {
      dest = value
      k++
    } else {
      deps.io.err(`  unknown option: ${a} (expected --dry-run, --dir <path>)\n`)
      return 2
    }
  }
  if (!(MODES as readonly string[]).includes(mode)) {
    deps.io.err(`${USAGE}\n`)
    return 2
  }
  try {
    run(mode as Mode, dry, dest, deps)
  } catch (error) {
    deps.io.err(`short-commands: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  return 0
}

function run(mode: Mode, dry: boolean, dest: string, deps: Deps): void {
  const say = (text: string): void => deps.io.out(`  ${dry ? '[dry-run] ' : ''}${text}\n`)
  const isDir = (): boolean => {
    try {
      return statSync(dest).isDirectory()
    } catch {
      return false
    }
  }
  if (mode === 'sync' && !isDir()) return
  if (mode === 'install' && !dry) mkdirSync(dest, { recursive: true })
  const table = rows(readFileSync(join(deps.root, 'short-names.tsv'), 'utf8'))
  for (const { short, file } of table) {
    const target = join(dest, `${short}.md`)
    const command = join(deps.root, 'commands', `${file}.md`)
    let source: string
    try {
      if (!statSync(command).isFile()) throw new Error('not a file')
      source = readFileSync(command, 'utf8')
    } catch {
      deps.io.err(`  no plugin command ${command} for /${short}\n`)
      continue
    }
    const there = exists(target)
    if ((there || isLink(target)) && !ours(target)) {
      if (mode !== 'sync') say(`kept: ${target} is not this plugin's (no « ${SHORT_MARKER} » line), left as it is`)
      continue
    }
    if (mode === 'uninstall') {
      if (!there) continue
      if (!dry) rmSync(target, { force: true })
      say(`short command removed: ${target}`)
      continue
    }
    const copy = render(source, deps.root)
    if (!there) {
      if (mode === 'sync') continue
      if (!dry) write(target, copy)
      say(`short command written: ${target}`)
    } else if (readFileSync(target, 'utf8') === copy) {
      if (mode !== 'sync') say(`short command up to date: ${target}`)
    } else {
      if (!dry) write(target, copy)
      say(`short command rewritten: ${target}`)
    }
  }
  // A marked copy whose row is gone: the earlier version wrote it, no version answers it now.
  if (!isDir()) return
  const named = new Set(table.map(r => r.short))
  for (const n of readdirSync(dest).filter(n => n.endsWith('.md') && !n.startsWith('.')).sort()) {
    const target = join(dest, n)
    if (isLink(target) || !exists(target) || !statSync(target).isFile()) continue
    if (named.has(n.slice(0, -'.md'.length)) || !ours(target)) continue
    if (!dry) rmSync(target, { force: true })
    say(`stale short command removed: ${target} (no row of short-names.tsv names it)`)
  }
}

/* node:coverage ignore next 4 */
if (isEntry(import.meta.url)) {
  const script = process.argv[1] ?? ''
  process.exitCode = main(process.argv.slice(2), { io: processIo, env: process.env, root: resolve(dirname(script), '..', '..', '..') })
}
