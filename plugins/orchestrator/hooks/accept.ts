// hooks/accept.ts
// The orchestrator's acceptance of a failed review: after its one correction round, the
// orchestrator judges that the findings left at the head need no fix, and records that decision
// for the github ready gate. The record is github's (core's pr-record.ts, ACCEPTANCE): this tool
// is its one writer, and it writes only from an orchestrator session. github checks the rest at
// the head it reads: the caller's plugin, the failed review named, and that no review followed it.
import { ACCEPTANCE } from '../core/pr-record.ts'
import { isOrchestratorSession } from './supervision.ts'
import { logArgv, LOG_TIMEOUT_MS } from './module-log.ts'
import { messageOf, type Host, type On } from './host.ts'

type Held = Host<'plugin' | 'env' | 'process' | 'tool' | 'session' | 'fs'>

// The tool's short name: the model calls it as mcp__orchestrator__accept.
export const ACCEPT_TOOL = 'accept'
const RECORD_TOOL = 'mcp__github__record'

export const NOT_ORCHESTRATOR = 'Only an orchestrator session accepts a failed review: the decision after its correction round is its own.'

// The record tool's call for an acceptance, or the line that says what the input lacks.
export function acceptanceCall(input: Record<string, unknown>): { tool: string } & Record<string, unknown> | string {
  const pr = Number(String(input['pr'] ?? '').replace('#', ''))
  if (!Number.isInteger(pr) || pr < 1) return 'pr is the pull request number'
  const over = typeof input['over'] === 'string' ? input['over'].trim() : ''
  if (over === '') return "over is the failed review record's file name at the pull request's head"
  const decision = typeof input['decision'] === 'string' ? input['decision'].trim() : ''
  if (decision === '') return 'decision is the decision, in one sentence'
  const repo = typeof input['repo'] === 'string' && input['repo'] !== '' ? { repo: input['repo'] } : {}
  return { tool: RECORD_TOOL, pr, ...repo, kind: ACCEPTANCE.kind, result: ACCEPTANCE.result, over, detail: decision }
}

// The record tool's answer as the tool's own: its text, an error when it refused or failed.
function answerOf(written: unknown): { result: string; isError?: boolean } {
  const w = (typeof written === 'object' && written !== null ? written : {}) as { result?: unknown; deny?: unknown; isError?: unknown }
  if (typeof w.deny === 'string') return { result: w.deny, isError: true }
  const text = typeof w.result === 'string' ? w.result : JSON.stringify(w.result ?? null)
  return w.isError === true ? { result: text, isError: true } : { result: text }
}

export function register(on: On<Held>): void {
  on('session.start', {}, async ($, e, next) => {
    try {
      await $.tool.register({
        name: ACCEPT_TOOL,
        isDeferred: false,
        description: 'Records, for the github ready gate, that the orchestrator accepts the failed review at a pull request\'s head: after the one correction round, the findings left need no fix. Only in an orchestrator session.',
        inputSchema: {
          type: 'object',
          properties: {
            pr: { type: 'integer', description: 'the pull request number' },
            repo: { type: 'string', description: 'owner/name; omitted, the checkout\'s origin' },
            over: { type: 'string', description: 'the failed review record\'s file name at the head; any other value is refused with the file to pass' },
            decision: { type: 'string', description: 'the decision, in one sentence' },
          },
          required: ['pr', 'over', 'decision'],
        },
      })
    } catch (err) {
      await logLine($, `accept tool not registered: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${ACCEPT_TOOL}` }, async ($, e) => {
    if (e.agentId) return { result: "only the session's main thread accepts a review", isError: true }
    const call = acceptanceCall(e)
    if (typeof call === 'string') return { result: call, isError: true }
    if (!(await isOrchestratorSession($, await $.session.id()))) return { result: NOT_ORCHESTRATOR, isError: true }
    return answerOf(await $.tool.call(call))
  }).catch(async ($, e, next) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the acceptance could not be recorded; the log says why', isError: true }
  })
}

async function logLine($: Host<'plugin' | 'env' | 'process'>, message: string): Promise<void> {
  try {
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
    await $.process.run(logArgv($.plugin.root, config, 'accept', message, undefined, await $.env.get('ORCHESTRATOR_MODULE_DIR')), { timeoutMs: LOG_TIMEOUT_MS })
  } catch { /* the log itself never blocks the handler that failed */ }
}
