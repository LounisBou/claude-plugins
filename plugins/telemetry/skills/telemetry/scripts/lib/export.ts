// The export: the day files, and the transcripts of the sessions they name, committed to a local
// clone of the logs repository and pushed, after the scan of every day file finds no secret and
// every transcript is passed through the redaction. The repository is named only by the environment; its
// address never reaches an output, git's own messages included.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readText, update, withLock, writeAtomic } from '../../../../core/store.ts'
import { lockOf } from '../../../../core/store-io.ts'
import { EVENT_SCHEMA, type KindSpec } from '../../../../hooks/schema.ts'
import type { ArchiveItem, ArchiveSource } from './archive.ts'
import { buildManifest } from './manifest.ts'
import { check, dayFiles, eventsDir } from './store.ts'
import { redactText, redactValue, type EnvSecrets } from './redact.ts'
import { INDEX_DIR, PROJECTS_DIR, schemaFiles, type IndexFile } from './schema-docs.ts'

/** The directory of the repository that holds each machine's day files and transcripts. */
export const MACHINES_DIR = 'machines'

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
  /** What one export takes of the transcripts: the defaults, `MAX_TRANSCRIPT_BYTES` and `MAX_RUN_BYTES`, unless a caller passes another. */
  readonly limits?: { readonly transcriptBytes?: number; readonly runBytes?: number }
  /**
   * The files of closed work the orchestrator's module holds (`archive.ts`): they go to the repository
   * after the same scan, and leave this machine only once the push that carries them is done.
   */
  readonly archive?: ArchiveSource
  /** The time, in milliseconds, against which a transcript's age is read; the clock's unless a caller passes another. */
  readonly now?: () => number
  /** Called before each git command and each transcript: the export is alive, and goes on. */
  readonly heartbeat?: () => void
}

/**
 * The largest transcript the export takes, in bytes, of its file and of its redacted copy (masking
 * can lengthen a text): GitHub refuses a file over 100 MB and warns over 50 MB, and the file is read
 * whole into memory, then parsed and redacted at about 22 MB/s. Over it, the transcript is left out and named.
 */
export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024

/**
 * The most one export takes of the transcripts' files, in bytes: the first export meets about 6 GB,
 * and everything it takes goes in one push, held with `git add` and `git commit` to the deadline of
 * a git command (60 s, `GIT_TIMEOUT_MS`). The rest waits for the next export, and the day files never wait.
 */
export const MAX_RUN_BYTES = 256 * 1024 * 1024

/**
 * A transcript last written longer ago than this is not copied into the repository: the operator
 * keeps raw transcripts 90 days there, and the host keeps its own file longer (365 days), so a
 * transcript dropped by the yearly rewrite would otherwise be copied back. One the repository holds
 * already and whose file has not changed stays.
 */
export const MAX_TRANSCRIPT_AGE_DAYS = 90

export interface ExportResult {
  readonly lines: string[]
  readonly code: number
}

/**
 * A lock not refreshed for this long is a holder that died. A running export refreshes it before each git
 * command (bounded at 60 s, `GIT_TIMEOUT_MS`) and each transcript (bounded by `MAX_TRANSCRIPT_BYTES`: a read
 * and a redaction of seconds), so what must stay under it is the slowest of those steps, never the whole export.
 */
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
const transcriptPath = (machine: string, session: string): string => `${MACHINES_DIR}/${machine}/transcripts/${session}.jsonl`

/**
 * What stands for a line that is no JSON. Its text is never kept: a value of ~/.env sits in it as
 * JSON wrote it (`\"`, `\\`, `é`), so the redaction, which looks for the value itself, would
 * pass it, and a value cut short is no value at all.
 */
const NOT_JSON_MARK = '[REDACTED:not-json]'

/**
 * A transcript's text with every secret masked: each line parsed and each of its strings redacted
 * at any depth (the same redaction as an event, so a value of ~/.env or a token inside a message
 * is masked wherever it sits). Wrapped, so no field of the line is held to the shape of an event's
 * identifier. A line that is no JSON becomes a mark, and the text after the last newline, which
 * the host is still writing, is left for the export that finds it ended.
 */
export function redactTranscript(text: string, secrets: EnvSecrets): string {
  const lines = text.split('\n')
  lines.pop()
  return lines.map(line => {
    if (line.trim() === '') return `${line}\n`
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return `${NOT_JSON_MARK}\n`
    }
    return `${JSON.stringify((redactValue({ line: parsed }, secrets).value as { line: unknown }).line)}\n`
  }).join('')
}

/**
 * The index of the repository: the schema pages, the manifest of each day file of the store, and the
 * sessions those name. A manifest points at a session's transcript when `has` says the repository holds it.
 */
function indexFiles(options: ExportOptions, events: string, days: readonly string[], has: (session: string) => boolean): { files: IndexFile[]; sessions: Set<string> } {
  const sessions = new Set<string>()
  const projects = projectsOfSessions(days.map(name => readFileSync(join(events, name), 'utf8')))
  const files = [
    ...schemaFiles(options.kinds ?? EVENT_SCHEMA),
    ...days.map((name): IndexFile => {
      const day = name.slice(0, 10)
      const manifest = buildManifest({
        day,
        machine: options.machine,
        text: readFileSync(join(events, name), 'utf8'),
        transcript: session => {
          sessions.add(session)
          return has(session) ? transcriptPath(options.machine, session) : undefined
        },
      })
      return { path: `${INDEX_DIR}/${options.machine}/${day}.json`, text: `${JSON.stringify(manifest, null, 2)}\n` }
    }),
    ...days.flatMap(name => projectViews(options, name.slice(0, 10), readFileSync(join(events, name), 'utf8'), projects, has)),
  ]
  return { files, sessions }
}

/** A project's name as a directory name: `owner/name` becomes `owner-name`, in lower case (one repository written in two cases is one directory), and nothing else escapes the directory. */
export function projectDir(project: string): string {
  const name = project.replace(/[^A-Za-z0-9._-]/g, '-').toLowerCase()
  return /^\.+$/.test(name) ? '_' : name
}

/** The project each session names, over every day file: only its `session_start` carries it, and a session outlives a UTC day. */
function projectsOfSessions(texts: readonly string[]): Map<string, string> {
  const projects = new Map<string, string>()
  for (const line of texts.flatMap(text => text.split('\n'))) {
    try {
      const e = JSON.parse(line) as { session?: unknown; project?: unknown }
      if (typeof e.session === 'string' && typeof e.project === 'string') projects.set(e.session, e.project)
    } catch {
      // A line that is no JSON names no project.
    }
  }
  return projects
}

/**
 * A day's manifest once per project: the same manifest as the day's, built from the events of the
 * sessions that name that project (`projects`, read over every day), at `index/projects/<owner-name>/<machine>/<day>.json`.
 * A session naming none is in no project's view.
 */
function projectViews(options: ExportOptions, day: string, text: string, projects: ReadonlyMap<string, string>, has: (session: string) => boolean): IndexFile[] {
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const parsed = lines.map(line => {
    try {
      const e = JSON.parse(line) as { session?: unknown }
      return typeof e.session === 'string' ? e.session : undefined
    } catch {
      return undefined
    }
  })
  const byDirectory = new Map<string, string[]>()
  parsed.forEach((session, i) => {
    const project = session === undefined ? undefined : projects.get(session)
    if (project === undefined) return
    const directory = projectDir(project)
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), lines[i] ?? ''])
  })
  return [...byDirectory].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([directory, own]): IndexFile => ({
    path: `${PROJECTS_DIR}/${directory}/${options.machine}/${day}.json`,
    text: `${JSON.stringify(buildManifest({ day, machine: options.machine, text: own.join('\n'), transcript: session => (has(session) ? transcriptPath(options.machine, session) : undefined) }), null, 2)}\n`,
  }))
}

/** The secrets an index would carry, one line each; none when it is clean. */
const leaksOf = (index: readonly IndexFile[], secrets: EnvSecrets): string[] =>
  index.flatMap(file => [...new Set(redactText(file.text, secrets).hits)].map(pattern => `  ${file.path}: ${pattern}`))

const refusal = (leaks: readonly string[]): ExportResult => ({ lines: [`export refused: the index would carry ${leaks.length} secret(s), nothing pushed`, ...leaks], code: 1 })

/** Replaces the generated index of `machine` in the clone: schema pages, the machine's manifests and its slice of each project's view, nothing stale left. */
function writeIndex(clone: string, machine: string, files: readonly IndexFile[]): void {
  rmSync(join(clone, INDEX_DIR, 'schema'), { recursive: true, force: true })
  rmSync(join(clone, INDEX_DIR, machine), { recursive: true, force: true })
  const projects = join(clone, PROJECTS_DIR)
  if (existsSync(projects)) for (const project of readdirSync(projects)) rmSync(join(projects, project, machine), { recursive: true, force: true })
  for (const file of files) {
    const path = join(clone, file.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.text)
  }
}

/** Why a read or a write failed, as the error's code. */
const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? 'unreadable'

/** What a transcript's file was when its copy was pushed: unchanged, it is not read again. */
interface Stamp {
  readonly size: number
  readonly mtimeMs: number
}

const STAMPS_FILE = 'export-transcripts.json'

/** The stamps of the copies pushed, by session; none when the file is absent or no stamps (everything is then copied again). */
function readStamps(stateDir: string): Map<string, Stamp> {
  const stamps = new Map<string, Stamp>()
  let parsed: unknown
  try {
    parsed = JSON.parse(readText(join(stateDir, STAMPS_FILE)) ?? '{}')
  } catch {
    return stamps
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return stamps
  for (const [session, entry] of Object.entries(parsed)) {
    const { size, mtimeMs } = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    if (typeof size === 'number' && typeof mtimeMs === 'number') stamps.set(session, { size, mtimeMs })
  }
  return stamps
}

const writeStamps = (stateDir: string, stamps: ReadonlyMap<string, Stamp>): void => writeAtomic(join(stateDir, STAMPS_FILE), `${JSON.stringify(Object.fromEntries(stamps))}\n`)

interface Copied {
  /** The sessions whose transcript is in the repository after this export. */
  readonly exported: ReadonlySet<string>
  /** The sessions whose transcript file is here. */
  readonly offered: ReadonlySet<string>
  /** Transcripts written to the clone. */
  readonly written: number
  /** The stamp of each exported session's file. */
  readonly stamps: ReadonlyMap<string, Stamp>
  /** What to say of the transcripts left out, for the result. */
  readonly notes: readonly string[]
}

/**
 * Copies the redacted transcript of each session whose file is here into the clone. A transcript that
 * cannot be read or redacted, or is over the size cap, is skipped and named; one beyond the run's bound
 * waits for the next export; one the repository holds and whose file has not changed since is left as
 * it is. None holds the day files back. Answers what was copied, or the line of a failure of the clone itself.
 */
function copyTranscripts(options: ExportOptions, clone: string, sessions: ReadonlySet<string>, stamped: ReadonlyMap<string, Stamp>, held: ReadonlySet<string>): Copied | string {
  const cap = options.limits?.transcriptBytes ?? MAX_TRANSCRIPT_BYTES
  const bound = options.limits?.runBytes ?? MAX_RUN_BYTES
  const exported = new Set<string>()
  const offered = new Set<string>()
  const stamps = new Map<string, Stamp>()
  const notes: string[] = []
  let written = 0
  let taken = 0
  let waiting = 0
  let waitingBytes = 0
  let old = 0
  const oldest = (options.now ?? Date.now)() - MAX_TRANSCRIPT_AGE_DAYS * 86_400_000
  for (const session of [...sessions].sort()) {
    options.heartbeat?.()
    const source = options.transcript?.(session)
    if (source === undefined) continue
    offered.add(session)
    const skip = (reason: string): void => void notes.push(`export: transcript ${session} skipped (${reason})`)
    let stamp: Stamp
    try {
      const { size, mtimeMs } = statSync(source)
      stamp = { size, mtimeMs }
    } catch (error) {
      skip(codeOf(error))
      continue
    }
    const path = transcriptPath(options.machine, session)
    const before = stamped.get(session)
    if (before?.size === stamp.size && before.mtimeMs === stamp.mtimeMs && held.has(path)) {
      exported.add(session)
      stamps.set(session, stamp)
      continue
    }
    if (stamp.mtimeMs < oldest) {
      old++
      continue
    }
    if (stamp.size > cap) {
      skip(`too large: ${stamp.size} bytes, over ${cap}`)
      continue
    }
    if (taken > 0 && taken + stamp.size > bound) {
      waiting++
      waitingBytes += stamp.size
      continue
    }
    taken += stamp.size
    let text: string
    try {
      text = readFileSync(source, 'utf8')
    } catch (error) {
      skip(codeOf(error))
      continue
    }
    let redacted: string
    try {
      redacted = redactTranscript(text, options.secrets)
    } catch (error) {
      skip(`redaction failed: ${error instanceof Error ? error.name : 'error'}`)
      continue
    }
    const length = Buffer.byteLength(redacted)
    if (length > cap) {
      skip(`too large once redacted: ${length} bytes, over ${cap}`)
      continue
    }
    try {
      const file = join(clone, path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, redacted)
    } catch (error) {
      return `export failed at transcript ${session} (${codeOf(error)})`
    }
    exported.add(session)
    stamps.set(session, stamp)
    written++
  }
  if (old > 0) notes.push(`export: ${old} transcript(s) last written over ${MAX_TRANSCRIPT_AGE_DAYS} days ago left out`)
  if (waiting > 0) notes.push(`export: ${waiting} transcript(s) left for the next export (${waitingBytes} bytes; a run takes up to ${bound})`)
  return { exported, offered, written, stamps, notes }
}

/** The archive's plan; a failure to make it is said, and the export goes on without an archive. */
function planOf(options: ExportOptions, machine: string): { readonly items: readonly ArchiveItem[]; readonly kept: number; readonly notes: readonly string[] } {
  try {
    return options.archive?.(machine, (options.now ?? Date.now)()) ?? { items: [], kept: 0, notes: [] }
  } catch (error) {
    return { items: [], kept: 0, notes: [`export: the archive was skipped (${codeOf(error)})`] }
  }
}

/** What the archive scan leaves of a plan: the files to export, those it holds back, and what to say of them. */
interface Scanned {
  readonly items: readonly ArchiveItem[]
  readonly kept: number
  readonly notes: readonly string[]
}

/** Every string, key or value, of the JSON a text holds whole or line by line: a value the text stores escaped is read as it is. */
function jsonStrings(body: string): string[] {
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        out.push(key)
        walk(item)
      }
    }
  }
  try {
    walk(JSON.parse(body))
    return out
  } catch { /* not one document: its lines may each be one */ }
  for (const line of body.split('\n')) {
    if (line === '') continue
    try {
      walk(JSON.parse(line))
    } catch { /* a line that is no JSON is read as the text it is */ }
  }
  return out
}

/**
 * The plan's files held to the secret scan, as the index is: one with a hit stays where it is and
 * is named with the patterns it matched, never a value; the rest are exported.
 */
function scanArchive(plan: { readonly items: readonly ArchiveItem[]; readonly kept: number; readonly notes: readonly string[] }, secrets: EnvSecrets): Scanned {
  const items: ArchiveItem[] = []
  const notes = [...plan.notes]
  let kept = plan.kept
  for (const item of plan.items) {
    const body = item.body.toString('utf8')
    const hits = [...new Set([...redactText(body, secrets).hits, ...jsonStrings(body).flatMap(each => redactText(each, secrets).hits)])]
    if (hits.length === 0) {
      items.push(item)
      continue
    }
    kept++
    notes.push(`export: ${item.rel} left in place (secret pattern: ${hits.join(', ')})`)
  }
  return { items, kept, notes }
}

/**
 * Writes the archive's files into the clone. A ledger month joins the lines the repository holds
 * of it already, in their order, each once: the lines that left the machine earlier are not here.
 * A file that cannot be written is left out and named; the day files never wait on it.
 */
function writeArchive(clone: string, scanned: Scanned): Scanned {
  const items: ArchiveItem[] = []
  const notes = [...scanned.notes]
  for (const item of scanned.items) {
    try {
      const file = join(clone, item.rel)
      mkdirSync(dirname(file), { recursive: true })
      if (item.lines === undefined) {
        writeFileSync(file, item.body)
      } else {
        const held = (readText(file) ?? '').split('\n').filter(line => line !== '')
        writeFileSync(file, `${[...new Set([...held, ...item.lines])].join('\n')}\n`)
      }
      items.push(item)
    } catch (error) {
      notes.push(`export: ${item.rel} left in place (not written to the clone: ${codeOf(error)})`)
    }
  }
  return { items, kept: scanned.kept + scanned.items.length - items.length, notes }
}

/** What leaving the machine came to: how many files went, and why each of the others, pushed all the same, stays. */
interface Removal {
  readonly removed: number
  /** The files pushed that a live session still reads: copied, never removed. */
  readonly copied: number
  readonly stays: readonly string[]
}

/**
 * Removes from this machine the archive's files the repository holds, as pushed: the clone's HEAD is
 * what the remote has (the push was done, or nothing was left to push), the file is in its tree and
 * its bytes are the local file's, and the same plan made again still names it. A ledger month's
 * lines leave their archive under its lock, the lines that came in meanwhile staying. A file that
 * stays is named with its reason, and the next export tries it again.
 */
function removeArchived(options: ExportOptions, git: Git, clone: string, items: readonly ArchiveItem[], machine: string): Removal {
  if (items.length === 0) return { removed: 0, copied: 0, stays: [] }
  const roots = [...new Set(items.map(item => item.rel.split('/')[0] ?? ''))]
  // NUL-separated: git quotes a name with a non-ASCII or control character otherwise.
  const listed = git(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...roots], clone)
  if (listed.status !== 0) return { removed: 0, copied: items.filter(item => item.stays !== undefined).length, stays: items.filter(item => item.stays === undefined).map(item => `export: ${item.rel} stays on this machine (the repository's tree could not be listed)`) }
  const held = new Set(listed.stdout.split('\0'))
  const still = new Set(planOf(options, machine).items.map(item => item.rel))
  let removed = 0
  let copied = 0
  const stays: string[] = []
  for (const item of items) {
    options.heartbeat?.()
    if (item.stays !== undefined) {
      copied++
      continue
    }
    const stay = (reason: string): void => void stays.push(`export: ${item.rel} stays on this machine (${reason})`)
    if (!held.has(item.rel)) {
      stay('not in the repository\'s tree')
      continue
    }
    if (!still.has(item.rel)) {
      stay('no longer a closed row\'s alone')
      continue
    }
    try {
      if (item.lines === undefined) {
        if (!readFileSync(item.source).equals(readFileSync(join(clone, item.rel)))) {
          stay('changed since it was copied')
          continue
        }
        rmSync(item.source)
        if (item.dir !== undefined) {
          try {
            rmdirSync(item.dir)
          } catch { /* the directory still holds a file that stays */ }
        }
      } else {
        const gone = new Set(item.lines)
        if (!existsSync(item.source)) continue
        update(item.source, current => (current ?? '').split('\n').filter(line => line !== '' && !gone.has(line)).map(line => `${line}\n`).join(''))
      }
      removed++
    } catch (error) {
      stay(`not removed: ${codeOf(error)}`)
    }
  }
  return { removed, copied, stays }
}

/** The archive's line of the result: files exported, removed from this machine, kept (those held back, and those pushed that stay); and what was said of each. */
function archiveLines(scanned: Scanned, removal: Removal): string[] {
  if (scanned.items.length + scanned.kept === 0) return []
  return [`export: archive: ${scanned.items.length} file(s) exported, ${removal.removed} removed from this machine, ${scanned.kept + removal.copied + removal.stays.length} kept`, ...scanned.notes, ...removal.stays]
}

/** Exports the store; answers the lines to print and the exit code. */
export function exportStore(options: ExportOptions): ExportResult {
  const { stateDir, secrets, repo, machine } = options
  const git: Git = (args, cwd) => {
    options.heartbeat?.()
    return options.git(args, cwd)
  }
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
  let scanned = scanArchive(planOf(options, machine), secrets)
  if (days.length === 0 && scanned.items.length === 0) return { lines: ['export: no event recorded yet, nothing pushed', ...archiveLines(scanned, { removed: 0, copied: 0, stays: [] })], code: 0 }
  // The index is generated from the same events, and held to the same scan before anything is cloned:
  // as planned, every transcript here in the repository; it is made again once the copy says which are.
  const planned = indexFiles(options, events, days, session => options.transcript?.(session) !== undefined)
  const leaks = leaksOf(planned.files, secrets)
  if (leaks.length > 0) return refusal(leaks)
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
  const target = join(clone, MACHINES_DIR, machine)
  mkdirSync(target, { recursive: true })
  for (const day of days) copyFileSync(join(events, day), join(target, day))
  // The copies the repository holds now: a transcript is left alone only when its copy is there and its file is as pushed.
  const listed = git(['ls-tree', '-r', '--name-only', 'HEAD', '--', `${MACHINES_DIR}/${machine}/transcripts`], clone)
  const held = new Set(listed.status === 0 ? listed.stdout.split('\n') : [])
  const stamped = readStamps(stateDir)
  const copied = copyTranscripts(options, clone, planned.sessions, stamped, held)
  if (typeof copied === 'string') return { lines: [copied], code: 1 }
  const counted = `${days.length} day file(s)${copied.written > 0 ? ` and ${copied.written} transcript(s)` : ''}${scanned.items.length > 0 ? `, ${scanned.items.length} archived file(s)` : ''}`
  let index = planned.files
  if (copied.exported.size < copied.offered.size) {
    // A manifest points at the transcript the repository holds, never at one that was skipped.
    index = indexFiles(options, events, days, session => copied.exported.has(session)).files
    const again = leaksOf(index, secrets)
    if (again.length > 0) return refusal(again)
  }
  // With no day file the machine's index is not rewritten: what the repository holds of it stays.
  if (days.length > 0) writeIndex(clone, machine, index)
  scanned = writeArchive(clone, scanned)
  const projects = [...new Set(scanned.items.map(item => item.rel.split('/')[0] ?? ''))]
  // Forced: an ignore rule of the clone or the machine matching a day file would leave it out unsaid.
  const added = git(['add', '--force', '--', ...[join(MACHINES_DIR, machine), INDEX_DIR, ...projects].filter(path => existsSync(join(clone, path)))], clone)
  if (added.status !== 0) return fail('add', added)
  if (git(['diff', '--cached', '--quiet'], clone).status !== 0) {
    const committed = git(['commit', '--quiet', '-m', `chore(telemetry): ${machine}, ${counted} up to ${days[days.length - 1]?.slice(0, 10) ?? ''}`], clone)
    if (committed.status !== 0) return fail('commit', committed)
  } else if (!unpushed(git, clone)) {
    writeStamps(stateDir, new Map([...stamped, ...copied.stamps]))
    const gone = removeArchived(options, git, clone, scanned.items, machine)
    return { lines: ['export: the logs repository already holds every event, nothing pushed', ...copied.notes, ...archiveLines(scanned, gone)], code: 0 }
  }
  // HEAD now holds a commit main lacks: the new files, or a former export's commit whose push was refused.
  const sent = git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], clone)
  if (sent.status !== 0) return fail('push', sent)
  writeStamps(stateDir, new Map([...stamped, ...copied.stamps]))
  const gone = removeArchived(options, git, clone, scanned.items, machine)
  return { lines: [`export: ${counted} of ${machine} pushed to the logs repository`, ...copied.notes, ...archiveLines(scanned, gone)], code: 0 }
}

/** Marks `lock` as held a moment longer: its age is what tells a holder that died from one that works. */
function refreshLock(lock: string): void {
  try {
    const now = new Date()
    utimesSync(lock, now, now)
  } catch (error) {
    // The lock is gone (taken over, or removed): there is nothing to refresh, and the export is not the one to say so.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
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
  const name = join(options.stateDir, 'export')
  try {
    return withLock(name, () => {
      if (lock.when?.() === false) return { lines: [], code: 0, busy: false, skipped: true as const }
      const heartbeat = (): void => {
        refreshLock(lockOf(name))
        options.heartbeat?.()
      }
      return { ...exportStore({ ...options, heartbeat }), busy: false }
    }, { waitMs: lock.waitMs, staleMs: EXPORT_LOCK_STALE_MS })
  } catch (error) {
    if (error instanceof Error && /stayed locked/.test(error.message)) return { lines: ['export: another export is running, nothing pushed'], code: 1, busy: true }
    throw error
  }
}
