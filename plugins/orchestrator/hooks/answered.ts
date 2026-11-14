// hooks/answered.ts
// The orchestrator's tool for an answer that reached it by a message. The operator answers in
// the coordinator's tab and the coordinator relays it: no hook sees that answer, so the entry
// stays open unless the orchestrator says it acted on it. The call marks the session's open
// question answered, by message, with the message's author. An unanswered question never
// leaves the round otherwise.
import { answerByMessage } from './supervision.ts'
import { messageOf, type Host, type On } from './host.ts'
import { logLine } from './module-io.ts'

// The nouns the answered tool holds; supervision's answerByMessage reads the session and the store through them.
type Held = Host<'plugin' | 'env' | 'process' | 'tool' | 'session' | 'fs'>

// The tool's short name: the model calls it as mcp__orchestrator__answered-by-message.
export const ANSWERED_TOOL = 'answered-by-message'

export function register(on: On<Held>): void {
  on('session.start', {}, async ($, e, next) => {
    try {
      await $.tool.register({
        name: ANSWERED_TOOL,
        isDeferred: false,
        description: "Call it when the session acts on an answer to its own open round question that reached it by a message from another session: it withdraws the question, marking it answered by message, with that session's name as author. Only in an orchestrator session.",
        inputSchema: {
          type: 'object',
          properties: {
            author: { type: 'string', description: 'The name of the session that sent the message carrying the answer' },
            entry: { type: 'string', description: 'The id of the round entry; omitted, every open question of this session' },
          },
          required: ['author'],
        },
      })
    } catch (err) {
      await logLine($, 'answered', `answered tool not registered: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'answered', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${ANSWERED_TOOL}` }, async ($, e) => {
    if (e.agentId) return { result: "only the session's main thread withdraws its question", isError: true }
    const author = typeof e['author'] === 'string' ? e['author'].trim() : ''
    if (author === '') return { result: 'author is the sender of the message that carried the answer', isError: true }
    const left = await answerByMessage($, author, typeof e['entry'] === 'string' && e['entry'] !== '' ? e['entry'] : null)
    if (left === null) return { result: 'Only an orchestrator has a question to withdraw.', isError: true }
    return { result: left.length === 0 ? 'Withdrawn as answered by message.' : `Withdrawn as answered by message; still open: ${left.join(', ')}.` }
  }).catch(async ($, e, next) => {
    await logLine($, 'answered', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the question could not be withdrawn; the log says why', isError: true }
  })
}
