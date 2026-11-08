// hooks/wait.ts
// The declared wait: `declare_wait({kind, blocks})`, the structured act by which a turn says
// what will wake it, read by the stop gate in place of the wording of the turn's last line
// (docs/conventions.md, « Guards and consent »). A declaration belongs to the turn that made
// it: the next turn's start makes it stale, and a stale one is never read.
//
// The gate's decisions live in stop-gate.ts and its handler in guards.ts; until that handler
// takes the declaration as a fact of its own, this module hands it on as the one machine line
// the declaration spells (waitLine), written last in the message every later reader of the
// stop and of the turn's end sees. The model's own line, when it wrote one, no longer decides.
import { waitLine, WAIT_KINDS, type DeclaredWait, type WaitKind } from './stop-gate.ts'
import { logArgv, LOG_TIMEOUT_MS } from './module-log.ts'

export const WAIT_TOOL = 'declare_wait'

// What `blocks` may hold: one line, short enough to be a reason and not a report.
export const BLOCKS_MAX = 300

const KIND_NEEDS: Record<WaitKind, string> = {
  operator: 'the question the operator must answer and what it blocks',
  tool: 'what is watched: the command, monitor or subagent you started in the background',
  done: '',
  deferred: 'the deferred items: their count (« 3 items ») or their ids',
}

// The tool's input, validated: the declaration, or why it is none.
export function parseDeclaration(input: unknown): { wait: DeclaredWait } | { error: string } {
  const e = (input ?? {}) as { kind?: unknown; blocks?: unknown }
  if (typeof e.kind !== 'string' || !(WAIT_KINDS as readonly string[]).includes(e.kind)) {
    return { error: `kind is one of ${WAIT_KINDS.join(', ')}` }
  }
  const kind = e.kind as WaitKind
  if (e.blocks !== undefined && typeof e.blocks !== 'string') return { error: 'blocks is a string' }
  const blocks = String(e.blocks ?? '').replace(/\s+/g, ' ').trim()
  if (kind === 'done') return { wait: { kind, blocks: '' } }
  if (blocks === '') return { error: `a ${kind} wait names in blocks ${KIND_NEEDS[kind]}` }
  if (blocks.length > BLOCKS_MAX) return { error: `blocks holds at most ${BLOCKS_MAX} characters` }
  return { wait: { kind, blocks } }
}

// The declarations of one session, by turn: a declaration is current only in the turn that
// made it. Pure over its own memory, so the gate's tests drive it turn by turn.
export class Declarations {
  private turn = 0
  private declared: { wait: DeclaredWait; turn: number } | null = null

  turnStarted(): void {
    this.turn += 1
  }

  declare(wait: DeclaredWait): void {
    this.declared = { wait, turn: this.turn }
  }

  // The current turn's declaration, or null: none made, or made in an earlier turn.
  current(): DeclaredWait | null {
    return this.declared !== null && this.declared.turn === this.turn ? this.declared.wait : null
  }
}

// The message as the gate and the turn's end read it: the declaration's line written last.
export function withDeclaredWait(message: string, wait: DeclaredWait | null): string {
  return wait === null ? message : `${message.replace(/\s+$/, '')}\n\n${waitLine(wait)}`
}

type On = (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }

// Mounted before the guards and the supervision: a chain answers in registration order, so the
// stop gate and the turn's end read the message this module hands on.
export function register(on: On, declarations: Declarations = new Declarations()) {
  on('session.start', {}, async ($: any, e: any, next: (e: any) => any) => {
    try {
      await $.tool.register({
        name: WAIT_TOOL,
        isDeferred: false,
        description: 'Declares what will wake this session once its turn ends, before ending the turn: '
          + '`operator` (a question the operator must answer; blocks: what it blocks), '
          + '`tool` (a command, monitor or subagent you started in the background; blocks: what is watched), '
          + '`done` (every goal met or ruled out), `deferred` (only work the operator deferred is left; blocks: « <n> items »). '
          + 'The stop gate reads the declaration in place of your last line.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...WAIT_KINDS] },
            blocks: { type: 'string', maxLength: BLOCKS_MAX },
          },
          required: ['kind'],
        },
      })
    } catch (err) {
      // A start never fails on the tool: the last line still declares the wait.
      await logLine($, `${WAIT_TOOL} not registered: ${(err as Error).message}`)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('turn.start', {}, async ($: any, e: any, next: (e: any) => any) => {
    if (e.agentId === undefined) declarations.turnStarted()
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${WAIT_TOOL}` }, async ($: any, e: any) => {
    // A subagent's turn is not the session's: its end wakes the session, not a wait of its own.
    if (e.agentId) return { result: `${WAIT_TOOL} is the main session's: a subagent ends its turn by answering.`, isError: true }
    const parsed = parseDeclaration(e)
    if ('error' in parsed) return { result: parsed.error, isError: true }
    declarations.declare(parsed.wait)
    return { result: `Wait declared: ${waitLine(parsed.wait)}. End the turn now.` }
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: `the wait could not be declared; the module's log says why`, isError: true }
  })

  on('classic.Stop', {}, async ($: any, e: any, next: (e: any) => any) => {
    const wait = declarations.current()
    if (wait === null) return next(e)
    return next({ ...e, last_assistant_message: withDeclaredWait(String(e.last_assistant_message ?? ''), wait) })
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('turn.complete', {}, async ($: any, e: any, next: (e: any) => any) => {
    const wait = e.agentId === undefined ? declarations.current() : null
    if (wait === null) return next(e)
    const handed = withDeclaredWait(String(e.answer ?? ''), wait)
    const result = await next({ ...e, answer: handed })
    // The line is the readers' beneath, never shown: a text the chain left as handed is the answer's own.
    return result && typeof result === 'object' && result.text === handed ? { ...result, text: String(e.answer ?? '') } : result
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// One line appended to the module's log (module-log.ts). Never throws.
async function logLine($: any, message: string): Promise<void> {
  try {
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
    await $.process.run(logArgv($.plugin.root, config, 'wait', message, undefined, await $.env.get('ORCHESTRATOR_MODULE_DIR')), { timeoutMs: LOG_TIMEOUT_MS })
  } catch { /* the log itself never blocks the handler that failed */ }
}
