// ci-watch — the one way to wait on a pull request's checks. Its command line, its lines, their
// exit codes and what the caller does on each are documented in the header of ci-watch.sh, the
// launcher every caller runs.
//
// No temporary file: what a failed `gh` said is read from its stderr in memory.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setting, stateDir, type Env } from '../../../core/paths.ts'
import { writeAtomic } from '../../../core/store.ts'
import { ENV } from '../../../core/env.ts'
import { locatePlugin, NotInstalled } from '../../../core/locate.ts'
import { CI_GATE_DIR, ciGatePath, CI_WATCH_DIR, ciWatchLogPath, MODULE_DIR } from '../../../core/orchestration.ts'
import { isEntry, processIo, run, type Io, type Ran, type Run } from './lib/process.ts'
import { auditRun, fullHead, scriptJournal, writeAudit, type Journal } from './lib/audit.ts'

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
  let interval = '30'
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
    stateDir: setting(env, 'ORCHESTRATOR_STATE_DIR') ?? stateDir(MODULE_DIR, env, setting(env, 'HOME')),
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
  /** Set only when GitHub reports the pull request as conflicting with its base. */
  readonly conflicting?: true
}

/** What `gh pr view`'s one-line answer says: `<STATE> <head>[ auto][ draft][ conflicting]`. */
export function parseView(out: string): PullRequest {
  const [state, rest] = split(out)
  const [head, flags] = split(rest)
  const words = rest === head ? [] : flags.split(' ')
  return { state, head, auto: words.includes('auto'), draft: words.includes('draft'), ...(words.includes('conflicting') ? { conflicting: true as const } : {}) }
}

/** The log of this pull request's watch, or of its base branch's watch after the merge (core's ciWatchLogPath). */
export function logPath(options: Options, base: boolean): string {
  return ciWatchLogPath(options.stateDir, options.repo, options.pr, base)
}

/** One check the gate counted: its name and bucket (pass, fail, pending, skipping). */
export interface GateCheck { readonly name: string; readonly bucket: string }

/** Counts the gate's checks in `bucket`, among `names` when given. */
export function countBucket(checks: readonly GateCheck[], bucket: string, names?: ReadonlySet<string>): number {
  return checks.filter(check => check.bucket === bucket && (names === undefined || names.has(check.name))).length
}

/** The gate's reading of CI at a head, as the watch decides on it. */
export interface GateCi {
  /** The repository the gate read, `owner/name`, when it names one. */
  readonly repo?: string
  /** The head the gate read. */
  readonly head: string | undefined
  readonly result: string
  readonly running: number
  readonly unverified: boolean
  readonly failed: readonly string[]
  readonly checks: readonly GateCheck[]
  /** The answer as the gate gave it, for the draft guard's stdin. */
  readonly raw: string
}

/** The gate's JSON answer read; null when it has no CI result. */
export function parseGate(stdout: string): GateCi | null {
  interface Answer { readonly repo?: unknown; readonly head?: unknown; readonly ci?: { readonly result?: unknown; readonly running?: unknown; readonly unverified?: unknown; readonly failed?: unknown; readonly checks?: unknown } }
  let gate: Answer | null = null
  try {
    gate = JSON.parse(stdout) as Answer | null
  } catch {
    return null
  }
  const ci = gate?.ci
  if (typeof ci?.result !== 'string' || typeof ci.running !== 'number') return null
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  const checks = Array.isArray(ci.checks)
    ? (ci.checks as { readonly name?: unknown; readonly bucket?: unknown }[]).flatMap(check => (typeof check?.name === 'string' && typeof check.bucket === 'string' ? [{ name: check.name, bucket: check.bucket }] : []))
    : []
  return {
    ...(typeof gate?.repo === 'string' ? { repo: gate.repo } : {}), head: typeof gate?.head === 'string' ? gate.head : undefined, result: ci.result, running: ci.running,
    unverified: strings(ci.unverified).length > 0, failed: strings(ci.failed), checks, raw: stdout,
  }
}

export interface Deps {
  /** Runs `gh` and `python3`. */
  readonly run: Run
  readonly io: Io
  readonly sleep: (seconds: number) => Promise<void>
  /** Milliseconds, for the bounds. */
  readonly now: () => number
  /** The command that runs the draft guard classifier beside this script, its arguments to follow. */
  readonly draftGuard: readonly [string, ...string[]]
  /** The github plugin's `pr-gate` of the pull request, as JSON: the one reading of what CI the head still awaits. */
  readonly gate: (repo: string, pr: string) => Promise<Ran>
  /** Takes the watch's start and end for the audit trail (lib/audit.ts); none, nothing is written. */
  readonly journal?: Journal
}

/** One watch of `options.pr`; resolves to the line it says and its exit code. */
export async function watch(options: Options, deps: Deps): Promise<Said> {
  const { pr, interval } = options
  const repo = options.repo === undefined ? [] : ['-R', options.repo]
  const gh = (args: readonly string[], extra: Parameters<Run>[1] = {}): Promise<Ran> => deps.run(['gh', ...args.slice(0, 2), ...insertRepo(args.slice(2), repo)], extra)
  // One interval, but never past the bound the loop checks after its read: a bound shorter than
  // the interval, or the last part of one, is slept to its end and no further.
  const sleep = (bound: number): Promise<void> => deps.sleep(Math.max(0, Math.min(Number(interval), (bound - deps.now()) / 1000)))
  const fail = (what: string, ran: Ran, fallback = 'no answer'): Said => unread(pr, `${what} failed: ${firstLine(ran.stderr) || fallback}`)
  let settled = false
  let log = logPath(options, false)

  const readPr = async (): Promise<PullRequest> => {
    const ran = await gh(['pr', 'view', pr, '--json', 'state,headRefOid,autoMergeRequest,isDraft,mergeable', '--jq',
      '.state + " " + .headRefOid + (if .autoMergeRequest then " auto" else "" end) + (if .isDraft then " draft" else "" end) + (if .mergeable == "CONFLICTING" then " conflicting" else "" end)'], { stderr: 'pipe' })
    const out = chomp(ran.stdout)
    if (ran.status !== 0 || out === '') throw fail('gh pr view', ran)
    return parseView(out)
  }

  // The draft guard classifies the gate's answer, given on its stdin: it reads no check itself.
  const draftGuard = async (gate: GateCi, ...args: string[]): Promise<string> => {
    const name = resolved
    if (name === undefined || name === '') throw unread(pr, 'gh repo view failed: no repository read')
    const ran = await deps.run([...deps.draftGuard, name, pr, ...args], { stderr: 'pipe', input: gate.raw })
    if (ran.status !== 0) throw unread(pr, firstLine(ran.stderr) || 'draft guard failed')
    return chomp(ran.stdout)
  }

  // CI at the head, as the github plugin's gate reads it: the one reading the watch decides on.
  const readCi = async (name: string): Promise<GateCi> => {
    const ran = await deps.gate(name, pr)
    if (ran.status !== 0) throw unread(pr, `pr-gate failed: ${firstLine(ran.stderr) || 'no answer'}`)
    const ci = parseGate(ran.stdout)
    if (ci === null) throw unread(pr, 'pr-gate failed: an answer with no ci result')
    keepGate(ci, name)
    return ci
  }

  /*
   * The gate's answer kept whole, the last one replacing the one before (core's ciGatePath): the
   * delivery's facts line reads CI there and asks GitHub nothing. A write that fails stops no watch;
   * the facts line then finds no reading at the head and says CI unread.
   */
  const keepGate = (ci: GateCi, name: string): void => {
    try {
      mkdirSync(join(options.stateDir, CI_GATE_DIR), { recursive: true })
      writeAtomic(ciGatePath(options.stateDir, ci.repo ?? name, pr), ci.raw)
    } catch {
      // Said by the facts line, which finds no reading at the head.
    }
  }

  // Whether the head's CI is still to come: the gate speaks of another head than the one watched (it
  // is read again), or no verdict is in and a check runs (a required check not yet reported being
  // one) or the checks the base requires are unread (`unverified`: green cannot be told). A head with
  // a third-party check alone (a secret scanner) answers yes until the repository's own run has registered.
  const awaitsCi = (ci: GateCi, head: string): boolean =>
    (ci.head !== undefined && ci.head.toLowerCase() !== head.toLowerCase())
    || (ci.result !== 'SUCCESS' && ci.result !== 'NONE' && (ci.running > 0 || ci.unverified))

  // `gh pr checks --watch` only waits: its exit code decides nothing, the gate's reading does.
  const checksWatch = async (draft: boolean, append: boolean): Promise<void> => {
    await gh(['pr', 'checks', pr, '--watch', ...(draft ? [] : ['--fail-fast']), '--interval', interval], { log: { path: log, append } })
  }

  const ensureLogDir = (): void => {
    try {
      mkdirSync(join(options.stateDir, CI_WATCH_DIR), { recursive: true })
    } catch {
      throw unread(pr, `cannot create ${options.stateDir}/${CI_WATCH_DIR}`)
    }
  }

  const followed = (name: string): boolean => options.workflows.length === 0 || options.workflows.includes(name)

  // The pull request is no longer open: closed without merge ends here; merged is followed onto
  // the base branch's push runs at the merge commit, unless --no-base. `during`: the watch saw it
  // open first, so no push run on the base branch ends the watch on the merge, exit 0.
  const ended = async (current: PullRequest, during = false): Promise<Said> => {
    if (!(current.state === 'MERGED' && options.base)) return new Said(`closed ${pr} ${current.state}`, 4)
    const view = await gh(['pr', 'view', pr, '--json', 'mergeCommit,baseRefName', '--jq', '(.mergeCommit.oid // "") + " " + .baseRefName'], { stderr: 'pipe' })
    if (view.status !== 0) throw fail('gh pr view', view)
    const out = chomp(view.stdout)
    const [sha, branch] = split(out)
    if (sha === '' || branch === '' || branch === out) throw unread(pr, 'gh pr view failed: no merge commit or base branch read')
    ensureLogDir()
    log = logPath(options, true)
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
        if (deps.now() >= deadline) {
          return during ? new Said(`merged ${pr} ${sha} no push run on ${branch} filtered=${left.size}`, 0)
            : new Said(`base-no-run ${pr} ${sha} filtered=${left.size}`, 7)
        }
        await sleep(deadline)
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

  // The pull request read again: closed, merged or moved ends the watch here.
  const reread = async (first: string): Promise<PullRequest> => {
    const current = await readPr()
    if (current.state !== 'OPEN') throw await ended(current, true)
    if (current.head !== first) throw new Said(`moved ${pr} ${first} ${current.head}`, 3)
    return current
  }

  // No repository named: gh reads the one the directory is a clone of, and outside any clone it
  // would fail, or, inside another project's, watch that project's pull request of the same number.
  let resolved = options.repo
  if (resolved === undefined) {
    const here = await deps.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { stderr: 'pipe' })
    const advice = 'pass --repo <owner/repo>'
    const why = firstLine(here.stderr)
    if (here.status !== 0 && why !== '') throw unread(pr, `gh repo view failed: ${why}: ${advice}`)
    resolved = here.status === 0 ? chomp(here.stdout) : ''
    if (resolved === '') throw unread(pr, `this directory is not a clone of the repository: ${advice}`)
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
    await sleep(deadline)
  }

  ensureLogDir()
  log = logPath(options, false)
  // The owner file names the session that armed this watch, beside its log: the stop gate tells a
  // session only the watches its own id owns. A watch armed by no session leaves no owner file, so
  // an earlier watch's is removed, and the log is told to no session.
  if (options.session !== undefined) {
    try {
      writeAtomic(`${log}.session`, `${options.session}\n`)
    } catch {
      throw unread(pr, `cannot write ${log}.session`)
    }
  } else {
    rmSync(`${log}.session`, { force: true })
  }
  await checksWatch(current.draft, false)
  // One read, now that the watch returned: the pull request may have been closed or moved.
  current = await reread(first)

  // The gate decides: a failure is a red at once, unless the pull request is a draft and every
  // failing check is a draft guard (`settled`: its green then needs a job behind one). The watch
  // returns once the checks it knows are done, and a slower workflow's checks may not be
  // registered yet: every workflow run of the head is read, each one unfinished is watched to its
  // end, and once none is, the checks are watched again. The bound restarts whenever a run is
  // watched for the first time; a run already watched and still listed unfinished is polled within it.
  deadline = deps.now() + options.registerWait * 1000
  const seen = new Set<string>()
  let waited = false
  let ci: GateCi
  for (;;) {
    ci = await readCi(resolved)
    // A verdict of another head is none: the head is read again before the gate is asked once more.
    const ours = ci.head === undefined || ci.head.toLowerCase() === current.head.toLowerCase()
    settled = false
    if (ours && ci.result === 'FAILURE') {
      const names = joinNames(current.draft ? await draftGuard(ci) : ci.failed.join('\n'))
      if (names !== '') return new Said(`red ${pr} ${current.head} ${names}`, 1)
      if (!current.draft) throw unread(pr, 'pr-gate read FAILURE with no failing check named')
      settled = true
    }
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
        await sleep(deadline)
      }
      continue
    }
    if (waited) {
      waited = false
      await checksWatch(current.draft, true)
      current = await reread(first)
      continue
    }
    // Every run listed is done: the verdict once the gate awaits no more CI, within the bound.
    if (!awaitsCi(ci, current.head)) break
    if (deps.now() >= deadline) return new Said(`no-checks ${pr} ${current.head}`, 2)
    await sleep(deadline)
    current = await reread(first)
  }

  // GitHub starts no workflow run on a conflicting pull request: what passed is an external check
  // at most, and the suites never ran. Auto-merge will never merge it either, so no wait.
  if (current.conflicting) return new Said(`no-checks ${pr} ${current.head} conflicting`, 2)
  if (options.base && current.auto) {
    // Auto-merge will merge: wait for it, bounded, and follow the base branch.
    const until = deps.now() + options.mergeWait * 1000
    while (deps.now() < until) {
      await sleep(until)
      current = await reread(first)
      if (!current.auto) break
    }
  }
  const skipped = countBucket(ci.checks, 'skipping')
  // A draft settled on its guards: green only when a check that needs one of them passed. Any
  // other head is green only as the gate reads it: one where nothing proved anything is no checks.
  const green = settled
    ? countBucket(ci.checks, 'pass', new Set((await draftGuard(ci, '--dependents')).split('\n').filter(Boolean))) > 0
    : ci.result === 'SUCCESS'
  if (!green) return new Said(`no-checks ${pr} ${current.head} skipped=${skipped}`, 2)
  return new Said(`green ${pr} ${current.head} ${gateCall(pr, options.repo)}`, 0)
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
  let options: Options | undefined
  try {
    options = parseArgs(argv, env)
    noteWait(deps, env, options, null, null)
    said = await watch(options, deps)
  } catch (error) {
    if (!(error instanceof Said)) throw error
    said = error
  }
  if (options !== undefined) noteWait(deps, env, options, said.line.split(' ')[0] ?? null, said.line.split(' ').find(word => fullHead(word) !== null))
  deps.io.out(`ci-watch: ${said.line}\n`)
  return said.code
}

/** The wait on CI as the audit trail holds it: its start (no result), or its end with the line's first word and the head it names. */
function noteWait(deps: Deps, env: Env, options: Options, result: string | null, head: string | undefined | null): void {
  writeAudit(deps.journal, auditRun(env, new Date(deps.now())), 'step', `orchestrator.ci-watch.${result ?? 'start'}`,
    { step: 'ci-wait', edge: result === null ? 'start' : 'end', record: null, row: null, result },
    { subject: { repo: options.repo ?? null, pr: Number(options.pr), head: fullHead(head ?? undefined) } })
}

/**
 * The github plugin's `pr-gate` of a pull request as JSON, run from the plugin's own engine: found
 * where the host installed it (the install record, or the override that names a checkout), never a
 * path built by hand. The plugin missing is a read that failed, said with what to install.
 */
/* node:coverage ignore next 10 */
async function readGate(repo: string, pr: string): Promise<Ran> {
  let root: string
  try {
    root = locatePlugin('github', ['lounisbou'], process.env, { override: ENV.githubRoot })
  } catch (error) {
    if (!(error instanceof NotInstalled)) throw error
    return { status: 1, stdout: '', stderr: `${error.message} (${error.fix})\n` }
  }
  return run(['python3', join(root, 'engine', 'gh.py'), '--repo', repo, 'pr-gate', pr, '--json'], { stderr: 'pipe' })
}

/* node:coverage ignore next 11 */
if (isEntry(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    run,
    io: processIo,
    sleep: seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)),
    now: () => Date.now(),
    draftGuard: [process.execPath, '--no-warnings', join(dirname(fileURLToPath(import.meta.url)), 'draft-guard.ts')],
    gate: readGate,
    journal: scriptJournal(process.env, () => new Date(), line => processIo.err(`${line}\n`)),
  })
}
