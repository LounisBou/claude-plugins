// A plugin's journal written by a script, through node's file system and core's store: the same
// files and the same pruning as journal.ts, which a hooks module writes through.
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { foldDropped, journalEntryOf, journalFileOf, JOURNAL_FOLD_FILE, prunable } from './learning.ts'
import { readText, withLock, writeAtomic } from './store.ts'

/**
 * Writes `event` into `dir`, then removes what the journal no longer keeps at `now`, once the removed
 * events are counted into the fold file under its lock. A fold file that cannot be read stops the
 * pruning, which throws.
 */
export function appendEvent(dir: string, event: { readonly id: string }, now: string): void {
  writeAtomic(join(dir, journalFileOf(event.id)), `${JSON.stringify(event)}\n`)
  const entries = readdirSync(dir).flatMap(name => journalEntryOf(name) ?? [])
  const gone = prunable(entries, now).map(id => join(dir, journalFileOf(id)))
  if (gone.length === 0) return
  const fold = join(dir, JOURNAL_FOLD_FILE)
  withLock(fold, () => {
    const next = foldDropped(gone.map(path => readText(path)), readText(fold))
    if (next !== undefined) writeAtomic(fold, next)
    for (const path of gone) rmSync(path, { force: true })
  })
}
