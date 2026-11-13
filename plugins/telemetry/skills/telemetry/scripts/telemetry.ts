// telemetry — the writer and the exporter of the session events.
//
//   telemetry.ts append   --config <dir>                  JSON lines on stdin, redacted, appended
//   telemetry.ts check    --config <dir>                  the scan of the store; exit 1 on a finding
//   telemetry.ts export   --config <dir>                  check, then commit and push to the logs repository
//   telemetry.ts backfill --config <dir> <transcript>...  one session_summary per past transcript
//
// <dir> is the host's configuration directory; the store is <dir>/telemetry. The operator's
// ~/.env (TELEMETRY_ENV_FILE in tests) is read for its secrets, which never leave this process.
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeEvent, type Event } from '../../../hooks/collect.ts'
import { exportStore, logsRepo, machineName, type Git } from './lib/export.ts'
import { parseEnvFile, type EnvSecrets } from './lib/redact.ts'
import { append, check, eventsDir, parseEvent } from './lib/store.ts'
import { summarizeFile, transcriptOf } from './lib/transcript.ts'

export const USAGE = 'usage: telemetry.ts {append|check|export|backfill} --config <dir> [<transcript>...]'

/** A git command is never left running past this. */
export const GIT_TIMEOUT_MS = 60_000

export interface Deps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdin: () => string
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly git: Git
  readonly now: () => number
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
  switch (sub) {
    case 'append': {
      const lines = deps.stdin().split('\n').filter(line => line.trim() !== '').map(line => enrich(line, config)).join('\n')
      const { refused } = append(eventsDir(stateDir), lines, secrets)
      for (const reason of refused) deps.err(`telemetry: a line was refused (${reason})`)
      return 0
    }
    case 'check': {
      const findings = check(eventsDir(stateDir), secrets)
      for (const f of findings) deps.out(`${f.file}:${f.line}: ${f.pattern}`)
      deps.out(findings.length === 0 ? 'check: no secret found' : `check: ${findings.length} finding(s)`)
      return findings.length === 0 ? 0 : 1
    }
    case 'export': {
      const machine = machineName(deps.env['TELEMETRY_MACHINE'] || hostname())
      const result = exportStore({ stateDir, secrets, repo: logsRepo(deps.env, secrets), machine, git: deps.git })
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

/* node:coverage ignore next 12 */
const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = run(process.argv.slice(2), {
    env: process.env,
    stdin: () => readFileSync(0, 'utf8'),
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
    git: realGit,
    now: Date.now,
  })
}
