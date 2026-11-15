// succession — the orchestrator's succession brief, generated from the state (decision 0007).
//
//   succession.sh live <brief> --next "<the next step>" [--note "<judgment>"]... [--promote <n>=<path>]...
//   succession.sh check <brief>
//   (either: [--name "<Orch: x>"] [--record <dispatch record>] [--session <id>])
//
// The orchestration's name and its dispatch record are read from the brief itself (the
// predecessor it names, its « Dispatch record » line) unless given; the session id, when given,
// also matches the round's entries written under it.
//
// `live` rewrites the brief's « Live state » from the files that hold it — the dispatch record's
// open rows and its pull request ledger (each open pull request with its repository, its number
// and who is on it), the deck's agents of this orchestrator, the round's open questions
// of this session, verbatim — and adds only what needs judgment: the next step and the notes. A
// note carries the generation it was written in; at the next generation it is promoted into an
// artifact (`--promote <n>=<path>`, the path of the decision, ruling or record it now lives in) or
// dropped, never carried: each one dropped is said on stderr. At most NOTES_MAX notes of at most
// NOTE_CHARS characters each. The brief's size is printed, the measure of the generation.
//
// `live` also brings the brief's takeover reading steps to the template's lean form (`leanSteps`): a
// standing brief keeps the orders of the template it came from, and says on stderr how many it changed.
//
// `live` then prunes the rulings and state files the brief names (`prune.ts`): what is carried
// out, superseded or older than the live summary moves to an archive beside each, never read at
// takeover; and it archives the round's entries settled over a day ago (round-archive's rule). It prints what moved and the characters a takeover reads, brief and both files,
// before and after: after, the rulings without their entries for one open item.
//
// `check` refuses (exit 1) a brief that misses an open item of the state: an open row, an open
// pull request, a running agent or a pending question, each one it misses named.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readText, writeAtomic } from '../../../core/store.ts'
import { configDir, type Env } from '../../../core/paths.ts'
import { openLine, parseRecord, stateRoot } from './dispatch-record.ts'
import { ledgerLines, prKey, statusText } from '../../../core/pr-ledger.ts'
import { isEntry, processIo, type Io } from './lib/process.ts'
import { pruneFile, pruneRulings, pruneState, readAtTakeover, type Pruned, type PruneResult } from './prune.ts'
import { recordNamedIn } from './lib/record-paths.ts'
import { auditRun, pointerOf, scriptJournal, writeAudit, type Journal } from './lib/audit.ts'
import { prRefsOf } from '../../../core/learning.ts'
import { archiveSettled } from './lib/round-archive.ts'

export const USAGE =
  'usage: succession.sh live|check <brief> [--name "<Orch: x>"] [--record <dispatch record>] [--session <id>] [--next "<text>"] [--note "<text>"]... [--promote <n>=<path>]...'

export const NOTES_MAX = 5
export const NOTE_CHARS = 300
export const HEADER = '# Orchestrator succession brief'

/** The fields of the Live state, by the start of their line in the template. */
export const FIELDS = {
  rows: '- Rows open (',
  prs: '- Pull requests open (',
  agents: '- Agents running (',
  questions: "- The operator's open questions",
  next: '- The next step:',
  owners: '- Row owners (',
  installed: '- Installed plugin (',
  notes: '- Notes of judgment (',
} as const

export interface Request {
  readonly command: 'live' | 'check'
  readonly brief: string
  readonly name: string
  readonly session: string
  readonly record: string
  readonly next: string
  readonly notes: readonly string[]
  readonly promotions: ReadonlyMap<number, string>
}

/** The request the command line makes, or the reason it is refused. */
export function parseArgs(argv: readonly string[]): Request | { readonly error: string } {
  const [command = '', brief = '', ...rest] = argv
  if (command !== 'live' && command !== 'check') return { error: USAGE }
  if (brief === '') return { error: USAGE }
  const values: Record<string, string> = {}
  const notes: string[] = []
  const promotions = new Map<number, string>()
  for (let k = 0; k < rest.length; k += 2) {
    const flag = rest[k] ?? ''
    const value = rest[k + 1]
    if (value === undefined) return { error: `${flag} needs a value` }
    if (flag === '--note') notes.push(value.trim())
    else if (flag === '--promote') {
      const match = /^([0-9]+)=(.+)$/.exec(value)
      if (!match) return { error: `--promote takes <n>=<path>, the note's number and the artifact it now lives in: ${value}` }
      promotions.set(Number(match[1]), match[2] ?? '')
    } else if (['--name', '--session', '--record', '--next'].includes(flag)) values[flag.slice(2)] = value
    else return { error: `unknown argument: ${flag} (${USAGE})` }
  }
  if (command === 'live' && !values['next']?.trim()) return { error: '--next is required: the next step is the successor\'s first decision' }
  if (notes.some(note => note === '')) return { error: 'a --note is empty' }
  if (notes.length > NOTES_MAX) return { error: `${notes.length} notes: at most ${NOTES_MAX}; promote the others into an artifact` }
  const long = notes.find(note => note.length > NOTE_CHARS)
  if (long !== undefined) return { error: `a note is ${long.length} characters, over ${NOTE_CHARS}: ${long.slice(0, 60)}…` }
  return {
    command, brief, name: values['name'] ?? '', session: values['session'] ?? '', record: values['record'] ?? '',
    next: (values['next'] ?? '').trim(), notes, promotions,
  }
}

/** One open question of the round, as the brief carries it. */
export interface Question {
  readonly id: string
  readonly text: string
}

/** What the state holds open for this orchestrator. */
export interface OpenState {
  readonly rows: readonly { readonly id: string; readonly line: string; readonly label?: string; readonly ruling?: string }[]
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

/** Reads the state this orchestrator holds open from the files that keep it. */
export function readOpen(request: Request, env: Env): OpenState {
  const state = stateRoot(env)
  const recordText = readText(request.record) ?? ''
  const rows = parseRecord(recordText).filter(row => row['state'] === 'open')
  // The ledger names each open pull request with its own repository: the deck lists numbers whose
  // repository it cannot tell, and a merged one lingers there (a ledger line is archived at its merge).
  const prs = ledgerLines(recordText).map(line => `${prKey(line.repo, line.pr)} ${statusText(line)}`)
  const { agents } = deckOpen(readText(join(state, 'deck.json')), request.name)
  const round = join(state, 'round')
  const names = existsSync(round) ? readdirSync(round).filter(name => name.endsWith('.json')).sort() : []
  return {
    rows: rows.map(row => ({ id: String(row['id']), line: openLine(row), label: String(row['label'] ?? ''), ruling: typeof row['deferred'] === 'string' ? row['deferred'] : '' })),
    prs,
    agents,
    questions: roundOpen(names.map(name => object(readText(join(round, name)))), request.name, request.session),
  }
}

/** A note as the brief keeps it: its number, the generation it was written in, its text. */
export interface Note {
  readonly generation: number
  readonly text: string
}

const GENERATION = /^<!-- generation: ([0-9]+) -->$/m
const NOTE = /\[g([0-9]+)\] (.+?)(?= · \[g[0-9]+\] |$)/g

/** The generation a brief was last written at, 0 when it never was. */
export function generationOf(brief: string): number {
  return Number(GENERATION.exec(brief)?.[1] ?? 0)
}

/** The notes a brief carries, in order. */
export function notesOf(brief: string): Note[] {
  const line = brief.split('\n').find(l => l.startsWith(FIELDS.notes))
  const value = line?.slice(line.indexOf('): ') + 3) ?? ''
  return [...value.matchAll(NOTE)].map(m => ({ generation: Number(m[1]), text: (m[2] ?? '').trim() }))
}

const list = (items: readonly string[]): string => (items.length === 0 ? 'none' : items.join('; '))

const alnum = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Who works each open row, from the facts the state holds: the agents of the deck carry the row's
 * label word as their name (`Agent: takeoverlean` for `TAKEOVERLEAN: …`, listed without its role prefix), no record names the
 * agent of a row. A deferred row reads « ruling », an open row with neither a live agent nor a
 * ruling reads « NO OWNER », so that it is seen at takeover, not found idle later.
 */
export function ownersOf(open: OpenState): string[] {
  return open.rows.map(row => {
    if ((row.ruling ?? '') !== '') return `${row.id} ruling`
    const word = alnum(/^[A-Za-z0-9]+/.exec(row.label ?? '')?.[0] ?? '')
    const agent = word.length < 3 ? undefined : open.agents.find(name => {
      const own = alnum(name.replace(/^Agent:\s*/, ''))
      return own.length >= 3 && (own.startsWith(word) || word.startsWith(own))
    })
    return `${row.id} ${agent === undefined ? 'NO OWNER' : agent.replace(/^Agent:\s*/, '')}`
  })
}

/**
 * The merged pull requests of the project's main that touch this plugin since the commit the
 * installed copy was built from, `<n> merged PRs not installed, oldest <h> h`: a git log against
 * the sha the host recorded for its install, read in the brief's worktree on its local `origin/main`
 * (no fetch). Empty where any of it cannot be read: a line is said only when it is known.
 */
export function notInstalled(brief: string, env: Env, now: Date): string {
  try {
    const worktree = /worktree `([^`{}]+)`/.exec(brief)?.[1] ?? ''
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

/** The Live state's lines, generated: each field the template names, the notes last. */
export function liveLines(open: OpenState, next: string, notes: readonly Note[], generation: number, installed = ''): Map<string, string> {
  const questions = open.questions.map(q => `[${q.id}] ${q.text}`)
  return new Map([
    [FIELDS.rows, `- Rows open (id, label, what remains): ${list(open.rows.map(row => row.line))}`],
    [FIELDS.prs, `- Pull requests open (number, head, where each stands): ${list(open.prs)}`],
    [FIELDS.agents, `- Agents running (name and reference, brief path): ${list(open.agents)}`],
    [FIELDS.questions, `- The operator's open questions, each verbatim (its \`Question i of N\` block whole), with its round entry id, or \`none\`: ${questions.length === 0 ? 'none' : questions.join('\n\n')}`],
    [FIELDS.next, `- The next step: ${next}`],
    [FIELDS.owners, `- Row owners (an open row's live agent by its label word, « ruling » for a deferred one, « NO OWNER » for neither): ${list(ownersOf(open))}`],
    ...(installed === '' ? [] : [[FIELDS.installed, `- Installed plugin (merged on main since the installed copy was built, by git log): ${installed}`] as [string, string]]),
    [FIELDS.notes, `- Notes of judgment (generation ${generation}, at most ${NOTES_MAX}; each is promoted into an artifact or dropped at the next succession): ${notes.length === 0 ? 'none' : notes.map(n => `[g${n.generation}] ${n.text}`).join(' · ')}`],
  ])
}

/**
 * The brief with its Live state rewritten: the section's prose stays, and everything from its
 * first field to the next heading is the generated fields; the generation is marked under the
 * header. The generator owns the fields: a hand edit of them is gone at the next generation.
 */
export function rewrite(brief: string, lines: ReadonlyMap<string, string>, generation: number): string | { readonly error: string } {
  const all = brief.split('\n')
  const start = all.findIndex(line => line.startsWith('## Live state'))
  if (start === -1) return { error: 'the brief has no « Live state » section: instantiate templates/orchestrator-succession-brief.md' }
  let end = all.findIndex((line, i) => i > start && /^#{1,2} /.test(line))
  if (end === -1) end = all.length
  const first = all.findIndex((line, i) => i > start && i < end && line.startsWith('- '))
  const prose = all.slice(start + 1, first === -1 ? end : first)
  while (prose.length > 0 && prose[prose.length - 1] === '') prose.pop()
  const head = all.slice(0, start + 1).filter(line => !GENERATION.test(line))
  const top = head.findIndex(line => line.startsWith(HEADER))
  head.splice(top + 1, 0, '', `<!-- generation: ${generation} -->`)
  const body = [...head, ...prose, '', ...lines.values(), '', ...all.slice(end)]
  return body.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** The successor's reference beside these scripts: an installed copy may lack it, and its pointer is then left as it is. */
const successorReference = fileURLToPath(new URL('../references/succession-successor.md', import.meta.url))

/**
 * The takeover's reading steps of a standing brief, in the form the template gives them now. A
 * standing brief is kept from one generation to the next and only its Live state is rewritten, so
 * it keeps the reading orders of the template it came from: the whole rulings file, the whole goals
 * table, every project's checkouts. Each stale order below is replaced by its lean form, the
 * rulings file read by `grep -v` on its entries for one open item, the goals without their met
 * rows, the checkouts of the brief's own project; a brief already lean is left as it is.
 */
export function leanSteps(brief: string, rulings: string, successor = true): { readonly text: string; readonly refreshed: number; readonly left: number } {
  const project = /^# Orchestrator succession brief — (.+)$/m.exec(brief)?.[1]?.trim() ?? ''
  // A title that is no `owner/name` or `name` (spaces, parentheses) is no argument of a command: that step is left alone.
  // The replacement strings read `$` as a pattern: a path carrying one is escaped.
  const lit = (value: string): string => value.replaceAll('$', '$$$$')
  const steps: [RegExp, string][] = [
    ...(rulings === '' || rulings === 'none' ? [] : [[
      /^1\. Read the rulings file WHOLE, then the rulebook and THIS brief, and nothing else whole\.$/m,
      `1. Read the rulings that bind now, \`grep -v '\\[for: ' ${lit(rulings)}\`, the rulebook and THIS brief, and nothing else whole; a \`[for: <item>]\` ruling by \`grep -n\` on its item once a task reaches it.`,
    ] as [RegExp, string]]),
    [/(dispatch-record\.sh goals [^`\n]* status)`, read whole\./, "$1 | grep -v '| met |'`."],
    ...(!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(project) ? [] : [[/Then `workspace\.sh list`:/, `Then \`workspace.sh list ${project}\`:`] as [RegExp, string]]),
    // The pointer moves only where the successor reference is installed beside these scripts; else it stays, and is counted.
    ...(successor ? [[/`references\/lifecycle\.md`, « Succession — the successor »/, '`references/succession-successor.md`, « Succession — the successor »'] as [RegExp, string]] : []),
  ]
  let text = brief
  let refreshed = 0
  for (const [stale, lean] of steps) {
    const next = text.replace(stale, lean)
    if (next !== text) refreshed++
    text = next
  }
  // A stale order worded otherwise is not rewritten: it is counted, so that the caller says it.
  const left = [/Read the rulings file WHOLE/, /goals [^`\n]* status`, read whole/, /workspace\.sh list`/, /`references\/lifecycle\.md`, « Succession/].filter(marker => marker.test(text)).length
  return { text, refreshed, left }
}

/** The open items of the state a brief does not name: each row id, pull request, agent and question id. */
export function missingItems(brief: string, open: OpenState): string[] {
  const live = liveSection(brief)
  const missing: string[] = []
  for (const row of open.rows) if (!new RegExp(`(?:open|deferred)=${row.id}\\b`).test(live)) missing.push(`dispatch row ${row.id}`)
  for (const pr of open.prs) {
    const key = pr.split(' ')[0] ?? pr
    if (!live.includes(key)) missing.push(`pull request ${key}`)
  }
  for (const agent of open.agents) if (!live.includes(agent)) missing.push(`agent ${agent}`)
  for (const question of open.questions) if (!live.includes(question.id)) missing.push(`question ${question.id}`)
  return missing
}

function liveSection(brief: string): string {
  const start = brief.indexOf('## Live state')
  if (start === -1) return ''
  const rest = brief.slice(start + 1)
  const end = rest.search(/\n#{1,2} /)
  return end === -1 ? rest : rest.slice(0, end)
}

/** The orchestration's name and dispatch record as the brief names them, when it does. */
export function namedIn(brief: string): { name: string; record: string } {
  return {
    name: /SUCCESSOR ORCHESTRATOR of `([^`{}]+)`/.exec(brief)?.[1] ?? '',
    record: recordNamedIn(brief),
  }
}

/** The rulings and state files a brief names, `~/` read as the home; '' where it names none. */
export function prunedFilesOf(brief: string, home: string): { rulings: string; state: string } {
  const path = (found: string | undefined) => (found === undefined ? '' : found.startsWith('~/') ? join(home, found.slice(2)) : found)
  return {
    rulings: path(/^- Standing rulings: `([^`{}]+)`/m.exec(brief)?.[1]),
    state: path(/state file `([^`{}]+)`/.exec(brief)?.[1]),
  }
}

function prune(path: string, how: (text: string, archive: string) => Pruned, now: Date, io: Io): PruneResult {
  if (path === '' || path === 'none') return { moved: 0, before: 0, after: 0, warnings: [] }
  const result = pruneFile(path, how, now)
  for (const warning of result.warnings) io.err(`succession: ${path}: ${warning}\n`)
  return result
}

// The round's entries settled over a day ago, moved to its archive as `round-archive` moves them:
// a move that fails is said, and the succession goes on.
function archiveRound(state: string, now: Date, io: Io): number {
  try {
    return archiveSettled(join(state, 'round'), now)
  } catch (error) {
    io.err(`succession: ${(error as Error).message}\n`)
    return 0
  }
}

export function main(argv: readonly string[], env: Env, io: Io, now: () => Date = () => new Date(), journal?: Journal): number {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    io.err(`succession: ${parsed.error}\n`)
    return 2
  }
  const brief = readText(parsed.brief)
  if (brief === undefined || !brief.startsWith(HEADER)) {
    io.err(`succession: ${parsed.brief} is no orchestrator succession brief (its first line is « ${HEADER} — <project> »)\n`)
    return 2
  }
  const named = namedIn(brief)
  const request: Request = { ...parsed, name: parsed.name || named.name, record: parsed.record || named.record }
  if (request.name === '' || request.record === '') {
    io.err(`succession: the brief names no ${request.name === '' ? 'predecessor (« SUCCESSOR ORCHESTRATOR of `<name>` »)' : '« Dispatch record » path'}: pass --${request.name === '' ? 'name' : 'record'}\n`)
    return 2
  }
  const open = readOpen(request, env)
  if (request.command === 'check') {
    const missing = missingItems(brief, open)
    if (missing.length === 0) {
      io.out(`complete: ${open.rows.length} rows, ${open.prs.length} pull requests, ${open.agents.length} agents, ${open.questions.length} questions\n`)
      return 0
    }
    for (const item of missing) io.err(`succession: the brief misses ${item}: run succession.sh live\n`)
    // A brief that would hand over less than the state holds: the method's failure, counted, its words left out.
    const pointer = pointerOf(resolve(parsed.brief), env)
    writeAudit(journal, auditRun(env, now()), 'failure', 'orchestrator.succession.lost-state',
      { failure: 'succession-lost-state', count: missing.length, prs: prRefsOf(missing.join(' ')) },
      { evidence: pointer === null ? [] : [{ type: 'record', path: pointer }] })
    return 1
  }
  const generation = generationOf(brief) + 1
  const old = notesOf(brief)
  for (const [n, path] of request.promotions) {
    if (n < 1 || n > old.length) {
      io.err(`succession: --promote ${n}: the brief carries ${old.length} notes\n`)
      return 2
    }
    if (!existsSync(path)) {
      io.err(`succession: --promote ${n}=${path}: no such artifact\n`)
      return 2
    }
  }
  old.forEach((note, i) => {
    const promoted = request.promotions.get(i + 1)
    io.err(promoted === undefined
      ? `succession: note ${i + 1} of generation ${note.generation} dropped: ${note.text}\n`
      : `succession: note ${i + 1} of generation ${note.generation} promoted to ${promoted}\n`)
  })
  const notes = request.notes.map(text => ({ generation, text }))
  const written = rewrite(brief, liveLines(open, request.next, notes, generation, notInstalled(brief, env, now())), generation)
  if (typeof written !== 'string') {
    io.err(`succession: ${written.error}\n`)
    return 2
  }
  const files = prunedFilesOf(written, env['HOME'] ?? '')
  const lean = leanSteps(written, files.rulings, existsSync(successorReference))
  writeAtomic(request.brief, lean.text)
  if (lean.refreshed > 0) io.err(`succession: ${lean.refreshed} reading step(s) of the brief brought to the template's lean form\n`)
  if (lean.left > 0) io.err(`succession: ${lean.left} reading step(s) of the brief still follow an older template (whole rulings, whole goals, every checkout or the lifecycle.md pointer): word them as templates/orchestrator-succession-brief.md does\n`)
  // A ruling for rows all closed in the dispatch record is carried out: it moves as a `done` one.
  const closed = new Set(parseRecord(readText(request.record) ?? '').filter(row => row['state'] === 'closed').map(row => Number(row['id'])))
  const rulings = prune(files.rulings, (text, archive) => pruneRulings(text, archive, closed), now(), io)
  const state = prune(files.state, pruneState, now(), io)
  const round = archiveRound(stateRoot(env), now(), io)
  // Before: the rulings file read whole. After: the part a takeover reads, its entries for one open item left out.
  const read = files.rulings === '' || files.rulings === 'none' ? 0 : readAtTakeover(readText(files.rulings) ?? '').length
  const takeover = (side: 'before' | 'after') => lean.text.length + (side === 'before' ? rulings.before : read) + state[side]
  io.out(`generation=${generation} chars=${lean.text.length} rows=${open.rows.length} prs=${open.prs.length} agents=${open.agents.length} questions=${open.questions.length} notes=${notes.length} pruned=rulings:${rulings.moved},state:${state.moved},round:${round} takeover_chars=${takeover('before')}->${takeover('after')}\n`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2), process.env, processIo, () => new Date(), scriptJournal(process.env, () => new Date(), line => processIo.err(`${line}\n`)))
