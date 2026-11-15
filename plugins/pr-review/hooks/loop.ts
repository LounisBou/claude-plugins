// hooks/loop.ts
// auto-fix-loop's state held by the module, and its two exit conditions watched
// at the Stop event. The skill reports each pass to the loop tool; the tool says
// which findings are new, counts the passes and says when the loop is over.
// While a loop runs and neither exit condition has been met, a stop goes through
// and leaves one line in the journal. Each pass the loop accepts leaves its Critical and Important
// findings there too, one event each (hooks/observe.ts), so they outlive the session.
//
// Never a trap: the stop is never refused, and any prompt the user types, an
// interrupted turn or a /clear ends the loop's watch.
import { loop, resetLoop, MAX_PASSES } from './state.ts'
import { GH_TOOL } from './policy.ts'
import { isSpawned } from '../core/env.ts'
import { answerOf, fieldsOf, messageOf, type Host, type Input, type On } from '../core/host.ts'
import { findingEvent } from '../core/learning.ts'
import { REVIEW_ROUNDS, reviewRounds } from '../core/readiness.ts'
import { reportPathOf, verdictLine } from '../core/verdict.ts'
import { journal, noteSubject, notedSubject, observed, resetSubject } from './observe.ts'
import { REPORT_REQUEST, agentText, carriesRequest, answerText, isBlocking, isRefusedRewrite, launchedAgent, MAX_WAITS, passFindings, reportOf, type Finding } from './report.ts'

export const LOOP_TOOL = 'loop'

export type LoopHost = Host<'env' | 'fs' | 'process' | 'session' | 'clock' | 'ui' | 'tool'>

export const LOOP_DESCRIPTION =
  'pr-review: the state of /pr-review:auto-fix-loop. Actions: start {test_command, review_only} once before '
  + 'the first pass (review_only: a reviewer\'s loop, one pass and no fix, its first findings end it with exit reviewed); begin_pass before each review (answers the pass number, or exit max_passes); '
  + 'findings {keys} after each review, one key per finding as "<file>::<summary>" (answers which '
  + 'keys are new and which were seen; an empty list, or keys whose agents reported no Critical or Important finding, answers exit clean, '
  + 'the count being read from the agents\' own blocks); fixed {key, sha, '
  + 'description} after each commit; reverted {key, sha} after a revert; status for the summary. '
  + 'The answer that carries an exit also carries a record line: the review record left for the '
  + 'github plugin\'s ready guard, or why none was.'

function summary(): Record<string, unknown> {
  return {
    passes: loop.pass,
    max_passes: loop.maxPasses,
    exit: loop.exit ?? null,
    test_command: loop.testCommand || 'UNDETERMINED',
    fixes: loop.fixes.filter((f) => !f.reverted).map((f) => ({ sha: f.sha, description: f.description, key: f.key })),
    reverted: loop.fixes.filter((f) => f.reverted).map((f) => ({ sha: f.sha, key: f.key })),
    seen: loop.seen,
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((v) => String(v)).filter((v) => v.trim() !== '') : []

// One action of the loop tool, applied to module memory; the answer the model reads.
export function act(e: Input, dir?: { dir: string } | { why: string }, maxPasses = MAX_PASSES): Record<string, unknown> {
  const action = String(e['action'] ?? '')
  if (action === 'start') {
    resetLoop(String(e['test_command'] ?? '').trim(), e['review_only'] === true, dir && 'dir' in dir ? dir.dir : undefined, dir && 'why' in dir ? dir.why : undefined, maxPasses)
    if (loop.isReviewOnly) return { pass: 0, max_passes: 1, next: 'call begin_pass, run the review, report its findings: no fix is made, the loop ends there' }
    return { pass: 0, max_passes: loop.maxPasses, next: 'call begin_pass, then run the review' }
  }
  if (action === 'status') return summary()
  if (!loop.isActive && loop.exit === undefined) {
    return { error: 'no loop is running: call start first' }
  }
  if (action === 'begin_pass') {
    if (!loop.isActive) return { exit: loop.exit, ...summary() }
    if (loop.pass >= loop.maxPasses) {
      loop.isActive = false
      loop.exit = 'max_passes'
      return { exit: 'max_passes', ...summary() }
    }
    loop.pass += 1
    loop.isReviewing = true
    loop.reports = []
    loop.readers = []
    loop.awaiting = new Map()
    loop.blockless = new Set()
    loop.reasked = new Set()
    loop.ended = new Set()
    loop.waits = 0
    loop.waitedAt = -1
    loop.lastFindings = 0
    loop.lastBlocking = undefined
    return { pass: loop.pass, max_passes: loop.maxPasses, next: 'run the review, each review agent\'s prompt ending with report_request verbatim, then report findings', report_request: REPORT_REQUEST.trim() }
  }
  if (action === 'findings') {
    // A clean exit records a pass: it must follow a review the loop counted, never the start.
    if (loop.pass === 0) return { error: 'no review pass has begun: call begin_pass, run the review, then report its findings' }
    const keys = strings(e['keys'])
    // A background agent whose hand-back carried no block is asked for it once, its place kept;
    // its waits start over, the ones counted before it was asked are not its own.
    if (loop.blockless.size > 0) {
      const ids = [...loop.blockless]
      ids.forEach((id) => loop.reasked.add(id))
      loop.blockless.clear()
      loop.waits = 0
      loop.waitedAt = -1
      return { error: ids.map(reaskLine).join('\n') }
    }
    // The pass's verdict waits for every agent the host runs in the background, whatever the keys.
    // One wait per hand-back event: calls with none between them are one wait, not several. Once
    // every awaited agent was asked again, each call is one wait: no other hand-back may come.
    const running = loop.awaiting.size
    if (running > 0) {
      const isAllReasked = [...loop.awaiting.keys()].every((id) => loop.reasked.has(id))
      if (isAllReasked || loop.waitedAt !== loop.handbacks) {
        loop.waits += 1
        loop.waitedAt = loop.handbacks
      }
      if (loop.waits <= MAX_WAITS) return { error: `${running} review agents are still running in the background: wait for their hand-back, then report` }
      // An agent asked twice for its block that never answered is silent, its place left null; one
      // never heard from leaves the pass unread.
      const unheard = [...loop.awaiting.keys()].filter((id) => !loop.reasked.has(id)).length
      loop.awaiting = new Map()
      if (unheard > 0) return { error: `${unheard} review agents never handed back after ${MAX_WAITS} waits: the pass cannot be found clean; call begin_pass and run the review again` }
    }
    // A verdict, whether a clean exit, a reviewer's or the fix loop's last pass, is computed from
    // the agents' blocks: none without an agent.
    if (loop.reports.length === 0) {
      return { error: 'no review agent ran in this pass: the verdict is computed from the agents\' findings; launch the review agents (a call the host or a hook refused did not run: issue it again), then report' }
    }
    const found = passFindings(loop.reports)
    if (keys.length === 0 && found === undefined) {
      const silent = silentReaders()
      return { error: `${silent.length} of ${loop.reports.length} review agents ended without their findings block (${silent.join(', ')}): the pass cannot be found clean; call begin_pass and run the review again` }
    }
    if (keys.length === 0 && found !== undefined && found.length > 0) {
      return { error: `the review agents reported ${found.length} finding(s) in this pass: report their keys` }
    }
    loop.isReviewing = false
    loop.lastFindings = found?.length ?? keys.length
    loop.lastBlocking = found?.filter(isBlocking).length
    if (keys.length === 0) {
      loop.isActive = false
      loop.exit = 'clean'
      return { exit: 'clean', ...summary() }
    }
    if (loop.isReviewOnly) {
      loop.seen.push(...keys)
      loop.isActive = false
      loop.exit = 'reviewed'
      return { exit: 'reviewed', ...summary() }
    }
    // Suggestions alone do not hold the loop: it ends on a pass with no Critical or Important finding.
    if (loop.lastBlocking === 0) {
      loop.isActive = false
      loop.exit = 'clean'
      return { exit: 'clean', ...summary() }
    }
    const seen = keys.filter((k) => loop.seen.includes(k))
    const fresh = keys.filter((k) => !loop.seen.includes(k))
    loop.seen.push(...fresh)
    return {
      pass: loop.pass,
      new: fresh,
      seen,
      next: 'fix the actionable new findings, commit each, run the tests, then call begin_pass: the loop goes on',
    }
  }
  if (action === 'fixed') {
    loop.fixes.push({ key: String(e['key'] ?? ''), sha: String(e['sha'] ?? ''), description: String(e['description'] ?? ''), reverted: false })
    return { pass: loop.pass, fixes: loop.fixes.filter((f) => !f.reverted).length }
  }
  if (action === 'reverted') {
    const fix = [...loop.fixes].reverse().find((f) => !f.reverted && (f.sha === String(e['sha'] ?? '') || f.key === String(e['key'] ?? '')))
    if (fix) fix.reverted = true
    return { pass: loop.pass, reverted: fix ? fix.sha : null }
  }
  return { error: `unknown action: ${action}` }
}

// What `findings` answers for an agent whose hand-back carried no block: ask it once more.
function reaskLine(id: string): string {
  const reader = loop.readers[loop.awaiting.get(id) ?? -1] ?? 'a review agent'
  return `${reader} (agentId ${id}) handed back no findings block: SendMessage to '${id}' asking only for `
    + 'its closing ```json findings block (an empty list when it found nothing), wait for its hand-back, then report again'
}

// The review agents of the pass that handed back no readable findings block, by the name they
// were launched under.
function silentReaders(): string[] {
  return loop.reports.flatMap((r, i) => (r === null ? [loop.readers[i] ?? `review agent ${i + 1}`] : []))
}

// Why the severity of a pass is unknown: the readers whose block is missing, or that none was read.
function unknownSeverity(): string {
  const silent = silentReaders()
  return silent.length > 0 ? `severity unknown: no findings block from ${silent.join(', ')}` : 'severity unknown: no review agent\'s findings block was read'
}

// The code of the stop the loop would once have held, or null when the stop is plain.
// A pass whose agents still run in the background ends its turn: their hand-back wakes the session.
// An agent that handed back no block runs no more: until `findings` has it asked again, nothing
// would wake the session. The stop goes through either way, and the journal keeps one line.
export function stopCode(stopHookActive: boolean): string | null {
  if (stopHookActive || !loop.isActive) return null
  if (loop.isReviewing && loop.blockless.size > 0) return 'pr-review.stop.reader-blockless'
  if (loop.isReviewing && loop.awaiting.size > 0) return null
  return 'pr-review.stop.loop-open'
}

export function releaseLoop(): void {
  if (loop.isActive) {
    loop.isActive = false
    loop.exit = 'released'
  }
}

// The tool a subagent calls, in its own loop, to hand its final report back to the session.
const HANDBACK_TOOL = 'SubagentHandback'

// A hand-back event, of an agent of the pass or not: the waits of `findings` are counted between them.
function handedBack(): void {
  loop.handbacks += 1
}

// A background agent of the pass has answered: its report fills its place once. An answer without
// a block keeps the place until the agent was asked again for its block; then it is silent. A turn
// that ended without an answer (`isFinal`) is silent at once: there is no one to ask again.
function settle(id: string, report: Finding[] | null, isFinal = false): void {
  const place = loop.awaiting.get(id)
  if (place === undefined || !loop.isActive || !loop.isReviewing) return
  if (report === null && !isFinal && !loop.reasked.has(id)) {
    loop.blockless.add(id)
    return
  }
  loop.blockless.delete(id)
  loop.reports[place] = report
  loop.awaiting.delete(id)
}

// A background agent of the pass that ended its turn without a hand-back: its last answer is its report;
// a turn that ended in error or aborted, none, and the agent is silent at once. The first run's
// answer that comes after the agent was asked again, without a block, is no answer to the request:
// the place waits for the second run.
export function agentEnded(id: string, reason: string, answer: string): void {
  handedBack()
  if (!loop.awaiting.has(id)) return
  const isFirstEnd = !loop.ended.has(id)
  loop.ended.add(id)
  const report = reason === 'answer' ? reportOf(answer) : null
  if (reason === 'answer' && report === null && isFirstEnd && loop.reasked.has(id)) return
  settle(id, report, reason !== 'answer')
}

function redraw($: Host<'ui'>): void {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // Nothing draws.
  }
}

export const LOOP_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['start', 'begin_pass', 'findings', 'fixed', 'reverted', 'status'] },
    test_command: { type: 'string' },
    review_only: { type: 'boolean', description: 'start: a reviewer\'s loop, run by a session that did not write the code: one pass, no fix; its findings are the verdict' },
    keys: { type: 'array', items: { type: 'string' } },
    key: { type: 'string' },
    sha: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['action'],
}

const RECORD_TOOL = 'mcp__github__record'
const NO_GITHUB = 'the github plugin 0.12.0 or later is not available'

// What GitHub's own answer says when the failure is its side's and passes: a 5xx, a timeout, a
// connection that dropped. A 4xx (a permission, a missing pull request) is not one.
const TRANSIENT = /\bHTTP 5\d\d\b|\b5\d\d (?:internal server error|bad gateway|service unavailable|gateway time-?out)\b|\b(?:internal server error|bad gateway|service unavailable|gateway time-?out)\b|timed? ?out|timeout|connection (?:reset|refused|aborted|closed)|ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT|EAI_AGAIN|temporarily unavailable/i
export const isTransient = (text: string): boolean => TRANSIENT.test(text)

// The pauses, in seconds, before each new attempt of a github call that failed transiently.
const RETRY_PAUSES = ['0.5', '1', '2']

// owner/name from an origin URL, ssh or https.
function repoOf(url: string): string | undefined {
  const m = url.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)
  return m ? m[1] : undefined
}

// The review record's result and detail for the exit the loop just reached.
export function verdict(exit: string): { result: 'pass' | 'fail'; detail: string } | null {
  if (exit === 'clean') {
    const none = loop.lastFindings === 0 ? 'no finding' : 'no Critical or Important finding'
    return { result: 'pass', detail: `clean at pass ${loop.pass}, ${loop.reports.length} review agents reporting ${none}` }
  }
  if (exit === 'reviewed') {
    const found = `${loop.lastFindings} findings`
    if (loop.lastBlocking === 0) return { result: 'pass', detail: `reviewed: ${found}, none Critical or Important` }
    if (loop.lastBlocking === undefined) return { result: 'fail', detail: `reviewed: ${found}, ${unknownSeverity()}`.slice(0, 500) }
    return { result: 'fail', detail: `reviewed: ${found}, ${loop.lastBlocking} Critical or Important: ${loop.seen.join('; ')}`.slice(0, 500) }
  }
  if (exit !== 'max_passes') return null
  const left = `${loop.lastFindings} findings left after ${loop.pass} passes`
  if (loop.lastBlocking === undefined) return { result: 'fail', detail: `${left}, ${unknownSeverity()}`.slice(0, 500) }
  return { result: 'fail', detail: `${left}, ${loop.lastBlocking} Critical or Important` }
}

// The text a tool answered, its refusal when it answered none.
const textOf = (answer: unknown): string => {
  const read = answerOf(answer)
  return read.text || (read.deny ?? '')
}

// Whether a tool's answer is a refusal or an error.
const isFailed = (answer: unknown): boolean => {
  const read = answerOf(answer)
  return read.deny !== undefined || read.isError
}

const git = ($: Host<'process'>, argv: string[], dir?: string) => $.process.run(['git', ...argv], { timeoutMs: 10_000, ...(dir ? { cwd: dir } : {}) })

// The top directory of the checkout the session is in, or why it is in none.
async function checkoutDir($: Host<'process'>): Promise<{ dir: string } | { why: string }> {
  try {
    const run = await git($, ['rev-parse', '--show-toplevel'])
    const top = String(run.stdout ?? '').trim()
    if (run.exitCode === 0 && top.startsWith('/')) return { dir: top }
    return { why: String(run.stderr ?? '').trim() || 'git rev-parse --show-toplevel answered ' + (top || 'nothing') }
  } catch (err) {
    return { why: messageOf(err).trim() }
  }
}

// A call to a github tool, asked again after a pause while it fails transiently; a refusal that is
// not transient is the answer at once. The last answer, or the last error thrown, once the pauses
// are spent.
async function github($: Host<'tool' | 'process'>, call: Record<string, unknown>): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let answer: unknown
    let failure: string
    let thrown: unknown
    try {
      answer = await $.tool.call(call)
      if (!isFailed(answer)) return answer
      failure = textOf(answer)
    } catch (err) {
      thrown = err
      failure = messageOf(err)
    }
    const pause = RETRY_PAUSES[attempt]
    if (!isTransient(failure) || pause === undefined) {
      if (thrown !== undefined) throw thrown
      return answer
    }
    await $.process.run(['sleep', pause], { timeoutMs: 10_000 })
  }
}

// The pull request of the checkout, in its repository, named: a branch asks for its own; a detached
// head (a review checkout) names no branch, and the open pull request whose head is its commit is
// the one, never one of several. The number, or the line that says why there is none.
async function pullOf($: Host<'process'>, repo: string, ask: (call: Record<string, unknown>) => Promise<unknown>, dir?: string): Promise<number | string> {
  const branchRun = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'], dir)
  const branch = String(branchRun.stdout ?? '').trim()
  if (branchRun.exitCode !== 0 || branch === '') return 'record: none — git rev-parse failed: ' + String(branchRun.stderr ?? '').trim()
  if (branch !== 'HEAD') {
    const found = await ask({ tool: GH_TOOL, command: 'pr-get', args: { branch, format: 'pr-number' }, repo })
    if (isFailed(found)) return 'record: none — ' + (textOf(found) || 'the pull request could not be read')
    const pr = Number(textOf(found))
    return Number.isInteger(pr) && pr >= 1 ? pr : 'record: none — the branch has no pull request'
  }
  const headRun = await git($, ['rev-parse', 'HEAD'], dir)
  const head = String(headRun.stdout ?? '').trim()
  if (headRun.exitCode !== 0 || head === '') return 'record: none — git rev-parse failed: ' + String(headRun.stderr ?? '').trim()
  const listed = await ask({ tool: GH_TOOL, command: 'pr-list', args: { format: 'raw' }, repo })
  if (isFailed(listed)) return 'record: none — ' + (textOf(listed) || 'the pull requests could not be read')
  let pulls: unknown
  try {
    pulls = JSON.parse(textOf(listed))
  } catch {
    pulls = undefined
  }
  if (!Array.isArray(pulls)) return 'record: none — the github plugin\'s pr-list answer is not a list of pull requests'
  const at = pulls.map((p: unknown) => fieldsOf(p) ?? {}).filter((p) => fieldsOf(p['head'])?.['sha'] === head)
  if (at.length > 1) return `record: none — ${at.length} open pull requests have the head ${head.slice(0, 12)}: ${at.map((p) => `${repo}#${String(p['number'])}`).join(', ')}`
  const pr = Number(at[0]?.['number'])
  return Number.isInteger(pr) && pr >= 1 ? pr : `record: none — no open pull request has the head ${head.slice(0, 12)}`
}

// What a record line says when GitHub kept failing: the verdict is kept and the write is owed.
const PENDING_NOTE = '; the record is still owed, the verdict is kept: call findings or status again to write it'

// The head the checkout is at, or undefined when git cannot say.
async function headOf($: Host<'process'>, dir?: string): Promise<string | undefined> {
  const run = await git($, ['rev-parse', 'HEAD'], dir)
  const head = String(run.stdout ?? '').trim()
  return run.exitCode === 0 && head !== '' ? head : undefined
}

const short = (head: string | undefined): string => head ? head.slice(0, 12) : 'no commit'

// Writes the review record through the github tool, once the loop has ended. A retry (the record
// was owed) writes only at the head the loop ended on. The line the loop's answer carries, and
// whether the record is owed: a github call failed transiently and the write did not happen.
// Never throws.
// `found` takes the repository and the pull request once they are known, for the verdict line.
async function recordReview($: Host<'tool' | 'process'>, exit: string, isRetry: boolean, found: { repo?: string; pr?: number } = {}): Promise<{ line: string | null; isOwed: boolean }> {
  const outcome = verdict(exit)
  if (!outcome) return { line: null, isOwed: false }
  // A pass whose findings were never accepted read nothing: its count is no verdict.
  if (loop.isReviewing) return { line: 'record: none — the last pass has no findings its review agents reported', isOwed: false }
  // Whether the last github call failed transiently.
  let isOwed = false
  const ask = async (call: Record<string, unknown>): Promise<unknown> => {
    isOwed = false
    try {
      const answer = await github($, call)
      isOwed = isFailed(answer) && isTransient(textOf(answer))
      return answer
    } catch (err) {
      isOwed = isTransient(messageOf(err))
      throw err
    }
  }
  const none = (why: string) => ({ line: 'record: none — ' + why, isOwed })
  try {
    if (!(await $.tool.list()).some((t) => t.name === RECORD_TOOL)) return none(NO_GITHUB)
    // The checkout the loop started in: a later shell `cd` does not move the record to another one.
    const dir = loop.dir
    if (!dir) return none('the loop started outside a git checkout (' + (loop.dirWhy || 'no directory read') + ')')
    if (isRetry) {
      const now = await headOf($, dir)
      if (now === undefined || loop.reviewedHead === undefined || now !== loop.reviewedHead) {
        return none(`the checkout is at ${short(now)}, the review read ${short(loop.reviewedHead)}: a record is written at the head it read`)
      }
    }
    const status = await git($, ['status', '--porcelain', '-uno'], dir)
    if (status.exitCode !== 0) return none('git status failed: ' + String(status.stderr ?? '').trim())
    if (String(status.stdout).trim() !== '') return none('the tracked files have changes: a record is written on a clean checkout of the head')
    const remote = await git($, ['remote', 'get-url', 'origin'], dir)
    const repo = remote.exitCode === 0 ? repoOf(String(remote.stdout)) : undefined
    if (!repo) return none('the origin remote is not a GitHub repository')
    const pr = await pullOf($, repo, ask, dir)
    if (typeof pr === 'string') return { line: pr, isOwed }
    found.repo = repo
    found.pr = pr
    const written = await ask({ tool: RECORD_TOOL, pr, repo, kind: 'review', result: outcome.result, detail: outcome.detail, dir })
    if (isFailed(written)) return none(textOf(written) || 'refused')
    return { line: 'record: ' + textOf(written), isOwed: false }
  } catch (err) {
    return none(messageOf(err))
  }
}

// What the events written from now on are about: the loop's repository, the head its checkout is
// at, and its pull request, asked of the github tool once per loop, in one attempt. Never throws.
async function readSubject($: Host<'tool' | 'process'>): Promise<void> {
  try {
    const dir = loop.dir
    if (!dir) return
    noteSubject({ head: await headOf($, dir) ?? null })
    if (notedSubject().pr !== null) return
    const remote = await git($, ['remote', 'get-url', 'origin'], dir)
    const repo = remote.exitCode === 0 ? repoOf(String(remote.stdout)) : undefined
    if (!repo) return
    noteSubject({ repo })
    const pr = await pullOf($, repo, (call) => $.tool.call(call), dir)
    if (typeof pr === 'number') noteSubject({ pr })
  } catch {
    // Unread: the events name what was read before.
  }
}

// The Critical and Important findings of the pass the loop just accepted, into the journal: one
// event each, its severity and its file, nothing of its summary.
async function journalPass($: LoopHost): Promise<void> {
  const found = (passFindings(loop.reports) ?? []).filter(isBlocking)
  if (found.length === 0) return
  await readSubject($)
  await journal($, (known) => found.map((f) => findingEvent({ ...known(), code: 'pr-review.finding', severity: f.severity, file: f.file, ...(loop.dir ? { root: loop.dir } : {}) })))
}

// Whether this session was spawned by the orchestrator, from the environment its launcher sets.
async function isOrchestrated($: Host<'env'>): Promise<boolean> {
  const spawned: unknown = await Promise.resolve().then(() => $.env.get('ORCHESTRATOR_SPAWNED')).catch(() => undefined)
  return isSpawned(typeof spawned === 'string' ? spawned : undefined)
}

// The rounds the pull request's check plan gives its review (core's reviewRounds), read through the
// github tool's pr-plan from the checkout's pull request; core's `omitted` when no plan is readable.
async function plannedPasses($: Host<'tool' | 'process'>, top: { dir: string } | { why: string }): Promise<number> {
  try {
    if (!('dir' in top)) return REVIEW_ROUNDS.omitted
    const remote = await git($, ['remote', 'get-url', 'origin'], top.dir)
    const repo = remote.exitCode === 0 ? repoOf(String(remote.stdout)) : undefined
    if (!repo) return REVIEW_ROUNDS.omitted
    const ask = (call: Record<string, unknown>) => github($, call)
    const pr = await pullOf($, repo, ask, top.dir)
    if (typeof pr === 'string') return REVIEW_ROUNDS.omitted
    const answer = await ask({ tool: GH_TOOL, command: 'pr-plan', args: { pr }, repo })
    if (isFailed(answer)) return REVIEW_ROUNDS.omitted
    return reviewRounds(fieldsOf(JSON.parse(textOf(answer)))?.['review'])
  } catch {
    return REVIEW_ROUNDS.omitted
  }
}

// The verdict line an orchestrator's agent sends up (core's verdict.ts), last in the answer that ends
// the loop, in a session the orchestrator spawned only: the review record is its report, and the
// blocking findings' files of the last pass what blocks. Null outside such a session, or with no head.
async function verdictFor($: Host<'env' | 'process'>, exit: string, repo: string, pr: number, line: string): Promise<string | null> {
  if (!await isOrchestrated($)) return null
  const outcome = verdict(exit)
  const headRun = await git($, ['rev-parse', 'HEAD'])
  const head = String(headRun.stdout ?? '').trim()
  if (!outcome || headRun.exitCode !== 0 || head === '') return null
  const blocking = [...new Set((passFindings(loop.reports) ?? []).filter(isBlocking).map((f) => f.file))]
  return verdictLine({ repo, pr, head, verdict: `review ${outcome.result} (${exit})`, blocking, report: reportPathOf(line.replace(/^record:/, 'report:')) })
}

// Every agent a pass launches is a reader of it, whatever its type, but a norms agent: the norms
// check runs beside the review and its agents report no findings block.
const isReader = (type: unknown): boolean => !String(type ?? '').startsWith('norms:')
// The host's agent when the call names none.
const DEFAULT_AGENT = 'general-purpose'

export function register(on: On<LoopHost>): void {
  // Each agent a review pass launches carries the findings-block request in its own prompt, and
  // its answer is read. The hook never changes the call's input: the host's auto mode reviews the
  // call before the hooks run, and refuses one a hook rewrote. A reader whose prompt lacks the
  // request runs all the same, and leaves one line in the journal.
  // The host may run the agent in the background: core's record of the launch then names the
  // agent, and its hand-back, read below, fills its place in the pass.
  // The agent runs once: a failure is its answer, and leaves the pass without a count; a call
  // that the host refused for a hook's rewrite never ran, and is no agent of the pass; any other
  // refusal is the agent's answer.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = e['subagent_type']
    if (!loop.isActive || !loop.isReviewing || !isReader(type)) return next(e)
    if (!carriesRequest(String(e['prompt'] ?? ''))) await observed($, 'pr-review.reader.no-request')
    const reader = typeof type === 'string' && type !== '' ? type : DEFAULT_AGENT
    let answer: unknown
    try {
      answer = await next(e)
    } catch (err) {
      loop.reports.push(null)
      loop.readers.push(reader)
      return { result: messageOf(err), isError: true }
    }
    let report: ReturnType<typeof reportOf> = null
    let agent: string | undefined
    try {
      const text = answerText(answer) || (answerOf(answer).deny ?? '')
      if (isRefusedRewrite(text)) return answer
      const failed = isFailed(answer)
      report = failed ? null : reportOf(agentText(answer))
      agent = report === null && !failed ? launchedAgent(answer) : undefined
    } catch {
      // Unreadable: no count.
    }
    if (loop.isReviewing) {
      if (agent !== undefined) loop.awaiting.set(agent, loop.reports.length)
      loop.reports.push(report)
      loop.readers.push(reader)
    }
    return answer
  }).catch(async (_$, e, next) => next(e))

  // The hand-back of a review agent the host ran in the background, as a delivery that carries
  // the hand-back's origin: its report, read for the pass it belongs to. The host of 2026-11
  // gives session.receive no such origin; the agent's own SubagentHandback call, below, is read. Only the host's own delivery counts: a peer origin flagged as a hand-back,
  // from an agent launched in this pass, on the main session's event. The message goes on to the
  // model as it came.
  on('session.receive', {}, async (_$, e, next) => {
    try {
      const o = fieldsOf(e['origin']) ?? {}
      const id = typeof o['from'] === 'string' ? o['from'] : ''
      const text = o['handbackReportText']
      if (!e['agentId'] && o['kind'] === 'peer' && o['handback'] === true && typeof text === 'string'
        && loop.isActive && loop.isReviewing) {
        handedBack()
        if (loop.awaiting.has(id)) settle(id, reportOf(text))
      }
    } catch {
      // Unreadable: no count.
    }
    return next(e)
  }).catch(async (_$, e, next) => next(e))

  // The report of a review agent the host ran in the background, read where the module sees it:
  // the agent's own SubagentHandback call, in its loop (`agentId`, the id its launch named), once
  // core says the report reached the session. A hand-back that reached no one is not read, but
  // for an agent asked again for its block: core delivers one report per agent, and refuses the second.
  on('tool.call', { tool: HANDBACK_TOOL }, async (_$, e, next) => {
    const answer = await next(e)
    try {
      const id = typeof e['agentId'] === 'string' ? e['agentId'] : ''
      handedBack()
      const read = fieldsOf(answerOf(answer).result)?.['success'] === true || loop.reasked.has(id)
      const message = e['message']
      if (read && typeof message === 'string') settle(id, reportOf(message))
    } catch {
      // Unreadable: no count.
    }
    return answer
  }).catch(async (_$, e, next) => next(e))

  on('tool.call', { tool: 'mcp__pr-review__loop' }, async ($, e) => {
    const before = loop.exit
    const action = e['action']
    // A record still owed after a transient github failure is written again at the next
    // `findings` or `status`: the verdict the loop kept stands, nothing is computed again.
    const isOwed = loop.isRecordPending && (action === 'findings' || action === 'status')
    const top = action === 'start' ? await checkoutDir($) : undefined
    const passes = top && await isOrchestrated($) ? await plannedPasses($, top) : MAX_PASSES
    // A new loop names its own pull request: what an earlier one read is forgotten.
    if (action === 'start') resetSubject()
    const wasReviewing = loop.isReviewing
    const answer = isOwed && action === 'findings' ? { exit: loop.exit, ...summary() } : act(e, top, passes)
    redraw($)
    // The pass the loop just accepted: its findings are kept past the session.
    const isAccepted = action === 'findings' && wasReviewing && !loop.isReviewing
    const text = JSON.stringify(answer, null, 2)
    // The record is first written at the call that ends the loop, at the head the loop ended on.
    // It is owed from before the write: a write interrupted is written again at the next call.
    const isFirst = before === undefined && loop.exit !== undefined && !loop.isRecorded
    // A pass the loop goes on from asks for its pull request itself; the one that ends the loop
    // takes the record's.
    if (isAccepted && !isFirst) await journalPass($)
    if (isOwed || isFirst) {
      loop.isRecorded = true
      loop.isRecordPending = true
      if (isFirst) loop.reviewedHead = await headOf($, loop.dir).catch(() => undefined)
      const found: { repo?: string; pr?: number } = {}
      const written = await recordReview($, String(loop.exit), isOwed, found)
      loop.isRecordPending = written.isOwed
      if (found.repo && found.pr) noteSubject({ repo: found.repo, pr: found.pr })
      if (isAccepted) await journalPass($)
      const verdict = written.line && found.repo && found.pr ? await verdictFor($, String(loop.exit), found.repo, found.pr, written.line) : null
      if (written.line) return { result: text + '\n' + (written.isOwed ? written.line + PENDING_NOTE : written.line) + (verdict ? '\n' + verdict : '') }
    }
    return { result: text, ...(answer['error'] ? { isError: true } : {}) }
  }).catch(async () => ({ result: 'pr-review loop tool failed in the module: keep the loop state yourself, as the skill describes.', isError: true }))

  on('classic.Stop', async ($, e, next) => {
    const code = stopCode(Boolean(e['stop_hook_active']))
    if (code) await observed($, code)
    return next(e)
  }).catch(async (_$, e, next) => next(e))
}
