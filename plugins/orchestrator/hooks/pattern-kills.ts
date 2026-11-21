// hooks/pattern-kills.ts
// The kill guard's reading of a command line, pure: which kills reach processes by name or
// pattern. The line is read by core's shell reader (core/shell.ts), the one every plugin reads
// a command line with; what is a kill by pattern is decided here. Known limits, which pass: a
// variable an assignment filled (`p=$(pgrep x); kill $p`, then `for p in $p`) or a process
// substitution fed (`done < <(pgrep x)`, `mapfile a < <(pgrep x)`): the reader drops an assignment
// and ties no variable, nor a loop, to the substitution that fed it.
import { innerLine, readCommands, stdinLines, unwrapPath, type ShellCommand } from '../core/shell.ts'

// Programs that list processes: what `xargs kill` kills by pattern when one feeds it.
const LISTERS = new Set(['pgrep', 'pidof', 'lsof', 'ps'])
// Package runners that fetch a program and run it: `npx kill-port 3000` runs kill-port. The
// managers among them (`pnpm dlx x`, `npm exec x`) run what follows their subcommand.
const RUNNERS = new Set(['npx', 'bunx', 'pnpx'])
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const RUN_SUBCOMMANDS = new Set(['dlx', 'exec', 'x'])
// The managers that run a binary named right after them, with no subcommand: `pnpm kill-port 3000`.
const BINARY_RUNNERS = new Set(['pnpm', 'yarn', 'bun'])
// How many strings may sit inside one another and still be read as command lines.
const STRING_DEPTH = 4

// The program's name, its directory dropped: `/usr/bin/pkill` is `pkill`.
function baseName(word: string): string {
  return word.replace(/^.*\//, '')
}

// What belongs to the session, a pattern that names it reaching no other session's process: its id,
// which its scratchpad (`/private/tmp/claude-<uid>/<project>/<session id>/…`) carries.
export type Own = { readonly session: string }
const NOTHING: Own = { session: '' }

// The kills by name or pattern a command line holds, one short reason each, none when
// there is none. A kill is pkill or killall whatever their options, or a kill whose pids
// come from a command substitution or, through xargs, from a lister, or one that reaches
// more than one process: every process (`-1`), the caller's group (`0`) or a group
// (`-<pgid>`), or one that takes a variable a lister filled, through a loop (`pgrep x | while
// read p; do kill $p; done`, `for p in $(pgrep x); do kill $p; done`). `fuser -k` and
// `kill-port`, bare or behind a package runner, kill by port or file. `kill 1234`, `kill $pid`, `kill %1`, `kill $(cat file)` (the pid kept in a
// file), `pkill -P "$(cat file)"` (the children of a recorded pid) and `kill -0 …` (a probe, it kills nothing) are not kills by pattern, and neither
// is a `command -v` lookup, which runs nothing. Words in quotes, heredocs and arguments of
// other programs are data, but for the string a shell runs after `-c` and the words eval
// runs, and the text the line writes to the standard input of a shell (`echo 'pkill x' | sh`,
// `sh <<< 'pkill x'`, a heredoc): those are command lines themselves and read as such,
// STRING_DEPTH nested at most. A `pkill` whose one pattern is a path of the session (`own`) is no
// kill of another's: it reaches the session's own processes.
export function detectPatternKills(command: string, own: Own = NOTHING): string[] {
  const found: string[] = []
  const seen = (reason: string): void => { if (!found.includes(reason)) found.push(reason) }
  try {
    killsIn(command, 0, seen, own)
  } catch (error) {
    // A line the reader refuses (a brace expansion past its limit) may hide a kill: it is read as one.
    if (!(error instanceof RangeError)) throw error
    seen('a line the reader cannot read')
  }
  return found
}

// The variables of one command line that a lister filled, each with what filled it.
type Filled = Map<string, string>

// A line is read with the variables a lister filled in the one that holds it (`inherited`): a
// shell string or text given to a shell in the middle of a loop expands them as the loop does.
function killsIn(line: string, depth: number, seen: (reason: string) => void, own: Own, inherited: Filled = new Map()): void {
  const filled: Filled = new Map(inherited)
  const commands = readCommands(line)
  // What a loop reads through a here-string, `done <<< "$(pgrep x)"`, is in the `done` that
  // closes it, after the commands of its body.
  const loop = commands.map(c => (c.argv[0] === 'done' ? listerIn(c.substitutions) : undefined)).find(l => l !== undefined)
  for (const command of commands) killOf(command, depth, seen, own, filled, loop)
}

function killOf(command: ShellCommand, depth: number, seen: (reason: string) => void, own: Own, filled: Filled, loop?: string): void {
  const bare = unwrapPath(command.argv)
  if (bare.wrappers.length > 0) {
    const wrappers = [...command.wrappers, ...bare.wrappers]
    return killOf({ ...command, argv: bare.argv, wrappers, lookup: command.lookup || bare.lookup }, depth, seen, own, filled, loop)
  }
  const { argv, wrappers, lookup, substitutions, piped } = command
  if (lookup) return
  const program = baseName(argv[0] ?? '')
  if (program === 'pkill' && childrenOfRecorded(argv.slice(1), substitutions)) return
  if (program === 'pkill' && substitutions.length === 0 && !wrappers.includes('xargs') && matchesOnlyOwn(argv.slice(1), own)) return
  if (program === 'pkill' || program === 'killall') { seen(program); return }
  if (program === 'fuser' && argv.some(isFuserKill)) { seen('fuser -k'); return }
  if (runsKillPort(argv)) { seen('kill-port'); return }
  const text = depth < STRING_DEPTH ? innerLine(argv) : undefined
  if (text !== undefined) { killsIn(text, depth + 1, seen, own, filled); return }
  const fed = depth < STRING_DEPTH ? stdinLines(command) : []
  if (fed.length > 0) { for (const line of fed) killsIn(line, depth + 1, seen, own, filled); return }
  fill(command, filled, loop)
  if (program !== 'kill' || argv[1] === '-0') return
  if (substitutions.some(held => !isRecordedPid(held))) seen('kill of a command substitution')
  else if (wrappers.includes('xargs')) {
    const lister = piped.find(p => LISTERS.has(p))
    if (lister) seen(`kill fed through xargs by ${lister}`)
  }
  const source = filledTarget(argv.slice(1), filled)
  if (source !== undefined) seen(`kill fed through a loop by ${source}`)
  if (reachesMany(argv.slice(1))) seen('kill of all processes or a process group')
}

// What a loop gives a variable: `read` at the end of a pipe a lister feeds, or fed it through a
// here-string (its own, or the `done` that closes its loop: `loop`), names the variables it reads
// (REPLY when it names none), and `for name in …` with a substitution among its words, other than
// a recorded pid, names the one it sets.
function fill({ argv, substitutions, piped }: ShellCommand, filled: Filled, loop: string | undefined): void {
  if (argv[0] === 'read') {
    const lister = piped.find(p => LISTERS.has(p)) ?? listerIn(substitutions) ?? loop
    if (lister === undefined) return
    const names = argv.slice(1).filter(word => /^[A-Za-z_][A-Za-z0-9_]*$/.test(word))
    for (const name of names.length > 0 ? names : ['REPLY']) filled.set(name, lister)
  } else if (argv[0] === 'for' && argv[2] === 'in' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(argv[1] ?? '')) {
    const lookups = substitutions.filter(held => !isRecordedPid(held))
    if (lookups.length === 0) return
    filled.set(argv[1] ?? '', listerIn(lookups) ?? 'a command substitution')
  }
}

// The first lister among the commands the substitutions held, undefined when none is.
function listerIn(substitutions: readonly (readonly ShellCommand[])[]): string | undefined {
  return substitutions.flat().map(c => baseName(c.argv[0] ?? '')).find(p => LISTERS.has(p))
}

// What filled the first variable among kill's words that a lister filled, or undefined when
// none is. A variable is written `$name`, `"$name"`, or `${name}`, which the reader splits into
// `$` and the name when it is not in quotes.
function filledTarget(args: readonly string[], filled: Filled): string | undefined {
  if (filled.size === 0) return undefined
  for (const [k, word] of args.entries()) {
    for (const [name, source] of filled) {
      if (new RegExp(`\\$\\{?${name}(?![A-Za-z0-9_])`).test(word) || (word === '$' && args[k + 1] === name)) return source
    }
  }
  return undefined
}

// `fuser`'s kill option: `-k`, alone or in a cluster (`-km`), or `--kill`. A signal name
// (`-TERM`, `-KILL`) is no option of its own, and kills nothing without it.
function isFuserKill(word: string): boolean {
  return word === '--kill' || /^-[A-Za-z0-9]*k[A-Za-z0-9]*$/.test(word)
}

// Whether the words run the kill-port program: bare, or behind a package runner (`npx -y
// kill-port 3000`, `pnpm dlx kill-port 3000`, `pnpm kill-port 3000`). Installing it (`npm install kill-port`) runs
// nothing of it.
function runsKillPort(argv: readonly string[]): boolean {
  const isIt = (word: string): boolean => /^kill-port(@.*)?$/.test(baseName(word))
  const program = baseName(argv[0] ?? '')
  if (isIt(program)) return true
  if (RUNNERS.has(program)) return argv.slice(1).some(isIt)
  if (!MANAGERS.has(program)) return false
  if (BINARY_RUNNERS.has(program) && isIt(argv.slice(1).find(word => !word.startsWith('-')) ?? '')) return true
  const at = argv.findIndex((word, k) => k > 0 && RUN_SUBCOMMANDS.has(word))
  return at > 0 && argv.slice(at + 1).some(isIt)
}

// What a command substitution held, when it is a pid read back from the file that
// recorded it: `cat` and one file operand, no wrapper, no option, no glob, no other command. A
// shell variable does not outlive a Bash call, a file does.
function isRecordedPid(held: readonly ShellCommand[]): boolean {
  const [only] = held
  if (held.length !== 1 || only === undefined) return false
  const [program, file] = only.argv
  return only.substitutions.length === 0 && only.wrappers.length === 0 && only.argv.length === 2 && program === 'cat' && file !== undefined && !/^-|[*?[]/.test(file)
}

/*
 * Whether pkill's words reach only the children of a pid the session recorded: at most one signal
 * (`-9`, `-TERM`), then `-P` and the pid read back from its file in quotes (`"$(cat <file>)"`: the
 * one substitution, a recorded pid, which the reader leaves in place as empty words; unquoted it
 * leaves none, and where it stood is unknown). No pattern, no other option. A pid typed in digits is
 * no proof the session started it, and `-P 1` reaches every detached process.
 */
function childrenOfRecorded(args: readonly string[], substitutions: readonly (readonly ShellCommand[])[]): boolean {
  const words = SIGNAL.test(args[0] ?? '') ? args.slice(1) : args
  if (words[0] !== '-P') return false
  const target = words.slice(1)
  const [only] = substitutions
  return substitutions.length === 1 && only !== undefined && isRecordedPid(only) && target.length > 0 && target.every(word => word === '')
}

// A segment of a path a pkill may name: no leading dot (`.`, `..`, a hidden name), never empty.
const SEGMENT = /^[\w@:-][\w.@:-]*$/

/*
 * Whether pkill's words match only the session's own processes: no option but `-f`, `-x` and a
 * signal (`-u`, `-g`, `-P`, `-t`, `-v`, `-i` and the others widen or move the match), and one
 * pattern that is a plain absolute path under the session's scratchpad, the session's id in it. A
 * pattern is matched anywhere in a command line, so the path is read as written: no empty, `.` or
 * `..` segment, no trailing `/`, no regex operator but the dot inside a name. Only a path carrying
 * the session's id reaches that session's processes alone. A substitution or xargs fills words
 * unseen, and a redirection's descriptor (`2>/dev/null`) is left by the reader as a second word:
 * those lines stay refused.
 */
function matchesOnlyOwn(args: readonly string[], own: Own): boolean {
  const options = args.filter(word => word.startsWith('-'))
  const patterns = args.filter(word => !word.startsWith('-'))
  const [path] = patterns
  if (patterns.length !== 1 || path === undefined || !options.every(word => /^-(?:[fx]+|[0-9]{1,2}|[A-Z]{3,}[0-9]?)$/.test(word))) return false
  if (!path.startsWith('/') || !path.slice(1).split('/').every(segment => SEGMENT.test(segment))) return false
  return /^[\w-]+$/.test(own.session) && new RegExp(`^(?:/private)?/tmp/claude-[0-9]+/[^/]+/${own.session}(?:/|$)`).test(path)
}

// A signal option: a number, or a name of three letters or more (`-TERM`, `-SIGKILL`, `-USR1`), never
// a one-letter option such as `-U` that takes the next word as its value.
const SIGNAL = /^-(?:[0-9]{1,2}|[A-Z]{3,}[0-9]?)$/

// Whether the words after `kill` aim at more than one process: `0` (the caller's group),
// `-1` (every process of the user) or `-<digits>`, `-$$`, `-$name` (a group). The options
// come first, the way the shell reads them: one `-<signal>`, `-s <signal>` or `-n <num>`,
// and `--` ends them; every word after is a target, a `-` one included. `-l` lists
// signals and kills nothing. A lone `-1` has no pid to be the signal of, so it is read as
// the target, which is how a kill that took it as one would take it.
function reachesMany(args: readonly string[]): boolean {
  let signal = ''
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '--') { i++; break }
    if (/^-[lL]$/.test(a)) return false
    if (a === '-s' || a === '-n') { signal = a; i++; continue }
    if (!a.startsWith('-') || signal) break
    signal = a
  }
  const targets = args.slice(i)
  if (targets.length === 0) return signal === '-1'
  return targets.some(t => /^0+$/.test(t) || /^-($|[0-9$])/.test(t))
}
