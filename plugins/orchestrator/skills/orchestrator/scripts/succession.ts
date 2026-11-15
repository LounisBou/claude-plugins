// succession — the takeover, read from the state alone (decision 0007).
//
//   succession.sh takeover <dispatch record> --mode build|investigate [--tty <predecessor's tty>] [--name "<Orch: x>"] [--session <id>] [--worktree <dir>]
//
// One owner per fact: the dispatch record's rows hold the work (state, blocker, note, verdict line),
// the to-do list holds the operator's words and the rows each item turned into, the rulings file
// holds his rulings, the goals file the spec it names; agents, pull requests and checkouts are read
// live. So no succession brief is written: the successor runs this command, which prints the fixed
// instructions of `templates/orchestrator-succession-brief.md` filled from those files, then the
// Live state, and nothing of it lands in a file.
//
// The Live state: the open rows at level 1; their owners, an open row's live agent by its label
// word, « ruling » for a deferred one, else its blocker checked on its artifact (the pull request
// merged, the row closed, the release installed): fallen and with no agent, READY NOT STARTED; an
// open row with no blocker recorded reads NO OWNER; the record's pull request ledger; the deck's
// agents of this orchestration; the round's open questions, verbatim; the to-do items pointing to a
// row closed or missing; the project sheet from `goals.md` (objective, spec, open goals and their plan)
// and the merged pull requests not installed.
//
// The orchestration's name is the record's owner (`<record>.owner`) unless given. Before printing,
// the command moves the rulings carried out or superseded, and those for rows the record closed, to
// the archive beside the rulings file (`prune.ts`), and the round's entries settled over a day ago
// (round-archive's rule): what a takeover reads is only what is live. Its measure goes to stderr.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readText } from '../../../core/store.ts'
import { configDir, type Env } from '../../../core/paths.ts'
import { openLine, orchForm, parseRecord, stateRoot, type Row } from './dispatch-record.ts'
import { ledgerLines, prKey, statusText } from '../../../core/pr-ledger.ts'
import { isEntry, processIo, type Io } from './lib/process.ts'
import { pruneFile, pruneRulings, readAtTakeover, type PruneResult } from './prune.ts'
import { goalsFileOf, ownerFileOf } from './lib/record-paths.ts'
import { archiveSettled } from './lib/round-archive.ts'
import { openTodos, todoItems, todoPath } from '../../../hooks/todo-format.ts'

export const USAGE =
  'usage: succession.sh takeover <dispatch record> --mode build|investigate [--tty <predecessor tty>] [--name "<Orch: x>"] [--session <id>] [--worktree <dir>]'

const here = dirname(fileURLToPath(import.meta.url))
/** The fixed text of the successor's instructions, in the plugin. */
export const TEMPLATE = join(here, '..', '..', '..', 'templates', 'orchestrator-succession-brief.md')

export interface Request {
  readonly record: string
  readonly mode: string
  readonly tty: string
  readonly name: string
  readonly session: string
  readonly worktree: string
}

/** The request the command line makes, or the reason it is refused. */
export function parseArgs(argv: readonly string[], cwd: string): Request | { readonly error: string } {
  const [command = '', record = '', ...rest] = argv
  if (command !== 'takeover' || record === '' || record.startsWith('--')) return { error: USAGE }
  const values: Record<string, string> = {}
  for (let k = 0; k < rest.length; k += 2) {
    const flag = rest[k] ?? ''
    const value = rest[k + 1]
    if (!['--mode', '--tty', '--name', '--session', '--worktree'].includes(flag)) return { error: `unknown argument: ${flag} (${USAGE})` }
    if (value === undefined) return { error: `${flag} needs a value` }
    values[flag.slice(2)] = value
  }
  const mode = values['mode'] ?? ''
  if (mode !== 'build' && mode !== 'investigate') return { error: '--mode build|investigate is required: the mode the successor was launched in' }
  return { record: resolve(cwd, record), mode, tty: values['tty'] ?? 'none', name: values['name'] ?? '', session: values['session'] ?? '', worktree: values['worktree'] ?? cwd }
}

/** One open question of the round, as the takeover prints it. */
export interface Question {
  readonly id: string
  readonly text: string
}

/** An open row, as the takeover reads it. */
export interface OpenRow {
  readonly id: string
  readonly line: string
  readonly label?: string
  readonly ruling?: string
  /** What the row waits on; undefined when none was recorded. */
  readonly blocker?: string
}

/** What the state holds open for this orchestrator. */
export interface OpenState {
  readonly rows: readonly OpenRow[]
  readonly prs: readonly string[]
  readonly agents: readonly string[]
  readonly questions: readonly Question[]
}

type Fields = Record<string, unknown>

function object(text: string | undefined): Fields | undefined {
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : undefined
  } catch {
    return undefined
  }
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

/** The deck's orchestrator of that name, local: its pull requests and its agents' names. */
export function deckOpen(deckText: string | undefined, name: string): { prs: string[]; agents: string[] } {
  const deck = object(deckText)
  const orchestrators = Array.isArray(deck?.['orchestrators']) ? (deck['orchestrators'] as unknown[]) : []
  for (const entry of orchestrators) {
    const orch = typeof entry === 'object' && entry !== null ? (entry as Fields) : {}
    if (orch['name'] !== name || (orch['machine'] ?? null) !== null) continue
    const agents = Array.isArray(orch['agents']) ? (orch['agents'] as unknown[]) : []
    return {
      prs: strings(orch['prs']),
      agents: agents.map(agent => (typeof agent === 'object' && agent !== null ? (agent as Fields)['name'] : undefined)).filter((n): n is string => typeof n === 'string'),
    }
  }
  return { prs: [], agents: [] }
}

/** A question asked with `ask` (hooks/question.ts, `v` 2) as its block reads, from its fields. */
export function askedText(entry: Fields): string {
  const choices = Array.isArray(entry['choices']) ? (entry['choices'] as unknown[]) : []
  const lettered = choices.flatMap(choice => {
    const c = typeof choice === 'object' && choice !== null ? (choice as Fields) : {}
    return typeof c['letter'] === 'string' && typeof c['text'] === 'string' ? [`- **${c['letter']}** : ${c['text']}`] : []
  })
  const why = typeof entry['why'] === 'string' ? entry['why'] : null
  const recommended = typeof entry['recommended'] === 'string' ? `${entry['recommended']} — ` : ''
  return [
    `_Subject_ : ${String(entry['subject'] ?? '')}`, `_Context_ : ${String(entry['context'] ?? '')}`, `_Question_ : ${String(entry['ask'] ?? '')}`,
    ...(lettered.length > 0 ? ['_Choices_ :', ...lettered] : []),
    ...(why !== null ? [`_Recommendation_ : ${recommended}${why}`] : []),
  ].join('\n')
}

/** The round's open operator questions of this orchestration: its sender's name, or this session; asked with `ask` or written by the relay. */
export function roundOpen(entries: readonly (Fields | undefined)[], name: string, session: string): Question[] {
  const senderOf = (entry: Fields): Fields => (typeof entry['sender'] === 'object' && entry['sender'] !== null ? (entry['sender'] as Fields) : {})
  return entries
    .filter((entry): entry is Fields => entry !== undefined && entry['status'] === 'open')
    .flatMap(entry => {
      if (entry['v'] === 2) {
        const sender = senderOf(entry)
        const ours = sender['name'] === name || (session !== '' && sender['session'] === session)
        return ours ? [{ id: String(entry['id']), text: askedText(entry) }] : []
      }
      const ours = entry['kind'] === 'operator' && (entry['from'] === name || (session !== '' && entry['session'] === session))
      return ours ? [{ id: String(entry['id']), text: typeof entry['question'] === 'string' ? entry['question'] : '' }] : []
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The open rows of a record's rows, as the takeover reads them. */
export function openRows(rows: readonly Row[]): OpenRow[] {
  return rows.filter(row => row['state'] === 'open').map(row => ({
    id: String(row['id']),
    line: openLine(row),
    label: String(row['label'] ?? ''),
    ruling: typeof row['deferred'] === 'string' ? row['deferred'] : '',
    ...(typeof row['blocker'] === 'string' ? { blocker: row['blocker'] } : {}),
  }))
}

/** Reads the state this orchestrator holds open from the files that keep it. */
export function readOpen(request: Request, env: Env): OpenState {
  const state = stateRoot(env)
  const recordText = readText(request.record) ?? ''
  // The ledger names each pull request it attends with its own repository: the deck lists numbers
  // whose repository it cannot tell, and a merged one lingers there. A ledger line leaves the record
  // when it is archived (the Stop hook, or `pr-archive`), so a pull request merged since may still show.
  const prs = ledgerLines(recordText).map(line => `${prKey(line.repo, line.pr)} ${statusText(line)}`)
  const { agents } = deckOpen(readText(join(state, 'deck.json')), request.name)
  const round = join(state, 'round')
  const names = existsSync(round) ? readdirSync(round).filter(name => name.endsWith('.json')).sort() : []
  return {
    rows: openRows(parseRecord(recordText)),
    prs,
    agents,
    questions: roundOpen(names.map(name => object(readText(join(round, name)))), request.name, request.session),
  }
}

const list = (items: readonly string[]): string => (items.length === 0 ? 'none' : items.join('; '))

const alnum = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Whether a blocker has fallen, read on its artifact: fallen, still standing, or not readable now. */
export type Fall = 'fallen' | 'standing' | 'unread'

/** The facts a blocker is checked against: the record's rows, a pull request's state on the forge, the installed copy. */
export interface Artifacts {
  readonly rows: readonly Row[]
  /** `MERGED`, `OPEN` or `CLOSED`; undefined when the forge cannot be read. */
  readonly prState: (repo: string, pr: number) => string | undefined
  /** `notInstalled`'s line: '' when it cannot be read. */
  readonly installed: () => string
}

/** A blocker checked on its artifact. */
export function fallOf(blocker: string, facts: Artifacts): Fall {
  if (blocker === 'none') return 'fallen'
  const row = /^row ([0-9]+) closed$/.exec(blocker)
  if (row) {
    const found = facts.rows.find(r => r['id'] === Number(row[1]))
    return found === undefined ? 'unread' : found['state'] === 'closed' ? 'fallen' : 'standing'
  }
  const pr = /^PR ([^#\s]+)#([0-9]+) merged$/.exec(blocker)
  if (pr) {
    const state = facts.prState(pr[1] ?? '', Number(pr[2]))
    return state === undefined ? 'unread' : state === 'MERGED' ? 'fallen' : 'standing'
  }
  if (blocker === 'release installed') {
    const line = facts.installed()
    return line === '' ? 'unread' : line.startsWith('0 ') ? 'fallen' : 'standing'
  }
  return 'unread'
}

/**
 * Who works each open row, from the facts the state holds: the agents of the deck carry the row's
 * label word as their name (`Agent: takeoverlean` for `TAKEOVERLEAN: …`, listed without its role
 * prefix). A deferred row reads « ruling »; a row with no agent reads its blocker checked on its
 * artifact: READY NOT STARTED once it has fallen, `blocked: <blocker>` while it stands, `blocker
 * unread: <blocker>` when its artifact cannot be read; a row with no blocker recorded reads NO OWNER.
 */
export function ownersOf(open: OpenState, fall: (blocker: string) => Fall = () => 'unread'): string[] {
  return open.rows.map(row => {
    if ((row.ruling ?? '') !== '') return `${row.id} ruling`
    const word = alnum(/^[A-Za-z0-9]+/.exec(row.label ?? '')?.[0] ?? '')
    const agent = word.length < 3 ? undefined : open.agents.find(name => {
      const own = alnum(name.replace(/^Agent:\s*/, ''))
      return own.length >= 3 && (own.startsWith(word) || word.startsWith(own))
    })
    if (agent !== undefined) return `${row.id} ${agent.replace(/^Agent:\s*/, '')}`
    if (row.blocker === undefined) return `${row.id} NO OWNER`
    const fell = fall(row.blocker)
    return `${row.id} ${fell === 'fallen' ? 'READY NOT STARTED' : fell === 'standing' ? `blocked: ${row.blocker}` : `blocker unread: ${row.blocker}`}`
  })
}

/** The open to-do items of the orchestration that point to a row the record closed or does not hold. */
export function todoStray(todoText: string, rows: readonly Row[]): string[] {
  return openTodos(todoItems(todoText)).flatMap(item => (item.rows ?? []).flatMap(id => {
    const row = rows.find(r => r['id'] === id)
    if (row === undefined) return [`to-do ${item.id} → row ${id} missing`]
    return row['state'] === 'closed' ? [`to-do ${item.id} → row ${id} closed`] : []
  }))
}

/**
 * The merged pull requests of the project's main that touch this plugin since the commit the
 * installed copy was built from, `<n> merged PRs not installed, oldest <h> h`: a git log against
 * the sha the host recorded for its install, read in the worktree on its local `origin/main`
 * (no fetch). Empty where any of it cannot be read: a line is said only when it is known.
 */
export function notInstalled(worktree: string, env: Env, now: Date): string {
  try {
    if (worktree === '' || worktree === 'none') return ''
    const installed = JSON.parse(readText(join(configDir(env), 'plugins', 'installed_plugins.json')) ?? '{}') as { plugins?: Record<string, { gitCommitSha?: unknown }[]> }
    const entry = Object.entries(installed.plugins ?? {}).find(([key]) => key.startsWith('orchestrator@'))?.[1]?.[0]
    const sha = typeof entry?.gitCommitSha === 'string' ? entry.gitCommitSha : ''
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return ''
    const dates = execFileSync('git', ['-C', worktree, 'log', '--first-parent', '-m', '--merges', '--format=%cI', `${sha}..origin/main`, '--', 'plugins/orchestrator'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).split('\n').filter(line => line !== '')
    if (dates.length === 0) return '0 merged PRs not installed'
    // The log walks the history, not the dates: the oldest merge is the earliest of them all.
    const times = dates.map(line => Date.parse(line))
    if (times.some(Number.isNaN)) return ''
    const oldest = Math.min(...times)
    return `${dates.length} merged PRs not installed, oldest ${Math.max(0, Math.round((now.getTime() - oldest) / 3_600_000))} h`
  } catch {
    return ''
  }
}

/** A pull request's state on the forge (`gh pr view`), undefined when it cannot be read. */
export function forgeState(env: Env): (repo: string, pr: number) => string | undefined {
  return (repo, pr) => {
    try {
      const state = execFileSync('gh', ['pr', 'view', String(pr), '-R', repo, '--json', 'state', '-q', '.state'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, env: { ...process.env, ...env },
      }).trim()
      return state === '' ? undefined : state
    } catch {
      return undefined
    }
  }
}

/** The goal rows of `goals.md` as their cells (`| G<n> | status | goal | plan | evidence |`). */
function goalRows(goals: string): string[][] {
  return goals.split('\n').filter(line => /^\| G[0-9]+ \|/.test(line)).map(line => line.split('|').map(cell => cell.trim()))
}

/** Whether `goals.md` holds a goal still `open`: the one case that asks for the goals' table. */
export function hasOpenGoal(goals: string | undefined): boolean {
  return goals !== undefined && goalRows(goals).some(cells => cells[2] === 'open')
}

/**
 * The project sheet from `goals.md`: the objective, the spec it names and the goals as one line,
 * `goals met=m/n open=none`, or `open=` the open ones with their plan.
 */
export function projectSheet(goals: string | undefined, installed: string): string {
  const parts: string[] = []
  if (goals === undefined) parts.push('no goals.md beside the record')
  else {
    const value = (key: string): string => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(goals)?.[1]?.trim() ?? ''
    const rows = goalRows(goals)
    const open = rows.filter(cells => cells[2] === 'open')
    parts.push(`objective ${value('aim') || 'none'}`, `spec ${value('spec') || 'none'}`)
    parts.push(`goals met=${rows.filter(cells => cells[2] === 'met').length}/${rows.length} open=${open.length === 0 ? 'none' : open.map(cells => `${cells[1]} (plan: ${cells[4] || 'none'})`).join(', ')}`)
  }
  if (installed !== '') parts.push(`installed: ${installed}`)
  return parts.join('; ')
}

/** The project a takeover names to `workspace.sh list`: the worktree's `origin` as `owner/name`, else the record's directory. */
export function projectOf(worktree: string, record: string): string {
  try {
    const url = execFileSync('git', ['-C', worktree, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
    const found = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1]
    if (found !== undefined) return found
  } catch {
    // No git, no origin: the record's directory names the project.
  }
  return basename(dirname(record))
}

/** The fixed instructions filled: each placeholder of the template by its value. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => values[key] ?? whole)
}

function prune(path: string, closed: ReadonlySet<number>, now: Date, io: Io): PruneResult {
  if (!existsSync(path)) return { moved: 0, before: 0, after: 0, warnings: [] }
  const result = pruneFile(path, (text, archive) => pruneRulings(text, archive, closed), now)
  for (const warning of result.warnings) io.err(`succession: ${path}: ${warning}\n`)
  return result
}

// The round's entries settled over a day ago, moved to its archive as `round-archive` moves them:
// a move that fails is said, and the takeover goes on.
function archiveRound(state: string, now: Date, io: Io): number {
  try {
    return archiveSettled(join(state, 'round'), now)
  } catch (error) {
    io.err(`succession: ${(error as Error).message}\n`)
    return 0
  }
}

export interface Deps {
  readonly cwd: string
  readonly now: () => Date
  readonly prState?: (repo: string, pr: number) => string | undefined
}

export function main(argv: readonly string[], env: Env, io: Io, deps: Deps = { cwd: process.cwd(), now: () => new Date() }): number {
  const parsed = parseArgs(argv, deps.cwd)
  if ('error' in parsed) {
    io.err(`succession: ${parsed.error}\n`)
    return 2
  }
  const recordText = readText(parsed.record)
  if (recordText === undefined) {
    io.err(`succession: no dispatch record at ${parsed.record}\n`)
    return 2
  }
  const name = orchForm(parsed.name || (readText(ownerFileOf(parsed.record)) ?? '').split('\n')[0]?.trim() || '')
  if (name === '') {
    io.err(`succession: ${ownerFileOf(parsed.record)} names no orchestration: pass --name "<Orch: x>"\n`)
    return 2
  }
  const template = readText(TEMPLATE)
  if (template === undefined) {
    io.err(`succession: the plugin's template ${TEMPLATE} cannot be read\n`)
    return 2
  }
  const now = deps.now()
  const all = parseRecord(recordText)
  const rulingsFile = join(dirname(parsed.record), 'rulings.md')
  const rulings = prune(rulingsFile, new Set(all.filter(row => row['state'] === 'closed').map(row => Number(row['id']))), now, io)
  const round = archiveRound(stateRoot(env), now, io)
  const request: Request = { ...parsed, name }
  const open = readOpen(request, env)
  let installed: string | undefined
  const installedLine = (): string => (installed ??= notInstalled(parsed.worktree, env, now))
  const facts: Artifacts = { rows: all, prState: deps.prState ?? forgeState(env), installed: installedLine }
  const owners = ownersOf(open, blocker => fallOf(blocker, facts))
  const stray = todoStray(readText(todoPath(stateRoot(env), name)) ?? '', all)
  const project = projectOf(parsed.worktree, parsed.record)
  const goals = readText(goalsFileOf(parsed.record))
  const liveRulings = existsSync(rulingsFile) ? readAtTakeover(readText(rulingsFile) ?? '').trim() : ''
  const text = fill(template, {
    PROJECT: project,
    MODE: parsed.mode,
    PREDECESSOR_NAME_PATTERN: name,
    AGENT_NAME_PATTERN: 'Agent: <subject>',
    RULINGS_FILE: existsSync(rulingsFile) ? rulingsFile : 'none',
    LIVE_RULINGS: liveRulings === '' ? 'none' : liveRulings,
    GOALS_READ: hasOpenGoal(goals)
      ? `a goal is open: \`dispatch-record.sh goals ${parsed.record} status | grep -v '| met |'\` for its text`
      : 'no goal is open: the Project line below is the goals line, read nothing more',
    DISPATCH_RECORD: parsed.record,
    LAUNCHER: join(here, '..', '..', 'iterm-agents', 'scripts', 'iterm-agent.sh'),
    PREDECESSOR_TTY: parsed.tty,
    LIVE_ROWS: list(open.rows.map(row => row.line)),
    LIVE_OWNERS: list(owners),
    LIVE_PULL_REQUESTS: list(open.prs),
    LIVE_AGENTS: list(open.agents),
    LIVE_OPEN_QUESTIONS: open.questions.length === 0 ? 'none' : open.questions.map(q => `[${q.id}] ${q.text}`).join('\n\n'),
    LIVE_TODO: list(stray),
    PROJECT_SHEET: projectSheet(goals, installedLine()),
  })
  io.out(text.endsWith('\n') ? text : `${text}\n`)
    io.err(`takeover: chars=${text.length} rulings_read=${liveRulings.length} rows=${open.rows.length} ready=${owners.filter(o => o.endsWith(' READY NOT STARTED')).length} prs=${open.prs.length} agents=${open.agents.length} questions=${open.questions.length} todo_stray=${stray.length} pruned=rulings:${rulings.moved},round:${round}\n`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2), process.env, processIo)
