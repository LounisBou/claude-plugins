// hooks/asked-key.ts
// What makes two questions of the round one: the key of a question asked with `ask`, and the plain
// text it is read from. Pure, so a script outside the module (the takeover) reads the same key `ask`
// stores under; question.ts and round.ts import them from here.
import type { Asked } from './question.ts'
import { parseSessionName } from '../core/names.ts'

// The question's text as the pane draws it: the emphasis markers around a span — `**x**`,
// `__x__`, `*x*`, `_x_` and backticks — dropped, the words kept; a marker inside a word
// (snake_case) or before a space (a `* ` list item) is no emphasis. Each span stays on its
// line. The entry itself keeps the text verbatim.
export function plainText(text: string): string {
  return textSpans(text).map(span => span.text).join('')
}

// The same text cut into the spans the pane draws, each mark it carried kept as a style: inline
// code, bold, italic. Joined, the spans are plainText's text. The markers are found as plainText
// always found them, then read as an opening and a closing mark around each span.
export type TextSpan = { text: string; code?: true; bold?: true; italic?: true }
const MARK = { code: ['\uE000', '\uE001'], bold: ['\uE002', '\uE003'], italic: ['\uE004', '\uE005'] } as const
const MARK_NAMES = ['code', 'bold', 'italic'] as const
export function textSpans(text: string): TextSpan[] {
  const marked = text
    .replace(/`([^`\n]+)`/g, `${MARK.code[0]}$1${MARK.code[1]}`)
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, `${MARK.bold[0]}$2${MARK.bold[1]}`)
    .replace(/(^|[^\w*])\*(?=[^\s*])([^\n*]*?[^\s*])\*(?![\w*])/gm, `$1${MARK.italic[0]}$2${MARK.italic[1]}`)
    .replace(/(^|[^\w])_(?=[^\s_])([^\n_]*?[^\s_])_(?!\w)/gm, `$1${MARK.italic[0]}$2${MARK.italic[1]}`)
  const spans: TextSpan[] = []
  const on = { code: 0, bold: 0, italic: 0 }
  let run = ''
  const flush = () => {
    if (run === '') return
    spans.push({ text: run, ...(on.code ? { code: true as const } : {}), ...(on.bold ? { bold: true as const } : {}), ...(on.italic ? { italic: true as const } : {}) })
    run = ''
  }
  for (const char of marked) {
    const mark = MARK_NAMES.find(name => MARK[name][0] === char || MARK[name][1] === char)
    if (!mark) {
      run += char
      continue
    }
    flush()
    on[mark] += char === MARK[mark][0] ? 1 : -1
  }
  flush()
  return spans
}

const flatText = (text: string): string => plainText(text).replace(/\s+/g, ' ').trim()

/**
 * What makes two questions one for the record: the asker's project (its session name's subject),
 * what it blocks (its parts split by `, `, spacing and case aside), the consent it asks, and its
 * fields, choices and recommendation as given.
 */
export function askedKey(entry: Pick<Asked, 'sender' | 'blocks' | 'consent' | 'subject' | 'context' | 'ask' | 'choices' | 'recommended' | 'why'>): string {
  const blocks = entry.blocks.split(', ').map(part => flatText(part).toLowerCase()).filter(part => part !== '').sort()
  const consent = entry.consent ? [entry.consent.kind, entry.consent.repo.toLowerCase(), 'pr' in entry.consent ? entry.consent.pr : 'env' in entry.consent ? entry.consent.env : null] : null
  return JSON.stringify([
    parseSessionName(entry.sender.name)?.subject ?? entry.sender.name, blocks, consent,
    [entry.subject, entry.context, entry.ask].map(flatText), entry.choices.map(choice => [choice.letter, flatText(choice.text)]),
    entry.recommended, entry.why === null ? null : flatText(entry.why),
  ])
}

