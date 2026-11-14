// A command line read the way the shell reads it: quoting, heredocs, comments, $((…)),
// assignments and wrappers. A heredoc body, a comment and quoted text that is an argument (a
// commit message, a body) are data and never read as a command. The command line a shell runs
// with -c, or eval runs, is read again by simpleCommands, one level deep; readCommands hands the
// structure to a reader that needs more than the words (what each substitution held, what fed
// the pipe) and innerLine the line a command runs from a string; the text a line writes to a
// command's standard input (a heredoc, a here-string, what echo or printf print into a pipe) is
// kept on the command, and stdinLines gives what a shell reads from it. Pure functions only.
// Every plugin that reads a command line reads it here (docs/conventions.md, « One rule, one place »).

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
// The shells' long options that take a value as the next word: it is no script file.
const VALUED_LONG = new Set(['--rcfile', '--init-file'])
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
  /**
   * The text the line itself writes to its standard input: its here-strings and heredoc bodies,
   * and, in a pipeline, the same from the commands before it with what an `echo` or `printf`
   * among them prints. A body or a word is one entry; text a command reads from a file or
   * another program's output is not there.
   */
  readonly stdin: readonly string[]
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

/**
 * The command lines a shell reads from its standard input, when the line writes them: the
 * command's `stdin` for a shell run with no `-c` and no script file (`sh`, `bash -s`, `bash -`,
 * `bash -o pipefail`, `bash --rcfile f`), none for any other command, for a shell given a command
 * string or a script, which read no commands from it, nor for one that only parses (`-n`).
 */
export function stdinLines(command: ShellCommand): readonly string[] {
  const { argv } = command
  if (!SHELL.test(argv[0] ?? '')) return []
  for (let k = 1; k < argv.length; k++) {
    const word = argv[k] ?? ''
    if (word === '-') break
    if (/^[-+][A-Za-z]+$/.test(word)) {
      if (word.includes('c') || (word.startsWith('-') && word.includes('n'))) return []
      if (word.includes('s')) break
      k += word.replace(/[^oO]/g, '').length
      continue
    }
    if (VALUED_LONG.has(word)) { k++; continue }
    if (word.startsWith('-')) continue
    return []
  }
  return command.stdin
}

// Where a wrapper's own words end: `next` is the index of the first word after its options (and
// the duration of `timeout`), `from` the index of the first word after its name; `lookup` is
// whether a `command -v` among them looks the program up rather than run it.
function pastOptions(wrap: string, w: readonly string[], from: number): { next: number; lookup: boolean } {
  let next = from
  let lookup = false
  while (next < w.length && (w[next] ?? '').startsWith('-')) {
    if (wrap === 'command' && LOOKUP.test(w[next] ?? '')) lookup = true
    next += VALUED.has(`${wrap} ${w[next]}`) ? 2 : 1
  }
  if (wrap === 'timeout' || wrap === 'gtimeout') next++
  return { next, lookup }
}

/**
 * The command a wrapper written with its directory runs (`/usr/bin/env bash -c …`, which
 * readCommands keeps as the program `/usr/bin/env`, leaving every reader it serves as it is): the
 * words from the real command on, the wrappers skipped by their base name, and whether a lookup
 * is among them. A command that does not start with such a wrapper comes back as it is.
 */
export function unwrapPath(argv: readonly string[]): { argv: readonly string[]; wrappers: readonly string[]; lookup: boolean } {
  const wrappers: string[] = []
  let lookup = false
  let i = 0
  if ((argv[0] ?? '').includes('/') && WRAPPER.has(baseName(argv[0] ?? ''))) {
    while (i < argv.length) {
      const word = argv[i] ?? ''
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { i++; continue }
      const wrap = baseName(word)
      if (!WRAPPER.has(wrap)) break
      wrappers.push(wrap)
      const past = pastOptions(wrap, argv, i + 1)
      i = past.next
      lookup ||= past.lookup
    }
  }
  return { argv: argv.slice(i), wrappers, lookup }
}

function baseName(word: string): string {
  return word.replace(/^.*\//, '')
}

// What an `echo` or a `printf` writes into a pipe, as the text a shell at its other end would
// read: echo's words joined by a space, each of printf's words on its own (its format may
// shape them, a word it prints is still a line a shell would read).
function printed(argv: readonly string[]): string[] {
  const program = baseName(argv[0] ?? '')
  const args = argv.slice(1)
  if (program === 'echo') {
    const text = args.filter((word, k) => !(/^-[neE]+$/.test(word) && args.slice(0, k).every(w => /^-[neE]+$/.test(w)))).join(' ')
    return text === '' ? [] : [text]
  }
  return program === 'printf' ? args.filter(word => word !== '' && word !== '--') : []
}

// What the commands of a pipeline so far write to a standard input: texts, and the heredocs whose
// bodies, not read yet, are to be added.
interface Feed {
  readonly texts: readonly string[]
  readonly hds: readonly number[]
}

// The most words one brace expansion may give: a word that would give more is left as it is.
const BRACE_LIMIT = 1000

// A word as characters and, one per character, whether it was quoted or escaped ('1') or not ('0').
interface Marked {
  readonly text: string
  readonly quoted: string
}

// The values of a sequence expression `x..y` or `x..y..step` (two integers, or two single letters
// of the same kind), or undefined when the body is no sequence or would give more than the limit.
function sequence(body: string): string[] | undefined {
  const m = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(body)
  if (m === null) return undefined
  const [, from = '', to = '', by] = m
  const letters = /^[A-Za-z]$/.test(from)
  if (letters !== /^[A-Za-z]$/.test(to)) return undefined
  const first = letters ? from.charCodeAt(0) : Number(from)
  const last = letters ? to.charCodeAt(0) : Number(to)
  const step = Math.abs(Number(by ?? 1)) || 1
  if (Math.abs(last - first) / step + 1 > BRACE_LIMIT) return undefined
  const width = !letters && (/^-?0\d/.test(from) || /^-?0\d/.test(to)) ? Math.max(from.length, to.length) : 0
  const out: string[] = []
  for (let v = first; first <= last ? v <= last : v >= last; v += first <= last ? step : -step) {
    if (letters) out.push(String.fromCharCode(v))
    else out.push(v < 0 ? '-' + String(-v).padStart(width - 1, '0') : String(v).padStart(width, '0'))
  }
  return out
}

// Where the brace group opened at `open` closes, and the alternatives of its top-level commas;
// undefined when it never closes. Quoted braces and commas are no part of the syntax.
function braceGroup(w: Marked, open: number): { close: number; parts: Marked[] } | undefined {
  let depth = 0
  let from = open + 1
  const parts: Marked[] = []
  for (let i = open; i < w.text.length; i++) {
    if (w.quoted[i] === '1') continue
    const c = w.text[i]
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      parts.push({ text: w.text.slice(from, i), quoted: w.quoted.slice(from, i) })
      return { close: i, parts }
    }
    else if (c === ',' && depth === 1) {
      parts.push({ text: w.text.slice(from, i), quoted: w.quoted.slice(from, i) })
      from = i + 1
    }
  }
  return undefined
}

// The words an unquoted word gives once bash has expanded its braces (`{a,b}`, `x{1..3}`): the
// brace expansion runs before the command is looked up, so `{git,push,--force}` is `git push
// --force`. A brace that is quoted or escaped, follows `$`, holds no top-level comma or sequence,
// or never closes stays as it is. Undefined when the word holds no expansion; throws when it would
// give more than BRACE_LIMIT words.
function braces(w: Marked, budget: { left: number }): Marked[] | undefined {
  for (let i = 0; i < w.text.length; i++) {
    if (w.quoted[i] === '1') continue
    if (w.text[i] === '$' && w.text[i + 1] === '{' && w.quoted[i + 1] !== '1') {
      const skip = braceGroup(w, i + 1)
      if (skip !== undefined) i = skip.close
      continue
    }
    if (w.text[i] !== '{') continue
    const group = braceGroup(w, i)
    if (group === undefined) continue
    const body = w.text.slice(i + 1, group.close)
    const seq = group.parts.length === 1 && !w.quoted.slice(i + 1, group.close).includes('1') ? sequence(body) : undefined
    if (group.parts.length === 1 && seq === undefined) continue
    const alternatives = seq === undefined ? group.parts.flatMap(part => braces(part, budget) ?? [part]) : seq.map(text => ({ text, quoted: '0'.repeat(text.length) }))
    const post = { text: w.text.slice(group.close + 1), quoted: w.quoted.slice(group.close + 1) }
    const tails = braces(post, budget) ?? [post]
    const out: Marked[] = []
    for (const alt of alternatives) {
      for (const tail of tails) {
        if (--budget.left < 0) throw new RangeError('brace expansion over the limit')
        out.push({ text: w.text.slice(0, i) + alt.text + tail.text, quoted: w.quoted.slice(0, i) + alt.quoted + tail.quoted })
      }
    }
    return out
  }
  return undefined
}

// The words of one unquoted-or-quoted word after brace expansion; the word itself, as one, when
// it holds no expansion or would give more than BRACE_LIMIT words.
function expandWord(text: string, quoted: string): string[] {
  try {
    return (braces({ text, quoted }, { left: BRACE_LIMIT }) ?? [{ text, quoted }]).map(word => word.text)
  } catch (error) {
    if (error instanceof RangeError) return [text]
    throw error
  }
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
  // 1 drops the next word (a redirection's target), 2 keeps it as a here-string's text.
  const sk = [0]
  // The here-string words and the heredocs (by number) the command being read opened; what the
  // earlier commands of the pipeline write to a standard input, as texts and heredocs; and,
  // by heredoc number, every stdin list its body goes to once the body is read.
  const hereWords: string[][] = [[]]
  const hdOwn: number[][] = [[]]
  const feeds: Feed[] = [{ texts: [], hds: [] }]
  const sinks: string[][][] = []
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
  // One character per character of cur: '1' when it was quoted or escaped, '0' when not.
  let curq = ''
  let started = 0
  const add = (text: string, quoted: boolean): void => { cur += text; curq += (quoted ? '1' : '0').repeat(text.length) }
  const HD = ['']
  const HS = [0]
  let hn = 0
  let hdone = 0

  function push(cl: string): void {
    flushWord(); d++; closer[d] = cl; words[d] = []; pd[d] = 0; dq[d] = 0; sk[d] = 0
    substs[d] = []; held[d] = []; chain[d] = []; piping[d] = false
    hereWords[d] = []; hdOwn[d] = []; feeds[d] = { texts: [], hds: [] }
  }
  function pop(): void {
    flushWord(); flushCmd()
    const inside = held[d] ?? []
    d--
    substs[d]?.push(inside)
    cur = ''
    curq = ''
    started = dq[d] ? 1 : 0
  }
  function flushWord(): void {
    if (started) {
      if (sk[d] === 2) { hereWords[d]?.push(cur); sk[d] = 0 }
      else if (sk[d]) sk[d] = 0
      else words[d]?.push(...expandWord(cur, curq))
    }
    cur = ''
    curq = ''
    started = 0
  }
  function flushCmd(): void {
    if ((words[d] ?? []).length > 0) {
      const piped = piping[d] ? chain[d] ?? [] : []
      const before = piping[d] ? feeds[d] ?? { texts: [], hds: [] } : { texts: [], hds: [] }
      const here = hereWords[d] ?? []
      const opened = hdOwn[d] ?? []
      const stdin = [...before.texts, ...here]
      for (const k of [...before.hds, ...opened]) (sinks[k] ??= []).push(stdin)
      const command = analyze(d, piped, stdin)
      if (command !== undefined) {
        found.push(command)
        if (d > 0) held[d]?.push(command)
      }
      chain[d] = [...piped, command === undefined ? '' : baseName(command.argv[0] ?? '')]
      feeds[d] = { texts: [...stdin, ...(command === undefined ? [] : printed(command.argv))], hds: [...before.hds, ...opened] }
      piping[d] = false
    }
    words[d] = []
    sk[d] = 0
    substs[d] = []
    hereWords[d] = []
    hdOwn[d] = []
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
    hdOwn[d]?.push(hn)
    return j
  }
  function bodies(j: number): number {
    for (let k = hdone + 1; k <= hn; k++) {
      const body: string[] = []
      while (j <= L) {
        const e = find('\n', j)
        let line: string
        if (e === 0) { line = rest(j); j = L + 1 }
        else { line = s.slice(j - 1, e - 1); j = e + 1 }
        if (HS[k]) line = line.replace(/^\t+/, '')
        if (line === HD[k]) break
        body.push(line)
      }
      for (const sink of sinks[k] ?? []) sink.push(body.join('\n'))
    }
    hdone = hn
    return j
  }
  // A finished simple command, from its real command on; undefined when nothing is left
  // once the assignments, reserved words and wrappers are skipped.
  function analyze(depth: number, piped: readonly string[], stdin: readonly string[]): ShellCommand | undefined {
    const w = words[depth] ?? []
    const n = w.length
    const wrappers: string[] = []
    let lookup = false
    let k = 1
    while (k <= n) {
      const word = w[k - 1] ?? ''
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || RESERVED.has(word)) { k++; continue }
      if (WRAPPER.has(word)) {
        wrappers.push(word)
        const past = pastOptions(word, w, k)
        k = past.next + 1
        lookup ||= past.lookup
        continue
      }
      break
    }
    if (k > n) return undefined
    return { argv: w.slice(k - 1), wrappers, lookup, substitutions: substs[depth] ?? [], piped, stdin }
  }

  // One pass over s, c the character, n1 the one after it.
  let i = 1
  while (i <= L) {
    const c = at(i), n1 = at(i + 1)
    if (dq[d]) {
      if (c === '"') { dq[d] = 0; i++ }
      else if (c === '\\') {
        if (n1 === '\n') i += 2
        else { add(/[$`"\\]/.test(n1) ? n1 : c + n1, true); i += 2 }
      }
      else if (c === '`') { push('`'); i++ }
      else if (c === '$' && n1 === '(') {
        if (at(i + 2) === '(') i = arith(i + 1)
        else { push(')'); i += 2 }
      }
      else { add(c, true); i++ }
      continue
    }
    if (c === ' ' || c === '\t') { flushWord(); i++ }
    else if (c === '\n') { flushWord(); flushCmd(); i = bodies(i + 1) }
    else if (c === '\\') { if (n1 !== '\n') { add(n1, true); started = 1 } i += 2 }
    else if (c === "'") {
      const j = find("'", i + 1)
      if (j === 0) { add(rest(i + 1), true); i = L + 1 }
      else { add(s.slice(i, j - 1), true); i = j + 1 }
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
      if (at(i + 2) === '<') { sk[d] = 2; i += 3 }
      else i = heredoc(i + 2)
    }
    else if (c === '<' || c === '>') {
      flushWord(); i++
      while (/[<>&|]/.test(at(i))) i++
      sk[d] = 1
    }
    // `{}` is a word (`xargs -I {} kill {}`, `find -exec rm {} ;`); a brace standing alone groups,
    // one inside a word (`repos/{owner}/x`, `{a,b}`) stays part of it.
    else if (c === '{' && n1 === '}') { add('{}', true); started = 1; i += 2 }
    else if ((c === '{' || c === '}') && !started && /^[\s;&|()<>]?$/.test(n1)) { i++ }
    else { add(c, false); started = 1; i++ }
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
