// hooks/tests/journal.ts
// The journal beneath the module in a test: the host's configuration directory, the session's
// id, and every file the module writes into its journal, read back as events.
import type { TestOn } from 'claude-code/testing'
import { parseLearningEvent, type LearningEvent } from '../../core/learning.ts'

// The events the module wrote so far, parsed; each is one file under <config>/pr-review/journal/.
export function watchJournal(on: TestOn): () => LearningEvent[] {
  const events: LearningEvent[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/op' : undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', (_$, e) => {
    const event = String(e.path).startsWith('/home/op/.claude/pr-review/journal/') ? parseLearningEvent(JSON.parse(String(e.text))) : undefined
    if (event !== undefined) events.push(event)
    return { value: undefined }
  })
  return () => events
}

// What a journal line of an observed guard holds: its code, as the source and as the refusal it would have been.
export const observedAs = (code: string) => ({
  kind: 'escape', source: { plugin: 'pr-review', code }, evidence: [{ type: 'refusal', code }], context: { session: 'sess-1' },
})
