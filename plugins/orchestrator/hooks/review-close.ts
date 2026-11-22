// hooks/review-close.ts
// The close of a review session once its round's verdict is recorded. A round's review session is
// found on facts, as an implementer's row is (row-owner.ts): the launch script of an agent names its
// brief, and the review brief (`review-brief.sh`) names the project, the pull request and the head
// it reads. The verdict (review.ts) names the same three: the sessions whose brief reads that round
// are owed a close, kept here for the module's tick (ledger.ts prWake), which closes each one the
// way it closes an agent at Ready, once its host is idle (never mid-turn) and its pin clean. The
// next round of a pull request is a fresh session on a fresh brief, so the closed one is never needed again.
import { parseSessionRow, REFERENCED, storeOf } from './supervision.ts'
import { briefOfLaunch, newestLaunch } from './row-owner.ts'
import { messageOf, type FsEntry, type Host } from './host.ts'
import { logLine, stateDir } from './module-io.ts'
import { isRound, readingOf, type Reading, type Round } from './review-reading.ts'

type Held = Host<'plugin' | 'env' | 'fs' | 'process'>

/** A review session whose close is owed: it is the one of a round whose verdict is recorded; its cost goes on `cost`, the row the verdict counted. */
export type Owed = { session: string; agent: string; round: string; at: number; cost?: { record: string; row: number } | undefined }

/** How long a close stays owed: a session busy or gone for longer than this is let be. */
export const OWED_MS = 60 * 60 * 1000

// What the module owes, by session of the orchestrator then agent: held in memory as the merges the session made itself are (ledger.ts).
const owed = new Map<string, Owed>()

const keyOf = (session: string, agent: string, round: string): string => `${session} ${agent} ${round}`

/** The round as a line names it: `owner/name#7 0123456`. */
export const roundText = (round: Round): string => `${round.repo}#${round.pr} ${round.head.slice(0, 7)}`

/** The closes owed by the orchestrator session `session`. */
export const owedOf = (session: string): Owed[] => [...owed.values()].filter(one => one.session === session)

/** Whether any close is owed by the session: its tick keeps running while one is. */
export const hasOwed = (session: string): boolean => owedOf(session).length > 0

/** A close done or given up. */
export const settleOwed = (one: Owed): void => void owed.delete(keyOf(one.session, one.agent, one.round))

async function readOf($: Held, path: string): Promise<string> {
  try {
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

async function listOf($: Held, dir: string): Promise<FsEntry[]> {
  try {
    return await $.fs.list(dir)
  } catch {
    return []
  }
}

/** The agents (names without their reference) whose launch brief is a review brief of the pull request, each with what it reads. */
export async function reviewersOf($: Held, pr: number): Promise<{ agent: string; read: Reading }[]> {
  const store = await storeOf($)
  const prompts = `${await stateDir($)}/prompts`
  const files = (await listOf($, prompts)).map(entry => entry.name)
  const found = new Map<string, Reading>()
  for (const entry of await listOf($, `${store}/sessions`)) {
    if (entry.kind !== 'file' || entry.name.includes('.tmp-')) continue
    const held = parseSessionRow(await readOf($, `${store}/sessions/${entry.name}`))
    const agent = (held?.name ?? '').replace(REFERENCED, '').trim()
    if (held?.role !== 'agent' || agent === '' || found.has(agent)) continue
    const launch = newestLaunch(files, agent)
    const brief = launch === undefined ? undefined : briefOfLaunch(await readOf($, `${prompts}/${launch}`))
    const read = brief === undefined ? null : readingOf(await readOf($, brief))
    if (read !== null && read.pr === pr) found.set(agent, read)
  }
  return [...found].map(([agent, read]) => ({ agent, read }))
}

/**
 * The verdict is recorded: the review sessions of the round are owed a close, and the line the verdict's
 * answer carries says them; null when the round has none (a pass read by the orchestrator alone, a session
 * closed already). `round` reads the repository and the head where the verdict was recorded, asked only once a
 * review session of the pull request is found. Nothing here refuses the verdict: a failure is a log line.
 */
export async function oweRound($: Held, input: { session: string; pr: number; round: () => Promise<Omit<Round, 'pr'> | null>; cost?: { record: string; row: number } | undefined }, now: number = Date.now()): Promise<string | null> {
  try {
    const found = await reviewersOf($, input.pr)
    if (found.length === 0) return null
    const where = await input.round()
    if (where === null) return null
    const round = { ...where, pr: input.pr }
    const agents = found.filter(one => isRound(one.read, round)).map(one => one.agent)
    if (agents.length === 0) return null
    const text = roundText(round)
    for (const agent of agents) owed.set(keyOf(input.session, agent, text), { session: input.session, agent, round: text, at: now, cost: input.cost })
    return `review session of ${text}: ${agents.join(', ')} is closed by the module once its turn ends.`
  } catch (err) {
    await logLine($, 'review', `the review session of ${input.pr} not found: ${messageOf(err)}`).catch(() => undefined)
    return null
  }
}
