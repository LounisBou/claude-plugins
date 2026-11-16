// A question of the orchestrator's round, as another plugin may read it from its file
// (`<module dir>/round/<id>.json`, and `round/archive/`): who asked, when, how many choices it
// offered, which one was recommended, and how it was settled, by whom and on which letter. The
// file has two writers in the orchestrator, read here as one: the object its `ask` tool stores
// (`v: 2`, the asker under `sender`) and the entry its relay writes out of a turn that ended on a
// wait (no `v`, the asker under `from` and `session`). Nothing of the question's or the answer's
// words is part of this contract: a reader gets the letter the answer names, never its text.
import { answersChoice } from './consent-record.ts'
import { ROUND_DIR } from './orchestration.ts'

export const ROUND_STATUSES = ['open', 'answered', 'withdrawn', 'closed'] as const
export type RoundStatus = typeof ROUND_STATUSES[number]

/** Who settled a question: the operator in the pane or in the asker's tab, the coordinator, the asker itself, or a message that carried his answer. */
export const ROUND_ANSWERERS = ['pane', 'coordinator', 'tab', 'sender', 'message'] as const
export type RoundAnswerer = typeof ROUND_ANSWERERS[number]

export interface RoundQuestion {
  readonly id: string
  /** The asker: its session id and its name. */
  readonly session: string
  readonly asker: string
  /** `operator` for a question to him, `done` for a closing proposal. */
  readonly kind: 'operator' | 'done'
  /** When it was asked, ISO. */
  readonly at: string
  readonly status: RoundStatus
  /** How many lettered choices it offered: none, or two to five. */
  readonly options: number
  /** The recommended choice's letter. */
  readonly recommended: string | null
  readonly urgent: boolean
  /**
   * How it was settled; null while it is open. `withdrawn` when no answer of his settled it (its
   * asker withdrew it, or the coordinator did on evidence); else `letter` is the choice the answer
   * names, null for any other words.
   */
  readonly answer: { readonly at: string; readonly by: RoundAnswerer; readonly withdrawn: boolean; readonly letter: string | null } | null
}

type Fields = Record<string, unknown>
const fields = (value: unknown): Fields | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : undefined)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const instant = (value: unknown): string | undefined => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined)
const letterOf = (value: unknown): string | null => (typeof value === 'string' && /^[A-E]$/.test(value) ? value : null)

/** The round question a parsed file holds, or undefined when it is neither of the two forms. */
export function parseRoundQuestion(value: unknown): RoundQuestion | undefined {
  const entry = fields(value)
  if (entry === undefined) return undefined
  const asked = entry['v'] === 2
  if (!asked && entry['v'] !== undefined) return undefined
  const sender = asked ? fields(entry['sender']) : undefined
  const id = text(entry['id'])
  const session = text(asked ? sender?.['session'] : entry['session'])
  const asker = text(asked ? sender?.['name'] : entry['from'])
  const at = instant(asked ? entry['at'] : entry['since'] ?? entry['at'])
  const status = ROUND_STATUSES.find(known => known === entry['status'])
  const kind = asked ? 'operator' : entry['kind']
  if (id === undefined || session === undefined || asker === undefined || at === undefined || status === undefined) return undefined
  if (kind !== 'operator' && kind !== 'done') return undefined
  const choices = (Array.isArray(entry['choices']) ? entry['choices'] : []).flatMap(raw => {
    const choice = fields(raw)
    const letter = letterOf(choice?.['letter'])
    return letter === null ? [] : [{ letter, text: text(choice?.['text']) ?? '' }]
  })
  const given = fields(entry['answer'])
  const by = ROUND_ANSWERERS.find(known => known === given?.['by'])
  const answeredAt = instant(given?.['at'])
  if (status !== 'open' && (by === undefined || answeredAt === undefined)) return undefined
  // His own words, when the entry kept them beside the reason (an answer typed in the asker's tab), name the choice.
  const said = text(given?.['typed']) ?? text(given?.['text']) ?? ''
  // A relayed entry is `closed` by its answer as by its withdrawal: the coordinator's withdrawal keeps its evidence, the asker's is its own.
  const withdrawn = status === 'withdrawn' || given?.['evidence'] !== undefined || (status === 'closed' && by === 'sender')
  return {
    id, session, asker, kind, at, status,
    options: choices.length,
    recommended: letterOf(asked ? entry['recommended'] : entry['recommendation']),
    urgent: entry['urgent'] === true,
    answer: status === 'open' || by === undefined || answeredAt === undefined
      ? null
      : { at: answeredAt, by, withdrawn, letter: withdrawn ? null : answersChoice(said, choices)?.letter ?? null },
  }
}

/**
 * The data half for a reader in another language that counts a session's open questions, as
 * statusbar's `statusline.sh` does: the directory of the entries under the orchestrator's state
 * directory, and the rule it applies to each file (`npm run core` writes it as `round-reader.json`).
 * An entry is the session's open question when its status is `open`, it asks the operator (an `ask`
 * object, `v: 2`, always does; a relayed entry says so by its `kind`), and its asker is the session
 * by name (`sender.name` of an `ask` object, `from` of a relayed entry; a successor keeps its
 * predecessor's name) or else by id (`sender.session`, `session`): the fields `parseRoundQuestion`
 * reads, tested against it (`scripts/contracts.test.ts`).
 */
export const ROUND_READER_CONTRACT = {
  version: 1,
  dir: ROUND_DIR,
  open_status: 'open',
  operator_kind: 'operator',
} as const
