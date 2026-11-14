// A plugin's journal written over the I/O a hooks module hands in (store-io.ts): one file per
// event, in one rename, then the journal pruned of what the contract's retention and count drop
// (learning.ts). No module of node is imported here, so a hooks module imports this one; a
// script writes through journal-sync.ts. Writing is an observation: the caller catches what this
// throws, logs it, and lets its own decision stand.
import { journalEntryOf, journalFileOf, prunable } from './learning.ts'
import { removeArgv, writeAtomicOver, type StoreIo } from './store-io.ts'

export interface JournalIo extends StoreIo {
  /** The names of the entries of `dir`, none when it does not exist. */
  readonly list: (dir: string) => Promise<readonly string[]>
}

/** The random part of an event's identifier: eight lowercase hex digits. */
export function randomPart(): string {
  const bytes = new Uint8Array(4)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Writes `event` into `dir`; with `prune`, then removes what the journal no longer keeps at `now`. */
export async function appendEventOver(io: JournalIo, dir: string, event: { readonly id: string }, now: string, prune: boolean): Promise<void> {
  await writeAtomicOver(io, `${dir}/${journalFileOf(event.id)}`, `${JSON.stringify(event)}\n`)
  if (!prune) return
  const entries = (await io.list(dir)).flatMap(name => journalEntryOf(name) ?? [])
  const gone = prunable(entries, now).map(id => `${dir}/${journalFileOf(id)}`)
  if (gone.length > 0) await io.run(removeArgv(...gone))
}
