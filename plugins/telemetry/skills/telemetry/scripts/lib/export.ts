// The export: the day files committed to a local clone of the logs repository and pushed, after
// the scan of every file finds no secret. The repository is named only by the environment; its
// address never reaches an output, git's own messages included.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { check, dayFiles, eventsDir } from './store.ts'
import { redactText, type EnvSecrets } from './redact.ts'

/** The variable that names the logs repository, in the environment or in ~/.env. */
export const REPO_VARIABLE = 'CLAUDE_LOGS_REPO'

export interface GitResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs git with `args` in `cwd` (undefined: the caller's directory). */
export type Git = (args: readonly string[], cwd?: string) => GitResult

export interface ExportOptions {
  readonly stateDir: string
  readonly secrets: EnvSecrets
  readonly repo: string | undefined
  readonly machine: string
  readonly git: Git
}

/** The logs repository: the environment's value, else ~/.env's. */
export function logsRepo(env: Readonly<Record<string, string | undefined>>, secrets: EnvSecrets): string | undefined {
  const value = env[REPO_VARIABLE] || secrets.get(REPO_VARIABLE)
  return value === undefined || value === '' ? undefined : value
}

/** A machine's directory name in the repository: letters, digits and dashes. */
export function machineName(raw: string): string {
  return raw.split('.')[0]?.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'machine'
}

/** Git's output made safe to print: the repository's address hidden, then every secret. */
export function safeOutput(output: string, repo: string, secrets: EnvSecrets): string {
  return redactText(output.split(repo).join('<logs repository>'), secrets).text.trim()
}

/** Exports the store; answers the lines to print and the exit code. */
export function exportStore(options: ExportOptions): { lines: string[]; code: number } {
  const { stateDir, secrets, repo, machine, git } = options
  const events = eventsDir(stateDir)
  if (repo === undefined) return { lines: [`export: ${REPO_VARIABLE} is not set; the events stay local in ${events}, nothing pushed`], code: 0 }
  const findings = check(events, secrets)
  if (findings.length > 0) {
    return {
      lines: [`export refused: ${findings.length} secret(s) found in the store, nothing pushed`, ...findings.map(f => `  ${f.file}:${f.line}: ${f.pattern}`)],
      code: 1,
    }
  }
  const days = dayFiles(events)
  if (days.length === 0) return { lines: ['export: no event recorded yet, nothing pushed'], code: 0 }
  const clone = join(stateDir, 'export')
  const fail = (step: string, result: GitResult): { lines: string[]; code: number } => ({
    lines: [`export failed at ${step} (git exit ${result.status}): ${safeOutput(`${result.stderr}\n${result.stdout}`, repo, secrets)}`],
    code: 1,
  })
  if (!existsSync(join(clone, '.git'))) {
    const cloned = git(['clone', '--quiet', repo, clone])
    if (cloned.status !== 0) return fail('clone', cloned)
  } else {
    // A clone made for an earlier value of the variable pushes to the repository named now.
    const pointed = git(['remote', 'set-url', 'origin', repo], clone)
    if (pointed.status !== 0) return fail('remote set-url', pointed)
  }
  const fetched = git(['fetch', '--quiet', 'origin'], clone)
  if (fetched.status !== 0) return fail('fetch', fetched)
  if (git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], clone).status === 0) {
    const reset = git(['checkout', '--quiet', '-B', 'main', 'origin/main'], clone)
    if (reset.status !== 0) return fail('checkout', reset)
  } else {
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], clone)
  }
  const target = join(clone, 'machines', machine)
  mkdirSync(target, { recursive: true })
  for (const day of days) copyFileSync(join(events, day), join(target, day))
  const added = git(['add', '--', join('machines', machine)], clone)
  if (added.status !== 0) return fail('add', added)
  if (git(['diff', '--cached', '--quiet'], clone).status === 0) return { lines: ['export: the logs repository already holds every event, nothing pushed'], code: 0 }
  const committed = git(['commit', '--quiet', '-m', `chore(telemetry): ${machine}, ${days.length} day file(s) up to ${days[days.length - 1]?.slice(0, 10) ?? ''}`], clone)
  if (committed.status !== 0) return fail('commit', committed)
  const pushed = git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], clone)
  if (pushed.status !== 0) return fail('push', pushed)
  return { lines: [`export: ${days.length} day file(s) of ${machine} pushed to the logs repository`], code: 0 }
}
