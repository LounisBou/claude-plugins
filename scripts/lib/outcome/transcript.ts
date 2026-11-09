// The orchestrator session's transcript, read for what the harness decides on. A turn's wait is
// the structured act `declare_wait` made in that turn (docs/conventions.md, « Guards and
// consent »), never the wording of its last line. The decisions the orchestrator took in place
// of the operator are the lines it wrote as `Decision: …`.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** The tool by which a turn declares what will wake it. */
export const WAIT_TOOL = 'mcp__orchestrator__declare_wait'

export const WAIT_KINDS = ['operator', 'tool', 'done', 'deferred'] as const
export type WaitKind = (typeof WAIT_KINDS)[number]

export interface Wait {
  readonly kind: WaitKind
  readonly blocks: string
}

export interface Reading {
  /** The last turn has ended: the session's last message is the model's, ending its turn. */
  readonly idle: boolean
  /** What the last turn declared will wake it, or null. */
  readonly wait: Wait | null
  /** `question → choice`, each decision once, in the order taken. */
  readonly decisions: readonly string[]
  /** Equal for two readings of an unchanged transcript. */
  readonly signature: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isKind = (value: unknown): value is WaitKind => WAIT_KINDS.some(kind => kind === value)

const DECISION_LINE = /^[\s>*-]*Decision: (.+?) (?:→|->) (.+?)\s*$/u

function waitOfInput(input: unknown): Wait | null {
  if (!isRecord(input) || !isKind(input['kind'])) return null
  return { kind: input['kind'], blocks: typeof input['blocks'] === 'string' ? input['blocks'].replace(/\s+/gu, ' ').trim() : '' }
}

/** The blocks of a message's content; a plain string is one text block. */
function blocksOf(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message['content']
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter(isRecord) : []
}

/** The transcript's lines that are messages of the main thread, in order; a half-written line is skipped. */
function messagesOf(text: string): { type: 'user' | 'assistant'; message: Record<string, unknown> }[] {
  const found: { type: 'user' | 'assistant'; message: Record<string, unknown> }[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(entry) || entry['isSidechain'] === true) continue
    const type = entry['type']
    const message = entry['message']
    if ((type === 'user' || type === 'assistant') && isRecord(message)) found.push({ type, message })
  }
  return found
}

export function readTranscript(text: string): Reading {
  const messages = messagesOf(text)
  const decisions: string[] = []
  // The state of the turn being read: a user message that is no tool result starts the next one.
  let declared: Wait | null = null
  const calls = new Map<string, Wait | null>()
  for (const { type, message } of messages) {
    const blocks = blocksOf(message)
    if (type === 'user') {
      if (!blocks.some(block => block['type'] === 'tool_result')) {
        declared = null
        calls.clear()
        continue
      }
      // A refused declaration declares nothing.
      for (const block of blocks) {
        const id = block['tool_use_id']
        if (block['type'] === 'tool_result' && block['is_error'] === true && typeof id === 'string' && calls.get(id) === declared) declared = null
      }
      continue
    }
    for (const block of blocks) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        for (const line of block['text'].split('\n')) {
          const match = DECISION_LINE.exec(line)
          const decision = match === null ? null : `${match[1]} → ${match[2]}`
          if (decision !== null && !decisions.includes(decision)) decisions.push(decision)
        }
      } else if (block['type'] === 'tool_use' && block['name'] === WAIT_TOOL) {
        const wait = waitOfInput(block['input'])
        if (typeof block['id'] === 'string') calls.set(block['id'], wait)
        if (wait !== null) declared = wait
      }
    }
  }
  const last = messages.at(-1)
  const idle = last?.type === 'assistant' && last.message['stop_reason'] === 'end_turn'
  const wait = declared
  return { idle, wait, decisions, signature: `${messages.length}|${idle}|${wait?.kind ?? '-'}|${wait?.blocks ?? ''}` }
}

/** The transcript of a session: `<projects>/<any project>/<session>.jsonl`, or null. */
export function findTranscript(projectsDir: string, session: string): string | null {
  if (!/^[A-Za-z0-9-]{8,64}$/u.test(session) || !existsSync(projectsDir)) return null
  for (const project of readdirSync(projectsDir)) {
    const path = join(projectsDir, project, `${session}.jsonl`)
    if (existsSync(path)) return path
  }
  return null
}
