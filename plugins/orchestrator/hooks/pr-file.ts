// hooks/pr-file.ts
// The machine's one pull request file: `<state>/prs.json`, every pull request the dispatch records on
// the machine name (their ledger lines), every open one of their repositories and of those the
// workspace checkouts are clones of (`prs.wanted`, the sweep's), and those seen merged or closed within ENDED_KEPT_MS, with its state,
// draft, head, base and their commits, labels, mergeable, fork and one CI word, beside `<state>/prs.log`, one line
// per change. No daemon refreshes it: a reader that finds it older than PR_FILE_INTERVAL_MS refreshes
// it, under the file's lock, in one forge call for every repository (one GraphQL query), so the
// machine pays one call per interval whatever the number of orchestrators or pull requests. A call
// that fails keeps the pull requests read before and says so on the log; the next try waits a whole
// interval, never a loop: the try is written to the file before the call, and a file that cannot be
// written makes no call.
import { ledgerLines, prKey } from '../core/pr-ledger.ts'
import { withLockOver } from '../core/store-io.ts'
import { RECORDS_DIR } from '../core/orchestration.ts'
import { messageOf, type Host } from './host.ts'
import { logLine, stateDir, storeIo, writeAtomic } from './module-io.ts'
import {
  ENDED_KEPT_MS, filePrOf, isFresh, parsePrFile, prFilePath, prLogPath, prWantedPath, PR_FILE_VERSION, wantedRepos, type FilePr, type PrFile,
} from './pr-file-format.ts'

// The nouns a refresh holds.
type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'clock'>

/** The bound of the one forge call. */
export const PR_FILE_CALL_MS = 15_000
/** The open and the ended pull requests read per repository, and the labels per pull request. */
export const OPEN_PAGE = 100
export const ENDED_PAGE = 50
const LABELS_PAGE = 10
/** The change log's last lines kept. */
export const LOG_KEPT = 500

const literal = (value: string): string => JSON.stringify(value)
const BASE = 'number state isDraft createdAt headRefName headRefOid baseRefName baseRefOid mergeable author{login} isCrossRepository headRepositoryOwner{login}'
const FIELDS = `${BASE} labels(first:${LABELS_PAGE}){nodes{name}}`
const ENDED = `ended:pullRequests(states:[MERGED,CLOSED],first:${ENDED_PAGE},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${BASE}}}`

/**
 * The one query: per repository, its open pull requests (one page of OPEN_PAGE, the newest), the last
 * ones merged or closed (one page of ENDED_PAGE, for the sweep's clones) and each pull request the
 * records name, by its number, with its head's check rollup; the viewer; the call's cost.
 */
export function prQuery(tracked: ReadonlyMap<string, readonly number[]>): string {
  const parts = [...tracked].map(([repo, numbers], i) => {
    const [owner = '', name = ''] = repo.split('/')
    const named = numbers.map(n => `n${n}:pullRequest(number:${n}){${FIELDS} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}`).join(' ')
    return `r${i}:repository(owner:${literal(owner)},name:${literal(name)}){open:pullRequests(states:OPEN,first:${OPEN_PAGE},orderBy:{field:CREATED_AT,direction:DESC}){pageInfo{hasNextPage} nodes{${FIELDS}}} ${ENDED} ${named}}`
  })
  return `query{viewer{login} rateLimit{cost remaining} ${parts.join(' ')}}`
}

export function prQueryArgv(tracked: ReadonlyMap<string, readonly number[]>): string[] {
  return ['gh', 'api', 'graphql', '-f', `query=${prQuery(tracked)}`]
}

/** What one answer read: the viewer, the pull requests kept, the repositories read and not, the cost and the repositories whose open list ran past its page. */
export interface PrAnswer {
  readonly viewer: string
  readonly prs: FilePr[]
  readonly repos: string[]
  readonly unread: string[]
  readonly cost: number | null
  readonly truncated: string[]
}

function nodePr(repo: string, node: unknown): FilePr | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const n = node as Record<string, unknown>
  const author = (n['author'] as { login?: unknown } | null | undefined)?.login
  const labels = ((n['labels'] as { nodes?: unknown } | null | undefined)?.nodes)
  const commits = ((n['commits'] as { nodes?: unknown } | null | undefined)?.nodes)
  const rollup = Array.isArray(commits) ? (commits[0] as { commit?: { statusCheckRollup?: { state?: unknown } | null } } | undefined)?.commit?.statusCheckRollup : undefined
  return filePrOf({
    repo, pr: n['number'], state: n['state'], draft: n['isDraft'], head: n['headRefName'], sha: n['headRefOid'], base: n['baseRefName'], baseSha: n['baseRefOid'],
    author: typeof author === 'string' ? author : null, createdAt: n['createdAt'],
    labels: Array.isArray(labels) ? labels.flatMap(label => (typeof (label as { name?: unknown } | null)?.name === 'string' ? [(label as { name: string }).name] : [])) : [],
    mergeable: n['mergeable'],
    fork: n['isCrossRepository'] === true ? (n['headRepositoryOwner'] as { login?: unknown } | null | undefined)?.login ?? '?' : null,
    ...(Array.isArray(commits) ? { ci: typeof rollup?.state === 'string' ? rollup.state.toLowerCase() : 'none' } : {}),
  })
}

/**
 * The forge's answer to prQuery read: per repository, its open pull requests, its last ones merged or
 * closed, and those the records name, whatever their state; a repository the answer has no data for
 * is unread. Undefined when the answer is no data at all.
 */
export function parsePrAnswer(tracked: ReadonlyMap<string, readonly number[]>, stdout: string): PrAnswer | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const data = (value as { data?: unknown } | null)?.data
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  const viewer = (d['viewer'] as { login?: unknown } | null | undefined)?.login
  if (typeof viewer !== 'string') return undefined
  const cost = (d['rateLimit'] as { cost?: unknown } | null | undefined)?.cost
  const answer: PrAnswer = { viewer, prs: [], repos: [], unread: [], cost: typeof cost === 'number' ? cost : null, truncated: [] }
  ;[...tracked].forEach(([repo, numbers], i) => {
    const r = d[`r${i}`] as Record<string, unknown> | null | undefined
    const open = r?.['open'] as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } } | undefined
    if (typeof r !== 'object' || r === null || !Array.isArray(open?.nodes)) {
      answer.unread.push(repo)
      return
    }
    answer.repos.push(repo)
    if (open.pageInfo?.hasNextPage === true) answer.truncated.push(repo)
    const byNumber = new Map<number, FilePr>()
    const ended = (r['ended'] as { nodes?: unknown } | null | undefined)?.nodes
    for (const node of [...(Array.isArray(ended) ? ended : []), ...open.nodes]) {
      const pr = nodePr(repo, node)
      if (pr !== undefined) byNumber.set(pr.pr, pr)
    }
    for (const n of numbers) {
      const pr = nodePr(repo, r[`n${n}`])
      if (pr !== undefined) byNumber.set(n, pr)
    }
    answer.prs.push(...byNumber.values())
  })
  return answer
}

/** The change log's lines from `before` to `after`, at `at`, in the repositories read: none when there was no file before. */
export function changeLines(before: PrFile | undefined, after: readonly FilePr[], read: readonly string[], at: string): string[] {
  if (before === undefined) return []
  const was = new Map(before.prs.map(pr => [prKey(pr.repo, pr.pr), pr]))
  const lines: string[] = []
  const say = (pr: { repo: string; pr: number }, what: string) => lines.push(`${at} ${prKey(pr.repo, pr.pr)} ${what}`)
  const now = new Set<string>()
  for (const pr of after) {
    const key = prKey(pr.repo, pr.pr)
    now.add(key)
    const old = was.get(key)
    if (old === undefined) {
      if (pr.state === 'OPEN') say(pr, 'opened')
      continue
    }
    if (old.state !== pr.state) say(pr, pr.state === 'OPEN' ? 'reopened' : pr.state.toLowerCase())
    if (old.draft !== pr.draft) say(pr, pr.draft ? 'draft' : 'ready for review')
    if (pr.ci !== undefined && old.ci !== pr.ci) say(pr, `ci ${pr.ci}`)
  }
  for (const old of before.prs) {
    if (old.state === 'OPEN' && read.includes(old.repo) && !now.has(prKey(old.repo, old.pr))) say(old, 'no longer open')
  }
  return lines
}

/** The log's text with `lines` appended, its LOG_KEPT last lines kept. */
export function withLogLines(log: string, lines: readonly string[]): string {
  return [...log.split('\n').filter(line => line !== ''), ...lines].slice(-LOG_KEPT).map(line => `${line}\n`).join('')
}

async function readOr($: Host<'fs'>, path: string): Promise<string> {
  return String(await $.fs.read(path).catch(() => ''))
}

/** The pull requests the dispatch records on the machine name, by repository: the records every session registered. */
export async function trackedPrs($: Host<'fs'>, state: string): Promise<Map<string, number[]>> {
  const registries: { name: string; kind: string }[] = await $.fs.list(`${state}/${RECORDS_DIR}`).catch(() => [])
  const records = new Set<string>()
  for (const entry of registries) {
    if (entry.kind !== 'file') continue
    for (const path of (await readOr($, `${state}/${RECORDS_DIR}/${entry.name}`)).split('\n')) if (path.trim() !== '') records.add(path.trim())
  }
  const tracked = new Map<string, number[]>()
  for (const path of records) {
    for (const line of ledgerLines(await readOr($, path))) {
      const numbers = tracked.get(line.repo) ?? []
      if (!numbers.includes(line.pr)) numbers.push(line.pr)
      tracked.set(line.repo, numbers)
    }
  }
  return tracked
}

/** Whether the sweep asks the file to hold a repository at `now` (`prs.wanted`). */
export async function fileWanted($: Host<'fs'>, state: string, now: number): Promise<boolean> {
  return wantedRepos(await readOr($, prWantedPath(state)), now).length > 0
}

/** The repositories to read: those the records name, with their numbers, and those the sweep wants. */
export async function reposToRead($: Host<'fs'>, state: string, now: number): Promise<Map<string, number[]>> {
  const tracked = await trackedPrs($, state)
  for (const repo of wantedRepos(await readOr($, prWantedPath(state)), now)) if (!tracked.has(repo)) tracked.set(repo, [])
  return tracked
}

/**
 * The pull requests a new reading holds: the answer's, each merged or closed one stamped with when the
 * file first saw it ended, then those of the file before, ended within ENDED_KEPT_MS, in a repository
 * read and not in the answer.
 */
export function withEnded(before: PrFile | undefined, answer: readonly FilePr[], read: readonly string[], now: number, at: string): FilePr[] {
  const was = new Map((before?.prs ?? []).map(pr => [prKey(pr.repo, pr.pr), pr]))
  const fresh = answer.map(pr => (pr.state === 'OPEN' ? pr : { ...pr, ended: was.get(prKey(pr.repo, pr.pr))?.ended ?? at }))
  const seen = new Set(fresh.map(pr => prKey(pr.repo, pr.pr)))
  const kept = (before?.prs ?? []).filter(pr => pr.ended !== undefined && read.includes(pr.repo) && !seen.has(prKey(pr.repo, pr.pr))
    && now - Date.parse(pr.ended) <= ENDED_KEPT_MS)
  return [...fresh, ...kept]
}

/** The file as it stands, undefined when there is none. */
export async function readPrFile($: Host<'env' | 'fs'>): Promise<PrFile | undefined> {
  return parsePrFile(await readOr($, prFilePath(await stateDir($))))
}

/**
 * The file refreshed when it is older than the interval: under its lock, one session of the machine
 * at a time, read again under it so a refresh another session just made counts. A lock another
 * session holds is its refresh: this one reads what is there. Never throws.
 */
export async function refreshPrFile($: Held, now: number = Date.now()): Promise<void> {
  try {
    const state = await stateDir($)
    const path = prFilePath(state)
    if (isFresh(parsePrFile(await readOr($, path)), now)) return
    await withLockOver(storeIo($), path, async () => {
      const before = parsePrFile(await readOr($, path))
      if (isFresh(before, now)) return
      await refreshUnder($, state, before, now)
    }, { tries: 0 })
  } catch (err) {
    if (!/stayed locked/.test(messageOf(err))) await logLine($, 'prs', `refresh failed: ${messageOf(err)}`)
  }
}

async function refreshUnder($: Held, state: string, before: PrFile | undefined, now: number): Promise<void> {
  const at = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const tracked = await reposToRead($, state, now)
  const kept = { at: before?.at ?? null, viewer: before?.viewer ?? null, repos: before?.repos ?? [], unread: before?.unread ?? [], prs: before?.prs ?? [] }
  let answer: PrAnswer | undefined
  let failure = ''
  if (tracked.size > 0) {
    // The try is on the file before the call: a reader of any session waits the interval even when
    // the file cannot be written after it, and a file that cannot be written now makes no call.
    await writeAtomic($, prFilePath(state), `${JSON.stringify(before === undefined ? { v: PR_FILE_VERSION, ...kept, tried: at } : { ...before, tried: at })}\n`)
    const ran = await $.process.run(prQueryArgv(tracked), { timeoutMs: PR_FILE_CALL_MS }).catch((err: unknown) => {
      failure = messageOf(err)
      return null
    })
    // A query some of whose parts the forge cannot resolve (a repository gone, a number that never
    // was) exits 1 with the rest of its data: the data is read, its errors said once on the log.
    if (ran !== null) answer = parsePrAnswer(tracked, String(ran.stdout ?? ''))
    if (ran !== null && ran.exitCode !== 0) failure = `gh exited ${ran.exitCode}: ${String(ran.stderr ?? '').trim()}`
    else if (ran !== null && answer === undefined) failure = 'the answer holds no data'
  }
  const partial = answer !== undefined && failure !== '' ? failure : undefined
  const truncated = answer?.truncated ?? []
  const file: PrFile = answer === undefined
    ? { v: PR_FILE_VERSION, ...kept, tried: at, ...(tracked.size > 0 ? { error: failure } : { repos: [], unread: [], prs: [] }) }
    : {
      // A repository whose open list ran past its page is read only in part: unread for every reader.
      v: PR_FILE_VERSION, at, tried: at, viewer: answer.viewer, repos: answer.repos.filter(repo => !truncated.includes(repo)), unread: [...answer.unread, ...truncated],
      ...(answer.cost === null ? {} : { cost: answer.cost }), ...(partial === undefined ? {} : { partial }), prs: withEnded(before, answer.prs, answer.repos, now, at),
    }
  const lines = answer === undefined
    ? (tracked.size > 0 ? [`${at} refresh failed: ${failure}`] : [])
    : [
        // A repository whose open list ran past its page is not read whole: no pull request is said gone from it.
        ...changeLines(before, file.prs, answer.repos.filter(repo => !truncated.includes(repo)), at), ...answer.truncated.map(repo => `${at} ${repo} open past ${OPEN_PAGE}: the rest unread`),
        ...(partial !== undefined && partial !== before?.partial ? [`${at} read in part: ${partial}`] : []),
      ]
  await writeAtomic($, prFilePath(state), `${JSON.stringify(file)}\n`)
  if (lines.length > 0) await writeAtomic($, prLogPath(state), withLogLines(await readOr($, prLogPath(state)), lines))
  if (answer === undefined && tracked.size > 0) await logLine($, 'prs', `refresh failed, the file kept: ${failure}`)
}
