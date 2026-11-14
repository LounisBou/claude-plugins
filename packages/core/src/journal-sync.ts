// A plugin's journal written by a script, through node's file system and core's store: the same
// files and the same pruning as journal.ts, which a hooks module writes through.
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { journalEntryOf, journalFileOf, prunable } from './learning.ts'
import { writeAtomic } from './store.ts'

/** Writes `event` into `dir`, then removes what the journal no longer keeps at `now`. */
export function appendEvent(dir: string, event: { readonly id: string }, now: string): void {
  writeAtomic(join(dir, journalFileOf(event.id)), `${JSON.stringify(event)}\n`)
  const entries = readdirSync(dir).flatMap(name => journalEntryOf(name) ?? [])
  for (const id of prunable(entries, now)) rmSync(join(dir, journalFileOf(id)), { force: true })
}
