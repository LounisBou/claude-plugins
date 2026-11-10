// hooks/one-question.ts
// The stop gate's rules on the question a turn puts to the operator, all read off the final
// message alone. One question per turn: an orchestrator puts one to him, the next only after
// his answer, so a message holding two numbered question blocks or more breaks it. A turn
// that ends on a wait for him puts one: an operator wait with no block asks him nothing he can
// see. And a block follows the method's format: no more than five choices, a recommendation that
// argues. The blocks are the ones round.ts's questionParts splits an entry on (`**Question 3 of 4**`,
// in the sender's language): the numbering is read there, once. A heading inside a fenced code
// block is a quoted example, never a block: the rules read the message without its fences, as
// unanswered-question.ts does.
import { questionParts, entryQuestions, questionDefects } from './round.ts'
import { MACHINE_LINE, blocksNothing, machineLine } from './stop-gate.ts'

export const ONE_QUESTION =
  'One question per turn: this message holds several numbered question blocks. Put the first to the operator '
  + 'alone, in the method\'s question format, and let the others wait for his answer: ask the next in the '
  + 'turn that follows it. The numbering « i of N » still says how many questions there are.'

export const NO_QUESTION =
  'This turn ends on a wait for the operator but holds no question block: he is shown a report, not a question, '
  + 'and what waits on his answer stays blocked. Put the question to him as orchestrator:decide runs it, '
  + 'in the method\'s question format (method:lifecycle, references/questions.md): a block is the '
  + '`**Question i of N**` line followed by its labelled fields (`_Subject_ :`, `_Context_ :`, '
  + '`_Question_ :`, `_Choices_ :`, `_Free answer_ :`, `_Recommendation_ :`, in the operator\'s language): '
  + 'a heading alone is refused. If you ask him nothing, end on the line that fits: '
  + '`waiting: tool — <what is watched>`, `waiting: deferred — <n> items`, `waiting: done`, or no machine line.'

// The message without its fenced code blocks (``` or ~~~, the closing fence of the opening one's
// marker and at least its length; one never closed runs to the end), the text both rules count
// blocks in: a numbering line quoted as an example is no question.
export function outsideFences(message: string): string {
  const kept: string[] = []
  let fence: string | null = null
  for (const line of message.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null
    if (fence === null) {
      if (marker !== null) fence = marker
      else kept.push(line)
    } else if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      fence = null
    }
  }
  return kept.join('\n')
}

// The refusal for a message with two question blocks or more; null for one block or none.
export function oneQuestionRefusal(message: string): string | null {
  return questionParts(outsideFences(message)).length > 1 ? ONE_QUESTION : null
}

// The refusal for a message whose machine line is a wait for the operator (the urgent form
// included, its reason naming something) with no numbered question block above it; null for any other ending, or a block. A
// block is a numbering line followed by labelled fields, the shape entryQuestions reads a number
// from: questionParts alone answers the whole text for one block or none.
export function operatorWaitRefusal(message: string): string | null {
  const line = machineLine(message)
  // A wait that blocks nothing asks him nothing: the gate's own refusal of it names the line that fits.
  if (!MACHINE_LINE.exec(line)?.[1] || blocksNothing(line)) return null
  const asked = entryQuestions({ question: outsideFences(message), choices: [], recommendation: null })
  return asked.some(part => part.number !== null) ? null : NO_QUESTION
}

export const QUESTION_BY_MESSAGE =
  'Ask it at the end of your own turn: the module carries it to the coordinator. A question sent to the '
  + 'coordinator by message reaches no round, and the operator is never shown it.'

// Whether a message puts the operator a question: a numbered question block outside the fences, or
// a machine line that waits on him. The same two readings the stop gate takes of a turn's end.
export function asksTheOperator(message: string): boolean {
  const line = machineLine(message)
  // A wait that blocks nothing asks him nothing: the stop gate reads it as no question.
  if (MACHINE_LINE.exec(line)?.[1] && !blocksNothing(line)) return true
  return entryQuestions({ question: outsideFences(message), choices: [], recommendation: null }).some(part => part.number !== null)
}

export const FORMAT_DEFECT =
  'The question breaks the method\'s question format (method:lifecycle, references/questions.md): '

// The refusal for a numbered block outside the fences that holds more than five lettered choices (two
// to five, A to E) or a recommendation naming a letter with no argument; null otherwise. Asked of an
// orchestrator's own question: the coordinator relays the sender's block as it was ruled on.
export function questionDefectRefusal(message: string): string | null {
  const defects = new Set(entryQuestions({ question: outsideFences(message), choices: [], recommendation: null })
    .filter(part => part.number !== null)
    .flatMap(part => questionDefects(part.question)))
  if (defects.size === 0) return null
  const faults = [
    ...(defects.has('choices')
      ? ['it holds more than five choices: keep two to five, lettered A to E, and put the rest in the free answer'] : []),
    ...(defects.has('recommendation')
      ? ['its recommendation names a letter with no argument: argue it against the other choices'] : []),
  ]
  return `${FORMAT_DEFECT}${faults.join('; ')}. Put the question again, corrected.`
}
