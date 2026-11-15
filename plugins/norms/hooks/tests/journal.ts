// hooks/tests/journal.ts
// The journal beneath the module in a test: the session's id, the rename a journal write ends on,
// and every file the module writes into its journal, read back as events.

// Where fakeDollar's host keeps the module's journal: its home, then the plugin's directory.
export const JOURNAL_DIR = '/home/u/.claude/norms/journal/'

// Makes `$` hold a journal and returns the events the module wrote into it so far, parsed.
export function watchJournal($: any): () => any[] {
  const events: any[] = []
  const write = $.fs.write
  $.fs.write = async (path: string, text: string) => {
    if (String(path).startsWith(JOURNAL_DIR)) events.push(JSON.parse(String(text)))
    return write(path, text)
  }
  const run = $.process.run
  $.process.run = async (argv: readonly string[], init?: unknown) => (argv[0] === 'mv' ? { exitCode: 0, stdout: '', stderr: '' } : run(argv, init))
  $.session = { ...$.session, id: async () => 'sess-1' }
  $.clock = { sleep: async () => undefined }
  return () => events
}

// What a journal line of an observed guard holds: its code, as the source and as the refusal it would have been.
export const observedAs = (code: string) => ({
  kind: 'escape', source: { plugin: 'norms', code }, evidence: [{ type: 'refusal', code }], context: { session: 'sess-1' },
})
