// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The launcher chains' format (chains.ts), for a caller that has no node:fs: the entry, the file a
// chain lives in, and its text read and written. No module of node is imported here, so a hooks
// module imports this one; chains.ts holds the reads and the changes under the store's lock.

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
  return `${state}/${CHAINS_DIR}/${tty.slice(tty.lastIndexOf('/') + 1)}${SUFFIX}`
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
