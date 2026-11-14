// hooks/one-question.ts
// The stop gate's rule on the question a turn puts to the operator, read off the final message
// alone. A turn that ends on a wait for him puts one: an operator wait with no block asks him
// nothing he can see. The blocks are the ones core's method.ts (entryQuestions) reads a numbering from
// (`**Question 3 of 4**`, in the sender's language). A heading inside a fenced code block is a
// quoted example, never a block: the rule reads the message without its fences, as
// unanswered-question.ts does.
import { entryQuestions, machineLine, outsideFences } from '../core/method.ts'
import { MACHINE_LINE, blocksNothing } from './stop-gate.ts'

export const NO_QUESTION =
  'This turn ends on a wait for the operator but holds no question block: he is shown a report, not a question, '
  + 'and what waits on his answer stays blocked. Put the question to him as orchestrator:decide runs it, '
  + 'in the method\'s question format (method:lifecycle, references/questions.md): a block is the '
  + '`**Question i of N**` line followed by its labelled fields (`_Subject_ :`, `_Context_ :`, '
  + '`_Question_ :`, `_Choices_ :`, `_Free answer_ :`, `_Recommendation_ :`, in the operator\'s language): '
  + 'a heading alone is refused. If you ask him nothing, declare the wait that fits (a tool, deferred or done wait), or none.'

// The refusal for a message whose machine line is a wait for the operator (the urgent form
// included, its reason naming something) with no numbered question block above it; null for any other ending, or a block. A
// block is a numbering line followed by labelled fields, the shape core's entryQuestions reads a
// number from.
export function operatorWaitRefusal(message: string): string | null {
  const line = machineLine(message)
  // A wait that blocks nothing asks him nothing: the gate's own refusal of it names the line that fits.
  if (!MACHINE_LINE.exec(line)?.[1] || blocksNothing(line)) return null
  return holdsQuestionBlock(message) ? null : NO_QUESTION
}

// Whether a text shows a numbered question block outside its fences.
function holdsQuestionBlock(text: string): boolean {
  return entryQuestions({ question: outsideFences(text), choices: [], recommendation: null }).some(part => part.number !== null)
}

// Whether the turn the transcript's end belongs to already put the operator a question: read from the
// transcript's last line backwards, one line at a time, up to the turn's own start, the operator's
// prompt (a user entry the host did not inject: its stop-hook feedback and reminders are `isMeta`,
// a tool's result carries no text). The question is a numbered block in a text the model wrote in the
// turn, or in the `question` of a `declare_wait` it called in it. A turn that asked it once is not
// refused for asking it no more in its last message. Handed to scanTail as its matcher: it answers
// true on the line that settles the reading, and `asked()` says what the reading found.
export function turnQuestionReader(): { matches: (line: string) => boolean; asked: () => boolean } {
  let found = false
  const matches = (line: string): boolean => {
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      return false
    }
    const content = entry?.message?.content
    if (entry?.type === 'user') {
      if (entry.isMeta === true) return false
      const prompted = typeof content === 'string' || (Array.isArray(content) && content.some((block: any) => block?.type === 'text'))
      return prompted
    }
    if (entry?.type !== 'assistant' || !Array.isArray(content)) return false
    for (const block of content) {
      const text = block?.type === 'text' ? block.text
        : block?.type === 'tool_use' && /declare_wait$/.test(String(block.name ?? '')) ? block.input?.question
          : null
      if (typeof text === 'string' && holdsQuestionBlock(text)) found = true
    }
    return found
  }
  return { matches, asked: () => found }
}
