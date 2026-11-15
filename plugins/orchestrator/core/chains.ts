// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The launcher's chains: one file per orchestrator, `<state>/chains/<tty name>.jsonl`, each line
// an agent it launched, in launch order, with the session that wrote it (`owner`, the key every
// reader filters on: a tty is recycled minutes after a close, and the file named after it outlives
// its occupant). Every write goes through the store (store.ts): read and rewritten under the lock
// `<path>.lock`, replaced whole in one rename. The lines keep the format the launcher wrote before
// the store owned it (Python's `json.dumps`), so a session of an earlier release reads them.
import { readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readText, withLock, writeAtomic, type LockOptions } from './store.ts'

/** The chains' directory under the orchestrator's state directory. */
export const CHAINS_DIR = 'chains'
const SUFFIX = '.jsonl'

export interface ChainEntry {
  readonly tab_id: string
  readonly tty: string
  /** The session that wrote the entry; empty when none was known. */
  readonly owner: string
  /** An agent meant to stay idle while a background command of its own waits. */
  readonly resident: boolean
}

/** The chain file of the orchestrator on `tty` (`/dev/ttys001` or `ttys001`). */
export function chainPath(state: string, tty: string): string {
  return join(state, CHAINS_DIR, `${basename(tty)}${SUFFIX}`)
}

/** The tty a chain file's name stands for, or undefined for a name that is no chain. */
export function chainTtyOf(name: string): string | undefined {
  return name.endsWith(SUFFIX) && name.length > SUFFIX.length ? `/dev/${name.slice(0, -SUFFIX.length)}` : undefined
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The entries of a chain's text: one line that is no JSON empties the whole file (the writes are
 * atomic, so a bad line means the file is not a chain); a line that is no object, or carries no
 * tab id or no tty, is dropped alone.
 */
export function parseChain(text: string | undefined): ChainEntry[] {
  const entries: ChainEntry[] = []
  for (const line of (text ?? '').split('\n')) {
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return []
    }
    if (!isObject(value)) continue
    const { tab_id: tab, tty, owner, resident } = value
    if (typeof tab !== 'string' || tab === '' || typeof tty !== 'string' || tty === '') continue
    entries.push({ tab_id: tab, tty, owner: typeof owner === 'string' ? owner : '', resident: resident === true })
  }
  return entries
}

// A string as Python's json.dumps writes it: every character past ASCII escaped.
const pyString = (value: string): string =>
  JSON.stringify(value).replace(/[\u0080-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** The text of a chain, one line an entry, byte for byte what the launcher's Python writer wrote. */
export function chainText(entries: readonly ChainEntry[]): string {
  return entries
    .map(e => `{"tab_id": ${pyString(e.tab_id)}, "tty": ${pyString(e.tty)}, "owner": ${pyString(e.owner)}${e.resident ? ', "resident": true' : ''}}\n`)
    .join('')
}

/** The entries `owner` wrote; with no owner known, every entry. */
export function chainOwned(entries: readonly ChainEntry[], owner: string): ChainEntry[] {
  return owner === '' ? [...entries] : entries.filter(e => e.owner === owner)
}

/** The chain of `tty` as it stands, empty when absent or unreadable. */
export function readChain(state: string, tty: string): ChainEntry[] {
  try {
    return parseChain(readText(chainPath(state, tty)))
  } catch {
    return []
  }
}

/**
 * The chain of `tty` read again and rewritten under its lock: `change` takes the entries as they
 * stand and answers those to write, or undefined to leave the file as it is. Answers what was written.
 */
export function changeChain(
  state: string,
  tty: string,
  change: (entries: ChainEntry[]) => ChainEntry[] | undefined,
  options?: LockOptions,
): ChainEntry[] | undefined {
  const path = chainPath(state, tty)
  return withLock(path, () => {
    const next = change(readChain(state, tty))
    if (next !== undefined) writeAtomic(path, chainText(next))
    return next
  }, options)
}

/** The ttys of every chain file of the state directory. */
export function chainTtys(state: string): string[] {
  let names: string[]
  try {
    names = readdirSync(join(state, CHAINS_DIR))
  } catch {
    return []
  }
  return names.sort().flatMap(name => chainTtyOf(name) ?? [])
}

/** An agent appended to the chain of `tty`. */
export function appendChain(state: string, tty: string, entry: ChainEntry, options?: LockOptions): void {
  changeChain(state, tty, entries => [...entries, entry], options)
}

/** The entries naming those tabs removed from the chain of `tty`; answers whether it was rewritten. */
export function dropFromChain(state: string, tty: string, tabIds: readonly string[], options?: LockOptions): boolean {
  const gone = new Set(tabIds)
  if (gone.size === 0) return false
  return changeChain(state, tty, entries => (entries.some(e => gone.has(e.tab_id)) ? entries.filter(e => !gone.has(e.tab_id)) : undefined), options) !== undefined
}

/** Every entry naming `tabId`, in every chain, removed; answers the ttys whose chain was rewritten. */
export function dropTabEverywhere(state: string, tabId: string, options?: LockOptions): string[] {
  return chainTtys(state).filter(tty => dropFromChain(state, tty, [tabId], options))
}

/**
 * Every entry naming the old tab, in every chain, made to name the new one on its tty, its owner
 * and resident mark kept. Answers how many entries moved and the ttys whose chain was rewritten.
 */
export function repointTab(state: string, oldTab: string, newTab: string, newTty: string, options?: LockOptions): { count: number; written: string[] } {
  let count = 0
  const written: string[] = []
  for (const tty of chainTtys(state)) {
    const changed = changeChain(state, tty, entries => {
      const hits = entries.filter(e => e.tab_id === oldTab).length
      count += hits
      return hits === 0 ? undefined : entries.map(e => (e.tab_id === oldTab ? { ...e, tab_id: newTab, tty: newTty } : e))
    }, options)
    if (changed !== undefined) written.push(tty)
  }
  return { count, written }
}

/**
 * The predecessor's entries (those `oldOwner` wrote in the chain of `oldTty`) moved under the
 * successor's tty and session. Whatever the successor's file held is replaced, unless `merge`
 * (a takeover after the successor launched agents of its own): its own entries are then kept and
 * the predecessor's follow, a tab already there not doubled. The predecessor's file is removed.
 * Both files are held under their locks, taken in one order. Answers how many entries moved.
 */
export function transferChain(
  state: string,
  oldTty: string,
  oldOwner: string,
  newTty: string,
  newOwner: string,
  merge = false,
  options?: LockOptions,
): number {
  const [first, second] = [chainPath(state, oldTty), chainPath(state, newTty)].sort()
  const both = (work: () => number): number =>
    first === second || second === undefined ? withLock(first ?? '', work, options) : withLock(first ?? '', () => withLock(second, work, options), options)
  return both(() => {
    const moved = chainOwned(readChain(state, oldTty), oldOwner)
    const own = merge && newOwner !== '' ? chainOwned(readChain(state, newTty), newOwner) : []
    const have = new Set(own.map(e => e.tab_id))
    writeAtomic(chainPath(state, newTty), chainText([...own, ...moved.filter(e => !have.has(e.tab_id)).map(e => ({ ...e, owner: newOwner }))]))
    if (chainPath(state, oldTty) !== chainPath(state, newTty)) rmSync(chainPath(state, oldTty), { force: true })
    return moved.length
  })
}
