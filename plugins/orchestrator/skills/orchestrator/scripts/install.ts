// install — the orchestrator's install and uninstall of its state directory and short commands.
//
//   install.sh                install / update
//   install.sh --dry-run      print what would happen, change nothing
//   uninstall.sh [--dry-run]  take the tap off the status line, remove the state directory, the
//                             short commands and the profile's line this plugin wrote
//
// The install creates the state directory, unwires the tap a previous install may have left in
// front of the status line, writes the short names as user commands, and sources the plugin's
// shell file from the profile of the user's shell (shell-profile.ts). Idempotent: the tier
// map and the server catalogue are created only when absent, a status line already free of the
// tap is left alone, and settings.json and the profile are backed up before any change.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dataRootFileOf, MEASURE_DIR, parseDataRoot } from '../../../core/orchestration.ts'
import { configDir, setting, type Env } from '../../../core/paths.ts'
import { orchestratorRoots } from '../../../core/roots.ts'
import { writeAtomic } from '../../../core/store.ts'
import { isEntry, processIo, resolvedPath, type Io } from './lib/process.ts'
import { copyDiffers, copyOf, earlierBlock, guarded, lineOf, MARKER, profileOf, sourceOf, withLine, withoutLine, writeCopy, writeProfile } from './shell-profile.ts'
import { main as shortCommands } from './short-commands.ts'

export const HOST_FLOOR = '2.1.287'
const PRUNE_MS = 90 * 24 * 3600 * 1000

type Json = Record<string, unknown>
/** What the unwrap left: the tap taken off the line, no line running it, or a line that may still run it. */
type Unwrap = 'unwired' | 'none' | 'skipped'

export interface Deps {
  readonly io: Io
  readonly env: Env
  /** The plugin's root, as the launcher names it. */
  readonly root: string
  /** Runs a command without a shell; `status` is null when it could not start. */
  readonly exec: (argv: readonly [string, ...string[]]) => { readonly status: number | null; readonly stdout: string }
  readonly alive: (pid: number) => boolean
  readonly now: () => Date
  readonly platform: string
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
const isDir = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false

/** The parsed JSON of a file, or undefined when it does not parse. */
function parsed(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Whether a dotted numeric version sorts below the floor, missing components counting as zero. */
export function olderThan(version: string, floor: string): boolean {
  const v = version.split('.').map(Number)
  const f = floor.split('.').map(Number)
  for (let i = 0; i < Math.max(v.length, f.length); i++) {
    if ((v[i] ?? 0) !== (f[i] ?? 0)) return (v[i] ?? 0) < (f[i] ?? 0)
  }
  return false
}

/**
 * What follows the tap in a stored status line command, '' when the tap is all it holds, and
 * undefined when the command does not start with the tap in one of its four spellings: the path
 * itself, or the home spelled `$HOME`, `${HOME}` or `~`. Matched on the stored text, so the
 * command that followed keeps the spelling it was written with.
 */
export function afterTap(stored: string, tap: string, home: string): string | undefined {
  const rel = tap.startsWith(`${home}/`) ? tap.slice(home.length + 1) : tap
  for (const spelling of [tap, `$HOME/${rel}`, `\${HOME}/${rel}`, `~/${rel}`]) {
    if (stored === spelling) return ''
    if (stored.startsWith(`${spelling} `)) return stored.slice(spelling.length + 1)
  }
  return undefined
}

const stamp = (d: Date): string => {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
}

export function main(argv: readonly string[], deps: Deps): number {
  const [mode, ...options] = argv
  const { io, env } = deps
  const home = setting(env, 'HOME') ?? ''
  const config = configDir(env, home)
  const state = join(config, 'claude-orchestrator')
  // The data root and the module's directory that state's data-root file places, read before an uninstall removes it.
  const roots = orchestratorRoots({ ...env, ORCHESTRATOR_STATE_DIR: state }, home)
  const tap = join(state, 'statusline-tap.sh')
  const previous = join(state, 'statusline.previous.json')
  const settings = join(config, 'settings.json')
  const backup = join(config, 'backups', `claude-orchestrator-${stamp(deps.now())}`)

  for (const option of options) {
    if (option !== '--dry-run') {
      io.err(`  unknown option: ${option} (expected --dry-run)\n`)
      return 2
    }
  }
  const dry = options.includes('--dry-run')
  const say = (text: string): void => io.out(`  ${text}\n`)
  const step = (text: string): void => io.out(`\n${text}\n`)
  /** Does `work`, or in a dry run prints the command line that names it. */
  const run = (command: string, work: () => void): void => {
    if (dry) say(`[dry-run] ${command}`)
    else work()
  }
  const remove = (path: string, flags: string): void => run(`rm ${flags} '${path}'`, () => rmSync(path, { recursive: true, force: true }))

  /** One change applied to settings.json, the file backed up first. */
  const apply = (message: string, change: (root: Json) => void): void => {
    if (dry) return say(`[dry-run] ${message}`)
    mkdirSync(backup, { recursive: true })
    copyFileSync(settings, join(backup, 'settings.json.before'))
    const root = parsed(settings)
    if (isObject(root)) {
      change(root)
      writeAtomic(settings, `${JSON.stringify(root, null, 2)}\n`)
    }
    say(message)
  }

  /*
   * The inverse of the tap's own wrap. The command that followed the tap is the authority, kept
   * as written: the saved object dates from the day the tap was wired. It only fills the keys the
   * line lacks, and is restored whole only when the tap was all the line held; with no saved
   * object, such a line is removed.
   */
  const unwrap = (): Unwrap => {
    if (!isFile(settings)) {
      say(`no ${settings}: nothing to unwire`)
      return 'none'
    }
    const root = readFileSync(settings, 'utf8').trim() === '' ? {} : parsed(settings)
    if (root === undefined) {
      // Named and skipped, not read as empty: the file may still hold the tap's wiring.
      io.err(`  ${settings} does not parse as JSON: the status line was not unwired — the tap's wiring, if it is in there, is left as it is; fix the file and run this again.\n`)
      return 'skipped'
    }
    if (!isObject(root) || !('statusLine' in root)) {
      say('no statusLine to unwire')
      return 'none'
    }
    const line = root['statusLine']
    const command = isObject(line) && typeof line['command'] === 'string' ? line['command'] : ''
    const rest = afterTap(command, tap, home)
    if (rest === undefined) {
      say('statusLine carries no tap, left untouched')
      return 'none'
    }
    const saved = isFile(previous) ? parsed(previous) : undefined
    const lineOf = (r: Json): Json => (isObject(r['statusLine']) ? r['statusLine'] : {})
    if (rest !== '' && isObject(saved)) apply(`statusLine.command → ${rest}`, r => { r['statusLine'] = { ...saved, ...lineOf(r), command: rest } })
    else if (rest !== '') apply(`statusLine.command → ${rest}`, r => { r['statusLine'] = { ...lineOf(r), command: rest } })
    else if (isObject(saved)) apply('statusLine restored from the saved object', r => { r['statusLine'] = saved })
    else apply('statusLine removed (the tap was all it held)', r => { delete r['statusLine'] })
    return 'unwired'
  }

  const shellCopy = copyOf(state)
  const shellLine = lineOf(shellCopy, home)
  const profile = profileOf(env, home)

  /** The profile changed to `text`, saved first; the one write this installer makes outside the host's directory and its own. */
  const rewrite = (path: string, text: string, message: string): void => {
    if (dry) return say(`[dry-run] ${message}`)
    if (existsSync(path)) {
      mkdirSync(backup, { recursive: true })
      copyFileSync(path, join(backup, `${basename(path)}.before`))
    }
    writeProfile(path, text)
    say(message)
  }

  const short = (which: 'install' | 'uninstall'): number =>
    shortCommands([which, ...(dry ? ['--dry-run'] : [])], { io, env, root: resolvedPath(deps.root) })

  /*
   * The plugin's shell file, copied beside the state it keeps, and the one line of the profile that
   * sources it. A shell that is neither zsh nor bash gets the file and the line to add by hand.
   */
  const shellFile = (): number => {
    const source = sourceOf(deps.root)
    if (!isFile(source)) {
      io.err(`  no shell file in the plugin: ${source}\n`)
      return 1
    }
    const differs = copyDiffers(deps.root, state)
    const present = isFile(shellCopy)
    if (!differs) say(`shell file up to date: ${shellCopy}`)
    else {
      if (!dry) writeCopy(deps.root, state)
      say(`${dry ? '[dry-run] ' : ''}shell file ${present ? 'rewritten' : 'written'}: ${shellCopy}`)
    }
    if (profile === undefined) {
      say(`SHELL is ${setting(env, 'SHELL')}: only zsh and bash profiles are written, add this line to yours:`)
      say(guarded(shellCopy, home))
      return 0
    }
    const text = isFile(profile.path) ? readFileSync(profile.path, 'utf8') : ''
    const next = withLine(text, shellLine)
    if (next === undefined) say(`line already in ${profile.path}`)
    else rewrite(profile.path, next, `line ${text.split('\n').some(l => l.endsWith(` ${MARKER}`)) ? 'replaced in' : 'added to'} ${profile.path}`)
    // The earlier hand-written block does the same as the file: the user's to delete, never ours.
    const earlier = earlierBlock(text)
    if (earlier.length > 0) {
      say(`${profile.path} still holds the earlier \`unset CLAUDECODE …\` block, line${earlier.length > 1 ? 's' : ''} ${earlier.join(', ')}: the file does the same now, delete that block by hand`)
    }
    return 0
  }

  if (mode === 'uninstall') {
    // The profile's line goes first: the copy it sources leaves with the state directory below.
    const profiled = profile !== undefined && isFile(profile.path) ? readFileSync(profile.path, 'utf8') : undefined
    const without = profiled === undefined ? undefined : withoutLine(profiled, shellLine)
    if (profile !== undefined && without !== undefined) rewrite(profile.path, without, `line removed from ${profile.path}`)
    const unwrapped = unwrap()
    // While a status line may still run the tap, its copy and saved object stay.
    if (isDir(state) && unwrapped === 'skipped') {
      if (dry) say(`[dry-run] empty ${state} but for the tap's copy and saved object`)
      else {
        for (const name of readdirSync(state)) {
          if (name !== basename(tap) && name !== basename(previous)) rmSync(join(state, name), { recursive: true, force: true })
        }
        say(`emptied ${state} but for the tap's copy and saved object: the status line may still run it`)
      }
    } else if (isDir(state)) {
      if (dry) say(`[dry-run] rm -rf ${state}`)
      else {
        rmSync(state, { recursive: true, force: true })
        say(`removed ${state} (measure files, the module's log with its rotation and lock, prompts, tier map)`)
      }
    }
    // A data root placed elsewhere is the operator's directory: named, never removed.
    if (roots.dataRoot !== state && isDir(roots.dataRoot)) say(`left ${roots.dataRoot}, the data root ${state} placed: remove it by hand once no session writes there`)
    const code = short('uninstall')
    if (code !== 0) return code
    say('Done. Restart your session.')
    return 0
  }

  step('Prerequisites')
  // The module's events and the fs API it reads are host 2.1.287 and later; an older host loads
  // the plugin and silently runs none of it.
  const cli = setting(env, 'ORCHESTRATOR_HOST_CLI') ?? 'claude'
  const version = /[0-9]+(\.[0-9]+)+/.exec(deps.exec([cli, '--version']).stdout.split('\n')[0] ?? '')?.[0]
  if (version === undefined) {
    io.err(`  the host's version could not be read from '${cli} --version'; this plugin needs ${HOST_FLOOR} or later.\n`)
    return 1
  }
  if (olderThan(version, HOST_FLOOR)) {
    io.err(`  the host is ${version}; this plugin needs ${HOST_FLOOR} or later (the hooks module).\n`)
    return 1
  }
  say(`host ${version}`)

  step('State directory')
  const measure = join(roots.moduleDir, MEASURE_DIR)
  run(`mkdir -p '${measure}'`, () => mkdirSync(measure, { recursive: true }))
  say(`measure directory ready: ${measure}`)
  // The data root the operator placed, or the file that places none: a refused file leaves the data on the protected root.
  const rootFile = dataRootFileOf(state)
  if (isFile(rootFile)) {
    say(parseDataRoot(readFileSync(rootFile, 'utf8')) === null
      ? `${rootFile} names no absolute data root: the data stays on ${state}`
      : `data root: ${roots.dataRoot}`)
  }
  // The tap's ctx/ directory: nothing reads it since the module measures the session itself.
  if (isDir(join(state, 'ctx'))) {
    remove(join(state, 'ctx'), '-rf')
    say("the tap's ctx/ removed")
  } else say('no ctx/ to remove')

  /*
   * A session writes its measure file when a turn ends, so an idle one keeps an old file it will
   * read again. A file is pruned only past 90 days AND when no live session owns it: the host's
   * registry (sessions/<pid>.json) names each session's id. A closed session's file is kept those
   * 90 days: the series of closed sessions tells whether a change of method helped.
   */
  const live = new Set<string>()
  const sessions = join(config, 'sessions')
  for (const name of isDir(sessions) ? readdirSync(sessions) : []) {
    const pid = /^([0-9]+)\.json$/.exec(name)?.[1]
    if (pid === undefined || !isFile(join(sessions, name)) || !deps.alive(Number(pid))) continue
    const registered = parsed(join(sessions, name))
    if (isObject(registered) && typeof registered['sessionId'] === 'string') live.add(registered['sessionId'])
  }
  let pruned = 0
  for (const entry of isDir(measure) ? readdirSync(measure, { withFileTypes: true, recursive: true }) : []) {
    const path = join(entry.parentPath, entry.name)
    if (!entry.isFile() || !entry.name.endsWith('.json') || live.has(entry.name.slice(0, -'.json'.length))) continue
    if (deps.now().getTime() - statSync(path).mtimeMs <= PRUNE_MS) continue
    remove(path, '-f')
    pruned++
  }
  say(`measure files pruned (past 90 days, no live session): ${pruned}`)

  // The tier map and the server catalogue are the operator's: created empty, never overwritten.
  const created = (what: string, path: string, content: string): void => {
    if (dry) say(`[dry-run] ${what} created: ${path}`)
    else if (isFile(path)) say(`${what} already present: ${path}`)
    else {
      writeFileSync(path, content)
      say(`${what} created: ${path}`)
    }
  }
  created('tier map', join(state, 'models.json'), '{"deep": "", "standard": "", "light": ""}\n')
  say('bind deep, standard and light there to the identifiers this host accepts;')
  say('an unbound tier leaves the choice to the host.')
  created('server catalogue', join(state, 'mcp.json'), '{"servers": {}, "default": []}\n')
  say("name there the servers this machine offers, in the host's own shape, and list the")
  say('elementary ones in default; an agent gets that set, plus what its spawn line adds.')

  // The tab tooling drives the terminal through the app's own API, from a private environment:
  // recent macOS refuses `pip install` into a package-managed Python.
  step('Terminal tooling environment')
  const venv = join(state, 'venv')
  const ok = (argv: readonly [string, ...string[]]): boolean => deps.exec(argv).status === 0
  if (deps.platform !== 'darwin') say('not macOS: the tab tooling is skipped, the other skills work anywhere')
  else if (dry) say(`[dry-run] python3 -m venv ${venv} && pip install iterm2`)
  else if (ok([join(venv, 'bin', 'python'), '-c', 'import iterm2'])) say(`environment already usable: ${venv}`)
  else if (deps.exec(['python3', '--version']).status === null) say('python3 not found: the tab tooling will refuse to run and say so')
  else {
    if (!ok(['python3', '-m', 'venv', venv])) say(`could not create ${venv}`)
    if (ok([join(venv, 'bin', 'pip'), 'install', '-q', '--disable-pip-version-check', 'iterm2'])) say(`environment ready: ${venv}`)
    else {
      say(`could not install the terminal module into ${venv}`)
      say('the tab tooling will refuse to run and say so; everything else works')
    }
  }
  say('iTerm2 must have its API enabled (Preferences > General > Magic > Enable Python API)')

  step('settings.json')
  const unwrapped = unwrap()

  /*
   * The tap's copy and saved object, the shell gates' logs and the heads they kept: inert once no
   * line runs the tap. They stay while a status line may still point at the tap. The module's own
   * heads (.mheads) are never touched.
   */
  step('Old pipeline files')
  if (unwrapped === 'skipped') say('the status line may still run the tap: its files are kept')
  else {
    const gate = join(state, 'stop-gate')
    const heads = isDir(gate) ? readdirSync(gate).filter(n => n.endsWith('.heads')).sort().map(n => join(gate, n)) : []
    const old = [tap, previous, join(state, 'context-gate.log'), join(state, 'stop-gate.log'), ...heads].filter(isFile)
    for (const path of old) remove(path, '-f')
    say(`old pipeline files removed: ${old.length}`)
  }

  // The short names as user commands, each copy marked as this plugin's.
  step('Short commands')
  const code = short('install')
  if (code !== 0) return code
  if (setting(env, 'SHELL') !== undefined) {
    step('Shell file')
    const code = shellFile()
    if (code !== 0) return code
  }
  step('Done.')
  say('Restart your session for the module to take effect.')
  return 0
}

/* node:coverage ignore next 17 */
if (isEntry(import.meta.url)) {
  const [root = '', ...argv] = process.argv.slice(2)
  process.exitCode = main(argv, {
    io: processIo, env: process.env, root, now: () => new Date(), platform: process.platform,
    exec: ([command, ...args]) => {
      const ran = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return { status: ran.error === undefined ? ran.status : null, stdout: ran.stdout ?? '' }
    },
    alive: pid => {
      try {
        return process.kill(pid, 0)
      } catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'EPERM'
      }
    },
  })
}
