// The round's archive: round-archive moves the entries of <state>/round/ settled over a day ago into
// round/archive/ (archiveSettled, in the orchestrator's scripts/lib/round-archive.ts, which
// succession.sh takeover runs too). The entries are the hooks
// module's (hooks/round.ts, hooks/question.ts), each moved under the lock the module writes it under.
// A question is closed by the module's `settle` tool, no longer by a command here.
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROUND_DIR } from '../../../core/orchestration.ts'
import { setting } from '../../../core/paths.ts'
import { isTemporary } from '../../../core/store-io.ts'
import { update } from '../../../core/store.ts'
import { ArchiveError, archiveSettled, DAY_MS } from '../../orchestrator/scripts/lib/round-archive.ts'
import { die, moduleOf, say, stateOf, type Context } from './context.ts'
import { recordedCoordinator } from './record.ts'

export { parseEntry } from '../../orchestrator/scripts/lib/round-archive.ts'

export function roundArchive(ctx: Context, args: readonly string[]): number {
  if (args.length > 0) die(`round-archive: unexpected argument ${args[0]}`)
  const round = join(stateOf(ctx.env), ROUND_DIR)
  let moved: number
  try {
    moved = archiveSettled(round, ctx.now())
  } catch (error) {
    if (error instanceof ArchiveError) die(error.message)
    throw error
  }
  let names: string[]
  try {
    names = readdirSync(round).sort()
  } catch {
    names = []
  }
  // A write that died between its temporary file and the rename leaves the temporary behind;
  // one a day old is no write in flight.
  const now = ctx.now().getTime()
  for (const name of names) {
    if (!isTemporary(name)) continue
    const path = join(round, name)
    try {
      const stat = statSync(path)
      if (stat.isFile() && now - stat.mtimeMs > DAY_MS) rmSync(path, { force: true })
    } catch {
      // Gone meanwhile, or unreadable: nothing to remove.
    }
  }
  ctx.out(`archived ${moved}`)
  return 0
}

// --- The round's listing. --------------------------------------------------------------------
// `round` prints the entries still to be ruled, in the round's order; coordinator.sh's header
// documents its lines. The entries are read from <state>/round/<id>.json, one per file, written by
// the hooks module; a file that does not parse is skipped.

type Entry = Record<string, unknown>

function isObject(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `a // b`: b when a is absent, null or false. */
function or(value: unknown, fallback: unknown): unknown {
  return value === undefined || value === null || value === false ? fallback : value
}

/** A value as a string interpolation writes it: text as it is, anything else as JSON. */
function shown(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null)
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function isFileAt(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The names of the plain files of `dir` (no dot file) in byte order. */
function namesOf(dir: string): string[] {
  try {
    return readdirSync(dir).filter(name => !name.startsWith('.')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  } catch {
    return []
  }
}

/**
 * The entry one file holds, or undefined. A question asked with `ask` (hooks/question.ts, `v` 2) is
 * read as an entry: its sender's name and session, its stamp for its start, its block written from
 * its fields. One claimed by the operator's prompt in its asker's tab has left the pane until that
 * turn's end: it is no entry.
 */
export function entryOf(value: unknown): Entry | undefined {
  if (!isObject(value)) return undefined
  let entry = value
  if (value['v'] === 2 && isObject(value['claimed'])) return undefined
  if (value['v'] === 2 && isObject(value['sender'])) {
    const sender = value['sender']
    const choices = value['choices']
    if (choices !== undefined && choices !== null && !Array.isArray(choices)) return undefined
    const lines = [`_Subject_ : ${shown(value['subject'])}`, `_Context_ : ${shown(value['context'])}`, `_Question_ : ${shown(value['ask'])}`]
    if (Array.isArray(choices) && choices.length > 0) {
      if (!choices.every(c => isObject(c) || c === null)) return undefined
      lines.push('_Choices_ :', ...choices.map(c => `- **${shown(isObject(c) ? c['letter'] : null)}** : ${shown(isObject(c) ? c['text'] : null)}`))
    }
    const why = value['why']
    const recommended = value['recommended']
    if (typeof why === 'string') lines.push(`_Recommendation_ : ${typeof recommended === 'string' ? `${recommended} — ` : ''}${why}`)
    entry = { ...value, from: sender['name'], session: sender['session'], kind: 'operator', since: value['at'], question: lines.join('\n') }
  }
  const textual = ['id', 'from', 'since', 'status', 'kind', 'question'].every(key => typeof entry[key] === 'string')
  return textual ? entry : undefined
}

/** Every entry of the round directory, in the order of its files. */
export function roundEntries(round: string): Entry[] {
  const entries: Entry[] = []
  for (const name of namesOf(round)) {
    if (!name.endsWith('.json') || !isFileAt(join(round, name))) continue
    const entry = entryOf(readJson(join(round, name)))
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

const text = (entry: Entry, key: string): string => shown(entry[key])

/** Byte order of the sort keys, the first that differs deciding. */
function compareKeys(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? ''
    const y = b[i] ?? ''
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Grouped by sender, the groups by their earliest wait, each in the order its waits began. */
function grouped(entries: readonly Entry[]): Entry[] {
  const first = new Map<string, string>()
  for (const e of [...entries].sort((a, b) => compareKeys([text(a, 'since')], [text(b, 'since')]))) {
    if (!first.has(text(e, 'from'))) first.set(text(e, 'from'), text(e, 'since'))
  }
  const key = (e: Entry) => [first.get(text(e, 'from')) ?? '', text(e, 'from'), text(e, 'since'), text(e, 'id')]
  return [...entries].sort((a, b) => compareKeys(key(a), key(b)))
}

/** The round order: the urgent first, then the others, each level grouped by sender. */
export function ordered(entries: readonly Entry[]): Entry[] {
  return [...grouped(entries.filter(e => e['urgent'] === true)), ...grouped(entries.filter(e => e['urgent'] !== true))]
}

/** The session ids of the module's sessions files, as the module names them. */
function liveSessions(module: string): Set<string> {
  const names = new Set<string>()
  const walk = (dir: string) => {
    let found: string[]
    try {
      found = readdirSync(dir)
    } catch {
      return
    }
    for (const name of found) {
      const path = join(dir, name)
      try {
        const stat = statSync(path)
        if (stat.isDirectory()) walk(path)
        else if (stat.isFile() && !name.includes('.tmp-')) names.add(name)
      } catch {
        // Gone meanwhile.
      }
    }
  }
  walk(join(module, 'store', 'sessions'))
  return names
}

/** The machine each remote row of the module's store names, by its orchestrator's name. */
function remoteMachines(module: string): Map<string, string> {
  const machines = new Map<string, string>()
  const store = join(module, 'store', 'remote')
  for (const name of namesOf(store)) {
    if (name.includes('.tmp-') || !isFileAt(join(store, name))) continue
    const row = readJson(join(store, name))
    if (isObject(row) && typeof row['name'] === 'string' && typeof row['machine'] === 'string') machines.set(row['name'], row['machine'])
  }
  return machines
}

/**
 * Whether the coordinator's pane is open, from <state>/pane.json ({"session","pid","tty","at"}),
 * kept by the hooks module while it is: open while that pid still runs a session, as
 * hooks/supervision.ts runsLive reads it — listed, neither exiting (an E among its state flags)
 * nor a zombie, and on the record's tty when it names one. COORDINATOR_PS_TABLE, when the suite
 * gives one, is a file of lines starting with a pid (the pid alone judges).
 */
export function paneOpen(ctx: Context, state: string): boolean {
  const pane = readJson(join(state, 'pane.json'))
  if (!isObject(pane)) return false
  const pid = shown(or(pane['pid'], ''))
  if (!/^[0-9]+$/.test(pid)) return false
  const table = setting(ctx.env, 'COORDINATOR_PS_TABLE')
  if (table !== undefined) {
    let rows: string
    try {
      rows = readFileSync(table, 'utf8')
    } catch {
      return false
    }
    return rows.split('\n').some(row => row.trim().split(/[ \t]+/)[0] === pid)
  }
  const tty = shown(or(pane['tty'], '')).replace(/^\/dev\//, '')
  const ps = ctx.run('ps', ['-p', pid, '-o', 'stat=,tty='])
  if (ps.status !== 0) return false
  const [stat = '', listed = ''] = ps.stdout.trim().split(/\s+/)
  const flags = stat.replace(/^\?+/, '')
  if (stat === '' || flags.startsWith('Z') || flags.includes('E')) return false
  return tty === '' || listed === '' || listed === tty
}

type View = { readonly pane: boolean; readonly text: boolean; readonly live: Set<string>; readonly remote: Map<string, string> }

/** Whether an open entry is due: an operator question its sender marked urgent, or any while no pane is open. */
const isDue = (entry: Entry, view: View): boolean => entry['status'] === 'open' && entry['kind'] === 'operator' && (entry['urgent'] === true || !view.pane)

/** Whether its question is printed: a due one, a closing proposal, or every one when asked whole. */
const presents = (entry: Entry, view: View): boolean => view.text || isDue(entry, view) || entry['kind'] !== 'operator'

/** The lines of one entry: its header, then its question and its close when they are printed. */
export function entryLines(entry: Entry, view: View): string[] {
  const from = text(entry, 'from')
  const machine = isObject(entry['origin']) ? view.remote.get(from) : undefined
  const session = entry['session']
  const gone = isObject(entry['origin'])
    ? machine === undefined
    : typeof session === 'string' && session !== '' && !view.live.has(session.replace(/[^A-Za-z0-9._-]/gu, '_'))
  const due = isDue(entry, view)
  const where = machine !== undefined ? ` | remote on ${machine}` : gone ? ' | sender gone' : ''
  const lines = [`round ${text(entry, 'id')} | ${text(entry, 'kind')} | from ${from} | since ${text(entry, 'since')} | blocks: ${shown(or(entry['blocks'], '-'))} | ${text(entry, 'status')}${due ? ' | due' : ''}${where}`]
  const question = text(entry, 'question')
  if (presents(entry, view) && question !== '') lines.push(...question.split('\n').map(line => `    ${line}`))
  const answer = isObject(entry['answer']) ? entry['answer'] : {}
  const at = shown(or(answer['at'], '?'))
  const said = shown(or(answer['text'], ''))
  const by = answer['by']
  if (entry['status'] === 'answered') lines.push(`    answered from the pane at ${at}: ${said}`)
  if (entry['status'] === 'withdrawn' && by === 'sender') {
    const why = typeof answer['text'] === 'string' && answer['text'] !== '' ? answer['text'] : 'a later turn the operator typed in waits on something else'
    lines.push(`    withdrawn by the sender at ${at}: ${why}`)
  }
  if (entry['status'] === 'withdrawn' && by === 'tab') {
    const typed = answer['typed']
    lines.push(`    withdrawn in the sender's tab at ${at}: ${said}${typeof typed === 'string' && typed !== '' ? ` — he typed: ${typed.replace(/\s*\n\s*/g, ' ')}` : ''}`)
  }
  if (entry['status'] === 'withdrawn' && isObject(entry['answer']) && by !== 'sender' && by !== 'tab') lines.push(`    withdrawn by ${shown(or(by, '?'))} at ${at}: ${said}`)
  return lines
}

/**
 * The ids of the open entries whose question `round` printed, kept in <state>/round-listed.json
 * beside those it printed before, and only while the round still holds them. The hooks module
 * reads it: an entry the coordinator was shown and that is then settled is reported to it at once,
 * so it never asks it again. An entry printed as its header alone is the pane's: its settling wakes
 * no one. A write that fails is said and changes nothing of what round printed.
 */
export function recordListed(ctx: Context, state: string, entries: readonly Entry[], view: View): void {
  const listed = join(state, 'round-listed.json')
  const present = new Set(entries.map(e => text(e, 'id')))
  const open = entries.filter(e => e['status'] === 'open' && presents(e, view)).map(e => text(e, 'id'))
  try {
    // Read and rewritten under the store's lock: two listings at once each keep the other's ids.
    update(listed, current => {
      const was = parsed(current)
      const before = Array.isArray(was) ? was.filter((id): id is string => typeof id === 'string') : []
      const ids = [...new Set([...before, ...open])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).filter(id => present.has(id))
      return `${JSON.stringify(ids)}\n`
    })
  } catch {
    say(ctx, `round: cannot record the listed entries in ${listed}`)
  }
}

function parsed(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

export function round(ctx: Context, args: readonly string[]): number {
  let all = false
  let full = false
  let decide = false
  let me: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--all') all = full = true
    // The decision round asks for it: the one order, every question's text.
    else if (arg === '--by-urgency') full = true
    else if (arg === '--decide') decide = true
    else if (arg === '--as') {
      const value = args[++i]
      if (value === undefined || value.startsWith('--')) die('round: --as needs a value')
      if (me !== undefined) die('round: --as is given once')
      me = value.trim()
    } else die(`round: unexpected argument ${arg}`)
  }
  if (me !== undefined && !decide) die('round: --as goes with --decide')
  if (decide && all) die('round: --decide takes no --all')
  if (decide && (me === undefined || me === '')) die('round: --decide needs --as "<your exact name and reference>"')
  if (decide) return decideRound(ctx, me ?? '')
  const state = stateOf(ctx.env)
  const module = moduleOf(ctx.env)
  const dir = join(state, ROUND_DIR)
  // One read of the round for the print and its record: an entry opened between two reads would
  // be recorded as shown though it was never printed.
  const entries = roundEntries(dir)
  const view = { pane: paneOpen(ctx, state), text: full, live: liveSessions(module), remote: remoteMachines(module) }
  // The settled entries are counted in one line, and printed only on --all.
  const settled = (['answered', 'withdrawn'] as const)
    .map(status => [status, entries.filter(e => e['status'] === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`)
  if (!all && settled.length > 0) ctx.out(`settled: ${settled.join(', ')} (round --all prints them)`)
  for (const status of all ? ['open', 'answered', 'withdrawn'] : ['open']) {
    for (const entry of ordered(entries.filter(e => e['status'] === status))) entryLines(entry, view).forEach(line => ctx.out(line))
  }
  if (isDir(dir)) recordListed(ctx, state, entries, view)
  return 0
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * `round --decide [--as <name>]`, the operator's decide machine-wide: its first line says where it
 * runs. The live coordinator's own session (named by `--as`) reads the round as `round --by-urgency`
 * prints it; any other session, while a coordinator is live, is told where to run it; with none
 * live, the open operator entries of every session of the machine are listed in the round's order,
 * or one line says there are none.
 */
function decideRound(ctx: Context, me: string): number {
  // A record naming no pid cannot be judged by the hooks module, which counts it live: so does the
  // decide, or it would list entries `settle` then refuses.
  const recorded = recordedCoordinator(ctx)
  const coordinator = recorded !== undefined && recorded.name !== '' && (recorded.live || recorded.pid === '') ? recorded : undefined
  if (coordinator !== undefined && coordinator.name !== me) {
    ctx.out(`decide: elsewhere | ${coordinator.name} | ${coordinator.tty}`)
    return 0
  }
  if (coordinator !== undefined) {
    ctx.out('decide: coordinator')
    return round(ctx, ['--by-urgency'])
  }
  const state = stateOf(ctx.env)
  const open = ordered(roundEntries(join(state, ROUND_DIR)).filter(e => e['status'] === 'open' && e['kind'] === 'operator'))
  if (open.length === 0) {
    ctx.out('decide: empty | no open question')
    return 0
  }
  const module = moduleOf(ctx.env)
  const view = { pane: paneOpen(ctx, state), text: true, live: liveSessions(module), remote: remoteMachines(module) }
  ctx.out(`decide: machine | ${open.length} open`)
  for (const entry of open) entryLines(entry, view).forEach(line => ctx.out(line))
  return 0
}
