// hooks/wait.ts
// The declared wait: `declare_wait({kind, blocks, question})`, the structured act by which a turn says
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
import { CONSENT_KINDS, parseConsentSubject, type ConsentSubject } from '../core/consent-record.ts'
import { messageOf, type Host, type On } from './host.ts'
import { openFence, outsideFences, oneQuestionRefusal, questionDefectRefusal } from './one-question.ts'
import { entryQuestions, parseChoices, questionShape, type QuestionField } from './round.ts'

// The nouns the declaration holds.
type Held = Host<'plugin' | 'env' | 'process' | 'tool'>

export const WAIT_TOOL = 'declare_wait'

// What `blocks` may hold: one line, short enough to be a reason and not a report.
export const BLOCKS_MAX = 300

const KIND_NEEDS: Record<WaitKind, string> = {
  operator: 'the question the operator must answer and what it blocks',
  tool: 'what is watched: the command, monitor or subagent you started in the background',
  done: '',
  deferred: 'the deferred items: their count (« 3 items ») or their ids',
}

// Why an operator wait is refused with no question block: the call itself must carry it.
export const QUESTION_MISSING =
  'An operator wait carries the question he must answer: pass in `question` the full `**Question i of N**` block '
  + '(`_Subject_ :`, `_Context_ :`, `_Question_ :`, `_Choices_ :`, `_Free answer_ :`, `_Recommendation_ :`, in his language; '
  + 'method:lifecycle, references/questions.md). A heading alone is no block. If you ask him nothing, declare another kind.'

// The question of an operator wait, validated with the readers the stop gate uses: one numbered block, in the format.
function checkQuestion(question: unknown): { question: string } | { error: string } {
  if (typeof question !== 'string' || question.trim() === '') return { error: QUESTION_MISSING }
  const asked = entryQuestions({ question: outsideFences(question), choices: [], recommendation: null }).filter(part => part.number !== null)
  if (asked.length === 0) return { error: `question holds no question block. ${QUESTION_MISSING}` }
  const defect = oneQuestionRefusal(question) ?? questionDefectRefusal(question)
  return defect === null ? { question: question.trim() } : { error: defect }
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

// Each question block a text shows outside its fences, by its content with its whitespace flattened:
// its numbering, its labelled fields, its choices and its recommendation with the lines that argue it.
function blockKeys(text: string): string[] {
  return entryQuestions({ question: outsideFences(text), choices: [], recommendation: null }).flatMap(part => {
    const { choices } = parseChoices(part.question)
    const shape = questionShape(part.question, choices)
    if (!shape?.number) return []
    const fields = shape.fields.map(field => `${flat(field.label)}: ${flat(field.text)}`)
    const listed = choices.map(choice => `${choice.letter}: ${flat(choice.text)}`)
    return [[flat(shape.number), ...fields, ...listed, recommendationOf(part.question, shape.recommendation)].join('\n')]
  })
}

// The recommendation of a block, flattened: its line and the lines below it up to a blank one or the
// machine line, the argument questionShape does not keep. The last line holding its label and its text is its own.
function recommendationOf(question: string, recommendation: QuestionField | null): string {
  if (recommendation === null) return ''
  const lines = question.split('\n')
  const at = lines.findLastIndex(line => line.includes(recommendation.label) && line.includes(recommendation.text))
  if (at < 0) return flat(`${recommendation.label}: ${recommendation.text}`)
  const end = lines.findIndex((line, i) => i > at && (line.trim() === '' || /^\s*waiting\s*:/.test(line)))
  return flat(`${recommendation.label}: ${lines.slice(at, end < 0 ? lines.length : end).join(' ')}`)
}

// The question block an operator wait holds that the message does not show: appended above the line.
// The call's question is authoritative: a block in the message is the declared one only when its
// content matches it, whitespace and line breaks aside. Any other block, of the same numbering and
// subject or not, does not hide it: the two then make several questions in one turn, which the stop
// gate refuses.
function questionMissingFrom(message: string, wait: DeclaredWait): string | null {
  if (wait.kind !== 'operator' || !wait.question) return null
  if (flat(outsideFences(message)).includes(flat(wait.question))) return null
  const shown = blockKeys(message)
  const declared = blockKeys(wait.question)
  return declared.length > 0 && declared.every(key => shown.includes(key)) ? null : wait.question
}

// The tool's input, validated: the declaration, or why it is none.
export function parseDeclaration(input: unknown): { wait: DeclaredWait } | { error: string } {
  const e = (input ?? {}) as { kind?: unknown; blocks?: unknown; urgent?: unknown; consent?: unknown; question?: unknown }
  if (typeof e.kind !== 'string' || !(WAIT_KINDS as readonly string[]).includes(e.kind)) {
    return { error: `kind is one of ${WAIT_KINDS.join(', ')}` }
  }
  const kind = e.kind as WaitKind
  if (e.blocks !== undefined && typeof e.blocks !== 'string') return { error: 'blocks is a string' }
  if (e.question !== undefined && kind !== 'operator') return { error: 'only an operator wait carries a question' }
  if (e.urgent !== undefined && typeof e.urgent !== 'boolean') return { error: 'urgent is true or false' }
  if (e.urgent === true && kind !== 'operator') return { error: 'only an operator wait is urgent' }
  const consent = e.consent === undefined ? undefined : parseConsentSubject(e.consent)
  if (e.consent !== undefined && kind !== 'operator') return { error: 'only an operator question asks consent' }
  if (e.consent !== undefined && consent === undefined) {
    return { error: 'consent is {"kind": "e2e-waiver", "repo": "owner/name", "pr": <n>} or {"kind": "auto-merge", "repo": "owner/name"}' }
  }
  const blocks = String(e.blocks ?? '').replace(/\s+/g, ' ').trim()
  if (kind === 'done') return { wait: { kind, blocks: '' } }
  if (blocks === '') return { error: `a ${kind} wait names in blocks ${KIND_NEEDS[kind]}` }
  if (blocks.length > BLOCKS_MAX) return { error: `blocks holds at most ${BLOCKS_MAX} characters` }
  const asked = kind === 'operator' ? checkQuestion(e.question) : null
  if (asked && 'error' in asked) return asked
  return { wait: { kind, blocks, ...(e.urgent === true ? { urgent: true as const } : {}), ...(consent ? { consent } : {}), ...(asked ? { question: asked.question } : {}) } }
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

// The declarations of this session's main thread, which the relay reads too: the subject a
// question asks consent on rides with its round entry (supervision.ts).
export const DECLARATIONS = new Declarations()

// The subject the current turn's operator question asks consent on, or null.
export function declaredConsent(declarations: Declarations = DECLARATIONS): ConsentSubject | null {
  const wait = declarations.current()
  return wait?.kind === 'operator' ? wait.consent ?? null : null
}

// The message with the declared question in it unless it shows a block of the same content: the pane, the round entry
// and the gate read the question from the call, whatever the prose around it says.
export function withDeclaredQuestion(message: string, wait: DeclaredWait | null): string {
  const missing = wait === null ? null : questionMissingFrom(message, wait)
  if (missing === null) return message
  // A message that ends inside a code fence has it closed first: the block would else be quoted text.
  const fence = openFence(message)
  return `${message.replace(/\s+$/, '')}${fence === null ? '' : `\n${fence}`}\n\n${missing}`
}

// The message as the gate and the turn's end read it: the declaration's question, then its line written last.
export function withDeclaredWait(message: string, wait: DeclaredWait | null): string {
  return wait === null ? message : `${withDeclaredQuestion(message, wait).replace(/\s+$/, '')}\n\n${waitLine(wait)}`
}

// Mounted before the guards and the supervision: a chain answers in registration order, so the
// stop gate and the turn's end read the message this module hands on.
export function register(on: On<Held>, declarations: Declarations = DECLARATIONS): void {
  on('session.start', {}, async ($, e, next) => {
    try {
      await $.tool.register({
        name: WAIT_TOOL,
        isDeferred: false,
        description: 'Declares what will wake this session once its turn ends, before ending the turn: '
          + '`operator` (a question the operator must answer; blocks: what it blocks; urgent: true to have it presented at once), '
          + '`tool` (a command, monitor or subagent you started in the background; blocks: what is watched), '
          + '`done` (every goal met or ruled out), `deferred` (only work the operator deferred is left; blocks: « <n> items »). '
          + 'An operator question that asks his consent to waive E2E on a pull request, or to put a repository in or out of auto-merge, '
          + 'names it in consent: {kind: "e2e-waiver", repo, pr} or {kind: "auto-merge", repo}; his answer is then recorded as that consent. '
          + 'An `operator` wait needs `question`, the whole `**Question i of N**` block. '
          + 'The stop gate reads the declaration in place of your last line.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...WAIT_KINDS] },
            blocks: { type: 'string', maxLength: BLOCKS_MAX },
            urgent: { type: 'boolean' },
            question: { type: 'string' },
            consent: {
              type: 'object',
              properties: { kind: { type: 'string', enum: [...CONSENT_KINDS] }, repo: { type: 'string' }, pr: { type: 'integer' } },
              required: ['kind', 'repo'],
            },
          },
          required: ['kind'],
        },
      })
    } catch (err) {
      // A start never fails on the tool: the last line still declares the wait.
      await logLine($, `${WAIT_TOOL} not registered: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('turn.start', {}, async ($, e, next) => {
    if (e.agentId === undefined) declarations.turnStarted()
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${WAIT_TOOL}` }, async ($, e) => {
    // A subagent's turn is not the session's: its end wakes the session, not a wait of its own.
    if (e.agentId) return { result: `${WAIT_TOOL} is the main session's: a subagent ends its turn by answering.`, isError: true }
    const parsed = parseDeclaration(e)
    if ('error' in parsed) return { result: parsed.error, isError: true }
    declarations.declare(parsed.wait)
    return { result: `Wait declared: ${waitLine(parsed.wait)}. End the turn now.` }
  }).catch(async ($, e, next) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: `the wait could not be declared; the module's log says why`, isError: true }
  })

  on('classic.Stop', {}, async ($, e, next) => {
    const wait = declarations.current()
    if (wait === null) return next(e)
    return next({ ...e, last_assistant_message: withDeclaredWait(String(e.last_assistant_message ?? ''), wait) })
  }).catch(async ($, e, next) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('turn.complete', {}, async ($, e, next) => {
    const wait = e.agentId === undefined ? declarations.current() : null
    if (wait === null) return next(e)
    const handed = withDeclaredWait(String(e.answer ?? ''), wait)
    const result = await next({ ...e, answer: handed })
    // The line is the readers' beneath, never shown: a text the chain left as handed is the answer's own.
    // The question the call carried stays in what is shown: it is what the operator is asked.
    return result && typeof result === 'object' && 'text' in result && result.text === handed ? { ...result, text: withDeclaredQuestion(String(e.answer ?? ''), wait) } : result
  }).catch(async ($, e, next) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// One line appended to the module's log (module-log.ts). Never throws.
async function logLine($: Host<'plugin' | 'env' | 'process'>, message: string): Promise<void> {
  try {
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
    await $.process.run(logArgv($.plugin.root, config, 'wait', message, undefined, await $.env.get('ORCHESTRATOR_MODULE_DIR')), { timeoutMs: LOG_TIMEOUT_MS })
  } catch { /* the log itself never blocks the handler that failed */ }
}
