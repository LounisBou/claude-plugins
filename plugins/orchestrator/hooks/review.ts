// hooks/review.ts
// The orchestrator's review verdict: once its review round has read a pull request's head, the
// orchestrator records the verdict for the github ready gate, a pass, a fail, or an acceptance
// that sets non-critical points aside, each with its reason. The record is github's (core's
// pr-record.ts): this tool writes it from an orchestrator session, or a pass or a fail from a review
// session outside an orchestration (implement's /implement:review, `Agent: review <subject>`), the
// acceptance, the check plan and the row staying the orchestrator's; github checks the rest
// at the head of the clean checkout it reads: the caller's plugin, a session that did not push
// that head, and no pass over a failed review there. In place of a verdict, the same tool writes the pull
// request's check plan (github's check-plan.ts), which github takes from this plugin only.
// Given the dispatch record and its row, the same call then writes level 1 of the review into the
// row (dispatch-record.sh verdict): the verdict, a few words and the path of the review session's
// findings index, the one reading the orchestrator makes of a round.
import { ACCEPTANCE, acceptanceDetail, DETAIL_MAX } from '../core/pr-record.ts'
import { AUDIT_CONTRACT, type Decision, type FindingSeverity } from '../core/learning.ts'
import { parseFindingId } from '../core/lens.ts'
import { PLAN_NEEDS, REVIEW_ROUNDS } from '../core/readiness.ts'
import { isOrchestratorSession, reportsToOrchestrator, sessionNameOf } from './supervision.ts'
import { roleOf } from '../core/names.ts'
import { messageOf, type Host, type On } from './host.ts'
import { logLine } from './module-io.ts'
import { wakeReconciler } from '../core/reconcile-wake.ts'
import { countRound } from './review-rounds.ts'

type Held = Host<'plugin' | 'env' | 'process' | 'tool' | 'session' | 'fs' | 'clock'>

// The tool's short name: the model calls it as mcp__orchestrator__review.
export const REVIEW_TOOL = 'review'
const RECORD_TOOL = 'mcp__github__record'
const VERDICTS = ['pass', 'fail', ACCEPTANCE.result] as const

// A finding as the tool takes it: its point, and its file, line and severity when known.
const FINDING = {
  point: { type: 'string' },
  file: { type: 'string', description: 'its repository path' },
  line: { type: 'integer' },
  severity: { type: 'string', enum: [...AUDIT_CONTRACT.finding_severities] },
}

export const NOT_ORCHESTRATOR = 'Only an orchestrator session records an acceptance, a check plan or a dispatch row, and a review session (`Agent: review <subject>`) a pass or a fail: the review round and the scope are theirs.'

// A review session's name: an agent whose subject starts with « review », as implement's /implement:review names it.
export function isReviewSessionName(name: string | null): boolean {
  return roleOf(name) === 'agent' && /^\S+ ?: review \S/u.test(name ?? '')
}

// Whether a session that is no orchestrator records this verdict: a review session outside an
// orchestration, a pass or a fail at the head with no row. Inside one, the verdict is the orchestrator's.
async function mayReview($: Held, input: Record<string, unknown>, target: RowTarget | null, session: string): Promise<boolean> {
  if (input['plan'] !== undefined || target !== null || text(input['verdict']) === ACCEPTANCE.result) return false
  const name = await sessionNameOf($, session)
  return isReviewSessionName(name) && !(await reportsToOrchestrator($, session, name ?? ''))
}

// The needs a plan may give a check, as core's readiness contract lists them.
export const needsOf = (check: keyof typeof PLAN_NEEDS): string => PLAN_NEEDS[check].join(', ')

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

// The few words of level 1: dispatch-record.ts's VERDICT_WORDS_MAX, which refuses longer ones.
const WORDS_MAX = 120
const ROW_RUN_MS = 10_000
// What stands in github's answer for the detail the verdict sent, which it repeats.
const ECHOED_DETAIL = 'the detail sent'

// github's line of the gate, cut to its verdict: « Ready at <head> », or « Not Ready at <head>.
// Missing: <what> » without the review's own words, which the orchestrator wrote and knows. A line
// of another shape is left whole.
export function gateWords(line: string): string {
  const ready = /^github: \S+ (Ready at \w+)(?::|$)/.exec(line)
  if (ready?.[1] !== undefined) {
    // What the gate carried from an earlier head, or the operator waived, is not the orchestrator's own review: said.
    const carried = /\((?:[^()]|\([^()]*\))*(?:carried from|waived by the operator)(?:[^()]|\([^()]*\))*\)\.$/.exec(line)?.[0]
    return carried === undefined ? ready[1] : `${ready[1]} ${carried.slice(0, -1)}`
  }
  const missing = /^github: \S+ (not Ready yet|back to Not Ready) at (\w+)\. (?:.*?\. )?(Missing: .*)$/.exec(line)
  if (missing?.[1] === undefined || missing[2] === undefined || missing[3] === undefined) return line
  const state = missing[1] === 'not Ready yet' ? 'Not Ready' : 'back to Not Ready'
  return `${state} at ${missing[2]}. ${missing[3].split(` by orchestrator, ${ECHOED_DETAIL}`).join('')}`
}

// The row, as one short piece: the round the count raised and the verdict the row took, when each
// is said in the form of its writer. What is not that form (a count that raised none, a warning, a
// row line of another shape) is returned in `extra`, whole. `rowLine` is the record script's output
// of a row written, null when none was.
export function rowWords(counted: string, rowLine: string | null): { piece: string; extra: string[] } {
  const raised = /^rounds: row (\d+) of .+ raised to (\d+)$/.exec(counted)
  const [first = '', ...rest] = rowLine === null ? [] : rowLine.split('\n')
  const written = /^row (\d+): (\w+) — /.exec(first)
  const extra = [...(raised === null ? [counted] : []), ...(rowLine === null ? [] : written === null ? [rowLine] : rest)].filter(Boolean)
  if (raised !== null && written !== null && raised[1] === written[1]) return { piece: `row ${written[1]}: ${written[2]}, round ${raised[2]}`, extra }
  const pieces = [raised === null ? '' : `row ${raised[1]} round ${raised[2]}`, written === null ? '' : `row ${written[1]}: ${written[2]}`]
  return { piece: pieces.filter(Boolean).join(' · '), extra }
}

// The verdict's answer: the record's path line, which the audit reads, then one line, the gate's
// verdict and the row. A github line of an unknown shape and every warning stay as they are.
export function answerLines(gate: string, counted: string, rowLine: string | null): string {
  const lines = gate.split('\n')
  const at = lines.map((l) => l.startsWith('github: ')).lastIndexOf(true)
  const { piece, extra } = rowWords(counted, rowLine)
  const said = lines.map((l) => (l.startsWith('github: ') ? gateWords(l) : l))
  if (at >= 0 && piece !== '') said[at] = `${said[at]} · ${piece}`
  else if (piece !== '') said.push(piece)
  return [...said, ...extra].join('\n')
}

type RowTarget = { record: string; row: number; findings: string }

// The dispatch record's row a verdict writes level 1 into: null with no record named, or the line
// that says what the input lacks.
export function rowTarget(input: Record<string, unknown>): RowTarget | null | string {
  const record = text(input['record'])
  const row = input['row']
  const findings = text(input['findings'])
  if (record === '' && row === undefined && findings === '') return null
  if (input['plan'] !== undefined) return 'a check plan names no row: record, row and findings go with a verdict'
  if (!record.startsWith('/')) return 'record is the absolute path of the dispatch record, with row'
  if (!(typeof row === 'number' && Number.isInteger(row) && row >= 1)) return 'row is the id of the dispatch record\'s row, with record'
  if (findings !== '' && !findings.startsWith('/')) return 'findings is the absolute path of the review session\'s findings index'
  return { record, row, findings }
}

// A verdict's few words: its line's first, or what it decided counted.
export function wordsOf(input: Record<string, unknown>): string {
  const count = (raw: unknown): number => (Array.isArray(raw) ? raw.length : 0)
  const verdict = text(input['verdict'])
  const said = verdict === ACCEPTANCE.result ? '' : text(input['detail']).split('\n')[0]?.trim() ?? ''
  const words = said || (verdict === ACCEPTANCE.result ? `${count(input['set_asides'])} point(s) set aside`
    : verdict === 'fail' ? `${count(input['kept'])} kept` : 'clean')
  return words.slice(0, WORDS_MAX).trimEnd()
}

// Level 1 written into the row, at the checkout's head: the record script's line, or why not.
async function writeRow($: Held, input: Record<string, unknown>, target: RowTarget): Promise<{ line: string; ok: boolean }> {
  const dir = text(input['dir'])
  const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { ...(dir ? { cwd: dir } : {}), timeoutMs: ROW_RUN_MS })
  const sha = head.stdout.trim()
  if (head.exitCode !== 0 || sha === '') return { line: `no head read in ${dir || 'the session\'s directory'}: ${head.stderr.trim()}`, ok: false }
  // What the record script reads of the session's environment: its owner, its registry, its state.
  const read: Record<string, string | undefined> = {
    PATH: await $.env.get('PATH'),
    HOME: await $.env.get('HOME'),
    CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'),
    ORCHESTRATOR_STATE_DIR: await $.env.get('ORCHESTRATOR_STATE_DIR'),
    ORCHESTRATOR_JOURNAL_DIR: await $.env.get('ORCHESTRATOR_JOURNAL_DIR'),
  }
  const env: Record<string, string> = { CLAUDE_CODE_SESSION_ID: await $.session.id() }
  for (const [key, value] of Object.entries(read)) if (value !== undefined) env[key] = value
  const argv = [
    'bash', `${$.plugin.root}/skills/orchestrator/scripts/dispatch-record.sh`, 'verdict', target.record, String(target.row),
    '--head', sha, '--result', text(input['verdict']), '--words', wordsOf(input), ...(target.findings ? ['--findings', target.findings] : []),
    // This verdict is the review of that head: the row needs no `review` first.
    '--reviewed',
  ]
  const run = await $.process.run(argv, { env, timeoutMs: ROW_RUN_MS })
  // A warning of a write that succeeded (a row no review touched) rides the line.
  const said = [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join('\n')
  return run.exitCode === 0 ? { line: said, ok: true } : { line: said || `dispatch-record.sh exited ${run.exitCode}`, ok: false }
}

// The record tool's call for a verdict, or the line that says what the input lacks.
export function verdictCall(input: Record<string, unknown>): { tool: string } & Record<string, unknown> | string {
  const pr = Number(String(input['pr'] ?? '').replace('#', ''))
  if (!Number.isInteger(pr) || pr < 1) return 'pr is the pull request number'
  const repo = text(input['repo']) ? { repo: text(input['repo']) } : {}
  const plan = input['plan']
  if (plan !== undefined) {
    if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) return 'plan is {"e2e": …, "norms": …, "review": …}'
    return input['verdict'] === undefined ? { tool: RECORD_TOOL, pr, ...repo, plan } : 'a plan goes in place of the verdict'
  }
  const verdict = text(input['verdict'])
  if (!VERDICTS.some((v) => v === verdict)) return 'verdict is pass, fail or ' + ACCEPTANCE.result
  const setAsides = itemsOf(input['set_asides'], 'set_asides')
  const kept = itemsOf(input['kept'], 'kept')
  if (typeof setAsides === 'string') return setAsides
  if (typeof kept === 'string') return kept
  if (verdict === ACCEPTANCE.result && (setAsides.length === 0 || setAsides.some((s) => !s.reason))) {
    return 'set_asides lists each point set aside with its one-line reason: [{"point": "...", "reason": "..."}]'
  }
  if (verdict === 'pass' && input['set_asides'] !== undefined) return 'set_asides goes with the verdict ' + ACCEPTANCE.result + ' or fail only'
  if (setAsides.some((s) => !s.reason)) return 'each point set aside carries its one-line reason'
  if (verdict !== 'fail' && input['kept'] !== undefined) return 'kept goes with the verdict fail only: the findings its correction round fixes'
  const set = setAsides.length > 0 ? acceptanceDetail(setAsides) : ''
  const detail = verdict === ACCEPTANCE.result ? set : [text(input['detail']), set].filter(Boolean).join('; ').slice(0, DETAIL_MAX)
  const dir = text(input['dir']) ? { dir: text(input['dir']) } : {}
  return { tool: RECORD_TOOL, pr, ...repo, ...dir, kind: ACCEPTANCE.kind, result: verdict, detail }
}

// A finding the verdict names: its point and reason for the record's line, and what the audit trail
// keeps of it — its file, line and severity when the orchestrator gives them, never its words.
type Finding = { point: string; reason: string; file: string | null; line: number | null; severity: FindingSeverity | null }

// The findings of `kept` or `set_asides`, none when absent, or the line that says what is wrong.
function itemsOf(raw: unknown, name: string): Finding[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return `${name} is a list: [{"point": "...", ...}]`
  const items: Finding[] = []
  for (const item of raw) {
    const fields = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const point = text(fields['point'])
    if (!point) return `each item of ${name} names its point`
    const { file, line, severity } = fields
    if (file !== undefined && typeof file !== 'string') return `file is the finding's repository path`
    if (line !== undefined && !(typeof line === 'number' && Number.isInteger(line) && line >= 1)) return 'line is a line number, from 1'
    if (severity !== undefined && !AUDIT_CONTRACT.finding_severities.some((s) => s === severity)) return `severity is ${AUDIT_CONTRACT.finding_severities.join(', ')}`
    items.push({ point, reason: text(fields['reason']), file: text(file) || null, line: typeof line === 'number' ? line : null, severity: (severity as FindingSeverity | undefined) ?? null })
  }
  return items
}

// An acceptance over a findings index: one set-aside of severity important per `[important]` line
// of the index, each with a reason of its own, or the line that says what is missing.
export function importantUncovered(index: string, input: Record<string, unknown>): string | null {
  const important = index.split('\n').filter((l) => /^\s*\d+\.\s*\[important\]/i.test(l)).length
  if (important === 0) return null
  const items = itemsOf(input['set_asides'], 'set_asides')
  const given = typeof items === 'string' ? [] : items.filter((s) => s.severity === 'important')
  const reasons = new Set(given.map((s) => s.reason.toLowerCase()))
  if (given.length >= important && reasons.size === given.length) return null
  return `the findings index holds ${important} important finding(s): accepted sets each aside in its own set_asides entry, severity "important", with its own reason against the design (${given.length} given, ${reasons.size} distinct reason(s))`
}

// The orchestrator's decision on each finding a valid verdict names: kept, then set aside.
export function findingsOf(input: Record<string, unknown>): { decision: Decision; file: string | null; line: number | null; severity: FindingSeverity | null }[] {
  const decided = (raw: unknown, decision: Decision) => {
    const items = itemsOf(raw, '')
    return typeof items === 'string' ? [] : items.map(({ file, line, severity }) => ({ decision, file, line, severity }))
  }
  return [...decided(input['kept'], 'kept'), ...decided(input['set_asides'], 'set-aside')]
}

// A finding of the review index (`<n>. [severity] file:line — title — <id> — <detail>`) that names its id.
const INDEX_LINE = /^\s*\d+\.\s*\[(critical|important|minor)\]\s+`?([^\s`:]+):(\d+)/i

type Decided = ReturnType<typeof findingsOf>[number]

// Each decision with the id and lens of the index line it names, matched by file and line, then by
// severity when several share them; each line names one decision. A decision with no file and line,
// or none of the index's, keeps them unknown.
export function withIndexIds(findings: readonly Decided[], index: string | null): (Decided & { finding_id: string | null; lens: string | null })[] {
  const lines = (index ?? '').split('\n').flatMap(line => {
    const m = INDEX_LINE.exec(line)
    const id = parseFindingId(line)
    return m === null || id === undefined ? [] : [{ severity: (m[1] ?? '').toLowerCase(), file: m[2] ?? '', line: Number(m[3]), ...id }]
  })
  const taken = new Set<number>()
  return findings.map(finding => {
    const same = lines.map((l, at) => ({ l, at })).filter(({ l, at }) => !taken.has(at) && l.file === finding.file && l.line === finding.line)
    const match = same.find(({ l }) => l.severity === finding.severity) ?? same[0]
    if (match === undefined) return { ...finding, finding_id: null, lens: null }
    taken.add(match.at)
    return { ...finding, finding_id: match.l.id, lens: match.l.lens }
  })
}

// The record tool's answer as the tool's own: its text, an error when it refused or failed.
function answerOf(written: unknown): { result: string; isError?: boolean } {
  const w = (typeof written === 'object' && written !== null ? written : {}) as { result?: unknown; deny?: unknown; isError?: unknown }
  if (typeof w.deny === 'string') return { result: w.deny, isError: true }
  const text = typeof w.result === 'string' ? w.result : JSON.stringify(w.result ?? null)
  return w.isError === true ? { result: text, isError: true } : { result: text }
}

export function register(on: On<Held>): void {
  on('session.start', {}, async ($, e, next) => {
    try {
      await $.tool.register({
        name: REVIEW_TOOL,
        isDeferred: false,
        description: 'Records the review round\'s verdict at a pull request\'s head for the github ready gate: pass, fail, or accepted with each point set aside and its reason. From a clean checkout at the head; in an orchestrator session, or a pass or a fail in a review session (`Agent: review <subject>`). A verdict counts a round on the row it names (record and row), else on the row whose label names the pull request. In place of the verdict, plan sets the proofs the pull request owes.',
        inputSchema: {
          type: 'object',
          properties: {
            pr: { type: 'integer', description: 'the pull request number' },
            repo: { type: 'string', description: 'owner/name; omitted, the checkout\'s origin' },
            dir: { type: 'string', description: 'absolute path of a clean checkout at the head; omitted, the session\'s directory' },
            verdict: { type: 'string', enum: [...VERDICTS] },
            set_asides: {
              type: 'array',
              description: 'accepted, or fail: each point set aside in a few words, its reason in a few words',
              items: { type: 'object', properties: { ...FINDING, reason: { type: 'string' } }, required: ['point', 'reason'] },
            },
            kept: {
              type: 'array',
              description: 'fail: each finding the correction round fixes',
              items: { type: 'object', properties: FINDING, required: ['point'] },
            },
            detail: { type: 'string', description: 'pass or fail: one line on what was reviewed or found' },
            record: { type: 'string', description: 'with row: the dispatch record\'s absolute path; the verdict, a few words and findings go into that row' },
            row: { type: 'integer', description: 'with record: the row\'s id' },
            findings: { type: 'string', description: 'with record: the absolute path of the review session\'s findings index' },
            plan: {
              type: 'object',
              description: 'in place of the verdict: each "<need>" or "<need>: <reason>"; a required review "required: max <n>", its rounds from 1 to ' + REVIEW_ROUNDS.cap + '; the review is never skipped, "one-pass" for a mechanical pull request is one round with no correction round',
              properties: {
                e2e: { type: 'string', description: needsOf('e2e') },
                norms: { type: 'string', description: needsOf('norms') },
                review: { type: 'string', description: needsOf('review') },
              },
            },
          },
          required: ['pr'],
        },
      })
    } catch (err) {
      await logLine($, 'review', `review tool not registered: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'review', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${REVIEW_TOOL}` }, async ($, e) => {
    if (e.agentId) return { result: "only the session's main thread records a review verdict", isError: true }
    const call = verdictCall(e)
    if (typeof call === 'string') return { result: call, isError: true }
    const target = rowTarget(e)
    if (typeof target === 'string') return { result: target, isError: true }
    const session = await $.session.id()
    const orchestrator = await isOrchestratorSession($, session)
    if (!orchestrator && !(await mayReview($, e, target, session))) return { result: NOT_ORCHESTRATOR, isError: true }
    if (target !== null && target.findings !== '' && text(e['verdict']) === ACCEPTANCE.result) {
      const index = await $.fs.read(target.findings).catch(() => null)
      if (index === null) await logLine($, 'review', `findings index not read: ${target.findings}`)
      const missing = index === null ? null : importantUncovered(index, e)
      if (missing !== null) return { result: missing, isError: true }
    }
    const written = answerOf(await $.tool.call(call))
    // A verdict is a review round: the row of the pull request counts it, and the answer says which row, or that none matched.
    if (written.isError === true || !('result' in call)) return written
    await wakeReconciler($)
    // github's line repeats the detail the orchestrator just wrote, in the two places its gate puts
    // it (« orchestrator (<detail>) », « by orchestrator, <detail> »): named there, never carried back.
    const sent = text(call['detail'])
    const answer = sent ? { result: written.result.split(`orchestrator (${sent})`).join(`orchestrator (${ECHOED_DETAIL})`)
      .split(`orchestrator, ${sent}`).join(`orchestrator, ${ECHOED_DETAIL}`) } : written
    // A review session's verdict counts no round: no dispatch record is its own.
    if (!orchestrator) return { result: answerLines(answer.result, '', null) }
    const counted = await countRound($, { pr: Number(call['pr']), repo: text(call['repo']), ...(typeof call['dir'] === 'string' ? { dir: call['dir'] } : {}), ...(typeof e['cwd'] === 'string' ? { cwd: e['cwd'] } : {}), ...(target === null ? {} : { at: { record: target.record, row: target.row } }) })
    if (target === null) return { result: answerLines(answer.result, counted, null) }
    // Level 1 after the count, so its rounds include this one. The gate's record is written: a row that
    // fails is a warning on a success, never an error, so the audit trail keeps the verdict
    // (audit-events.ts answerText) and nobody writes the record twice.
    const row = await writeRow($, e, target).catch((err: unknown) => ({ line: messageOf(err), ok: false }))
    if (row.ok) return { result: answerLines(answer.result, counted, row.line) }
    return { result: `${answerLines(answer.result, counted, null)}\nWARNING: the gate's record is written, the row is not: write it with dispatch-record.sh verdict, never this tool again: ${row.line}` }
  }).catch(async ($, e, next) => {
    await logLine($, 'review', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the review verdict could not be recorded; the log says why', isError: true }
  })
}
