// The failed calls of the store, grouped for a model to act on: every `tool_call` whose outcome is
// `error` or `refused`, one line per group, the plugins' own failures first. A group is the same
// decider (or tool), the same command and the same message once its variable parts (a repository
// and pull request, a sha, a path, a number) are normalised, so two refusals that differ by a PR
// number are one line with a count. The reading keeps a cursor, one byte offset per day file, so
// each call is read once however often the command runs; `--since` reads from a time instead and
// leaves the cursor where it is.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { update } from '../../../../core/store.ts'
import { dayFiles, eventsDir } from './store.ts'

/** The reading's cursor file, in telemetry's state directory. */
export const CURSOR_FILE = 'errors.json'
/** With no cursor and no `--since`, the reading starts this long before now. */
export const FIRST_READ_MS = 24 * 3_600_000
/** A section prints at most this many groups; the rest is counted on one line. */
export const GROUPS_SHOWN = 15
/** An example is cut to this many characters in the output (the event keeps its own bound). */
export const EXAMPLE_MAX = 240
/** A normalised message, the group's key, is cut to this. */
export const KEY_MAX = 200

/** The servers and plugins of this catalogue: a call of their tools, or of their scripts, is a plugin's. */
export const PLUGIN_NAMES: readonly string[] = ['bugs-bot', 'cloudflare', 'github', 'implement', 'learning', 'method', 'norms', 'orchestrator', 'pr-review', 'statusbar', 'telemetry']

type Fields = Record<string, unknown>
const record = (value: unknown): Fields => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {})
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** A failed call, as the group reads it. */
export interface Failure {
  readonly ts: number
  readonly session: string
  readonly outcome: string
  readonly by: string
  readonly command: string | undefined
  readonly message: string | undefined
  readonly plugin: boolean
}

/** One line of a day file as a failure, or undefined for any other event. */
export function failureOf(line: string): Failure | undefined {
  if (!line.includes('"tool_call"') || !(line.includes('"outcome":"error"') || line.includes('"outcome":"refused"'))) return undefined
  let e: Fields
  try {
    e = record(JSON.parse(line))
  } catch {
    return undefined
  }
  const outcome = text(e['outcome'])
  const ts = Date.parse(text(e['ts']) ?? '')
  if (e['event'] !== 'tool_call' || (outcome !== 'error' && outcome !== 'refused') || !Number.isFinite(ts)) return undefined
  const tool = text(e['tool']) ?? 'unknown'
  const server = text(e['mcp_server'])
  const decided = text(e['decided_by'])
  const line_ = text(record(e['bash'])['line'])
  const pluginTool = (server !== undefined && PLUGIN_NAMES.includes(server)) || (line_ !== undefined && pluginScript(line_))
  const pluginRefusal = decided !== undefined && (decided === 'plugin' || decided.startsWith('plugin:'))
  return {
    ts, session: text(e['session']) ?? '?', outcome, by: decided ?? (server ?? tool),
    command: text(e['command']), message: text(e['error_message']),
    plugin: pluginRefusal || (outcome === 'error' && pluginTool),
  }
}

/** Whether a Bash line runs a script of a plugin: by its install path, or by the plugin root variable. */
export function pluginScript(line: string): boolean {
  if (/\$\{?CLAUDE_PLUGIN_ROOT\}?/.test(line)) return true
  // A path names its plugin after `/plugins/` (a checkout, a deploy, a marketplace) or after `/cache/<marketplace>/` (an install).
  for (const shape of [/\/plugins\/([a-z0-9-]+)(?=\/)/g, /\/cache\/[^/\s]+\/([a-z0-9-]+)(?=\/)/g]) for (const named of line.matchAll(shape)) if (PLUGIN_NAMES.includes(named[1] ?? '')) return true
  return false
}

const PARTS: readonly [RegExp, string][] = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/g, '<time>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/https?:\/\/\S+/g, '<url>'],
  [/[\w.-]+\/[\w.-]+#\d+/g, '<repo>#<n>'],
  [/(?:~|\.{1,2})?(?:\/[\w.@+=,-]+){2,}\/?|~\/[\w.@+=,-]+|(?<![\w/])[\w.-]+(?:\/[\w.-]+)+/g, '<path>'],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi, '<sha>'],
  [/#\d+/g, '#<n>'],
  [/\b\d+(?:\.\d+)*\b/g, '<n>'],
]

/** A message with its variable parts replaced by a placeholder, its blanks folded: the group's key. */
export function normalise(message: string): string {
  let out = message
  for (const [pattern, mark] of PARTS) out = out.replace(pattern, mark)
  return out.replace(/\s+/g, ' ').trim().slice(0, KEY_MAX)
}

/** A group of failures that read the same. */
export interface Group {
  readonly key: string
  readonly plugin: boolean
  readonly outcome: string
  readonly by: string
  readonly command: string | undefined
  readonly normalised: string
  count: number
  first: number
  last: number
  readonly sessions: Set<string>
  readonly example: string | undefined
}

/** The failures, grouped: same class, outcome, decider, command and normalised message. */
export function group(failures: readonly Failure[]): Group[] {
  const groups = new Map<string, Group>()
  for (const f of failures) {
    const normalised = f.message === undefined ? '(no message)' : normalise(f.message)
    const key = JSON.stringify([f.plugin, f.outcome, f.by, f.command ?? '', normalised])
    const g = groups.get(key)
    if (g === undefined) {
      groups.set(key, { key, plugin: f.plugin, outcome: f.outcome, by: f.by, command: f.command, normalised, count: 1, first: f.ts, last: f.ts, sessions: new Set([f.session]), example: f.message })
    } else {
      g.count++
      g.first = Math.min(g.first, f.ts)
      g.last = Math.max(g.last, f.ts)
      g.sessions.add(f.session)
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.first - b.first)
}

const at = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace('T', ' ') + 'Z'
const oneLine = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** One group as one line: count, who, what, when, where, and one example verbatim. */
export function lineOf(g: Group): string {
  const span = g.first === g.last ? at(g.first) : `${at(g.first)} → ${at(g.last)}`
  const name = g.command === undefined ? g.by : `${g.by} ${g.command}`
  const example = g.example === undefined ? '' : ` — e.g. ${JSON.stringify(oneLine(g.example, EXAMPLE_MAX))}`
  return `${g.count}× ${g.outcome} ${name}: ${g.normalised} [${span}, ${g.sessions.size} session(s)]${example}`
}

function section(title: string, groups: readonly Group[], since: number): string[] {
  if (groups.length === 0) return []
  const shown = groups.slice(0, GROUPS_SHOWN)
  const rest = groups.slice(GROUPS_SHOWN)
  const more = rest.length === 0 ? [] : [`… ${rest.length} more group(s), ${rest.reduce((n, g) => n + g.count, 0)} call(s) (the cursor passed them: --since ${new Date(since).toISOString().slice(0, 19)}Z lists them)`]
  return [`${title} (${groups.reduce((n, g) => n + g.count, 0)} call(s), ${groups.length} group(s)):`, ...shown.map(lineOf), ...more]
}

/** The printed groups: the plugins' first, then the rest. */
export function render(failures: readonly Failure[], since: number): string[] {
  const groups = group(failures)
  const header = `errors since ${new Date(since).toISOString().slice(0, 16)}Z: ${failures.length} failed call(s)`
  if (groups.length === 0) return [`${header}`]
  return [header, ...section('plugin', groups.filter(g => g.plugin), since), ...section('other', groups.filter(g => !g.plugin), since)]
}

/** The cursor: for each day file, the bytes already read. */
interface Cursor {
  readonly offsets: Readonly<Record<string, number>>
  /** When the previous reading ran, for the header. */
  readonly readAt: number | undefined
}

function parseCursor(raw: string | undefined): Cursor | undefined {
  try {
    const parsed = record(JSON.parse(raw ?? 'null'))
    if (typeof parsed['offsets'] !== 'object' || parsed['offsets'] === null) return undefined
    const offsets = record(parsed['offsets'])
    const readAt = Date.parse(text(parsed['read_at']) ?? '')
    return {
      offsets: Object.fromEntries(Object.entries(offsets).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] >= 0)),
      readAt: Number.isFinite(readAt) ? readAt : undefined,
    }
  } catch {
    return undefined
  }
}

/** The complete lines of `buffer` from `from`, and where the last complete one ends (a line being written is left). */
function completeLines(buffer: Buffer, from: number): { lines: string[]; end: number } {
  const start = from <= buffer.length ? from : 0
  const last = buffer.lastIndexOf(0x0a)
  if (last < start) return { lines: [], end: start }
  return { lines: buffer.subarray(start, last + 1).toString('utf8').split('\n').filter(line => line !== ''), end: last + 1 }
}

export interface ErrorsInput {
  readonly stateDir: string
  readonly now: number
  /** A time to read from instead of the cursor; the cursor then stays where it is. */
  readonly since?: number | undefined
}

/** The failures a day file holds from `from` on, and where its last complete line ends. */
export function readDay(dir: string, name: string, from: number, collect: (f: Failure) => void): number {
  let buffer: Buffer
  try {
    buffer = readFileSync(join(dir, name))
  } catch (error) {
    // A day file the export removed since it was listed has nothing more to read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return from
    throw error
  }
  const { lines, end } = completeLines(buffer, from)
  for (const line of lines) {
    const f = failureOf(line)
    if (f !== undefined) collect(f)
  }
  return end
}

/**
 * The failed calls since the last reading (or since `since`), grouped. Without `since` the day
 * files are read from the cursor's offsets, the first time from 24 hours before `now`, and the
 * cursor moves to the end of what was read, under its lock, so two readers never share a call.
 */
export function errors(input: ErrorsInput): string[] {
  const dir = eventsDir(input.stateDir)
  const days = dayFiles(dir)
  const since = input.since ?? input.now - FIRST_READ_MS
  const sinceDay = new Date(since).toISOString().slice(0, 10)
  const failures: Failure[] = []
  let from = since
  const fromSince = (f: Failure): void => {
    if (f.ts >= since) failures.push(f)
  }
  if (input.since !== undefined) {
    for (const name of days.filter(day => day.slice(0, 10) >= sinceDay)) readDay(dir, name, 0, fromSince)
    return render(failures, since)
  }
  update(join(input.stateDir, CURSOR_FILE), current => {
    const cursor = parseCursor(current)
    from = cursor?.readAt ?? since
    const offsets: Record<string, number> = {}
    for (const name of days) {
      if (cursor !== undefined) offsets[name] = readDay(dir, name, cursor.offsets[name] ?? 0, f => failures.push(f))
      // A first reading looks back a day; the files before that are passed without a read of their failures.
      else offsets[name] = readDay(dir, name, 0, name.slice(0, 10) >= sinceDay ? fromSince : () => undefined)
    }
    return `${JSON.stringify({ v: 1, offsets, read_at: new Date(input.now).toISOString() })}\n`
  })
  return render(failures, from)
}
