// The decisions of the ready guard and the auto-merge split: which call marks
// a pull request ready, leaves draft, merges it or opens it, which push moves
// a branch's head, and what a pull request still misses to be ready at its
// head. Pure functions only: register.ts reads GitHub, the records and the
// session, and answers the calls.

import { ACCEPTANCE, accepts, isAcceptance, KINDS, kindFor, parsePrRecord, producersOf, SCRIPTED, type Kind, type PrRecord } from '../core/pr-record.ts'
import { carriesAcross, heldBy, missingEvidence, type Holder } from '../core/readiness.ts'
import { gitSubcommand, innerLine, readCommands, simpleCommands } from '../core/shell.ts'
import type { Excused } from './check-plan.ts'
import { IDLE_MAX_MS } from './reconcile.ts'
import { type EngineCall, engineCall, engineFlag, engineOption, engineStart } from './shell.ts'

// merge: a merge or an auto-merge armed. undraft: out of draft. create: a pull
// request opened out of draft. create-draft: one opened as a draft. redraft: one
// put back to draft.
export type ActKind = 'merge' | 'undraft' | 'create' | 'create-draft' | 'redraft'

export type Act = {
  kind: ActKind
  // The command as a refusal names it: `gh pr merge`, `gh api`, `pr-merge`.
  name: string
  // owner/name as the command names it, when it does.
  repo?: string
  pr?: number
  // A branch the command names the pull request by.
  branch?: string
  // The head the command pins (`--match-head-commit`, `pr-merge --sha`).
  sha?: string
  // The command names no pull request a reader can find (a GraphQL mutation).
  unnamed?: boolean
  // The engine was given no pull request number a reader can find (`{}` of an
  // xargs, `$PR`): never read as the current branch's pull request.
  unreadable?: boolean
  // An undraft through the engine: whether it asks for CI only (`--for-ci`),
  // which keeps Not Ready. A gh pr ready leaves it unset.
  forCi?: boolean
  // A GraphQL call whose query the command line does not show (a file, stdin, a variable).
  opaque?: boolean
  // The engine fed its request on stdin (`gh.py --stdin-json`): the line shows no act.
  stdin?: boolean
}

// What pr-gate answers.
export type Gate = {
  repo: string
  pr: number
  state: string
  draft: boolean
  head: string
  labels: string[]
  // The pull request's commit count at this head.
  commits?: number
  // GitHub's mergeability of the head against its base: false or dirty when it conflicts, null while GitHub computes it.
  mergeable?: boolean | null
  mergeable_state?: string
  // Its base branch, and whether that base is the head branch of another open pull request.
  base?: string
  stacked?: boolean
  // draft_failed: the engine read that every failed check of a draft fails because it is a draft (its job, or the workflow it calls, reads the draft state).
  ci: { result: string; failed: string[]; running?: number; skipped?: string[]; unverified?: string[]; total: number; draft_failed?: boolean }
}

// One file of a head's records directory.
export type RecordFile = { name: string; text: string }

// The record contract is core's (pr-record.json); its kinds are re-exported for the module's readers.
export { KINDS } from '../core/pr-record.ts'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

// The labels, compared without regard to case as GitHub does.
export const READY = 'ready'
export const NOT_READY = 'not ready'

const URL = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/
const GH = /^(.*\/)?gh$/

// owner/name from what -R takes: OWNER/REPO, HOST/OWNER/REPO or a URL.
export function repoOf(value: string): string | undefined {
  const parts = value.replace(/\.git$/, '').replace(/\/+$/, '').split('/').filter((p) => p !== '')
  if (parts.length < 2) return undefined
  return parts[parts.length - 2] + '/' + parts[parts.length - 1]
}

// Each gh verb's options that take a value, -R and --repo apart.
const VALUED: Record<string, string[]> = {
  merge: ['-b', '--body', '-F', '--body-file', '-t', '--subject', '--match-head-commit', '-A', '--author-email'],
  ready: [],
  edit: [
    '-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '--add-label', '--remove-label',
    '--add-reviewer', '--remove-reviewer', '--add-assignee', '--remove-assignee', '--add-project',
    '--remove-project', '-m', '--milestone',
  ],
  create: [
    '-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-H', '--head', '-l', '--label',
    '-a', '--assignee', '-r', '--reviewer', '-p', '--project', '-m', '--milestone', '-T', '--template', '--recover',
  ],
}

// `repo` is present and undefined when `-R` ends the words with no value.
type Parsed = { repo?: string | undefined; opts: Array<[string, string | undefined]>; positionals: string[] }

// The options and positionals of a gh command's words, -R wherever it stands.
function parseWords(words: string[], valued: string[]): Parsed {
  const out: Parsed = { opts: [], positionals: [] }
  for (let k = 0; k < words.length; k++) {
    const word = words[k] ?? ''
    if (word === '-R' || word === '--repo') {
      out.repo = words[++k]
      continue
    }
    if (word.startsWith('--repo=')) { out.repo = word.slice(7); continue }
    if (/^-R./.test(word)) { out.repo = word.slice(2); continue }
    if (word.startsWith('--') && word.includes('=')) {
      const at = word.indexOf('=')
      out.opts.push([word.slice(0, at), word.slice(at + 1)])
      continue
    }
    if (word.startsWith('-') && word !== '-') {
      if (valued.includes(word)) out.opts.push([word, words[++k]])
      // A short valued flag joined to its value (`-Flabels[]=@f`, `-XPATCH`) is read as gh does.
      else if (/^-[^-]./.test(word) && valued.includes(word.slice(0, 2))) out.opts.push([word.slice(0, 2), word.slice(2)])
      else out.opts.push([word, undefined])
      continue
    }
    out.positionals.push(word)
  }
  return out
}

function has(parsed: Parsed, ...flags: string[]): boolean {
  return parsed.opts.some(([flag]) => flags.includes(flag))
}

// A boolean flag as gh reads it: bare or `=true` is set, `=false`, `=f` or `=0` is not,
// and the last occurrence wins.
function flagSet(parsed: Parsed, ...flags: string[]): boolean {
  const given = parsed.opts.filter(([flag]) => flags.includes(flag))
  if (given.length === 0) return false
  const value = given[given.length - 1]?.[1]
  return value === undefined || !/^(false|f|0)$/i.test(value)
}

function values(parsed: Parsed, ...flags: string[]): string[] {
  return parsed.opts.flatMap(([flag, value]) => (flags.includes(flag) && value !== undefined ? [value] : []))
}

// The pull request a gh pr command names by its first positional: a number,
// a URL (which also names the repository) or a branch.
function target(act: Act, positional: string | undefined): Act {
  if (positional === undefined) return act
  const url = URL.exec(positional)
  if (url) return { ...act, repo: act.repo ?? url[1] + '/' + url[2], pr: Number(url[3]) }
  if (/^#?\d+$/.test(positional)) return { ...act, pr: Number(positional.replace('#', '')) }
  return { ...act, branch: positional }
}

// The acts of one gh pr command.
function prAct(argv: string[]): Act | undefined {
  // gh [-R x] pr <verb> …: the noun and the verb are the first two words.
  let k = 1
  const named: number[] = []
  while (k < argv.length && named.length < 2) {
    const word = argv[k] ?? ''
    if (word === '-R' || word === '--repo') { k += 2; continue }
    if (word.startsWith('-')) { k++; continue }
    named.push(k++)
  }
  const [nounAt, verbAt] = named
  if (nounAt === undefined || verbAt === undefined || argv[nounAt] !== 'pr') return undefined
  const noun = argv[nounAt] ?? ''
  const verb = argv[verbAt] ?? ''
  const words = argv.filter((_w, i) => i > 0 && i !== nounAt && i !== verbAt)
  const parsed = parseWords(words, VALUED[verb] ?? [])
  const repo = parsed.repo
  const base: Act = { kind: 'merge', name: 'gh ' + noun + ' ' + verb, ...(repo ? { repo: repoOf(repo) ?? repo } : {}) }
  if (verb === 'merge') {
    if (has(parsed, '--disable-auto')) return undefined
    const sha = values(parsed, '--match-head-commit')[0]
    return target({ ...base, kind: 'merge', ...(sha ? { sha } : {}) }, parsed.positionals[0])
  }
  if (verb === 'ready') {
    return target({ ...base, kind: flagSet(parsed, '--undo') ? 'redraft' : 'undraft' }, parsed.positionals[0])
  }
  if (verb === 'create') {
    return { ...base, kind: flagSet(parsed, '-d', '--draft') ? 'create-draft' : 'create' }
  }
  return undefined
}

const API_VALUED = [
  '-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq',
  '-t', '--template', '--cache', '-p', '--preview', '--hostname',
]
const MERGE_PATH = /^\/?repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge\/?$/
// The shape of a merge path whose repository or number the line does not show (`$PR`, `${PR}`,
// `$REPO`, which may stand for owner/name, a substitution): an opaque merge.
const MERGE_SHAPE = /^\/?repos\/(?:[^/]*\/){1,2}pulls\/[^/]*\/merge\/?$/
// The API's own host before a REST path: api.github.com, or a server's /api/v3.
const API_HOST = /^https?:\/\/[^/]+(?:\/api\/v3)?\//
const GRAPHQL = /^(?:https?:\/\/[^/]+(?:\/api)?\/|\/)?graphql\/?$/

// The fields of a gh api command, as [name, value] pairs: -f sends the text as it is, -F reads
// `@file` and types the rest.
function apiFields(parsed: Parsed): Array<{ name: string; value: string; typed: boolean }> {
  return parsed.opts
    .flatMap(([flag, text]) => {
      if (!['-f', '--raw-field', '-F', '--field'].includes(flag) || text === undefined) return []
      const at = text.indexOf('=')
      return [{ name: at === -1 ? text : text.slice(0, at), value: at === -1 ? '' : text.slice(at + 1), typed: flag === '-F' || flag === '--field' }]
    })
}

// The GraphQL query the command line shows, or undefined when it does not: read from a file or
// stdin (`-F query=@…`, `--input`), absent or empty (a command substitution reads as nothing), or
// holding a shell expansion the hook cannot see. A `$name` the query declares (`$name:`) is a
// GraphQL variable, not the shell's.
function inlineQuery(parsed: Parsed, fields: Array<{ name: string; value: string; typed: boolean }>): string | undefined {
  if (has(parsed, '--input')) return undefined
  const query = fields.filter((field) => field.name === 'query')
  if (query.length === 0 || query.some((field) => field.value.trim() === '' || (field.typed && field.value.startsWith('@')))) {
    return undefined
  }
  const text = query.map((field) => field.value).join('\n')
  const declared = new Set([...text.matchAll(/\$(\w+)\s*:/g)].map((m) => m[1]))
  if (/`|\$[({]/.test(text) || [...text.matchAll(/\$(\w+)/g)].some((m) => !declared.has(m[1]))) return undefined
  return text
}

// The act of one gh api command: a merge through the REST API, or a GraphQL mutation that merges, leaves draft, arms auto-merge or puts back to draft.
function apiAct(argv: string[]): Act | undefined {
  const parsed = parseWords(argv.slice(2), API_VALUED)
  const endpoint = parsed.positionals[0]
  if (endpoint === undefined) return undefined
  const fields = apiFields(parsed)
  const input = has(parsed, '--input')
  const explicit = values(parsed, '-X', '--method')[0]
  const method = (explicit ?? (fields.length > 0 || input ? 'POST' : 'GET')).toUpperCase()
  if (GRAPHQL.test(endpoint)) {
    const base = { name: 'gh api graphql', unnamed: true }
    const query = inlineQuery(parsed, fields)
    // A query the hook cannot read may do any of the acts below.
    if (query === undefined) return { ...base, kind: 'undraft', opaque: true }
    if (/\b(mergePullRequest|enablePullRequestAutoMerge)\b/.test(query)) return { ...base, kind: 'merge' }
    if (/\bmarkPullRequestReadyForReview\b/.test(query)) return { ...base, kind: 'undraft' }
    return undefined
  }
  const path = endpoint.replace(API_HOST, '')
  if (method !== 'PUT' && method !== 'POST') return undefined
  const merge = MERGE_PATH.exec(path)
  const sha = fields.find((field) => field.name === 'sha')?.value
  if (merge) return { kind: 'merge', name: 'gh api', repo: merge[1] + '/' + merge[2], pr: Number(merge[3]), ...(sha ? { sha } : {}) }
  // A substitution splits the path into words: the words are joined as the shell would.
  const joined = parsed.positionals.join('').replace(API_HOST, '')
  return MERGE_SHAPE.test(joined) ? { kind: 'merge', name: 'gh api', unreadable: true } : undefined
}

// The act of one run of the plugin's engine, engine/gh.py, from Bash. A draft
// opened or put back is the engine's to label, as it does for the tool.
function engineAct(call: EngineCall): Act | undefined {
  const repo = call.repo ? repoOf(call.repo) ?? call.repo : undefined
  const first = call.positionals[0] ?? ''
  const number = /^#?\d+$/.test(first) ? Number(first.replace('#', '')) : undefined
  const at = (kind: ActKind, extra: Partial<Act> = {}): Act => ({
    kind, name: 'gh.py ' + call.command, ...(repo ? { repo } : {}), ...(number !== undefined ? { pr: number } : { unreadable: true }), ...extra,
  })
  const sha = engineOption(call, '--sha')
  if (call.command === 'pr-merge') return at('merge', sha ? { sha } : {})
  if (call.command === 'pr-ready') return at('undraft', { forCi: engineFlag(call, '--for-ci') })
  if (call.command === 'pr-create' && !engineFlag(call, '--draft')) return { kind: 'create', name: 'gh.py pr-create', ...(repo ? { repo } : {}) }
  return undefined
}

// The simple commands of a line as simpleCommands reads them, each with whether a command
// substitution stands among its words: the shell drops it from the argv, where it may have been the
// pull request's number or branch.
function commandsOf(line: string): Array<{ argv: string[]; substituted: boolean }> {
  const read = (text: string) => readCommands(text).map((command) => ({ argv: [...command.argv], substituted: command.substitutions.length > 0 }))
  const out = read(line)
  for (const { argv } of [...out]) {
    const inner = innerLine(argv)
    if (inner !== undefined) out.push(...read(inner))
  }
  return out
}

// A merge or an undraft that names no pull request, in a command that holds a substitution
// (`gh pr merge $(…) -R o/n`), names one the line does not show: it is no current-branch act.
function unreadableTarget(act: Act): Act {
  const names = act.pr !== undefined || (act.branch ?? '') !== '' || act.unreadable
  return names || (act.kind !== 'merge' && act.kind !== 'undraft') || !act.name.startsWith('gh pr ') ? act : { ...act, unreadable: true }
}

// Every act of a Bash command line, read word by word: a message or a body
// that only mentions one is an argument, not a command. A request the engine
// reads from stdin (`gh.py --stdin-json`) shows no act: it is one of its own, refused.
export function bashActs(line: string): Act[] {
  const found: Act[] = []
  for (const { argv, substituted } of commandsOf(line)) {
    const start = engineStart(argv)
    if (start !== undefined && argv.length === start + 1 && argv[start] === '--stdin-json') {
      found.push({ kind: 'merge', name: 'gh.py --stdin-json', stdin: true })
      continue
    }
    const engine = engineCall(argv)
    const act = engine ? engineAct(engine) : !GH.test(argv[0] ?? '') ? undefined : argv[1] === 'api' ? apiAct(argv) : prAct(argv)
    if (act) found.push(substituted ? unreadableTarget(act) : act)
  }
  return found
}

// The act of a call of the tool, or undefined.
export function toolAct(command: string, args: Record<string, unknown>): Act | undefined {
  const pr = args['pr'] === undefined || args['pr'] === null ? undefined : Number(String(args['pr']).replace('#', ''))
  const at = (kind: ActKind, extra: Partial<Act> = {}): Act => ({ kind, name: command, ...(pr !== undefined ? { pr } : {}), ...extra })
  if (command === 'pr-ready') return at('undraft')
  if (command === 'pr-draft') return at('redraft')
  if (command === 'pr-merge') return at('merge', typeof args['sha'] === 'string' ? { sha: args['sha'] } : {})
  if (command === 'pr-create') return { kind: args['draft'] === false ? 'create' : 'create-draft', name: command }
  return undefined
}

// ---- pushes ----

const PUSH_VALUED = new Set(['--repo', '--push-option', '-o', '--receive-pack', '--exec'])

// What a git push names: its remote and the branches it moves, or why the
// branch cannot be read with certainty. current: the push names no branch,
// so the session's current one moves (upstream: on its upstream remote too).
export type Push = { remote?: string; branches: string[]; current?: 'branch' | 'upstream'; unsure?: string }

export function pushOf(argv: string[]): Push | undefined {
  const git = gitSubcommand(argv)
  if (!git || argv[git.at] !== 'push') return undefined
  if (argv.slice(1, git.at).some((w) => w === '-C' || w === '--git-dir' || w === '--work-tree')) {
    return { branches: [], unsure: 'the push names another checkout' }
  }
  const positionals: string[] = []
  for (let k = git.at + 1; k < argv.length; k++) {
    const word = argv[k] ?? ''
    if (word === '--') { positionals.push(...argv.slice(k + 1)); break }
    if (['--all', '--branches', '--mirror', '--tags', '--delete', '-d', '--prune'].includes(word)) {
      return { branches: [], unsure: 'the push names no single branch (' + word + ')' }
    }
    if (word.startsWith('-')) {
      if (PUSH_VALUED.has(word)) k++
      continue
    }
    positionals.push(word)
  }
  const [remote, ...refspecs] = positionals
  if (remote === undefined) return { branches: [], current: 'upstream' }
  if (refspecs.length === 0) return { remote, branches: [], current: 'branch' }
  const branches: string[] = []
  let current = false
  for (const raw of refspecs) {
    const spec = raw.replace(/^\+/, '')
    const colon = spec.indexOf(':')
    const src = colon === -1 ? spec : spec.slice(0, colon)
    const dst = colon === -1 ? spec : spec.slice(colon + 1)
    // A deletion moves no head.
    if (colon !== -1 && src === '') continue
    if (dst === 'HEAD' || dst === '' || dst === '@') { current = true; continue }
    if (dst.startsWith('refs/') && !dst.startsWith('refs/heads/')) continue
    branches.push(dst.replace(/^refs\/heads\//, ''))
  }
  return { remote, branches, ...(current ? { current: 'branch' as const } : {}) }
}

// The pushes of a command line, and whether the line moves the shell to
// another directory first, which leaves the session's own unsure.
export function bashPushes(line: string): { pushes: Push[]; moves: boolean } {
  const commands = simpleCommands(line)
  const moves = commands.some((argv) => argv[0] === 'cd' || argv[0] === 'pushd' || argv[0] === 'popd')
  const pushes = commands.map(pushOf).filter((p): p is Push => p !== undefined)
  return { pushes, moves }
}

// The number and repository of the pull request a gh pr create printed.
export function createdPr(stdout: string): { repo: string; pr: number } | undefined {
  for (const word of String(stdout ?? '').split(/\s+/)) {
    const url = URL.exec(word)
    if (url) return { repo: url[1] + '/' + url[2], pr: Number(url[3]) }
  }
  return undefined
}

// ---- readiness ----

// pr-gate's answer, or a throw naming what is wrong with it.
export function parseGate(text: string): Gate {
  const gate: unknown = JSON.parse(text)
  const ci = isRecord(gate) ? gate['ci'] : undefined
  if (!isRecord(gate) || typeof gate['head'] !== 'string' || !/^[0-9a-f]{40}$/.test(gate['head'])
    || typeof gate['state'] !== 'string' || !Array.isArray(gate['labels']) || !isRecord(ci) || typeof ci['result'] !== 'string') {
    throw new Error('pr-gate answered no head, state, labels and ci')
  }
  return gate as Gate
}

// What pr-gate --head-only answers: the head, the draft and the labels, which the gate reads again just before it writes.
export type HeadRead = Pick<Gate, 'head' | 'draft' | 'labels'>

export function parseHeadRead(text: string): HeadRead {
  const read: unknown = JSON.parse(text)
  if (!isRecord(read) || typeof read['head'] !== 'string' || !/^[0-9a-f]{40}$/.test(read['head']) || !Array.isArray(read['labels'])) {
    throw new Error('pr-gate answered no head and labels')
  }
  return { head: read['head'], draft: read['draft'] === true, labels: read['labels'].map(String) }
}

const head7 = (sha: string) => sha.slice(0, 7)

// The records of the pull request at a head (its own, omitted) that parse and agree with it, by file name,
// and the names of those that do not.
export function headRecordsRead(gate: Gate, files: RecordFile[], head: string = gate.head): { read: Map<string, PrRecord>; skipped: string[] } {
  const read = new Map<string, PrRecord>()
  const skipped: string[] = []
  for (const file of files) {
    let record: PrRecord | undefined
    try {
      record = parsePrRecord(JSON.parse(file.text))
    } catch {
      record = undefined
    }
    if (!record || record.head.toLowerCase() !== head
      || record.repo.toLowerCase() !== gate.repo.toLowerCase()
      || record.pr !== Number(gate.pr)
      || !file.name.startsWith(record.kind + '.')) {
      skipped.push(file.name)
      continue
    }
    read.set(file.name, record)
  }
  return { read, skipped }
}

/**
 * Whether `a` decides over `b`, two records of one kind (or a record and a forge copy of it): the later instant; on
 * the same second, a failure over any other result, then the result's name. Every machine holding both picks the same
 * one of two that tell different stories, so the Ready label does not follow each machine's own reading.
 */
export function supersedes(a: Pick<PrRecord, 'at' | 'result'>, b: Pick<PrRecord, 'at' | 'result'>): boolean {
  if (a.at !== b.at) return a.at > b.at
  if (a.result === b.result) return false
  if (a.result === 'fail' || b.result === 'fail') return a.result === 'fail'
  return a.result > b.result
}

// Per kind, the record that decides: the latest `at`, a failure over the others on the same second.
function latestByKind(read: Map<string, PrRecord>): Map<Kind, PrRecord> {
  const latest = new Map<Kind, PrRecord>()
  for (const record of read.values()) {
    const before = latest.get(record.kind)
    if (!before || !supersedes(before, record)) latest.set(record.kind, record)
  }
  return latest
}

/** The latest review record of the head, whatever its result. */
export function latestReview(gate: Gate, files: RecordFile[]): PrRecord | undefined {
  return latestByKind(headRecordsRead(gate, files).read).get(ACCEPTANCE.kind)
}

/** The detail of the orchestrator's acceptance, when it is what lets the review pass at the head. */
export function reviewAccepted(gate: Gate, files: RecordFile[]): string | undefined {
  const record = latestReview(gate, files)
  return record && isAcceptance(record) ? record.detail : undefined
}

// The files of a head's records that do not parse, each with the kinds it may hold: the one its name
// (`<kind>.<at>.<producer>.json`) gives, or every kind when its name gives none.
export function unreadableRecords(files: RecordFile[]): Array<{ name: string; kinds: Kind[] }> {
  const unreadable: Array<{ name: string; kinds: Kind[] }> = []
  for (const file of files) {
    let record: PrRecord | undefined
    try {
      record = parsePrRecord(JSON.parse(file.text))
    } catch {
      record = undefined
    }
    if (record) continue
    const named = KINDS.find((kind) => file.name.startsWith(kind + '.'))
    unreadable.push({ name: file.name, kinds: named ? [named] : [...KINDS] })
  }
  return unreadable
}

// The pull requests a head's records name, whatever their head.
export function recordPrs(files: RecordFile[]): number[] {
  const prs = new Set<number>()
  for (const file of files) {
    try {
      const record = parsePrRecord(JSON.parse(file.text))
      if (record) prs.add(record.pr)
    } catch {
      // Names none.
    }
  }
  return [...prs]
}

// A record of an earlier head of the pull request, counted at its head as their diffs are the same, or
// the operator's waiver of its E2E or norms check (`waived`: who recorded his answer, and when).
export type Carried = { kind: Kind; from: string; waived?: string }

// The kinds with no record of the pull request at its head: the ones an earlier head may carry. A
// kind a file that does not parse may hold is none of them: that file may be its newest failure.
export function unrecorded(gate: Gate, files: RecordFile[]): Kind[] {
  const latest = latestByKind(headRecordsRead(gate, files).read)
  const unread = new Set(unreadableRecords(files).flatMap((file) => file.kinds))
  return KINDS.filter((kind) => !latest.has(kind) && !unread.has(kind))
}

// The latest record of each kind of the pull request at an earlier head, whatever its result.
export function headLatest(gate: Gate, head: string, files: RecordFile[]): Map<Kind, PrRecord> {
  return latestByKind(headRecordsRead(gate, files, head.toLowerCase()).read)
}

// A record an earlier head carries to a head of the same diff, when it is the latest of its kind
// across the earlier heads of that diff (core's readiness contract).
export const carries = carriesAcross

// The operator's waiver of a kind of the pull request at an earlier head, whatever its diff: it stands for every
// later head while it is the newest record of that kind across them. A record file there that may be a later
// record of that kind but does not parse stands for none.
export function durableWaiver(gate: Gate, found: ReadonlyMap<string, RecordFile[]>, kind: Kind): Carried | undefined {
  let newest: { record: PrRecord; from: string } | undefined
  for (const [head, files] of found) {
    if (unreadableRecords(files).some((file) => file.kinds.includes(kind))) return undefined
    const record = headLatest(gate, head, files).get(kind)
    if (record && (!newest || record.at > newest.record.at)) newest = { record, from: head }
  }
  return newest?.record.result === 'waived' ? { kind, from: newest.from } : undefined
}

// The shortest sha of a head that names it: the 7 hex git prints by default.
const SHA_MIN = 7

// Whether a sha given by an act names the head: the head itself or a prefix of it of SHA_MIN hex or more.
export function namesHead(sha: string, head: string): boolean {
  const given = sha.toLowerCase()
  return given === head || (given.length >= SHA_MIN && /^[0-9a-f]+$/.test(given) && head.startsWith(given))
}

// GitHub's mergeability as pr-gate reads it: a head that conflicts with its base (false, or dirty), and one GitHub is still computing (null, unknown).
// An absent field is not read at all, and blocks nothing.
const isConflicting = (gate: Gate): boolean => gate.mergeable === false || gate.mergeable_state === 'dirty'
// The item a gate names while GitHub computes mergeability; an act (merge, leaving draft) does not wait for it.
export const COMPUTING_ITEM = 'mergeability unknown: GitHub is computing it, read again'
const isComputing = (gate: Gate): boolean => gate.mergeable === null || gate.mergeable_state === 'unknown'

// What a pull request misses to be ready at its head, as core's readiness contract defines it
// (readiness.ts), and before that an act that cannot be ready at all (closed, moved head).
// excused: the kinds its check plan or the operator's exemption excuses, each standing for its record unless a run failed.
// carried: the kinds with no record at the head that an earlier head of the same diff holds.
// holder: only the conditions that holder refuses a merge on; every condition, omitted.
// lightCiOff: why the repository has no light CI (none configured, or the operator's dated refusal): a stacked pull request needs no tests.
export function missingItems(gate: Gate, files: RecordFile[], sha?: string, excused: Excused = {}, carried: Carried[] = [],
  holder?: Holder, lightCiOff?: string): string[] {
  const missing: string[] = []
  if (gate.state !== 'open') missing.push('the pull request is ' + gate.state)
  if (sha && !namesHead(sha, gate.head)) missing.push('the head moved: ' + sha + ' given, ' + gate.head + ' on GitHub')
  // A conflict with the base is named; a mergeability GitHub has not computed yet is named too, and read again by the next gate.
  if (isConflicting(gate)) missing.push('conflict with base')
  // Only the Ready path waits for an unknown state: a merge right after a push is not refused for it.
  else if (!holder && isComputing(gate)) missing.push(COMPUTING_ITEM)
  const { read, skipped } = headRecordsRead(gate, files)
  const ci = gate.ci
  const lacking = missingEvidence({
    latest: latestByKind(read),
    excused: new Set(KINDS.filter((kind) => excused[kind])),
    required: new Set(excused.required ?? []),
    carried: new Set(carried.map((c) => c.kind)),
    // A repository with no CI configured has no CI to wait for.
    ciGreen: ci.result === 'SUCCESS' || ci.result === NO_CI,
    ciFailed: ci.result === 'FAILURE',
    ciNone: ci.result === NO_CI,
    stacked: gate.stacked === true,
    lightCiOff: lightCiOff !== undefined,
  })
  const held = holder ? heldBy(lacking, holder) : lacking
  const kinds = held.flatMap((item) => item.condition === 'ci' ? [] : [item])
  for (const { condition, record } of kinds) {
    if (!record && condition === SCRIPTED.kind) missing.push(lightCiMissing(gate))
    else if (!record) missing.push(condition + ': no record at ' + head7(gate.head))
    else missing.push(condition + ': ' + record.result + ' at ' + head7(gate.head) + ' by ' + record.producer + (record.detail ? ', ' + record.detail : ''))
  }
  // A file skipped is named only beside a kind it may have been meant for: with
  // the kinds accepted it blocks nothing, as nobody may delete it.
  if (kinds.length > 0) for (const name of skipped) missing.push('unreadable record ' + name)
  // CI is named when its holder asks it: GitHub's on the bottom pull request, the gate's failure on a stacked one.
  // A stacked pull request whose light CI is off or absent waits for its forge checks while they run: they are the proof
  // the light CI would give. With light CI on, its tests record stands over a pending forge check, so nothing is named here.
  // A tests item already missing names the same wait, so it is not named twice.
  const testsMissing = missing.some((item) => item.startsWith(SCRIPTED.kind + ':'))
  if (!holder && gate.stacked === true && lightCiOff !== undefined && ci.result !== 'FAILURE' && (ci.running ?? 0) > 0 && !testsMissing) {
    missing.push('CI still running')
  }
  if (!held.some((item) => item.condition === 'ci')) return missing
  if (ci.result === 'FAILURE') missing.push('CI failed: ' + (ci.failed ?? []).join(', '))
  else if (ci.result !== 'SUCCESS' && ci.result !== NO_CI) {
    const skippedChecks = ci.skipped ?? []
    // A read of the checks the base requires that failed: green cannot be told, and the failure is named.
    const unverified = ci.unverified ?? []
    if (unverified.length > 0) missing.push('CI unverified: ' + unverified.join('; '))
    if (skippedChecks.length > 0 && !ci.running) missing.push('CI did not run: ' + skippedChecks.join(', ') + ' skipped')
    else if (unverified.length === 0 || ci.running) missing.push('CI still running')
  }
  return missing
}

// An item of missingItems that names a record absent at the head: no run, no verdict, nothing that failed.
const ABSENT_RECORD = new RegExp('^(?:' + KINDS.join('|') + '): no record at [0-9a-f]+$')

/** Whether what a pull request misses is only records absent at its head: what the gate observes on an act, and does not refuse. */
export function onlyAbsentRecords(missing: readonly string[]): boolean {
  return missing.length > 0 && missing.every((item) => ABSENT_RECORD.test(item))
}

// What a stacked pull request misses with neither a tests record nor its checks green: the light CI's run.
const LIGHT_CI_STACKED = ' and its checks not green: stacked on '
function lightCiMissing(gate: Gate): string {
  return SCRIPTED.kind + ': no record at ' + head7(gate.head) + LIGHT_CI_STACKED + (gate.base || 'another pull request')
    + ', run ' + SCRIPTED.tool + ' {"action": "run", "pr": ' + gate.pr + '} from a clean checkout of its head'
}

// That item of missingItems: the light CI has not run at the head. A head the walk of a stack moved by merging a member it gated
// into it holds the reviewed head and that member, whose run proved them: the item is then an absent record, as the others are.
export const LIGHT_CI_ABSENT = new RegExp('^' + SCRIPTED.kind + ': no record at [0-9a-f]+' + LIGHT_CI_STACKED)

// The CI result of a repository with no CI configured (engine's gate_ci): no workflow, no required check, no check on
// its default branch. It holds the place of green CI, named as such in the Ready line.
export const NO_CI = 'NONE'
const NO_CI_TEXT = 'no CI configured'

// What stands for green CI at a stacked pull request's head, as the Ready line names it, or undefined on the bottom
// pull request (`no CI configured` on either, in a repository with none): why the repository has no light CI, the tests record (its own or carried), or the checks green.
export function stackedCi(gate: Gate, files: RecordFile[], carried: Carried[] = [], lightCiOff?: string): string | undefined {
  if (gate.stacked !== true) return gate.ci.result === NO_CI ? NO_CI_TEXT : undefined
  if (lightCiOff !== undefined) return lightCiOff
  const tests = latestByKind(headRecordsRead(gate, files).read).get(SCRIPTED.kind)
  if (tests && accepts(tests)) return 'passed local tests (' + SCRIPTED.producer + ')'
  if (!tests && carried.some((c) => c.kind === SCRIPTED.kind)) return 'passed local tests (' + SCRIPTED.producer + ')'
  return gate.ci.result === NO_CI ? NO_CI_TEXT : 'green CI'
}

// An undraft only for the CI to run: the pull request carries Not Ready and no
// check of its head has passed yet, so it leaves draft still Not Ready.
export function ciUndraft(gate: Gate): boolean {
  const ci = gate.ci
  const passed = (ci.total ?? 0) - (ci.failed ?? []).length - (ci.running ?? 0) - (ci.skipped ?? []).length
  return gate.labels.some((label) => label.toLowerCase() === NOT_READY) && ci.result !== 'SUCCESS' && ci.result !== NO_CI && passed <= 0
}

// A draft the gate takes out of draft by itself, for the CI the draft state keeps from passing: a CI undraft, and either no check ran
// (none, or all skipped) or every failed check failed because it is a draft (the engine read it in the workflow). A CI that runs and
// passes, or fails for a reason of its own, leaves the draft as it is.
export function gateUndraft(gate: Gate): boolean {
  if (!ciUndraft(gate)) return false
  const ci = gate.ci
  const failed = (ci.failed ?? []).length
  // A read of the required checks that failed is no evidence the draft state keeps CI from running.
  return failed === 0 ? (ci.running ?? 0) === 0 && (ci.unverified ?? []).length === 0 : ci.draft_failed === true
}

// Whether what a pull request misses is CI alone (missingItems names each CI item « CI … »): the only thing a draft gains by leaving draft.
export function ciOnlyMissing(missing: readonly string[]): boolean {
  return missing.length > 0 && missing.every((item) => item.startsWith('CI '))
}

export function carriesReady(gate: Gate): boolean {
  return gate.labels.some((label) => label.toLowerCase() === READY)
}

// The label the gate puts on an open pull request, or undefined to leave it: Ready when nothing is
// missing and it does not carry Ready alone, Not Ready when it carries Ready and something is, or
// carries neither label and `unlabelled` asks it (the reconciler's). A closed or merged one keeps its labels.
export function labelMove(gate: Gate, missing: string[], unlabelled = false): 'ready' | 'not-ready' | undefined {
  if (gate.state !== 'open') return undefined
  const notReady = gate.labels.some((label) => label.toLowerCase() === NOT_READY)
  if (missing.length === 0) return carriesReady(gate) && !notReady ? undefined : 'ready'
  return carriesReady(gate) || (unlabelled && !notReady) ? 'not-ready' : undefined
}

// ---- the texts ----

// The records counted at the head from an earlier head of the same diff, as the lines name them.
export function carriedText(carried: Carried[]): string {
  return carried.map((c) => (c.waived ? c.kind + ' waived by the operator (' + c.waived + ')' : c.kind + ' carried from ' + head7(c.from))).join(', ')
}

const tail = (missing: string[], carried: Carried[] = []) =>
  'Missing: ' + missing.join(', ') + (carried.length > 0 ? '; ' + carriedText(carried) : '')

// Why a GraphQL mutation that may leave draft is refused: the readiness gate needs the pull request named.
const LEAVE_DRAFT = 'leaving draft meets the readiness gate, which needs the pull request named, and Ready is put'
  + ' by the gate once the pull request is ready'

export function notReadyRefusal(act: string, repo: string, pr: number, head: string, missing: string[], carried: Carried[] = []): string {
  return 'github: ' + act + ' refused on ' + repo + '#' + pr + ' at ' + head7(head) + ': not ready. ' + tail(missing, carried)
    + '. What Ready needs is core\'s readiness contract (core/readiness.ts).'
}

// The readiness label a pull request carries, as pr-readiness's answer names it.
function carriedLabel(labels: string[]): string {
  if (labels.some((label) => label.toLowerCase() === READY)) return 'Ready'
  return labels.some((label) => label.toLowerCase() === NOT_READY) ? 'Not Ready' : 'no readiness label'
}

// pr-readiness ready on a pull request the gate reads not ready: the state it carries now and what
// is missing, an answer and no refusal.
export function notReadyAnswer(repo: string, pr: number, head: string, labels: string[], missing: string[], carried: Carried[] = []): string {
  return 'github: ' + repo + '#' + pr + ' carries ' + carriedLabel(labels) + ' at ' + head7(head) + ', Ready not put: not ready. '
    + tail(missing, carried) + '.'
}

// pr-readiness ready whose readiness could not be read: the state it carries, when read, and why.
export function unverifiedAnswer(repo: string | undefined, pr: number | string | undefined, error: string, labels?: string[]): string {
  return 'github: ' + (repo ?? 'the origin repository') + '#' + (pr ?? '?') + (labels ? ' carries ' + carriedLabel(labels) : '')
    + ', Ready not put: readiness unverified: ' + error
}

// repo undefined: the call names no repository the guard could read.
export function unverifiedRefusal(repo: string | undefined, pr: number | string | undefined, error: string): string {
  if (repo === undefined) return 'github: readiness unverified: ' + error
  return 'github: readiness of ' + repo + '#' + (pr ?? '?') + ' unverified: ' + error
}

export function unreadablePrRefusal(act: string): string {
  return 'github: ' + act + ' refused: the pull request number cannot be read from the command.'
    + ' Write it as a number, or run the tool\'s mcp__github__gh call with {"pr": <n>}.'
}

export function unnamedRepoRefusal(act: string): string {
  const option = act.startsWith('gh.py ') ? '--repo' : '-R'
  return 'github: ' + act + ' refused: name the repository with ' + option + ' owner/name.'
}

// A GraphQL mutation names a node, not a repository and a number.
export function graphqlRefusal(kind: ActKind): string {
  const named = 'github: gh api graphql refused: the pull request it acts on cannot be read from the command.'
  if (kind !== 'merge') {
    return named + ' Run mcp__github__gh pr-ready {"pr": <n>} on <owner/name>; ' + LEAVE_DRAFT + '.'
  }
  return named + ' Run mcp__github__gh pr-merge {"pr": <n>} on <owner/name>: it checks that the pull request is ready.'
}

// A GraphQL query the command line does not show may leave draft or merge.
export function opaqueGraphqlRefusal(): string {
  return 'github: gh api graphql refused: its query cannot be read from the command (a file, stdin or a shell'
    + ' expansion), and ' + LEAVE_DRAFT + '. Write the query inline, or run the mcp__github__gh call it stands for.'
}

export const STDIN_REFUSAL = 'github: gh.py --stdin-json refused from Bash: its request cannot be read from the command.'
  + ' Run the mcp__github__gh call, or gh.py with its subcommand and arguments.'

// name: the command as the refusal names it, by default the gh command.
export function autoMergeRefusal(repo: string, pr?: number, name?: string): string {
  return 'github: ' + (name ?? 'gh pr merge') + ' refused on ' + repo + ': this repository is not in auto-merge, so a merge'
    + ' needs the operator\'s explicit word. When they gave it, run mcp__github__gh pr-merge {"pr": ' + (pr ?? '<n>') + '} on '
    + repo + ': it checks that the pull request is ready, then asks them in the conversation.'
}

// A Bash merge the gate let through that pins no head: the line names the flag that pins the gated one.
export function unpinnedMergeRefusal(name: string, repo: string, pr: number, head: string): string {
  const flag = name.startsWith('gh.py ') ? '--sha ' : name === 'gh api' ? '-f sha=' : '--match-head-commit '
  return 'github: ' + name + ' refused on ' + repo + '#' + pr + ': pin the head the gate checked, ' + flag + head + '.'
}

export function ciUndraftLine(repo: string, pr: number): string {
  return 'github: ' + repo + '#' + pr + ' out of draft to run CI, still Not Ready'
}

// The lines the gate says when it reads a pull request: the label it put, or what is still missing.
// accepted: the points the orchestrator's acceptance set aside at the head, named in place of a clean review.
// excused: the kinds the check plan or the exemption stood for, named.
// carried: the kinds counted at the head from an earlier head of the same diff.
// ciText: what stands for green CI on a stacked pull request, or in a repository with no CI (stackedCi).
export function gateReadyLine(repo: string, pr: number, head: string, accepted?: string, excused: Excused = {},
  carried: Carried[] = [], ciText = 'green CI'): string {
  return 'github: ' + repo + '#' + pr + ' Ready at ' + head7(head)
    + ': ' + (accepted ? reviewAcceptedLine(accepted) : 'a clean review') + ', '
    + (excused.norms ? 'no norms check needed (' + excused.norms + '), ' : '')
    + (excused.e2e ? 'no E2E needed (' + excused.e2e + ')' : 'passed E2E') + ' and ' + ciText + ' hold at its head'
    + (carried.length > 0 ? ' (' + carriedText(carried) + ').' : '.')
}

export function reviewAcceptedLine(detail: string): string {
  return 'review accepted by the orchestrator (' + detail + ')'
}

export function gateNotReadyLine(repo: string, pr: number, head: string, missing: string[], carried: Carried[] = []): string {
  return 'github: ' + repo + '#' + pr + ' back to Not Ready at ' + head7(head) + '. ' + tail(missing, carried)
}

export function gateMissingLine(repo: string, pr: number, head: string, missing: string[], accepted?: string, carried: Carried[] = []): string {
  return 'github: ' + repo + '#' + pr + ' not Ready yet at ' + head7(head) + '. '
    + (accepted ? reviewAcceptedLine(accepted) + '. ' : '') + tail(missing, carried)
}

// The kinds no earlier head carries (every kind, omitted), for the reason given.
export function uncarriedLine(repo: string, pr: number, head: string, reason: string, kinds?: Kind[]): string {
  return 'github: ' + repo + '#' + pr + ': no ' + (kinds ? kinds.join(', ') + ' ' : '') + 'record carried to ' + head7(head) + ': ' + reason
}

// The gate read nothing it can trust (the pull request, its records): the label stays.
export function gateLeftLine(repo: string, pr: number, error: string): string {
  return 'github: the Ready label of ' + repo + '#' + pr + ' is left as it is: ' + error
}

export function gateMovedLine(repo: string, pr: number, read: string, now: string): string {
  return 'github: the Ready label of ' + repo + '#' + pr + ' is left as it is: the head moved from ' + head7(read)
    + ' to ' + head7(now) + ' while the gate read it, no label written.'
}

// Why Ready is held over a Not Ready this machine did not set, and until when (ms) at the earliest; undefined: the clock cannot be read.
// failing: the other machine's statuses cannot be imported, so no listing of the forge counts.
function heldWhy(until: number | undefined, now: number, failing = false): string {
  const set = 'the Not Ready it carries was not set by this machine, and '
  if (until === undefined) return set + 'the clock cannot be read, so the wait cannot be told: Ready waits for it'
  if (failing) return set + 'the statuses the forge holds cannot be imported here (no listing counts until they are): Ready waits for the import'
  if (until <= now) {
    return set + 'the forge is not known to be listed since the wait: it is read again by the reconciler\'s next listing, '
      + String(IDLE_MAX_MS / 60_000) + ' minutes at the latest while it runs: try again after it'
  }
  return set + 'the forge is read again first, in ' + String(Math.max(1, Math.ceil((until - now) / 1000))) + ' s at the earliest'
}

// The gate's line when Ready is held over a Not Ready this machine did not set.
export function gateHeldLine(repo: string, pr: number, head: string, until: number | undefined, now: number, failing = false): string {
  return 'github: the Ready label of ' + repo + '#' + pr + ' is left as it is at ' + head7(head) + ': ' + heldWhy(until, now, failing) + '.'
}

// The refusal of an act that needs Ready, held the same way.
export function gateHeldRefusal(act: string, repo: string, pr: number, head: string, until: number | undefined, now: number, failing = false): string {
  return 'github: ' + act + ' refused on ' + repo + '#' + pr + ' at ' + head7(head) + ': ' + heldWhy(until, now, failing) + '.'
}

// pr-readiness ready held the same way: the state it carries, an answer and no refusal.
export function gateHeldAnswer(repo: string, pr: number, head: string, labels: string[], until: number | undefined, now: number, failing = false): string {
  return 'github: ' + repo + '#' + pr + ' carries ' + carriedLabel(labels) + ' at ' + head7(head) + ', Ready not put: ' + heldWhy(until, now, failing) + '.'
}

// Ready goes over a Not Ready this machine did not set, no listing of the forge having followed the wait.
export function gateHeldGivenUpLine(repo: string, pr: number, head: string, minutes: number): string {
  return 'github: the Ready label of ' + repo + '#' + pr + ' goes over the Not Ready it carries at ' + head7(head) + ', which this machine did not set: no listing of the forge followed the wait within '
    + String(minutes) + ' minutes, the gate decides on what this machine holds.'
}

export function gateUnwrittenLine(repo: string, pr: number, error: string): string {
  return 'github: the Ready label of ' + repo + '#' + pr + ': label not written: ' + error
}

export const RECORDS_REFUSAL = 'github: records are written by their producers\' tools, and E2E by mcp__github__record,'
  + ' never by hand.'

// A path into the records, or to their directory itself: a message or a body
// that only names the word is no path.
const RECORDS_PATH = /pr-records\/|\/pr-records(?![\w.-])/

// Whether a Bash command line names the records or their writer.
// The text, then each word as the shell reads it: quotes removed, so `rec""ord.py` is record.py.
export function touchesRecords(line: string, root?: string): boolean {
  const names = recordsNamer(root)
  return names(line) || simpleCommands(line).some((argv) => argv.some(names))
}

function recordsNamer(root?: string): (text: string) => boolean {
  return (text) => RECORDS_PATH.test(text) || text.includes('engine/record.py') || (!!root && text.includes(root))
}

// The programs that write nothing a line gives them, but through a redirection or one of the
// options onlyReads refuses. A program outside this list is no read, whatever it is given: a
// guard that must refuse a write cannot know every writer, so it knows the readers.
const READERS: ReadonlySet<string> = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'find', 'stat', 'wc', 'jq', 'diff', 'cmp', 'du',
  'echo', 'printf', 'test', '[', '[[', 'true', 'pwd', 'basename', 'dirname', 'realpath', 'readlink',
])
// find's options that delete, run a program or write a file.
const FIND_WRITES = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/

// Whether a command line only reads: every simple command it holds, a substitution's and a pipeline's
// included, is a program of READERS named bare (a path such as `./ls` is any program), `find` carries
// no writing option, and the line holds no `>` at all, whatever its quoting: the shell reads `>&path`,
// `1>&path`, a redirection inside `$(…)` or backticks and `$'…'` as writes, and the shell reader
// gives no redirection target. A line the reader cannot read is no read.
export function onlyReads(line: string): boolean {
  try {
    if (line.includes('>')) return false
    return readCommands(line).every(({ argv }) => {
      if (argv.length === 0) return true
      const program = argv[0] ?? ''
      if (!READERS.has(program)) return false
      return program !== 'find' || !argv.some((word) => FIND_WRITES.test(word))
    })
  } catch {
    return false
  }
}

// The programs that delete, bare or by path, and the options and calls that delete inside another
// program. A deletion is irreversible: a command line that deletes the records, the E2E exemptions or
// the check plans is refused, where any other write to the exemptions or the plans is observed.
const DELETER_WORD = /(?:^|[\s;&|(){}`'"=])(?:[^\s;&|(){}`'"=]*\/)?(?:rm|rmdir|unlink|shred|srm|trash)(?=$|[\s;&|(){}`'"$])/
const DELETE_OPTION = /(?:^|\s)(?:-delete|--(?:delete[\w-]*|del|remove-files|remove-source-files))(?=\s|=|$)/
const DELETE_CALL = /\b(?:os\.(?:remove|removedirs|unlink|rmdir|rename|replace)|shutil\.(?:rmtree|move)|rmtree|rmSync|rmdirSync|unlinkSync|renameSync|fs\.(?:rm|rmdir|unlink|rename)|File\.(?:delete|unlink|rename)|FileUtils\.(?:rm|mv|remove)\w*)\b|\.(?:unlink|rmdir)\s*\(/
const GIT_DELETERS: ReadonlySet<string> = new Set(['clean', 'rm'])
const GIT_TEXT = /\bgit\b[^;&|]*\b(?:clean|rm)\b/
const MOVE_WORD = /(?:^|[\s;&|(){}`'"=])(?:[^\s;&|(){}`'"=]*\/)?mv(?=$|[\s;&|(){}`'"$])/
const DELETERS: ReadonlySet<string> = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash'])
const MAX_NESTING = 4

// Whether the argv of a command that moves (`mv`) takes something `names` recognises out of its place: a source
// (every operand but the last, or any with -t / --target-directory), or what a pipeline feeds it.
function movesOut(argv: readonly string[], names: (text: string) => boolean, fed: boolean): boolean {
  const operands = argv.slice(1)
  const toDirectory = operands.some((word) => word === '--target-directory' || word.startsWith('--target-directory=') || /^-[A-Za-z]*t$/.test(word))
  return fed || (toDirectory ? operands.some(names) : operands.slice(0, -1).some(names))
}

function deletesIn(line: string, names: (text: string) => boolean, depth: number): boolean {
  if (DELETER_WORD.test(line) || DELETE_OPTION.test(line) || DELETE_CALL.test(line)) return true
  let commands
  try {
    commands = readCommands(line)
  } catch {
    // A line that cannot be read: a move is judged on its text.
    return (MOVE_WORD.test(line) || GIT_TEXT.test(line)) && names(line)
  }
  // The reader gives nothing for a line it cannot close (`$(`): that is no read either.
  if (commands.length === 0) return line.trim() !== '' && (MOVE_WORD.test(line) || GIT_TEXT.test(line)) && names(line)
  return commands.some(({ argv, wrappers }) => {
    const program = (argv[0] ?? '').split('/').pop() ?? ''
    if (argv.some((word) => DELETERS.has(word.split('/').pop() ?? ''))) return true
    const git = gitSubcommand(argv)
    if (git && GIT_DELETERS.has(argv[git.at] ?? '')) return true
    if (program === 'mv') return movesOut(argv, names, wrappers.includes('xargs'))
    if (argv.slice(1).includes('mv') && argv.some(names)) return true
    const inner = innerLine(argv)
    return inner !== undefined && depth < MAX_NESTING && deletesIn(inner, names, depth + 1)
  })
}

// Whether a command line that is not only a read deletes: a deleting program anywhere in its text
// (`bash -c`, `xargs`, `find -exec` and `&&` included), `find -delete`, `git clean`, a deleting call of an
// interpreter, a word that reads as a deleting program once its quotes are gone, or a move out of what
// `names` recognises (a move out of a place deletes there; a move into it only writes).
export function deletes(line: string, names: (text: string) => boolean): boolean {
  let reads = false
  try {
    reads = onlyReads(line) && readCommands(line).length > 0
  } catch {
    // A line that cannot be read is no read.
  }
  return !reads && deletesIn(line, names, 0)
}

// Whether a Bash command line deletes in the records: it names them and deletes.
export function deletesRecords(line: string, root?: string): boolean {
  const names = recordsNamer(root)
  let touches: boolean
  try {
    touches = touchesRecords(line, root)
  } catch {
    // A line the reader cannot read is judged on its text.
    touches = names(line)
  }
  return touches && deletes(line, names)
}

export const STATUS_REFUSAL = 'github: commit statuses are posted by the github module alone (engine/forge_status.py, before a record'
  + ' is written and from its reconciler): the readiness/ copies of the records are its own, and any other status reads as CI.'

// A commit status's write path, `…/statuses/<sha>`; the reads are `…/commits/<ref>/status(es)`, with no slash after.
const STATUS_PATH = /\/statuses\//
// What makes a call to it a write: a method that writes, or the fields, data or body that make gh api, curl and wget post.
const STATUS_WRITE = /(?:^|\s)(?:-X\s*|--request[=\s]|--method[=\s])['"]?(?:POST|PUT|PATCH)\b|(?:^|\s)(?:-f|-F|--field|--raw-field|--input|-d|--data(?:-raw|-binary|-urlencode|-ascii)?|--json|--form|--post-data|--post-file)(?=[\s=]|$)/i
// The same written as one word, its value attached: `-fstate=success`, `-d@body.json`, `-XPOST`.
const WRITE_WORD = /^(?:-[fF][^\s=]+=|-d.|-X(?:POST|PUT|PATCH)$|--(?:request|method)=(?:POST|PUT|PATCH)$)/i
// httpie and xh write with a method word or with `key=value` / `key:=value` items.
const HTTPIE_WRITE = /^(?:POST|PUT|PATCH|[\w.-]+:?=.*)$/i
const STATUS_CLIENT = /\b(?:gh\s+api|gh\s+alias\s+set|curl|wget|http|https|xh)\b/
const INTERPRETER = /^(?:python[\d.]*|node|deno|bun|ruby|perl)$/
// The module's writer, by its file (a glob included) or its function.
const FORGE_WRITER = /forge_(?:status|[*?[])|forge\.post\b/

// Whether one simple command, quotes removed, posts a status: a client calling the statuses path to write, or an
// interpreter given that path or the module's writer.
function commandPostsStatus(argv: readonly string[]): boolean {
  const [program = '', ...rest] = argv
  const name = program.slice(program.lastIndexOf('/') + 1)
  if (!rest.some((word) => STATUS_PATH.test(word))) return INTERPRETER.test(name) && rest.some((word) => FORGE_WRITER.test(word))
  if (INTERPRETER.test(name)) return true
  const words = rest.join(' ')
  if (name === 'http' || name === 'https' || name === 'xh') return rest.some((word) => HTTPIE_WRITE.test(word)) || STATUS_WRITE.test(words)
  const client = name === 'curl' || name === 'wget' || (name === 'gh' && (rest[0] === 'api' || (rest[0] === 'alias' && rest[1] === 'set')))
  return client && (STATUS_WRITE.test(words) || rest.some((word) => WRITE_WORD.test(word)))
}

// Whether a Bash command line posts a commit status: it runs the module's writer, or calls the statuses API to write.
// The text, then each simple command as the shell reads it: quotes removed, so `statu""ses` is statuses.
export function postsStatus(line: string): boolean {
  let commands: string[][] | undefined
  try {
    commands = simpleCommands(line)
  } catch {
    // A line the reader cannot read is judged on its text.
  }
  const words = commands?.flat() ?? []
  if ((FORGE_WRITER.test(line) || words.some((word) => FORGE_WRITER.test(word))) && !onlyReads(line)) return true
  if (STATUS_CLIENT.test(line) && STATUS_PATH.test(line) && STATUS_WRITE.test(line)) return true
  return (commands ?? []).some(commandPostsStatus)
}

// The record kind a caller of mcp__github__record may write, by the plugin whose hook made the
// call: the one the record contract names it the producer of, the open kind (E2E) for the model
// (the engine) and any other plugin.
export function recordKindFor(origin: string): string {
  return kindFor(origin)
}

// The refusal of a record of a kind its caller does not write, naming the producer the contract declares.
export function kindRefusal(kind: string, origin: string, owned: string): string {
  if (kind === SCRIPTED.kind) {
    return 'github: ' + kind + ' records are written by ' + SCRIPTED.tool + ' alone, from the run of the project\'s command: '
      + (origin === 'engine' ? 'this tool' : origin) + ' writes ' + owned + ' only.'
  }
  const producers = producersOf(kind)
  const by = producers.length > 0 ? ' (' + producers.map((p) => p.plugin + ', ' + p.tool).join('; ') + ')' : ''
  return 'github: ' + kind + ' records are written by their producer' + by + ': '
    + (origin === 'engine' ? 'this tool' : origin) + ' writes ' + owned + ' only.'
}

// The refusal of an acceptance (core's ACCEPTANCE) from any writer but its own.
export function acceptanceOriginRefusal(origin: string): string {
  return 'github: an ' + ACCEPTANCE.result + ' ' + ACCEPTANCE.kind + ' is the ' + ACCEPTANCE.plugin + '\'s decision, written by '
    + ACCEPTANCE.tool + ' in an ' + ACCEPTANCE.plugin + ' session; ' + (origin === 'engine' ? 'this tool' : origin) + ' writes none.'
}

// The refusal of a pass over a failed review at the same head: the orchestrator accepts it, with its set-asides.
export function passOverFailRefusal(head: string): string {
  return 'github: the latest review at ' + head7(head) + ' failed: a pass does not override it. Set its points aside with'
    + ' their reasons ({"verdict": "' + ACCEPTANCE.result + '", "set_asides": [...]}), or fix them and review the new head.'
}

// A plugin's name as a producer slug.
export function producerSlug(origin: string): string {
  return origin === 'engine' ? 'session-e2e' : origin.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}

// The head directories older than the cut-off, by their newest file.
export const PRUNE_DAYS = 90
export const PRUNE_EVERY_MS = 24 * 3600 * 1000
