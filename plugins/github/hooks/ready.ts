// The decisions of the ready guard and the auto-merge split: which call marks
// a pull request ready, leaves draft, merges it or opens it, which push moves
// a branch's head, and what a pull request still misses to be ready at its
// head. Pure functions only: register.ts reads GitHub, the records and the
// session, and answers the calls.

import { accepts, KINDS, kindFor, parsePrRecord, producerOf, type Kind, type PrRecord } from '../core/pr-record.ts'
import { gitSubcommand, simpleCommands } from '../core/shell.ts'
import { type EngineCall, engineCall, engineFlag, engineOption, engineStart } from './shell.ts'

// warn: an act that is not ready goes ahead with one warn line. enforce: it is
// refused with what it misses.
export type Phase = 'warn' | 'enforce'

// merge: a merge or an auto-merge armed. undraft: out of draft. ready-label:
// the Ready label put on. create: a pull request opened out of draft.
// create-draft: one opened as a draft. redraft: one put back to draft.
export type ActKind = 'merge' | 'undraft' | 'ready-label' | 'create' | 'create-draft' | 'redraft'

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
  ci: { result: string; failed: string[]; running?: number; skipped?: string[]; total: number }
}

// One file of a head's records directory.
export type RecordFile = { name: string; text: string }

// The record contract is core's (pr-record.json); its kinds are re-exported for the module's readers.
export { KINDS } from '../core/pr-record.ts'

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

type Parsed = { repo?: string; opts: Array<[string, string | undefined]>; positionals: string[] }

// The options and positionals of a gh command's words, -R wherever it stands.
function parseWords(words: string[], valued: string[]): Parsed {
  const out: Parsed = { opts: [], positionals: [] }
  for (let k = 0; k < words.length; k++) {
    const word = words[k]
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
  const value = given[given.length - 1][1]
  return value === undefined || !/^(false|f|0)$/i.test(value)
}

function values(parsed: Parsed, ...flags: string[]): string[] {
  return parsed.opts.filter(([flag, value]) => flags.includes(flag) && value !== undefined).map(([, value]) => value as string)
}

function namesReady(list: string[]): boolean {
  return list.some((value) => value.split(',').some((label) => label.trim().toLowerCase() === READY))
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
    const word = argv[k]
    if (word === '-R' || word === '--repo') { k += 2; continue }
    if (word.startsWith('-')) { k++; continue }
    named.push(k++)
  }
  if (named.length < 2 || argv[named[0]] !== 'pr' && argv[named[0]] !== 'issue') return undefined
  const noun = argv[named[0]]
  const verb = argv[named[1]]
  const words = argv.filter((_w, i) => i > 0 && i !== named[0] && i !== named[1])
  const parsed = parseWords(words, VALUED[verb] ?? [])
  const repo = parsed.repo
  const base: Act = { kind: 'merge', name: 'gh ' + noun + ' ' + verb, ...(repo ? { repo: repoOf(repo) ?? repo } : {}) }
  if (noun === 'issue') {
    if (verb === 'edit' && namesReady(values(parsed, '--add-label'))) {
      return target({ ...base, kind: 'ready-label' }, parsed.positionals[0])
    }
    return undefined
  }
  if (verb === 'merge') {
    if (has(parsed, '--disable-auto')) return undefined
    const sha = values(parsed, '--match-head-commit')[0]
    return target({ ...base, kind: 'merge', ...(sha ? { sha } : {}) }, parsed.positionals[0])
  }
  if (verb === 'ready') {
    return target({ ...base, kind: flagSet(parsed, '--undo') ? 'redraft' : 'undraft' }, parsed.positionals[0])
  }
  if (verb === 'edit' && namesReady(values(parsed, '--add-label'))) {
    return target({ ...base, kind: 'ready-label' }, parsed.positionals[0])
  }
  if (verb === 'create') {
    // A pull request opened with the Ready label is opened as ready.
    const draft = flagSet(parsed, '-d', '--draft') && !namesReady(values(parsed, '-l', '--label'))
    return { ...base, kind: draft ? 'create-draft' : 'create' }
  }
  return undefined
}

const API_VALUED = [
  '-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq',
  '-t', '--template', '--cache', '-p', '--preview', '--hostname',
]
const MERGE_PATH = /^\/?repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge\/?$/
const LABELS_PATH = /^\/?repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels\/?$/
// An issue or a pull request itself, whose PATCH may set its labels.
const ISSUE_PATH = /^\/?repos\/([^/]+)\/([^/]+)\/(?:issues|pulls)\/(\d+)\/?$/
// The API's own host before a REST path: api.github.com, or a server's /api/v3.
const API_HOST = /^https?:\/\/[^/]+(?:\/api\/v3)?\//
const GRAPHQL = /^(?:https?:\/\/[^/]+(?:\/api)?\/|\/)?graphql\/?$/

// The fields of a gh api command, as [name, value] pairs: -f sends the text as it is, -F reads
// `@file` and types the rest.
function apiFields(parsed: Parsed): Array<{ name: string; value: string; typed: boolean }> {
  return parsed.opts
    .filter(([flag, value]) => ['-f', '--raw-field', '-F', '--field'].includes(flag) && value !== undefined)
    .map(([flag, value]) => {
      const text = value as string
      const at = text.indexOf('=')
      return { name: at === -1 ? text : text.slice(0, at), value: at === -1 ? '' : text.slice(at + 1), typed: flag === '-F' || flag === '--field' }
    })
}

// The labels one field's value names: a JSON list (`["Ready"]`), or names split on commas.
function labelsIn(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.map((item) => (typeof item === 'string' ? item : String(item?.name ?? '')))
    if (typeof parsed === 'string') return [parsed]
  } catch {
    // Not JSON: names split on commas.
  }
  return value.split(',').map((name) => name.trim().replace(/^["'[]+|["'\]]+$/g, ''))
}

function fieldsNameReady(fields: Array<{ value: string }>): boolean {
  return fields.some((field) => labelsIn(field.value).some((name) => name.trim().toLowerCase() === READY))
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

// The act of one gh api command: a merge or a label put through the REST API,
// or a GraphQL mutation that merges, leaves draft, arms auto-merge or puts back to draft.
function apiAct(argv: string[]): Act | undefined {
  const parsed = parseWords(argv.slice(2), API_VALUED)
  const endpoint = parsed.positionals[0]
  if (endpoint === undefined) return undefined
  const fields = apiFields(parsed)
  const input = has(parsed, '--input')
  const explicit = values(parsed, '-X', '--method')[0]
    ?? parsed.opts.filter(([flag]) => /^-X./.test(flag)).map(([flag]) => flag.slice(2))[0]
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
  const at = (match: RegExpExecArray, kind: ActKind): Act => ({ kind, name: 'gh api', repo: match[1] + '/' + match[2], pr: Number(match[3]) })
  if (method === 'PATCH') {
    // A body the hook cannot read may set the labels.
    const issue = ISSUE_PATH.exec(path)
    if (issue && (input || fieldsNameReady(fields.filter((field) => field.name.startsWith('labels'))))) return at(issue, 'ready-label')
    return undefined
  }
  if (method !== 'PUT' && method !== 'POST') return undefined
  const merge = MERGE_PATH.exec(path)
  if (merge) return at(merge, 'merge')
  const labels = LABELS_PATH.exec(path)
  if (labels && (input || fieldsNameReady(fields))) return at(labels, 'ready-label')
  return undefined
}

// The act of one run of the plugin's engine, engine/gh.py, from Bash. A draft
// opened or put back is the engine's to label, as it does for the tool.
function engineAct(call: EngineCall): Act | undefined {
  const repo = call.repo ? repoOf(call.repo) ?? call.repo : undefined
  const number = /^#?\d+$/.test(call.positionals[0] ?? '') ? Number(call.positionals[0].replace('#', '')) : undefined
  const rest = number !== undefined ? call.positionals.slice(1) : call.positionals
  const at = (kind: ActKind, extra: Partial<Act> = {}): Act => ({
    kind, name: 'gh.py ' + call.command, ...(repo ? { repo } : {}), ...(number !== undefined ? { pr: number } : { unreadable: true }), ...extra,
  })
  const sha = engineOption(call, '--sha')
  if (call.command === 'pr-merge') return at('merge', sha ? { sha } : {})
  if (call.command === 'pr-ready') return at('undraft', { forCi: engineFlag(call, '--for-ci') })
  if (call.command === 'pr-readiness' && rest.some((word) => word.toLowerCase() === READY)) return at('ready-label')
  if (call.command === 'label-add' && namesReady(rest)) return at('ready-label')
  if (call.command === 'pr-create' && !engineFlag(call, '--draft')) return { kind: 'create', name: 'gh.py pr-create', ...(repo ? { repo } : {}) }
  return undefined
}

// Every act of a Bash command line, read word by word: a message or a body
// that only mentions one is an argument, not a command. A request the engine
// reads from stdin (`gh.py --stdin-json`) shows no act: it is one of its own, refused.
export function bashActs(line: string): Act[] {
  const found: Act[] = []
  for (const argv of simpleCommands(line)) {
    const start = engineStart(argv)
    if (start !== undefined && argv.length === start + 1 && argv[start] === '--stdin-json') {
      found.push({ kind: 'merge', name: 'gh.py --stdin-json', stdin: true })
      continue
    }
    const engine = engineCall(argv)
    const act = engine ? engineAct(engine) : !GH.test(argv[0] ?? '') ? undefined : argv[1] === 'api' ? apiAct(argv) : prAct(argv)
    if (act) found.push(act)
  }
  return found
}

// The act of a call of the tool, or undefined.
export function toolAct(command: string, args: Record<string, unknown>): Act | undefined {
  const pr = args.pr === undefined || args.pr === null ? undefined : Number(String(args.pr).replace('#', ''))
  const at = (kind: ActKind, extra: Partial<Act> = {}): Act => ({ kind, name: command, ...(pr !== undefined ? { pr } : {}), ...extra })
  if (command === 'pr-ready') return at('undraft')
  if (command === 'pr-draft') return at('redraft')
  if (command === 'pr-merge') return at('merge', typeof args.sha === 'string' ? { sha: args.sha } : {})
  if (command === 'pr-readiness' && String(args.state ?? '').toLowerCase() === 'ready') return at('ready-label')
  if (command === 'label-add') {
    const named = [args.label, args.names, args.name].flatMap((v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]))
    if (namesReady(named.map(String))) return at('ready-label')
  }
  if (command === 'pr-create') return { kind: args.draft === false ? 'create' : 'create-draft', name: command }
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
    const word = argv[k]
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
  const gate = JSON.parse(text)
  if (!gate || typeof gate !== 'object' || typeof gate.head !== 'string' || !/^[0-9a-f]{40}$/.test(gate.head)
    || typeof gate.state !== 'string' || !Array.isArray(gate.labels) || !gate.ci || typeof gate.ci.result !== 'string') {
    throw new Error('pr-gate answered no head, state, labels and ci')
  }
  return gate as Gate
}

const head7 = (sha: string) => sha.slice(0, 7)

// The latest record of each kind of a pull request at a head, and the files that are none of its.
function latestRecords(gate: Gate, head: string, files: RecordFile[]): { latest: Map<Kind, PrRecord>; skipped: string[] } {
  const latest = new Map<Kind, PrRecord>()
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
    const before = latest.get(record.kind)
    if (!before || record.at >= before.at) latest.set(record.kind, record)
  }
  return { latest, skipped }
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

// A record of an earlier head of the pull request, counted at its head as their diffs are the same.
export type Carried = { kind: Kind; from: string }

// The kinds with no record of the pull request at its head: the ones an earlier head may carry.
export function unrecorded(gate: Gate, files: RecordFile[]): Kind[] {
  const { latest } = latestRecords(gate, gate.head, files)
  return KINDS.filter((kind) => !latest.has(kind))
}

// The latest record of each kind of the pull request at an earlier head, whatever its result.
export function headLatest(gate: Gate, head: string, files: RecordFile[]): Map<Kind, PrRecord> {
  return latestRecords(gate, head.toLowerCase(), files).latest
}

// A record an earlier head carries to a head of the same diff, when it is the latest of its kind
// across the earlier heads of that diff: a clean review, a passed norms check, an E2E waiver.
// An E2E pass is run again at the new head.
export function carries(record: PrRecord): boolean {
  return accepts(record) && !(record.kind === 'e2e' && record.result === 'pass')
}

// What a pull request misses to be ready at its head: the four conditions,
// and before them an act that cannot be ready at all (closed, moved head).
// carried: the kinds with no record at the head that an earlier head of the same diff holds.
export function missingItems(gate: Gate, files: RecordFile[], sha?: string, carried: Carried[] = []): string[] {
  const missing: string[] = []
  if (gate.state !== 'open') missing.push('the pull request is ' + gate.state)
  if (sha && sha.toLowerCase() !== gate.head) missing.push('the head moved: ' + sha + ' given, ' + gate.head + ' on GitHub')
  const { latest, skipped } = latestRecords(gate, gate.head, files)
  let kindMissing = false
  for (const kind of KINDS) {
    const record = latest.get(kind)
    if (record && accepts(record)) continue
    if (!record && carried.some((c) => c.kind === kind)) continue
    kindMissing = true
    if (!record) missing.push(kind + ': no record at ' + head7(gate.head))
    else {
      missing.push(kind + ': ' + record.result + ' at ' + head7(gate.head) + ' by ' + record.producer
        + (record.detail ? ', ' + record.detail : ''))
    }
  }
  // A file skipped is named only beside a kind it may have been meant for: with
  // the three accepted it blocks nothing, as nobody may delete it.
  if (kindMissing) for (const name of skipped) missing.push('unreadable record ' + name)
  const ci = gate.ci
  if (ci.result === 'FAILURE') missing.push('CI failed: ' + (ci.failed ?? []).join(', '))
  else if (ci.result !== 'SUCCESS') {
    const skippedChecks = ci.skipped ?? []
    if (skippedChecks.length > 0 && !ci.running) missing.push('CI did not run: ' + skippedChecks.join(', ') + ' skipped')
    else missing.push('CI still running')
  }
  return missing
}

// An undraft only for the CI to run: the pull request carries Not Ready and no
// check of its head has passed yet, so it leaves draft still Not Ready.
export function ciUndraft(gate: Gate): boolean {
  const ci = gate.ci
  const passed = (ci.total ?? 0) - (ci.failed ?? []).length - (ci.running ?? 0) - (ci.skipped ?? []).length
  return gate.labels.some((label) => label.toLowerCase() === NOT_READY) && ci.result !== 'SUCCESS' && passed <= 0
}

export function carriesReady(gate: Gate): boolean {
  return gate.labels.some((label) => label.toLowerCase() === READY)
}

// The label the gate puts on an open pull request, or undefined to leave it: Ready when the four
// hold and it does not carry Ready alone, Not Ready when it carries Ready and they no longer hold.
// A closed or merged one keeps its labels.
export function labelMove(gate: Gate, missing: string[]): 'ready' | 'not-ready' | undefined {
  if (gate.state !== 'open') return undefined
  const notReady = gate.labels.some((label) => label.toLowerCase() === NOT_READY)
  if (missing.length === 0) return carriesReady(gate) && !notReady ? undefined : 'ready'
  return carriesReady(gate) ? 'not-ready' : undefined
}

// ---- the texts ----

// The records counted at the head from an earlier head of the same diff, as the lines name them.
export function carriedText(carried: Carried[]): string {
  return carried.map((c) => c.kind + ' carried from ' + head7(c.from)).join(', ')
}

const tail = (missing: string[], carried: Carried[] = []) =>
  'Missing: ' + missing.join(', ') + (carried.length > 0 ? '; ' + carriedText(carried) : '')

// Why leaving draft is refused outside auto-merge, whatever the route.
const LEAVE_DRAFT = 'outside auto-merge, leaving draft is the operator\'s, on GitHub after their review, and Ready is put'
  + ' by the gate once the four conditions hold'

export function notReadyRefusal(act: string, repo: string, pr: number, head: string, missing: string[], carried: Carried[] = []): string {
  return 'github: ' + act + ' refused on ' + repo + '#' + pr + ' at ' + head7(head) + ': not ready. ' + tail(missing, carried)
    + '. A pull request is ready when a clean review, a passed norms check, passed E2E and'
    + ' green CI are all at its current head (engine/writing/pull-requests.md « Ready pull requests »).'
}

// repo undefined: the call names no repository the guard could read.
export function unverifiedRefusal(repo: string | undefined, pr: number | string | undefined, error: string): string {
  if (repo === undefined) return 'github: readiness unverified: ' + error
  return 'github: readiness of ' + repo + '#' + (pr ?? '?') + ' unverified: ' + error
}

export function draftRefusal(act: string): string {
  return 'github: ' + act + ' refused: open it as a draft, then leave draft once ready.'
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
    return named + ' In a repository in auto-merge, run mcp__github__gh pr-ready {"pr": <n>} on <owner/name>; ' + LEAVE_DRAFT + '.'
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

// Leaving draft, or opening out of draft, in a repository not in auto-merge: never asked, refused.
export function leaveDraftRefusal(act: string, repo: string, pr?: number): string {
  return 'github: ' + act + ' refused on ' + repo + ': ' + LEAVE_DRAFT + ' (pr-readiness {"pr": ' + (pr ?? '<n>')
    + ', "state": "ready"} reads them now).'
}

// name: the command as the refusal names it, by default the gh command of that kind.
export function autoMergeRefusal(kind: ActKind, repo: string, pr?: number, name?: string): string {
  if (kind === 'create') return leaveDraftRefusal(name ?? 'gh pr create', repo)
  if (kind !== 'merge') return leaveDraftRefusal(name ?? 'gh pr ready', repo, pr)
  return 'github: ' + (name ?? 'gh pr merge') + ' refused on ' + repo + ': this repository is not in auto-merge, so a merge'
    + ' needs the operator\'s explicit word. When they gave it, run mcp__github__gh pr-merge {"pr": ' + (pr ?? '<n>') + '} on '
    + repo + ': it checks that the pull request is ready, then asks them in the conversation.'
}

export function ciUndraftLine(repo: string, pr: number): string {
  return 'github: ' + repo + '#' + pr + ' out of draft to run CI, still Not Ready'
}

// The lines the gate says when it reads a pull request: the label it put, or what is still missing.
// redrafted: outside auto-merge it put the pull request back to draft first, out of draft for its CI.
export function gateReadyLine(repo: string, pr: number, head: string, redrafted = false, carried: Carried[] = []): string {
  return 'github: ' + repo + '#' + pr + (redrafted ? ' back to draft, then' : '') + ' Ready at ' + head7(head)
    + ': a clean review, a passed norms check, passed E2E and green CI hold at its head'
    + (carried.length > 0 ? ' (' + carriedText(carried) + ').' : '.')
}

export function gateNotReadyLine(repo: string, pr: number, head: string, missing: string[], carried: Carried[] = []): string {
  return 'github: ' + repo + '#' + pr + ' back to Not Ready at ' + head7(head) + '. ' + tail(missing, carried)
}

export function gateMissingLine(repo: string, pr: number, head: string, missing: string[], carried: Carried[] = []): string {
  return 'github: ' + repo + '#' + pr + ' not Ready yet at ' + head7(head) + '. ' + tail(missing, carried)
}

// The gate read nothing it can trust (the pull request, its records): the label stays.
// The records of an earlier head are not counted: its commits, or the head's (from omitted), could not be fingerprinted.
export function uncarriedLine(repo: string, pr: number, head: string, error: string, from?: string): string {
  return 'github: ' + repo + '#' + pr + ': no record of ' + (from ? head7(from) : 'an earlier head') + ' carried to ' + head7(head)
    + ', its commits cannot be fingerprinted: ' + error
}

export function gateLeftLine(repo: string, pr: number, error: string): string {
  return 'github: the Ready label of ' + repo + '#' + pr + ' is left as it is: ' + error
}

export function gateMovedLine(repo: string, pr: number, read: string, now: string): string {
  return 'github: the Ready label of ' + repo + '#' + pr + ' is left as it is: the head moved from ' + head7(read)
    + ' to ' + head7(now) + ' while the gate read it, no label written.'
}

export function gateUnwrittenLine(repo: string, pr: number, error: string): string {
  return 'github: the Ready label of ' + repo + '#' + pr + ': label not written: ' + error
}

export function warnLine(act: string, repo: string, pr: number | string, missing: string[]): string {
  return 'github: ' + act + ' on ' + repo + '#' + pr + ' is not ready, let through while the guard only warns. ' + tail(missing)
}

export const RECORDS_REFUSAL = 'github: records are written by their producers\' tools, and E2E by mcp__github__record,'
  + ' never by hand.'

// A path into the records, or to their directory itself: a message or a body
// that only names the word is no path.
const RECORDS_PATH = /pr-records\/|\/pr-records(?![\w.-])/

// Whether a Bash command line names the records or their writer.
// The text, then each word as the shell reads it: quotes removed, so `rec""ord.py` is record.py.
export function touchesRecords(line: string, root?: string): boolean {
  const names = (text: string) => RECORDS_PATH.test(text) || text.includes('engine/record.py') || (!!root && text.includes(root))
  return names(line) || simpleCommands(line).some((argv) => argv.some(names))
}

// The record kind a caller of mcp__github__record may write, by the plugin whose hook made the
// call: the one the record contract names it the producer of, the open kind (E2E) for the model
// (the engine) and any other plugin.
export function recordKindFor(origin: string): string {
  return kindFor(origin)
}

// The refusal of a record of a kind its caller does not write, naming the producer the contract declares.
export function kindRefusal(kind: string, origin: string, owned: string): string {
  const producer = producerOf(kind)
  const by = producer ? ' (' + producer.plugin + ', ' + producer.tool + ')' : ''
  return 'github: ' + kind + ' records are written by their producer' + by + ': '
    + (origin === 'engine' ? 'this tool' : origin) + ' writes ' + owned + ' only.'
}

// A plugin's name as a producer slug.
export function producerSlug(origin: string): string {
  return origin === 'engine' ? 'session-e2e' : origin.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}

// The head directories older than the cut-off, by their newest file.
export const PRUNE_DAYS = 90
export const PRUNE_EVERY_MS = 24 * 3600 * 1000
