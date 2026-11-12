// hooks/record.ts
// The norms record: /norms:check ends by calling mcp__norms__check_done, which
// leaves one record at the pull request's head through the github plugin's
// record tool (mcp__github__record), for its ready guard to read.
// The call is refused unless /norms:check computed its scope in this session,
// typed or run through the Skill tool (hooks/check.ts sets the mark), so the record follows its own scope. A
// failure never throws out of the handler: the answer is one `record:` line,
// the path written or `none` with the reason.
import type { NormsScopeMark } from '../types/index.d.ts'
import { endSkillCheck } from './guards.ts'

export const CHECK_DONE_TOOL = 'mcp__norms__check_done'
const GH_TOOL = 'mcp__github__gh'
const RECORD_TOOL = 'mcp__github__record'
const GIT_TIMEOUT_MS = 30_000

export const CHECK_DONE_DESCRIPTION =
  '/norms:check\'s last act: record its outcome at the pull request\'s head commit, for the github '
  + 'plugin\'s ready guard. open = findings neither fixed nor passed, fixed = findings fixed, passed = '
  + 'findings passed; auto = true in automatic mode. Answers one line, `record: <path>` or `record: none — <why>`: print it in the report. '
  + 'Refused unless /norms:check computed its scope in this session.'

export const CHECK_DONE_SCHEMA = {
  type: 'object',
  properties: {
    open: { type: 'integer', minimum: 0, description: 'findings left neither fixed nor passed' },
    fixed: { type: 'integer', minimum: 0, description: 'findings fixed' },
    passed: { type: 'integer', minimum: 0, description: 'findings passed' },
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

// The mark read back from the state, or undefined for anything that is not one.
export function asMark(value: unknown): Mark | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.head !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v.head)) return undefined
  if (typeof v.at !== 'number' || !Array.isArray(v.files) || !v.files.every(f => typeof f === 'string')) return undefined
  if (v.dir !== undefined && (typeof v.dir !== 'string' || !v.dir.startsWith('/'))) return undefined
  return { head: v.head, at: v.at, files: v.files as string[], ...(typeof v.dir === 'string' ? { dir: v.dir } : {}) }
}

// One line in the session's log. A log that throws or rejects draws nothing: what the line
// reports has been dealt with all the same.
function warn($: any, line: string): void {
  try {
    const sent = $.ui.log(line)
    if (sent && typeof sent.catch === 'function') sent.catch(() => undefined)
  } catch {
    // No line drawn.
  }
}

// `dir`: the repository the check read, so that a later shell `cd` into another repository is not
// taken for the reviewed one.
export async function markScope($: any, head: string, files: readonly string[] = [], dir?: string): Promise<void> {
  const mark: Mark = { head, at: Date.now(), files: [...files], ...(dir ? { dir } : {}) }
  try {
    await $.state.set({ plugin: 'norms', key: 'scopeMark' }, mark)
    fallback = undefined
  } catch (err: any) {
    fallback = mark
    warn($, `norms: the scope mark could not be kept in the session state, it is kept in memory: ${String(err?.message ?? err).trim()}`)
  }
}

// Called from the module's one session.end hook, in guards.ts: the host refuses a second
// session.end hook without a matcher.
export async function clearMark($: any): Promise<void> {
  fallback = undefined
  try {
    await $.state.set({ plugin: 'norms', key: 'scopeMark' }, null)
  } catch {
    // Refused: nothing is left to do at the end of a session.
  }
}

// The state first, then the memory copy; neither leaves no mark, and check_done refuses.
async function readMark($: any): Promise<Mark | undefined> {
  try {
    const stored = asMark((await $.state.get({ plugin: 'norms', key: 'scopeMark' }))?.value)
    if (stored) return stored
  } catch {
    // Unreadable: the memory copy, if any, is the mark.
  }
  return fallback
}

// The repository the last /norms:check of this session read, or undefined when no mark names one.
export async function markedDir($: any): Promise<string | undefined> {
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
export async function repositoryDir($: any): Promise<string | undefined> {
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
export type Lookup = { pull?: Pull } | { why: string }

const NO_GITHUB = 'the github plugin is absent or older than 0.12.0'

async function pullList($: any, repo: string, command: string, args: Record<string, unknown>): Promise<Pull[] | { why: string }> {
  let answer: any
  try {
    answer = await $.tool.call({ tool: GH_TOOL, command, args, repo })
  } catch {
    return { why: NO_GITHUB }
  }
  const read = textOf(answer)
  if ('why' in read) return read
  try {
    const pulls = JSON.parse(read.text)
    if (Array.isArray(pulls)) return pulls
  } catch {
    // Not JSON: said below.
  }
  return { why: `the github plugin's ${command} answer is not a list of pull requests` }
}

// The open pull request of `branch` in `repo`.
export async function branchPull($: any, repo: string, branch: string): Promise<Lookup> {
  const pulls = await pullList($, repo, 'pr-get', { branch })
  return Array.isArray(pulls) ? { pull: pulls[0] } : pulls
}

// The open pull request of `repo` whose head is `head`: a detached head names no branch to ask
// about, its commit does. Several such pull requests are refused, naming them: none is the one.
export async function openPullAt($: any, repo: string, head: string): Promise<Lookup> {
  const pulls = await pullList($, repo, 'pr-list', {})
  if (!Array.isArray(pulls)) return pulls
  const found = pulls.filter(p => p?.head?.sha === head)
  if (found.length > 1) {
    return { why: `${found.length} open pull requests have the head ${head.slice(0, 12)}: ${found.map(p => `${repo}#${String(p?.number)}`).join(', ')}` }
  }
  return { pull: found[0] }
}

// The repository of the checkout in `dir`, owner/name, or undefined for an origin that names none.
export async function repositoryOf($: any, dir?: string): Promise<string | undefined> {
  return repoOf(await git($, ['git', 'remote', 'get-url', 'origin'], dir))
}

async function git($: any, argv: string[], dir?: string): Promise<string> {
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
function textOf(answer: any): { text: string } | { why: string } {
  if (answer?.deny) return { why: String(answer.deny).trim() }
  const text = String(answer?.result ?? answer?.text ?? '').trim()
  if (answer?.isError) return { why: text || 'the tool failed' }
  return { text }
}

export async function checkDone($: any, input: any): Promise<{ result: string; isError?: boolean }> {
  const checked = await readMark($)
  if (!checked) return { result: 'norms: run /norms:check first: the record follows its own scope', isError: true }
  const open = count(input?.open)
  const fixed = count(input?.fixed)
  const passed = count(input?.passed)
  if (open === undefined || fixed === undefined || passed === undefined) {
    return { result: 'norms: open, fixed and passed are whole numbers, 0 or more', isError: true }
  }
  try {
    // The repository the check read, not the one a later shell `cd` landed in.
    const dir = checked.dir ?? await repositoryDir($)
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
    }
    const repo = await repositoryOf($, dir)
    if (!repo) return { result: none('the origin remote names no GitHub repository') }
    // A branch asks for its own pull request; a detached head (a review checkout) names none, its
    // commit may.
    const branch = (await git($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim()
    const found = branch === 'HEAD' ? await openPullAt($, repo, head) : await branchPull($, repo, branch)
    if ('why' in found) return { result: none(found.why) }
    const pr = Number(found.pull?.number)
    if (!Number.isInteger(pr) || pr < 1) return { result: none('the branch has no pull request') }
    let recorded: { text: string } | { why: string }
    try {
      recorded = textOf(await $.tool.call({
        tool: RECORD_TOOL, pr, repo, kind: 'norms',
        result: open === 0 ? 'pass' : 'fail',
        detail: `${fixed} fixed, ${passed} passed${input?.auto === true ? ' (non-blocking, automatic)' : ''}, ${open} open`,
      }))
    } catch {
      return { result: none(NO_GITHUB) }
    }
    if ('why' in recorded) return { result: none(recorded.why) }
    return { result: `record: ${recorded.text}` }
  } catch (err: any) {
    return { result: none(String(err?.message ?? err).trim()) }
  }
}

export function register(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    // In the tool list from the start (isDeferred false): check.md calls it
    // at its last step, and behind tool search the model would skip it.
    try {
      await $.tool.register({
        name: 'check_done', description: CHECK_DONE_DESCRIPTION, inputSchema: CHECK_DONE_SCHEMA, isDeferred: false,
      })
    } catch (err: any) {
      // Not listed: the report goes without a record line, and the session says why.
      warn($, `norms: mcp__norms__check_done could not be registered, the report goes without a record line: ${String(err?.message ?? err).trim()}`)
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('tool.call', { tool: CHECK_DONE_TOOL }, async ($: any, e: any) => {
    const answer = await checkDone($, e)
    // The main loop's call only (a subagent's is not the walkthrough's), and only once the
    // record is written: a refused call leaves the guards armed.
    if (!e.agentId && wroteRecord(answer)) endSkillCheck()
    return answer
  })
    .catch(async () => ({ result: none('the norms module failed'), isError: false }))
}
