// hooks/tests/journal.ts
// The journal beneath the module in a test: every file the module writes into its journal, read
// back as events. The fake host (fakes.ts) answers the session's id and the journal's commands.
import { JOURNAL_DIR } from './fakes.ts'

// Returns the events the module wrote into the journal of `$` since, parsed.
export function watchJournal($: any): () => any[] {
  const events: any[] = []
  const write = $.fs.write
  $.fs.write = async (path: string, text: string) => {
    if (String(path).startsWith(JOURNAL_DIR)) events.push(JSON.parse(String(text)))
    return write(path, text)
  }
  return () => events
}

// What a journal line of an observed guard holds: its code, as the source and as the refusal it would have been.
export const observedAs = (code: string) => ({
  kind: 'escape', source: { plugin: 'norms', code }, evidence: [{ type: 'refusal', code }], context: { session: 'sess-1' },
})
