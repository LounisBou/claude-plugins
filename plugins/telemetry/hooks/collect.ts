// hooks/collect.ts
// The events, built from what the host hands the module's hooks. Pure: no `$`, no node module,
// so the hooks module imports it and the script's tests drive it with fixtures. Every input is
// `unknown` and read through the small readers below; a field the host did not give is left out.
import { currentSessionName, parseSessionName } from '../core/names.ts'
import { WAIT_KINDS, WAIT_TOOL } from '../core/orchestration.ts'
import { gitSubcommand, simpleCommands } from '../core/shell.ts'
import { EVENTS, type EventName } from './schema.ts'

export const EVENT_VERSION = 1

// The kinds are declared once, in schema.ts, which also feeds the logs repository's index.
export { EVENTS, type EventName }

export type Event = { readonly v: 1; readonly ts: string; readonly event: EventName; readonly session: string } & Readonly<Record<string, unknown>>

/** A Bash command line is kept to this many characters, once redacted. */
export const LINE_MAX = 400
/** Free text kept (a description, a title) is cut to this, once redacted. */
export const TEXT_MAX = 80
/** A question's header is cut to this, once redacted. */
export const HEADER_MAX = 12

/** A failed call's message is cut to this, once redacted: its first paragraph, with room for a deny sentence and its hint. */
export const MESSAGE_MAX = 800
/**
 * The message is bounded to this before the writer redacts it, and only 800 characters are kept: the
 * secret-assignment patterns are quadratic on a long unspaced run (about 13 s at 100000 characters, past
 * the writer's 10 s, which would lose the whole batch), about 25 ms here. The bound falls on a blank,
 * never inside a token, and a secret spanning blanks (a private key's block) is masked to the text's end.
 */
export const MESSAGE_RAW_MAX = 4000

/**
 * The fields cut to a length, by key at any depth. The events carry them whole: the writer
 * redacts each whole value first and cuts after (`cutFields`), so a secret straddling a limit is
 * never left half-matched and half-kept.
 */
export const CUTS: Readonly<Record<string, number>> = { line: LINE_MAX, file: LINE_MAX, url: LINE_MAX, ask_reason: LINE_MAX, description: TEXT_MAX, headers: HEADER_MAX, title: TEXT_MAX, parent: TEXT_MAX, reason: TEXT_MAX, error_message: MESSAGE_MAX }
/** The prompts and shown dialogs the module remembers at once, the oldest dropped: a call that never ends leaves one. */
export const ASKS_KEPT = 100
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

/** The title the host gives a session at its start, when it gives one. */
export function sessionTitleOf(input: unknown): string | undefined {
  return titleText(record(input)['session_title'])
}

function titleText(value: unknown): string | undefined {
  const title = text(value)?.trim()
  return title === undefined || title === '' ? undefined : title
}

/** The title a successful `rename_session` call gives the session. */
export function renamedTo(input: unknown, result: unknown, check: Check | undefined): string | undefined {
  const e = record(input)
  const mcp = mcpOf(text(e['tool']) ?? '')
  if (mcp?.server !== 'orchestrator' || mcp.name !== 'rename_session' || outcomeOf(result, check).outcome !== 'ok') return undefined
  const name = titleText(e['name'])
  return name === undefined ? undefined : currentSessionName(name)
}

/** The title of the last `custom-title` entry among the complete lines of the head of a transcript. */
export function titleFromTranscriptHead(head: string): string | undefined {
  let title: string | undefined
  for (const line of head.split('\n')) {
    if (!line.includes('"custom-title"')) continue
    try {
      const entry = record(JSON.parse(line))
      if (entry['type'] === 'custom-title') title = titleText(entry['customTitle']) ?? title
    } catch { /* a line the read cut, or no JSON: no title from it */ }
  }
  return title
}

/** The head of a transcript read for the title: its first bytes hold the entry. */
export const TRANSCRIPT_HEAD_BYTES = 8192

/**
 * The `owner/name` a git remote names, in its https, ssh and scp forms (credentials, port and `.git`
 * dropped); the last two segments of the path when a forge nests groups. A local path names none.
 */
export function repositoryOf(remote: string | null | undefined): string | undefined {
  if (remote === undefined || remote === null) return undefined
  const url = remote.trim()
  const path = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(url)?.[1] ?? /^(?:[^@/:]+@)?[^/:]+:(?!\/)(.+)$/.exec(url)?.[1]
  const parts = (path ?? '').replace(/\/+$/, '').replace(/\.git$/, '').split('/')
  const [owner, name] = parts.slice(-2)
  return parts.length >= 2 && owner !== '' && name !== '' && owner !== undefined && name !== undefined ? `${owner}/${name}` : undefined
}

/** The command that lists a repository's remotes, `remote.<name>.url <url>` a line each, from any of its worktrees. */
export function remoteUrlsArgv(root: string): string[] {
  return ['git', '-C', root, 'config', '--get-regexp', '^remote\\..*\\.url$']
}

/** The urls of `remoteUrlsArgv`'s answer, in its order. */
export function remoteUrls(stdout: string): string[] {
  return stdout.split('\n').filter(l => /^remote\..*\.url /.test(l)).map(l => l.slice(l.indexOf(' ') + 1).trim()).filter(url => url !== '')
}

/** The url of the first remote line of `remoteUrlsArgv`'s answer. */
export function firstRemoteUrl(stdout: string): string | undefined {
  return remoteUrls(stdout)[0]
}

/** The repository of the first remote of `remoteUrlsArgv`'s answer that names one: a remote that is a local path is passed over. */
export function firstRepository(stdout: string): string | undefined {
  return remoteUrls(stdout).map(repositoryOf).find(repository => repository !== undefined)
}

/** The project a session belongs to: its repository (`owner/name`) when it has one, else the last segment of its directory. */
export function projectOf(cwd: string | undefined, repository?: string): string | undefined {
  if (repository !== undefined) return repository
  if (cwd === undefined) return undefined
  const parts = cwd.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || undefined
}

// ----- session -----

export function sessionStart(at: number, session: string, input: unknown, facts: { model?: string | undefined; startedAt?: number | undefined; spawned?: boolean | undefined; repository?: string | undefined }): Event {
  const e = record(input)
  const cwd = text(e['cwd'])
  return makeEvent('session_start', at, session, {
    cwd,
    project: projectOf(cwd, facts.repository),
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

/**
 * `turn_end`. `turnCostUsd` is the turn's own cost, the difference the collector computed between
 * this turn's cumulative figure and the previous one (`Collector.turnCost`); `cost_usd` stays the
 * session's cumulative figure.
 */
export function turnEnd(at: number, session: string, input: unknown, usage: UsageFacts, turnCostUsd?: number): Event {
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
    turn_cost_usd: turnCostUsd,
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

/**
 * What a failed call told the model: the deny text, or the error's text, its first paragraph (up to
 * the first blank line), the host's `<tool_use_error>` wrapper dropped. Redacted and cut by the writer.
 */
export function messageOf(result: unknown): string | undefined {
  const r = record(result)
  const whole = text(r['deny']) ?? (r['isError'] === true ? text(r['text']) ?? text(r['result']) : undefined)
  if (whole === undefined) return undefined
  const paragraph = whole.replace(/<\/?tool_use_error>/g, '').trim().split(/\r?\n[ \t]*\r?\n/)[0]?.trim() ?? ''
  if (paragraph.length <= MESSAGE_RAW_MAX) return paragraph === '' ? undefined : paragraph
  const bounded = paragraph.slice(0, MESSAGE_RAW_MAX)
  return bounded.slice(0, Math.max(bounded.search(/\s\S*$/), 0) || MESSAGE_RAW_MAX)
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

/** What a GitHub act names, each field present only when the call names it. */
export interface Target {
  readonly repo?: string
  readonly pr?: number
  readonly head?: string
}

/** A head is kept to this many characters: a full sha reads as a random run to the redaction. */
export const HEAD_MAX = 12
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA = /^[0-9a-f]{7,40}$/i
/** `github.com` on a boundary: the start of the word, a `/`, an `@` or the `.` of a subdomain. */
const GITHUB = '(?:^|[/@.])github\\.com'
const PULL_URL = new RegExp(`${GITHUB}/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/(\\d+)`)
const PULL_URLS = new RegExp(PULL_URL.source, 'g')
/** A whole word that is a pull request's URL. */
const PULL_WORD = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/
const REMOTE_URL = new RegExp(`${GITHUB}[:/]([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\\.git)?(?:/|$)`)

function targetFrom(repo: unknown, pr: unknown, head: unknown): Target {
  const number = typeof pr === 'number' ? pr : typeof pr === 'string' && /^#?\d{1,9}$/.test(pr) ? Number(pr.replace('#', '')) : undefined
  return compact({
    repo: typeof repo === 'string' && REPO.test(repo) ? repo : undefined,
    pr: number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined,
    head: typeof head === 'string' && SHA.test(head) ? head.slice(0, HEAD_MAX) : undefined,
  }) as Target
}

const merged = (first: Target, second: Target): Target => ({ ...second, ...first })

/** What a result names, from its top-level JSON object (a string of JSON or an object) and its text. */
function resultOf(result: unknown): { json: Fields; raw: string } {
  const r = record(result)
  const body = r['result'] ?? r['text']
  let json: Fields = typeof body === 'object' ? record(body) : {}
  const raw = typeof body === 'string' ? body : text(r['text']) ?? ''
  if (raw.startsWith('{')) {
    try {
      json = record(JSON.parse(raw))
    } catch { /* not JSON: read as text */ }
  }
  return { json, raw }
}

/**
 * A `mcp__github__gh` call's target. A pr named by the arguments is the target's: the result only
 * completes its repository and head, from its top-level JSON of that same pr. Else one source,
 * the result's JSON or its one pull URL, gives repository and pr together.
 */
function githubTarget(input: Fields, result: unknown): Target {
  const args = record(input['args'])
  const isPr = text(input['command'])?.startsWith('pr-') === true
  const named = targetFrom(input['repo'] ?? args['repo'], input['pr'] ?? args['pr'] ?? (isPr ? args['number'] : undefined), args['sha'] ?? args['head'] ?? input['sha'] ?? input['head'])
  const { json, raw } = resultOf(result)
  const fromJson = targetFrom(json['repo'], json['pr'], json['head'])
  if (named.pr !== undefined) return fromJson.pr === named.pr ? merged(named, fromJson) : named
  if (fromJson.pr !== undefined || fromJson.repo !== undefined) return merged(named, fromJson)
  const urls = new Set([...raw.matchAll(PULL_URLS)].map(m => `${m[1]}#${m[2]}`))
  const [only] = urls.size === 1 ? urls : []
  const [repo, pr] = only === undefined ? [] : only.split('#')
  return merged(named, targetFrom(repo, pr, undefined))
}

/** The directory a pull request record is written to: `pr-records/<owner>/<name>/<head>/`. */
const RECORD_DIR = /pr-records\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/([0-9a-f]{40})\//i

/**
 * A review or record call's target: the repository and pull request its arguments name, and the
 * head of the record its result names by its path, when that record is of the same repository.
 * The `dir` checkout is not read: that would be a new process.
 */
function recordTarget(input: Fields, result: unknown): Target {
  const named = targetFrom(input['repo'], input['pr'], undefined)
  const dir = RECORD_DIR.exec(resultOf(result).raw)
  const written = dir === null ? {} : targetFrom(dir[1], undefined, dir[2])
  if (named.repo !== undefined && written.repo !== undefined && named.repo.toLowerCase() !== written.repo.toLowerCase()) return named
  return merged(named, written)
}

/** A Bash `gh` or `git push` command's target: what its arguments name plainly. */
export function bashTarget(command: string): Target | undefined {
  let commands: string[][]
  try {
    commands = simpleCommands(command)
  } catch {
    return undefined
  }
  for (const argv of commands) {
    const program = BASENAME(argv[0] ?? '')
    const words = argv.slice(1)
    let found: Target = {}
    if (program === 'gh') {
      const at = words.findIndex(w => w === '-R' || w === '--repo')
      const inline = words.find(w => w.startsWith('--repo='))
      const positional = words[0] === 'pr' ? words[2] : undefined
      const url = at < 0 && inline === undefined && positional !== undefined ? PULL_WORD.exec(positional) : null
      found = merged(
        targetFrom(at >= 0 ? words[at + 1] : inline?.slice('--repo='.length), positional, flag(words, '--match-head-commit') ?? flag(words, '--sha')),
        url === null ? {} : targetFrom(url[1], url[2], undefined),
      )
    } else if (program === 'git') {
      const sub = gitSubcommand(argv)
      const remote = sub === undefined || argv[sub.at] !== 'push' ? undefined : argv.slice(sub.at + 1).map(w => REMOTE_URL.exec(w)).find(m => m !== null)
      if (remote !== undefined && remote !== null) found = targetFrom(remote[1], undefined, undefined)
    }
    if (Object.keys(found).length > 0) return found
  }
  return undefined
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

/**
 * The launcher's spawn or close, read from a Bash line. The dispatch record's writes are not read
 * here: its script publishes each one in the orchestrator's journal, and the sweep takes them from
 * there (`lib/sweep.ts`).
 */
export function orchestrationOf(command: string): { event: 'agent_spawned' | 'agent_closed'; fields: Fields }[] {
  let commands: string[][]
  try {
    commands = simpleCommands(command)
  } catch {
    return []
  }
  const out: { event: 'agent_spawned' | 'agent_closed'; fields: Fields }[] = []
  for (const raw of commands) {
    const at = raw.findIndex(word => /(?:^|\/)iterm-agent\.(?:sh|ts)$/.test(word))
    if (at < 0) continue
    const argv = raw.slice(at)
    const sub = argv[1]
    if (sub === 'spawn') {
      const title = flag(argv, '--title')
      const role = argv.includes('--auditor') ? 'auditor' : argv.includes('--coordinator-successor') ? 'coordinator' : roleOf(title, true)
      out.push({ event: 'agent_spawned', fields: { kind: 'session', title, role, tier: flag(argv, '--tier'), model: flag(argv, '--model'), effort: flag(argv, '--effort'), permission_mode: flag(argv, '--permission-mode') } })
    } else if (sub === 'close') {
      out.push({ event: 'agent_closed', fields: { kind: 'session', title: flag(argv, '--title') ?? argv.slice(2).find(w => !w.startsWith('-')) } })
    }
  }
  return out
}

/** A conventional `fix` subject: `fix:`, `fix(scope):`, `fix!:`. */
const FIX_SUBJECT = /^fix(?:\([^)]*\))?!?:/i
/** The pull requests a text names: `owner/name#N`, `name#N`, `#N` (each a whole word), their URLs. */
const NAMED_PULLS = [
  /(?<![\w/.#-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g,
  /(?<![\w/.#-])([A-Za-z0-9_.-]+)#(\d+)\b/g,
  /(?<![\w/.#-])#(\d+)\b/g,
]
/** At most this many names are kept on an escape. */
export const ESCAPE_NAMES_MAX = 10

/** The pull requests `text` names, as written (a URL as `owner/name#N`), each once, in the order of the patterns. */
export function namedPulls(text: string): string[] {
  const names = [...text.matchAll(PULL_URLS)].map(m => `${m[1]}#${m[2]}`)
  for (const pattern of NAMED_PULLS) names.push(...[...text.matchAll(pattern)].map(m => (m.length === 3 ? `${m[1]}#${m[2]}` : `#${m[1]}`)))
  return [...new Set(names)].slice(0, ESCAPE_NAMES_MAX)
}

/** Every value of `--name <v>`, `--name=<v>` and its `short` form in `argv`. */
function flagValues(argv: readonly string[], names: readonly string[]): string[] {
  const values: string[] = []
  argv.forEach((word, at) => {
    if (names.includes(word) && argv[at + 1] !== undefined) values.push(argv[at + 1] ?? '')
    for (const name of names) if (name.startsWith('--') && word.startsWith(`${name}=`)) values.push(word.slice(name.length + 1))
  })
  return values
}

/** The fix a Bash line writes, when it is one: a `git commit -m` or a `gh pr create --title`, its subject and text. */
function bashFixes(command: string): { source: string; text: string }[] {
  let commands: string[][]
  try {
    commands = simpleCommands(command)
  } catch {
    return []
  }
  const found: { source: string; text: string }[] = []
  for (const argv of commands) {
    const program = BASENAME(argv[0] ?? '')
    let source: string | undefined
    let parts: string[] = []
    if (program === 'git') {
      const sub = gitSubcommand(argv)
      if (sub !== undefined && argv[sub.at] === 'commit') [source, parts] = ['commit', flagValues(argv.slice(sub.at + 1), ['-m', '--message'])]
    } else if (program === 'gh' && argv[1] === 'pr' && argv[2] === 'create') {
      const rest = argv.slice(3)
      source = 'pull_request'
      parts = [...flagValues(rest, ['-t', '--title']), ...flagValues(rest, ['-b', '--body'])]
    }
    if (source !== undefined && FIX_SUBJECT.test(parts[0] ?? '')) found.push({ source, text: parts.join('\n') })
  }
  return found
}

/**
 * A candidate escaped defect: a fix (a `fix` pull request opened, a `fix` commit) whose subject or
 * text names pull requests. Whether a name was merged, and is the defect's origin, is its reader's
 * join; the names are kept as written, the fix's own pull request in `target`.
 */
function escapesOf(at: number, session: string, agent: string | undefined, e: Fields, mcp: { server: string; name: string } | undefined, target: Target | undefined): Event[] {
  const fixes: { source: string; text: string }[] = []
  if (mcp?.server === 'github' && mcp.name === 'gh' && text(e['command']) === 'pr-create') {
    const args = record(e['args'])
    const title = text(args['title']) ?? ''
    if (FIX_SUBJECT.test(title)) fixes.push({ source: 'pull_request', text: `${title}\n${text(args['body']) ?? ''}` })
  } else if (text(e['tool']) === 'Bash' && typeof e['command'] === 'string') {
    fixes.push(...bashFixes(e['command']))
  }
  return fixes.flatMap(fix => {
    const names = namedPulls(fix.text)
    return names.length === 0 ? [] : [makeEvent('escape', at, session, { agent, source: fix.source, names, target })]
  })
}

/** The `tool_call` event, and the events the call's arguments carry (a question, a spawn, an escape). */
export function toolEvents(at: number, session: string, input: unknown, result: unknown, check: Check | undefined, durationMs: number | undefined, askedAt?: number): Event[] {
  const e = record(input)
  const tool = text(e['tool']) ?? 'unknown'
  const agent = text(e['agentId'])
  const mcp = mcpOf(tool)
  const { outcome, decided_by } = outcomeOf(result, check)
  const bash = tool === 'Bash' && typeof e['command'] === 'string' ? bashOf(e['command']) : undefined
  const mcpCommand = text(e['command'])
  const waited = mcp?.server === 'orchestrator' && mcp.name === WAIT_TOOL
  const acts = (mcp?.server === 'github' && mcp.name === 'record') || (mcp?.server === 'orchestrator' && mcp.name === 'review')
  const target = mcp?.server === 'github' && mcp.name === 'gh'
    ? githubTarget(e, result)
    : acts ? recordTarget(e, result) : bash !== undefined ? bashTarget(String(e['command'])) : undefined
  const events: Event[] = [makeEvent('tool_call', at, session, {
    agent,
    tool,
    mcp_server: mcp?.server,
    mcp_tool: mcp?.name,
    tool_use_id: text(e['tool_use_id']),
    outcome,
    decided_by,
    error_message: messageOf(result),
    check,
    duration_ms: durationMs,
    ask_ms: askedAt === undefined ? undefined : Math.max(0, at - askedAt),
    bash,
    skill: tool === 'Skill' ? text(e['skill']) : undefined,
    subagent_type: tool === 'Agent' ? text(e['subagent_type']) : undefined,
    command: mcp !== undefined && mcpCommand !== undefined && /^[a-z][a-z0-9-]{0,40}$/.test(mcpCommand) ? mcpCommand : undefined,
    target: target !== undefined && Object.keys(target).length > 0 ? target : undefined,
    wait_kind: waited ? WAIT_KINDS.find(kind => kind === text(e['kind'])) : undefined,
  })]
  if (tool === 'AskUserQuestion') events.push(makeEvent('question', at, session, { agent, ...questionOf(e, result), wait_ms: durationMs }))
  if (waited && text(e['kind']) === 'operator') {
    events.push(makeEvent('question', at, session, { agent, source: 'round', kind: text(e['kind']), urgent: bool(e['urgent']) }))
  }
  if (bash !== undefined && outcome === 'ok') {
    for (const found of orchestrationOf(String(e['command']))) events.push(makeEvent(found.event, at, session, { agent, ...found.fields }))
  }
  if (outcome === 'ok') events.push(...escapesOf(at, session, agent, e, mcp, target !== undefined && Object.keys(target).length > 0 ? target : undefined))
  return events
}

/** A permission prompt `tool.check` announced (its verdict was an ask), waiting for the dialog's own hook. */
export interface Ask {
  readonly tool: string
  /** The call's arguments as `tool.check` read them, in the stable form `sameInput` compares. */
  readonly input: string
  readonly id: string
  readonly agent: string | undefined
  readonly reason: string | undefined
  readonly check: Check | undefined
}

/** `value` as JSON with each object's keys in order: two inputs equal as values give one text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** The ask a `tool.check` verdict is, or undefined for a verdict that is no ask or names no call (a query, a call straight to its server: no dialog is raised for it). */
export function askOf(input: unknown, result: unknown): Ask | undefined {
  const e = record(input)
  const check = checkOf(result)
  const tool = text(e['tool'])
  const id = text(e['tool_use_id'])
  if (check?.decision !== 'ask' || tool === undefined || id === undefined) return undefined
  return { tool, input: stableJson(e['input']), id, agent: text(e['agentId']), reason: text(record(result)['reason']), check }
}

/**
 * The `permission_ask` event of a dialog about to be shown, from the classic `PermissionRequest`
 * input (the tool, its arguments, the mode) and the `tool.check` ask it matched, which gives the
 * call's id, Claude Code's reason and who asked. The target is what the arguments name plainly:
 * a path, a command line, a URL, a skill; the writer redacts and cuts it like any other field.
 */
export function permissionAsk(at: number, session: string, input: unknown, ask: Ask | undefined): Event {
  const e = record(input)
  const tool = text(e['tool_name']) ?? ask?.tool ?? 'unknown'
  const args = record(e['tool_input'])
  const mcp = mcpOf(tool)
  const command = text(args['command'])
  const mcpCommand = mcp !== undefined && command !== undefined && /^[a-z][a-z0-9-]{0,40}$/.test(command) ? command : undefined
  return makeEvent('permission_ask', at, session, {
    agent: text(e['agent_id']) ?? ask?.agent,
    tool,
    mcp_server: mcp?.server,
    mcp_tool: mcp?.name,
    tool_use_id: ask?.id,
    ask_reason: ask?.reason,
    check: ask?.check,
    permission_mode: text(e['permission_mode']),
    file: text(args['file_path']) ?? text(args['notebook_path']) ?? text(args['path']),
    bash: tool === 'Bash' && command !== undefined ? bashOf(command) : undefined,
    url: text(args['url']),
    skill: tool === 'Skill' ? text(args['skill']) : undefined,
    command: mcpCommand,
  })
}

/** The ids of the plugin and MCP calls a conversation already holds, answered or not. */
export function transcriptCallIds(messages: unknown): string[] {
  const ids: string[] = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const uses = record(message)['toolUses']
    for (const raw of Array.isArray(uses) ? uses : []) {
      const use = record(raw)
      const id = text(use['tool_use_id'])
      const tool = text(use['tool'])
      if (id !== undefined && tool !== undefined && mcpOf(tool) !== undefined) ids.push(id)
    }
  }
  return ids
}

/**
 * The `tool_call` events of the plugin and MCP tools a conversation holds that the `tool.call` hook
 * never saw. A plugin serves its own tool by answering `tool.call` in place of `next`, and a hook
 * beneath that answer is never run: this module's own `tool.call` hook cannot see those calls, so
 * they are read back from the transcript (`$.session.messages`) once answered. `claim` says whether
 * a call's id is new, and records it, so a call is written once however often the transcript is
 * read. A call without its result is still running: it is left for the next read. The transcript
 * holds no clock and no permission check, so these events carry neither a duration nor a `check`,
 * and their `ts` is the read's. A call that never gets a result (an aborted turn) is never written.
 */
export function transcriptToolEvents(at: number, session: string, messages: unknown, agent: string | undefined, claim: (id: string) => boolean): Event[] {
  const events: Event[] = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const uses = record(message)['toolUses']
    for (const raw of Array.isArray(uses) ? uses : []) {
      const use = record(raw)
      const id = text(use['tool_use_id'])
      const tool = text(use['tool'])
      if (id === undefined || tool === undefined || mcpOf(tool) === undefined) continue
      if (use['text'] === undefined && use['result'] === undefined && use['isError'] !== true) continue
      if (!claim(id)) continue
      const input = { ...record(use['input']), tool, tool_use_id: id, agentId: agent }
      events.push(...toolEvents(at, session, input, { result: use['result'], text: use['text'], isError: use['isError'] }, undefined, undefined))
    }
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

/**
 * The end of one run of a subagent: its first, counted from its spawn, or a later one (the child
 * was sent a message and ran again), counted from that run's first turn, or from the host's own
 * figure when the module did not see it start. `run` is absent for a child whose spawn the module
 * did not see (a session resumed, a module reloaded).
 */
export function agentClosed(at: number, session: string, child: string, run: Run, input: unknown): Event {
  const e = record(input)
  const duration = run.since === undefined ? num(e['durationMs']) : Math.max(0, at - run.since)
  return makeEvent('agent_closed', at, session, { kind: 'subagent', child, run: run.run, duration_ms: duration, reason: text(e['reason']) })
}

/** One run of a subagent: its rank from the spawn (1 for the first), and when it began. */
export interface Run {
  readonly run?: number
  readonly since?: number
}

/** What the launcher's environment says of a session it spawned: the orchestrator it reports to and its tier. */
export interface Origin {
  readonly parent?: string
  readonly tier?: string
}

/** The origin two values of the environment give (core's `ENV.reportsTo` and `ENV.tier`); a tier that is no plain word is left out. */
export function originOf(reportsTo: string | undefined, tier: string | undefined): Origin {
  const word = tier?.trim().toLowerCase()
  return compact({ parent: titleText(reportsTo), tier: word !== undefined && /^[a-z][a-z0-9-]{0,30}$/.test(word) ? word : undefined }) as Origin
}

/**
 * The module's memory between hooks: the events not yet written, the checks waiting for their
 * call, the subagents spawned with their runs, and the session's own clock marks.
 */
export class Collector {
  private buffer: Event[] = []
  private readonly checks = new Map<string, Check>()
  private asks: Ask[] = []
  private readonly shown = new Map<string, number>()
  private readonly children = new Map<string, { spawnedAt: number; runs: number }>()
  private readonly runStarts = new Map<string, number>()
  private readonly recorded = new Set<string>()
  startAt: number | undefined
  launchedAt: number | undefined
  firstTurnSeen = false
  turns = 0
  private costSoFar: number | undefined
  private actor: { title: string; role: string } | undefined
  private headRead = false
  private origin: Origin = {}

  /**
   * The cost of the turn that just ended, from the session's cumulative `costUsd`: the difference
   * with the highest figure seen so far, subagent turns included, so the turns' costs add up to
   * the session's cost. The first turn costs its whole figure. A figure below the baseline (two
   * turns that ended together read the host out of order) costs nothing and leaves the baseline
   * where it is. Undefined, and the baseline kept, when the host gave no figure.
   */
  turnCost(costUsd: number | undefined): number | undefined {
    if (costUsd === undefined) return undefined
    const before = this.costSoFar ?? 0
    this.costSoFar = Math.max(before, costUsd)
    return Math.round(Math.max(0, costUsd - before) * 1e9) / 1e9
  }

  /** The session's title, once known. */
  get title(): string | undefined {
    return this.actor?.title
  }

  /** Names the session: each event buffered from now on carries its title and role. */
  setTitle(title: string | undefined): void {
    if (title !== undefined) this.actor = { title, role: roleOf(title) }
  }

  /** True once, while the title is unknown: the transcript's head is read at most once per session. */
  wantsHeadRead(): boolean {
    if (this.actor !== undefined || this.headRead) return false
    this.headRead = true
    return true
  }

  /** Says where the session comes from: each event buffered from now on carries its parent orchestrator and its launch tier. */
  setOrigin(origin: Origin): void {
    this.origin = origin
  }

  /**
   * `event` with the session's title and role, but for those its kind carries of its own, and with
   * the orchestrator it reports to and the tier it was launched on.
   */
  private stamped(event: Event): Event {
    const from = compact({ parent: this.origin.parent, launch_tier: this.origin.tier })
    if (this.actor === undefined) return { ...event, ...from }
    const own = text(event['title'])
    return { ...event, title: own ?? this.actor.title, role: event['role'] ?? (own === undefined ? this.actor.role : roleOf(own)), ...from }
  }

  push(...events: Event[]): boolean {
    this.buffer.push(...events.map(event => this.stamped(event)))
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

  /** True once per call id: the plugin and MCP calls are written by the hook or by the transcript read, never twice. */
  claim(toolUseId: string): boolean {
    if (this.recorded.has(toolUseId)) return false
    this.recorded.add(toolUseId)
    return true
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

  /** A prompt `tool.check` announced: held until the dialog's hook claims it or its call ends. */
  noteAsk(ask: Ask | undefined): void {
    if (ask === undefined) return
    this.asks.push(ask)
    if (this.asks.length > ASKS_KEPT) this.asks = this.asks.slice(-ASKS_KEPT)
  }

  /**
   * The announced ask a dialog is for: the oldest of the same tool and loop with the same arguments (the
   * dialogs of a burst are raised in the order of its asks), else the only one of that tool and loop.
   * Taken once, and marked shown at `at`.
   */
  takeAsk(tool: string, input: unknown, agent: string | undefined, at: number): Ask | undefined {
    const same = this.asks.filter(ask => ask.tool === tool && ask.agent === agent)
    const wanted = stableJson(input)
    const found = same.find(ask => ask.input === wanted) ?? (same.length === 1 ? same[0] : undefined)
    if (found === undefined) return undefined
    this.asks = this.asks.filter(ask => ask !== found)
    this.shown.set(found.id, at)
    if (this.shown.size > ASKS_KEPT) this.shown.delete([...this.shown.keys()][0] ?? '')
    return found
  }

  /** The call ended: when its prompt was shown, if it was; its announced ask, shown or not, is forgotten. */
  settleAsk(toolUseId: string | undefined): number | undefined {
    if (toolUseId === undefined) return undefined
    this.asks = this.asks.filter(ask => ask.id !== toolUseId)
    const at = this.shown.get(toolUseId)
    this.shown.delete(toolUseId)
    return at
  }

  spawned(child: string | undefined, at: number): void {
    if (child !== undefined) this.children.set(child, { spawnedAt: at, runs: 0 })
  }

  /** Notes when a run of `child` began: the first turn start seen since its last run's end. */
  runStarted(child: string, at: number): void {
    if (!this.runStarts.has(child)) this.runStarts.set(child, at)
  }

  /**
   * The run of `child` that just ended. Its first is counted from the spawn; a later one from its
   * own start, when the module saw it. A child whose spawn the module did not see has no rank.
   */
  closing(child: string): Run {
    const started = this.runStarts.get(child)
    this.runStarts.delete(child)
    const known = this.children.get(child)
    if (known === undefined) return compact({ since: started }) as Run
    known.runs++
    return compact({ run: known.runs, since: known.runs === 1 ? known.spawnedAt : started }) as Run
  }
}
