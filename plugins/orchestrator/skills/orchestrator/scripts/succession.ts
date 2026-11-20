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
// The Live state: the open rows at level 1; their owners, « ruling » for a deferred one (DEFERRED DUE once its `until` date has come), an open
// row's live agent as the row's `agent` field names it (`dispatch-record.sh agent`, written by the launcher),
// else its blocker checked on its artifact (the pull request merged, the row closed, the release
// installed, the `until` time passed; a `measure` never falls): fallen and with no agent, READY NOT
// STARTED; a row whose `agent` is no longer live, DISPATCHED, NO LIVE AGENT; an open row
// with no blocker recorded reads NO OWNER; the record's pull request ledger; the agents of this
// orchestration, each with its tty and the brief its launch named: the deck's orchestrator on the
// predecessor's tty (by name when no tty is given or the deck has none there), joined with the
// launcher's chains of both ttys and its `list`, so an agent spawned since the deck's last write is
// there too, and each agent the rows name that runs in a window of a home server (the predecessor's
// included, read from tmux's socket directory), with `<server>:<window>`; the round's open questions, verbatim; the to-do items pointing to a
// row closed or missing; the project sheet from `goals.md` (objective, spec, open goals and their plan)
// and the merged pull requests not installed.
//
// The print carries the meaning, never his words: a row's ruling and note are one line, a quotation
// of his replaced by the id of the round entry or to-do item that holds it; a note several rows share
// is printed once, naming them; an answer his asker already received (typed in its tab, or delivered)
// is not printed, one still to apply is one line of its letter or first sentence under its id; the
// objective is its first sentence. The full words stay in `round/` and the to-do list, named by id.
//
// The orchestration's name is the one given, else the record's owner (`<record>.owner`), else, when
// that file names no orchestration, the name of the session that runs the takeover. The owner file then
// names the successor (the orchestration this session is), whether the predecessor is
// dead and whether its title differs, so `dispatch-record.sh` accepts the successor. A row names its
// pull request in its label (`<repo>#<n>`, the repository's short name too) or in the heads its review
// recorded; the forge says which of them is open, and the ledger who is on it. Before printing,
// the command moves the round's entries settled over a day ago to its archive (round-archive's
// rule): what a takeover reads is only what is live. Its measure goes to stderr. When the deck
// names an agent the launcher's `list` does not show, one journal line says how many
// (`succession-lost-state`), so the succession is tuned on its misses. An agent `list` shows that
// the deck lacks is no miss: the deck holds an agent from the end of its first turn, so one
// spawned since is in the chain and `list` alone, and is printed from them.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chainPath, parseChain } from '../../../core/chain-entries.ts'
import { DECK_FILE, parseDeck } from '../../../core/deck.ts'
import { ROUND_ARCHIVE_DIR, ROUND_DIR } from '../../../core/orchestration.ts'
import { readText, writeAtomic } from '../../../core/store.ts'
import { parsePrFile, prFilePath, prsOfRepo } from '../../../hooks/pr-file-format.ts'
import { configDir, type Env } from '../../../core/paths.ts'
import { setting } from '../../../core/env.ts'
import { openLine, parseRecord, stateRoot, type Row } from './dispatch-record.ts'
import { orchForm } from '../../../core/names.ts'
import { sessionOrchestration } from '../../../core/session-orchestration.ts'
import { parseSessionName } from '../../../core/names.ts'
import { agentsOf, ledgerLines, prKey, statusText, subjectOf, untilOf, type LedgerLine } from '../../../core/pr-ledger.ts'
import { auditRun, scriptJournal, writeAudit, type Journal } from './lib/audit.ts'
import { isEntry, processIo, type Io } from './lib/process.ts'
import { GoalsFault, namedGoals, parseGoals } from './lib/goals-file.ts'
import { goalsFileOf, ownerFileOf } from './lib/record-paths.ts'
import { archiveSettled } from './lib/round-archive.ts'
import { openTodos, todoItems, todoPath } from '../../../hooks/todo-format.ts'
import { askedKey } from '../../../hooks/asked-key.ts'
import { holdsOf, readyHeadsOf } from '../../../hooks/ready-agent.ts'
import { bareName, briefOfLaunch, isAgent, newestLaunch, rowOfBrief } from '../../../hooks/row-owner.ts'
export { rowOfBrief }
import type { Asked } from '../../../hooks/question.ts'

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

// A directory inside an installed plugin: a deploy or a host install.
const PLUGIN_DIR = /\/(deploys\/[^/]+\/[0-9a-f]{40}|plugins\/(cache|marketplaces))(\/|$)/

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
  const worktree = values['worktree'] ?? cwd
  // The project is read from the working directory: run from inside the plugin's own copy, it would be the configuration's repository.
  if (PLUGIN_DIR.test(worktree.replaceAll('\\', '/'))) return { error: `run the takeover from the project's directory, not from the plugin's (${worktree}): call <base dir>/scripts/succession.sh by its path, or pass --worktree <project dir>` }
  return { record: resolve(cwd, record), mode, tty: values['tty'] ?? 'none', name: values['name'] ?? '', session: values['session'] ?? '', worktree }
}

/** One open question of the round, as the takeover prints it. */
export interface Question {
  readonly id: string
  readonly text: string
}

/** A settled question of the round: its entry id, its block, and what settled it (the operator's answer, or the reason it was withdrawn). */
export interface Settled {
  readonly id: string
  readonly text: string
  readonly said: string
  /** What names the question in a line: its subject, else its words cut short. */
  readonly label: string
}

/** What a successor does with the settled questions of its orchestration: apply the answers, ask the withdrawn ones again. */
export interface SettledQuestions {
  readonly answered: readonly Settled[]
  readonly reask: readonly Settled[]
}

/** An open row, as the takeover reads it. */
export interface OpenRow {
  readonly id: string
  readonly line: string
  /** The same line without its note, and the note on one line: a note several rows share is printed once. */
  readonly bare?: string
  readonly meant?: string
  readonly label?: string
  readonly ruling?: string
  /** The row's note of judgment. */
  readonly note?: string
  /** The session working the row, as `dispatch-record.sh agent` wrote it (`Agent: <subject>`). */
  readonly agent?: string
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

/** An agent of this orchestration: its name, the tty `close`, `rotate` and `screen` take, and the brief its launch named. */
export interface LiveAgent {
  readonly name: string
  readonly tty: string | null
  readonly brief?: string
  /** The home server and window it runs in, `<server>:<window>`; undefined for a session of an iTerm2 tab. */
  readonly where?: string
  /** What its Ready pull request says of it, `Ready (<prs>): the module closes it once done` or the pull requests it still holds; undefined when none of its pull requests is Ready. */
  readonly ready?: string
}

/** What the state holds open for this orchestrator. */
export interface OpenState {
  readonly rows: readonly OpenRow[]
  readonly prs: readonly string[]
  /** The agents' names, which a row's note is matched on. */
  readonly agents: readonly string[]
  /** The same agents with their tty and brief, as the Live state prints them. */
  readonly seats?: readonly LiveAgent[]
  readonly questions: readonly Question[]
  /** The questions the operator answered, to apply; the withdrawn ones to ask again. */
  readonly settled?: SettledQuestions
  /** How many deck agents the launcher's `list` does not show; undefined when `list` was not read. */
  readonly disagree?: number
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

/** A tty by its device name, `ttys005` for `/dev/ttys005`. */
const ttyName = (tty: string): string => tty.slice(tty.lastIndexOf('/') + 1)

/**
 * The deck's local orchestrator on the predecessor's tty: its pull requests and its agents. A
 * successor carries the same name, so the name decides only when no tty is given or no deck row
 * runs on it; then every local orchestrator of that name counts.
 */
export function deckOpen(deckText: string | undefined, name: string, tty = 'none'): { prs: string[]; agents: LiveAgent[]; repo?: string } {
  const local = ((deckText === undefined ? null : parseDeck(deckText))?.orchestrators ?? []).filter(o => o.machine === null)
  const onTty = tty === 'none' ? [] : local.filter(o => o.tty !== null && ttyName(o.tty) === ttyName(tty))
  const found = onTty.length > 0 ? onTty : local.filter(o => o.name === name)
  const agents = new Map<string, LiveAgent>()
  for (const agent of found.flatMap(o => o.agents)) if (!agents.has(agent.name)) agents.set(agent.name, { name: agent.name, tty: agent.tty })
  const repo = found.find(o => o.repo)?.repo
  return { prs: [...new Set(found.flatMap(o => o.prs))], agents: [...agents.values()], ...(repo ? { repo } : {}) }
}

/** One row of the launcher's `list`: the session's tty, its name (its title when it has none), and whether it is the caller. */
export interface ListedRow {
  readonly tty: string
  readonly name: string
  readonly self: boolean
}

/** The rows of the launcher's `list` output (`w<i>/t<j> | <tty> | <title> | <name>[ | self][ | hidden]`); other lines are skipped. */
export function parseList(text: string): ListedRow[] {
  return text.split('\n').flatMap(line => {
    const parts = line.split(' | ')
    if (parts.length < 4 || !/^w[0-9]+\/t[0-9]+$/.test(parts[0] ?? '')) return []
    const title = (parts[2] ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim()
    const named = (parts[3] ?? '').trim()
    return [{ tty: parts[1] ?? '', name: named === '' || named.startsWith('(') ? title : named, self: parts.slice(4).includes('self') }]
  })
}

/**
 * The agents of this orchestration as they run now: the deck's, each given the tty `list` shows
 * under its name, then each agent the launcher's chains hold that `list` shows running and the deck
 * does not name (spawned since the deck's last write). With no `list`, the deck's as they are.
 * `disagree` counts the deck agents `list` does not show. A chained agent the deck lacks is not
 * counted: the deck is written from the sessions' measures, taken when a turn ends, so an agent
 * still in its first turn is in the chain and `list` alone, and that is the usual state of a
 * takeover, not a lost one.
 */
export function liveAgents(deck: readonly LiveAgent[], chained: readonly string[], listed: readonly ListedRow[] | undefined, homes: readonly HomeAgent[] = []): { agents: LiveAgent[]; disagree?: number } {
  if (listed === undefined) return { agents: [...deck] }
  const byTty = new Map(listed.map(row => [ttyName(row.tty), row]))
  const shown = (agent: LiveAgent): ListedRow | undefined => (agent.tty !== null ? byTty.get(ttyName(agent.tty)) : undefined) ?? listed.find(row => row.name === agent.name)
  const agents = deck.map(agent => ({ ...agent, tty: agent.tty ?? shown(agent)?.tty ?? null }))
  // A deck agent that runs in a home server `list` does not show is not a lost one.
  const disagree = deck.filter(agent => shown(agent) === undefined && !homes.some(found => isAgent(agent.name, found.agent))).length
  for (const tty of chained) {
    const row = byTty.get(ttyName(tty))
    if (row === undefined || agents.some(agent => agent.name === row.name || (agent.tty !== null && ttyName(agent.tty) === ttyName(row.tty)))) continue
    agents.push({ name: row.name, tty: row.tty })
  }
  return { agents, disagree }
}

/** One pane of a home server: the server's socket name, its window, the tty and the window's name. */
export interface HomePane {
  readonly server: string
  readonly window: number
  readonly tty: string
  readonly name: string
  /** The pane's title, which the host rewrites: the name when the window's own is no agent's. */
  readonly title?: string
}

/** The prefix of a home server's socket (`iterm_agent.py`'s HOME_SOCKET_PREFIX): the process table of tmux's own directory, not the launcher's `list`, shows every one. */
const HOME_SOCKET_PREFIX = 'orch-'

/**
 * Every pane of every live home server of the machine, read from tmux's socket directory: the
 * predecessor's home server holds its agents as windows, and the launcher's `list` shows no window
 * of a server this session is not in. A server that does not answer is skipped; undefined when the
 * directory cannot be read at all.
 */
export function homePanes(env: Env, uid: number = process.getuid?.() ?? 0, said: (line: string) => void = () => {}): HomePane[] | undefined {
  let sockets: string[]
  try {
    sockets = readdirSync(join(setting(env, 'TMUX_TMPDIR') ?? '/tmp', `tmux-${uid}`)).filter(name => name.startsWith(HOME_SOCKET_PREFIX)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') said(`succession: the tmux socket directory cannot be read: ${(error as Error).message}`)
    return undefined
  }
  const tmux = setting(env, 'ORCHESTRATOR_TMUX') ?? 'tmux'
  return sockets.flatMap(server => {
    try {
      const out = execFileSync(tmux, ['-u', '-L', server, 'list-panes', '-a', '-F', '#{window_index}\t#{pane_tty}\t#{window_name}\t#{pane_title}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env: { ...process.env, ...env } })
      return out.split('\n').flatMap(line => {
        const [window = '', tty = '', name = '', title = ''] = line.split('\t')
        return /^[0-9]+$/.test(window) && tty !== '' ? [{ server, window: Number(window), tty, name, title }] : []
      })
    } catch (error) {
      said(`succession: home server ${server} not read, its agents are missing from the list: ${(error as Error).message.split('\n')[0] ?? ''}`)
      return []
    }
  })
}

/** A pane of a home server that runs an agent the record's rows name, with the name the row gives it. */
export interface HomeAgent {
  readonly agent: string
  readonly pane: HomePane
}

/** The panes that run an agent a row names (by the window's name, else the pane's title); window 0 is the orchestrator's, never an agent's. */
export function homeAgentsOf(homes: readonly HomePane[], named: readonly string[]): HomeAgent[] {
  return homes.flatMap(pane => {
    if (pane.window === 0) return []
    const agent = named.find(one => isAgent(one, pane.name) || isAgent(one, pane.title ?? ''))
    return agent === undefined ? [] : [{ agent, pane }]
  })
}

/**
 * Those agents added to the ones the deck and the launcher's `list` gave, each with where it is; an
 * agent they already hold, by its name, has its place filled in.
 */
export function withHomeAgents(agents: readonly LiveAgent[], found: readonly HomeAgent[]): LiveAgent[] {
  const result = agents.map(agent => ({ ...agent }))
  for (const { agent, pane } of found) {
    const where = `${pane.server}:${pane.window}`
    const held = result.findIndex(one => isAgent(agent, one.name))
    if (held === -1) result.push({ name: agent, tty: pane.tty, where })
    else result[held] = { ...(result[held] as LiveAgent), tty: result[held]?.tty ?? pane.tty, where }
  }
  return result
}

/**
 * The brief an agent's launch named: `ORCHESTRATOR_BRIEF` in the newest launch script the launcher
 * wrote for its title (`<state>/prompts/launch-<title>-<ms>.sh`); undefined when none names one.
 */
export function briefOf(state: string, name: string): string | undefined {
  const dir = join(state, 'prompts')
  let file: string | undefined
  try {
    file = newestLaunch(readdirSync(dir), name)
  } catch {
    return undefined
  }
  return file === undefined ? undefined : briefOfLaunch(readText(join(dir, file)) ?? '')
}

/** An agent as the Live state prints it: its name, then its tty, its place in a home server and its brief where known. */
export function agentLine(agent: LiveAgent): string {
  const facts = [agent.tty === null ? '' : ttyName(agent.tty), agent.where ?? '', agent.brief === undefined ? '' : `brief ${agent.brief}`].filter(part => part !== '')
  const named = facts.length === 0 ? agent.name : `${agent.name} (${facts.join(', ')})`
  return agent.ready === undefined ? named : `${named} — ${agent.ready}`
}

/**
 * What the Ready pull requests of an agent say of it, the module's wake read from the same artifact: `Ready (<pr>): the module
 * closes it once done` when every pull request its lines name is Ready or ended, `Ready <pr>, still holds <pr>: tell it`
 * when another open pull request of its own is not. Undefined when none of its pull requests is Ready.
 * `ledger` is the record's lines, `ended` whether the forge reads a pull request merged or closed, `readyHead` its Ready head.
 */
export function readyNote(
  agent: string, ledger: readonly LedgerLine[], ended: (repo: string, pr: number) => boolean, readyHead: (repo: string, pr: number) => string | undefined,
): string | undefined {
  const kept = ledger.filter(line => !ended(line.repo, line.pr))
  if (bareName(agent) === '') return undefined
  const mine = (name: string): boolean => bareName(name).toLowerCase() === bareName(agent).toLowerCase()
  const ready = kept.filter(line => agentsOf(line).some(mine) && readyHead(line.repo, line.pr) !== undefined)
  if (ready.length === 0) return undefined
  const holds = holdsOf(kept, mine, key => ready.some(line => prKey(line.repo, line.pr) === key))
  const names = ready.map(line => prKey(line.repo, line.pr)).join(', ')
  return holds.length === 0 ? `Ready (${names}): the module closes it once done` : `Ready ${names}, still holds ${holds.join(', ')}: tell it`
}

/** The launcher's `list`, its rows; undefined when it cannot be run. */
export function launcherList(launcher: string, env: Env): ListedRow[] | undefined {
  try {
    return parseList(execFileSync('bash', [launcher, 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, env: { ...process.env, ...env } }))
  } catch {
    return undefined
  }
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

const LABEL_MAX = 120
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** A place his words are kept: the id of a round entry (`q-…`) or of a to-do item (`to-do 15`), with the words it holds. */
export interface Holder {
  readonly id: string
  readonly text: string
}

const LINE_MAX = 200
const QUOTE_KEY = 40
const QUOTE_MIN = 8

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`)

/**
 * A text of a row on one line, the operator's quotations (« … ») replaced by the id of the holder
 * that keeps them: `[words: q-1]`, else `« … »` when none holds them. A quotation is found in a
 * holder by its first characters, case and spacing aside.
 */
export function oneLine(text: string, holders: readonly Holder[] = [], max = LINE_MAX): string {
  const cited = text.replace(/«([^»]*)»/g, (_whole, quoted: string) => {
    const key = flat(quoted).replace(/^[….\s]+/, '').slice(0, QUOTE_KEY).toLowerCase()
    const holder = key.length < QUOTE_MIN ? undefined : holders.find(h => flat(h.text).toLowerCase().includes(key))
    return holder === undefined ? '« … »' : `[words: ${holder.id}]`
  })
  const line = flat(cited)
  if (line.length <= max) return line
  // A cut never lands inside a `[words: id]` token: the id is what the line is for.
  const open = line.lastIndexOf('[words:', max - 1)
  const inside = open !== -1 && line.indexOf(']', open) >= max - 1
  return cut(line, inside ? open + 1 : max)
}

/** The meaning of an answer in one line: its letter when it opens on one, else its first sentence. */
export function answerMeaning(said: string): string {
  const text = flat(said.replace(/«[^»]*»/g, ' '))
  // A letter is a choice when nothing but a dash, a colon, a dot or a bracket follows it: « A few … » is a sentence.
  const letter = /^([A-Z])(?=$|\s+[—–-]|[.:)])/u.exec(text)
  if (letter !== null) return letter[1] ?? ''
  const sentence = /^.*?(?:[.!?](?=\s+\p{Lu}|$)|$)/u.exec(text)?.[0] ?? text
  return cut(sentence.trim(), LABEL_MAX)
}

/** One entry of the round, read for what a succession decides on: what makes it the same question as another, its status, its asker, its words. */
interface Seen {
  readonly id: string
  readonly key: string
  readonly status: string
  readonly ours: boolean
  /** When it was settled, else when it was asked. */
  readonly at: string
  readonly text: string
  readonly said: string
  readonly label: string
}

const isText = (value: unknown): value is string => typeof value === 'string'

/** The fields of an object `ask` stored that its key reads, each of its type; undefined for anything else. */
function askedFields(entry: Fields): Pick<Asked, 'sender' | 'blocks' | 'subject' | 'context' | 'ask' | 'choices' | 'recommended' | 'why'> & { id: string; status: string; at: string } | undefined {
  const { id, status, at, subject, context, ask, blocks, recommended, why, choices, sender } = entry
  const from = typeof sender === 'object' && sender !== null ? (sender as Fields) : {}
  if (!isText(id) || !isText(status) || !isText(at) || !isText(subject) || !isText(context) || !isText(ask) || !isText(blocks) || !isText(from['name']) || !isText(from['session'])) return undefined
  if ((recommended !== null && !isText(recommended)) || (why !== null && !isText(why)) || !Array.isArray(choices)) return undefined
  const lettered = choices.flatMap(choice => {
    const c = typeof choice === 'object' && choice !== null ? (choice as Fields) : {}
    return isText(c['letter']) && isText(c['text']) ? [{ letter: c['letter'], text: c['text'] }] : []
  })
  if (lettered.length !== choices.length) return undefined
  return {
    id, status, at, subject, context, ask, blocks, recommended: recommended as string | null, why: why as string | null, choices: lettered,
    sender: { name: from['name'], session: from['session'], role: '', machine: '' },
  }
}

/**
 * An entry of the round, `ask`'s (v 2) or the relay's; undefined for anything else. A withdrawal the
 * operator made in the asker's own tab (`by: tab`) is his answer, the words he typed, whether the
 * entry was withdrawn or closed after a coordinator was shown it; a relay entry `closed` with a
 * `withdrawn:` text is otherwise a withdrawal.
 */
function seen(text: string | undefined, name: string, session: string): Seen | undefined {
  const entry = object(text)
  if (entry === undefined || typeof entry['id'] !== 'string' || typeof entry['status'] !== 'string') return undefined
  const answer = typeof entry['answer'] === 'object' && entry['answer'] !== null ? (entry['answer'] as Fields) : {}
  const reason = isText(answer['text']) ? answer['text'] : ''
  const withdrawal = entry['status'] === 'withdrawn' || (entry['status'] === 'closed' && reason.startsWith('withdrawn:'))
  const inTab = withdrawal && answer['by'] === 'tab'
  const said = inTab ? (isText(answer['typed']) && answer['typed'] !== '' ? answer['typed'] : reason.replace(/^withdrawn:\s*/, '')) : reason
  const status = inTab ? 'answered' : withdrawal ? 'withdrawn' : entry['status']
  const settled = isText(answer['at']) ? answer['at'] : ''
  const asked = entry['v'] === 2 ? askedFields(entry) : undefined
  if (asked !== undefined) {
    return { id: asked.id, key: askedKey(asked), status, ours: asked.sender.name === name || (session !== '' && asked.sender.session === session), at: settled === '' ? asked.at : settled, text: askedText(entry), said, label: flat(asked.subject).slice(0, LABEL_MAX) }
  }
  if (entry['v'] === 2 || entry['kind'] !== 'operator' || typeof entry['question'] !== 'string') return undefined
  const ours = entry['from'] === name || (session !== '' && entry['session'] === session)
  return { id: entry['id'], key: JSON.stringify(['relay', flat(entry['question'])]), status, ours, at: settled === '' ? (typeof entry['since'] === 'string' ? entry['since'] : '') : settled, text: entry['question'], said, label: flat(entry['question']).slice(0, LABEL_MAX) }
}

/**
 * What a successor does with the settled questions of its orchestration, from the round's entries
 * and the archive's: a question the operator answered (answered, or closed with a coordinator shown
 * it) is applied, never asked again; a withdrawn one is asked again once, the newest of its key,
 * unless an open, answered or closed entry holds its key, whoever asked it. A withdrawal made in
 * the asker's tab is the operator's answer. Whether another withdrawal's reason names an answer and
 * its premise stands is the successor's to read, from the reason printed.
 */
export function roundSettled(entries: readonly (string | undefined)[], archived: readonly (string | undefined)[], name: string, session: string): SettledQuestions {
  const live = entries.flatMap(text => seen(text, name, session) ?? [])
  const every = [...live, ...archived.flatMap(text => seen(text, name, session) ?? [])]
  const byId = (a: Seen, b: Seen): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const answeredOnes = (entry: Seen): boolean => entry.status === 'answered' || entry.status === 'closed'
  const answered = live.filter(entry => entry.ours && answeredOnes(entry)).sort(byId).map(entry => ({ id: entry.id, text: entry.text, said: entry.said, label: entry.label }))
  const reask = live.filter(entry => {
    if (!entry.ours || entry.status !== 'withdrawn') return false
    const same = every.filter(other => other.key === entry.key && other !== entry)
    if (same.some(other => other.status === 'open' || answeredOnes(other))) return false
    // The newest withdrawal of the key, among this orchestration's, speaks for the others.
    return !same.some(other => other.ours && other.status === 'withdrawn' && (other.at > entry.at || (other.at === entry.at && other.id > entry.id)))
  }).sort(byId).map(entry => ({ id: entry.id, text: entry.text, said: entry.said, label: entry.label }))
  return { answered, reask }
}

/**
 * The answers still to apply: those of `answered` whose asker does not have them yet. One typed in
 * the asker's own tab, or delivered to it, was applied by the asker; its entry stays in the round.
 */
export function toApply(answered: readonly Settled[], entries: readonly (string | undefined)[]): Settled[] {
  const received = new Set(entries.flatMap(text => {
    const entry = object(text)
    const answer = field(entry, 'answer')
    return entry !== undefined && (field(answer, 'by') === 'tab' || field(field(entry, 'delivery'), 'state') === 'delivered') ? [String(entry['id'])] : []
  }))
  return answered.filter(q => !received.has(q.id))
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

/**
 * The open rows of a record's rows, as the takeover reads them: a ruling and a note on one line, his
 * quotations replaced by the id of the holder that keeps them.
 */
export function openRows(rows: readonly Row[], holders: readonly Holder[] = []): OpenRow[] {
  return rows.filter(row => row['state'] === 'open').map(row => {
    const surface = field(row['surface'], 'pr')
    const refs = [...refsOf(String(row['label'] ?? '')), ...(typeof surface === 'string' ? refsOf(surface) : [])]
    const heads = headsOf(row)
    const meant = typeof row['note'] === 'string' ? oneLine(row['note'], holders) : ''
    const said = typeof row['deferred'] === 'string' && row['deferred'] !== '' ? { deferred: oneLine(row['deferred'], holders) } : {}
    const printed = { ...row, ...said }
    return {
      id: String(row['id']),
      line: openLine({ ...printed, note: meant }),
      bare: openLine({ ...printed, note: '' }),
      ...(meant === '' ? {} : { meant }),
      label: String(row['label'] ?? ''),
      ruling: typeof row['deferred'] === 'string' ? row['deferred'] : '',
      ...(typeof row['note'] === 'string' && row['note'] !== '' ? { note: row['note'] } : {}),
      ...(typeof row['blocker'] === 'string' ? { blocker: row['blocker'] } : {}),
      ...(typeof row['agent'] === 'string' && row['agent'] !== '' ? { agent: row['agent'] } : {}),
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
 * review recorded. A pull request the ledger says someone is on reads by its line until `state` reads
 * it merged or closed, else it is open with no agent. One no row holds is another orchestration's, and
 * stays out.
 */
export function linkRows(
  rows: readonly OpenRow[], ledger: readonly LedgerLine[], seed: readonly (string | undefined)[], open: OpenPrReader,
  state: (repo: string, pr: number) => string | undefined = () => undefined,
): Linked {
  if (!rows.some(row => (row.refs?.length ?? 0) > 0 || (row.heads?.length ?? 0) > 0)) return { rows, prs: [], unread: [] }
  const full = rows.flatMap(row => (row.refs ?? []).filter(ref => ref.includes('/')).map(ref => ref.split('#')[0] ?? ''))
  const repos = [...new Set([...seed, ...ledger.map(line => line.repo), ...full].filter((repo): repo is string => typeof repo === 'string' && /^[^/\s]+\/[^/\s]+$/.test(repo)))]
  const forge: ForgePr[] = []
  const unread: string[] = []
  for (const repo of repos) {
    const read = open(repo)
    if (read === undefined) unread.push(repo)
    else forge.push(...read)
  }
  const standing = (key: string): string | undefined => {
    const onForge = forge.some(pr => prKey(pr.repo, pr.pr) === key)
    const line = ledger.find(l => prKey(l.repo, l.pr) === key)
    // A merged or closed pull request's ledger line says nothing of it; one the file does not hold yet keeps its line.
    const ended = line !== undefined && ['MERGED', 'CLOSED'].includes(state(line.repo, line.pr) ?? '')
    if (line !== undefined && !ended) return `${key} ${statusText(line)}`
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

/** The words the round's entries keep: what he answered and typed, and the question. */
function roundHolders(entries: readonly (string | undefined)[]): Holder[] {
  return entries.flatMap(text => {
    const entry = object(text)
    if (entry === undefined || typeof entry['id'] !== 'string') return []
    const answer = field(entry, 'answer')
    const words = [field(answer, 'text'), field(answer, 'typed'), entry['question'], entry['ask']].filter(isText)
    return words.length === 0 ? [] : [{ id: entry['id'], text: words.join(' ') }]
  })
}

/** The words the to-do list keeps, by item. */
function todoHolders(todoText: string): Holder[] {
  return todoItems(todoText).map(item => ({ id: `to-do ${item.id}`, text: item.words }))
}

/** Reads the state this orchestrator holds open from the files that keep it. */
export function readOpen(
  request: Request, env: Env, openPrs: OpenPrReader = () => undefined, listed?: readonly ListedRow[],
  prState?: (repo: string, pr: number) => string | undefined, readyHead: (repo: string, pr: number) => string | undefined = () => undefined,
  homes: readonly HomePane[] = [],
): OpenState {
  const state = stateRoot(env)
  const recordText = readText(request.record) ?? ''
  // The ledger names each pull request it attends with its own repository: the deck lists numbers
  // whose repository it cannot tell, and a merged one lingers there. A ledger line leaves the record
  // when it is archived (the Stop hook, or `pr-archive`), so a pull request merged since may still show.
  const ledger = ledgerLines(recordText)
  const deck = deckOpen(readText(join(state, DECK_FILE)), request.name, request.tty)
  // The predecessor's chain and the successor's own, which the succession's spawn handed it.
  const own = listed?.find(row => row.self)?.tty
  const chained = [request.tty, own].filter((tty): tty is string => tty !== undefined && tty !== 'none')
    .flatMap(tty => parseChain(readText(chainPath(state, tty))).map(entry => entry.tty))
  const rows = parseRecord(recordText)
  // The agents the record's rows name run wherever their launch put them: a window of the predecessor's home server is as live as a tab.
  const named = rows.flatMap(row => (typeof row['agent'] === 'string' && row['agent'] !== '' ? [row['agent']] : []))
  const inHomes = homeAgentsOf(homes, named)
  const live = liveAgents(deck.agents, chained, listed, inHomes)
  const seats = withHomeAgents(live.agents, inHomes).map(agent => {
    // Named only for an agent the launcher's listing shows running, as the module's wake does: one it does not show, or no listing, closes nothing.
    const shown = agent.where !== undefined || listed?.some(one => one.name === agent.name || (agent.tty !== null && ttyName(one.tty) === ttyName(agent.tty))) === true
    const ready = shown ? readyNote(agent.name, ledger, (repo, pr) => ['MERGED', 'CLOSED'].includes(prState?.(repo, pr) ?? ''), readyHead) : undefined
    const said = ready === undefined ? agent : { ...agent, ready }
    const brief = briefOf(state, agent.name)
    return brief === undefined ? said : { ...said, brief }
  })
  // A row of a record older than the ledger names no pull request the ledger holds: the forge's open
  // ones are matched to the open rows, by what a label names and the heads its review recorded.
  const round = join(state, ROUND_DIR)
  const names = existsSync(round) ? readdirSync(round).filter(name => name.endsWith('.json')).sort() : []
  const entries = names.map(name => readText(join(round, name)))
  const found = linkRows(openRows(rows, [...roundHolders(entries), ...todoHolders(readText(todoPath(state, request.name)) ?? '')]), ledger, [deck.repo, projectOf(request.worktree, request.record)], openPrs, prState)
  const lines = ledger.map(line => `${prKey(line.repo, line.pr)} ${statusText(line)}`)
  const prs = [...lines, ...found.prs.filter(line => !lines.includes(line)), ...found.unread]
  const settled = roundSettled(
    entries,
    [join(round, ROUND_ARCHIVE_DIR), join(round, ROUND_ARCHIVE_DIR, 'withdrawn')].flatMap(from => (existsSync(from) ? readdirSync(from).filter(name => name.endsWith('.json') && !name.includes('.tmp-')).sort().map(name => readText(join(from, name))) : [])),
    request.name, request.session,
  )
  return {
    rows: found.rows,
    prs,
    agents: seats.map(agent => agent.name),
    seats,
    questions: roundOpen(entries.map(text => object(text)), request.name, request.session),
    settled: { answered: toApply(settled.answered, entries), reask: settled.reask },
    ...(live.disagree === undefined ? {} : { disagree: live.disagree }),
  }
}

const list = (items: readonly string[]): string => (items.length === 0 ? 'none' : items.join('; '))

/** The open rows' lines: a note two rows or more share is printed once at the end, naming them. */
export function rowLines(rows: readonly OpenRow[]): string[] {
  // Rows share a note when their whole notes are the same, not their shortened lines.
  const sameAs = (row: OpenRow): string => flat(row.note ?? '')
  const holders = new Map<string, OpenRow[]>()
  for (const row of rows) if (row.meant !== undefined && row.meant !== '') holders.set(sameAs(row), [...(holders.get(sameAs(row)) ?? []), row])
  const shared = [...holders.values()].filter(group => group.length > 1)
  const lines = rows.map(row => (row.meant !== undefined && (holders.get(sameAs(row))?.length ?? 0) > 1 ? (row.bare ?? row.line) : row.line))
  return [...lines, ...shared.map(group => `note of rows ${group.map(row => row.id).join(', ')}: ${group[0]?.meant ?? ''}`)]
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
 * Who works each open row, from the fact the record holds: the live agents the row's `agent` field names
 * (`dispatch-record.sh agent`, which the launcher writes at the spawn of the row's brief), never a guess
 * from its label nor from its note (listed without the role prefix). A deferred row reads
 * « ruling » until its `until` date, then DEFERRED DUE; a row with no live agent reads its blocker checked on its artifact: `blocked: <blocker>` while it stands, then an open pull request it holds,
 * DISPATCHED, NO LIVE AGENT when its `agent` names a session the deck no longer lists, READY NOT STARTED
 * once its blocker has fallen, `blocker unread: <blocker>` when its artifact cannot be read; a row
 * with no blocker recorded reads NO OWNER. Each line leads with the row's subject, its id in parentheses: `<subject> (<id>): <owner>`.
 */
export function ownersOf(open: OpenState, fall: (blocker: string) => Fall = () => 'unread'): string[] {
  return open.rows.map(row => {
    // The row leads with its subject, its id after it; a row whose label has no words leads with its id.
    const subject = subjectOf(row.label ?? '')
    const lead = subject === '' ? row.id : `${subject} (${row.id}):`
    // A deferred row waits for its revisit date, its `until` blocker; once it has come the row goes back to the operator.
    if ((row.ruling ?? '') !== '') return `${lead} ${row.blocker !== undefined && untilOf(row.blocker) !== undefined && fall(row.blocker) === 'fallen' ? 'DEFERRED DUE, ask the operator: relaunch or drop' : 'ruling'}`
    const seats: readonly LiveAgent[] = open.seats ?? open.agents.map(name => ({ name, tty: null }))
    const live = seats.filter(seat => isAgent(row.agent, seat.name)).map(seat => seat.name)
    if (live.length > 0) return `${lead} ${live.map(bareName).join(', ')}`
    // A blocker still standing says why nobody is on the row; once it fell, an open pull request the row holds is its owner.
    const fell = row.blocker === undefined ? undefined : fall(row.blocker)
    if (fell === 'standing') return `${lead} blocked: ${row.blocker}`
    if ((row.linked ?? []).length > 0) return `${lead} ${(row.linked ?? []).join(', ')}`
    // Dispatched, and its agent gone from the deck: its pull request or branch is read before anyone is sent again.
    if (row.agent !== undefined) return `${lead} DISPATCHED, NO LIVE AGENT`
    if (row.blocker === undefined) return `${lead} NO OWNER`
    return `${lead} ${fell === 'fallen' ? 'READY NOT STARTED' : `blocker unread: ${row.blocker}`}`
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

/**
 * The machine's pull request file (the hooks module refreshes it, one forge call a minute for the
 * whole machine), read once: each pull request's state and each repository's open pull requests, as
 * it holds them; undefined where it holds no current reading of the repository or does not hold the
 * pull request.
 */
export function filePrs(env: Env, now: number): {
  readonly state: (repo: string, pr: number) => string | undefined; readonly open: OpenPrReader; readonly ready: (repo: string, pr: number) => string | undefined
} {
  const file = parsePrFile(readText(prFilePath(stateRoot(env))) ?? '')
  return {
    state: (repo, pr) => prsOfRepo(file, repo, now)?.find(one => one.pr === pr)?.state,
    open: repo => prsOfRepo(file, repo, now)?.filter(one => one.state === 'OPEN').map(one => ({ repo, pr: one.pr, head: one.sha })),
    // The head a pull request carries Ready at; undefined when it is not Ready, or its repository's reading is not current.
    ready: (repo, pr) => readyHeadsOf(prsOfRepo(file, repo, now) ?? []).get(prKey(repo, pr)),
  }
}

/** The objective's first sentence: what follows it is the history of the goals, which goals.md keeps. */
export function objectiveOf(aim: string): string {
  const text = flat(aim)
  const end = /[.!?]\s+\p{Lu}/u.exec(text)
  return cut(end === null ? text.replace(/[.!?]$/, '') : text.slice(0, end.index), 300)
}

/** The project sheet from `goals.md`: the objective, the spec it names and the goals as one line, `goals met=m/n` then the goals still to reach by their words (`namedGoals`). */
export function projectSheet(goals: string | undefined, installed: string): string {
  const parts: string[] = []
  if (goals === undefined) parts.push('no goals.md beside the record')
  else {
    try {
      const { head, rows } = parseGoals(goals, 'goals.md')
      parts.push(`objective ${objectiveOf(head.aim) || 'none'}`, `spec ${head.spec || 'none'}`)
      parts.push(`goals met=${rows.filter(row => row.status === 'met').length}/${rows.length} ${namedGoals(rows)}`)
    } catch (error) {
      if (!(error instanceof GoalsFault)) throw error
      parts.push(`goals unread: ${error.message}`)
    }
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
  // A line ending on an optional placeholder, `{{KEY?}}`, is left out whole when its value is empty.
  const kept = template.replace(/^.*\{\{([A-Z_]+)\?\}\}[ \t]*\n?/gm, (line, key: string) => ((values[key] ?? '') === '' ? '' : line.replace(`{{${key}?}}`, `{{${key}}}`)))
  return kept.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => values[key] ?? whole)
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
  /** The head a pull request carries Ready at; undefined when it is not Ready or cannot be read. */
  readonly readyHead?: (repo: string, pr: number) => string | undefined
  /** The window index of the home session's pane on a tty; undefined when no tmux pane runs there. */
  readonly paneWindow?: (tty: string) => number | undefined
  /** The launcher's `list` rows; undefined when it cannot be read. */
  readonly list?: () => readonly ListedRow[] | undefined
  /** The panes of every live home server; read from tmux when absent. */
  readonly homes?: () => readonly HomePane[] | undefined
  readonly journal?: Journal
  /** Whether this session's tab becomes its home session when the takeover's turn ends; read by `movesHome` when absent. */
  readonly movesHome?: boolean
}

/**
 * Whether the end of the takeover's turn moves this session into its home session: on macOS, tmux
 * there, and the session in no tmux pane, a plain tab. The hooks module makes the move, the one
 * the start command makes at the end of its naming turn.
 */
export function movesHome(env: Env, platform: string = process.platform): boolean {
  if (platform !== 'darwin' || setting(env, 'TMUX') !== undefined) return false
  try {
    execFileSync(setting(env, 'ORCHESTRATOR_TMUX') ?? 'tmux', ['-V'], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/*
 * The sentence step 3 ends on for a successor that does not move: its predecessor is closed, and no
 * agent, question or watch of its own is there yet to start a next turn, so it dispatches in this
 * one, or declares what it waits on when every row is blocked.
 */
export const STAY_TURN = 'Then go on to step 4 in this same turn: no agent, watch or question of yours is there yet to wake you. With no row to dispatch, declare the wait naming what you wait on.'

/** The sentence step 3 ends on when the turn's end moves this tab into the home session. */
export const HOME_STEP = ' Its end turns this tab into your home session, as the orchestrator start command does: window 0 of a tmux server of your own resumes this conversation, and every agent you spawn from there is a window of it; the agents already in tabs stay where they are. Nothing to type; still in this tab at your next turn, the move did not happen (the module\'s log says why), and that turn, which the module starts, is step 4.'

/**
 * The window of the tmux pane on a tty, read from the server (`tmux list-panes -a`): an
 * orchestrator of a home session sits in its window 0. Undefined where tmux runs no pane there, a
 * tab of iTerm2.
 */
export function tmuxWindow(tty: string): number | undefined {
  try {
    const lines = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_tty} #{window_index}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).split('\n')
    const found = lines.map(line => line.split(' ')).find(([pane]) => pane === tty)
    return found === undefined ? undefined : Number(found[1])
  } catch {
    return undefined
  }
}

/** The launcher's verb that closes the predecessor's place: `takeover` for window 0 of a home session, `close` for a tab. */
export function closeVerb(tty: string, paneWindow: (tty: string) => number | undefined): { verb: string; where: string } {
  if (tty !== 'none' && paneWindow(tty) === 0) {
    return { verb: 'takeover', where: 'window 0 of a home session: run it at once with `timeout: 600000`; it waits for the predecessor\'s « handed over » on its transcript, or five minutes of an idle transcript, says which, then kills it and moves yours to index 0' }
  }
  return { verb: 'close', where: 'a tab: first wait for its « handed over »; five minutes without it, read its screen with `screen --tty` and close on a prompt with nothing in flight, never while it may still be writing' }
}

/**
 * The record's ownership passes to the successor: the owner file names the orchestration this session
 * is, the name `dispatch-record.sh` compares, whether the predecessor is dead and whether its title
 * differs. Written in one rename; undefined when the file already names it or the session names none,
 * else the owner it replaced (empty when it had none). A write that fails is said and the takeover
 * goes on.
 */
export function takeOwnership(record: string, successor: string, io: Io): string | undefined {
  if (successor === '') return undefined
  const file = ownerFileOf(record)
  try {
    const before = orchForm((readText(file) ?? '').split('\n')[0] ?? '')
    if (before === successor) return undefined
    writeAtomic(file, `${successor}\n`, 0o644)
    return before
  } catch (error) {
    io.err(`succession: ${file} could not pass to ${successor}: ${(error as Error).message}\n`)
    return undefined
  }
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
  const launcher = join(here, '..', '..', 'iterm-agents', 'scripts', 'iterm-agent.sh')
  const prs = filePrs(env, now.getTime())
  const prState = deps.prState ?? prs.state
  const open = readOpen(request, env, deps.openPrs ?? prs.open, (deps.list ?? (() => launcherList(launcher, env)))(), prState, deps.readyHead ?? prs.ready, (deps.homes ?? (() => homePanes(env, undefined, line => io.err(`${line}\n`))))() ?? [])
  if ((open.disagree ?? 0) > 0) {
    const journal = deps.journal ?? scriptJournal(env, deps.now, line => io.err(`${line}\n`))
    writeAudit(journal, auditRun(env, now), 'failure', 'orchestrator.succession.agents', { failure: 'succession-lost-state', count: open.disagree ?? 0, prs: [] })
  }
  let installed: string | undefined
  const installedLine = (): string => (installed ??= notInstalled(parsed.worktree, env, now))
  const facts: Artifacts = { rows: all, prState, installed: installedLine, now: now.getTime() }
  const owners = ownersOf(open, blocker => fallOf(blocker, facts))
  const stray = todoStray(readText(todoPath(stateRoot(env), name)) ?? '', all)
  const project = projectOf(parsed.worktree, parsed.record)
  const close = closeVerb(parsed.tty, deps.paneWindow ?? tmuxWindow)
  const moves = deps.movesHome ?? movesHome(env)
  const text = fill(template, {
    PROJECT: project,
    MODE: parsed.mode,
    PREDECESSOR_NAME_PATTERN: name,
    AGENT_NAME_PATTERN: 'Agent: <subject>',
    STATE_DIR: stateRoot(env),
    SCRIPTS: here,
    DISPATCH_RECORD: parsed.record,
    LAUNCHER: launcher,
    PREDECESSOR_TTY: parsed.tty,
    CLOSE_VERB: close.verb,
    CLOSE_WHERE: close.where,
    HOME_STEP: moves ? HOME_STEP : '',
    TURN_END: moves ? 'END THE TURN.' : STAY_TURN,
    DISPATCH_WHEN: moves ? 'Your next turn dispatches' : 'Dispatch',
    TURN_RESULT: moves ? 'the turn ended' : 'the open rows dispatched, or the wait declared',
    LIVE_ROWS: list(rowLines(open.rows)),
    LIVE_OWNERS: list(owners),
    LIVE_PULL_REQUESTS: list(open.prs),
    LIVE_AGENTS: list((open.seats ?? []).map(agentLine)),
    LIVE_OPEN_QUESTIONS: open.questions.length === 0 ? 'none' : open.questions.map(q => `[${q.id}] ${q.text}`).join('\n\n'),
    LIVE_ANSWERED: (open.settled?.answered ?? []).map(q => `[${q.id}] ${q.label}: ${answerMeaning(q.said) || '(no answer text recorded)'}`).join('\n'),
    LIVE_REASK: (open.settled?.reask ?? []).length === 0 ? 'none' : (open.settled?.reask ?? []).map(q => `[${q.id}] ${q.said === '' ? '(no reason recorded)' : q.said}\n${q.text}`).join('\n\n'),
    LIVE_TODO: list(stray),
    PROJECT_SHEET: projectSheet(readText(goalsFileOf(parsed.record)), installedLine()),
  })
  // The text is made: only now does the record pass, so a takeover that failed above leaves the owner where it was.
  const successor = sessionOrchestration(env)
  const replaced = takeOwnership(parsed.record, successor, io)
  if (replaced !== undefined) io.err(`takeover: ${ownerFileOf(parsed.record)} passed from ${replaced === '' ? 'no owner' : replaced} to ${successor}\n`)
  io.out(text.endsWith('\n') ? text : `${text}\n`)
  io.err(`takeover: chars=${text.length} rows=${open.rows.length} ready=${owners.filter(o => o.endsWith(' READY NOT STARTED')).length} prs=${open.prs.length} agents=${open.agents.length}${open.disagree === undefined ? '' : ` agents_disagree=${open.disagree}`} questions=${open.questions.length} todo_stray=${stray.length} pruned=round:${round}\n`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2), process.env, processIo)
