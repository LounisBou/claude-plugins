// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// A plugin's journal written over the I/O a hooks module hands in (store-io.ts): one file per
// event, in one rename, then the journal pruned of what the contract's retention and count drop
// (learning.ts). No module of node is imported here, so a hooks module imports this one; a
// script writes through journal-sync.ts. Writing is an observation: the caller catches what this
// throws, logs it, and lets its own decision stand.
import { foldDropped, journalEntryOf, journalFileOf, JOURNAL_FOLD_FILE, prunable } from './learning.ts'
import type { Host } from './host.ts'
import { removeArgv, withLockOver, writeAtomicOver, type StoreIo } from './store-io.ts'

export interface JournalIo extends StoreIo {
  /** The names of the entries of `dir`, none when it does not exist. */
  readonly list: (dir: string) => Promise<readonly string[]>
}

/** The journal's I/O over a hooks module's host: files through `$.fs`, the rename and the removal through `$.process`. */
export function journalIoOf($: Host<'fs' | 'process' | 'clock'>): JournalIo {
  return {
    write: (path, text) => $.fs.write(path, text),
    read: (path) => $.fs.read(path).then((text) => String(text), () => undefined),
    run: (argv) => $.process.run(argv, { timeoutMs: 5000 }),
    mtimeMs: (path) => $.fs.stat(path).then((stat) => stat.mtimeMs, () => undefined),
    sleep: (ms) => $.clock.sleep(ms),
    now: Date.now,
    tag: () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    list: (dir) => $.fs.list(dir).then((entries) => entries.map((entry) => String(entry.name)), () => []),
  }
}

/** The identifier of the event a journal path names. */
function idOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name
}

/** The random part of an event's identifier: eight lowercase hex digits. */
export function randomPart(): string {
  const bytes = new Uint8Array(4)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Writes `event` into `dir`; with `prune`, then removes what the journal no longer keeps at `now`,
 * once the removed events are counted into the fold file (learning.ts, `foldDropped`) under its lock.
 * A fold file that cannot be read stops the pruning, which throws, and so does a removal that fails:
 * the ids it left behind are pending in the fold, so the next prune does not count them again.
 */
export async function appendEventOver(io: JournalIo, dir: string, event: { readonly id: string }, now: string, prune: boolean): Promise<void> {
  await writeAtomicOver(io, `${dir}/${journalFileOf(event.id)}`, `${JSON.stringify(event)}\n`)
  if (!prune) return
  const entries = (await io.list(dir)).flatMap(name => journalEntryOf(name) ?? [])
  const gone = prunable(entries, now).map(id => `${dir}/${journalFileOf(id)}`)
  if (gone.length === 0) return
  const fold = `${dir}/${JOURNAL_FOLD_FILE}`
  await withLockOver(io, fold, async () => {
    const next = foldDropped(await Promise.all(gone.map(async path => ({ id: idOf(path), text: await io.read(path) }))), await io.read(fold))
    if (next !== undefined) await writeAtomicOver(io, fold, next)
    const removed = await io.run(removeArgv(...gone))
    if (removed.exitCode !== 0) throw new Error(`the journal ${dir} could not be pruned${removed.stderr ? `: ${removed.stderr.trim()}` : ''}`)
  })
}
