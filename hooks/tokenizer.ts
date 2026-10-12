// hooks/tokenizer.ts
// Ported from the awk tokeniser in hooks/push-guard.sh. The specification is the
// header comment of that script: the command line is tokenised the way the shell
// reads it, and only a command whose first word is git followed by its global
// options and `push` is read for a force. The awk source stays in the repo until
// Task 12; the sets below are its BEGIN block verbatim, and every function maps
// to one awk function, same behaviour, same order:
//   push()/pop()     — the depth stack with each opener's closer
//   flushWord()      — a finished word joins the current simple command
//   flushCmd()       — a finished simple command goes to analyze()
//   arith()          — skip $((...)) whole, it may contain `<<`
//   heredoc()        — read <<[-]"delim" and fast-forward past its body lines
//   analyze()        — assignments, then wrappers (skipping their options and
//                      their option arguments), then: git + valued global
//                      options + `push` + valued push options, and the force
//                      rules on the remaining words
// Everything else — non-git commands, heredoc bodies, comments, text in quotes
// that is an argument not an option — is data and never a force.

// Words that end a simple command or open a group: skipped in command position
// the way an assignment is. The awk's own list, kept exactly — the shell's
// grouping punctuation never survives tokenisation as a word, so a longer
// reserved list would change nothing but the shape.
const RESERVED = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time'])
// Commands that wrap the real one: everything until a word that is not an option
// of the wrapper is skipped before the real command is read.
const WRAPPER = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'timeout', 'gtimeout', 'sudo', 'xargs'])
// A wrapper's options that take a value: `env -u X git push -f` pushes. Keyed
// "wrapper option", the awk's two-part index joined.
const VALUED = new Set([
  'env -u', 'env -C', 'env -S', 'nice -n', 'timeout -s', 'timeout -k', 'gtimeout -s', 'gtimeout -k',
  'sudo -u', 'sudo -g', 'sudo -C', 'sudo -h', 'sudo -p', 'xargs -n', 'xargs -I', 'xargs -P',
  'xargs -L', 'xargs -s', 'xargs -d', 'xargs -E', 'xargs -a',
])
// git global options that take a value: `git -C /tmp/r push --force` pushes.
const GITVALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])
// push options that take a value: `git push --repo x --force-with-lease` still forces.
const PUSHVALUED = new Set(['--repo', '--push-option', '--receive-pack', '--exec'])

export function detectForces(command: string): string[] {
  const found: string[] = []
  // Dedup is exact where the awk's was substring — a deliberate widening: the module's « Seen: … » can name a reason the shell guard suppressed; verdicts identical.
  const seen = (reason: string) => { if (!found.includes(reason)) found.push(reason) }

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
  let d = 0
  let cur = ''
  let started = 0
  const HD = ['']
  const HS = [0]
  let hn = 0
  let hdone = 0

  function push(cl: string): void {
    flushWord(); d++; closer[d] = cl; words[d] = []; pd[d] = 0; dq[d] = 0; sk[d] = 0
  }
  function pop(): void {
    flushWord(); flushCmd(); d--
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
    analyze(d)
    words[d] = []
    sk[d] = 0
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
  function prefixOf(name: string, full: string, min: number): boolean {
    return name.length >= min && full.indexOf(name) === 0
  }
  function analyze(depth: number): void {
    const w = words[depth]
    const n = w.length
    let k = 1
    while (k <= n) {
      const word = w[k - 1]
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || RESERVED.has(word)) { k++; continue }
      if (WRAPPER.has(word)) {
        const wrap = word
        k++
        while (k <= n && w[k - 1].startsWith('-')) {
          k += VALUED.has(`${wrap} ${w[k - 1]}`) ? 2 : 1
        }
        if (wrap === 'timeout' || wrap === 'gtimeout') k++
        continue
      }
      break
    }
    if (k > n || !/^(.*\/)?git$/.test(w[k - 1])) return
    for (k++; k <= n && w[k - 1].startsWith('-'); k++) { if (GITVALUED.has(w[k - 1])) k++ }
    if (k > n || w[k - 1] !== 'push') return
    let skip = 0
    let ddash = 0
    for (k++; k <= n; k++) {
      const word = w[k - 1]
      if (skip) { skip = 0; continue }
      if (!ddash && word === '--') { ddash = 1; continue }
      if (!ddash && /^--/.test(word)) {
        const eq = word.indexOf('=') + 1
        const name = eq ? word.slice(0, eq - 1) : word
        const val = eq ? word.slice(eq) : ''
        if (prefixOf(name, '--force', 4)) seen('--force')
        else if (prefixOf(name, '--force-with-lease', 9)) {
          // The pinned form is a shape, not a length: `<branch>:<sha>` with a
          // non-empty sha, exactly the awk's rule — the spec says "not of the
          // form =<branch>:<sha>", and a hex-length limit would refuse the
          // 64-character object ids of a SHA-256 repository.
          if (!eq || !/^[^:= \t\n]+:[^ \t\n]+$/.test(val)) seen('--force-with-lease without <branch>:<sha>')
        }
        else if (prefixOf(name, '--mirror', 4)) seen('--mirror')
        else if (!eq && PUSHVALUED.has(name)) skip = 1
        continue
      }
      if (!ddash && /^-./.test(word)) {
        for (let j = 2; j <= word.length; j++) {
          const ch = word.charAt(j - 1)
          if (ch === 'f') seen('-f')
          if (ch === 'o') { if (j === word.length) skip = 1; break }
        }
        continue
      }
      if (/^\+/.test(word)) seen('a +<refspec>')
    }
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
    else if (c === ';' || c === '|') { flushWord(); flushCmd(); i++ }
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
  return found
}
