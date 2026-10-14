// hooks/core.ts
// The module's pure half: no `$` here. The engine fences `$` to the file whose
// hook received it, so the handlers (start.ts, tool.ts, guard.ts) hold it and
// call these functions with plain values.

// --- /bugs-bot:start ---------------------------------------------------------

// The orchestrator release whose launcher knows `spawn --resident`.
export const MIN_ORCHESTRATOR = '0.46.1'

// The iTerm launcher, under the orchestrator's install directory.
export const ITERM_SCRIPT = 'skills/iterm-agents/scripts/iterm-agent.sh'

// How long a spawn may take: the launcher waits up to 30 s for the host CLI on
// the new tty, and the app itself answers in a few seconds.
export const SPAWN_TIMEOUT_MS = 120_000

// Every other child of the start: the CLI's own commands and the launcher's
// list, move and verify.
export const STEP_TIMEOUT_MS = 60_000

export type Session = { name: string; ref: string; full: string }

/*
 * The first line of ListAgents names the caller: « This session is <name>
 * [<ref>] — the name other sessions use to message it … ». The peers follow,
 * one row each: « <name> [<ref>]  ·  interactive  ·  busy  ·  started 1h ago ».
 */
export function selfOf(listing: string): Session | null {
  const first = listing.split('\n', 1)[0] ?? ''
  const m = first.match(/^This session is (.+?) \[([\w-]{1,20})\](?: —|$)/)
  if (!m) return null
  return { name: m[1].trim(), ref: m[2], full: `${m[1].trim()} [${m[2]}]` }
}

export function peersOf(listing: string): Session[] {
  const peers: Session[] = []
  for (const line of listing.split('\n').slice(1)) {
    const m = line.match(/^\s+(.+?) \[([\w-]{1,20})\](?:\s+·|\s*$)/)
    if (m) peers.push({ name: m[1].trim(), ref: m[2], full: `${m[1].trim()} [${m[2]}]` })
  }
  return peers
}

// A live row « named as agent_title (or a variant of it) »: the same words, case
// and spacing aside, or the title followed by more words (a host suffix).
export function isAgentRow(name: string, agentTitle: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const n = norm(name)
  const t = norm(agentTitle)
  return t !== '' && (n === t || n.startsWith(t + ' '))
}

// The leading x.y.z of a version, `0.49.1-2afa38391c2b` read as 0.49.1.
export function versionParts(version: string): number[] | null {
  const m = String(version).trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

export function versionAtLeast(version: string, min: string): boolean {
  const v = versionParts(version)
  const w = versionParts(min)
  if (!v || !w) return false
  for (let i = 0; i < 3; i++) {
    if (v[i] !== w[i]) return v[i] > w[i]
  }
  return true
}

// The last non-empty line of a child's output: the spawn's tty, the prompt's path.
export function lastLine(text: string): string {
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  return lines.length > 0 ? lines[lines.length - 1] : ''
}

export function isTty(text: string): boolean {
  return /^\/dev\/ttys\d{1,4}$/.test(text)
}

/*
 * The launcher's list: `w<window>/t<tab> | <tty> | <title> | <name>[ | self][ | hidden]`.
 * The new tab sits right of its launcher when it is the next tab of the same window.
 */
export type TabRow = { window: number; tab: number; tty: string; isSelf: boolean }

export function tabRows(listing: string): TabRow[] {
  const rows: TabRow[] = []
  for (const line of listing.split('\n')) {
    const cells = line.split(' | ').map(c => c.trim())
    const at = (cells[0] ?? '').match(/^w(\d+)\/t(\d+)$/)
    if (!at || cells.length < 2) continue
    rows.push({ window: Number(at[1]), tab: Number(at[2]), tty: cells[1], isSelf: cells.slice(2).includes('self') })
  }
  return rows
}

export function sitsRightOfSelf(listing: string, tty: string): boolean {
  const rows = tabRows(listing)
  const self = rows.find(r => r.isSelf)
  const tab = rows.find(r => r.tty === tty)
  return Boolean(self && tab && tab.window === self.window && tab.tab === self.tab + 1)
}

// The project file the CLI finds: `.bugs-bot.json` in the directory or a parent.
export const PROJECT_FILE = '.bugs-bot.json'

export function parentsOf(dir: string): string[] {
  const out: string[] = []
  let d = dir.replace(/\/+$/, '') || '/'
  for (;;) {
    out.push(d)
    if (d === '/' || d === '') break
    const up = d.slice(0, d.lastIndexOf('/')) || '/'
    if (up === d) break
    d = up
  }
  return out
}

export type ProjectFacts = { project: string; agentTitle: string; deployUrl: string | null }

export function projectFacts(text: string): ProjectFacts | null {
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object') return null
    const project = typeof data.project === 'string' ? data.project : ''
    const agentTitle = typeof data.agent_title === 'string' ? data.agent_title : ''
    if (!project || !agentTitle) return null
    return { project, agentTitle, deployUrl: typeof data.deploy_url === 'string' && data.deploy_url ? data.deploy_url : null }
  } catch {
    return null
  }
}

// --- the bugs tool --------------------------------------------------------------

export const TOOL_NAME = 'bugs'
export const TOOL = 'mcp__bugs-bot__bugs'

/*
 * The CLI commands the tool runs. `wait` is not one: it blocks up to 55 minutes
 * and stays a background Bash call. `pull`, `init`, `remove`, `doctor`, `install`
 * and `token` are the operator's and the machine's, never an agent's.
 */
export const TOOL_COMMANDS = [
  'list', 'show', 'reply', 'edit', 'delete', 'fixed', 'taken', 'done', 'triage',
  'pending', 'overdue', 'escalated', 'unask', 'post', 'backfill-authors',
  'person', 'person-note', 'person-lang', 'agent-prompt', 'gate', 'deployed',
  'handover', 'plugin-path',
]

// The commands that only read the project's data. Any other one writes, to the
// group or to the reports; a command missing here is a write, the safe side.
export const READS = new Set(['list', 'show', 'pending', 'overdue', 'person', 'plugin-path', 'deployed'])

// A write without a grant takes as long as the person needs to answer: the
// CLI's own run is bounded by the image uploads and the deploy check.
export const TOOL_TIMEOUT_MS = 300_000

/*
 * Where bin/setup remembers the interpreter it found or installed: `python` in the bugs home
 * (`BUGS_BOT_HOME`, else `~/.bugs-bot`), as the fixed launcher reads it.
 */
export function pythonFile(bugsHome: string | undefined, home: string): string {
  return `${(bugsHome || `${home}/.bugs-bot`).replace(/\/+$/, '')}/python`
}

// The remembered interpreter, its file's first line; none (or an empty file) leaves python3.
export function chosenPython(remembered: string | null): string {
  return (remembered ?? '').split('\n')[0].trim() || 'python3'
}

export function toolArgv(python: string, root: string, command: string, args: readonly string[]): string[] {
  return [python, `${root.replace(/\/+$/, '')}/bin/bugs-bot`, command, ...args]
}

// The arguments must be a list of strings: no shell ever reads them.
export function argsOf(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return null
  return raw.every(a => typeof a === 'string') ? (raw as string[]) : null
}

/*
 * `gate --measure` measured in-process: the session's own figures replace the
 * orchestrator's measure file, passed as `--tokens` and `--window`. Without
 * a figure (no answer yet) the arguments are kept, and the CLI reads the file.
 */
export function measuredGateArgs(args: readonly string[], tokens: number | undefined, window: number | undefined): string[] | null {
  if (!args.includes('--measure')) return null
  if (!Number.isInteger(tokens) || !Number.isInteger(window) || (window as number) <= 0) return null
  return [...args.filter(a => a !== '--measure'), '--tokens', String(tokens), '--window', String(window)]
}

export function toolText(stdout: string, stderr: string, exitCode: number): string {
  const parts = [String(stdout ?? '').trimEnd(), String(stderr ?? '').trimEnd()].filter(Boolean)
  if (exitCode !== 0) parts.push(`exit=${exitCode}`)
  return parts.join('\n') || '(no output)'
}

// --- the guard ------------------------------------------------------------------

/*
 * Shell words of a command line, quotes removed, with what a guard needs beside
 * them: where an unquoted control operator splits the line, and whether a word
 * holds an expansion the guard cannot read (`$(…)`, a backquote, `$NAME`).
 * Null when the quotes do not balance.
 */
export type Word = { text: string; isDynamic: boolean; isOperator: boolean }

export function shellWords(line: string): Word[] | null {
  const words: Word[] = []
  let cur = ''
  let inWord = false
  let dynamic = false
  const push = () => {
    if (inWord) words.push({ text: cur, isDynamic: dynamic, isOperator: false })
    cur = ''
    inWord = false
    dynamic = false
  }
  const expands = (i: number) => line[i] === '`' || (line[i] === '$' && /[({A-Za-z_]/.test(line[i + 1] ?? ''))
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      if (end < 0) return null
      cur += line.slice(i + 1, end)
      inWord = true
      i = end + 1
    } else if (c === '"') {
      i += 1
      for (;;) {
        if (i >= line.length) return null
        const d = line[i]
        if (d === '"') { i += 1; break }
        if (d === '\\' && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1])) { cur += line[i + 1]; i += 2; continue }
        if (expands(i)) dynamic = true
        cur += d
        i += 1
      }
      inWord = true
    } else if (c === '\\') {
      if (i + 1 < line.length) cur += line[i + 1]
      inWord = true
      i += 2
    } else if (/\s/.test(c) && c !== '\n') {
      push()
      i += 1
    } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      push()
      words.push({ text: c, isDynamic: false, isOperator: true })
      i += 1
    } else {
      if (expands(i)) dynamic = true
      cur += c
      inWord = true
      i += 1
    }
  }
  push()
  return words
}

// The commands whose words reach the group: the text of `reply`, `edit` and
// `post`, and the `--reason` of `done`, posted as a reply.
export const POSTING = new Set(['reply', 'edit', 'post', 'done'])

// Options whose value is a local reference, never posted.
const UNPOSTED_VALUES = new Set(['--image', '--project', '--reply', '--note'])

/*
 * The words a bugs-bot call would post, from its arguments after the command.
 * Every word but option names and the values of UNPOSTED_VALUES is read: the
 * report ids among them carry no letter and pass every rule.
 */
export function postedWords(command: string, args: readonly Word[]): Word[] {
  if (!POSTING.has(command)) return []
  if (command === 'done' && !args.some(a => a.text === '--reason' || a.text.startsWith('--reason='))) return []
  const out: Word[] = []
  for (let i = 0; i < args.length; i++) {
    const w = args[i]
    if (w.text.startsWith('--')) {
      const eq = w.text.indexOf('=')
      if (eq > 0) {
        if (!UNPOSTED_VALUES.has(w.text.slice(0, eq))) out.push({ ...w, text: w.text.slice(eq + 1) })
      } else if (UNPOSTED_VALUES.has(w.text)) {
        i += 1
      }
      continue
    }
    out.push(w)
  }
  return out
}

export type Call = { command: string; args: Word[] }

// Each bugs-bot call of a Bash line: a word named `bugs-bot` (or a path ending
// in it), the next word its command, up to the next control operator.
export function bugsCalls(words: readonly Word[]): Call[] {
  const calls: Call[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w.isOperator || !/(^|\/)bugs-bot$/.test(w.text)) continue
    const next = words[i + 1]
    if (!next || next.isOperator) continue
    const args: Word[] = []
    for (let j = i + 2; j < words.length && !words[j].isOperator; j++) args.push(words[j])
    calls.push({ command: next.text, args })
  }
  return calls
}

/*
 * What may not reach a tester (SKILL.md « Talking to a reporter » rule 5, the
 * never-revealed list of AGENT.md): a PR or issue number, a commit hash, a
 * branch, a local path, a URL on any host but the deployment's.
 *
 * Each finding is the token as written, so the person can release it by typing
 * it, and the reason says which rule it broke.
 */
export type Leak = { token: string; rule: string }

const BRANCH = /(?:^|[\s("'«])((?:feat|feature|fix|hotfix|bugfix|chore|refactor|docs|test|perf|build|ci|style|release)\/[\w.\-/]+)/gi
const URL = /\b(?:https?|wss?|ftp):\/\/[^\s<>"'«»)]+/gi
const PATH = /(?:^|[\s("'«=:])((?:~|\/Users|\/home|\/private|\/var\/folders|\/opt|\/etc)\/[^\s"'«»)]*)/g
const ISSUE = /(?:^|[^\w&])(#\d+)\b/g
const HEX = /\b([0-9a-f]{7,40})\b/gi
const LOCAL_HOST = /\b(localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?|(?:\d{1,3}\.){3}\d{1,3}:\d+)\b/gi

export function hostOf(url: string): string | null {
  const m = String(url).match(/^[a-z]+:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i)
  return m ? m[1].toLowerCase() : null
}

export function leaksOf(text: string, deployUrl: string | null): Leak[] {
  const found: Leak[] = []
  const allowed = deployUrl ? hostOf(deployUrl) : null
  // URLs first, then read out of the text: a path or a hash inside the
  // deployment's own address is not a second finding.
  let rest = text
  for (const m of text.matchAll(URL)) {
    const url = m[0].replace(/[.,;:!?]+$/, '')
    if (!allowed || hostOf(url) !== allowed) found.push({ token: url, rule: 'a link to a host other than the deployment URL' })
    rest = rest.replace(m[0], ' ')
  }
  for (const m of rest.matchAll(LOCAL_HOST)) found.push({ token: m[1], rule: 'a local host or address' })
  for (const m of rest.matchAll(PATH)) found.push({ token: m[1], rule: 'a path of the machine' })
  for (const m of rest.matchAll(BRANCH)) found.push({ token: m[1], rule: 'a branch name' })
  for (const m of rest.matchAll(ISSUE)) found.push({ token: m[1], rule: 'a PR or ticket number' })
  for (const m of rest.matchAll(HEX)) {
    // A hash mixes digits and letters: a plain number (a date, a count) and a
    // plain word (« effaced ») are neither.
    if (/\d/.test(m[1]) && /[a-f]/i.test(m[1])) found.push({ token: m[1], rule: 'a commit hash' })
  }
  return found
}

// The person's own typed words release a finding they contain: they asked for it.
export function unreleased(leaks: readonly Leak[], typed: string | null): Leak[] {
  if (!typed) return [...leaks]
  return leaks.filter(l => !typed.includes(l.token))
}

export function leakDenial(leaks: readonly Leak[]): string {
  const listed = leaks.slice(0, 5).map(l => `« ${l.token} » (${l.rule})`).join(', ')
  return `bugs-bot guard: this text would reach the testers with ${listed}. No PR number, commit, branch, ticket id, `
    + 'local path or host but the deployment URL is ever posted in the group: say what changed for them in a sentence, '
    + 'and send it again. A token the operator typed himself in this session passes.'
}

export const DYNAMIC_DENIAL = 'bugs-bot guard: a text posted to the group is written out literally, never through '
  + '`$(…)`, a backquote or a variable: the guard reads every word before it is posted. Write the text itself in quotes.'

// The prompt kinds the person typed: at the terminal, or through the bridge.
// A peer's delivery or a notification is never their word.
export function typedByPerson(kind: string): boolean {
  return kind === 'composer' || kind === 'bridge'
}

/*
 * The token file: `BUGS_BOT_ENV_FILE`, else `.env` of the bugs home
 * (`BUGS_BOT_HOME`, else `~/.bugs-bot`), as envfile.py resolves it.
 */
export function tokenFile(envFile: string | undefined, bugsHome: string | undefined, home: string): string {
  if (envFile) return envFile
  return `${(bugsHome || `${home}/.bugs-bot`).replace(/\/+$/, '')}/.env`
}

export const TOKEN_DENIAL = 'bugs-bot guard: the bot token file is read by the bugs-bot tool alone, never by a session: '
  + 'its value is never printed, copied or shown. `bugs-bot doctor` says whether the token is there and valid.'

// A Bash line that names the token file: its path as resolved, its spelling under
// the home directory, or `.env` beside a word naming the bugs home.
export function bashNamesTokenFile(command: string, file: string, home: string): boolean {
  if (file && command.includes(file)) return true
  if (home && file.startsWith(home + '/') && command.includes('~' + file.slice(home.length))) return true
  if (/BUGS_BOT_ENV_FILE/.test(command)) return true
  if (/\.bugs-bot\/\.env\b/.test(command)) return true
  return /\.bugs-bot\b/.test(command) && /(^|[\s/'"])\.env\b/.test(command)
}

export function typedNamesTokenFile(typed: string | null): boolean {
  return Boolean(typed && /\.env\b/.test(typed))
}
