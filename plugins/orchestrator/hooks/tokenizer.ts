// hooks/tokenizer.ts
// The command line read the way the shell reads it, for the kill guard. scan() splits the
// line into simple commands and hands each to a reader:
//   push()/pop()     — the depth stack with each opener's closer
//   flushWord()      — a finished word joins the current simple command
//   flushCmd()       — a finished simple command goes to the reader scan() was given
//   arith()          — skip $((...)) whole, it may contain `<<`
//   heredoc()        — read <<[-]"delim" and fast-forward past its body lines
//   programOf()      — assignments, then wrappers (skipping their options and
//                      their option arguments), to the command's own program
// Heredoc bodies, comments and text in quotes that is an argument are data.
//
// detectPatternKills reads the kills by name or pattern, and needs two facts beyond the
// words — what each command substitution among a command's words held (the
// substitution's own words are a deeper command, so the outer word is lost to the words
// list), and which programs fed the pipe the command reads from. It also reads the string
// of a shell's `-c` and of eval as a command line of its own.

// Words that end a simple command or open a group: skipped in command position
// the way an assignment is. The awk's own list, kept exactly — the shell's
// grouping punctuation never survives tokenisation as a word, so a longer
// reserved list would change nothing but the shape.
const RESERVED = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time'])
// Commands that wrap the real one: everything until a word that is not an option
// of the wrapper is skipped before the real command is read.
const WRAPPER = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'timeout', 'gtimeout', 'sudo', 'xargs'])
// A wrapper's options that take a value: `env -u X pkill y` kills. Keyed
// "wrapper option", the awk's two-part index joined.
const VALUED = new Set([
  'env -u', 'env -C', 'env -S', 'nice -n', 'timeout -s', 'timeout -k', 'gtimeout -s', 'gtimeout -k',
  'sudo -u', 'sudo -g', 'sudo -C', 'sudo -h', 'sudo -p', 'xargs -n', 'xargs -I', 'xargs -P',
  'xargs -L', 'xargs -s', 'xargs -d', 'xargs -E', 'xargs -a',
])
// The same without `xargs -I`: see detectPatternKills.
const VALUED_BRACELESS = new Set([...VALUED].filter(o => o !== 'xargs -I'))

// One simple command as scan() hands it over: its words, the simple commands each
// command substitution among them held (one entry per substitution), and the programs
// of the commands before it in the same pipeline (empty when it follows `;`, `&&`,
// `||`, `&` or a newline).
interface Simple {
  words: string[]
  substs: Simple[][]
  piped: string[]
}

// `command`'s lookup options: -v and -V (alone or clustered with -p) print where a
// program is and run nothing.
const LOOKUP = /^-[pvV]*[vV][pvV]*$/

// Where the command's own program starts: assignments, reserved words and wrappers
// (with their options and their options' values) skipped. k is the 1-based index of
// the program in words, past the end when there is none; wrappers names those skipped;
// lookup tells that a `command -v` or `command -V` was among them, so the program is
// looked up and not run.
function programOf(w: string[], valued: Set<string> = VALUED): { k: number; wrappers: string[]; lookup: boolean } {
  const n = w.length
  const wrappers: string[] = []
  let lookup = false
  let k = 1
  while (k <= n) {
    const word = w[k - 1]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || RESERVED.has(word)) { k++; continue }
    if (WRAPPER.has(word)) {
      const wrap = word
      wrappers.push(wrap)
      k++
      while (k <= n && w[k - 1].startsWith('-')) {
        if (wrap === 'command' && LOOKUP.test(w[k - 1])) lookup = true
        k += valued.has(`${wrap} ${w[k - 1]}`) ? 2 : 1
      }
      if (wrap === 'timeout' || wrap === 'gtimeout') k++
      continue
    }
    break
  }
  return { k, wrappers, lookup }
}

// The program's name, its directory dropped: `/usr/bin/pkill` is `pkill`.
function baseName(word: string): string {
  return word.replace(/^.*\//, '')
}

// Programs that list processes: what `xargs kill` kills by pattern when one feeds it.
const LISTERS = new Set(['pgrep', 'pidof', 'lsof', 'ps'])
// Shells that run a command line given as a string after `-c`.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
// How many strings may sit inside one another and still be read as command lines.
const STRING_DEPTH = 4

// The kills by name or pattern a command line holds, one short reason each, none when
// there is none. A kill is pkill or killall whatever their options, or a kill whose pids
// come from a command substitution or, through xargs, from a lister, or one that reaches
// more than one process: every process (`-1`), the caller's group (`0`) or a group
// (`-<pgid>`). `kill 1234`, `kill $pid`, `kill %1`, `kill $(cat file)` (the pid kept in a
// file) and `kill -0 …` (a probe, it kills nothing) are not kills by pattern, and neither
// is a `command -v` lookup, which runs nothing. Words in quotes,
// heredocs and arguments of other programs are data, but for the string a shell runs
// after `-c` and the words eval runs: those are command lines themselves and read as
// such, STRING_DEPTH nested at most.
export function detectPatternKills(command: string): string[] {
  const found: string[] = []
  const seen = (reason: string) => { if (!found.includes(reason)) found.push(reason) }
  killsIn(command, 0, seen)
  return found
}

function killsIn(command: string, depth: number, seen: (reason: string) => void): void {
  scan(command, ({ words, substs, piped }) => {
    // `xargs -I {} kill {}`: the tokeniser drops the braces, so the replacement string
    // of a separate `-I` may be gone from the words and the next word is the program.
    // Both readings are tried; a kill under either is a kill.
    for (const valued of [VALUED, VALUED_BRACELESS]) {
      const { k, wrappers, lookup } = programOf(words, valued)
      if (k > words.length) continue
      if (lookup) return
      const program = baseName(words[k - 1])
      if (program === 'pkill' || program === 'killall') { seen(program); return }
      const text = depth < STRING_DEPTH ? stringOf(program, words.slice(k)) : null
      if (text !== null) { killsIn(text, depth + 1, seen); return }
      if (program !== 'kill' || words[k] === '-0') continue
      if (substs.some(held => !isRecordedPid(held))) seen('kill of a command substitution')
      else if (wrappers.includes('xargs')) {
        const lister = piped.find(p => LISTERS.has(p))
        if (lister) seen(`kill fed through xargs by ${lister}`)
      }
      if (reachesMany(words.slice(k))) seen('kill of all processes or a process group')
      return
    }
  })
}

// What a command substitution held, when it is a pid read back from the file that
// recorded it: `cat` and one file operand, no option, no glob, no other command. A
// shell variable does not outlive a Bash call, a file does.
function isRecordedPid(held: Simple[]): boolean {
  if (held.length !== 1) return false
  const { words, substs } = held[0]
  return substs.length === 0 && words.length === 2 && words[0] === 'cat' && !/^-|[*?[]/.test(words[1])
}

// Whether the words after `kill` aim at more than one process: `0` (the caller's group),
// `-1` (every process of the user) or `-<digits>`, `-$$`, `-$name` (a group). The options
// come first, the way the shell reads them: one `-<signal>`, `-s <signal>` or `-n <num>`,
// and `--` ends them; every word after is a target, a `-` one included. `-l` lists
// signals and kills nothing. A lone `-1` has no pid to be the signal of, so it is read as
// the target, which is how a kill that took it as one would take it.
function reachesMany(args: string[]): boolean {
  let signal = ''
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]
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

// The command line a program runs from a string, null when it has none: eval's words
// joined by spaces, or the word after a shell's `-c` option (a cluster ending in c, like
// `-lc`, is one) among the options before its first operand. `-o` and `-O` take a value,
// so `bash -o pipefail -c '…'` still finds its `-c`.
function stringOf(program: string, args: string[]): string | null {
  if (program === 'eval') return args.length > 0 ? args.join(' ') : null
  if (!SHELLS.has(program)) return null
  for (let j = 0; j < args.length && /^[-+]/.test(args[j]); j += /^[-+][A-Za-z]*[oO]$/.test(args[j]) ? 2 : 1) {
    if (/^-[A-Za-z]*c$/.test(args[j])) return args[j + 1] ?? null
  }
  return null
}

// The shared reading: every simple command of the line, in order, to onCommand.
function scan(command: string, onCommand: (c: Simple) => void): void {
  // The whole command, the awk's `s` — one trailing newline appended the way the
  // awk's record reader does. Positions below are the awk's own 1-based ones, so
  // every index lines up with the script being ported: at() is substr(s, i, 1)
  // ("" past either end, never a split of a surrogate pair the awk would have
  // read as two bytes), rest() is substr(s, i), find() is index(substr(s, i), c)
  // returned as an absolute position, 0 when absent.
  const s = command + '\n'
  const L = s.length
  const at = (p: number): string => (p >= 1 && p <= L ? s.charAt(p - 1) : '')
  const rest = (p: number): string => s.slice(p - 1)
  const find = (c: string, p: number): number => {
    const r = s.indexOf(c, p - 1)
    return r === -1 ? 0 : r + 1
  }

  // Per-depth state, index 0 the top level: the closer that ends this nesting
  // (` or )), the words of the simple command being read, the paren depth inside
  // it, whether a double quote is open, whether the next word is a redirected
  // fd's target and must be dropped. Pending heredocs queue their delimiters
  // (HD) and <<- tab stripping (HS) for bodies(), hdone counting those read.
  const closer = ['']
  const words: string[][] = [[]]
  const pd = [0]
  const dq = [0]
  const sk = [0]
  // The command substitutions closed among the words of the simple command being read,
  // each as the simple commands it held; those held so far at each depth below the top
  // (what pop() hands to the depth above); the programs of the pipeline so far, and
  // whether the last separator was a pipe.
  const substs: Simple[][][] = [[]]
  const held: Simple[][] = [[]]
  const chain: string[][] = [[]]
  const piping = [false]
  let d = 0
  let cur = ''
  let started = 0
  const HD = ['']
  const HS = [0]
  let hn = 0
  let hdone = 0

  function push(cl: string): void {
    flushWord(); d++; closer[d] = cl; words[d] = []; pd[d] = 0; dq[d] = 0; sk[d] = 0
    substs[d] = []; held[d] = []; chain[d] = []; piping[d] = false
  }
  function pop(): void {
    flushWord(); flushCmd()
    const inside = held[d]
    d--
    substs[d].push(inside)
    cur = ''
    started = dq[d] ? 1 : 0
  }
  function flushWord(): void {
    if (started) {
      if (sk[d]) sk[d] = 0
      else words[d].push(cur)
    }
    cur = ''
    started = 0
  }
  function flushCmd(): void {
    const w = words[d]
    if (w.length > 0) {
      const piped = piping[d] ? chain[d] : []
      const simple = { words: w, substs: substs[d], piped }
      if (d > 0) held[d].push(simple)
      onCommand(simple)
      const { k } = programOf(w)
      chain[d] = [...piped, k <= w.length ? baseName(w[k - 1]) : '']
      piping[d] = false
    }
    words[d] = []
    sk[d] = 0
    substs[d] = []
  }
  // `$((...))` is arithmetic, not a command: skipped whole, so a `<<` inside it is no heredoc.
  function arith(j: number): number {
    let n = 0
    for (; j <= L; j++) {
      const ch = at(j)
      if (ch === '(') n++
      else if (ch === ')') { n--; if (n === 0) return j + 1 }
    }
    return j
  }
  // After `<<` or `<<-`: the delimiter, quotes removed. The body starts at the next newline.
  function heredoc(j: number): number {
    let strip = 0
    if (at(j) === '-') { strip = 1; j++ }
    while (at(j) === ' ' || at(j) === '\t') j++
    let dl = ''
    for (; j <= L; j++) {
      const ch = at(j)
      if (ch === "'" || ch === '"') {
        const q = find(ch, j + 1)
        if (q === 0) { dl += rest(j + 1); j = L + 1; break }
        dl += s.slice(j, q - 1)
        j = q
        continue
      }
      if (ch === '\\') { dl += at(j + 1); j++; continue }
      if (/[ \t\n;|&<>()]/.test(ch)) break
      dl += ch
    }
    hn++; HD[hn] = dl; HS[hn] = strip
    return j
  }
  function bodies(j: number): number {
    for (let k = hdone + 1; k <= hn; k++) {
      while (j <= L) {
        const e = find('\n', j)
        let line: string
        if (e === 0) { line = rest(j); j = L + 1 }
        else { line = s.slice(j - 1, e - 1); j = e + 1 }
        if (HS[k]) line = line.replace(/^\t+/, '')
        if (line === HD[k]) break
      }
    }
    hdone = hn
    return j
  }
  // The awk's END block: one pass over s, c the character, n1 the one after it.
  let i = 1
  while (i <= L) {
    const c = at(i), n1 = at(i + 1)
    if (dq[d]) {
      if (c === '"') { dq[d] = 0; i++ }
      else if (c === '\\') {
        if (n1 === '\n') i += 2
        else { cur += /[$`"\\]/.test(n1) ? n1 : c + n1; i += 2 }
      }
      else if (c === '`') { push('`'); i++ }
      else if (c === '$' && n1 === '(') {
        if (at(i + 2) === '(') i = arith(i + 1)
        else { push(')'); i += 2 }
      }
      else { cur += c; i++ }
      continue
    }
    if (c === ' ' || c === '\t') { flushWord(); i++ }
    else if (c === '\n') { flushWord(); flushCmd(); i = bodies(i + 1) }
    else if (c === '\\') { if (n1 !== '\n') { cur += n1; started = 1 } i += 2 }
    else if (c === "'") {
      const j = find("'", i + 1)
      if (j === 0) { cur += rest(i + 1); i = L + 1 }
      else { cur += s.slice(i, j - 1); i = j + 1 }
      started = 1
    }
    else if (c === '$' && (n1 === "'" || n1 === '"')) i++
    else if (c === '"') { dq[d] = 1; started = 1; i++ }
    else if (c === '#' && !started) { while (i <= L && at(i) !== '\n') i++ }
    else if (c === '$' && n1 === '(') {
      if (at(i + 2) === '(') { i = arith(i + 1); started = 1 }
      else { push(')'); i += 2 }
    }
    else if (c === '`') { if (d > 0 && closer[d] === '`') pop(); else push('`'); i++ }
    else if (c === '(') { flushWord(); flushCmd(); pd[d]++; i++ }
    else if (c === ')') {
      flushWord(); flushCmd()
      if (pd[d] > 0) pd[d]--
      else if (d > 0 && closer[d] === ')') pop()
      i++
    }
    else if (c === '|') {
      flushWord(); flushCmd()
      // `||` is a list, not a pipe; `|&` pipes the error stream too.
      if (n1 === '|') i += 2
      else { piping[d] = true; i += n1 === '&' ? 2 : 1 }
    }
    else if (c === ';') { flushWord(); flushCmd(); i++ }
    else if (c === '&') { flushWord(); if (n1 !== '>') flushCmd(); i++ }
    else if (c === '<' && n1 === '<') {
      flushWord()
      if (at(i + 2) === '<') { sk[d] = 1; i += 3 }
      else i = heredoc(i + 2)
    }
    else if (c === '<' || c === '>') {
      flushWord(); i++
      while (/[<>&|]/.test(at(i))) i++
      sk[d] = 1
    }
    else if (c === '{' || c === '}') { flushWord(); i++ }
    else { cur += c; started = 1; i++ }
  }
  flushWord(); flushCmd()
  while (d > 0) pop()
}
