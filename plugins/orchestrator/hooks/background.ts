// hooks/background.ts
// No session of the host runs in the background: a session lives in its terminal and ends with it.
// Two guards, in every session. On every Bash call, a command line that runs the host's CLI to start
// or resume a background session (`--bg`, `--background`, `--resume … --bg`, `attach`, `respawn`) or
// to run the daemon that hosts them (`daemon run`, or `daemon` bare, which runs it when piped) is
// refused before it runs. At start, a session that is itself a background one ends at once: the host
// marks the sessions its daemon starts with two variables, the ones its own test of a background
// session reads (isBackgroundSession). The line is read by core's shell reader (core/shell.ts), the
// strings a shell runs with -c, eval runs or a shell reads on its standard input read as lines
// themselves; the CLI goes by the basenames ORCHESTRATOR_HOST_CLI spells, as the launcher's.
import { innerLine, readCommands, stdinLines, unwrapPath, type ShellCommand } from '../core/shell.ts'
import type { Host, On } from './host.ts'
import { configDir, logLine } from './module-io.ts'
import { hostBasenames } from './session-name.ts'

// The nouns the guards hold.
type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'ui'>

// The refusal of a background launch, and the end of a background session: one line, why, and
// what to do instead.
export const BACKGROUND_DENY = 'background session refused, by the operator\'s order: a session lives in its terminal and ends with it. '
  + 'Start it in a tab (the launcher\'s spawn) or run it with -p in the foreground.'
export const BACKGROUND_END = 'background session ended at start, by the operator\'s order: a session lives in its terminal and ends with it.'
// The CLI's options whose value is the next word: that word is no subcommand.
const VALUED = new Set([
  '--model', '--name', '-n', '--effort', '--agent', '--agents', '--settings', '--permission-mode', '--add-dir',
  '--mcp-config', '--session-id', '--resume', '-r', '--plugin-dir', '--append-system-prompt', '--system-prompt',
  '--fallback-model', '--output-format', '--input-format', '--debug-file', '--setting-sources', '--cwd',
])
// The daemon's subcommands that run nothing in the background: they read it or stop it.
const DAEMON_HARMLESS = new Set(['status', 'logs', 'stop', 'uninstall'])
// How many strings may sit inside one another and still be read as command lines.
const STRING_DEPTH = 4

const baseName = (word: string): string => word.replace(/^.*\//, '')

// Whether the text names the host's CLI by one of its basenames, as a word.
function namesHost(text: string, hosts: readonly string[]): boolean {
  return hosts.some(host => text.split(/[^A-Za-z0-9._-]+/).includes(host))
}

// The background launches a command line holds, one short form each, none when there is none;
// `hosts` are the basenames the host's CLI goes by. A line the reader refuses (a brace expansion
// past its limit) that names the CLI is read as one.
export function backgroundLaunches(command: string, hosts: readonly string[]): string[] {
  const found: string[] = []
  const seen = (form: string): void => { if (!found.includes(form)) found.push(form) }
  try {
    launchesIn(command, hosts, 0, seen)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    if (namesHost(command, hosts)) seen('a line the reader cannot read')
  }
  return found
}

function launchesIn(line: string, hosts: readonly string[], depth: number, seen: (form: string) => void): void {
  for (const command of readCommands(line)) launchOf(command, hosts, depth, seen)
}

function launchOf(command: ShellCommand, hosts: readonly string[], depth: number, seen: (form: string) => void): void {
  const bare = unwrapPath(command.argv)
  if (command.lookup || bare.lookup) return
  const argv = bare.argv
  const text = depth < STRING_DEPTH ? innerLine(argv) : undefined
  if (text !== undefined) { launchesIn(text, hosts, depth + 1, seen); return }
  const fed = depth < STRING_DEPTH ? stdinLines({ ...command, argv }) : []
  if (fed.length > 0) { for (const line of fed) launchesIn(line, hosts, depth + 1, seen); return }
  if (!hosts.includes(baseName(argv[0] ?? ''))) return
  const form = backgroundForm(argv.slice(1))
  if (form !== undefined) seen(form)
}

// What background launch the CLI's words ask for, or undefined for none. A help flag runs
// nothing; a print run's words after its options are its prompt, never a subcommand.
export function backgroundForm(args: readonly string[]): string | undefined {
  if (args.some(word => word === '--help' || word === '-h')) return undefined
  if (args.some(word => /^--(bg|background)(=|$)/.test(word))) return '--bg'
  if (args.some(word => word === '-p' || word === '--print')) return undefined
  const at = subcommandAt(args)
  const sub = at === undefined ? undefined : args[at]
  if (sub === 'attach') return 'attach'
  if (sub === 'respawn') return 'respawn'
  if (sub === 'daemon' && at !== undefined) {
    const next = args.slice(at + 1).find(word => !word.startsWith('-'))
    if (next === undefined || !DAEMON_HARMLESS.has(next)) return 'daemon run'
  }
  return undefined
}

// Where the CLI's subcommand sits: the first word that is no option and no option's value.
function subcommandAt(args: readonly string[]): number | undefined {
  for (let k = 0; k < args.length; k++) {
    const word = args[k] ?? ''
    if (word === '--') return undefined
    if (word.startsWith('-')) { if (VALUED.has(word)) k++; continue }
    return k
  }
  return undefined
}

// Whether the host started this session as a background one, by the variables its daemon sets
// on every session it starts: the session's kind, and its job directory.
export function isBackgroundSession(kind: string | undefined, jobDir: string | undefined): boolean {
  return Boolean(kind?.trim()) || Boolean(jobDir?.trim())
}

// The basenames the host's CLI goes by: the name ORCHESTRATOR_HOST_CLI spells, its default the launcher's.
async function hostNames($: Held): Promise<string[]> {
  return hostBasenames((await $.env.get('ORCHESTRATOR_HOST_CLI')) ?? 'claude', null)
}

// The session's own process: the parent of a shell this very session starts, proved by the host
// record the host keeps for each live session (`<config>/sessions/<pid>.json`). Null when either
// fails: a process not proved the session's is never signalled.
async function ownPid($: Held): Promise<string | null> {
  const out = await $.process.run(['sh', '-c', 'echo $PPID'], { timeoutMs: 5_000 })
  const pid = out.stdout.trim()
  if (out.exitCode !== 0 || !/^\d+$/.test(pid) || Number(pid) <= 1) return null
  return (await $.fs.exists(`${await configDir($)}/sessions/${pid}.json`)) ? pid : null
}

export function register(on: On<Held>): void {
  // The launch guard, in every session: the operator's own as much as a launched one.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const launches = backgroundLaunches(String(e['command'] ?? ''), await hostNames($))
    if (launches.length > 0) return { deny: `${BACKGROUND_DENY} Seen: ${launches.join(', ')}.` }
    return next(e)
  }).catch(async ($, e, next) => {
    // It protects, so it fails closed: a call not yet run that names the CLI waits for a guard that can read it.
    await logLine($, 'background', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    if (next.called) return next(e)
    const command = String(e['command'] ?? '')
    const hosts = await hostNames($).catch(() => [] as string[])
    if (hosts.length === 0 || namesHost(command, hosts)) return { deny: `${BACKGROUND_DENY} The guard could not read this line (${next.error?.message ?? 'it did not finish'}), and a line that names the host's CLI waits until it can.` }
    return next(e)
  })
}

// The start guard, called by the module's one session.start handler (register.ts): a background
// session ends at once, with its one line in the module's log. A start the guard cannot read goes
// on: ending a session is never guessed.
export async function endIfBackground($: Held): Promise<void> {
  if (!isBackgroundSession(await $.env.get('CLAUDE_CODE_SESSION_KIND'), await $.env.get('CLAUDE_JOB_DIR'))) return
  await logLine($, 'background', BACKGROUND_END)
  $.ui.toast(BACKGROUND_END)
  const pid = await ownPid($)
  if (pid === null) {
    await logLine($, 'background', 'the background session could not be ended: its own process was not proved')
    return
  }
  await $.process.run(['kill', '-TERM', pid], { timeoutMs: 5_000 })
}
