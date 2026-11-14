// hooks/collect.ts
// The events, built from what the host hands the module's hooks. Pure: no `$`, no node module,
// so the hooks module imports it and the script's tests drive it with fixtures. Every input is
// `unknown` and read through the small readers below; a field the host did not give is left out.
import { parseSessionName } from '../core/names.ts'
import { simpleCommands } from '../core/shell.ts'
import { EVENTS, type EventName } from './schema.ts'

export const EVENT_VERSION = 1

// The kinds are declared once, in schema.ts, which also feeds the logs repository's index.
export { EVENTS, type EventName }

export type Event = { readonly v: 1; readonly ts: string; readonly event: EventName; readonly session: string } & Readonly<Record<string, unknown>>

/** A Bash command line is kept to this many characters, once redacted. */
export const LINE_MAX = 400
/** Free text kept (a description, a verdict) is cut to this, once redacted. */
export const TEXT_MAX = 80
/** A question's header is cut to this, once redacted. */
export const HEADER_MAX = 12

/**
 * The fields cut to a length, by key at any depth. The events carry them whole: the writer
 * redacts each whole value first and cuts after (`cutFields`), so a secret straddling a limit is
 * never left half-matched and half-kept.
 */
export const CUTS: Readonly<Record<string, number>> = { line: LINE_MAX, description: TEXT_MAX, verdict: TEXT_MAX, headers: HEADER_MAX }
/** Past this many buffered events the module writes without waiting for the turn's end. */
export const FLUSH_AT = 100

type Fields = Record<string, unknown>

const record = (value: unknown): Fields => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {})
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

/** `value` cut to `max` characters, never inside a redaction mark: a mark the limit would split goes whole. */
export function cutText(value: string, max: number): string {
  if (value.length <= max) return value
  let end = max
  const open = value.lastIndexOf('[REDACTED:', end - 1)
  if (open >= 0 && value.indexOf(']', open) >= end) end = open
  return `${value.slice(0, end)}…`
}

/** `value` with each field of `CUTS` cut, at any depth; an array's strings take their field's limit. */
export function cutFields(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    const max = key === undefined ? undefined : CUTS[key]
    return max === undefined ? value : cutText(value, max)
  }
  if (Array.isArray(value)) return value.map(item => cutFields(item, key))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, item]) => [k, cutFields(item, k)]))
  return value
}

/** `fields` without the keys whose value is undefined. */
export function compact(fields: Fields): Fields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

export function makeEvent(event: EventName, at: number, session: string, fields: Fields): Event {
  return { v: EVENT_VERSION, ts: new Date(at).toISOString(), event, session, ...compact(fields) }
}

/** The role a session's title gives it. */
export function roleOf(title: string | undefined, spawned = false): string {
  if (title === undefined) return spawned ? 'agent' : 'other'
  const parsed = parseSessionName(title)
  if (parsed !== null) return parsed.role
  if (/^review/i.test(title)) return 'reviewer'
  return 'other'
}

/** The last path segment, the project a directory names. */
export function projectOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  const parts = cwd.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || undefined
}

// ----- session -----

export function sessionStart(at: number, session: string, input: unknown, facts: { model?: string | undefined; startedAt?: number | undefined; spawned?: boolean | undefined }): Event {
  const e = record(input)
  const cwd = text(e['cwd'])
  return makeEvent('session_start', at, session, {
    cwd,
    project: projectOf(cwd),
    model: facts.model,
    interactive: bool(e['isInteractive']),
    surface: text(e['surface']),
    spawned: facts.spawned,
    startup_ms: facts.startedAt === undefined ? undefined : Math.max(0, at - facts.startedAt),
  })
}

export function firstTurn(at: number, session: string, startAt: number | undefined, launchedAt: number | undefined): Event {
  return makeEvent('first_turn', at, session, {
    since_start_ms: startAt === undefined ? undefined : Math.max(0, at - startAt),
    since_launch_ms: launchedAt === undefined ? undefined : Math.max(0, at - launchedAt),
  })
}

/** What `$.session.usage()` answered, as far as the events read it. */
export interface UsageFacts {
  readonly contextTokens?: number
  readonly window?: number
  readonly costUsd?: number
  readonly startedAt?: number
}

export function usageFacts(usage: unknown): UsageFacts {
  const u = record(usage)
  const context = record(u['context'])
  const cost = record(u['cost'])
  return compact({ contextTokens: num(context['tokens']), window: num(context['window']), costUsd: num(cost['usd']), startedAt: num(u['startedAt']) }) as UsageFacts
}

export function turnEnd(at: number, session: string, input: unknown, usage: UsageFacts): Event {
  const e = record(input)
  const u = record(e['usage'])
  const refusal = record(e['refusal'])
  const tokens = compact({ in: num(u['input_tokens']), out: num(u['output_tokens']), cache_read: num(u['cache_read_input_tokens']), cache_write: num(u['cache_creation_input_tokens']) })
  return makeEvent('turn_end', at, session, {
    agent: text(e['agentId']),
    turn: text(e['turnId']),
    reason: text(e['reason']),
    duration_ms: num(e['durationMs']),
    model: text(u['model']),
    tokens: Object.keys(tokens).length > 0 ? tokens : undefined,
    refusal: text(refusal['category']),
    context_tokens: e['agentId'] === undefined ? usage.contextTokens : undefined,
    window: e['agentId'] === undefined ? usage.window : undefined,
    cost_usd: usage.costUsd,
  })
}

export function sessionEnd(at: number, session: string, input: unknown, facts: UsageFacts & { turns?: number }): Event {
  const e = record(input)
  return makeEvent('session_end', at, session, {
    reason: text(e['reason']),
    duration_ms: facts.startedAt === undefined ? undefined : Math.max(0, at - facts.startedAt),
    turns: facts.turns,
    cost_usd: facts.costUsd,
    context_tokens: facts.contextTokens,
    window: facts.window,
  })
}

// ----- tools -----

/** What `tool.check` decided, kept only when it did not simply allow. */
export interface Check {
  readonly decision: string
  readonly rule?: string
  readonly hook?: string
  readonly plugin?: string
  readonly setting?: string
}

export function checkOf(result: unknown): Check | undefined {
  const r = record(result)
  const decision = text(r['decision'])
  if (decision === undefined || decision === 'allow') return undefined
  return compact({ decision, rule: text(r['rule']), hook: text(r['hook']), plugin: text(r['plugin']), setting: text(r['setting']) }) as unknown as Check
}

/** Who refused a call, read from the text the model was given, then from the check. */
export function deciderOf(errorText: string, check: Check | undefined): string | undefined {
  const head = errorText.replace(/^<tool_use_error>/, '').trimStart()
  if (/auto mode classifier/i.test(head)) return 'auto_mode'
  if (/denied by a built-in Claude Code safety/i.test(head)) return 'safety'
  if (/doesn't want to proceed|user (?:rejected|declined|denied)/i.test(head)) return 'user'
  if (/^Permission to use \S+ .*has been denied/i.test(head)) return check?.rule ? 'rule' : 'user'
  const plugin = /^([a-z][a-z0-9-]{1,30}): /.exec(head)
  if (plugin !== null && head !== errorText) return `plugin:${plugin[1]}`
  if (/^Blocked: /.test(head)) return 'hook'
  if (check?.decision === 'deny') return check.plugin ? `plugin:${check.plugin}` : check.hook ? 'hook' : check.rule ? 'rule' : 'policy'
  return undefined
}

/** The outcome of a call from what `next` resolved to: ok, error, or refused and by whom. */
export function outcomeOf(result: unknown, check: Check | undefined): { outcome: string; decided_by?: string } {
  const r = record(result)
  const deny = text(r['deny'])
  if (deny !== undefined) return { outcome: 'refused', decided_by: deciderOf(deny, check) ?? 'plugin' }
  if (r['isError'] === true) {
    const decided = deciderOf(text(r['text']) ?? text(r['result']) ?? '', check)
    return decided === undefined ? { outcome: 'error' } : { outcome: 'refused', decided_by: decided }
  }
  return { outcome: 'ok' }
}

const BASENAME = (word: string): string => word.replace(/^.*\//, '')

/** A Bash command line: its first command's name, every command's name, and the whole line (cut by the writer). */
export function bashOf(command: string): { head?: string; heads: string[]; line: string } {
  let commands: string[][]
  try {
    commands = simpleCommands(command)
  } catch {
    commands = []
  }
  const heads = [...new Set(commands.map(argv => argv[0]).filter((w): w is string => w !== undefined).map(BASENAME))].slice(0, 20)
  return compact({ head: heads[0], heads, line: command }) as { head?: string; heads: string[]; line: string }
}

/** An MCP tool's server and tool, from `mcp__<server>__<tool>`. */
export function mcpOf(tool: string): { server: string; name: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool)
  return match === null ? undefined : { server: match[1] ?? '', name: match[2] ?? '' }
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** The question an AskUserQuestion call put, and the letters chosen, from its input and result. */
export function questionOf(input: Fields, result: unknown): Fields {
  const questions = Array.isArray(input['questions']) ? input['questions'].map(record) : []
  const answers = record(record(record(result)['result'])['answers'])
  const chosen = questions.map(q => {
    const options = Array.isArray(q['options']) ? q['options'].map(record) : []
    const answer = text(answers[text(q['question']) ?? ''])
    if (answer === undefined) return '-'
    const picked = answer.split(/,\s*/).map(label => options.findIndex(o => o['label'] === label)).filter(i => i >= 0)
    return picked.length === 0 ? 'other' : picked.map(i => LETTERS[i] ?? '?').join('')
  })
  return {
    source: 'ask_user',
    count: questions.length,
    headers: questions.map(q => text(q['header']) ?? ''),
    options: questions.map(q => (Array.isArray(q['options']) ? q['options'].length : 0)),
    multi: questions.map(q => q['multiSelect'] === true),
    chosen,
  }
}

/** The value of `--name` in an argv, or undefined. */
function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

/** The launcher's spawn or close, and the dispatch record's writes, read from a Bash line. */
export function orchestrationOf(command: string): { event: 'agent_spawned' | 'agent_closed' | 'dispatch'; fields: Fields }[] {
  let commands: string[][]
  try {
    commands = simpleCommands(command)
  } catch {
    return []
  }
  const out: { event: 'agent_spawned' | 'agent_closed' | 'dispatch'; fields: Fields }[] = []
  for (const raw of commands) {
    const at = raw.findIndex(word => /(?:^|\/)(?:iterm-agent|dispatch-record)\.(?:sh|ts)$/.test(word))
    if (at < 0) continue
    const argv = raw.slice(at)
    const script = BASENAME(argv[0] ?? '')
    const sub = argv[1]
    if (script.startsWith('iterm-agent') && sub === 'spawn') {
      const title = flag(argv, '--title')
      const role = argv.includes('--auditor') ? 'auditor' : argv.includes('--coordinator-successor') ? 'coordinator' : roleOf(title, true)
      out.push({ event: 'agent_spawned', fields: { kind: 'session', title, role, tier: flag(argv, '--tier'), model: flag(argv, '--model'), effort: flag(argv, '--effort'), permission_mode: flag(argv, '--permission-mode') } })
    } else if (script.startsWith('iterm-agent') && sub === 'close') {
      out.push({ event: 'agent_closed', fields: { kind: 'session', title: flag(argv, '--title') ?? argv.slice(2).find(w => !w.startsWith('-')) } })
    } else if (script.startsWith('dispatch-record') && sub !== undefined && sub !== 'summary') {
      const record = argv[2]
      const row = argv[3] !== undefined && !argv[3].startsWith('-') ? argv[3] : undefined
      out.push({
        event: 'dispatch',
        fields: {
          sub,
          record: record === undefined ? undefined : BASENAME(record),
          row,
          class: flag(argv, '--class'),
          tier: flag(argv, '--tier'),
          model: flag(argv, '--model'),
          effort: flag(argv, '--effort'),
          head: flag(argv, '--head'),
          verdict: flag(argv, '--verdict'),
        },
      })
    }
  }
  return out
}

/** The `tool_call` event, and the events the call's arguments carry (a question, a spawn, a dispatch). */
export function toolEvents(at: number, session: string, input: unknown, result: unknown, check: Check | undefined, durationMs: number): Event[] {
  const e = record(input)
  const tool = text(e['tool']) ?? 'unknown'
  const agent = text(e['agentId'])
  const mcp = mcpOf(tool)
  const { outcome, decided_by } = outcomeOf(result, check)
  const bash = tool === 'Bash' && typeof e['command'] === 'string' ? bashOf(e['command']) : undefined
  const mcpCommand = text(e['command'])
  const events: Event[] = [makeEvent('tool_call', at, session, {
    agent,
    tool,
    mcp_server: mcp?.server,
    mcp_tool: mcp?.name,
    tool_use_id: text(e['tool_use_id']),
    outcome,
    decided_by,
    check,
    duration_ms: durationMs,
    bash,
    skill: tool === 'Skill' ? text(e['skill']) : undefined,
    subagent_type: tool === 'Agent' ? text(e['subagent_type']) : undefined,
    command: mcp !== undefined && mcpCommand !== undefined && /^[a-z][a-z0-9-]{0,40}$/.test(mcpCommand) ? mcpCommand : undefined,
  })]
  if (tool === 'AskUserQuestion') events.push(makeEvent('question', at, session, { agent, ...questionOf(e, result), wait_ms: durationMs }))
  if (mcp?.server === 'orchestrator' && mcp.name === 'declare_wait' && text(e['kind']) === 'operator') {
    events.push(makeEvent('question', at, session, { agent, source: 'round', kind: text(e['kind']), urgent: bool(e['urgent']) }))
  }
  if (bash !== undefined && outcome === 'ok') {
    for (const found of orchestrationOf(String(e['command']))) events.push(makeEvent(found.event, at, session, { agent, ...found.fields }))
  }
  return events
}

// ----- agents -----

export function agentSpawned(at: number, session: string, input: unknown, result: unknown): Event {
  const e = record(input)
  const r = record(result)
  const provider = record(e['provider'])
  return makeEvent('agent_spawned', at, session, {
    agent: text(e['parentAgentId']),
    kind: 'subagent',
    child: text(r['agentId']),
    subagent_type: text(e['subagentType']),
    model: text(r['model']),
    requested_model: text(e['model']),
    background: bool(e['background']),
    provider: text(provider['plugin']),
    description: text(e['description']),
  })
}

export function agentClosed(at: number, session: string, child: string, spawnedAt: number, input: unknown): Event {
  const e = record(input)
  return makeEvent('agent_closed', at, session, { kind: 'subagent', child, duration_ms: Math.max(0, at - spawnedAt), reason: text(e['reason']) })
}

/**
 * The module's memory between hooks: the events not yet written, the checks waiting for their
 * call, the subagents running, and the session's own clock marks.
 */
export class Collector {
  private buffer: Event[] = []
  private readonly checks = new Map<string, Check>()
  private readonly running = new Map<string, number>()
  startAt: number | undefined
  launchedAt: number | undefined
  firstTurnSeen = false
  turns = 0

  push(...events: Event[]): boolean {
    this.buffer.push(...events)
    return this.buffer.length >= FLUSH_AT
  }

  /** The buffered events as JSON lines, emptying the buffer; empty text when there is none. */
  drain(): string {
    const lines = this.buffer.map(event => JSON.stringify(event)).join('\n')
    this.buffer = []
    return lines === '' ? '' : `${lines}\n`
  }

  get size(): number {
    return this.buffer.length
  }

  noteCheck(toolUseId: string | undefined, check: Check | undefined): void {
    if (toolUseId !== undefined && check !== undefined) this.checks.set(toolUseId, check)
  }

  takeCheck(toolUseId: string | undefined): Check | undefined {
    if (toolUseId === undefined) return undefined
    const check = this.checks.get(toolUseId)
    this.checks.delete(toolUseId)
    return check
  }

  spawned(child: string | undefined, at: number): void {
    if (child !== undefined) this.running.set(child, at)
  }

  /** When the child was spawned, once: its first run's end closes it. */
  closing(child: string | undefined): number | undefined {
    if (child === undefined) return undefined
    const at = this.running.get(child)
    this.running.delete(child)
    return at
  }
}
