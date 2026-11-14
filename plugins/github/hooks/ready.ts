// The decisions of the ready guard and the auto-merge split: which call marks
// a pull request ready, leaves draft, merges it or opens it, which push moves
// a branch's head, and what a pull request still misses to be ready at its
// head. Pure functions only: register.ts reads GitHub, the records and the
// session, and answers the calls.

import { ACCEPTANCE, isAcceptance, KINDS, kindFor, parsePrRecord, producersOf, type Kind, type PrRecord } from '../core/pr-record.ts'
import { carriesAcross, heldBy, missingEvidence, type Holder } from '../core/readiness.ts'
import { gitSubcommand, innerLine, readCommands, redirectsToFile, simpleCommands } from '../core/shell.ts'
import type { Excused } from './check-plan.ts'
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
  const value = given[given.length - 1][1]
  return value === undefined || !/^(false|f|0)$/i.test(value)
}

function values(parsed: Parsed, ...flags: string[]): string[] {
  return parsed.opts.filter(([flag, value]) => flags.includes(flag) && value !== undefined).map(([, value]) => value as string)
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
  if (named.length < 2 || argv[named[0]] !== 'pr') return undefined
  const noun = argv[named[0]]
  const verb = argv[named[1]]
  const words = argv.filter((_w, i) => i > 0 && i !== named[0] && i !== named[1])
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
  if (merge) return { kind: 'merge', name: 'gh api', repo: merge[1] + '/' + merge[2], pr: Number(merge[3]) }
  // A substitution splits the path into words: the words are joined as the shell would.
  const joined = parsed.positionals.join('').replace(API_HOST, '')
  return MERGE_SHAPE.test(joined) ? { kind: 'merge', name: 'gh api', unreadable: true } : undefined
}

// The act of one run of the plugin's engine, engine/gh.py, from Bash. A draft
// opened or put back is the engine's to label, as it does for the tool.
function engineAct(call: EngineCall): Act | undefined {
  const repo = call.repo ? repoOf(call.repo) ?? call.repo : undefined
  const number = /^#?\d+$/.test(call.positionals[0] ?? '') ? Number(call.positionals[0].replace('#', '')) : undefined
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
  const pr = args.pr === undefined || args.pr === null ? undefined : Number(String(args.pr).replace('#', ''))
  const at = (kind: ActKind, extra: Partial<Act> = {}): Act => ({ kind, name: command, ...(pr !== undefined ? { pr } : {}), ...extra })
  if (command === 'pr-ready') return at('undraft')
  if (command === 'pr-draft') return at('redraft')
  if (command === 'pr-merge') return at('merge', typeof args.sha === 'string' ? { sha: args.sha } : {})
  if (command === 'pr-create') return { kind: args.draft === false ? 'create' : 'create-draft', name: command }
  return undefined
}

// ---- labels put on or taken off ----

// A label put on, taken off, renamed or deleted, as far as the command shows it: the names it
// moves, or opaque when it may move any (a body read from a file, every label of a pull request
// deleted, a GraphQL query). repo: owner/name as the command names it, when it does.
export type Labelling = { name: string; repo?: string; labels: string[]; opaque?: boolean }

const LABEL_VALUED = ['-n', '--name', '-c', '--color', '-d', '--description']
const ONE_LABEL_PATH = /^\/?repos\/([^/]+)\/([^/]+)\/issues\/\d+\/labels\/([^/?]+)\/?$/
const REPO_LABEL_PATH = /^\/?repos\/([^/]+)\/([^/]+)\/labels\/([^/?]+)\/?$/
const LABEL_MUTATION = /\b(addLabelsToLabelable|removeLabelsFromLabelable|clearLabelsFromLabelable|updateLabel|deleteLabel)\b/

const splitLabels = (list: string[]): string[] => list.flatMap((value) => value.split(',')).map((label) => label.trim()).filter((label) => label !== '')

function decoded(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

// What one gh command does to labels: gh pr|issue edit and create, gh label, gh api.
function ghLabelling(argv: string[]): Labelling | undefined {
  if (argv[1] === 'api') return apiLabelling(argv)
  let k = 1
  const named: number[] = []
  while (k < argv.length && named.length < 2) {
    const word = argv[k]
    if (word === '-R' || word === '--repo') { k += 2; continue }
    if (word.startsWith('-')) { k++; continue }
    named.push(k++)
  }
  if (named.length < 2) return undefined
  const noun = argv[named[0]]
  const verb = argv[named[1]]
  const words = argv.filter((_w, i) => i > 0 && i !== named[0] && i !== named[1])
  const name = 'gh ' + noun + ' ' + verb
  if (noun === 'label') {
    if (verb !== 'edit' && verb !== 'delete' && verb !== 'clone') return undefined
    const parsed = parseWords(words, LABEL_VALUED)
    const repo = parsed.repo ? { repo: repoOf(parsed.repo) ?? parsed.repo } : {}
    // A clone copies the labels of another repository, any of them.
    if (verb === 'clone') return { name, ...repo, labels: [], opaque: true }
    return { name, ...repo, labels: [...parsed.positionals.slice(0, 1), ...values(parsed, '-n', '--name')] }
  }
  if (noun !== 'pr' && noun !== 'issue') return undefined
  const parsed = parseWords(words, VALUED[verb] ?? [])
  const labels = verb === 'edit' ? splitLabels(values(parsed, '--add-label', '--remove-label'))
    : verb === 'create' ? splitLabels(values(parsed, '-l', '--label')) : []
  if (labels.length === 0) return undefined
  return { name, ...(parsed.repo ? { repo: repoOf(parsed.repo) ?? parsed.repo } : {}), labels }
}

// What one gh api command does to labels: a write on a pull request's labels, on the pull request
// itself naming labels, on a label of the repository, or a GraphQL label mutation.
function apiLabelling(argv: string[]): Labelling | undefined {
  const parsed = parseWords(argv.slice(2), API_VALUED)
  const endpoint = parsed.positionals[0]
  if (endpoint === undefined) return undefined
  const fields = apiFields(parsed)
  const input = has(parsed, '--input')
  const explicit = values(parsed, '-X', '--method')[0]
  const method = (explicit ?? (fields.length > 0 || input ? 'POST' : 'GET')).toUpperCase()
  if (GRAPHQL.test(endpoint)) {
    const query = inlineQuery(parsed, fields)
    return query === undefined || LABEL_MUTATION.test(query) ? { name: 'gh api graphql', labels: [], opaque: true } : undefined
  }
  if (method === 'GET' || method === 'HEAD') return undefined
  const path = endpoint.replace(API_HOST, '')
  const at = (match: RegExpExecArray, labels: string[], opaque = false): Labelling =>
    ({ name: 'gh api', repo: match[1] + '/' + match[2], labels, ...(opaque ? { opaque } : {}) })
  const naming = (prefix: string) => fields.filter((field) => field.name.startsWith(prefix))
  const named = (prefix: string) => naming(prefix).flatMap((field) => labelsIn(field.value))
  // A -F value `@file` is read from the file: its labels are not on the line.
  const unread = (...prefixes: string[]) => input || prefixes.some((prefix) => naming(prefix).some((field) => field.typed && field.value.startsWith('@')))
  const one = ONE_LABEL_PATH.exec(path) ?? REPO_LABEL_PATH.exec(path)
  if (one) return at(one, [decoded(one[3]), ...named('new_name'), ...named('name')], unread('new_name', 'name'))
  const all = LABELS_PATH.exec(path)
  if (all) return at(all, named('labels'), unread('labels') || method === 'DELETE')
  const issue = ISSUE_PATH.exec(path)
  if (issue && method === 'PATCH' && (input || named('labels').length > 0)) return at(issue, named('labels'), unread('labels'))
  return undefined
}

// The engine's own label commands run from Bash.
function engineLabelling(call: EngineCall): Labelling | undefined {
  if (call.command !== 'label-add' && call.command !== 'label-remove') return undefined
  const rest = /^#?\d+$/.test(call.positionals[0] ?? '') ? call.positionals.slice(1) : call.positionals
  return { name: 'gh.py ' + call.command, ...(call.repo ? { repo: repoOf(call.repo) ?? call.repo } : {}), labels: splitLabels(rest) }
}

// Every labelling of a Bash command line, read word by word as bashActs reads its acts.
export function bashLabellings(line: string): Labelling[] {
  const found: Labelling[] = []
  for (const argv of simpleCommands(line)) {
    const engine = engineCall(argv)
    const labelling = engine ? engineLabelling(engine) : GH.test(argv[0] ?? '') ? ghLabelling(argv) : undefined
    if (labelling) found.push(labelling)
  }
  return found
}

// The labelling of a call of the tool: label-add and label-remove.
export function toolLabelling(command: string, args: Record<string, unknown>): Labelling | undefined {
  if (command !== 'label-add' && command !== 'label-remove') return undefined
  const named = [args.label, args.names, args.name].flatMap((v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]))
  return { name: command, labels: splitLabels(named.map(String)) }
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

// Per kind, the record with the latest `at`: it decides.
function latestByKind(read: Map<string, PrRecord>): Map<Kind, PrRecord> {
  const latest = new Map<Kind, PrRecord>()
  for (const record of read.values()) {
    const before = latest.get(record.kind)
    if (!before || record.at >= before.at) latest.set(record.kind, record)
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

// The operator's answer to the waiver question of a kind, granted at `at` (ISO) and recorded by `by`, standing
// for that kind at every head that has no record of it, unless a run failed after it at an earlier head, or a
// record file there that may be that failure does not parse.
export function consentWaiver(gate: Gate, found: ReadonlyMap<string, RecordFile[]>, at: string, by: string, kind: Kind): Carried | undefined {
  for (const [head, files] of found) {
    if (unreadableRecords(files).some((file) => file.kinds.includes(kind))) return undefined
    const failed = [...headRecordsRead(gate, files, head.toLowerCase()).read.values()].some((r) => r.kind === kind && r.result === 'fail' && r.at > at)
    if (failed) return undefined
  }
  return { kind, from: '', waived: by + ', ' + at }
}

// What a pull request misses to be ready at its head, as core's readiness contract defines it
// (readiness.ts), and before that an act that cannot be ready at all (closed, moved head).
// excused: the kinds its check plan or the operator's exemption excuses, each standing for its record unless a run failed.
// carried: the kinds with no record at the head that an earlier head of the same diff holds.
// holder: only the conditions that holder refuses a merge on; every condition, omitted.
export function missingItems(gate: Gate, files: RecordFile[], sha?: string, excused: Excused = {}, carried: Carried[] = [],
  holder?: Holder): string[] {
  const missing: string[] = []
  if (gate.state !== 'open') missing.push('the pull request is ' + gate.state)
  if (sha && sha.toLowerCase() !== gate.head) missing.push('the head moved: ' + sha + ' given, ' + gate.head + ' on GitHub')
  const { read, skipped } = headRecordsRead(gate, files)
  const ci = gate.ci
  const lacking = missingEvidence({
    latest: latestByKind(read),
    excused: new Set(KINDS.filter((kind) => excused[kind])),
    required: new Set(excused.required ?? []),
    carried: new Set(carried.map((c) => c.kind)),
    ciGreen: ci.result === 'SUCCESS',
  })
  const kinds = (holder ? heldBy(lacking, holder) : lacking).flatMap((item) => item.condition === 'ci' ? [] : [item])
  for (const { condition, record } of kinds) {
    if (!record) missing.push(condition + ': no record at ' + head7(gate.head))
    else missing.push(condition + ': ' + record.result + ' at ' + head7(gate.head) + ' by ' + record.producer + (record.detail ? ', ' + record.detail : ''))
  }
  // A file skipped is named only beside a kind it may have been meant for: with
  // the kinds accepted it blocks nothing, as nobody may delete it.
  if (kinds.length > 0) for (const name of skipped) missing.push('unreadable record ' + name)
  if (holder && holder !== 'github') return missing
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

// The label the gate puts on an open pull request, or undefined to leave it: Ready when nothing is
// missing and it does not carry Ready alone, Not Ready when it carries Ready and something is.
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
  return carried.map((c) => (c.waived ? c.kind + ' waived by the operator (' + c.waived + ')' : c.kind + ' carried from ' + head7(c.from))).join(', ')
}

const tail = (missing: string[], carried: Carried[] = []) =>
  'Missing: ' + missing.join(', ') + (carried.length > 0 ? '; ' + carriedText(carried) : '')

// Why leaving draft is refused outside auto-merge, whatever the route.
const LEAVE_DRAFT = 'outside auto-merge, leaving draft is the operator\'s, on GitHub after their review, and Ready is put'
  + ' by the gate once the pull request is ready'

export function notReadyRefusal(act: string, repo: string, pr: number, head: string, missing: string[], carried: Carried[] = []): string {
  return 'github: ' + act + ' refused on ' + repo + '#' + pr + ' at ' + head7(head) + ': not ready. ' + tail(missing, carried)
    + '. What Ready needs is core\'s readiness contract (core/readiness.ts).'
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
// accepted: the points the orchestrator's acceptance set aside at the head, named in place of a clean review.
// excused: the kinds the check plan or the exemption stood for, named.
// carried: the kinds counted at the head from an earlier head of the same diff.
export function gateReadyLine(repo: string, pr: number, head: string, redrafted = false, accepted?: string, excused: Excused = {},
  carried: Carried[] = []): string {
  return 'github: ' + repo + '#' + pr + (redrafted ? ' back to draft, then' : '') + ' Ready at ' + head7(head)
    + ': ' + (accepted ? reviewAcceptedLine(accepted) : 'a clean review') + ', '
    + (excused.norms ? 'no norms check needed (' + excused.norms + '), ' : '')
    + (excused.e2e ? 'no E2E needed (' + excused.e2e + ')' : 'passed E2E') + ' and green CI hold at its head'
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
  const names = (text: string) => RECORDS_PATH.test(text) || text.includes('engine/record.py') || (!!root && text.includes(root))
  return names(line) || simpleCommands(line).some((argv) => argv.some(names))
}

// The programs that write nothing a line gives them, but through a redirection or one of the
// options onlyReads refuses. A program outside this list is no read, whatever it is given: a
// guard that must refuse a write cannot know every writer, so it knows the readers.
const READERS: ReadonlySet<string> = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'find', 'stat', 'wc', 'jq', 'diff', 'cmp', 'du',
  'echo', 'printf', 'test', '[', '[[', 'true', 'cd', 'pwd', 'basename', 'dirname', 'realpath', 'readlink',
])
// find's options that delete, run a program or write a file.
const FIND_WRITES = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/

// Whether a command line only reads: every simple command it holds, a substitution's and a pipeline's
// included, is a program of READERS (find without a writing option), and no `>`, `>>` or `>|` sends
// output into a file. A line the reader cannot read is no read.
export function onlyReads(line: string): boolean {
  try {
    if (redirectsToFile(line)) return false
    return readCommands(line).every(({ argv }) => {
      const program = (argv[0] ?? '').replace(/^.*\//, '')
      if (argv.length === 0) return true
      if (!READERS.has(program)) return false
      return program !== 'find' || !argv.some((word) => FIND_WRITES.test(word))
    })
  } catch {
    return false
  }
}

// Whether a Bash command line writes into the records or runs their writer: it names them
// (touchesRecords) and is not a line that only reads.
export function writesRecords(line: string, root?: string): boolean {
  return touchesRecords(line, root) && !onlyReads(line)
}

// The record kind a caller of mcp__github__record may write, by the plugin whose hook made the
// call: the one the record contract names it the producer of, the open kind (E2E) for the model
// (the engine) and any other plugin.
export function recordKindFor(origin: string): string {
  return kindFor(origin)
}

// The refusal of a record of a kind its caller does not write, naming the producer the contract declares.
export function kindRefusal(kind: string, origin: string, owned: string): string {
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
