// A push to main skips what its tree already passed.
//
// The merge of a pull request is, in the usual case, the very tree its `pull_request` run tested:
// that run checks out GitHub's merge of the base and the head. This script finds that run for the
// pushed commit and says which jobs it covered, so that main runs only the rest. Every doubt is a
// « run »: no pull request run, a tree that differs, a run that did not succeed, a lookup that
// fails. It never fails the build and never skips more than a run passed.
//
// The pushed commit is a merge commit; its second parent is the pull request's head, which names
// the runs (`head_sha`). A run does not name the merge commit it tested: its ref is deleted at the
// merge, and the run forgets its pull request. The checkout step's log does, in the line that
// fetches `+<sha>:refs/remotes/pull/<n>/merge`. The commit is then read through the API, which
// keeps it, and is believed only when its second parent is the run's head: its tree is the tree
// the run tested.
//
//   node scripts/tested-tree.ts [<sha>]
//
// Reads GITHUB_REPOSITORY and GH_TOKEN (`actions: read`). Prints the decision;
// appends to $GITHUB_OUTPUT: `repository=true|false` (the repository rules passed) and `covered=`,
// a JSON list of cell keys (`cellKey` of scripts/plugin-matrix.ts) whose job passed.
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { processIo, type Io } from './lib/io.ts'
import { isEntry, isRecord } from './lib/plugins.ts'
import { cellKey, PLATFORMS } from './plugin-matrix.ts'

/** The workflow whose runs count: a pull request run of another workflow proves nothing about this one. */
export const WORKFLOW_PATH = '.github/workflows/ci.yml'

/** The name of the job that runs the repository rules (`name:` of the `repository` job in the workflow). */
export const REPOSITORY_JOB = 'repository rules'

export interface Decision {
  /** The repository rules passed on this tree: their steps may be skipped. */
  readonly repository: boolean
  /** The `cellKey`s of the plugin cells that passed on this tree. */
  readonly covered: readonly string[]
  readonly reason: string
}

/** Runs git in the checkout and returns its output; throws when git fails. */
export type Git = (...args: string[]) => string
/** Reads GitHub's API by path: a JSON answer, or a log as text; both reject when the call fails. */
export interface Api {
  readonly json: (path: string) => Promise<unknown>
  readonly text: (path: string) => Promise<string>
}

const RUN_EVERYTHING = (reason: string): Decision => ({ repository: false, covered: [], reason: `run everything: ${reason}` })

/** `<plugin> on <os>[ (part <n>)][ (not yet blocking)]`, the name of a plugin job in the workflow. */
const CELL_JOB = new RegExp(`^(\\S+) on (${PLATFORMS.join('|')})(?: \\(part (\\d+)\\))?(?: \\(not yet blocking\\))?$`)

/** The key of the cell a job name stands for, `undefined` for a job that is not a plugin cell. */
export function cellOfJob(name: string): string | undefined {
  const match = CELL_JOB.exec(name)
  if (match === null) return undefined
  const [, plugin, os, shard] = match
  const platform = PLATFORMS.find(candidate => candidate === os)
  if (plugin === undefined || platform === undefined) return undefined
  return cellKey({ plugin, os: platform, ...(shard === undefined ? {} : { shard: Number(shard) }) })
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`the API answer carries no ${what}`)
  return value
}

function listOf(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`the API answer carries no ${what}`)
  return value
}

/** The successful runs of the workflow on the pull request head. */
async function candidates(api: Api, repo: string, head: string): Promise<number[]> {
  const answer = await api.json(`repos/${repo}/actions/runs?head_sha=${head}&event=pull_request&per_page=100`)
  const found: number[] = []
  for (const run of listOf(field(answer, 'workflow_runs'), 'workflow_runs')) {
    if (field(run, 'conclusion') !== 'success' || field(run, 'head_sha') !== head) continue
    if (text(field(run, 'path'), 'path').split('@')[0] !== WORKFLOW_PATH) continue
    const id = field(run, 'id')
    if (typeof id === 'number') found.push(id)
  }
  return found
}

interface Jobs {
  /** The job that runs the repository rules, when it passed. */
  readonly repository: boolean
  /** The id of the job whose log names the merge commit the run checked out. */
  readonly repositoryId: number | undefined
  /** The keys of the plugin cells that passed. */
  readonly covered: string[]
}

async function jobsOf(api: Api, repo: string, id: number): Promise<Jobs> {
  const answer = await api.json(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`)
  const jobs = listOf(field(answer, 'jobs'), 'jobs')
  if (jobs.length >= 100) throw new Error(`run ${id} has more jobs than one page of the API lists`)
  let repository = false
  let repositoryId: number | undefined
  const covered: string[] = []
  for (const job of jobs) {
    const name = text(field(job, 'name'), 'job name')
    const jobId = field(job, 'id')
    if (name === REPOSITORY_JOB && typeof jobId === 'number') repositoryId = jobId
    if (field(job, 'conclusion') !== 'success') continue
    if (name === REPOSITORY_JOB) repository = true
    const key = cellOfJob(name)
    if (key !== undefined) covered.push(key)
  }
  return { repository, repositoryId, covered }
}

/** The line of the checkout step that fetches the merge commit it then checks out. */
const FETCHED_MERGE = /\+([0-9a-f]{40}):refs\/remotes\/pull\/\d+\/merge/

/**
 * The tree the run tested: the merge commit its checkout step fetched, read through the API, and
 * believed only when it merges the run's head. `undefined` when the log is gone or says nothing.
 */
async function testedTree(api: Api, repo: string, head: string, repositoryId: number | undefined): Promise<string | undefined> {
  if (repositoryId === undefined) return undefined
  const sha = FETCHED_MERGE.exec(await api.text(`repos/${repo}/actions/jobs/${repositoryId}/logs`))?.[1]
  if (sha === undefined) return undefined
  const commit = await api.json(`repos/${repo}/git/commits/${sha}`)
  const parents = listOf(field(commit, 'parents'), 'parents')
  if (parents.length !== 2 || field(parents[1], 'sha') !== head) return undefined
  return text(field(field(commit, 'tree'), 'sha'), 'tree')
}

/**
 * The decision for the commit `sha` of main. The tree of the commit is compared with the tree each
 * successful pull request run of its second parent tested; the first run that matches gives the
 * jobs to leave out.
 */
export async function decide(sha: string, repo: string, git: Git, api: Api): Promise<Decision> {
  try {
    const tree = git('rev-parse', `${sha}^{tree}`).trim()
    const head = git('rev-list', '--parents', '-n', '1', sha).trim().split(' ')[2]
    if (head === undefined) return RUN_EVERYTHING(`${sha.slice(0, 8)} is not the merge of a pull request`)
    const runs = await candidates(api, repo, head)
    if (runs.length === 0) return RUN_EVERYTHING(`no successful pull request run of ${head.slice(0, 8)}`)
    const tested: string[] = []
    for (const id of runs) {
      const passed = await jobsOf(api, repo, id)
      const merged = await testedTree(api, repo, head, passed.repositoryId)
      if (merged === undefined) continue
      if (merged !== tree) { tested.push(merged.slice(0, 8)); continue }
      return {
        repository: passed.repository,
        covered: passed.covered,
        reason: `skip what run ${id} passed on tree ${tree.slice(0, 8)}: ${passed.repository ? 'the repository rules, ' : ''}${passed.covered.length} plugin cells`,
      }
    }
    return RUN_EVERYTHING(tested.length > 0
      ? `tree ${tree.slice(0, 8)} differs from the tree ${tested.join(', ')} the pull request run tested`
      : `no pull request run of ${head.slice(0, 8)} names the tree it tested`)
  } catch (error) {
    return RUN_EVERYTHING(`the lookup failed (${error instanceof Error ? error.message : String(error)})`)
  }
}

function gitIn(root: string): Git {
  return (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/* node:coverage ignore next 16 */
function githubApi(token: string | undefined): Api {
  const get = async (path: string): Promise<Response> => {
    if (token === undefined || token === '') throw new Error('no GH_TOKEN')
    // A log is a redirect to a signed address: fetch drops the token on the way, as it must.
    const response = await fetch(`https://api.github.com/${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path.split('?')[0]}`)
    return response
  }
  return { json: async path => (await get(path)).json(), text: async path => (await get(path)).text() }
}

export async function run(root: string, args: readonly string[], io: Io, git: Git = gitIn(root), api: Api = githubApi(io.env['GH_TOKEN'])): Promise<number> {
  const repo = io.env['GITHUB_REPOSITORY']
  const sha = args[0] ?? 'HEAD'
  const decision = repo === undefined || repo === '' ? RUN_EVERYTHING('no GITHUB_REPOSITORY') : await decide(sha, repo, git, api)
  io.out(`tested-tree: ${decision.reason}`)
  const output = io.env['GITHUB_OUTPUT']
  if (output !== undefined) appendFileSync(output, `repository=${decision.repository}\ncovered=${JSON.stringify(decision.covered)}\n`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(await run(process.cwd(), process.argv.slice(2), processIo))
