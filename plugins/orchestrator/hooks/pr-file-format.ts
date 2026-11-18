// hooks/pr-file-format.ts
// The machine's pull request file's format, pure, owned here and read by the hooks module (pr-file.ts,
// which refreshes it) and by the scripts that read it (the sweep, the coordinator's facts, the
// takeover): `<state>/prs.json`, its change log `prs.log`, and `prs.wanted`, the repositories of the
// workspace checkouts, which the sweep alone writes, one `<owner/name> <ISO time>` a line, dropped
// past ENDED_KEPT_MS. The pull requests the dispatch records name (their ledger lines) are read from
// the records themselves, never copied here.

/** The file's age past which a reader refreshes it: 60 calls an hour at most, about 1 % of the forge's 5 000. */
export const PR_FILE_INTERVAL_MS = 60_000
export const PR_FILE_VERSION = 1
const VERSION = PR_FILE_VERSION
/** How long a pull request seen merged or closed stays in the file, for the sweep's clones. */
export const ENDED_KEPT_MS = 7 * 24 * 60 * 60 * 1000

/**
 * A pull request as the file holds it: `fork`, the owner of its head's repository when that is a
 * fork; `ended`, when the file first saw it merged or closed; `base` and `baseSha`, its base branch and that
 * branch's commit, absent from a file written before they were read.
 */
export interface FilePr {
  readonly repo: string
  readonly pr: number
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED'
  readonly draft: boolean
  readonly head: string
  readonly sha: string
  readonly base?: string
  readonly baseSha?: string
  readonly author: string | null
  readonly createdAt: string | null
  readonly labels: readonly string[]
  readonly mergeable: string | null
  readonly fork: string | null
  readonly ended?: string
}

/** The file: when it was last read (`at`) and tried (`tried`), the repositories read and those the last call could not read. */
export interface PrFile {
  readonly v: number
  readonly at: string | null
  readonly tried: string
  readonly error?: string
  /** The errors of a call read in part (a repository or a number the forge cannot resolve). */
  readonly partial?: string
  /** The forge's cost of the last call, in its rate limit's points. */
  readonly cost?: number
  readonly viewer: string | null
  readonly repos: readonly string[]
  readonly unread: readonly string[]
  readonly prs: readonly FilePr[]
}

export const prFilePath = (state: string): string => `${state}/prs.json`
export const prLogPath = (state: string): string => `${state}/prs.log`

const STATES = ['OPEN', 'MERGED', 'CLOSED'] as const
const isState = (value: unknown): value is FilePr['state'] => STATES.some(state => state === value)
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

export function filePrOf(value: unknown): FilePr | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const r = value as Record<string, unknown>
  const { repo, pr, state, draft, head, sha, base, baseSha, ended } = r
  if (typeof repo !== 'string' || typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1 || !isState(state)) return undefined
  return {
    repo, pr, state, draft: draft === true, head: text(head) ?? '', sha: text(sha) ?? '', author: text(r['author']),
    createdAt: text(r['createdAt']), labels: strings(r['labels']), mergeable: text(r['mergeable']), fork: text(r['fork']),
    ...(typeof base === 'string' ? { base } : {}), ...(typeof baseSha === 'string' ? { baseSha } : {}),
    ...(typeof ended === 'string' ? { ended } : {}),
  }
}

/** The file's text read, or undefined when it is absent or breaks the shape. */
export function parsePrFile(raw: string): PrFile | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const r = value as Record<string, unknown>
  if (r['v'] !== VERSION || typeof r['tried'] !== 'string' || !Array.isArray(r['prs'])) return undefined
  return {
    v: VERSION, at: text(r['at']), tried: r['tried'], ...(typeof r['error'] === 'string' ? { error: r['error'] } : {}),
    ...(typeof r['cost'] === 'number' ? { cost: r['cost'] } : {}), ...(typeof r['partial'] === 'string' ? { partial: r['partial'] } : {}),
    viewer: text(r['viewer']), repos: strings(r['repos']), unread: strings(r['unread']),
    prs: r['prs'].flatMap(item => filePrOf(item) ?? []),
  }
}

/** Whether the file was tried within the interval at `now`: no reader refreshes it then. */
export function isFresh(file: PrFile | undefined, now: number): boolean {
  const tried = Date.parse(file?.tried ?? '')
  return Number.isFinite(tried) && now - tried < PR_FILE_INTERVAL_MS
}

/** The age past which a reading is no current one: the sweep's own cache lived as long. */
export const READING_KEPT_MS = 30 * 60 * 1000

/**
 * The file's pull requests of a repository it read; undefined when it holds no current reading of it:
 * none, a failed last refresh, a reading older than READING_KEPT_MS at `now`, or an open list that ran
 * past its page (the refresh counts it unread).
 */
export function prsOfRepo(file: PrFile | undefined, repo: string, now: number): readonly FilePr[] | undefined {
  if (file === undefined || file.error !== undefined || !file.repos.includes(repo)) return undefined
  if (!(now - Date.parse(file.at ?? '') <= READING_KEPT_MS)) return undefined
  return file.prs.filter(pr => pr.repo === repo)
}

/** `<owner>/<name>` of a GitHub origin's address (https, ssh or scp form); undefined for any other host. */
export function repoOfOrigin(url: string): string | undefined {
  const match = /^(?:[a-z+]+:\/\/)?(?:[^@/]*@)?github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/*$/.exec(url.trim())
  return match === null ? undefined : `${match[1]}/${match[2]}`
}

export const prWantedPath = (state: string): string => `${state}/prs.wanted`

/** The repositories a wanted file's text asks for at `now`, each asked within ENDED_KEPT_MS. */
export function wantedRepos(text: string, now: number): string[] {
  const kept = new Set<string>()
  for (const line of text.split('\n')) {
    const [repo = '', at = ''] = line.trim().split(/\s+/)
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && now - Date.parse(at) <= ENDED_KEPT_MS) kept.add(repo)
  }
  return [...kept]
}

/** A wanted file's text with `repos` asked again at `now`, each repository once, those too old dropped. */
export function withWanted(text: string, repos: readonly string[], now: number): string {
  const at = new Date(now).toISOString()
  const by = new Map<string, string>()
  for (const line of text.split('\n')) {
    const [repo = '', when = ''] = line.trim().split(/\s+/)
    if (wantedRepos(line, now).length > 0) by.set(repo, when)
  }
  for (const repo of repos) by.set(repo, at)
  return [...by].map(([repo, when]) => `${repo} ${when}\n`).join('')
}
