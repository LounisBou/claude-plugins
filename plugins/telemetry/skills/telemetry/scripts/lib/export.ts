// The export: the day files, and the transcripts of the sessions they name, committed to a local
// clone of the logs repository and pushed, after the scan of every day file finds no secret and
// every transcript is passed through the redaction. The repository is named only by the environment; its
// address never reaches an output, git's own messages included.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withLock } from '../../../../core/store.ts'
import { EVENT_SCHEMA, type KindSpec } from '../../../../hooks/schema.ts'
import { buildManifest } from './manifest.ts'
import { check, dayFiles, eventsDir } from './store.ts'
import { redactText, redactValue, type EnvSecrets } from './redact.ts'
import { INDEX_DIR, schemaFiles, type IndexFile } from './schema-docs.ts'

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
  /** The kinds the index documents: the declared list unless a caller passes another. */
  readonly kinds?: Readonly<Record<string, KindSpec>>
  /** The file of a session's transcript on this machine; undefined when it is gone. Its redacted copy goes to the repository. */
  readonly transcript?: (session: string) => string | undefined
}

export interface ExportResult {
  readonly lines: string[]
  readonly code: number
}

/** A lock older than this is a holder that died: longer than the slowest export (every git command is bounded). */
export const EXPORT_LOCK_STALE_MS = 600_000

/** The logs repository: the environment's value, else ~/.env's. */
export function logsRepo(env: Readonly<Record<string, string | undefined>>, secrets: EnvSecrets): string | undefined {
  const value = env[REPO_VARIABLE] || secrets.get(REPO_VARIABLE)
  return value === undefined || value === '' ? undefined : value
}

/** A machine's directory name in the repository: letters, digits and dashes. */
export function machineName(raw: string): string {
  return raw.split('.')[0]?.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'machine'
}

/**
 * The forms git prints the repository's address in, longest first: as given, without its
 * credentials (`https://host/owner/name.git/` in an error), without `.git`, and its path.
 */
export function addressForms(repo: string): string[] {
  const bare = repo.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1')
  const path = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(bare)?.[1] ?? /^(?:[^@/:]+@)?[^/:]+:(?!\/)(.+)$/.exec(bare)?.[1]
  const forms = [repo, bare, ...(path?.includes('/') === true ? [path] : [])].flatMap(form => [form, form.replace(/\.git\/?$/, '')])
  return [...new Set(forms)].filter(form => form !== '').sort((a, b) => b.length - a.length)
}

/** Git's output made safe to print: the repository's address hidden in each of its forms, then every secret. */
export function safeOutput(output: string, repo: string, secrets: EnvSecrets): string {
  const hidden = addressForms(repo).reduce((out, form) => out.split(form).join('<logs repository>'), output)
  return redactText(hidden, secrets).text.trim()
}

/** Whether the clone holds a commit `origin/main` lacks: absent there, or another one. */
function unpushed(git: Git, clone: string): boolean {
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], clone)
  if (head.status !== 0) return false
  const remote = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], clone)
  return remote.status !== 0 || remote.stdout.trim() !== head.stdout.trim()
}

/** Where a session's transcript is in the repository, relative to its root. */
const transcriptPath = (machine: string, session: string): string => `machines/${machine}/transcripts/${session}.jsonl`

/**
 * A transcript's text with every secret masked: each line parsed and each of its strings redacted
 * at any depth (the same redaction as an event, so a value of ~/.env or a token inside a message
 * is masked wherever it sits), a line that is no JSON redacted as text. Wrapped, so no field of
 * the line is held to the shape of an event's identifier.
 */
export function redactTranscript(text: string, secrets: EnvSecrets): string {
  return text.split('\n').map(line => {
    if (line.trim() === '') return line
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return redactText(line, secrets).text
    }
    return JSON.stringify((redactValue({ line: parsed }, secrets).value as { line: unknown }).line)
  }).join('\n')
}

/** The index of the repository: the schema pages, the manifest of each day file of the store, and the sessions those name. */
function indexFiles(options: ExportOptions, events: string, days: readonly string[]): { files: IndexFile[]; sessions: Set<string> } {
  const transcript = options.transcript
  const sessions = new Set<string>()
  const files = [
    ...schemaFiles(options.kinds ?? EVENT_SCHEMA),
    ...days.map((name): IndexFile => {
      const day = name.slice(0, 10)
      const manifest = buildManifest({
        day,
        machine: options.machine,
        text: readFileSync(join(events, name), 'utf8'),
        // The manifest points at the copy the export makes, for a session whose transcript is here.
        transcript: session => {
          sessions.add(session)
          return transcript?.(session) === undefined ? undefined : transcriptPath(options.machine, session)
        },
      })
      return { path: `${INDEX_DIR}/${options.machine}/${day}.json`, text: `${JSON.stringify(manifest, null, 2)}\n` }
    }),
  ]
  return { files, sessions }
}

/** Replaces the generated index of `machine` in the clone: schema pages and the machine's manifests, nothing stale left. */
function writeIndex(clone: string, machine: string, files: readonly IndexFile[]): void {
  rmSync(join(clone, INDEX_DIR, 'schema'), { recursive: true, force: true })
  rmSync(join(clone, INDEX_DIR, machine), { recursive: true, force: true })
  for (const file of files) {
    const path = join(clone, file.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.text)
  }
}

/** Copies the redacted transcript of each session whose file is here into the clone; answers how many, or the line of the failure. */
function copyTranscripts(options: ExportOptions, clone: string, sessions: ReadonlySet<string>): number | string {
  let copied = 0
  for (const session of [...sessions].sort()) {
    const source = options.transcript?.(session)
    if (source === undefined) continue
    let text: string
    try {
      text = readFileSync(source, 'utf8')
    } catch (error) {
      return `export failed at transcript ${session} (${(error as NodeJS.ErrnoException).code ?? 'unreadable'})`
    }
    const path = join(clone, transcriptPath(options.machine, session))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, redactTranscript(text, options.secrets))
    copied++
  }
  return copied
}

/** Exports the store; answers the lines to print and the exit code. */
export function exportStore(options: ExportOptions): ExportResult {
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
  // The index is generated from the same events, and held to the same scan before anything is cloned.
  const { files: index, sessions } = indexFiles(options, events, days)
  const leaks = index.flatMap(file => [...new Set(redactText(file.text, secrets).hits)].map(pattern => `  ${file.path}: ${pattern}`))
  if (leaks.length > 0) return { lines: [`export refused: the index would carry ${leaks.length} secret(s), nothing pushed`, ...leaks], code: 1 }
  const clone = join(stateDir, 'export')
  const fail = (step: string, result: GitResult): ExportResult => ({
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
  const copied = copyTranscripts(options, clone, sessions)
  if (typeof copied === 'string') return { lines: [copied], code: 1 }
  const counted = `${days.length} day file(s)${copied > 0 ? ` and ${copied} transcript(s)` : ''}`
  writeIndex(clone, machine, index)
  // Forced: an ignore rule of the clone or the machine matching a day file would leave it out unsaid.
  const added = git(['add', '--force', '--', join('machines', machine), INDEX_DIR], clone)
  if (added.status !== 0) return fail('add', added)
  if (git(['diff', '--cached', '--quiet'], clone).status !== 0) {
    const committed = git(['commit', '--quiet', '-m', `chore(telemetry): ${machine}, ${counted} up to ${days[days.length - 1]?.slice(0, 10) ?? ''}`], clone)
    if (committed.status !== 0) return fail('commit', committed)
  } else if (!unpushed(git, clone)) {
    return { lines: ['export: the logs repository already holds every event, nothing pushed'], code: 0 }
  }
  // HEAD now holds a commit main lacks: the new files, or a former export's commit whose push was refused.
  const pushed = git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], clone)
  if (pushed.status !== 0) return fail('push', pushed)
  return { lines: [`export: ${counted} of ${machine} pushed to the logs repository`], code: 0 }
}

/**
 * The export, one at a time on this machine: it takes the lock beside the clone and waits for it up to
 * `waitMs`. A holder is a session's export running; when the lock stays held, nothing is pushed.
 * `when`, asked once the lock is held, declines the export by answering false (`skipped`).
 */
export function exportExclusive(
  options: ExportOptions,
  lock: { readonly waitMs: number; readonly when?: () => boolean },
): ExportResult & { readonly busy: boolean; readonly skipped?: true } {
  try {
    return withLock(join(options.stateDir, 'export'), () => {
      if (lock.when?.() === false) return { lines: [], code: 0, busy: false, skipped: true as const }
      return { ...exportStore(options), busy: false }
    }, { waitMs: lock.waitMs, staleMs: EXPORT_LOCK_STALE_MS })
  } catch (error) {
    if (error instanceof Error && /stayed locked/.test(error.message)) return { lines: ['export: another export is running, nothing pushed'], code: 1, busy: true }
    throw error
  }
}
