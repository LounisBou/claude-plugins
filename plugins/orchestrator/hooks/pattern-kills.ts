// hooks/pattern-kills.ts
// The kill guard's reading of a command line, pure: which kills reach processes by name or
// pattern. The line is read by core's shell reader (core/shell.ts), the one every plugin reads
// a command line with; what is a kill by pattern is decided here.
import { innerLine, readCommands, type ShellCommand } from '../core/shell.ts'

// Programs that list processes: what `xargs kill` kills by pattern when one feeds it.
const LISTERS = new Set(['pgrep', 'pidof', 'lsof', 'ps'])
// How many strings may sit inside one another and still be read as command lines.
const STRING_DEPTH = 4

// The program's name, its directory dropped: `/usr/bin/pkill` is `pkill`.
function baseName(word: string): string {
  return word.replace(/^.*\//, '')
}

// The kills by name or pattern a command line holds, one short reason each, none when
// there is none. A kill is pkill or killall whatever their options, or a kill whose pids
// come from a command substitution or, through xargs, from a lister, or one that reaches
// more than one process: every process (`-1`), the caller's group (`0`) or a group
// (`-<pgid>`). `kill 1234`, `kill $pid`, `kill %1`, `kill $(cat file)` (the pid kept in a
// file) and `kill -0 …` (a probe, it kills nothing) are not kills by pattern, and neither
// is a `command -v` lookup, which runs nothing. Words in quotes, heredocs and arguments of
// other programs are data, but for the string a shell runs after `-c` and the words eval
// runs: those are command lines themselves and read as such, STRING_DEPTH nested at most.
export function detectPatternKills(command: string): string[] {
  const found: string[] = []
  const seen = (reason: string): void => { if (!found.includes(reason)) found.push(reason) }
  killsIn(command, 0, seen)
  return found
}

function killsIn(line: string, depth: number, seen: (reason: string) => void): void {
  for (const command of readCommands(line)) killOf(command, depth, seen)
}

function killOf({ argv, wrappers, lookup, substitutions, piped }: ShellCommand, depth: number, seen: (reason: string) => void): void {
  if (lookup) return
  const program = baseName(argv[0] ?? '')
  if (program === 'pkill' || program === 'killall') { seen(program); return }
  const text = depth < STRING_DEPTH ? innerLine(argv) : undefined
  if (text !== undefined) { killsIn(text, depth + 1, seen); return }
  if (program !== 'kill' || argv[1] === '-0') return
  if (substitutions.some(held => !isRecordedPid(held))) seen('kill of a command substitution')
  else if (wrappers.includes('xargs')) {
    const lister = piped.find(p => LISTERS.has(p))
    if (lister) seen(`kill fed through xargs by ${lister}`)
  }
  if (reachesMany(argv.slice(1))) seen('kill of all processes or a process group')
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
