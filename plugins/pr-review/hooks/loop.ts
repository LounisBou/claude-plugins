// hooks/loop.ts
// auto-fix-loop's state held by the module, and its two exit conditions held
// by a Stop gate. The skill reports each pass to the loop tool; the tool says
// which findings are new, counts the passes and says when the loop is over.
// While a loop runs and neither exit condition has been met, a stop is refused
// once, with the pass it stands at.
//
// Never a trap: the gate refuses at most once per stop (the host re-fires it
// with stop_hook_active set, and the gate steps aside), and any prompt the user
// types, an interrupted turn or a /clear ends the loop's hold.
import { loop, resetLoop, MAX_PASSES } from './state.ts'
import { GH_TOOL } from './policy.ts'
import { REPORT_REQUEST, agentText, answerText, isBlocking, isRefusedRewrite, launchedAgent, MAX_WAITS, passFindings, reportOf, type Finding } from './report.ts'

export const LOOP_TOOL = 'loop'

export const LOOP_DESCRIPTION =
  'pr-review: the state of /pr-review:auto-fix-loop. Actions: start {test_command, review_only} once before '
  + 'the first pass (review_only: a reviewer\'s loop, one pass and no fix, its first findings end it with exit reviewed); begin_pass before each review (answers the pass number, or exit max_passes); '
  + 'findings {keys} after each review, one key per finding as "<file>::<summary>" (answers which '
  + 'keys are new and which were seen; an empty list answers exit clean when every review agent '
  + 'reported none, and the Critical and Important count is read from the agents\' own blocks); fixed {key, sha, '
  + 'description} after each commit; reverted {key, sha} after a revert; status for the summary. '
  + 'The answer that carries an exit also carries a record line: the review record left for the '
  + 'github plugin\'s ready guard, or why none was.'

function summary(): Record<string, unknown> {
  return {
    passes: loop.pass,
    max_passes: MAX_PASSES,
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
export function act(e: any): Record<string, unknown> {
  const action = String(e?.action ?? '')
  if (action === 'start') {
    resetLoop(String(e.test_command ?? '').trim(), e.review_only === true)
    if (loop.isReviewOnly) return { pass: 0, max_passes: 1, next: 'call begin_pass, run the review, report its findings: no fix is made, the loop ends there' }
    return { pass: 0, max_passes: MAX_PASSES, next: 'call begin_pass, then run the review' }
  }
  if (action === 'status') return summary()
  if (!loop.isActive && loop.exit === undefined) {
    return { error: 'no loop is running: call start first' }
  }
  if (action === 'begin_pass') {
    if (!loop.isActive) return { exit: loop.exit, ...summary() }
    if (loop.pass >= MAX_PASSES) {
      loop.isActive = false
      loop.exit = 'max_passes'
      return { exit: 'max_passes', ...summary() }
    }
    loop.pass += 1
    loop.isReviewing = true
    loop.reports = []
    loop.readers = []
    loop.awaiting = new Map()
    loop.waits = 0
    loop.waitedAt = -1
    loop.lastFindings = 0
    loop.lastBlocking = undefined
    return { pass: loop.pass, max_passes: MAX_PASSES, next: 'run the review, then report findings' }
  }
  if (action === 'findings') {
    // A clean exit records a pass: it must follow a review the loop counted, never the start.
    if (loop.pass === 0) return { error: 'no review pass has begun: call begin_pass, run the review, then report its findings' }
    const keys = strings(e.keys)
    // The pass's verdict waits for every agent the host runs in the background, whatever the keys.
    // One wait per hand-back event: calls with none between them are one wait, not several.
    const running = loop.awaiting.size
    if (running > 0) {
      if (loop.waitedAt !== loop.handbacks) {
        loop.waits += 1
        loop.waitedAt = loop.handbacks
      }
      if (loop.waits <= MAX_WAITS) return { error: `${running} review agents are still running in the background: wait for their hand-back, then report` }
      loop.awaiting = new Map()
      return { error: `${running} review agents never handed back after ${MAX_WAITS} waits: the pass cannot be found clean; call begin_pass and run the review again` }
    }
    // A verdict, whether a clean exit, a reviewer's or the fix loop's last pass, is computed from
    // the agents' blocks: none without an agent.
    if (loop.reports.length === 0) {
      return { error: 'no review agent ran in this pass: the verdict is computed from the agents\' findings; launch the review agents (a call refused for the hook\'s rewrite did not run: issue it again), then report' }
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
    loop.fixes.push({ key: String(e.key ?? ''), sha: String(e.sha ?? ''), description: String(e.description ?? ''), reverted: false })
    return { pass: loop.pass, fixes: loop.fixes.filter((f) => !f.reverted).length }
  }
  if (action === 'reverted') {
    const fix = [...loop.fixes].reverse().find((f) => !f.reverted && (f.sha === String(e.sha ?? '') || f.key === String(e.key ?? '')))
    if (fix) fix.reverted = true
    return { pass: loop.pass, reverted: fix ? fix.sha : null }
  }
  return { error: `unknown action: ${action}` }
}

// The review agents of the pass that handed back no readable findings block, by the name they
// were launched under.
function silentReaders(): string[] {
  return loop.reports.flatMap((r, i) => (r === null ? [loop.readers[i] ?? `review agent ${i + 1}`] : []))
}

// Why the severity of a pass is unknown: the readers whose block is missing.
const unknownSeverity = (): string => `severity unknown: no findings block from ${silentReaders().join(', ')}`

// The Stop gate's reason, or null to let the stop through.
// A pass whose agents still run in the background ends its turn: their hand-back wakes the session.
export function stopReason(stopHookActive: boolean): string | null {
  if (stopHookActive || !loop.isActive) return null
  if (loop.isReviewing && loop.awaiting.size > 0) return null
  return `pr-review auto-fix-loop: pass ${loop.pass}/${MAX_PASSES}, and the last review reported ${loop.lastFindings} finding(s). `
    + 'The loop ends only on a review with zero findings or after pass 5: call mcp__pr-review__loop begin_pass and run the review again.'
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

// A background agent of the pass has answered: its report, or null, fills its place once.
function settle(id: string, report: Finding[] | null): void {
  const place = loop.awaiting.get(id)
  if (place === undefined || !loop.isActive || !loop.isReviewing) return
  loop.reports[place] = report
  loop.awaiting.delete(id)
}

// A background agent of the pass that ended its turn without a hand-back: its last answer is its report.
export function agentEnded(id: string, reason: string, answer: string): void {
  handedBack()
  if (loop.awaiting.has(id)) settle(id, reason === 'answer' ? reportOf(answer) : null)
}

function redraw($: any): void {
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

// owner/name from an origin URL, ssh or https.
function repoOf(url: string): string | undefined {
  const m = url.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)
  return m ? m[1] : undefined
}

// The review record's result and detail for the exit the loop just reached.
export function verdict(exit: string): { result: 'pass' | 'fail'; detail: string } | null {
  if (exit === 'clean') return { result: 'pass', detail: `clean at pass ${loop.pass}, ${loop.reports.length} review agents reporting no finding` }
  if (exit === 'reviewed') {
    const found = `${loop.lastFindings} findings`
    if (loop.lastBlocking === 0) return { result: 'pass', detail: `reviewed: ${found}, none Critical or Important` }
    if (loop.lastBlocking === undefined) return { result: 'fail', detail: `reviewed: ${found}, ${unknownSeverity()}`.slice(0, 500) }
    return { result: 'fail', detail: `reviewed: ${found}, ${loop.lastBlocking} Critical or Important: ${loop.seen.join('; ')}`.slice(0, 500) }
  }
  if (exit !== 'max_passes') return null
  const left = `${loop.lastFindings} findings left after ${loop.pass} passes`
  if (loop.lastBlocking === 0) return { result: 'pass', detail: `${left}, none Critical or Important` }
  if (loop.lastBlocking === undefined) return { result: 'fail', detail: `${left}, ${unknownSeverity()}`.slice(0, 500) }
  return { result: 'fail', detail: `${left}, ${loop.lastBlocking} Critical or Important` }
}

const textOf = (answer: any): string => String(answer?.result ?? answer?.text ?? answer?.deny ?? '').trim()

const git = ($: any, argv: string[]) => $.process.run(['git', ...argv], { timeoutMs: 10_000 })

// The pull request of the checkout, in its repository, named: a branch asks for its own; a detached
// head (a review checkout) names no branch, and the open pull request whose head is its commit is
// the one, never one of several. The number, or the line that says why there is none.
async function pullOf($: any, repo: string): Promise<number | string> {
  const branchRun = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = String(branchRun.stdout ?? '').trim()
  if (branchRun.exitCode !== 0 || branch === '') return 'record: none — git rev-parse failed: ' + String(branchRun.stderr ?? '').trim()
  if (branch !== 'HEAD') {
    const found = await $.tool.call({ tool: GH_TOOL, command: 'pr-get', args: { branch, format: 'pr-number' }, repo })
    if (found?.deny || found?.isError) return 'record: none — ' + (textOf(found) || 'the pull request could not be read')
    const pr = Number(textOf(found))
    return Number.isInteger(pr) && pr >= 1 ? pr : 'record: none — the branch has no pull request'
  }
  const headRun = await git($, ['rev-parse', 'HEAD'])
  const head = String(headRun.stdout ?? '').trim()
  if (headRun.exitCode !== 0 || head === '') return 'record: none — git rev-parse failed: ' + String(headRun.stderr ?? '').trim()
  const listed = await $.tool.call({ tool: GH_TOOL, command: 'pr-list', args: {}, repo })
  if (listed?.deny || listed?.isError) return 'record: none — ' + (textOf(listed) || 'the pull requests could not be read')
  let pulls: unknown
  try {
    pulls = JSON.parse(textOf(listed))
  } catch {
    pulls = undefined
  }
  if (!Array.isArray(pulls)) return 'record: none — the github plugin\'s pr-list answer is not a list of pull requests'
  const at = pulls.filter((p: any) => p?.head?.sha === head)
  if (at.length > 1) return `record: none — ${at.length} open pull requests have the head ${head.slice(0, 12)}: ${at.map((p: any) => `${repo}#${String(p?.number)}`).join(', ')}`
  const pr = Number(at[0]?.number)
  return Number.isInteger(pr) && pr >= 1 ? pr : `record: none — no open pull request has the head ${head.slice(0, 12)}`
}

// Writes the review record through the github tool, once the loop has ended.
// Always answers the line the loop's answer carries; never throws.
async function recordReview($: any, exit: string): Promise<string | null> {
  const outcome = verdict(exit)
  if (!outcome) return null
  // A pass whose findings were never accepted read nothing: its count is no verdict.
  if (loop.isReviewing) return 'record: none — the last pass has no findings its review agents reported'
  try {
    if (!(await $.tool.list()).some((t: any) => t.name === RECORD_TOOL)) return `record: none — ${NO_GITHUB}`
    const status = await git($, ['status', '--porcelain', '-uno'])
    if (status.exitCode !== 0) return 'record: none — git status failed: ' + String(status.stderr ?? '').trim()
    if (String(status.stdout).trim() !== '') return 'record: none — the tracked files have changes: a record is written on a clean checkout of the head'
    const remote = await git($, ['remote', 'get-url', 'origin'])
    const repo = remote.exitCode === 0 ? repoOf(String(remote.stdout)) : undefined
    if (!repo) return 'record: none — the origin remote is not a GitHub repository'
    const pr = await pullOf($, repo)
    if (typeof pr === 'string') return pr
    const written = await $.tool.call({ tool: RECORD_TOOL, pr, repo, kind: 'review', result: outcome.result, detail: outcome.detail })
    if (written?.deny || written?.isError) return 'record: none — ' + (textOf(written) || 'refused')
    return 'record: ' + textOf(written)
  } catch (err: any) {
    return 'record: none — ' + String(err?.message ?? err)
  }
}

export function register(on: any): void {
  // Each agent a review pass launches is asked for its findings block, and its answer is read.
  // The call asks for the foreground, once: a rewrite the call already carries is no rewrite, so
  // the call the host sends back to be issued again with the hook's input goes through as it is.
  // The host may run the agent in the background all the same: core's record of the launch then
  // names the agent, and its hand-back, read below, fills its place in the pass.
  // The agent runs once: a failure is its answer, and leaves the pass without a count; a call
  // that the host refused for the hook's rewrite never ran, and is no agent of the pass; any other
  // refusal is the agent's answer.
  on('tool.call', { tool: 'Agent' }, async ($: any, e: any, next: any) => {
    if (!loop.isActive || !loop.isReviewing) return next(e)
    const prompt = String(e.prompt ?? '')
    const reader = String(e.subagent_type || e.description || 'general-purpose')
    let answer: any
    try {
      answer = await next({ ...e, prompt: prompt.includes(REPORT_REQUEST) ? prompt : prompt + REPORT_REQUEST, run_in_background: false })
    } catch (err: any) {
      loop.reports.push(null)
      loop.readers.push(reader)
      return { result: String(err?.message ?? err), isError: true }
    }
    let report: ReturnType<typeof reportOf> = null
    let agent: string | undefined
    try {
      const text = answerText(answer) || String(answer?.deny ?? '')
      if (isRefusedRewrite(text)) return answer
      const failed = Boolean(answer?.isError || answer?.deny)
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
  }).catch(async (_$: any, e: any, next: any) => next(e))

  // The hand-back of a review agent the host ran in the background, as a delivery that carries
  // the hand-back's origin: its report, read for the pass it belongs to. The host of 2026-11
  // gives session.receive no such origin; the agent's own SubagentHandback call, below, is read. Only the host's own delivery counts: a peer origin flagged as a hand-back,
  // from an agent launched in this pass, on the main session's event. The message goes on to the
  // model as it came.
  on('session.receive', {}, async (_$: any, e: any, next: any) => {
    try {
      const o = e?.origin
      const id = typeof o?.from === 'string' ? o.from : ''
      if (!e?.agentId && o?.kind === 'peer' && o?.handback === true && typeof o?.handbackReportText === 'string'
        && loop.isActive && loop.isReviewing) {
        handedBack()
        if (loop.awaiting.has(id)) settle(id, reportOf(o.handbackReportText))
      }
    } catch {
      // Unreadable: no count.
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  // The report of a review agent the host ran in the background, read where the module sees it:
  // the agent's own SubagentHandback call, in its loop (`agentId`, the id its launch named), once
  // core says the report reached the session. A hand-back that reached no one is not read.
  on('tool.call', { tool: HANDBACK_TOOL }, async (_$: any, e: any, next: any) => {
    const answer = await next(e)
    try {
      const id = typeof e?.agentId === 'string' ? e.agentId : ''
      handedBack()
      if (answer?.result?.success === true && typeof e?.message === 'string') settle(id, reportOf(e.message))
    } catch {
      // Unreadable: no count.
    }
    return answer
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('tool.call', { tool: 'mcp__pr-review__loop' }, async ($: any, e: any) => {
    const before = loop.exit
    const answer = act(e)
    redraw($)
    const text = JSON.stringify(answer, null, 2)
    // The record is written once, at the call that ends the loop.
    if (before === undefined && loop.exit !== undefined && !loop.isRecorded) {
      loop.isRecorded = true
      const line = await recordReview($, loop.exit)
      if (line) return { result: text + '\n' + line }
    }
    return { result: text, ...(answer.error ? { isError: true } : {}) }
  }).catch(async () => ({ result: 'pr-review loop tool failed in the module: keep the loop state yourself, as the skill describes.', isError: true }))

  on('classic.Stop', async ($: any, e: any, next: any) => {
    const reason = stopReason(Boolean(e.stop_hook_active))
    return reason ? { block: reason } : next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))
}
