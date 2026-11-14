// prune — what a takeover reads is only what is live: the rulings file and the state file pruned
// at each succession, what is moved appended to an archive beside each, which no takeover reads.
//
// A ruling moves only on its orchestrator's marker, written at the end of its entry when its
// work is merged or closed, or when a later ruling replaces it:
//
//   [done: <ref>]                        carried out (<ref>: the pull request, the row)
//   [superseded: <YYYY-MM-DDThh:mm:ssZ>] replaced by the ruling that opens on that date, in the
//                                        file or its archive; a date no ruling opens on keeps it
//   [standing]                           binds every future action; stays, as an unmarked one does
//   [for: <ref>]                         binds one open item (<ref>: its row or pull request); stays,
//                                        and a takeover leaves it out (`readAtTakeover`), reading it
//                                        by grep on <ref> when a task reaches that item; once every
//                                        row <ref> numbers (`row N`, `rows N–M`, `rows N, M`) is
//                                        closed in the dispatch record, it moves as a `done` one
//
// The state file's journal moves by its dates: in the section of its latest
// `- <YYYY-MM-DDThh:mm:ssZ> LIVE SUMMARY` line, each dated line older than that summary, with the
// undated lines under it. A file with no marker, or a state file with no live summary, stays whole.
import { basename, dirname, join } from 'node:path'
import { readText, update, withLock, writeAtomic } from '../../../core/store.ts'

export type Marker =
  | { readonly kind: 'standing' }
  | { readonly kind: 'done'; readonly ref: string }
  | { readonly kind: 'superseded'; readonly by: string }
  | { readonly kind: 'for'; readonly ref: string }

/** A file split into what stays and what moves, each moved entry or block whole. */
export interface Pruned {
  readonly kept: string
  readonly moved: readonly string[]
  readonly warnings: readonly string[]
}

const ISO = '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
const MARKER = new RegExp(`\\[(standing|(done|for): ([^\\]]*[^\\]\\s][^\\]]*)|superseded: (${ISO}))\\]\\s*$`)
const DATED = new RegExp(`^- (${ISO}) `)
const SUMMARY = new RegExp(`^- (${ISO}) LIVE SUMMARY\\b`)

/** The marker an entry ends on, if any. */
export function markerOf(entry: string): Marker | undefined {
  const match = MARKER.exec(entry)
  if (!match) return undefined
  if (match[1] === 'standing') return { kind: 'standing' }
  if (match[3] !== undefined) return { kind: match[2] === 'for' ? 'for' : 'done', ref: match[3].trim() }
  return { kind: 'superseded', by: match[4] ?? '' }
}

/** The file's lines grouped: each `- ` entry with its indented lines, every other line alone. */
function entries(text: string): { lines: string[]; entry: boolean }[] {
  const groups: { lines: string[]; entry: boolean }[] = []
  for (const line of text.split('\n')) {
    const last = groups[groups.length - 1]
    if (line.startsWith('- ')) groups.push({ lines: [line], entry: true })
    else if (last?.entry === true && /^[ \t]+\S/.test(line)) last.lines.push(line)
    else groups.push({ lines: [line], entry: false })
  }
  return groups
}

/** The dates the rulings of a text open on. */
function datesOf(text: string): Set<string> {
  return new Set(text.split('\n').map(line => DATED.exec(line)?.[1]).filter((d): d is string => d !== undefined))
}

const ROWS = /\brows?\s+([0-9]+(?:\s*(?:[–-]|,|and)\s*[0-9]+)*)/gi

/** The row numbers a `for` reference names, a span `N–M` read whole; none when it names no row. */
export function rowsOf(ref: string): number[] {
  return [...ref.matchAll(ROWS)].flatMap(match => {
    const rows: number[] = []
    const parts = (match[1] ?? '').split(/\s*(?:,|and)\s*/)
    for (const part of parts) {
      const [from, to] = part.split(/\s*[–-]\s*/).map(Number)
      if (from === undefined) continue
      for (let row = from; row <= (to ?? from) && row - from < 1000; row++) rows.push(row)
    }
    return rows
  })
}

/**
 * The rulings file pruned: its `done` entries, those superseded by a ruling the file or the archive
 * holds, and those `for` rows all closed in the dispatch record (`closed`, the rows' ids).
 */
export function pruneRulings(text: string, archive: string, closed: ReadonlySet<number> = new Set()): Pruned {
  const known = new Set([...datesOf(text), ...datesOf(archive)])
  const kept: string[] = []
  const moved: string[] = []
  const warnings: string[] = []
  for (const group of entries(text)) {
    const body = group.lines.join('\n')
    const marker = group.entry ? markerOf(body) : undefined
    if (marker?.kind === 'superseded' && !known.has(marker.by)) {
      warnings.push(`ruling ${DATED.exec(body)?.[1] ?? body.slice(0, 40)} kept: superseded by ${marker.by}, which no ruling of the file or its archive opens on`)
    }
    const rows = marker?.kind === 'for' ? rowsOf(marker.ref) : []
    const carried = rows.length > 0 && rows.every(row => closed.has(row))
    if (marker?.kind === 'done' || carried || (marker?.kind === 'superseded' && known.has(marker.by))) moved.push(body)
    else kept.push(...group.lines)
  }
  return { kept: kept.join('\n'), moved, warnings }
}

/** What a takeover reads of the rulings file: every line but the entries marked `[for: <ref>]`. */
export function readAtTakeover(text: string): string {
  return entries(text).filter(group => !(group.entry && markerOf(group.lines.join('\n'))?.kind === 'for')).flatMap(group => group.lines).join('\n')
}

/** The state file pruned: the journal of its live summary's section older than that summary. */
export function pruneState(text: string): Pruned {
  const lines = text.split('\n')
  let summary = -1
  lines.forEach((line, i) => {
    const date = SUMMARY.exec(line)?.[1]
    if (date !== undefined && (summary === -1 || date >= (SUMMARY.exec(lines[summary] ?? '')?.[1] ?? ''))) summary = i
  })
  if (summary === -1) return { kept: text, moved: [], warnings: [] }
  const since = SUMMARY.exec(lines[summary] ?? '')?.[1] ?? ''
  const heading = (line: string) => /^#{1,6} /.test(line)
  let start = summary
  while (start > 0 && !heading(lines[start - 1] ?? '')) start--
  let end = summary
  while (end < lines.length && !heading(lines[end] ?? '')) end++
  const kept = lines.slice(0, start)
  const moved: string[] = []
  let block: string[] = []
  let date: string | undefined
  const flush = () => {
    let last = block.length
    while (last > 0 && block[last - 1] === '') last--
    if (date !== undefined && date < since) {
      moved.push(block.slice(0, last).join('\n'))
      kept.push(...block.slice(last))
    } else kept.push(...block)
    block = []
  }
  for (const line of lines.slice(start, end)) {
    const dated = DATED.exec(line)?.[1]
    if (dated !== undefined) {
      flush()
      date = dated
    }
    block.push(line)
  }
  flush()
  kept.push(...lines.slice(end))
  return { kept: kept.join('\n'), moved, warnings: [] }
}

/** The archive beside a file: `rulings.md` → `rulings-archive.md`. */
export function archiveOf(path: string): string {
  return join(dirname(path), `${basename(path).replace(/\.md$/, '')}-archive.md`)
}

export interface PruneResult {
  readonly moved: number
  /** The file's characters before and after. */
  readonly before: number
  readonly after: number
  readonly warnings: readonly string[]
}

/**
 * Prunes a file in place under its lock: what moves is appended to its archive first, under the
 * archive's lock, then the file is written in one rename; an interruption between the two leaves
 * an entry in both, never in neither. An absent file is left alone.
 */
export function pruneFile(path: string, prune: (text: string, archive: string) => Pruned, now: Date): PruneResult {
  return withLock(path, () => {
    const text = readText(path)
    if (text === undefined) return { moved: 0, before: 0, after: 0, warnings: [] }
    const archive = archiveOf(path)
    const pruned = prune(text, readText(archive) ?? '')
    if (pruned.moved.length > 0) {
      const section = `## Moved ${now.toISOString().replace(/\.[0-9]{3}Z$/, 'Z')} from ${basename(path)}\n\n${pruned.moved.join('\n')}\n`
      update(archive, current => (current === undefined || current === '' ? section : `${current}${current.endsWith('\n') ? '' : '\n'}\n${section}`))
      writeAtomic(path, pruned.kept)
    }
    return { moved: pruned.moved.length, before: text.length, after: pruned.kept.length, warnings: pruned.warnings }
  })
}
