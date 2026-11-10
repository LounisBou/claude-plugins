// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// A command line read the way the shell reads it: quoting, heredocs, comments, $((…)),
// assignments and wrappers. A heredoc body, a comment and quoted text that is an argument (a
// commit message, a body) are data and never read as a command. The command line a shell runs
// with -c, or eval runs, is read again by simpleCommands, one level deep; readCommands hands the
// structure to a reader that needs more than the words (what each substitution held, what fed
// the pipe) and innerLine the line a command runs from a string. Pure functions only. Every plugin that reads a
// command line reads it here (docs/conventions.md, « One rule, one place »).

// Words that end a simple command or open a group: skipped in command position
// the way an assignment is.
const RESERVED = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time'])
// Commands that wrap the real one: everything until a word that is not an option
// of the wrapper is skipped before the real command is read.
const WRAPPER = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'timeout', 'gtimeout', 'sudo', 'xargs', 'rtk'])
// A wrapper's options that take a value, keyed "wrapper option".
const VALUED = new Set([
  'env -u', 'env -C', 'env -S', 'nice -n', 'timeout -s', 'timeout -k', 'gtimeout -s', 'gtimeout -k',
  'sudo -u', 'sudo -g', 'sudo -C', 'sudo -h', 'sudo -p', 'xargs -n', 'xargs -I', 'xargs -P',
  'xargs -L', 'xargs -s', 'xargs -d', 'xargs -E', 'xargs -a',
])
// git global options that take a value: `git -C /tmp/r commit` commits.
const GITVALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])
// The shells whose -c argument is a command line of its own.
const SHELL = /^(.*\/)?(bash|sh|zsh|dash|ksh)$/
// `command`'s lookup options: -v and -V (alone or clustered with -p) print where a program is
// and run nothing.
const LOOKUP = /^-[pvV]*[vV][pvV]*$/

/** One simple command as the shell reads it. */
export interface ShellCommand {
  /** Its words from the real command on, quotes removed: assignments, reserved words and wrappers skipped. */
  readonly argv: readonly string[]
  /** The wrappers skipped before it (`sudo`, `xargs`, `env`…), in order. */
  readonly wrappers: readonly string[]
  /** Whether a `command -v` or `command -V` among them looks the program up rather than run it. */
  readonly lookup: boolean
  /** One entry per command substitution among its words: the simple commands it held. */
  readonly substitutions: readonly (readonly ShellCommand[])[]
  /** The programs, directory dropped, of the commands before it in its pipeline; empty after `;`, `&&`, `||`, `&` or a newline. */
  readonly piped: readonly string[]
}

// Where a git command's subcommand sits in its argv, past git's global options,
// or undefined when the argv is not git's or names no subcommand.
export function gitSubcommand(argv: readonly string[]): { at: number } | undefined {
  if (!/^(.*\/)?git$/.test(argv[0] ?? '')) return undefined
  let k = 1
  for (let word = argv[k]; word !== undefined && word.startsWith('-'); word = argv[++k]) if (GITVALUED.has(word)) k++
  return k < argv.length ? { at: k } : undefined
}

// The argv of every simple command on the line, quotes removed, from its real
// command on: the assignments, reserved words and wrappers before it skipped.
// A command inside $(…) or backticks is one of its own.
export function simpleCommands(line: string): string[][] {
  const out = readCommands(line).map(command => [...command.argv])
  for (const argv of [...out]) {
    const inner = innerLine(argv)
    if (inner !== undefined) out.push(...readCommands(inner).map(command => [...command.argv]))
  }
  return out
}

/**
 * Every simple command of the line, in the order the shell finishes reading them (a
 * substitution's commands before the command that holds it), each with its structure. The
 * command line a shell's -c or eval runs is not read again: innerLine gives it.
 */
export function readCommands(line: string): ShellCommand[] {
  return tokenize(line)
}

/**
 * The command line a command runs from a string, or undefined when it runs none: eval's words
 * joined by spaces, or what a shell (bash, sh, zsh, dash, ksh) runs with -c, alone or in a
 * cluster such as -lc: the first word after its options, the option each -o or -O sets skipped
 * (`bash -o pipefail -c …`, `bash -euo pipefail -c …`).
 */
export function innerLine(argv: readonly string[]): string | undefined {
  if (/^(.*\/)?eval$/.test(argv[0] ?? '')) return argv.length > 1 ? argv.slice(1).join(' ') : undefined
  if (!SHELL.test(argv[0] ?? '')) return undefined
  let dashC = false
  for (let k = 1; k < argv.length; k++) {
    const word = argv[k] ?? ''
    if (/^[-+][A-Za-z]+$/.test(word)) {
      if (word.includes('c')) dashC = true
      k += word.replace(/[^oO]/g, '').length
      continue
    }
    if (word.startsWith('-')) continue
    return dashC ? word : undefined
  }
  return undefined
}

function baseName(word: string): string {
  return word.replace(/^.*\//, '')
}

function tokenize(command: string): ShellCommand[] {
  const found: ShellCommand[] = []

  // The whole command with one trailing newline, and 1-based positions as in
  // the awk being ported: at() is substr(s, i, 1), rest() substr(s, i), find()
  // index(substr(s, i), c) as an absolute position, 0 when absent.
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
  // The substitutions closed among the words of the command being read, each as the
  // commands it held; the commands read so far at each depth below the top (what pop()
  // hands to the depth above); the programs of the pipeline so far, and whether the last
  // separator was a pipe.
  const substs: ShellCommand[][][] = [[]]
  const held: ShellCommand[][] = [[]]
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
    const inside = held[d] ?? []
    d--
    substs[d]?.push(inside)
    cur = ''
    started = dq[d] ? 1 : 0
  }
  function flushWord(): void {
    if (started) {
      if (sk[d]) sk[d] = 0
      else words[d]?.push(cur)
    }
    cur = ''
    started = 0
  }
  function flushCmd(): void {
    if ((words[d] ?? []).length > 0) {
      const piped = piping[d] ? chain[d] ?? [] : []
      const command = analyze(d, piped)
      if (command !== undefined) {
        found.push(command)
        if (d > 0) held[d]?.push(command)
      }
      chain[d] = [...piped, command === undefined ? '' : baseName(command.argv[0] ?? '')]
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
  // A finished simple command, from its real command on; undefined when nothing is left
  // once the assignments, reserved words and wrappers are skipped.
  function analyze(depth: number, piped: readonly string[]): ShellCommand | undefined {
    const w = words[depth] ?? []
    const n = w.length
    const wrappers: string[] = []
    let lookup = false
    let k = 1
    while (k <= n) {
      const word = w[k - 1] ?? ''
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || RESERVED.has(word)) { k++; continue }
      if (WRAPPER.has(word)) {
        const wrap = word
        wrappers.push(wrap)
        k++
        while (k <= n && (w[k - 1] ?? '').startsWith('-')) {
          if (wrap === 'command' && LOOKUP.test(w[k - 1] ?? '')) lookup = true
          k += VALUED.has(`${wrap} ${w[k - 1]}`) ? 2 : 1
        }
        if (wrap === 'timeout' || wrap === 'gtimeout') k++
        continue
      }
      break
    }
    if (k > n) return undefined
    return { argv: w.slice(k - 1), wrappers, lookup, substitutions: substs[depth] ?? [], piped }
  }

  // One pass over s, c the character, n1 the one after it.
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
    else if (c === '(') { flushWord(); flushCmd(); pd[d] = (pd[d] ?? 0) + 1; i++ }
    else if (c === ')') {
      flushWord(); flushCmd()
      const open = pd[d] ?? 0
      if (open > 0) pd[d] = open - 1
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
    // `{}` is a word (`xargs -I {} kill {}`, `find -exec rm {} ;`); a lone brace groups.
    else if (c === '{' && n1 === '}') { cur += '{}'; started = 1; i += 2 }
    else if (c === '{' || c === '}') { flushWord(); i++ }
    else { cur += c; started = 1; i++ }
  }
  flushWord(); flushCmd()
  while (d > 0) pop()
  return found
}

/**
 * Whether a command line redirects output into a file: a `>`, `>>` or `>|` outside quotes whose
 * target is neither `/dev/null` nor another stream (`&1`, `&2`). The tokens of `simpleCommands`
 * carry no redirection, so a guard that must refuse a write asks this as well.
 */
export function redirectsToFile(line: string): boolean {
  let quote: string | undefined
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = undefined
      continue
    }
    if (c === '\\') { i++; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c !== '>') continue
    let j = i + 1
    if (line[j] === '>' || line[j] === '|') j++
    while (line[j] === ' ' || line[j] === '\t') j++
    if (line[j] === '&') { i = j; continue }
    const target = /^[^\s;&|<>()]*/.exec(line.slice(j))?.[0] ?? ''
    if (target.replace(/^['"]|['"]$/g, '') !== '/dev/null') return true
    i = j + target.length - 1
  }
  return false
}
