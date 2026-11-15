// hooks/background.ts
// No Claude session runs in the background: a session lives in its terminal and ends with it.
// Two guards, in every session. On every Bash call, a command line that starts or resumes a
// background session (`claude --bg`, `claude --background`, `--resume … --bg`, `claude attach`,
// `claude respawn`) or runs the daemon that hosts them (`claude daemon run`, or `claude daemon`
// bare, which runs it when piped) is refused before it runs. At start, a session that is itself a
// background one ends at once: the host marks the sessions its daemon starts with
// CLAUDE_CODE_SESSION_KIND and CLAUDE_JOB_DIR, the two variables its own test of a background
// session reads. The line is read by core's shell reader (core/shell.ts), the strings a shell runs
// with -c, eval runs or a shell reads on its standard input read as lines themselves.
import { innerLine, readCommands, stdinLines, unwrapPath, type ShellCommand } from '../core/shell.ts'
import type { Host, On } from './host.ts'
import { configDir, logLine } from './module-io.ts'

// The nouns the guards hold.
type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'ui'>

// The refusal of a background launch, and the end of a background session: one line, why, and
// what to do instead.
export const BACKGROUND_DENY = 'background Claude session refused, by the operator\'s order: a session lives in its terminal and ends with it. '
  + 'Start it in a tab (the launcher\'s spawn) or run `claude -p` in the foreground.'
export const BACKGROUND_END = 'background Claude session ended at start, by the operator\'s order: a session lives in its terminal and ends with it.'

// The package runners that fetch the CLI and run it: `npx @anthropic-ai/claude-code --bg`.
const RUNNERS = new Set(['npx', 'bunx', 'pnpx'])
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

// The background launches a command line holds, one short form each, none when there is none.
// A line the reader refuses (a brace expansion past its limit) that names claude is read as one.
export function backgroundLaunches(command: string): string[] {
  const found: string[] = []
  const seen = (form: string): void => { if (!found.includes(form)) found.push(form) }
  try {
    launchesIn(command, 0, seen)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    if (/claude/.test(command)) seen('a line the reader cannot read')
  }
  return found
}

function launchesIn(line: string, depth: number, seen: (form: string) => void): void {
  for (const command of readCommands(line)) launchOf(command, depth, seen)
}

function launchOf(command: ShellCommand, depth: number, seen: (form: string) => void): void {
  const bare = unwrapPath(command.argv)
  if (command.lookup || bare.lookup) return
  const argv = bare.argv
  const text = depth < STRING_DEPTH ? innerLine(argv) : undefined
  if (text !== undefined) { launchesIn(text, depth + 1, seen); return }
  const fed = depth < STRING_DEPTH ? stdinLines({ ...command, argv }) : []
  if (fed.length > 0) { for (const line of fed) launchesIn(line, depth + 1, seen); return }
  const args = claudeArgs(argv)
  if (args === undefined) return
  const form = backgroundForm(args)
  if (form !== undefined) seen(form)
}

// The words after the CLI's name when the command runs the CLI, bare or behind a package
// runner; undefined when it runs another program.
function claudeArgs(argv: readonly string[]): readonly string[] | undefined {
  const program = baseName(argv[0] ?? '')
  if (program === 'claude') return argv.slice(1)
  if (!RUNNERS.has(program)) return undefined
  const at = argv.findIndex((word, k) => k > 0 && /^@anthropic-ai\/claude-code(@.*)?$/.test(word))
  return at > 0 ? argv.slice(at + 1) : undefined
}

// What background launch the CLI's words ask for, or undefined for none. A help flag runs
// nothing; a print run's words after its options are its prompt, never a subcommand.
export function backgroundForm(args: readonly string[]): string | undefined {
  if (args.some(word => word === '--help' || word === '-h')) return undefined
  if (args.some(word => /^--(bg|background)(=|$)/.test(word))) return 'claude --bg'
  if (args.some(word => word === '-p' || word === '--print')) return undefined
  const at = subcommandAt(args)
  const sub = at === undefined ? undefined : args[at]
  if (sub === 'attach') return 'claude attach'
  if (sub === 'respawn') return 'claude respawn'
  if (sub === 'daemon' && at !== undefined) {
    const next = args.slice(at + 1).find(word => !word.startsWith('-'))
    if (next === undefined || !DAEMON_HARMLESS.has(next)) return 'claude daemon run'
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
// on every session it starts.
export function isBackgroundSession(kind: string | undefined, jobDir: string | undefined): boolean {
  return Boolean(kind?.trim()) || Boolean(jobDir?.trim())
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
  on('tool.call', { tool: 'Bash' }, async (_$, e, next) => {
    const launches = backgroundLaunches(String(e['command'] ?? ''))
    if (launches.length > 0) return { deny: `${BACKGROUND_DENY} Seen: ${launches.join(', ')}.` }
    return next(e)
  }).catch(async ($, e, next) => {
    // It protects, so it fails closed: a call not yet run that names claude waits for a guard that can read it.
    await logLine($, 'background', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    if (next.called) return next(e)
    const command = String(e['command'] ?? '')
    if (/claude/.test(command)) return { deny: `${BACKGROUND_DENY} The guard could not read this line (${next.error?.message ?? 'it did not finish'}), and a line that names claude waits until it can.` }
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
