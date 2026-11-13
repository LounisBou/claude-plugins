// ci-watch — the one way to wait on a pull request's checks. Its command line, its lines, their
// exit codes and what the caller does on each are documented in the header of ci-watch.sh, the
// launcher every caller runs.
//
// No temporary file: what a failed `gh` said is read from its stderr in memory.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setting, stateDir, type Env } from '../../../core/paths.ts'
import { isEntry, processIo, run, type Io, type Ran, type Run } from './lib/process.ts'

export const USAGE = 'usage: ci-watch.sh <pr | owner/name#pr | pull request url> [--repo <owner/repo>] [--interval <s>] [--base-workflow <name>]... [--no-base] (outside a clone of the repository: name it, by --repo or in the target)'

/** A line said and the exit code that goes with it: the watch is over. */
export class Said {
  readonly line: string
  readonly code: number

  constructor(line: string, code: number) {
    this.line = line
    this.code = code
  }
}

const unread = (pr: string, reason: string): Said => new Said(`unread ${pr === '' ? '-' : pr} ${reason}`, 5)

export interface Options {
  readonly pr: string
  readonly repo: string | undefined
  readonly interval: string
  readonly base: boolean
  readonly workflows: readonly string[]
  readonly registerWait: number
  readonly baseWait: number
  readonly mergeWait: number
  readonly stateDir: string
  readonly session: string | undefined
}

const DIGITS = /^[0-9]+$/
const NAME = '[A-Za-z0-9_.-]+'
const SHORT_TARGET = new RegExp(`^(${NAME}/${NAME})#([0-9]+)$`)
const URL_TARGET = new RegExp(`^https://github\\.com/(${NAME}/${NAME})/pull/([0-9]+)(?:[/?#].*)?$`)

/** The pull request a target names, and the repository when the target names one: `7`, `owner/name#7` or its URL. */
export function parseTarget(target: string): { readonly pr: string; readonly repo: string | undefined } | undefined {
  if (DIGITS.test(target)) return { pr: target, repo: undefined }
  const named = SHORT_TARGET.exec(target) ?? URL_TARGET.exec(target)
  return named?.[1] === undefined || named[2] === undefined ? undefined : { pr: named[2], repo: named[1] }
}

/** The watch the command line and the environment ask for; throws `Said` on a bad call. */
export function parseArgs(argv: readonly string[], env: Env): Options {
  const [first = '', ...rest] = argv
  const target = parseTarget(first)
  if (target === undefined) throw unread('', USAGE)
  const pr = target.pr
  let repo = target.repo
  let interval = '10'
  let base = true
  let workflows: string[] = []
  for (let k = 0; k < rest.length; k++) {
    const flag = rest[k] ?? ''
    if (flag === '--no-base') {
      base = false
      continue
    }
    const value = rest[k + 1]
    if (value === undefined) throw unread(pr, `${flag} needs a value`)
    if (flag === '--repo') {
      // A repository named twice is one repository: the watch never reads another one's number.
      if (repo !== undefined && repo.toLowerCase() !== value.toLowerCase()) throw unread(pr, `the target names ${repo} and --repo names ${value}`)
      repo = value
    }
    else if (flag === '--interval') interval = value
    else if (flag === '--base-workflow') workflows.push(value)
    else throw unread(pr, `unknown argument: ${flag} (${USAGE})`)
    k++
  }
  if (!DIGITS.test(interval) || interval === '0') throw unread(pr, 'the interval is a positive number of seconds')
  const seconds = (name: string, fallback: number): number => {
    const value = setting(env, name)
    if (value === undefined) return fallback
    if (!DIGITS.test(value)) throw unread(pr, `${name} is a number of seconds`)
    return Number(value)
  }
  const registerWait = seconds('CI_WATCH_REGISTER_WAIT', 180)
  const baseWait = seconds('CI_WATCH_BASE_WAIT', 600)
  const mergeWait = seconds('CI_WATCH_MERGE_WAIT', 1800)
  const named = setting(env, 'CI_WATCH_BASE_WORKFLOWS')
  if (workflows.length === 0 && named !== undefined) {
    // As `IFS=, read -r -a`: the first line, split on commas, a trailing empty field dropped.
    workflows = (named.split('\n')[0] ?? '').split(',')
    if (workflows.at(-1) === '') workflows.pop()
  }
  return {
    pr, repo, interval, base, workflows, registerWait, baseWait, mergeWait,
    stateDir: setting(env, 'ORCHESTRATOR_STATE_DIR') ?? stateDir('claude-orchestrator', env, setting(env, 'HOME')),
    session: setting(env, 'CLAUDE_CODE_SESSION_ID'),
  }
}

/** The first line of a command's stderr, carriage returns removed. */
export function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').replaceAll('\r', '')
}

/** A command's output as `$(…)` reads it: trailing newlines removed. */
const chomp = (text: string): string => text.replace(/\n+$/, '')

/** `head` and `tail` around the first space, the way `${s%% *}` and `${s#* }` split it. */
function split(text: string): readonly [string, string] {
  const at = text.indexOf(' ')
  return at === -1 ? [text, text] : [text.slice(0, at), text.slice(at + 1)]
}

/** Names one per line, joined the way `paste -sd, - | sed 's/,/, /g'` joins them. */
export function joinNames(lines: string): string {
  const text = chomp(lines)
  return text === '' ? '' : text.split('\n').join(',').replaceAll(',', ', ')
}

export interface PullRequest {
  readonly state: string
  readonly head: string
  readonly auto: boolean
  readonly draft: boolean
}

/** What `gh pr view`'s one-line answer says: `<STATE> <head>[ auto][ draft]`. */
export function parseView(out: string): PullRequest {
  const [state, rest] = split(out)
  const [head, flags] = split(rest)
  const words = rest === head ? [] : flags.split(' ')
  return { state, head, auto: words.includes('auto'), draft: words.includes('draft') }
}

/** The log of this pull request's watch, `suffix` naming which watch writes it. */
export function logPath(options: Options, suffix: string): string {
  const slug = (options.repo ?? 'here').replace(/[^A-Za-z0-9._-]/g, '_')
  return join(options.stateDir, 'ci-watch', `${slug}-pr${options.pr}${suffix}.log`)
}

/** Counts the `bucket<TAB>name` lines of `buckets` in `bucket`, among `names` when given. */
export function countBucket(buckets: string, bucket: string, names?: ReadonlySet<string>): number {
  return buckets.split('\n').filter(line => {
    const [b, name = ''] = line.split('\t')
    return b === bucket && (names === undefined || names.has(name))
  }).length
}

export interface Deps {
  /** Runs `gh` and `python3`. */
  readonly run: Run
  readonly io: Io
  readonly sleep: (seconds: number) => Promise<void>
  /** Milliseconds, for the bounds. */
  readonly now: () => number
  /** The draft guard classifier beside this script. */
  readonly draftGuard: string
}

/** One watch of `options.pr`; resolves to the line it says and its exit code. */
export async function watch(options: Options, deps: Deps): Promise<Said> {
  const { pr, interval } = options
  const repo = options.repo === undefined ? [] : ['-R', options.repo]
  const gh = (args: readonly string[], extra: Parameters<Run>[1] = {}): Promise<Ran> => deps.run(['gh', ...args.slice(0, 2), ...insertRepo(args.slice(2), repo)], extra)
  const sleep = (): Promise<void> => deps.sleep(Number(interval))
  const fail = (what: string, ran: Ran, fallback = 'no answer'): Said => unread(pr, `${what} failed: ${firstLine(ran.stderr) || fallback}`)
  let settled = false
  let log = logPath(options, '')

  const readPr = async (): Promise<PullRequest> => {
    const ran = await gh(['pr', 'view', pr, '--json', 'state,headRefOid,autoMergeRequest,isDraft', '--jq',
      '.state + " " + .headRefOid + (if .autoMergeRequest then " auto" else "" end) + (if .isDraft then " draft" else "" end)'], { stderr: 'pipe' })
    const out = chomp(ran.stdout)
    if (ran.status !== 0 || out === '') throw fail('gh pr view', ran)
    return parseView(out)
  }

  const draftGuard = async (...args: string[]): Promise<string> => {
    const name = resolved
    if (name === undefined || name === '') throw unread(pr, 'gh repo view failed: no repository read')
    const ran = await deps.run(['python3', deps.draftGuard, name, pr, ...args], { stderr: 'pipe' })
    if (ran.status !== 0) throw unread(pr, firstLine(ran.stderr) || 'draft_guard.py failed')
    return chomp(ran.stdout)
  }

  const failingNames = async (): Promise<string> =>
    (await gh(['pr', 'checks', pr, '--json', 'name,bucket', '--jq', '.[] | select(.bucket == "fail" or .bucket == "cancel") | .name'])).stdout

  const checksWatch = async (draft: boolean, append: boolean): Promise<number> => {
    const ran = await gh(['pr', 'checks', pr, '--watch', ...(draft ? [] : ['--fail-fast']), '--interval', interval], { log: { path: log, append } })
    return ran.status ?? 1
  }

  const ensureLogDir = (): void => {
    try {
      mkdirSync(join(options.stateDir, 'ci-watch'), { recursive: true })
    } catch {
      throw unread(pr, `cannot create ${options.stateDir}/ci-watch`)
    }
  }

  const followed = (name: string): boolean => options.workflows.length === 0 || options.workflows.includes(name)

  // The pull request is no longer open: closed without merge ends here; merged is followed onto
  // the base branch's push runs at the merge commit, unless --no-base.
  const ended = async (current: PullRequest): Promise<Said> => {
    if (!(current.state === 'MERGED' && options.base)) return new Said(`closed ${pr} ${current.state}`, 4)
    const view = await gh(['pr', 'view', pr, '--json', 'mergeCommit,baseRefName', '--jq', '(.mergeCommit.oid // "") + " " + .baseRefName'], { stderr: 'pipe' })
    if (view.status !== 0) throw fail('gh pr view', view)
    const out = chomp(view.stdout)
    const [sha, branch] = split(out)
    if (sha === '' || branch === '' || branch === out) throw unread(pr, 'gh pr view failed: no merge commit or base branch read')
    ensureLogDir()
    log = logPath(options, '-base')
    try {
      writeFileSync(log, '')
    } catch {
      // As `: > "$log"`: the watches below append, or fail, on their own.
    }
    const deadline = deps.now() + options.baseWait * 1000
    const seen = new Set<string>()
    const left = new Set<string>()
    let green: string | undefined
    for (;;) {
      const listing = await gh(['run', 'list', '--branch', branch, '--commit', sha, '--event', 'push', '--json', 'databaseId,workflowName', '--jq', '.[] | "\\(.databaseId)\\t\\(.workflowName)"'], { stderr: 'pipe' })
      if (listing.status !== 0) throw fail('gh run list', listing)
      const fresh: (readonly [string, string])[] = []
      for (const line of listing.stdout.split('\n')) {
        const [id = '', ...name] = line.replace(/^\t+/, '').split('\t')
        if (id === '' || seen.has(id)) continue
        const workflow = name.join('\t').replace(/\t+$/, '')
        if (followed(workflow)) fresh.push([id, workflow])
        else left.add(id)
      }
      if (fresh.length === 0) {
        // Every run listed has been watched green: one listing more found nothing new.
        if (seen.size > 0) return new Said(`base-green ${pr} ${green ?? sha}`, 0)
        if (deps.now() >= deadline) return new Said(`base-no-run ${pr} ${sha} filtered=${left.size}`, 7)
        await sleep()
        continue
      }
      for (const [first, workflow] of fresh) {
        let id = first
        let at = sha
        for (;;) {
          seen.add(id)
          const ran = await gh(['run', 'watch', id, '--exit-status', '--interval', interval], { log: { path: log, append: true } })
          const code = ran.status ?? 1
          if (code === 0) break
          if (chomp((await gh(['run', 'view', id, '--json', 'conclusion', '--jq', '.conclusion'])).stdout) === 'cancelled') {
            const newest = await gh(['run', 'list', '--branch', branch, '--workflow', workflow, '--event', 'push', '--limit', '1', '--json', 'databaseId,headSha', '--jq', '.[] | "\\(.databaseId) \\(.headSha)"'], { stderr: 'pipe' })
            if (newest.status !== 0) throw fail('gh run list', newest)
            const [next, nextSha] = split(chomp(newest.stdout))
            // Only a newer run replaces it; the cancelled run itself listed means none came.
            if (DIGITS.test(next) && Number(next) > Number(id)) {
              id = next
              at = nextSha
              green = nextSha
              continue
            }
          }
          const jobs = joinNames((await gh(['run', 'view', id, '--json', 'jobs', '--jq',
            '.jobs[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out") | .name'])).stdout)
          if (jobs === '') throw unread(pr, `gh run watch ${id} exited ${code} with no failing job named (log: ${log})`)
          return new Said(`base-red ${pr} ${at} ${id} ${jobs}`, 6)
        }
      }
    }
  }

  // After a watch that exited non-zero on a draft: when at least one check fails and every failing
  // one is a draft guard, the watch counts as a pass and the green path goes on. A watch that
  // failed with no failing check (an API error) is no pass: it takes the path of a non-draft.
  // `settled` records that a draft was settled on its guards: its green then needs a job behind one.
  const settleDraft = async (code: number, current: PullRequest): Promise<number> => {
    if (code === 0 || !current.draft) return code
    if ((await draftGuard()) !== '') return code
    if (chomp(await failingNames()) === '') return code
    settled = true
    return 0
  }

  // The pull request read again: closed, merged or moved ends the watch here.
  const reread = async (first: string): Promise<PullRequest> => {
    const current = await readPr()
    if (current.state !== 'OPEN') throw await ended(current)
    if (current.head !== first) throw new Said(`moved ${pr} ${first} ${current.head}`, 3)
    return current
  }

  // No repository named: gh reads the one the directory is a clone of, and outside any clone it
  // would fail, or, inside another project's, watch that project's pull request of the same number.
  let resolved = options.repo
  if (resolved === undefined) {
    const here = await deps.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { stderr: 'pipe' })
    if (here.status !== 0) throw unread(pr, 'this directory is not a clone of the repository: pass --repo <owner/repo>')
    resolved = chomp(here.stdout)
  }

  let current = await readPr()
  if (current.state !== 'OPEN') return ended(current)
  const first = current.head

  // Wait, bounded, for checks to be registered on the head.
  let deadline = deps.now() + options.registerWait * 1000
  for (;;) {
    const ran = await gh(['pr', 'checks', pr, '--json', 'name', '--jq', 'length'], { stderr: 'pipe' })
    const why = firstLine(ran.stderr)
    if (!why.includes('no checks reported')) {
      // Any other failure, or an answer that is no number, is a gh failure.
      if (ran.status !== 0) throw unread(pr, `gh pr checks failed: ${why || 'no answer'}`)
      const count = chomp(ran.stdout)
      if (!DIGITS.test(count)) throw unread(pr, `gh pr checks failed: ${why || 'an answer that is no count'}`)
      if (Number(count) > 0) break
    }
    if (deps.now() >= deadline) return new Said(`no-checks ${pr} ${first}`, 2)
    await sleep()
  }

  ensureLogDir()
  log = logPath(options, '')
  // The owner file names the session that armed this watch, beside its log: the stop gate tells a
  // session only the watches its own id owns. A watch armed by no session leaves no owner file, so
  // an earlier watch's is removed, and the log is told to no session.
  if (options.session !== undefined) {
    try {
      writeFileSync(`${log}.session`, `${options.session}\n`)
    } catch {
      throw unread(pr, `cannot write ${log}.session`)
    }
  } else {
    rmSync(`${log}.session`, { force: true })
  }
  let code = await checksWatch(current.draft, false)

  // One read, now that the watch returned: the pull request may have been closed or moved.
  current = await reread(first)
  code = await settleDraft(code, current)

  // The watch returns once the checks it knows are done, and a slower workflow's checks may not
  // be registered yet: every workflow run of the head is read, each one unfinished is watched to
  // its end, and once none is, the checks are watched again, a late one read like the others.
  // The bound restarts whenever a run is watched for the first time; a run already watched and
  // still listed unfinished is polled within it.
  deadline = deps.now() + options.registerWait * 1000
  const seen = new Set<string>()
  let waited = false
  while (code === 0) {
    const listing = await gh(['run', 'list', '--commit', current.head, '--json', 'databaseId,status', '--jq', '.[] | select(.status != "completed") | .databaseId'], { stderr: 'pipe' })
    if (listing.status !== 0) throw fail('gh run list', listing)
    const pending = listing.stdout.split(/\s+/).filter(Boolean)
    if (pending.length > 0) {
      waited = true
      let fresh = false
      for (const id of pending) {
        if (seen.has(id)) continue
        seen.add(id)
        fresh = true
        await gh(['run', 'watch', id, '--interval', interval], { log: { path: log, append: true } })
      }
      if (fresh) {
        // The run watches may have lasted long: a head moved or a pull request closed meanwhile
        // is said now, not after a checks watch has waited for the new head's checks.
        current = await reread(first)
        deadline = deps.now() + options.registerWait * 1000
      } else {
        if (deps.now() >= deadline) throw unread(pr, `workflow runs of the head still unfinished: ${pending.join(' ')}`)
        await sleep()
      }
      continue
    }
    if (!waited) break
    waited = false
    code = await checksWatch(current.draft, true)
    current = await reread(first)
    code = await settleDraft(code, current)
  }

  let names: string
  if (code === 0) {
    // The watch exits 0 when no check is in the `fail` bucket, a cancelled one included: a check
    // whose job was never run is no green, so the buckets are read once before saying so.
    const read = await gh(['pr', 'checks', pr, '--json', 'name,bucket', '--jq', '.[] | .bucket + "\\t" + .name'], { stderr: 'pipe' })
    const buckets = chomp(read.stdout)
    if (read.status !== 0 || buckets === '') throw fail('gh pr checks', read)
    names = joinNames(buckets.split('\n').filter(line => line.split('\t')[0] === 'cancel').map(line => line.split('\t')[1] ?? '').join('\n'))
    // Nor is a head where no check passed: every one skipped, or failed as a draft guard the
    // draft settled, means nothing ran, and that is said as no checks.
    let passed = countBucket(buckets, 'pass')
    const skipped = countBucket(buckets, 'skipping')
    if (settled && current.draft) {
      // A draft settled on its guards: a check that needs none of them proves nothing ran.
      passed = countBucket(buckets, 'pass', new Set((await draftGuard('--dependents')).split('\n').filter(Boolean)))
    }
    if (names === '') {
      if (options.base && current.auto) {
        // Auto-merge will merge: wait for it, bounded, and follow the base branch.
        const until = deps.now() + options.mergeWait * 1000
        while (deps.now() < until) {
          await sleep()
          current = await reread(first)
          if (!current.auto) break
        }
      }
      if (passed <= 0) return new Said(`no-checks ${pr} ${current.head} skipped=${skipped}`, 2)
      return new Said(`green ${pr} ${current.head} ${gateCall(pr, options.repo)}`, 0)
    }
  } else {
    names = joinNames(current.draft ? await draftGuard() : await failingNames())
    if (names === '') throw unread(pr, `gh pr checks --watch exited ${code} with no failing check named (log: ${log})`)
  }
  return new Said(`red ${pr} ${current.head} ${names}`, 1)
}

/**
 * The one call a green line carries: the github tool's read of the gate, which puts `Ready` once
 * the four conditions hold at the head (github's contract, docs/contracts.md).
 */
export function gateCall(pr: string, repo: string | undefined): string {
  return `next: mcp__github__gh pr-gate {"pr": ${pr}}${repo === undefined ? '' : ` on ${repo}`}`
}

/** `-R <repo>` placed where the shell script put it: after the subcommand's first operand, if any. */
function insertRepo(rest: readonly string[], repo: readonly string[]): string[] {
  if (repo.length === 0) return [...rest]
  const operand = rest[0] !== undefined && !rest[0].startsWith('-') ? 1 : 0
  return [...rest.slice(0, operand), ...repo, ...rest.slice(operand)]
}

/** Runs the watch of `argv`; returns its exit code. */
export async function main(argv: readonly string[], env: Env, deps: Deps): Promise<number> {
  let said: Said
  try {
    said = await watch(parseArgs(argv, env), deps)
  } catch (error) {
    if (!(error instanceof Said)) throw error
    said = error
  }
  deps.io.out(`ci-watch: ${said.line}\n`)
  return said.code
}

/* node:coverage ignore next 9 */
if (isEntry(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    run,
    io: processIo,
    sleep: seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)),
    now: () => Date.now(),
    draftGuard: join(dirname(fileURLToPath(import.meta.url)), 'draft_guard.py'),
  })
}
