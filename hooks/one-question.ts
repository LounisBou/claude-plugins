// hooks/one-question.ts
// The stop gate's rules on the question a turn puts to the operator, both read off the final
// message alone. One question per turn: an orchestrator puts one to him, the next only after
// his answer, so a message holding two numbered question blocks or more breaks it. And a turn
// that ends on a wait for him puts one: an operator wait with no block asks him nothing he can
// see. The blocks are the ones round.ts's questionParts splits an entry on (`**Question 3 of 4**`,
// in the sender's language): the numbering is read there, once. A heading inside a fenced code
// block is a quoted example, never a block: both rules read the message without its fences.
import { questionParts, entryQuestions } from './round.ts'
import { MACHINE_LINE, blocksNothing, machineLine } from './stop-gate.ts'

export const ONE_QUESTION =
  'One question per turn: this message holds several numbered question blocks. Put the first to the operator '
  + 'alone, in the shape of orchestrator:decide, and let the others wait for his answer: ask the next in the '
  + 'turn that follows it. The numbering « i of N » still says how many questions there are.'

export const NO_QUESTION =
  'This turn ends on a wait for the operator but holds no question block: he is shown a report, not a question, '
  + 'and what waits on his answer stays blocked. Put the question to him in the shape of orchestrator:decide '
  + 'step 2: a block is the `**Question i of N**` line followed by its labelled fields (`_Subject_ :`, '
  + '`_Context_ :`, `_Question_ :`, `_Choices_ :`, `_Recommendation_ :`, in the operator\'s language): a heading '
  + 'alone is refused. If you ask him nothing, end on the line that fits: '
  + '`waiting: tool — <what is watched>`, `waiting: deferred — <ids>`, `waiting: done`, or no machine line.'

// The message without its fenced code blocks (``` or ~~~, the closing fence of the opening one's
// marker and at least its length; one never closed runs to the end), the text both rules count
// blocks in: a numbering line quoted as an example is no question.
function outsideFences(message: string): string {
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
