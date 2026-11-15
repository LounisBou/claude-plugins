// What a reader of `deck.json` in another language needs to know, owned here once beside the
// file's format (deck.ts): the file's name, its version, and how old its stamp may be before the
// reader takes it for a frozen file. The orchestrator rewrites the file at least once a minute
// (hooks/deck.ts, DECK_REFRESH_MS); `npm run core` writes the data half as `deck-reader.json`
// into the plugins that name it (statusbar's `statusline.sh`).
import { DECK_FILE, DECK_VERSION } from './deck.ts'

/** A deck stamped longer ago than this is a frozen file, not the machine's present: the reader shows nothing of it. */
export const DECK_STALE_AFTER_MS = 3 * 60 * 1000

export const DECK_READER_CONTRACT = {
  version: 1,
  file: DECK_FILE,
  deck_version: DECK_VERSION,
  stale_after_ms: DECK_STALE_AFTER_MS,
} as const
