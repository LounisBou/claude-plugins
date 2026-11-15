// hooks/ledger.ts
// The pull request ledger line written where the pull request is born (core's pr-ledger.ts,
// docs/contracts.md): a pull request opened through the github tool (`pr-create`) or by a Bash
// `gh pr create`, in any repository, takes its line in the dispatch record of the orchestration the
// creating session belongs to: the session's own when it is an orchestrator's, its orchestrator's
// when it is an agent's (orchestratorOn, the one mapping the relay uses). No model, no refusal, no
// gate: the call has already succeeded, so a write that fails is one log line and the answer goes on.
// A pull request an orchestrator merges through the github tool (`pr-merge`) is read against the
// open rows of its own records: those whose blocker or note names it wait on it, and the answer
// carries one line naming them, so the orchestrator relays the merge to their agents.
import { prRefsOf } from '../core/learning.ts'
import { isLedgerMarked, ledgerLineOf, ledgerLines, withLine } from '../core/pr-ledger.ts'
import { simpleCommands, unwrapPath } from '../core/shell.ts'
import { updateOver } from '../core/store-io.ts'
import { answerText, PULL_URL } from './audit-events.ts'
import { isDegradedPass, orchestrationOf, ownerOf, withDeadline } from './stop-gate.ts'
import { orchestratorOn, parseSessionRow, REFERENCED, sessionKey, storeOf } from './supervision.ts'
import { messageOf, type CatchHook, type Events, type FsEntry, type Host, type Next, type On } from './host.ts'
import { logLine, stateDir, storeIo } from './module-io.ts'
import { readOr, registered } from './unattended.ts'

// The nouns a write holds.
type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'session' | 'clock'>
type Call = Events['tool.call']

// The bound of one write: the lookups of the mapping and the record's lock.
export const LEDGER_BOUND_MS = 10_000

// Whether the command line runs `gh pr create`, read as the shell reads it (core's shell reader: quotes,
// heredocs, assignments, `time`, `rtk`, `sudo`, `bash -c`): the words after `gh`, past its repository
// option wherever it stands, are `pr create`. A line the reader cannot read creates nothing.
function runsPrCreate(line: string): boolean {
  try {
    return simpleCommands(line).some(command => {
      const argv = unwrapPath(command).argv
      if (!/^(.*\/)?gh$/.test(argv[0] ?? '')) return false
      const named: string[] = []
      for (let k = 1; k < argv.length && named.length < 2; k++) {
        const word = argv[k] ?? ''
        if (word === '-R' || word === '--repo') k++
        else if (!word.startsWith('-R') && !word.startsWith('--repo=')) named.push(word)
      }
      return named[0] === 'pr' && named[1] === 'create'
    })
  } catch {
    return false
  }
}

// The pull request a creation opened, from the call and its answer; null for any other call, a failed
// one, or an answer that names none. A JSON answer is read at its `html_url`, a text one at its last address, the one `gh` prints last.
export function createdPr(e: Readonly<Record<string, unknown>>, result: unknown): { repo: string; pr: number } | null {
  const opens = e['tool'] === 'mcp__github__gh' ? e['command'] === 'pr-create'
    : e['tool'] === 'Bash' && typeof e['command'] === 'string' && runsPrCreate(e['command'])
  const answer = opens ? answerText(result) : null
  if (answer === null) return null
  const last = [...(htmlUrlOf(answer) ?? answer).matchAll(new RegExp(PULL_URL, 'g'))].at(-1)
  return last?.[1] === undefined || last[2] === undefined ? null : { repo: last[1], pr: Number(last[2]) }
}

// The `html_url` of a JSON answer (the forge's pull request), so a body that names other pull requests is never read for one.
function htmlUrlOf(answer: string): string | null {
  try {
    const url = (JSON.parse(answer) as { html_url?: unknown } | null)?.html_url
    return typeof url === 'string' ? url : null
  } catch {
    return null
  }
}

// The orchestration the creating session belongs to: its session and its name. An orchestrator's own,
// an agent's orchestrator found as the relay finds it; null for any other session.
async function orchestrationOfSession($: Held, sessionId: string, row: { role: string | null; name: string | null; tty?: string | null }): Promise<{ id: string; name: string | null } | null> {
  if (row.role === 'orchestrator') return { id: sessionId, name: row.name }
  if (row.role !== 'agent' || !row.name) return null
  const to = await orchestratorOn($, row.tty ?? null, row.name, 'ledger')
  if (to === null) return null
  const store = await storeOf($)
  let id: string | null = typeof to === 'string' ? null : to.sessionId
  if (typeof to === 'string') {
    for (const entry of await $.fs.list(`${store}/sessions`).catch((): FsEntry[] => [])) {
      if (entry.kind !== 'file' || entry.name.includes('.tmp-')) continue
      const held = parseSessionRow(await readOr($, `${store}/sessions/${entry.name}`))
      if (held?.role === 'orchestrator' && held.name === to) id = entry.name
    }
  }
  if (id === null) return null
  // The session the launch record names may be any live one (a coordinator's): only an orchestrator's is an orchestration.
  const held = parseSessionRow(await readOr($, `${store}/${sessionKey(id)}`))
  return held?.role === 'orchestrator' ? { id, name: held.name } : null
}

// The records the orchestration owns that its session registered, each readable.
export async function ownRecords($: Host<'fs'>, state: string, id: string, name: string | null): Promise<string[]> {
  const own = orchestrationOf(name)
  if (own === null) return []
  const found: string[] = []
  for (const path of await registered($, state, id)) {
    if (ownerOf(await readOr($, `${path}.owner`)) === own && await $.fs.exists(path).catch(() => false)) found.push(path)
  }
  return found
}

// The line of the pull request, written once into the first record the orchestration owns; none when
// any of its records already holds one.
export async function writeLine($: Held, pr: { repo: string; pr: number }, now: Date, signal: AbortSignal): Promise<void> {
  const sessionId = await $.session.id()
  const row = parseSessionRow(await readOr($, `${await storeOf($)}/${sessionKey(sessionId)}`))
  if (row === null) return
  const belongs = await orchestrationOfSession($, sessionId, row)
  if (belongs === null) return
  const records = await ownRecords($, await stateDir($), belongs.id, belongs.name)
  const held = (text: string) => ledgerLines(text).some(line => line.repo === pr.repo && line.pr === pr.pr)
  const first = records[0]
  if (first === undefined) return
  for (const path of records) if (held(await readOr($, path))) return
  const agent = (row.name ?? '').replace(REFERENCED, '').trim()
  if (agent === '' || signal.aborted) return
  await updateOver(storeIo($), first, current =>
    current === undefined || held(current) ? undefined : withLine(current, ledgerLineOf({ repo: pr.repo, pr: pr.pr, status: 'working', agent }, now)))
}

// The pull request a merge through the github tool merged: its number, and its repository when the
// call names one; null for any other call or a merge that did not go through.
export function mergedPr(e: Readonly<Record<string, unknown>>, result: unknown): { repo: string | null; pr: number } | null {
  if (e['tool'] !== 'mcp__github__gh' || e['command'] !== 'pr-merge' || answerText(result) === null) return null
  const args = typeof e['args'] === 'object' && e['args'] !== null ? e['args'] as Record<string, unknown> : {}
  const pr = Number(String(args['pr'] ?? '').replace('#', ''))
  const repo = typeof e['repo'] === 'string' && e['repo'].includes('/') ? e['repo'].trim().toLowerCase() : null
  return Number.isInteger(pr) && pr >= 1 ? { repo, pr } : null
}

// Whether a reference (`name#7`, `owner/name#7`) names the merged pull request; with no repository
// known, its number alone decides.
function namesMerged(ref: string, merged: { repo: string | null; pr: number }): boolean {
  const [where = '', number = ''] = ref.toLowerCase().split('#')
  if (Number(number) !== merged.pr) return false
  if (merged.repo === null) return true
  return where.includes('/') ? where === merged.repo : where === merged.repo.split('/')[1]
}

// The open rows of a record's text that wait on the merged pull request: their blocker or their
// note names it. A row the operator deferred has no agent to tell.
export function waitingRows(text: string, merged: { repo: string | null; pr: number }): { id: number; label: string; agent: string | null }[] {
  const found: { id: number; label: string; agent: string | null }[] = []
  for (const line of text.split('\n')) {
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row !== 'object' || row === null || isLedgerMarked(row)) continue
    const { id, label, state, blocker, note, deferred } = row as Record<string, unknown>
    if (typeof id !== 'number' || state !== 'open' || (typeof deferred === 'string' && deferred.trim() !== '')) continue
    const said = [blocker, note].filter((part): part is string => typeof part === 'string').join(' ')
    if (!prRefsOf(said).some(ref => namesMerged(ref, merged))) continue
    const agent = typeof note === 'string' ? /\bAgent: [^,;()«»]+/.exec(note)?.[0].trim() ?? null : null
    found.push({ id, label: typeof label === 'string' ? label : '', agent })
  }
  return found
}

// The line the merge's answer carries, or null when no open row waits on it.
export function mergeRelayLine(merged: { repo: string | null; pr: number }, rows: readonly { id: number; label: string; agent: string | null }[]): string | null {
  if (rows.length === 0) return null
  const named = rows.map(row => `row ${row.id}${row.label === '' ? '' : ` « ${row.label} »`}${row.agent === null ? '' : ` (${row.agent})`}`)
  return `[module] ${merged.repo ?? ''}#${merged.pr} merged; open rows waiting on it: ${named.join(', ')}. Tell each one's agent now.`
}

// The open rows of the orchestrator's own records that wait on the merged pull request; none in a
// session that is no orchestrator's. A merge that names no repository takes the one the records'
// ledger holds for that number, when only one does.
async function waitingOnMerge($: Held, merged: { repo: string | null; pr: number }): Promise<{ merged: { repo: string | null; pr: number }; rows: { id: number; label: string; agent: string | null }[] }> {
  const sessionId = await $.session.id()
  const row = parseSessionRow(await readOr($, `${await storeOf($)}/${sessionKey(sessionId)}`))
  if (row?.role !== 'orchestrator') return { merged, rows: [] }
  const texts: string[] = []
  for (const path of await ownRecords($, await stateDir($), sessionId, row.name)) texts.push(await readOr($, path))
  const repos = new Set(texts.flatMap(text => ledgerLines(text)).filter(line => line.pr === merged.pr).map(line => line.repo.toLowerCase()))
  const known = merged.repo === null && repos.size === 1 ? { repo: [...repos][0] ?? null, pr: merged.pr } : merged
  return { merged: known, rows: texts.flatMap(text => waitingRows(text, known)) }
}

// The answer with one more line: after a text, or as one more text part.
function withRelay(result: unknown, line: string): unknown {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result
  const r = result as Record<string, unknown>
  if (typeof r['result'] === 'string') return { ...r, result: `${r['result']}\n${line}` }
  if (Array.isArray(r['result'])) return { ...r, result: [...r['result'], { type: 'text', text: line }] }
  return result
}

// A merge read against the rows that wait on it, within the bound; the answer as it came when none does.
async function afterMerge($: Held, merged: { repo: string | null; pr: number }, result: unknown, bound: number): Promise<unknown> {
  try {
    const found = await withDeadline(() => waitingOnMerge($, merged), bound)
    if (isDegradedPass(found)) {
      await logLine($, 'ledger', `the rows waiting on #${merged.pr} were not read within ${bound} ms`)
      return result
    }
    const line = mergeRelayLine(found.merged, found.rows)
    return line === null ? result : withRelay(result, line)
  } catch (err) {
    await logLine($, 'ledger', `the rows waiting on #${merged.pr} not read: ${messageOf(err)}`)
    return result
  }
}

// The call goes through; its answer is read for a creation and the line written within the bound,
// or for a merge and the rows waiting on it named.
async function afterCall($: Held, e: Call, next: Next<Call>, now: () => Date, bound: number): Promise<unknown> {
  const result = await next(e)
  const merged = mergedPr(e, result)
  if (merged !== null) return afterMerge($, merged, result, bound)
  const created = createdPr(e, result)
  if (created === null) return result
  try {
    const done = await withDeadline(signal => writeLine($, created, now(), signal), bound)
    if (isDegradedPass(done)) await logLine($, 'ledger', `the line of ${created.repo}#${created.pr} did not finish within ${bound} ms`)
  } catch (err) {
    await logLine($, 'ledger', `the line of ${created.repo}#${created.pr} not written: ${messageOf(err)}`)
  }
  return result
}

const net: CatchHook<Held, Call> = async ($, e, next) => {
  await logLine($, 'ledger', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
  return next(e)
}

export function register(on: On<Held>, now: () => Date = () => new Date(), bound: number = LEDGER_BOUND_MS): void {
  on('tool.call', { tool: 'mcp__github__gh' }, async ($, e, next) => afterCall($, e, next, now, bound)).catch(net)
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => afterCall($, e, next, now, bound)).catch(net)
}
