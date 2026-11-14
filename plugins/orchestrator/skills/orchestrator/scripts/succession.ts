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
// open rows, the deck's pull requests and agents of this orchestrator, the round's open questions
// of this session, verbatim — and adds only what needs judgment: the next step and the notes. A
// note carries the generation it was written in; at the next generation it is promoted into an
// artifact (`--promote <n>=<path>`, the path of the decision, ruling or record it now lives in) or
// dropped, never carried: each one dropped is said on stderr. At most NOTES_MAX notes of at most
// NOTE_CHARS characters each. The brief's size is printed, the measure of the generation.
//
// `live` then prunes the rulings and state files the brief names (`prune.ts`): what is carried
// out, superseded or older than the live summary moves to an archive beside each, never read at
// takeover; and it archives the round's entries settled over a day ago (round-archive's rule). It prints what moved and the characters a takeover reads, brief and both files,
// before and after: after, the rulings without their entries for one open item.
//
// `check` refuses (exit 1) a brief that misses an open item of the state: an open row, an open
// pull request, a running agent or a pending question, each one it misses named.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readText, writeAtomic } from '../../../core/store.ts'
import type { Env } from '../../../core/paths.ts'
import { openLine, parseRecord, stateRoot } from './dispatch-record.ts'
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
  readonly rows: readonly { readonly id: string; readonly line: string }[]
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
  const rows = parseRecord(readText(request.record) ?? '').filter(row => row['state'] === 'open')
  const { prs, agents } = deckOpen(readText(join(state, 'deck.json')), request.name)
  const round = join(state, 'round')
  const names = existsSync(round) ? readdirSync(round).filter(name => name.endsWith('.json')).sort() : []
  return {
    rows: rows.map(row => ({ id: String(row['id']), line: openLine(row) })),
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

/** The Live state's lines, generated: each field the template names, the notes last. */
export function liveLines(open: OpenState, next: string, notes: readonly Note[], generation: number): Map<string, string> {
  const questions = open.questions.map(q => `[${q.id}] ${q.text}`)
  return new Map([
    [FIELDS.rows, `- Rows open (id, label, what remains): ${list(open.rows.map(row => row.line))}`],
    [FIELDS.prs, `- Pull requests open (number, head, where each stands): ${list(open.prs)}`],
    [FIELDS.agents, `- Agents running (name and reference, brief path): ${list(open.agents)}`],
    [FIELDS.questions, `- The operator's open questions, each verbatim (its \`Question i of N\` block whole), with its round entry id, or \`none\`: ${questions.length === 0 ? 'none' : questions.join('\n\n')}`],
    [FIELDS.next, `- The next step: ${next}`],
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

/** The open items of the state a brief does not name: each row id, pull request, agent and question id. */
export function missingItems(brief: string, open: OpenState): string[] {
  const live = liveSection(brief)
  const missing: string[] = []
  for (const row of open.rows) if (!new RegExp(`(?:open|deferred)=${row.id}\\b`).test(live)) missing.push(`dispatch row ${row.id}`)
  for (const pr of open.prs) if (!live.includes(pr.split(' ')[0] ?? pr)) missing.push(`pull request ${pr}`)
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
  const written = rewrite(brief, liveLines(open, request.next, notes, generation), generation)
  if (typeof written !== 'string') {
    io.err(`succession: ${written.error}\n`)
    return 2
  }
  writeAtomic(request.brief, written)
  const files = prunedFilesOf(written, env['HOME'] ?? '')
  // A ruling for rows all closed in the dispatch record is carried out: it moves as a `done` one.
  const closed = new Set(parseRecord(readText(request.record) ?? '').filter(row => row['state'] === 'closed').map(row => Number(row['id'])))
  const rulings = prune(files.rulings, (text, archive) => pruneRulings(text, archive, closed), now(), io)
  const state = prune(files.state, pruneState, now(), io)
  const round = archiveRound(stateRoot(env), now(), io)
  // Before: the rulings file read whole. After: the part a takeover reads, its entries for one open item left out.
  const read = files.rulings === '' || files.rulings === 'none' ? 0 : readAtTakeover(readText(files.rulings) ?? '').length
  const takeover = (side: 'before' | 'after') => written.length + (side === 'before' ? rulings.before : read) + state[side]
  io.out(`generation=${generation} chars=${written.length} rows=${open.rows.length} prs=${open.prs.length} agents=${open.agents.length} questions=${open.questions.length} notes=${notes.length} pruned=rulings:${rulings.moved},state:${state.moved},round:${round} takeover_chars=${takeover('before')}->${takeover('after')}\n`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2), process.env, processIo, () => new Date(), scriptJournal(process.env, () => new Date(), line => processIo.err(`${line}\n`)))
