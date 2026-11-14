// hooks/ledger.ts
// The pull request ledger line written where the pull request is born (core's pr-ledger.ts,
// docs/contracts.md): a pull request opened through the github tool (`pr-create`) or by a Bash
// `gh pr create`, in any repository, takes its line in the dispatch record of the orchestration the
// creating session belongs to: the session's own when it is an orchestrator's, its orchestrator's
// when it is an agent's (orchestratorOn, the one mapping the relay uses). No model, no refusal, no
// gate: the call has already succeeded, so a write that fails is one log line and the answer goes on.
import { ledgerLineOf, ledgerLines, withLine } from '../core/pr-ledger.ts'
import { simpleCommands, unwrapPath } from '../core/shell.ts'
import { updateOver } from '../core/store-io.ts'
import { answerText } from './audit-events.ts'
import { isDegradedPass, orchestrationOf, ownerOf, withDeadline } from './stop-gate.ts'
import { orchestratorOn, parseSessionRow, REFERENCED, sessionKey, storeOf } from './supervision.ts'
import { logLine, stateDir, storeIo } from './module-io.ts'

// The bound of one write: the lookups of the mapping and the record's lock.
export const LEDGER_BOUND_MS = 10_000

const PULL_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)/g
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
  const last = [...(htmlUrlOf(answer) ?? answer).matchAll(PULL_URL)].at(-1)
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

const safe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '_')

async function readOr($: any, path: string): Promise<string> {
  return String(await $.fs.read(path).catch(() => ''))
}

// The orchestration the creating session belongs to: its session and its name. An orchestrator's own,
// an agent's orchestrator found as the relay finds it; null for any other session.
async function orchestrationOfSession($: any, sessionId: string, row: { role: string | null; name: string | null; tty?: string | null }): Promise<{ id: string; name: string | null } | null> {
  if (row.role === 'orchestrator') return { id: sessionId, name: row.name }
  if (row.role !== 'agent' || !row.name) return null
  const to = await orchestratorOn($, row.tty ?? null, row.name, 'ledger')
  if (to === null) return null
  const store = await storeOf($)
  let id: string | null = typeof to === 'string' ? null : to.sessionId
  if (typeof to === 'string') {
    for (const entry of await $.fs.list(`${store}/sessions`).catch(() => []) as { name: string; kind: string }[]) {
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
async function ownRecords($: any, state: string, id: string, name: string | null): Promise<string[]> {
  const own = orchestrationOf(name)
  if (own === null) return []
  const found: string[] = []
  for (const path of (await readOr($, `${state}/records/${safe(id)}`)).split('\n').map(line => line.trim()).filter(Boolean)) {
    if (ownerOf(await readOr($, `${path}.owner`)) === own && await $.fs.exists(path).catch(() => false)) found.push(path)
  }
  return found
}

// The line of the pull request, written once into the first record the orchestration owns; none when
// any of its records already holds one.
export async function writeLine($: any, pr: { repo: string; pr: number }, now: Date, signal: AbortSignal): Promise<void> {
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

// The call goes through; its answer is read for a creation and the line written within the bound.
async function afterCall($: any, e: any, next: (e: any) => any, now: () => Date, bound: number): Promise<unknown> {
  const result = await next(e)
  const created = createdPr(e, result)
  if (created === null) return result
  try {
    const done = await withDeadline(signal => writeLine($, created, now(), signal), bound)
    if (isDegradedPass(done)) await logLine($, 'ledger', `the line of ${created.repo}#${created.pr} did not finish within ${bound} ms`)
  } catch (err) {
    await logLine($, 'ledger', `the line of ${created.repo}#${created.pr} not written: ${(err as Error).message}`)
  }
  return result
}

async function net($: any, e: any, next: any): Promise<unknown> {
  await logLine($, 'ledger', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
  return next(e)
}

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }, now: () => Date = () => new Date(), bound: number = LEDGER_BOUND_MS) {
  on('tool.call', { tool: 'mcp__github__gh' }, async ($: any, e: any, next: (e: any) => any) => afterCall($, e, next, now, bound)).catch(net)
  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: (e: any) => any) => afterCall($, e, next, now, bound)).catch(net)
}
