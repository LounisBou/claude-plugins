// telemetry — the writer and the exporter of the session events.
//
//   telemetry.ts append   --config <dir>                  JSON lines on stdin, redacted, appended
//   telemetry.ts check    --config <dir>                  the scan of the store; exit 1 on a finding
//   telemetry.ts export   --config <dir>                  check, then commit and push to the logs repository
//   telemetry.ts export   --auto [--foreground] --config <dir>
//                                                         the export a session's end starts: at most once a day,
//                                                         detached unless --foreground
//   telemetry.ts backfill --config <dir> <transcript>...  one session_summary per past transcript
//   telemetry.ts sweep    [--auto] --config <dir>         the sessions that never ended, summarized, the settled
//                                                         round questions and the dispatch record's writes the
//                                                         orchestrator's journal holds; with --auto, at most once a day
//   telemetry.ts report   --config <dir> [--week <first day>] [--tool <owner/name>]...
//                                                         the week's cost, delay, questions, refusals and figures
//
// <dir> is the host's configuration directory; the store is <dir>/telemetry. The operator's
// ~/.env (TELEMETRY_ENV_FILE in tests) is read for its secrets, which never leave this process.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { firstRepository, makeEvent, remoteUrlsArgv, type Event } from '../../../hooks/collect.ts'
import { runAuto } from './lib/auto.ts'
import { exportExclusive, logsRepo, machineName, type Git } from './lib/export.ts'
import { parseOptions, report, type Check, type Gh } from './lib/report.ts'
import { parseEnvFile, type EnvSecrets } from './lib/redact.ts'
import { append, check, eventsDir, parseEvent } from './lib/store.ts'
import { claimSweep, sweep, sweepDue } from './lib/sweep.ts'
import { summarizeFile, transcriptOf } from './lib/transcript.ts'

export const USAGE = 'usage: telemetry.ts {append|check|export [--auto [--foreground]]|backfill|sweep [--auto]|report [--week <YYYY-MM-DD>] [--tool <owner/name>]...} --config <dir> [<transcript>...]'

/** A git command is never left running past this. */
export const GIT_TIMEOUT_MS = 60_000

/** A command-line export waits this long for another export's lock before saying so. */
export const EXPORT_WAIT_MS = 90_000

export interface Deps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdin: () => string
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly git: Git
  readonly now: () => number
  /** Starts `export --auto --foreground`, or `sweep --auto`, for `config` as a detached process. */
  readonly detach: (config: string, work?: 'sweep') => void
  readonly exportWaitMs: number
  /** The report's reads of GitHub and of a directory's remote, and the directory it runs in. */
  readonly gh: Gh
  /** Runs `npm run -s <script> -- --json` in the checkout the report is run in. */
  readonly check: Check
  readonly repositoryAt: (dir: string) => string | undefined
  readonly cwd: string
}

/**
 * The operator's secrets: the env file's keys and values; none when the file does not exist. Any
 * other failure to read it is an error: without its values the redaction cannot hide them.
 */
export function readSecrets(env: Deps['env']): { secrets: EnvSecrets } | { error: string } {
  const file = env['TELEMETRY_ENV_FILE'] || join(env['HOME'] || homedir(), '.env')
  try {
    return { secrets: parseEnvFile(readFileSync(file, 'utf8')) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { secrets: new Map() }
    return { error: `${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))})` }
  }
}

/** A session_end enriched with what its transcript holds; any other event as it came. */
export function enrich(line: string, config: string): string {
  const event = parseEvent(line)
  if (typeof event === 'string' || event.event !== 'session_end') return line
  const path = transcriptOf(config, event.session)
  if (path === undefined) return line
  try {
    const { title, role, effort, models, first_turn_ms, totals } = summarizeFile(path)
    return JSON.stringify({ ...event, title, role, effort, models, first_turn_ms, totals })
  } catch {
    return line
  }
}

/** Whether a line to append is a session's end. */
function endsSession(line: string): boolean {
  const event = parseEvent(line)
  return typeof event !== 'string' && event.event === 'session_end'
}

/** The session_summary of one past transcript, its session read from the file's name. */
export function backfillEvent(path: string, now: number): Event | undefined {
  const session = basename(path, '.jsonl')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(session)) return undefined
  const summary = summarizeFile(path)
  const at = summary.ended === undefined ? now : Date.parse(summary.ended)
  return makeEvent('session_summary', Number.isFinite(at) ? at : now, session, { ...summary, source: 'transcript' })
}

export function run(args: readonly string[], deps: Deps): number {
  const [sub, ...rest] = args
  const at = rest.indexOf('--config')
  const config = at >= 0 ? rest[at + 1] : undefined
  if (sub === undefined || config === undefined || config === '') {
    deps.err(USAGE)
    return 2
  }
  const operands = rest.filter((_, i) => i !== at && i !== at + 1)
  const stateDir = join(config, 'telemetry')
  if (sub === 'report') {
    // Read-only and secret-free: an unreadable env file does not stop it.
    const options = parseOptions(operands)
    if (typeof options === 'string') {
      deps.err(`report: ${options}`)
      return 2
    }
    for (const line of report({ config, env: deps.env, now: deps.now(), ...options, cwd: deps.cwd, gh: deps.gh, check: deps.check, repositoryAt: deps.repositoryAt })) deps.out(line)
    return 0
  }
  const read = readSecrets(deps.env)
  if ('error' in read) {
    deps.err(`telemetry: ${sub} refused, nothing written or pushed: ${read.error}`)
    return 1
  }
  const { secrets } = read
  const exportOptions = () => ({
    stateDir,
    secrets,
    repo: logsRepo(deps.env, secrets),
    machine: machineName(deps.env['TELEMETRY_MACHINE'] || hostname()),
    git: deps.git,
    transcript: (session: string) => transcriptOf(config, session),
  })
  switch (sub) {
    case 'append': {
      const raw = deps.stdin().split('\n').filter(line => line.trim() !== '')
      const lines = raw.map(line => enrich(line, config)).join('\n')
      const { refused } = append(eventsDir(stateDir), lines, secrets)
      for (const reason of refused) deps.err(`telemetry: a line was refused (${reason})`)
      if (raw.some(line => endsSession(line))) {
        // A session's end is the trigger of the day's sweep and of the export; neither ever fails the write.
        try {
          if (sweepDue(stateDir, deps.now())) deps.detach(config, 'sweep')
        } catch (error) {
          deps.err(`telemetry: the sweep was skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
        try {
          for (const line of runAuto({ ...exportOptions(), now: deps.now, foreground: false, detach: () => deps.detach(config) }).lines) deps.out(line)
        } catch (error) {
          deps.err(`telemetry: the automatic export was skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return 0
    }
    case 'check': {
      const findings = check(eventsDir(stateDir), secrets)
      for (const f of findings) deps.out(`${f.file}:${f.line}: ${f.pattern}`)
      deps.out(findings.length === 0 ? 'check: no secret found' : `check: ${findings.length} finding(s)`)
      return findings.length === 0 ? 0 : 1
    }
    case 'export': {
      const result = operands.includes('--auto')
        ? runAuto({ ...exportOptions(), now: deps.now, foreground: operands.includes('--foreground'), detach: () => deps.detach(config) })
        : exportExclusive(exportOptions(), { waitMs: deps.exportWaitMs })
      for (const line of result.lines) deps.out(line)
      return result.code
    }
    case 'backfill': {
      const events: string[] = []
      for (const path of operands) {
        const event = backfillEvent(path, deps.now())
        if (event === undefined) deps.err(`backfill: ${basename(path)} is not a session transcript, skipped`)
        else events.push(JSON.stringify(event))
      }
      const { written } = append(eventsDir(stateDir), events.join('\n'), secrets)
      deps.out(`backfill: ${written} session(s) summarized`)
      return 0
    }
    case 'sweep': {
      if (operands.includes('--auto') && !claimSweep(stateDir, deps.now())) return 0
      const result = sweep({ config, stateDir, secrets, moduleDir: deps.env['ORCHESTRATOR_MODULE_DIR'], journalDir: deps.env['ORCHESTRATOR_JOURNAL_DIR'], now: deps.now() })
      for (const reason of result.refused) deps.err(`telemetry: a line was refused (${reason})`)
      deps.out(`sweep: ${result.sessions} session(s) without an end summarized, ${result.questions} round question(s) recorded, ${result.dispatches} dispatch(es) recorded`)
      return 0
    }
    default:
      deps.err(USAGE)
      return 2
  }
}

/** git under a deadline, never prompting for a credential. */
export const realGit: Git = (args, cwd) => {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? (result.error?.message ?? '') }
}

/** gh under a deadline, never prompting. */
export const realGh: Gh = args => {
  const result = spawnSync('gh', [...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: { ...process.env, GH_PROMPT_DISABLED: '1' } })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? (result.error?.message ?? '') }
}

/**
 * One of the tooling checkout's report scripts, as JSON, under a deadline. It runs only where
 * `scripts/<script>.ts` exists, so another project's own `prompts` or `rules` script is never run.
 * Its status is not read: a script that fails still printed its figures.
 */
export const realCheck: Check = (checkout, script) => {
  if (!existsSync(join(checkout, 'scripts', `${script}.ts`))) return { status: 1, stdout: '', stderr: `no scripts/${script}.ts in it, so it is not the tooling's checkout` }
  const result = spawnSync('npm', ['run', '-s', script, '--', '--json'], { cwd: checkout, encoding: 'utf8', timeout: GIT_TIMEOUT_MS })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr || (result.error?.message ?? '') }
}

/** The `owner/name` the git remotes of a directory name, if it is a clone of one. */
export const realRepositoryAt = (dir: string): string | undefined => {
  const result = realGit(remoteUrlsArgv(dir).slice(1), dir)
  return result.status === 0 ? firstRepository(result.stdout) : undefined
}

/** The automatic export, or the day's sweep, as a process of its own, which outlives the session that started it. */
export const realDetach = (config: string, work?: 'sweep'): void => {
  const sub = work === 'sweep' ? ['sweep', '--auto'] : ['export', '--auto', '--foreground']
  const argv = ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...sub, '--config', config]
  spawn(process.execPath, argv, { detached: true, stdio: 'ignore', env: process.env }).unref()
}

/* node:coverage ignore next 15 */
const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = run(process.argv.slice(2), {
    env: process.env,
    stdin: () => readFileSync(0, 'utf8'),
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
    git: realGit,
    now: Date.now,
    detach: realDetach,
    exportWaitMs: EXPORT_WAIT_MS,
    gh: realGh,
    check: realCheck,
    repositoryAt: realRepositoryAt,
    cwd: process.cwd(),
  })
}
