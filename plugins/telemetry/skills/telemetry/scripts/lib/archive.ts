// The files of closed work, sorted for the logs repository: what the orchestrator's module keeps
// of a row once it is closed (its brief, its report, its review index), the pull request ledger's
// archive lines and the round's archived questions, each placed at
// `<project>/<YYYY-MM>/<machine>/<kind>/<name>`. This module only reads the module's directory and
// says what goes where; the export (`export.ts`) scans, commits, pushes and, once the push is
// done, removes. A file no closed row names, or one an open row names, is never in the plan.
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { orchForm, parseSessionName } from '../../../../core/names.ts'
import { RECORDS_DIR, ROUND_ARCHIVE_DIR, ROUND_DIR } from '../../../../core/orchestration.ts'
import { archiveOf } from '../../../../core/pr-ledger.ts'
import { parseRoundQuestion } from '../../../../core/round-question.ts'
import { MACHINES_DIR, projectDir } from './export.ts'
import { record, text } from './manifest.ts'
import { INDEX_DIR } from './schema-docs.ts'

/** The orchestrator module's directory of briefs, one directory per project, each with its dispatch record. */
export const BRIEFS_DIR = 'briefs'

/** A project's dispatch record, in its directory of briefs. */
export const RECORD_FILE = 'dispatch-record.jsonl'

/** The largest file the archive takes; over it the file stays where it is. */
export const MAX_ARCHIVE_FILE_BYTES = 8 * 1024 * 1024

/** A closed row's files wait this long after its close: the session that closed it, or its successor, still reads the report. */
export const SETTLE_MS = 24 * 60 * 60 * 1000

/** The directory of a round question whose asker names no project. */
export const UNSORTED = '_unsorted'

export interface ArchiveItem {
  /** Where the file goes in the logs repository, relative to its root. */
  readonly rel: string
  /** The local file it comes from; for a ledger month, the archive file its lines leave. */
  readonly source: string
  readonly body: Buffer
  /** A ledger month: the archive's lines it holds, which leave the file once pushed. */
  readonly lines?: readonly string[]
  /** The directory (a review's) that goes once its last file has. */
  readonly dir?: string
  /** Copied to the repository, never removed: a live session still reads the file where it is. */
  readonly stays?: true
}

export interface ArchivePlan {
  readonly items: readonly ArchiveItem[]
  /** The files of the scanned directories that stay: no closed row names them, an open row does, or the file cannot be taken. */
  readonly kept: number
  readonly notes: readonly string[]
}

/** What the export asks of the module's directory: the plan for this machine at this instant. */
export type ArchiveSource = (machine: string, now: number) => ArchivePlan

/** A directory of the repository's root that is not a project's. */
const RESERVED = new Set([MACHINES_DIR, INDEX_DIR])

/** A project's directory in the repository: the export's project name rule, kept off the repository's own directories. */
export function archiveProject(name: string): string {
  const dir = projectDir(name)
  return RESERVED.has(dir) || dir.startsWith('.') ? `_${dir}` : dir
}

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7)

/** The entries of `dir` that are directories or regular files; none when it is unreadable. */
function entriesOf(dir: string): { name: string; kind: 'file' | 'dir' | 'other' }[] {
  try {
    return readdirSync(dir).sort().map(name => {
      try {
        const stat = lstatSync(join(dir, name))
        return { name, kind: stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other' }
      } catch {
        return { name, kind: 'other' }
      }
    })
  } catch {
    return []
  }
}

/**
 * The non-blank lines of a file; none when it does not exist, `undefined` when it exists and cannot
 * be read or is a link (a link may lead out of the state directory): a reader that guards
 * something treats that as unknown, never as empty.
 */
function readLines(path: string): string[] | undefined {
  try {
    if (lstatSync(path).isSymbolicLink()) return undefined
    return readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined
  }
}

interface Row {
  readonly id: number
  readonly closed: boolean
  readonly closedAt: number
  readonly line: string
  readonly findings: string | undefined
}

interface Rows {
  readonly rows: Row[]
  /** The lines that are no JSON: one may be an open row, so what they say counts as an open row's text. */
  readonly broken: string[]
  /** The record exists and cannot be read: what it holds is unknown. */
  readonly unreadable: boolean
}

/** The rows of a record: the lines that carry an `id` and a `state`; the pull request ledger's lines are none. */
function rowsOf(path: string): Rows {
  const lines = readLines(path)
  if (lines === undefined) return { rows: [], broken: [], unreadable: true }
  const rows: Row[] = []
  const broken: string[] = []
  for (const line of lines) {
    try {
      const row = record(JSON.parse(line))
      const id = row['id']
      if (typeof id !== 'number' || typeof row['state'] !== 'string') continue
      const closedAt = Date.parse(text(row['closed']) ?? '')
      const verdict = record(record(row['review'])['verdict'])
      rows.push({ id, closed: row['state'] === 'closed' && Number.isFinite(closedAt), closedAt, line, findings: text(verdict['findings']) })
    } catch {
      broken.push(line)
    }
  }
  return { rows, broken, unreadable: false }
}

/** Whether `haystack` names `needle` as a whole file name, not inside a longer one. */
function names(haystack: string, needle: string): boolean {
  const word = /[A-Za-z0-9._-]/
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (!word.test(haystack[at - 1] ?? ' ') && !word.test(haystack[at + needle.length] ?? ' ')) return true
  }
  return false
}

const stemOf = (name: string): string => name.replace(/\.md$/, '')

/** The record files this machine knows: each project's, and the ones its registry names (an orchestration's record may sit elsewhere). */
function recordPaths(moduleDir: string, projects: readonly string[]): Set<string> {
  const paths = new Set(projects.map(project => join(moduleDir, BRIEFS_DIR, project, RECORD_FILE)))
  for (const entry of entriesOf(join(moduleDir, RECORDS_DIR))) {
    if (entry.kind === 'file') for (const path of readLines(join(moduleDir, RECORDS_DIR, entry.name)) ?? []) paths.add(path.trim())
  }
  return paths
}

/** A brief's header: the row it is for and the report it asks for. */
function headerOf(body: string): { row: number | undefined; report: string | undefined } {
  const head = body.split('\n').slice(0, 60).join('\n')
  const row = /^Row: (\d+)\b/m.exec(head)?.[1]
  const report = /^Report: (\S+)/m.exec(head)?.[1]
  return { row: row === undefined ? undefined : Number(row), report }
}

/** The regular files of a directory of briefs and of the directories in it, the records left out. */
function countFiles(dir: string): number {
  return entriesOf(dir).filter(entry => !entry.name.startsWith('dispatch-record')).reduce((n, entry) => n + (entry.kind === 'file' ? 1 : entry.kind === 'dir' ? entriesOf(join(dir, entry.name)).filter(inner => inner.kind === 'file').length : 0), 0)
}

/** The files a project's closed rows leave in its directory of briefs. */
function briefItems(moduleDir: string, project: string, machine: string, now: number, recordsText: string, items: ArchiveItem[], notes: string[]): number {
  const dir = join(moduleDir, BRIEFS_DIR, project)
  const rows = new Map(rowsOf(join(dir, RECORD_FILE)).rows.map(row => [row.id, row]))
  // A name starting with a dot (`.git`) is no archive's: git would refuse it.
  const entries = entriesOf(dir).filter(entry => !entry.name.startsWith('dispatch-record') && !entry.name.startsWith('.'))
  const settled = (id: number): boolean => rows.get(id)?.closed === true && now - (rows.get(id)?.closedAt ?? now) > SETTLE_MS
  // What a brief of a row that is not settled says counts as that row's text: it sends a live session to the files it names.
  let openText = recordsText
  const known = new Set(entries.map(entry => entry.name))
  // What each top-level entry is claimed by: a brief's header, a row's review index, a report a row's verdict names.
  const claims = new Map<string, Set<number>>()
  const claim = (name: string, id: number): void => {
    for (const target of [name, stemOf(name)]) if (known.has(target)) claims.set(target, (claims.get(target) ?? new Set()).add(id))
  }
  const briefs = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
    let body: string
    try {
      body = readFileSync(join(dir, entry.name), 'utf8')
    } catch {
      continue
    }
    const header = headerOf(body)
    if (header.row === undefined) continue
    if (!settled(header.row)) openText += `\n${body}`
    briefs.add(entry.name)
    claim(entry.name, header.row)
    // The state directory may have moved since the brief was written: the project's name tells which directory it means.
    if (header.report !== undefined && basename(dirname(header.report)) === project) claim(basename(header.report), header.row)
  }
  for (const row of rows.values()) {
    if (row.findings !== undefined) claim(basename(row.findings), row.id)
    for (const token of row.line.match(/[A-Za-z0-9._-]+\.md/g) ?? []) if (/^(report|review)-/.test(token)) claim(token, row.id)
  }
  let kept = 0
  for (const entry of entries) {
    const files = entry.kind === 'dir' ? entriesOf(join(dir, entry.name)).filter(inner => inner.kind === 'file' && !inner.name.startsWith('.')).map(inner => `${entry.name}/${inner.name}`) : entry.kind === 'file' ? [entry.name] : []
    const claimants = [...(claims.get(entry.name) ?? [])].map(id => rows.get(id))
    const closed = claimants.length > 0 && claimants.every(row => row?.closed === true && now - row.closedAt > SETTLE_MS)
    const opened = names(openText, entry.name) || names(openText, stemOf(entry.name))
    if (!closed || opened) {
      kept += files.length
      continue
    }
    const month = monthOf(Math.max(...claimants.map(row => row?.closedAt ?? 0)))
    const kind = briefs.has(entry.name) ? 'brief' : entry.name.startsWith('report-') ? 'report' : entry.name.startsWith('review-') ? 'review' : 'file'
    for (const file of files) {
      const source = join(dir, file)
      let body: Buffer
      try {
        body = readFileSync(source)
      } catch {
        kept++
        continue
      }
      if (body.length > MAX_ARCHIVE_FILE_BYTES) {
        notes.push(`export: ${project}/${file} left in place (${body.length} bytes, over ${MAX_ARCHIVE_FILE_BYTES})`)
        kept++
        continue
      }
      items.push({ rel: `${archiveProject(project)}/${month}/${machine}/${kind}/${file}`, source, body, ...(entry.kind === 'dir' ? { dir: join(dir, entry.name) } : {}) })
    }
  }
  return kept
}

/** The pull request ledger's archived lines of months before `current`, one item per project and month. */
function ledgerItems(moduleDir: string, project: string, machine: string, current: string, items: ArchiveItem[]): void {
  const source = archiveOf(join(moduleDir, BRIEFS_DIR, project, RECORD_FILE))
  const months = new Map<string, string[]>()
  for (const line of readLines(source) ?? []) {
    try {
      const archived = Date.parse(text(record(JSON.parse(line))['archived']) ?? '')
      if (!Number.isFinite(archived) || monthOf(archived) >= current) continue
      months.set(monthOf(archived), [...(months.get(monthOf(archived)) ?? []), line])
    } catch { /* a line that is no JSON stays in the archive */ }
  }
  for (const [month, lines] of [...months].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    items.push({ rel: `${archiveProject(project)}/${month}/${machine}/ledger/${basename(source)}`, source, body: Buffer.from(`${lines.join('\n')}\n`), lines })
  }
}

/** The round's archived questions settled in a month before `current`, sorted by the orchestration that asked; copied, they stay where they are. */
function roundItems(moduleDir: string, machine: string, current: string, items: ArchiveItem[]): number {
  let kept = 0
  const root = join(moduleDir, ROUND_DIR, ROUND_ARCHIVE_DIR)
  for (const place of ['', 'withdrawn']) {
    const dir = join(root, place)
    for (const entry of entriesOf(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name.includes('.tmp-')) continue
      const source = join(dir, entry.name)
      let body: Buffer
      let question: ReturnType<typeof parseRoundQuestion>
      try {
        body = readFileSync(source)
        question = parseRoundQuestion(JSON.parse(body.toString('utf8')))
      } catch {
        kept++
        continue
      }
      const settled = Date.parse(question?.answer?.at ?? question?.at ?? '')
      if (question === undefined || body.length > MAX_ARCHIVE_FILE_BYTES || !Number.isFinite(settled) || monthOf(settled) >= current) {
        kept++
        continue
      }
      const asker = orchForm(question.asker)
      const subject = parseSessionName(asker)?.subject ?? asker.replace(/^[A-Za-z]+ ?: ?/, '')
      const project = subject === '' ? UNSORTED : archiveProject(subject)
      // Copied, not moved: `recordedAsked` and the takeover's settled list read every question of the round's archive.
      items.push({ rel: `${project}/${monthOf(settled)}/${machine}/round/${place === '' ? '' : `${place}/`}${entry.name}`, source, body, stays: true })
    }
  }
  return kept
}

/**
 * What the module's directory gives the logs repository, from what is on disk now. A row's files
 * are the briefs whose header names it, the report such a brief asks for, the review index its
 * verdict records and the reports its verdict names: kept unless every row that names one was
 * closed a day ago or more and no open row's text names it. Ledger lines of a month already over; round
 * questions of one too, copied and kept (`stays`): a live session reads them.
 */
export function planArchive(options: { readonly moduleDir: string; readonly machine: string; readonly now: number }): ArchivePlan {
  const { moduleDir, machine } = options
  const current = monthOf(options.now)
  const items: ArchiveItem[] = []
  const notes: string[] = []
  const projects = entriesOf(join(moduleDir, BRIEFS_DIR)).filter(entry => entry.kind === 'dir').map(entry => entry.name)
  const records = [...recordPaths(moduleDir, projects)].map(path => ({ path, ...rowsOf(path) }))
  const unreadable = records.filter(each => each.unreadable)
  const recordsText = records.flatMap(each => [...each.rows.filter(row => !row.closed).map(row => row.line), ...each.broken]).join('\n')
  let kept = 0
  if (unreadable.length > 0) {
    // A record that cannot be read may hold an open row that names a file: no brief, report or review is taken.
    notes.push(`export: ${unreadable.length} dispatch record(s) cannot be read, no brief, report or review archived`)
  }
  for (const project of projects) {
    if (unreadable.length > 0) kept += countFiles(join(moduleDir, BRIEFS_DIR, project))
    else kept += briefItems(moduleDir, project, machine, options.now, recordsText, items, notes)
    ledgerItems(moduleDir, project, machine, current, items)
  }
  kept += roundItems(moduleDir, machine, current, items)
  return { items, kept, notes }
}
