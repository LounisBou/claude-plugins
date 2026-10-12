// hooks/core.ts
// The pure half of the hooks module: the state file's parser and writer, the
// preflight's verdict, the ignore guard's verdict, the shell reader the guards
// judge Bash lines with, and every guard decision. Nothing here touches `$`:
// register.ts reads the world and hands the facts in.

export const REQUIRED_PLUGINS = ['superpowers@claude-plugins-official'] as const

// The five skills by their short name, and the spelling the engine gives them.
export const SKILLS = ['feature', 'phase', 'check', 'close', 'prepare'] as const
export type SkillName = typeof SKILLS[number]

export function skillOf(key: string): SkillName | null {
  const short = key.startsWith('implement:') ? key.slice('implement:'.length) : ''
  return (SKILLS as readonly string[]).includes(short) ? short as SkillName : null
}

// ── The state file ───────────────────────────────────────────────────────────

export type Row = { phase: string; title: string; status: string; milestone: string }
export type State = {
  codename: string | null
  title: string | null
  branch: string | null
  bump: string | null
  artifacts: string | null
  base: string | null
  rows: Row[]
}

const HEADER = /^\*\*(Codename|Title|Branch|Bump|Artifacts|Base)\*\*: *(.*)$/
// The row shape close's own grep reads: `| NN | title | status | milestone |`.
const ROW = /^\| *([0-9]+) *\|([^|]*)\| *([a-z]+) *\|([^|]*)\|/
export const STATUSES = ['todo', 'doing', 'done'] as const

export function parseState(text: string): State {
  const state: State = { codename: null, title: null, branch: null, bump: null, artifacts: null, base: null, rows: [] }
  for (const line of text.split('\n')) {
    const header = HEADER.exec(line)
    if (header) {
      const key = header[1].toLowerCase() as 'codename' | 'title' | 'branch' | 'bump' | 'artifacts' | 'base'
      state[key] = header[2].trim()
      continue
    }
    const row = ROW.exec(line)
    if (row) state.rows.push({ phase: row[1], title: row[2].trim(), status: row[3], milestone: row[4].trim() })
  }
  return state
}

// The phase to run: the first row whose status is not done.
export function nextRow(rows: readonly Row[]): Row | null {
  return rows.find(row => row.status !== 'done') ?? null
}

// `3`, `03` and `003` all name row 03: the number is written on two digits.
export function twoDigits(phase: string | number): string | null {
  const text = String(phase).trim()
  if (!/^[0-9]+$/.test(text)) return null
  return String(Number(text)).padStart(2, '0')
}

// One row rewritten in place, every other line of the file untouched. A todo
// row leaves the milestone empty, whatever was asked.
export function markRow(text: string, phase: string | number, status: string, milestone: string):
{ text: string; row: Row } | { error: string } {
  const wanted = twoDigits(phase)
  if (wanted === null) return { error: `not a phase number: ${phase}` }
  if (!(STATUSES as readonly string[]).includes(status)) return { error: `status must be todo, doing or done, not ${status}` }
  if (status !== 'todo' && !/^[0-9a-f]{4,40}$/.test(milestone)) return { error: `a ${status} row needs a commit sha as its milestone, not "${milestone}"` }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const found = ROW.exec(lines[i])
    if (!found || twoDigits(found[1]) !== wanted) continue
    const row: Row = { phase: found[1], title: found[2].trim(), status, milestone: status === 'todo' ? '' : milestone }
    lines[i] = `| ${row.phase} | ${row.title} | ${row.status} | ${row.milestone} |`
    return { text: lines.join('\n'), row }
  }
  return { error: `no row ${wanted} in the state table` }
}

// ── The branch, the mode, the ignore guard ───────────────────────────────────

// `${BRANCH#*/}`: everything after the first slash, the whole name without one.
export function codenameOf(branch: string): string {
  const slash = branch.indexOf('/')
  return slash < 0 ? branch : branch.slice(slash + 1)
}

// The skills' one-liner: `artifacts` from .implement.json, `local` when the
// file is absent. Only `committed` changes anything, so any other value reads
// as local, exactly as the skills' `[ "$MODE" = committed ]` reads it.
export function modeOf(implementJson: string | null): 'local' | 'committed' {
  if (implementJson === null) return 'local'
  try {
    const parsed = JSON.parse(implementJson)
    return parsed && typeof parsed === 'object' && parsed.artifacts === 'committed' ? 'committed' : 'local'
  } catch {
    return 'local'
  }
}

export const LOCAL_NOT_IGNORED = 'docs/features and ROADMAP.md must be ignored in local mode: add them to the excludes, or set artifacts to committed in .implement.json'
export const COMMITTED_IGNORED = 'docs/features and ROADMAP.md must not be ignored in committed mode'
export const GUARD_SKIPPED = 'artifacts path given, ignore guard skipped'

// The skills' guard block, verbatim: an explicit path skips it, committed mode
// inverts it, local mode wants both paths ignored. `ok` when it passes.
export function ignoreVerdict(mode: 'local' | 'committed', docsGiven: boolean, docsIgnored: boolean, roadmapIgnored: boolean): string {
  if (docsGiven) return GUARD_SKIPPED
  if (mode === 'committed') return docsIgnored || roadmapIgnored ? COMMITTED_IGNORED : 'ok'
  return !docsIgnored || !roadmapIgnored ? LOCAL_NOT_IGNORED : 'ok'
}

// ── The preflight ────────────────────────────────────────────────────────────

// scripts/preflight.sh's two checks and its exact lines: every required plugin
// set to true in the merged enabledPlugins, then a repository on a branch.
export function preflightLines(enabledPlugins: unknown, repo: { inside: boolean; branch: string }): string[] {
  const enabled = enabledPlugins && typeof enabledPlugins === 'object' ? enabledPlugins as Record<string, unknown> : {}
  const lines: string[] = []
  for (const dep of REQUIRED_PLUGINS) {
    if (enabled[dep] === true) continue
    lines.push(`error: required plugin not installed or not enabled: ${dep}`)
    lines.push(`fix:   /plugin install ${dep}   then enable it in /plugin`)
  }
  if (lines.length > 0) return lines
  if (!repo.inside || repo.branch === '') {
    return ['error: not a git repository with a current branch', 'fix:   run this from inside a git repository, on a branch']
  }
  return []
}

// What /implement:install and /implement:doctor print.
export function doctorText(lines: readonly string[], branch: string): string {
  if (lines.length > 0) return lines.join('\n')
  return `ready: ${REQUIRED_PLUGINS.join(', ')} enabled, git repository on ${branch}`
}

export const PREFLIGHT_PASSED = 'Preflight: passed'

// The skill text as the model reads it: the stop when the preflight failed, the
// verdict and the derived state ahead of the skill's own text when it passed.
export function skillText(original: string, lines: readonly string[], stateLine: string | null): string {
  if (lines.length > 0) {
    return [
      'Preflight: failed, so this skill does not run. Print these lines to the user verbatim and do nothing else:',
      '',
      ...lines,
    ].join('\n')
  }
  const header = [`${PREFLIGHT_PASSED}, checked before this text was loaded: do not run scripts/preflight.sh.`]
  if (stateLine) header.push(stateLine)
  return `${header.join('\n')}\n\n${original}`
}

export type Snapshot = {
  branch: string
  codename: string
  docs: string
  mode: 'local' | 'committed'
  guard: string
  head: string
  clean: boolean
  stateFile: 'present' | 'absent'
  state: State | null
  next: Row | null
}

// The state as one line ahead of a skill's text. Derived from the branch: a
// --docs path changes it, and that is the state tool's to answer.
export function stateLine(s: Snapshot): string {
  const parts = [
    `branch ${s.branch}`, `codename ${s.codename}`, `docs ${s.docs}`, `artifacts ${s.mode}`,
    `ignore guard ${s.guard}`, `head ${s.head}`, `tree ${s.clean ? 'clean' : 'dirty'}`,
  ]
  if (s.state) {
    parts.push(`bump ${s.state.bump ?? 'unset'}`, `base ${s.state.base ?? 'unset'}`)
    parts.push(s.next ? `next phase ${s.next.phase} ${s.next.status}${s.next.milestone ? ` (milestone ${s.next.milestone})` : ''}` : 'every phase done')
  } else {
    parts.push(`no IMPLEMENTATION.md under ${s.docs}`)
  }
  return `State, derived from the branch (a --docs path overrides it: ask the state tool with docs): ${parts.join(', ')}.`
}

// ── The shell reader ─────────────────────────────────────────────────────────

// The index of the `)` closing the `(` at `open`, quotes skipped.
function closingParen(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') { i++; continue }
    if (c === "'") { const j = src.indexOf("'", i + 1); i = j < 0 ? src.length : j; continue }
    if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '(') depth++
    if (c === ')' && --depth === 0) return i
  }
  return src.length
}

// The line index after every pending here-document body, from `at` (the start
// of the line that follows the operator's).
function skipHeredocs(src: string, at: number, pending: readonly { delim: string; strip: boolean }[]): number {
  let i = at
  for (const doc of pending) {
    while (i < src.length) {
      const end = src.indexOf('\n', i)
      const line = src.slice(i, end < 0 ? src.length : end)
      i = end < 0 ? src.length : end + 1
      if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break
    }
  }
  return i
}

// A shell line as its simple commands, each a list of words with the quotes
// removed. Quoted text never starts a command, a here-document body or a
// comment is no command at all, and $( ) and backticks are commands of their
// own wherever they stand, a double-quoted string included.
export function simpleCommands(src: string, depth = 0): string[][] {
  const out: string[][] = []
  if (depth > 8) return out
  let words: string[] = []
  let word = ''
  let inWord = false
  let pending: { delim: string; strip: boolean }[] = []
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false }
  const endCommand = () => { endWord(); if (words.length > 0) out.push(words); words = [] }
  const nested = (body: string) => { for (const c of simpleCommands(body, depth + 1)) out.push(c) }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      if (src[i + 1] !== '\n') { word += src[i + 1] ?? ''; inWord = true }
      i += 2
      continue
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      const end = j < 0 ? src.length : j
      word += src.slice(i + 1, end); inWord = true; i = end + 1
      continue
    }
    if (c === '"') {
      inWord = true
      for (i++; i < src.length && src[i] !== '"';) {
        if (src[i] === '\\' && i + 1 < src.length) { word += src[i + 1]; i += 2; continue }
        if (src[i] === '$' && src[i + 1] === '(') { const end = closingParen(src, i + 1); nested(src.slice(i + 2, end)); i = end + 1; continue }
        if (src[i] === '`') { const j = src.indexOf('`', i + 1); const end = j < 0 ? src.length : j; nested(src.slice(i + 1, end)); i = end + 1; continue }
        word += src[i]; i++
      }
      i++
      continue
    }
    if (c === '$' && src[i + 1] === '(') {
      const end = closingParen(src, i + 1)
      nested(src.slice(i + 2, end)); inWord = true; i = end + 1
      continue
    }
    if (c === '`') {
      const j = src.indexOf('`', i + 1)
      const end = j < 0 ? src.length : j
      nested(src.slice(i + 1, end)); inWord = true; i = end + 1
      continue
    }
    if (c === '#' && !inWord) {
      const j = src.indexOf('\n', i)
      i = j < 0 ? src.length : j
      continue
    }
    if (c === '\n') {
      endCommand(); i++
      if (pending.length > 0) { i = skipHeredocs(src, i, pending); pending = [] }
      continue
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      endWord()
      let k = i + 2
      let strip = false
      if (src[k] === '-') { strip = true; k++ }
      while (src[k] === ' ' || src[k] === '\t') k++
      let delim = ''
      while (k < src.length && !/[\s;&|<>()]/.test(src[k])) {
        if (src[k] === "'" || src[k] === '"') {
          const j = src.indexOf(src[k], k + 1)
          const end = j < 0 ? src.length : j
          delim += src.slice(k + 1, end); k = end + 1
        } else if (src[k] === '\\') { delim += src[k + 1] ?? ''; k += 2 } else { delim += src[k]; k++ }
      }
      if (delim !== '') pending.push({ delim, strip })
      i = k
      continue
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') { endCommand(); i++; continue }
    if (c === ' ' || c === '\t' || c === '<' || c === '>') { endWord(); i++; continue }
    word += c; inWord = true; i++
  }
  endCommand()
  return out
}

// What a line does that a guard reads: an outward action, or a write to the
// index or the history.
export type Action = 'push' | 'merge' | 'pr-create' | 'pr-merge' | 'stage' | 'commit'

const PREFIXES = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'time', 'rtk', 'nice', 'env', 'xargs',
  'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'])
const base = (word: string) => word.slice(word.lastIndexOf('/') + 1)

function actionsOf(words: readonly string[], depth: number): Action[] {
  let w = [...words]
  // Assignments and the words that only run what follows them.
  for (;;) {
    if (w.length === 0) return []
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) { w = w.slice(1); continue }
    if (PREFIXES.has(base(w[0]))) {
      w = w.slice(1)
      while (w.length > 0 && w[0].startsWith('-')) w = w.slice(1)
      continue
    }
    break
  }
  const head = base(w[0])
  if (SHELLS.has(head)) {
    const flag = w.findIndex((word, k) => k > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word))
    return flag > 0 && w[flag + 1] !== undefined ? shellActions(w[flag + 1], depth + 1) : []
  }
  if (head === 'eval') return shellActions(w.slice(1).join(' '), depth + 1)
  if (head === 'git') {
    let k = 1
    while (k < w.length && w[k].startsWith('-')) k += GIT_OPTIONS_WITH_VALUE.has(w[k]) ? 2 : 1
    switch (w[k]) {
      case 'push': return ['push']
      case 'merge': return ['merge']
      case 'add': return ['stage']
      case 'commit': return ['commit']
      default: return []
    }
  }
  if (head === 'gh') {
    let k = 1
    while (k < w.length && w[k].startsWith('-')) k += w[k] === '-R' || w[k] === '--repo' ? 2 : 1
    if (w[k] !== 'pr') return []
    if (w[k + 1] === 'create' || w[k + 1] === 'new') return ['pr-create']
    if (w[k + 1] === 'merge') return ['pr-merge']
  }
  return []
}

export function shellActions(command: string, depth = 0): Action[] {
  if (depth > 8) return []
  return simpleCommands(command, depth).flatMap(words => actionsOf(words, depth))
}

// ── The guards ───────────────────────────────────────────────────────────────

// What is armed. `outer` is the implement skill last started, and holds until
// another one starts, the conversation ends or is cleared, a turn is aborted or
// the user releases it: a phase stopped on a question resumes on the next
// prompt under the same rules. `checking` is implement:check's own, and ends
// with its verdict, its turn, or the user's words. `typed` is the user's last
// prompt.
export type Guard = { outer: 'feature' | 'prepare' | 'phase' | 'close' | null; checking: boolean; typed: string }
export const IDLE: Guard = { outer: null, checking: false, typed: '' }

// The user's last prompt is kept across the start: a prompt that asks for the
// push and names the skill in one breath arms the skill after it was read.
export function armedBy(g: Guard, skill: SkillName): Guard {
  if (skill === 'check') return { ...g, checking: true }
  return { outer: skill, checking: false, typed: g.typed }
}

// The origins a person types from: the terminal, the remote bridge, and the
// caller of a headless run. A notification, a peer and a plugin are not them.
export function typedByUser(kind: string): boolean {
  return kind === 'composer' || kind === 'bridge' || kind === 'sdk'
}

// The user's words end a check in flight, unless the words are the slash
// command that started it.
export function onTyped(g: Guard, text: string): Guard {
  return { ...g, typed: text, checking: g.checking && text.trimStart().startsWith('/') }
}

// An interrupted turn releases everything; any other end of a turn ends the
// check, which is a one-turn skill.
export function onTurnEnd(g: Guard, aborted: boolean): Guard {
  return aborted ? IDLE : { ...g, checking: false }
}

const VERDICT_TABLE = /^\| *check *\| *evidence *\| *result *\|/m
const VERDICT_LINE = /^(PASS|FAIL: *[0-9][0-9, ]*)[ \t]*$/m

// implement:check is over once its table and its verdict line are written.
export function isVerdict(answer: string): boolean {
  return VERDICT_TABLE.test(answer) && VERDICT_LINE.test(answer)
}

// The user's own words that release one refusal: the action named in plain
// words or by its command.
const ASKED: Record<Action | 'agent', RegExp> = {
  'push': /\bpush/i,
  'merge': /\bmerg/i,
  'pr-create': /\b(pull request|PR|pr-create)s?\b/i,
  'pr-merge': /\bmerg/i,
  'stage': /\b(stage|commit)/i,
  'commit': /\bcommit/i,
  'agent': /\b(sub-?)?agents?\b/i,
}
export function userAsked(what: Action | 'agent', typed: string): boolean {
  return ASKED[what].test(typed)
}

const LABEL: Record<Action, string> = {
  'push': 'git push', 'merge': 'git merge', 'pr-create': 'opening a pull request',
  'pr-merge': 'merging a pull request', 'stage': 'git add', 'commit': 'git commit',
}
export const OUTWARD: readonly Action[] = ['push', 'merge', 'pr-create', 'pr-merge']
const RELEASE = 'The user releases it by asking for it in a prompt, or with /implement:release-guard.'
export const UNREAD = 'The implement guard could not read whether a phase or a close is running, so this outward action is refused. The user can run it himself, or release the guard with /implement:release-guard.'

export function outwardDeny(skill: 'phase' | 'close', action: Action): string {
  return `implement:${skill} stops at the branch: ${LABEL[action]} is the user's to do, refused by the implement plugin. Name it in your report and wait. ${RELEASE}`
}
export function checkDeny(what: string): string {
  return `implement:check edits, stages and commits nothing: ${what} refused by the implement plugin. Name the defect as a FAIL row; the repair belongs to the caller once the verdict line (PASS, or FAIL: <rows>) is written under the table. ${RELEASE}`
}
export function agentDeny(type: string): string {
  return `implement:phase writes the work itself: a subagent only searches (subagent_type Explore). ${type} refused by the implement plugin: do the work inline, or name the need and wait. ${RELEASE}`
}

const OUTWARD_SKILLS = new Set(['phase', 'close'])
export const READ_ONLY_AGENTS = new Set(['Explore'])

export function bashDecision(g: Guard, command: string): string | null {
  const actions = shellActions(command)
  if (g.checking) {
    const write = actions.find(a => a === 'stage' || a === 'commit')
    if (write) return checkDeny(LABEL[write])
  }
  if (g.outer !== null && OUTWARD_SKILLS.has(g.outer)) {
    const out = actions.find(a => OUTWARD.includes(a) && !userAsked(a, g.typed))
    if (out) return outwardDeny(g.outer as 'phase' | 'close', out)
  }
  return null
}

// The github plugin's tool, by its own subcommand names.
export function githubDecision(g: Guard, command: string): string | null {
  if (g.outer === null || !OUTWARD_SKILLS.has(g.outer)) return null
  const action: Action | null = command === 'pr-create' ? 'pr-create' : command === 'pr-merge' ? 'pr-merge' : null
  if (action === null || userAsked(action, g.typed)) return null
  return outwardDeny(g.outer as 'phase' | 'close', action)
}

export function agentDecision(g: Guard, subagentType: unknown): string | null {
  if (g.outer !== 'phase') return null
  const type = typeof subagentType === 'string' && subagentType !== '' ? subagentType : 'general-purpose'
  if (READ_ONLY_AGENTS.has(type) || userAsked('agent', g.typed)) return null
  return agentDeny(type)
}

export function editDecision(g: Guard, tool: string): string | null {
  return g.checking ? checkDeny(tool) : null
}

// The commit trailer the engine asks for: none while a skill that commits runs.
export function silencesAttribution(g: Guard): boolean {
  return g.outer === 'feature' || g.outer === 'phase' || g.outer === 'close'
}

// ── The band ─────────────────────────────────────────────────────────────────

export type Band = { codename: string; phase: string; of: number; status: string; title: string; milestone: string; head: string }

export function bandOf(s: Snapshot): Band | null {
  if (!s.state || s.state.rows.length === 0) return null
  const current = s.next ?? s.state.rows[s.state.rows.length - 1]
  return {
    codename: s.codename, phase: current.phase, of: s.state.rows.length, status: current.status,
    title: current.title, milestone: current.milestone, head: s.head,
  }
}

export function bandLine(b: Band, columns: number): string {
  const total = String(b.of).padStart(2, '0')
  const parts = [
    `implement:phase ${b.codename}`,
    b.status === 'done' ? `all ${total} phases done, implement:close is next` : `phase ${b.phase}/${total} ${b.status}: ${b.title}`,
    ...(b.status !== 'done' && b.milestone ? [`base ${b.milestone}`] : []),
    `head ${b.head}`,
  ]
  const line = parts.join(' · ')
  return line.length <= columns ? line : `${line.slice(0, Math.max(1, columns - 1))}…`
}
