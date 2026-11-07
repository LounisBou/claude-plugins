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

export const LOOP_TOOL = 'loop'

export const LOOP_DESCRIPTION =
  'pr-review: the state of /pr-review:auto-fix-loop. Actions: start {test_command} once before '
  + 'the first pass; begin_pass before each review (answers the pass number, or exit max_passes); '
  + 'findings {keys, blocking} after each review, one key per finding as "<file>::<summary>" and '
  + 'blocking the number of them that are Critical or Important (answers which keys are new and '
  + 'which were seen; an empty list answers exit clean); fixed {key, sha, '
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
    resetLoop(String(e.test_command ?? '').trim())
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
    return { pass: loop.pass, max_passes: MAX_PASSES, next: 'run the review, then report findings' }
  }
  if (action === 'findings') {
    const keys = strings(e.keys)
    loop.lastFindings = keys.length
    loop.lastBlocking = Number.isInteger(e.blocking) && e.blocking >= 0 ? e.blocking : undefined
    if (keys.length === 0) {
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

// The Stop gate's reason, or null to let the stop through.
export function stopReason(stopHookActive: boolean): string | null {
  if (stopHookActive || !loop.isActive) return null
  return `pr-review auto-fix-loop: pass ${loop.pass}/${MAX_PASSES}, and the last review reported ${loop.lastFindings} finding(s). `
    + 'The loop ends only on a review with zero findings or after pass 5: call mcp__pr-review__loop begin_pass and run the review again.'
}

export function releaseLoop(): void {
  if (loop.isActive) {
    loop.isActive = false
    loop.exit = 'released'
  }
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
    keys: { type: 'array', items: { type: 'string' } },
    blocking: { type: 'integer', description: 'findings: how many of the keys are Critical or Important' },
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
  if (exit === 'clean') return { result: 'pass', detail: `clean at pass ${loop.pass}` }
  if (exit !== 'max_passes') return null
  const left = `${loop.lastFindings} findings left after ${loop.pass} passes`
  if (loop.lastBlocking === 0) return { result: 'pass', detail: `${left}, none Critical or Important` }
  if (loop.lastBlocking === undefined) return { result: 'fail', detail: `${left}, severity unknown` }
  return { result: 'fail', detail: `${left}, ${loop.lastBlocking} Critical or Important` }
}

const textOf = (answer: any): string => String(answer?.result ?? answer?.text ?? answer?.deny ?? '').trim()

// Writes the review record through the github tool, once the loop has ended.
// Always answers the line the loop's answer carries; never throws.
async function recordReview($: any, exit: string): Promise<string | null> {
  const outcome = verdict(exit)
  if (!outcome) return null
  try {
    if (!(await $.tool.list()).some((t: any) => t.name === RECORD_TOOL)) return `record: none — ${NO_GITHUB}`
    const status = await $.process.run(['git', 'status', '--porcelain', '-uno'], { timeoutMs: 10_000 })
    if (status.exitCode !== 0) return 'record: none — git status failed: ' + String(status.stderr ?? '').trim()
    if (String(status.stdout).trim() !== '') return 'record: none — the tracked files have changes: a record is written on a clean checkout of the head'
    const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
    const repo = remote.exitCode === 0 ? repoOf(String(remote.stdout)) : undefined
    if (!repo) return 'record: none — the origin remote is not a GitHub repository'
    const found = await $.tool.call({ tool: GH_TOOL, command: 'pr-get', args: { format: 'pr-number' } })
    if (found?.deny || found?.isError) return 'record: none — ' + (textOf(found) || 'the pull request could not be read')
    const pr = Number(textOf(found))
    if (!Number.isInteger(pr) || pr < 1) return 'record: none — the branch has no pull request'
    const written = await $.tool.call({ tool: RECORD_TOOL, pr, repo, kind: 'review', result: outcome.result, detail: outcome.detail })
    if (written?.deny || written?.isError) return 'record: none — ' + (textOf(written) || 'refused')
    return 'record: ' + textOf(written)
  } catch (err: any) {
    return 'record: none — ' + String(err?.message ?? err)
  }
}

export function register(on: any): void {
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
