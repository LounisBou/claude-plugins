// hooks/one-question.ts
// The stop gate's rule on the question a turn puts to the operator, read off the final message
// alone. A turn that ends on a wait for him puts one: an operator wait with no block asks him
// nothing he can see. The blocks are the ones round.ts's entryQuestions reads a numbering from
// (`**Question 3 of 4**`, in the sender's language). A heading inside a fenced code block is a
// quoted example, never a block: the rule reads the message without its fences, as
// unanswered-question.ts does.
import { entryQuestions } from './round.ts'
import { MACHINE_LINE, blocksNothing, machineLine } from './stop-gate.ts'

export const NO_QUESTION =
  'This turn ends on a wait for the operator but holds no question block: he is shown a report, not a question, '
  + 'and what waits on his answer stays blocked. Put the question to him as orchestrator:decide runs it, '
  + 'in the method\'s question format (method:lifecycle, references/questions.md): a block is the '
  + '`**Question i of N**` line followed by its labelled fields (`_Subject_ :`, `_Context_ :`, '
  + '`_Question_ :`, `_Choices_ :`, `_Free answer_ :`, `_Recommendation_ :`, in the operator\'s language): '
  + 'a heading alone is refused. If you ask him nothing, declare the wait that fits (a tool, deferred or done wait), or none.'

// The message without its fenced code blocks (``` or ~~~, the closing fence of the opening one's
// marker and at least its length; one never closed runs to the end), the text the rules count
// blocks in: a numbering line quoted as an example is no question.
export function outsideFences(message: string): string {
  return scanFences(message).kept.join('\n')
}

// The fence a message ends inside, or null: the marker that opened a block never closed.
export function openFence(message: string): string | null {
  return scanFences(message).fence
}

function scanFences(message: string): { kept: string[]; fence: string | null; inside: boolean[] } {
  const kept: string[] = []
  const inside: boolean[] = []
  let fence: string | null = null
  for (const line of message.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null
    if (fence === null) {
      if (marker !== null) fence = marker
      else kept.push(line)
      inside.push(marker !== null)
    } else {
      inside.push(true)
      if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null
    }
  }
  return { kept, fence, inside }
}

// Whether each line of the message is a fence line or inside a fenced block: the lines outsideFences drops.
export function fencedLines(message: string): boolean[] {
  return scanFences(message).inside
}

// The refusal for a message whose machine line is a wait for the operator (the urgent form
// included, its reason naming something) with no numbered question block above it; null for any other ending, or a block. A
// block is a numbering line followed by labelled fields, the shape entryQuestions reads a number
// from.
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
