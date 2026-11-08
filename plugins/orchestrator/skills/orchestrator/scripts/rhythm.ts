// rhythm — the net balance of a repository, read from git alone, for an audit.
//
//   rhythm.sh <repo> --since <date> [--product <glob>...] [--instrument <glob>...]
//
// Prints, for the default branch since the date:
//   - merges per week: the branch's first-parent commits, each typed by its conventional-commit
//     type — a merge commit by the pull request title its body carries, any other commit by its
//     subject; a title with no type counts as `other`;
//   - lines added and removed under the --product globs and under the --instrument globs, over
//     the branch's non-merge commits (a merge commit would count its branch a second time);
//     the globs are git's plain pathspecs, where `*` crosses directories.
//
// The default branch is the remote's HEAD when the clone knows it, else what the remote
// itself answers (`ls-remote --symref origin HEAD`, one call cancelled at its deadline), else
// `main`, else `master`, else the branch checked out; a branch not read from origin/HEAD is
// named on stderr. Weeks are ISO weeks of the committer date. A bare `--since YYYY-MM-DD` means
// that day's midnight; a date with a time is passed to git as given.
//
// Why it exists: an audit weighs what the method added against what the product gained, and
// compares that with the previous audit; a comparison needs the same figures computed the
// same way twice (design §52).
import { DeadlineExceeded, withDeadline } from '../../../core/deadline.ts'
import { isEntry, processIo, run, type Io, type Run } from './lib/process.ts'

export const USAGE =
  'usage: rhythm.sh <repo> --since <date> [--product <glob>...] [--instrument <glob>...] (a bare YYYY-MM-DD means its midnight; a date with a time is passed to git as given)'

/** How long the remote is given to name its default branch. */
export const REMOTE_MS = 10_000

export const TYPES = ['feat', 'fix', 'chore', 'docs', 'ci', 'build', 'test', 'refactor'] as const

export interface Request {
  readonly repo: string
  readonly since: string
  readonly product: readonly string[]
  readonly instrument: readonly string[]
}

/** The request the command line makes, or the reason it is refused. */
export function parseArgs(argv: readonly string[]): Request | { readonly error: string } {
  const [repo = '', ...rest] = argv
  if (repo === '') return { error: USAGE }
  let since = ''
  const product: string[] = []
  const instrument: string[] = []
  for (let k = 0; k < rest.length; k += 2) {
    const flag = rest[k] ?? ''
    const value = rest[k + 1]
    if (value === undefined) return { error: `${flag} needs a value` }
    if (flag === '--since') since = value
    else if (flag === '--product') product.push(value)
    else if (flag === '--instrument') instrument.push(value)
    else return { error: `unknown argument: ${flag} (${USAGE})` }
  }
  if (since === '') return { error: '--since <date> is required' }
  return { repo, since: sinceForGit(since), product, instrument }
}

/**
 * A bare date as its midnight. git completes `--since=2026-09-13` with the current time of day,
 * and an audit run on the day of its scope read zero merges where there were five.
 */
export function sinceForGit(since: string): string {
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(since) ? `${since}T00:00:00` : since
}

/** The branch `ls-remote --symref origin HEAD` names, or '' when it names none. */
export function remoteHead(listing: string): string {
  for (const line of listing.split('\n')) {
    const fields = line.replace(/^[ \t]+/, '').split(/[ \t]+/)
    if (fields[0] === 'ref:' && fields[2] === 'HEAD') return (fields[1] ?? '').replace(/^refs\/heads\//, '')
  }
  return ''
}

const chomp = (text: string): string => text.replace(/\n+$/, '')

/**
 * The branch to read, and on stderr how it was found whenever it was not origin/HEAD — a figure
 * built on a guess is never silent. In order: origin/HEAD; the remote's own answer, read through
 * its remote-tracking ref when the clone has one; the local `main`, then `master`; the branch
 * checked out.
 */
export async function defaultBranch(repo: string, git: Run, io: Io, remoteMs = REMOTE_MS): Promise<string> {
  const head = await git(['git', '-C', repo, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const known = chomp(head.stdout)
  if (known !== '') return known
  const has = async (ref: string): Promise<boolean> =>
    (await git(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', ref], { stderr: 'inherit' })).status === 0
  let answer = ''
  try {
    answer = await withDeadline(remoteMs, async signal => remoteHead((await git(['git', '-C', repo, 'ls-remote', '--symref', 'origin', 'HEAD'], { signal })).stdout))
  } catch (error) {
    if (!(error instanceof DeadlineExceeded)) throw error
  }
  let unknown = ''
  if (answer !== '') {
    if (await has(`refs/remotes/origin/${answer}`)) {
      io.err(`rhythm: origin/HEAD is unset; read origin/${answer} from the remote\n`)
      return `origin/${answer}`
    }
    if (await has(`refs/heads/${answer}`)) {
      io.err(`rhythm: origin/HEAD is unset; read ${answer} from the remote\n`)
      return answer
    }
    unknown = answer
  }
  let found = ''
  for (const name of ['main', 'master']) {
    if (await has(`refs/heads/${name}`)) {
      found = name
      break
    }
  }
  if (found === '') found = chomp((await git(['git', '-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { stderr: 'inherit' })).stdout)
  io.err(
    unknown !== ''
      ? `rhythm: origin/HEAD is unset; the remote names ${unknown}, which this clone does not have; guessed ${found}\n`
      : `rhythm: origin/HEAD is unset and the remote did not answer; guessed ${found}\n`,
  )
  return found
}

/** The format `mergesPerWeek` reads: one record per commit, fields split on control characters. */
export const LOG_FORMAT = '%x1e%cd%x1f%P%x1f%s%x1f%b'

/** A commit's conventional-commit type, `other` when its title has none. */
export function typeOf(title: string): string {
  return TYPES.find(type => new RegExp(`^${type}(\\([^)]*\\))?!?:`).test(title)) ?? 'other'
}

/**
 * The table of merges per week, from `git log --format=LOG_FORMAT`: a merge commit typed by the
 * first line of its body that is not blank (the pull request's title), any other by its subject.
 */
export function mergesPerWeek(log: string): string[] {
  const counts = new Map<string, Map<string, number>>()
  for (const record of log.split('\x1e')) {
    const [week, parents, subject, body = ''] = record.split('\x1f')
    if (week === undefined || parents === undefined || subject === undefined) continue
    const merge = parents.split(/[ \t\n]+/).filter(Boolean).length > 1
    const title = (merge ? body.split('\n').find(line => /[^ \t]/.test(line)) : undefined) ?? subject
    const row = counts.get(week) ?? new Map<string, number>()
    const type = typeOf(title)
    row.set(type, (row.get(type) ?? 0) + 1)
    counts.set(week, row)
  }
  const header = `week ${TYPES.join(' ')} other total`
  const rows = [...counts.keys()].sort().map(week => {
    const row = counts.get(week) ?? new Map<string, number>()
    const cells = [...TYPES, 'other'].map(type => row.get(type) ?? 0)
    return [week, ...cells, cells.reduce((a, b) => a + b, 0)].join(' ')
  })
  return [header, ...rows]
}

/** Lines added and removed in `git log --numstat` output; a binary file's `-` counts nothing. */
export function numstat(text: string): { readonly added: number; readonly removed: number } {
  let added = 0
  let removed = 0
  for (const line of text.split('\n')) {
    const [a = '', d = ''] = line.replace(/^[ \t]+/, '').split(/[ \t]+/)
    if (!/^[0-9]+$/.test(a)) continue
    added += Number(a)
    removed += /^[0-9]+$/.test(d) ? Number(d) : 0
  }
  return { added, removed }
}

/** Runs the reading of `argv`; returns the exit status. */
export async function main(argv: readonly string[], git: Run, io: Io): Promise<number> {
  const request = parseArgs(argv)
  if ('error' in request) {
    io.err(`rhythm: ${request.error}\n`)
    return 1
  }
  const { repo, since } = request
  if ((await git(['git', '-C', repo, 'rev-parse', '--git-dir'])).status !== 0) {
    io.err(`rhythm: not a git repository: ${repo}\n`)
    return 1
  }
  const branch = await defaultBranch(repo, git, io)
  io.out(`rhythm: ${repo} on ${branch} since ${since}\n`)
  io.out(`merges per week (first-parent commits on ${branch}, typed by their pull request's title):\n`)
  const log = await git(['git', '-C', repo, 'log', branch, '--first-parent', `--since=${since}`, '--date=format:%G-W%V', `--format=${LOG_FORMAT}`], { stderr: 'inherit' })
  io.out(mergesPerWeek(log.stdout).map(line => `${line}\n`).join(''))
  io.out(`lines since ${since} (non-merge commits on ${branch}; globs are git pathspecs, where * crosses directories):\n`)
  for (const [label, globs] of [['product', request.product], ['instrument', request.instrument]] as const) {
    if (globs.length === 0) {
      io.out(`${label}: no --${label} glob given\n`)
      continue
    }
    // Plain pathspecs, not the `:(glob)` magic: under it `*` stops at a slash, and a product
    // written `src/*.ts` counted its directory's top-level files alone — +738 lines on a real
    // repository where git's own reading of the same tree was +40936.
    const stat = await git(['git', '-C', repo, 'log', branch, `--since=${since}`, '--no-merges', '--numstat', '--format=', '--', ...globs], { stderr: 'inherit' })
    const { added, removed } = numstat(stat.stdout)
    io.out(`${label} +${added} -${removed}  (${globs.join(' ')})\n`)
  }
  return 0
}

/* node:coverage ignore next 3 */
if (isEntry(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), run, processIo)
}
