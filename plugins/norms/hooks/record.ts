// hooks/record.ts
// The norms record: /norms:check ends by calling mcp__norms__check_done, which
// leaves one record at the pull request's head through the github plugin's
// record tool (mcp__github__record), for its ready guard to read.
// The call is refused unless /norms:check computed its scope in this session,
// typed or run through the Skill tool (hooks/check.ts sets the mark), so the record follows its own scope. A
// failure never throws out of the handler: the answer is one `record:` line,
// the path written or `none` with the reason.
// The same call leaves the check's findings in the module's journal (hooks/observe.ts), one event
// per finding an agent reported, once the pull request they belong to is read.
import type { NormsScopeMark } from '../types/index.d.ts'
import { endSkillCheck, spawned } from './guards.ts'
import { answerOf, fieldsOf, messageOf, type Host, type Input, type On } from '../core/host.ts'
import { findingEvent } from '../core/learning.ts'
import { reportPathOf, verdictLine } from '../core/verdict.ts'
import { agentText, noteReport, reportOf, reported, resetReports, type Found } from './findings.ts'
import { journal, noteSubject, resetSubject } from './observe.ts'

export type RecordHost = Host<'env' | 'fs' | 'process' | 'session' | 'state' | 'ui' | 'tool' | 'clock'>

export const CHECK_DONE_TOOL = 'mcp__norms__check_done'
const GH_TOOL = 'mcp__github__gh'
const RECORD_TOOL = 'mcp__github__record'
const GIT_TIMEOUT_MS = 30_000

export const CHECK_DONE_DESCRIPTION =
  '/norms:check\'s last act: record its outcome at the pull request\'s head commit, for the github '
  + 'plugin\'s ready guard. open = findings neither fixed nor passed, fixed = findings fixed, passed = '
  + 'findings passed; setAside = findings set aside, with their reason (they no longer count as open); auto = true in automatic mode. Answers one line, `record: <path>` or `record: none — <why>`: print it in the report. '
  + 'Refused unless /norms:check computed its scope in this session and its agents reported their findings, which the figures must account for once each.'

export const CHECK_DONE_SCHEMA = {
  type: 'object',
  properties: {
    open: { type: 'integer', minimum: 0, description: 'findings left neither fixed nor passed' },
    fixed: { type: 'integer', minimum: 0, description: 'findings fixed' },
    passed: { type: 'integer', minimum: 0, description: 'findings passed' },
    setAside: { type: 'integer', minimum: 0, description: 'findings set aside as not critical; reason is then required' },
    reason: { type: 'string', description: 'why the findings were set aside, kept in the record' },
    auto: { type: 'boolean', description: 'automatic mode: the passed findings were passed automatically as non-blocking (default false)' },
  },
  required: ['open', 'fixed', 'passed'],
}

// The scope /norms:check computed in this session: its head, the time, and the files the check
// read. A commit made after the check (the fix commits of check.md 7.4) may only touch those
// files, or the record would vouch for code the check never read.
// Kept in the host's $.state, which outlives the module's own variables, so a restart of the
// hooks worker does not lose it; cleared at session.end, since the state's scope is not known
// to be the session's. The module variable holds the mark only when $.state refused it, so the
// check still records in that session. The state key is written out at each call: the host's
// loader refuses one held in a const it cannot list (types/index.d.ts declares it).
type Mark = NormsScopeMark
let fallback: Mark | undefined

// The pull request the last lookup found, with its repository: the scope's mark reads it, so the
// events of the check name their pull request from its first line on, at no call of its own.
let lastPull: { repo: string; pr: number } | undefined
// Whether the running check's findings are in the journal: once per check.
let isJournaled = false

// The mark read back from the state, or undefined for anything that is not one.
export function asMark(value: unknown): Mark | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v['head'] !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v['head'])) return undefined
  if (typeof v['at'] !== 'number' || !Array.isArray(v['files']) || !v['files'].every(f => typeof f === 'string')) return undefined
  if (v['dir'] !== undefined && (typeof v['dir'] !== 'string' || !v['dir'].startsWith('/'))) return undefined
  return { head: v['head'], at: v['at'], files: v['files'] as string[], ...(typeof v['dir'] === 'string' ? { dir: v['dir'] } : {}) }
}

// One line in the session's log. A log that throws or rejects draws nothing: what the line
// reports has been dealt with all the same.
function warn($: Host<'ui'>, line: string): void {
  try {
    Promise.resolve($.ui.log(line)).catch(() => undefined)
  } catch {
    // No line drawn.
  }
}

// `dir`: the repository the check read, so that a later shell `cd` into another repository is not
// taken for the reviewed one.
export async function markScope($: RecordHost, head: string, files: readonly string[] = [], dir?: string): Promise<void> {
  const mark: Mark = { head, at: Date.now(), files: [...files], ...(dir ? { dir } : {}) }
  // A new check starts from no findings: the agents it runs report them again.
  resetReports()
  isJournaled = false
  // What the check's events are about: its head, its repository, and its pull request when the
  // scope's own lookup found it in that repository.
  const repo = await repositoryOf($, dir).catch(() => undefined)
  resetSubject()
  noteSubject({ repo, head, pr: lastPull !== undefined && lastPull.repo === repo ? lastPull.pr : null })
  lastPull = undefined
  try {
    await $.state.set({ plugin: 'norms', key: 'scopeMark' }, mark)
    fallback = undefined
  } catch (err) {
    fallback = mark
    warn($, `norms: the scope mark could not be kept in the session state, it is kept in memory: ${messageOf(err).trim()}`)
  }
}

// Called from the module's one session.end hook, in guards.ts: the host refuses a second
// session.end hook without a matcher.
export async function clearMark($: Host<'state'>): Promise<void> {
  fallback = undefined
  lastPull = undefined
  isJournaled = false
  resetReports()
  resetSubject()
  try {
    await $.state.set({ plugin: 'norms', key: 'scopeMark' }, null)
  } catch {
    // Refused: nothing is left to do at the end of a session.
  }
}

// The state first, then the memory copy; neither leaves no mark, and check_done refuses.
async function readMark($: Host<'state'>): Promise<Mark | undefined> {
  try {
    const stored = asMark((await $.state.get({ plugin: 'norms', key: 'scopeMark' }))?.value)
    if (stored) return stored
  } catch {
    // Unreadable: the memory copy, if any, is the mark.
  }
  return fallback
}

// The repository the last /norms:check of this session read, or undefined when no mark names one.
export async function markedDir($: Host<'state'>): Promise<string | undefined> {
  return (await readMark($))?.dir
}

// owner/name from a remote url: scp-like, https or ssh://. Undefined for a
// path or a url that names no owner and repository.
export function repoOf(url: string): string | undefined {
  const m = url.trim().match(/^(?:[\w.-]+@[\w.-]+:|(?:https?|ssh|git):\/\/(?:[^/@]+@)?[\w.-]+(?::\d+)?\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : undefined
}

// The repository the check reads, as its top directory: the session's directory's when it is in one,
// else the repository of the session's project root (a shell `cd` into a scratchpad or /tmp moves
// the session's directory out of the checkout, never its project root). Undefined when neither is a
// repository, or when the host cannot answer: git then runs in the session's directory and says why.
export async function repositoryDir($: Host<'process' | 'session'>): Promise<string | undefined> {
  try {
    const here = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS })
    const top = String(here.stdout).trim()
    if (here.exitCode === 0 && top !== '') return top
    const root = String(await $.session.root())
    const there = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })
    const rootTop = String(there.stdout).trim()
    return there.exitCode === 0 && rootTop !== '' ? rootTop : undefined
  } catch {
    return undefined
  }
}

export type Pull = { number?: unknown; head?: { sha?: unknown }; base?: { ref?: unknown } }

// A pull request asked of the github plugin, in the repository named: the pull request, none
// (`pull` undefined), or why it could not be read. Never against the session's own directory.
export type Lookup = { pull?: Pull | undefined } | { why: string }

const NO_GITHUB = 'the github plugin is absent or older than 0.12.0'

async function pullList($: Host<'tool'>, repo: string, command: string, args: Record<string, unknown>): Promise<Pull[] | { why: string }> {
  let answer: unknown
  try {
    answer = await $.tool.call({ tool: GH_TOOL, command, args, repo })
  } catch {
    return { why: NO_GITHUB }
  }
  const read = textOf(answer)
  if ('why' in read) return read
  try {
    const pulls: unknown = JSON.parse(read.text)
    if (Array.isArray(pulls)) return pulls.map(pull => (fieldsOf(pull) ?? {}) as Pull)
  } catch {
    // Not JSON: said below.
  }
  return { why: `the github plugin's ${command} answer is not a list of pull requests` }
}

// The open pull request of `branch` in `repo`.
export async function branchPull($: Host<'tool'>, repo: string, branch: string): Promise<Lookup> {
  const pulls = await pullList($, repo, 'pr-get', { branch, format: 'raw' })
  return Array.isArray(pulls) ? found(repo, pulls[0]) : pulls
}

// The pull request a lookup answers, remembered with its repository when it has a number.
function found(repo: string, pull: Pull | undefined): Lookup {
  const pr = numberOf(pull)
  if (pr !== undefined) lastPull = { repo, pr }
  return { pull }
}

const numberOf = (pull: Pull | undefined): number | undefined => {
  const pr = Number(pull?.number)
  return Number.isInteger(pr) && pr >= 1 ? pr : undefined
}

// The open pull request of `repo` whose head is `head`: a detached head names no branch to ask
// about, its commit does. Several such pull requests are refused, naming them: none is the one.
export async function openPullAt($: Host<'tool'>, repo: string, head: string): Promise<Lookup> {
  const pulls = await pullList($, repo, 'pr-list', { format: 'raw' })
  if (!Array.isArray(pulls)) return pulls
  const at = pulls.filter(p => fieldsOf(p.head)?.['sha'] === head)
  if (at.length > 1) {
    return { why: `${at.length} open pull requests have the head ${head.slice(0, 12)}: ${at.map(p => `${repo}#${String(p.number)}`).join(', ')}` }
  }
  return found(repo, at[0])
}

// The repository of the checkout in `dir`, owner/name, or undefined for an origin that names none.
export async function repositoryOf($: Host<'process'>, dir?: string): Promise<string | undefined> {
  return repoOf(await git($, ['git', 'remote', 'get-url', 'origin'], dir))
}

async function git($: Host<'process'>, argv: string[], dir?: string): Promise<string> {
  const r = await $.process.run(argv, { timeoutMs: GIT_TIMEOUT_MS, ...(dir ? { cwd: dir } : {}) })
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${String(r.stderr).trim() || 'exit ' + r.exitCode}`)
  return String(r.stdout)
}

const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined)

const NONE = 'record: none — '
const none = (why: string) => NONE + why

// Whether an answer of checkDone is a record written, not a refusal or a `none`.
const wroteRecord = (answer: { result: string; isError?: boolean }) => !answer.isError && !answer.result.startsWith(NONE)

// The answer of a tool called through $.tool.call, as text, or the reason it
// gave none.
function textOf(raw: unknown): { text: string } | { why: string } {
  const answer = answerOf(raw)
  if (answer.deny !== undefined) return { why: answer.deny }
  if (answer.isError) return { why: answer.text || 'the tool failed' }
  return { text: answer.text }
}

// The agent a report came from, as a part of an event's code: `norms:norms-variable-naming` is `variable-naming`.
const agentCode = (type: string): string => {
  const name = type.replace(/^norms:(?:norms-)?/, '')
  return /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : 'agent'
}

// The check's findings into the journal, once per check: one event per finding, its code the agent
// and the severity it reported, its path the file. Nothing of the summary enters.
async function journalFindings($: RecordHost, findings: readonly Found[], dir: string | undefined): Promise<void> {
  if (isJournaled) return
  isJournaled = true
  if (findings.length === 0) return
  await journal($, known => findings.map(f => findingEvent({
    ...known(), code: `norms.${agentCode(f.agent)}.${f.severity}`, severity: f.severity, file: f.file, ...(dir ? { root: dir } : {}),
  })))
}

export async function checkDone($: RecordHost, input: Input): Promise<{ result: string; isError?: boolean }> {
  const checked = await readMark($)
  if (!checked) return { result: 'norms: run /norms:check first: the record follows its own scope', isError: true }
  const given = { open: count(input['open']), fixed: count(input['fixed']), passed: count(input['passed']), setAside: input['setAside'] === undefined ? 0 : count(input['setAside']) }
  if (given.open === undefined || given.fixed === undefined || given.passed === undefined || given.setAside === undefined) {
    return { result: 'norms: open, fixed, passed and setAside are whole numbers, 0 or more', isError: true }
  }
  const isAuto = input['auto'] === true
  // A point set aside keeps its reason in the record, in one line.
  const reason = typeof input['reason'] === 'string' ? input['reason'].replace(/\s+/g, ' ').trim() : ''
  if (given.setAside > 0 && reason === '') return { result: 'norms: findings set aside need their reason', isError: true }
  // The pass is computed from what the agents reported.
  const known = reported()
  if ('why' in known) return { result: `norms: ${known.why}`, isError: true }
  const total = known.findings.length
  const blocking = known.findings.filter(f => f.severity === 'error').length
  let { open, fixed, passed } = given
  const setAside = isAuto ? Math.min(given.setAside, blocking) : given.setAside
  if (isAuto) {
    // An automatic check edits nothing and has nobody to pass an ERROR, so its figures are the
    // findings' own: nothing fixed, every WARNING and INFO passed, every ERROR open but the ones
    // set aside. The figures given are not read.
    fixed = 0
    passed = total - blocking
    open = blocking - setAside
  } else if (open + fixed + passed + setAside !== total) {
    // An interactive check's findings are passed and fixed by the person: the figures say which,
    // and account for every finding once. Figures that leave one out, or invent one, are not the check's.
    return { result: `norms: the agents reported ${total} finding(s) and open + fixed + passed + setAside add up to ${open + fixed + passed + setAside}: every finding is open, fixed, passed or set aside, once`, isError: true }
  }
  // What the check's events are about, as far as this call reads it.
  let dir = checked.dir
  let unfixed = 0
  try {
    // The repository the check read, not the one a later shell `cd` landed in.
    dir = checked.dir ?? await repositoryDir($)
    // First, so the reason is clear: a record is written on a clean checkout.
    if ((await git($, ['git', 'status', '--porcelain', '-uno'], dir)).trim() !== '') {
      return { result: none('the tracked files have changes') }
    }
    // At the call, not at the scope: the fix commits of check.md 7.4 are in it.
    const head = (await git($, ['git', 'rev-parse', 'HEAD'], dir)).trim()
    if (!head) return { result: none('the checkout has no commit') }
    if (head !== checked.head) {
      const changed = (await git($, ['git', 'diff', '--name-only', checked.head, head], dir)).split('\n').map(f => f.trim()).filter(Boolean)
      const read = new Set(checked.files)
      const unread = changed.filter(f => !read.has(f))
      if (unread.length > 0) {
        const named = unread.slice(0, 5).join(', ') + (unread.length > 5 ? ', …' : '')
        return { result: none(`commits since the check touch files it did not read (${named}): run /norms:check again`) }
      }
    } else if (fixed > 0) {
      // A fix is a commit (check.md 7.4), and the checkout is clean at the head the check read:
      // nothing was fixed, and the findings said fixed are open.
      unfixed = fixed
      open += fixed
      fixed = 0
    }
    const repo = await repositoryOf($, dir)
    if (!repo) return { result: none('the origin remote names no GitHub repository') }
    // A branch asks for its own pull request; a detached head (a review checkout) names none, its
    // commit may.
    const branch = (await git($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim()
    const pull = branch === 'HEAD' ? await openPullAt($, repo, head) : await branchPull($, repo, branch)
    if ('why' in pull) return { result: none(pull.why) }
    const pr = numberOf(pull.pull)
    if (pr === undefined) return { result: none('the branch has no pull request') }
    // The findings are the ones of the head the check read.
    noteSubject({ repo, pr, head: checked.head })
    await journalFindings($, known.findings, dir)
    let recorded: { text: string } | { why: string }
    try {
      recorded = textOf(await $.tool.call({
        tool: RECORD_TOOL, pr, repo, kind: 'norms',
        result: open === 0 ? 'pass' : 'fail',
        detail: `${fixed} fixed, ${passed} passed${isAuto ? ' (non-blocking, automatic)' : ''}${setAside > 0 ? `, ${setAside} set aside (${reason})` : ''}, ${open} open${unfixed > 0 ? ` (${unfixed} said fixed with no commit since the check)` : ''}`,
        ...(dir ? { dir } : {}),
      }))
    } catch {
      return { result: none(NO_GITHUB) }
    }
    if ('why' in recorded) return { result: none(recorded.why) }
    // In a session the orchestrator spawned, the answer ends on the verdict line its agent sends up.
    if (!(await spawned($))) return { result: `record: ${recorded.text}` }
    const line = verdictLine({
      repo, pr, head,
      verdict: `norms ${open === 0 ? 'pass' : 'fail'}: ${fixed} fixed, ${passed} passed, ${open} open`,
      blocking: open === 0 ? [] : [`${open} open finding(s), in the check's report`],
      report: reportPathOf(`report: ${recorded.text}`),
    })
    return { result: `record: ${recorded.text}\n${line}` }
  } catch (err) {
    return { result: none(messageOf(err).trim()) }
  }
}

export function register(on: On<RecordHost>): void {
  on('session.start', async ($, e, next) => {
    // In the tool list from the start (isDeferred false): check.md calls it
    // at its last step, and behind tool search the model would skip it.
    try {
      await $.tool.register({
        name: 'check_done', description: CHECK_DONE_DESCRIPTION, inputSchema: CHECK_DONE_SCHEMA, isDeferred: false,
      })
    } catch (err) {
      // Not listed: the report goes without a record line, and the session says why.
      warn($, `norms: mcp__norms__check_done could not be registered, the report goes without a record line: ${messageOf(err).trim()}`)
    }
    return next(e)
  }).catch(async (_$, e, next) => next(e))

  // The findings of each norms agent, read from its answer. The hook never changes the call's input.
  // An agent that fails, is launched in the background or answers without a readable block leaves
  // its findings unknown; its answer reaches the session as it came, and it runs once.
  on('tool.call', { tool: 'Agent' }, async (_$, e, next) => {
    const type = String(e['subagent_type'] ?? '')
    if (!type.startsWith('norms:')) return next(e)
    let answer: unknown
    try {
      answer = await next(e)
    } catch (err) {
      noteReport(type, null)
      return { result: messageOf(err), isError: true }
    }
    try {
      const read = answerOf(answer)
      noteReport(type, read.isError || read.deny !== undefined ? null : reportOf(agentText(answer)))
    } catch {
      noteReport(type, null)
    }
    return answer
  }).catch(async (_$, e, next) => next(e))

  on('tool.call', { tool: CHECK_DONE_TOOL }, async ($, e) => {
    const answer = await checkDone($, e)
    // The main loop's call only (a subagent's is not the walkthrough's), and only once the
    // record is written: a refused call leaves the guards armed.
    if (!e['agentId'] && wroteRecord(answer)) endSkillCheck()
    return answer
  })
    .catch(async () => ({ result: none('the norms module failed'), isError: false }))
}
