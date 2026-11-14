// telemetry — the writer and the exporter of the session events.
//
//   telemetry.ts append   --config <dir>                  JSON lines on stdin, redacted, appended
//   telemetry.ts check    --config <dir>                  the scan of the store; exit 1 on a finding
//   telemetry.ts export   --config <dir>                  check, then commit and push to the logs repository
//   telemetry.ts export   --auto [--foreground] --config <dir>
//                                                         the export a session's end starts: at most once a day,
//                                                         detached unless --foreground
//   telemetry.ts backfill --config <dir> <transcript>...  one session_summary per past transcript
//
// <dir> is the host's configuration directory; the store is <dir>/telemetry. The operator's
// ~/.env (TELEMETRY_ENV_FILE in tests) is read for its secrets, which never leave this process.
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeEvent, type Event } from '../../../hooks/collect.ts'
import { runAuto } from './lib/auto.ts'
import { exportExclusive, logsRepo, machineName, type Git } from './lib/export.ts'
import { parseEnvFile, type EnvSecrets } from './lib/redact.ts'
import { append, check, eventsDir, parseEvent } from './lib/store.ts'
import { summarizeFile, transcriptOf } from './lib/transcript.ts'

export const USAGE = 'usage: telemetry.ts {append|check|export [--auto [--foreground]]|backfill} --config <dir> [<transcript>...]'

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
  /** Starts `export --auto --foreground` for `config` as a detached process. */
  readonly detach: (config: string) => void
  readonly exportWaitMs: number
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

/** Where a session's transcript is, relative to the configuration directory; undefined when it is gone. */
export function transcriptPointer(config: string, session: string): string | undefined {
  const path = transcriptOf(config, session)
  return path === undefined ? undefined : relative(config, path)
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
    transcript: (session: string) => transcriptPointer(config, session),
  })
  switch (sub) {
    case 'append': {
      const raw = deps.stdin().split('\n').filter(line => line.trim() !== '')
      const lines = raw.map(line => enrich(line, config)).join('\n')
      const { refused } = append(eventsDir(stateDir), lines, secrets)
      for (const reason of refused) deps.err(`telemetry: a line was refused (${reason})`)
      if (raw.some(line => endsSession(line))) {
        // A session's end is the export's trigger; it never fails the write.
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

/** The automatic export as a process of its own, which outlives the session that started it. */
export const realDetach = (config: string): void => {
  const argv = ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), 'export', '--auto', '--foreground', '--config', config]
  spawn(process.execPath, argv, { detached: true, stdio: 'ignore', env: process.env }).unref()
}

/* node:coverage ignore next 14 */
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
  })
}
