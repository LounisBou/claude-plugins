// hooks/review-rounds.ts
// The review verdict counts its own round: once the verdict is recorded, the dispatch-record row of
// the pull request gets `rounds` raised by one, as `dispatch-record.sh round` does, so the first-pass
// rate (rows closed in one round) is read from the record and not from what was remembered to run.
// No refusal: a missing row, an unknown repository or a failed write is said in the answer line this
// returns, and the verdict stands.
import { prRefsOf } from '../core/learning.ts'
import { updateOver } from '../core/store-io.ts'
import { messageOf, type Host } from './host.ts'
import { ownRecords } from './ledger.ts'
import { dataDir, logLine, storeIo } from './module-io.ts'
import { parseSessionRow, sessionKey, storeOf } from './supervision.ts'
import { readOr } from './unattended.ts'

type Row = Record<string, unknown>

// The nouns the count holds.
type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'session' | 'clock'>

const PROCESS_BOUND_MS = 5000

// The record's lines as rows: a line that is no JSON object with a numeric id, or a ledger line, is no row.
function rowsOf(text: string): { index: number; row: Row }[] {
  const found: { index: number; row: Row }[] = []
  text.split('\n').forEach((raw, index) => {
    try {
      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return
      const row = value as Row
      if (typeof row['id'] === 'number' && row['ledger'] === undefined) found.push({ index, row })
    } catch {
      /* a blank or torn line */
    }
  })
  return found
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

// The pull request's row names it by its label or its verdict, `owner/name#7` or `name#7`.
// A reference is a whole token; the repository reads whatever its case, as GitHub does.
function names(row: Row, repo: string, pr: number): boolean {
  const name = repo.split('/').at(-1) ?? repo
  const wanted = [`${repo}#${pr}`, `${name}#${pr}`].map(ref => ref.toLowerCase())
  return prRefsOf(`${textOf(row['label'])} ${textOf(row['verdict'])}`).some(ref => wanted.includes(ref.toLowerCase()))
}

// What git says in `cwd`: one trimmed line, or null.
async function git($: Host<'process'>, cwd: string | undefined, argv: readonly string[]): Promise<string | null> {
  if (cwd === undefined) return null
  const done = await $.process.run(['git', ...argv], { cwd, timeoutMs: PROCESS_BOUND_MS }).catch(() => null)
  const line = done !== null && done.exitCode === 0 ? String(done.stdout ?? '').trim() : ''
  return line === '' ? null : line
}

/** The repository `owner/name` the verdict is about: the one given, else the checkout's origin. */
export async function repositoryOf($: Host<'process'>, given: string, cwd: string | undefined): Promise<string | null> {
  if (given !== '') return given
  return /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec((await git($, cwd, ['remote', 'get-url', 'origin'])) ?? '')?.[1] ?? null
}

// Raises `rounds` of the row `id` of `path`: the new count, or 0 when the row is gone.
async function raise($: Held, path: string, id: number): Promise<number> {
  let raised = 0
  await updateOver(storeIo($), path, current => {
    const lines = (current ?? '').split('\n')
    const target = rowsOf(current ?? '').find(r => r.row['id'] === id)
    if (target === undefined) return undefined
    raised = (typeof target.row['rounds'] === 'number' ? target.row['rounds'] : 0) + 1
    lines[target.index] = JSON.stringify({ ...target.row, rounds: raised })
    return lines.join('\n')
  })
  return raised
}

/**
 * Raises the `rounds` of a row, and answers the line the verdict's answer carries: which row was
 * raised, or why none was. The row the call names (`at`: its record and id) is the row, whatever the
 * labels say; one the record does not hold falls to the search; a write that fails is said, never moved to another row. Without one, the row of `pr` is
 * found in the records of this orchestration by the reference its label or verdict names; open rows
 * come before closed ones and two rows left naming it are not guessed between. The verdict is the
 * one writer of `rounds` for a review round: `dispatch-record.sh review` records the head and
 * raises nothing.
 */
export async function countRound($: Held, input: { pr: number; repo: string; dir?: string; cwd?: string; at?: { record: string; row: number } }): Promise<string> {
  try {
    if (input.at !== undefined) {
      const { record, row: id } = input.at
      // A row the record holds is raised or its failure said, never swapped for another row; a row it does not hold falls to the search.
      if (rowsOf(await readOr($, record)).some(r => r.row['id'] === id)) {
        const raisedNamed = await raise($, record, id)
        if (raisedNamed > 0) return `rounds: row ${id} of ${record} raised to ${raisedNamed}`
      }
    }
    const cwd = input.dir ?? input.cwd
    const repo = await repositoryOf($, input.repo, cwd)
    if (repo === null) return `rounds: none raised, the repository of the pull request is not known: give repo`
    const ref = `${repo}#${input.pr}`
    const sessionId = String(await $.session.id())
    const session = parseSessionRow(await readOr($, `${await storeOf($)}/${sessionKey(sessionId)}`))
    const found: { path: string; id: number; open: boolean }[] = []
    for (const path of await ownRecords($, await dataDir($), sessionId, session?.name ?? null)) {
      for (const { row } of rowsOf(await readOr($, path))) {
        const id = row['id']
        if (typeof id !== 'number' || !names(row, repo, input.pr)) continue
        found.push({ path, id, open: row['state'] === 'open' })
      }
    }
    const open = found.filter(row => row.open)
    const matched = open.length > 0 ? open : found
    if (matched.length === 0) return `rounds: no dispatch-record row names ${ref}, none raised: open its row with a label naming ${ref}`
    const [row, ...others] = matched
    if (row === undefined || others.length > 0) return `rounds: none raised, rows ${matched.map(m => m.id).join(', ')} all name ${ref}`
    const raised = await raise($, row.path, row.id)
    return raised === 0 ? `rounds: none raised, row ${row.id} is gone from ${row.path}` : `rounds: row ${row.id} of ${row.path} raised to ${raised}`
  } catch (err) {
    await logLine($, 'review', `rounds of ${input.repo}#${input.pr} not counted: ${messageOf(err)}`).catch(() => undefined)
    return `rounds: none raised, ${messageOf(err)}`
  }
}
