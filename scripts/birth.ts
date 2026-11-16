// The sessions' birth: the context each session's first model call carried, read from the
// transcripts the host keeps (`<config>/projects/*/<session>.jsonl`), by role, and what the
// context was made of. A measure counts only the sessions born after the last deploy of what it
// judges (`installed.json`'s history), and is set against the oldest sessions the transcripts keep
// and against the sessions between the first deploy record and that deploy.
//
//   npm run birth                       every role, since the last deploy of the catalogue
//   npm run birth -- --plugin <name>    since the last deploy that changed plugins/<name>
//   --projects <dir> --state <file>     another transcripts directory, another deploy record
//   --baseline <n>                      the oldest <n> sessions of a role (default 30)
//
// What a transcript gives and telemetry's `first_turn` does not: the tokens of the first call
// (input, cache read and cache write), and the attachments the host put in front of it. What it does
// not give, the host's own system prompt and tool schemas, is the remainder.
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { parseArgs } from 'node:util'
import { DEPLOY_MARKETPLACE, DEPLOY_STATE_FILE, DEPLOYS_DIR, parseDeployState, type Installed } from '../packages/core/src/deploy-state.ts'
import { roleOf, type Role } from '../packages/core/src/names.ts'
import { configDir } from '../packages/core/src/paths.ts'
import { processIo, type Io } from './lib/io.ts'
import { isEntry, isRecord, PLUGINS_DIR } from './lib/plugins.ts'
import { estimateTokens } from './prompts.ts'

/** What a transcript's attachments put in front of the first call, one entry each. */
export const PARTS = ['instructions', 'skills', 'agents', 'mcp', 'deferred', 'hooks'] as const
export type Part = (typeof PARTS)[number]
export type Kind = Role | 'plain'

/** The owner of a listing line that names no plugin: the host's, or the operator's own. */
export const BARE = '(no plugin)'
export const BASELINE_SIZE = 30
const CHUNK = 64 * 1024

export interface Birth {
  readonly session: string
  /** The first call's time, ISO 8601 UTC. */
  readonly at: string
  readonly role: Kind
  /** The first call's input: fresh, read from the cache and written to it. */
  readonly tokens: number
  readonly parts: Readonly<Record<Part, number>>
  /** Tokens of the skill, agent and MCP listings by owner: a plugin's name, or `BARE`. */
  readonly shares: Readonly<Record<string, number>>
}

const OWNED_LINE = /^- ([a-z0-9][a-z0-9-]*):[a-z0-9][a-z0-9-]*: /
const MCP_BLOCK = /^## (\S+)/

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** The text units an attachment carries and the part they belong to; nothing for any other kind. */
function unitsOf(attachment: Record<string, unknown>): { part: Part; units: string[] } | undefined {
  switch (attachment['type']) {
    case 'skill_listing': return { part: 'skills', units: strings(attachment['content']).flatMap(text => text.split(/\n(?=- )/)) }
    case 'agent_listing_delta': return { part: 'agents', units: strings(attachment['addedLines']) }
    case 'mcp_instructions_delta': return { part: 'mcp', units: strings(attachment['addedBlocks']) }
    case 'deferred_tools_delta': return { part: 'deferred', units: strings(attachment['addedLines']) }
    case 'hook_additional_context': return { part: 'hooks', units: strings(attachment['content']) }
    case 'instructions': {
      const files = attachment['files']
      return { part: 'instructions', units: Array.isArray(files) ? files.flatMap(file => (isRecord(file) ? strings(file['content']) : [])) : [] }
    }
    default: return undefined
  }
}

function ownerOf(part: Part, unit: string): string | undefined {
  if (part === 'mcp') return MCP_BLOCK.exec(unit)?.[1] ?? BARE
  if (part === 'skills' || part === 'agents') return OWNED_LINE.exec(unit)?.[1] ?? BARE
  return undefined
}

function usageTokens(message: unknown): number {
  const usage = isRecord(message) ? message['usage'] : undefined
  if (!isRecord(usage)) return 0
  let sum = 0
  for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isFinite(value)) sum += value
  }
  return sum
}

/**
 * The birth of the session whose transcript's lines `lines` yields, read up to its first model call
 * of its own loop; undefined for a session that never called the model. A line before that call
 * that is not a JSON object throws: the figures would be a later call's, or short of an attachment.
 */
export function parseBirth(session: string, lines: Iterable<string>): Birth | undefined {
  let title: string | undefined
  const parts: Record<Part, number> = { instructions: 0, skills: 0, agents: 0, mcp: 0, deferred: 0, hooks: 0 }
  const shares: Record<string, number> = {}
  for (const line of lines) {
    let entry: unknown
    try { entry = JSON.parse(line) } catch { throw new Error(`${session}: a line before the first model call is not JSON`) }
    if (!isRecord(entry)) throw new Error(`${session}: a line before the first model call is not an object`)
    if (entry['type'] === 'custom-title' && title === undefined && typeof entry['customTitle'] === 'string') title = entry['customTitle']
    if (entry['type'] === 'attachment' && isRecord(entry['attachment'])) {
      const found = unitsOf(entry['attachment'])
      if (found === undefined) continue
      for (const unit of found.units) {
        const tokens = estimateTokens(unit)
        parts[found.part] += tokens
        const owner = ownerOf(found.part, unit)
        if (owner !== undefined) shares[owner] = (shares[owner] ?? 0) + tokens
      }
      continue
    }
    if (entry['type'] !== 'assistant' || entry['isSidechain'] === true) continue
    const tokens = usageTokens(entry['message'])
    const at = entry['timestamp']
    if (tokens === 0 || typeof at !== 'string') continue
    return { session, at, role: roleOf(title ?? null) ?? 'plain', tokens, parts, shares }
  }
  return undefined
}

/** A file's lines, read in chunks, so a caller that stops early never reads a long transcript whole. */
export function* headLines(path: string): Generator<string> {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(CHUNK)
    const decoder = new StringDecoder('utf8')
    let rest = ''
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK, null)
      if (read === 0) break
      rest += decoder.write(buffer.subarray(0, read))
      const cut = rest.lastIndexOf('\n')
      if (cut < 0) continue
      const complete = rest.slice(0, cut).split('\n')
      rest = rest.slice(cut + 1)
      yield* complete
    }
    rest += decoder.end()
    if (rest !== '') yield rest
  } finally {
    closeSync(fd)
  }
}

/** The births read, and the sessions left out: those whose transcript could not be read, those with no model call. */
export interface Births {
  readonly births: Birth[]
  readonly unreadable: number
  readonly withoutCall: number
}

/** Every session of `<projects>/<dir>/<session>.jsonl`, its birth read; a subagent's transcript is deeper and left out. */
export function readBirths(projects: string): Births {
  const births: Birth[] = []
  let unreadable = 0
  let withoutCall = 0
  for (const dir of readdirSync(projects, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    for (const file of readdirSync(join(projects, dir.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
      try {
        const birth = parseBirth(file.name.slice(0, -'.jsonl'.length), headLines(join(projects, dir.name, file.name)))
        if (birth === undefined) withoutCall++
        else births.push(birth)
      } catch {
        unreadable++
      }
    }
  }
  return { births: births.sort(byTime), unreadable, withoutCall }
}

/** Instants compared as instants: `…:02Z` and `…:02.500Z` do not sort as strings. */
const instant = (iso: string): number => Date.parse(iso)
const byTime = (a: { readonly at: string }, b: { readonly at: string }): number => instant(a.at) - instant(b.at)

/** Strings in code-point order, whatever the locale. */
const plain = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  const value = sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  return value === undefined ? undefined : Math.round(value)
}

export type Period = 'baseline' | 'before' | 'after'
export const PERIODS: readonly Period[] = ['baseline', 'before', 'after']

/**
 * The births in three groups: the oldest `size` of each role among those born before the first
 * deploy record `start`; those born from it up to `cut`; those born at or after `cut`.
 */
export function periods(births: readonly Birth[], start: string, cut: string, size: number): Record<Period, Birth[]> {
  const out: Record<Period, Birth[]> = { baseline: [], before: [], after: [] }
  const seen = new Map<Kind, number>()
  for (const birth of [...births].sort(byTime)) {
    if (instant(birth.at) < instant(start)) {
      const rank = seen.get(birth.role) ?? 0
      seen.set(birth.role, rank + 1)
      if (rank < size) out.baseline.push(birth)
    } else if (instant(birth.at) < instant(cut)) out.before.push(birth)
    else out.after.push(birth)
  }
  return out
}

/** The remainder of a birth: the host's system prompt and tool schemas, and the first prompt; negative where the parts' estimate exceeds the call's real count. */
export function remainder(birth: Birth): number {
  return birth.tokens - PARTS.reduce((sum, part) => sum + birth.parts[part], 0)
}

const cell = (values: readonly number[]): string => {
  const value = median(values)
  return value === undefined ? '—' : `${value} (${values.length})`
}

const head = (label: string): string[] => [`| ${label} | oldest sessions | before the last deploy | after the last deploy |`, '|---|---:|---:|---:|']

function row(label: string, groups: Record<Period, Birth[]>, pick: (birth: Birth) => number, only?: (birth: Birth) => boolean): string {
  const cells = PERIODS.map(period => cell(groups[period].filter(birth => only?.(birth) ?? true).map(pick)))
  return `| ${label} | ${cells.join(' | ')} |`
}

/** The report as markdown lines: each cell is the median, then the number of sessions in brackets. */
export function report(groups: Record<Period, Birth[]>, cut: string, subject: string): string[] {
  const roles = [...new Set(PERIODS.flatMap(period => groups[period].map(birth => birth.role)))].sort()
  const owners = new Set<string>()
  for (const period of PERIODS) for (const birth of groups[period]) for (const owner of Object.keys(birth.shares)) owners.add(owner)
  const share = (owner: string) => median(groups.after.map(birth => birth.shares[owner] ?? 0)) ?? 0
  const lines = [`Last deploy of ${subject}: ${cut} (UTC). Median tokens of the first model call, sessions in brackets.`, '']
  lines.push(...head('role'))
  for (const role of roles) lines.push(row(role, groups, birth => birth.tokens, birth => birth.role === role))
  lines.push('', ...head('role, without the project\'s instructions'))
  for (const role of roles) lines.push(row(role, groups, birth => birth.tokens - birth.parts.instructions, birth => birth.role === role))
  lines.push('', ...head('part, every role'))
  for (const part of PARTS) lines.push(row(part, groups, birth => birth.parts[part]))
  lines.push(row('host prompt, tool schemas, first prompt', groups, remainder))
  lines.push('', ...head('owner of the skill, agent and MCP listings'))
  for (const owner of [...owners].filter(name => share(name) > 0 || PERIODS.some(period => groups[period].some(birth => (birth.shares[name] ?? 0) > 0))).sort((a, b) => share(b) - share(a) || plain(a, b))) {
    lines.push(row(owner, groups, birth => birth.shares[owner] ?? 0))
  }
  lines.push('', '| day (UTC) since the first deploy record | sessions | median tokens without the project\'s instructions | median tokens of listings owned by a plugin |', '|---|---:|---:|---:|')
  const days = new Map<string, Birth[]>()
  for (const birth of [...groups.before, ...groups.after]) days.set(birth.at.slice(0, 10), [...(days.get(birth.at.slice(0, 10)) ?? []), birth])
  for (const [day, births] of [...days].sort(([a], [b]) => plain(a, b))) {
    lines.push(`| ${day} | ${births.length} | ${median(births.map(birth => birth.tokens - birth.parts.instructions))} | ${median(births.map(owned))} |`)
  }
  return lines
}

/** The tokens of a birth's listings that a plugin owns. */
export const owned = (birth: Birth): number => Object.entries(birth.shares).reduce((sum, [owner, tokens]) => (owner === BARE ? sum : sum + tokens), 0)

/** The deploy at which `plugin` last changed: the newest history entry whose commit differs from the one before it under the plugin's directory. */
export function lastDeployOf(plugin: string, history: readonly Installed[], changed: (plugin: string, from: string, to: string) => boolean): Installed | undefined {
  const ascending = [...history].sort(byTime)
  for (let at = ascending.length - 1; at > 0; at--) {
    const from = ascending[at - 1]
    const to = ascending[at]
    if (from !== undefined && to !== undefined && changed(plugin, from.commit, to.commit)) return to
  }
  return undefined
}

const gitChanged = (root: string) => (plugin: string, from: string, to: string): boolean => {
  try {
    execFileSync('git', ['diff', '--quiet', from, to, '--', `${PLUGINS_DIR}/${plugin}`], { cwd: root, stdio: 'ignore' })
    return false
  } catch (error) {
    if (isRecord(error) && error['status'] === 1) return true
    throw new Error(`git cannot compare ${from.slice(0, 8)} and ${to.slice(0, 8)}: is the deploy record's repository the working directory's?`)
  }
}

export function run(root: string, args: readonly string[], io: Io, changed: (plugin: string, from: string, to: string) => boolean = gitChanged(root)): number {
  try {
    const { values } = parseArgs({ args: [...args], options: { projects: { type: 'string' }, state: { type: 'string' }, plugin: { type: 'string' }, baseline: { type: 'string' } } })
    const config = configDir(io.env)
    const size = values.baseline === undefined ? BASELINE_SIZE : Number(values.baseline)
    if (values.baseline !== undefined && !/^[1-9]\d*$/.test(values.baseline)) throw new Error('--baseline: a whole number of sessions, 1 or more')
    if (values.plugin !== undefined && !existsSync(join(root, PLUGINS_DIR, values.plugin))) throw new Error(`--plugin: no ${PLUGINS_DIR}/${values.plugin} in ${root}`)
    const state = values.state ?? join(config, DEPLOYS_DIR, DEPLOY_MARKETPLACE, DEPLOY_STATE_FILE)
    const history = [...parseDeployState(readFileSync(state, 'utf8')).history].sort(byTime)
    const start = history[0]?.at ?? ''
    const newest = history[history.length - 1]?.at ?? ''
    const deployed = values.plugin === undefined ? { at: newest } : lastDeployOf(values.plugin, history, changed)
    const cut = deployed?.at ?? start
    const read = readBirths(values.projects ?? join(config, 'projects'))
    if (deployed === undefined) io.out(`No deploy of ${values.plugin} changed it since the first record: every session since ${start} counts as after.`)
    io.out(`Sessions: ${read.births.length} read, ${read.withoutCall} without a model call, ${read.unreadable} unreadable (left out).`)
    for (const line of report(periods(read.births, start, cut, size), cut, values.plugin ?? 'the catalogue')) io.out(line)
    return 0
  } catch (error) {
    io.err(`birth: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
