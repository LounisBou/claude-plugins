// succession — the takeover, read from the state alone (decision 0007).
//
//   succession.sh takeover <dispatch record> --mode build|investigate [--tty <predecessor's tty>] [--name "<Orch: x>"] [--session <id>] [--worktree <dir>]
//
// One owner per fact: the dispatch record's rows hold the work (state, blocker, note, verdict line),
// the to-do list holds the operator's words and the rows each item turned into, the round his
// answers, the goals file the spec it names; agents, pull requests and checkouts are read live. So
// no succession brief is written: the successor runs this command, which prints the fixed
// instructions of `templates/orchestrator-succession-brief.md` filled from those files, then the
// Live state, and nothing of it lands in a file.
//
// The Live state: the open rows at level 1; their owners, « ruling » for a deferred one, an open
// row's live agent as its note names it (the dispatch writes `Dispatched …: Agent: <name>` there),
// else its blocker checked on its artifact (the pull request merged, the row closed, the release
// installed, the `until` time passed; a `measure` never falls): fallen and with no agent, READY NOT
// STARTED; a row whose note names an agent no longer live, DISPATCHED, NO LIVE AGENT; an open row
// with no blocker recorded reads NO OWNER; the record's pull request ledger; the deck's
// agents of this orchestration; the round's open questions, verbatim; the to-do items pointing to a
// row closed or missing; the project sheet from `goals.md` (objective, spec, open goals and their plan)
// and the merged pull requests not installed.
//
// The orchestration's name is the one given, else the record's owner (`<record>.owner`), else, when
// that file names no orchestration, the name of the session that runs the takeover. A row names its
// pull request in its label (`<repo>#<n>`, the repository's short name too) or in the heads its review
// recorded; the forge says which of them is open, and the ledger who is on it. Before printing,
// the command moves the round's entries settled over a day ago to its archive (round-archive's
// rule): what a takeover reads is only what is live. Its measure goes to stderr.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DECK_FILE, parseDeck } from '../../../core/deck.ts'
import { ROUND_DIR } from '../../../core/orchestration.ts'
import { readText } from '../../../core/store.ts'
import { configDir, type Env } from '../../../core/paths.ts'
import { openLine, orchForm, parseRecord, sessionOrchestration, stateRoot, type Row } from './dispatch-record.ts'
import { parseSessionName } from '../../../core/names.ts'
import { ledgerLines, prKey, statusText, untilOf, type LedgerLine } from '../../../core/pr-ledger.ts'
import { isEntry, processIo, type Io } from './lib/process.ts'
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
  /** The row's note of judgment, where its dispatch names the agent it went to. */
  readonly note?: string
  /** What the row waits on; undefined when none was recorded. */
  readonly blocker?: string
  /** The pull requests the row names, as written (`<repo>#<n>`, the repository maybe by its short name). */
  readonly refs?: readonly string[]
  /** The heads its review recorded, where its pull request stood. */
  readonly heads?: readonly string[]
  /** Its pull requests found open, each with where it stands: filled by the live read. */
  readonly linked?: readonly string[]
}

/** An open pull request of the forge, with the head it stands at. */
export interface ForgePr {
  readonly repo: string
  readonly pr: number
  readonly head: string
}

/** A repository's open pull requests on the forge; undefined when it cannot be read. */
export type OpenPrReader = (repo: string) => readonly ForgePr[] | undefined

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

/** The deck's orchestrator of that name, local: its pull requests and its agents' names. */
export function deckOpen(deckText: string | undefined, name: string): { prs: string[]; agents: string[]; repo?: string } {
  const orch = (deckText === undefined ? null : parseDeck(deckText))?.orchestrators.find(o => o.name === name && o.machine === null)
  if (orch === undefined) return { prs: [], agents: [] }
  return { prs: orch.prs, agents: orch.agents.map(agent => agent.name), ...(orch.repo ? { repo: orch.repo } : {}) }
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

const PR_REF = /([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)#([1-9][0-9]*)/g

/** The pull requests a text names, `<repo>#<n>` as written. */
export const refsOf = (text: string): string[] => [...text.matchAll(PR_REF)].map(match => `${match[1]}#${match[2]}`)

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? (value as Fields)[key] : undefined)

/** The heads a row's review recorded: the one it judged and the one its corrections left. */
function headsOf(row: Row): string[] {
  const review = row['review']
  return [field(review, 'head'), field(field(review, 'fixed'), 'head')].filter((head): head is string => typeof head === 'string' && /^[0-9a-f]{7,40}$/.test(head))
}

/** The open rows of a record's rows, as the takeover reads them. */
export function openRows(rows: readonly Row[]): OpenRow[] {
  return rows.filter(row => row['state'] === 'open').map(row => {
    const surface = field(row['surface'], 'pr')
    const refs = [...refsOf(String(row['label'] ?? '')), ...(typeof surface === 'string' ? refsOf(surface) : [])]
    const heads = headsOf(row)
    return {
      id: String(row['id']),
      line: openLine(row),
      label: String(row['label'] ?? ''),
      ruling: typeof row['deferred'] === 'string' ? row['deferred'] : '',
      ...(typeof row['note'] === 'string' && row['note'] !== '' ? { note: row['note'] } : {}),
      ...(typeof row['blocker'] === 'string' ? { blocker: row['blocker'] } : {}),
      ...(refs.length > 0 ? { refs } : {}),
      ...(heads.length > 0 ? { heads } : {}),
    }
  })
}

/** The repository a `<repo>#<n>` names: as written when it has an owner, else the one known repository of that name. */
function repoOf(ref: string, known: readonly string[]): { repo: string; pr: number } | undefined {
  const [name = '', number = ''] = ref.split('#')
  const pr = Number(number)
  if (name.includes('/')) return { repo: name, pr }
  const found = known.filter(repo => repo.split('/')[1] === name)
  return found.length === 1 ? { repo: found[0] ?? '', pr } : undefined
}

const sameHead = (a: string, b: string): boolean => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))

/** What the live read found of the pull requests of the open rows: each row's, and the repositories the forge could not tell. */
export interface Linked {
  readonly rows: readonly OpenRow[]
  readonly prs: readonly string[]
  readonly unread: readonly string[]
}

/**
 * The pull requests the open rows hold, read live: the repositories to ask are the project's, the
 * deck's, the ledger's and those a label names in full; the forge lists each one's open pull
 * requests, and a row holds those it names (by label or surface) and those standing at a head its
 * review recorded. A pull request the ledger says someone is on reads by its line, else it is open
 * with no agent. One no row holds is another orchestration's, and stays out.
 */
export function linkRows(rows: readonly OpenRow[], ledger: readonly LedgerLine[], seed: readonly (string | undefined)[], open: OpenPrReader): Linked {
  if (!rows.some(row => (row.refs?.length ?? 0) > 0 || (row.heads?.length ?? 0) > 0)) return { rows, prs: [], unread: [] }
  const full = rows.flatMap(row => (row.refs ?? []).filter(ref => ref.includes('/')).map(ref => ref.split('#')[0] ?? ''))
  const repos = [...new Set([...seed, ...ledger.map(line => line.repo), ...full].filter((repo): repo is string => typeof repo === 'string' && /^[^/\s]+\/[^/\s]+$/.test(repo)))]
  const forge: ForgePr[] = []
  const unread: string[] = []
  const readRepos = new Set<string>()
  for (const repo of repos) {
    const read = open(repo)
    if (read === undefined) unread.push(repo)
    else {
      readRepos.add(repo)
      forge.push(...read)
    }
  }
  const standing = (key: string): string | undefined => {
    const onForge = forge.some(pr => prKey(pr.repo, pr.pr) === key)
    const line = ledger.find(l => prKey(l.repo, l.pr) === key)
    // A repository the forge was read for no longer lists a merged or closed pull request: its ledger line says nothing of it.
    if (line !== undefined && (onForge || !readRepos.has(line.repo))) return `${key} ${statusText(line)}`
    return onForge ? `${key} open, no agent` : undefined
  }
  const described = new Map<string, string>()
  const linked = rows.map(row => {
    const keys = new Set<string>()
    for (const ref of row.refs ?? []) {
      const found = repoOf(ref, repos)
      if (found !== undefined) keys.add(prKey(found.repo, found.pr))
    }
    for (const pr of forge) if ((row.heads ?? []).some(head => sameHead(head, pr.head))) keys.add(prKey(pr.repo, pr.pr))
    const lines = [...keys].flatMap(key => {
      const line = standing(key)
      if (line === undefined) return []
      described.set(key, line)
      return [line]
    })
    return lines.length === 0 ? row : { ...row, linked: lines }
  })
  return { rows: linked, prs: [...described.values()], unread: unread.map(repo => `${repo} open pull requests unread`) }
}

/** Reads the state this orchestrator holds open from the files that keep it. */
export function readOpen(request: Request, env: Env, openPrs: OpenPrReader = () => undefined): OpenState {
  const state = stateRoot(env)
  const recordText = readText(request.record) ?? ''
  // The ledger names each pull request it attends with its own repository: the deck lists numbers
  // whose repository it cannot tell, and a merged one lingers there. A ledger line leaves the record
  // when it is archived (the Stop hook, or `pr-archive`), so a pull request merged since may still show.
  const ledger = ledgerLines(recordText)
  const { agents, repo } = deckOpen(readText(join(state, DECK_FILE)), request.name)
  // A row of a record older than the ledger names no pull request the ledger holds: the forge's open
  // ones are matched to the open rows, by what a label names and the heads its review recorded.
  const found = linkRows(openRows(parseRecord(recordText)), ledger, [repo, projectOf(request.worktree, request.record)], openPrs)
  const lines = ledger.map(line => `${prKey(line.repo, line.pr)} ${statusText(line)}`)
  const prs = [...lines, ...found.prs.filter(line => !lines.includes(line)), ...found.unread]
  const round = join(state, ROUND_DIR)
  const names = existsSync(round) ? readdirSync(round).filter(name => name.endsWith('.json')).sort() : []
  return {
    rows: found.rows,
    prs,
    agents,
    questions: roundOpen(names.map(name => object(readText(join(round, name)))), request.name, request.session),
  }
}

const list = (items: readonly string[]): string => (items.length === 0 ? 'none' : items.join('; '))

const bareName = (name: string): string => name.replace(/^Agent:\s*/, '').trim()

/** Whether a text names that agent: its name whole, not as the start of a longer word. */
function names(text: string, agent: string): boolean {
  const name = bareName(agent).toLowerCase()
  if (name === '') return false
  const lower = text.toLowerCase()
  for (let at = lower.indexOf(name); at !== -1; at = lower.indexOf(name, at + 1)) {
    const before = lower[at - 1] ?? ' '
    const after = lower[at + name.length] ?? ' '
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true
  }
  return false
}

/** Whether a blocker has fallen, read on its artifact: fallen, still standing, or not readable now. */
export type Fall = 'fallen' | 'standing' | 'unread'

/** The facts a blocker is checked against: the record's rows, a pull request's state on the forge, the installed copy. */
export interface Artifacts {
  readonly rows: readonly Row[]
  /** `MERGED`, `OPEN` or `CLOSED`; undefined when the forge cannot be read. */
  readonly prState: (repo: string, pr: number) => string | undefined
  /** `notInstalled`'s line: '' when it cannot be read. */
  readonly installed: () => string
  /** The clock an `until` is read on, in ms; the current time when absent. */
  readonly now?: number
}

/** A blocker checked on its artifact. A `measure` never falls by itself: the orchestrator sets it to `none` or closes the row. */
export function fallOf(blocker: string, facts: Artifacts): Fall {
  if (blocker === 'none') return 'fallen'
  const at = untilOf(blocker)
  if (at !== undefined) return at <= (facts.now ?? Date.now()) ? 'fallen' : 'standing'
  if (/^measure \S/.test(blocker)) return 'standing'
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
 * Who works each open row, from the facts the state holds: the deck's live agents its note names
 * (the dispatch writes `Dispatched …: Agent: <name>` there; listed without the role prefix), never a
 * guess from its label. A deferred row reads « ruling »; a row with no live agent reads its blocker
 * checked on its artifact: `blocked: <blocker>` while it stands, then an open pull request it holds,
 * DISPATCHED, NO LIVE AGENT when its note names an agent the deck no longer lists, READY NOT STARTED
 * once its blocker has fallen, `blocker unread: <blocker>` when its artifact cannot be read; a row
 * with no blocker recorded reads NO OWNER.
 */
export function ownersOf(open: OpenState, fall: (blocker: string) => Fall = () => 'unread'): string[] {
  return open.rows.map(row => {
    if ((row.ruling ?? '') !== '') return `${row.id} ruling`
    const note = row.note ?? ''
    const live = open.agents.filter(agent => names(note, agent))
    if (live.length > 0) return `${row.id} ${live.map(bareName).join(', ')}`
    // A blocker still standing says why nobody is on the row; once it fell, an open pull request the row holds is its owner.
    const fell = row.blocker === undefined ? undefined : fall(row.blocker)
    if (fell === 'standing') return `${row.id} blocked: ${row.blocker}`
    if ((row.linked ?? []).length > 0) return `${row.id} ${(row.linked ?? []).join(', ')}`
    // Dispatched, and its agent gone from the deck: its pull request or branch is read before anyone is sent again.
    if (/\bAgent:\s*\S/.test(note)) return `${row.id} DISPATCHED, NO LIVE AGENT`
    if (row.blocker === undefined) return `${row.id} NO OWNER`
    return `${row.id} ${fell === 'fallen' ? 'READY NOT STARTED' : `blocker unread: ${row.blocker}`}`
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

/** A repository's open pull requests as `gh pr list` tells them, undefined when it cannot be read. */
export function forgeOpenPrs(env: Env): OpenPrReader {
  return repo => {
    try {
      const listed: unknown = JSON.parse(execFileSync('gh', ['pr', 'list', '-R', repo, '--state', 'open', '--limit', '200', '--json', 'number,headRefOid'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, env: { ...process.env, ...env },
      }))
      if (!Array.isArray(listed)) return undefined
      return listed.flatMap(item => {
        const number = field(item, 'number')
        const head = field(item, 'headRefOid')
        return typeof number === 'number' && typeof head === 'string' ? [{ repo, pr: number, head }] : []
      })
    } catch {
      return undefined
    }
  }
}

/** The project sheet from `goals.md`: the objective, the spec it names and the goals as one line, `goals met=m/n open=none`, `open=` the open ones with their plan, and `deferred=` the deferred ones. */
export function projectSheet(goals: string | undefined, installed: string): string {
  const parts: string[] = []
  if (goals === undefined) parts.push('no goals.md beside the record')
  else {
    const value = (key: string): string => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(goals)?.[1]?.trim() ?? ''
    const rows = goals.split('\n').filter(line => /^\| G[0-9]+ \|/.test(line)).map(line => line.split('|').map(cell => cell.trim()))
    const open = rows.filter(cells => cells[2] === 'open')
    parts.push(`objective ${value('aim') || 'none'}`, `spec ${value('spec') || 'none'}`)
    const deferred = rows.filter(cells => cells[2] === 'deferred').map(cells => cells[1])
    parts.push(`goals met=${rows.filter(cells => cells[2] === 'met').length}/${rows.length} open=${open.length === 0 ? 'none' : open.map(cells => `${cells[1]} (plan: ${cells[4] || 'none'})`).join(', ')}${deferred.length === 0 ? '' : ` deferred=${deferred.join(',')}`}`)
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

// The round's entries settled over a day ago, moved to its archive as `round-archive` moves them:
// a move that fails is said, and the takeover goes on.
function archiveRound(state: string, now: Date, io: Io): number {
  try {
    return archiveSettled(join(state, ROUND_DIR), now)
  } catch (error) {
    io.err(`succession: ${(error as Error).message}\n`)
    return 0
  }
}

export interface Deps {
  readonly cwd: string
  readonly now: () => Date
  readonly prState?: (repo: string, pr: number) => string | undefined
  readonly openPrs?: OpenPrReader
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
  const owner = orchForm((readText(ownerFileOf(parsed.record)) ?? '').split('\n')[0]?.trim() ?? '')
  // An owner file that names no orchestration (empty, torn, a note) leaves the session's own: the
  // successor's name is the predecessor's, the host's reference left off.
  const named = parsed.name !== '' || parseSessionName(owner)?.role === 'orchestrator'
  const name = parsed.name !== '' ? orchForm(parsed.name) : named ? owner : sessionOrchestration(env)
  if (!named && name !== '') io.err(`succession: ${ownerFileOf(parsed.record)} names no orchestration, using this session's: ${name}\n`)
  if (name === '') {
    io.err(`succession: ${ownerFileOf(parsed.record)} names no orchestration: pass --name "<Orch: x>" (this session is no orchestration either)\n`)
    return 2
  }
  const template = readText(TEMPLATE)
  if (template === undefined) {
    io.err(`succession: the plugin's template ${TEMPLATE} cannot be read\n`)
    return 2
  }
  const now = deps.now()
  const all = parseRecord(recordText)
  const round = archiveRound(stateRoot(env), now, io)
  const request: Request = { ...parsed, name }
  const open = readOpen(request, env, deps.openPrs ?? forgeOpenPrs(env))
  let installed: string | undefined
  const installedLine = (): string => (installed ??= notInstalled(parsed.worktree, env, now))
  const facts: Artifacts = { rows: all, prState: deps.prState ?? forgeState(env), installed: installedLine, now: now.getTime() }
  const owners = ownersOf(open, blocker => fallOf(blocker, facts))
  const stray = todoStray(readText(todoPath(stateRoot(env), name)) ?? '', all)
  const project = projectOf(parsed.worktree, parsed.record)
  const text = fill(template, {
    PROJECT: project,
    MODE: parsed.mode,
    PREDECESSOR_NAME_PATTERN: name,
    AGENT_NAME_PATTERN: 'Agent: <subject>',
    STATE_DIR: stateRoot(env),
    SCRIPTS: here,
    DISPATCH_RECORD: parsed.record,
    LAUNCHER: join(here, '..', '..', 'iterm-agents', 'scripts', 'iterm-agent.sh'),
    PREDECESSOR_TTY: parsed.tty,
    LIVE_ROWS: list(open.rows.map(row => row.line)),
    LIVE_OWNERS: list(owners),
    LIVE_PULL_REQUESTS: list(open.prs),
    LIVE_AGENTS: list(open.agents),
    LIVE_OPEN_QUESTIONS: open.questions.length === 0 ? 'none' : open.questions.map(q => `[${q.id}] ${q.text}`).join('\n\n'),
    LIVE_TODO: list(stray),
    PROJECT_SHEET: projectSheet(readText(goalsFileOf(parsed.record)), installedLine()),
  })
  io.out(text.endsWith('\n') ? text : `${text}\n`)
  io.err(`takeover: chars=${text.length} rows=${open.rows.length} ready=${owners.filter(o => o.endsWith(' READY NOT STARTED')).length} prs=${open.prs.length} agents=${open.agents.length} questions=${open.questions.length} todo_stray=${stray.length} pruned=round:${round}\n`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2), process.env, processIo)
