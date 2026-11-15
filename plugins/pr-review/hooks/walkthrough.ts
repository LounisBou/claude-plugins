// hooks/walkthrough.ts
// The Iron Rules of start-review and process-comments, held by the engine
// rather than by the model's memory. A skill's start opens its rules; the
// user's own prompts are the only source of a grant. A tool call the rules
// would stop goes through and leaves one line in the journal, except the
// irreversible (a forced push, a deleted comment), denied with the word that
// lifts it. The band above the prompt shows that a walkthrough holds the
// session and what it has kept so far.
//
// Never a trap: "end review" typed by the user, an interrupted turn (Esc), a
// /clear, or the skill's own closing line ends the rules at once (session.ts
// holds those lifecycle hooks; this file holds the guard and the band).
import { fieldsOf, type Host, type Events, type On } from '../core/host.ts'
import { GH_TOOL, PUSH_REFUSAL, decide, needsToolList, pushQuestion, scratchDirOf, type Call } from './policy.ts'
import { askAllow, observed, type JournalHost } from './observe.ts'
import { walkthrough, loop } from './state.ts'

type WalkthroughHost = JournalHost & Host<'tool' | 'ui' | 'fs'>

async function isGhListed($: Host<'tool'>): Promise<boolean> {
  try {
    return (await $.tool.list()).some((t) => t.name === GH_TOOL)
  } catch {
    // Unknown: the resolver route stays open rather than leaving no route at all.
    return false
  }
}

function redraw($: Host<'ui'>): void {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // A session that draws nothing has nothing to redraw.
  }
}

// A piece of the band: its words and, when it has one, the theme colour it takes.
type Piece = { text: string; color?: string }

// The band's pieces, or null when nothing holds the session. The first is the head.
async function bandPieces($: Host<'fs'>): Promise<Piece[] | null> {
  if (loop.isActive) {
    const fixes = loop.fixes.filter((f) => !f.reverted).length
    return [
      { text: 'pr-review · auto-fix-loop' },
      { text: `pass ${loop.pass}/${loop.maxPasses}` },
      { text: `${fixes} fix${fixes === 1 ? '' : 'es'} committed` },
    ]
  }
  const skill = walkthrough.skill
  if (skill !== 'start-review' && skill !== 'process-comments') return null
  const pieces: Piece[] = [{ text: `pr-review · ${skill}` }]
  if (walkthrough.scratchDir) {
    try {
      const names = (await $.fs.list(walkthrough.scratchDir)).map((entry) => String(entry.name))
      const kept = names.filter((n: string) => /^comment-\d+\.md$/.test(n)).length
      const prepared = names.filter((n: string) => /^commit-\d+\.msg$/.test(n)).length
      if (skill === 'start-review') pieces.push({ text: `kept ${kept}`, color: 'success' })
      if (prepared > 0) pieces.push({ text: `prepared commits ${prepared} (say commit or drop)`, color: 'warning' })
    } catch {
      // The directory is gone (a drop all, a reboot): nothing to count.
    }
  }
  pieces.push({ text: '"end review" to lift' })
  return pieces
}

// The tool call an event carries, as the policy reads it.
const callOf = (e: Events['tool.call']): Call => ({ ...e, tool: String(e['tool'] ?? '') })

export function register(on: On<WalkthroughHost>): void {
  on('tool.call', async ($, e, next) => {
    const skill = walkthrough.skill
    if (skill === null) return next(e)
    const call = callOf(e)
    const question = pushQuestion(skill, call)
    // Only the user's own Allow lets the act through: a Deny, or nobody there to answer, refuses it.
    if (question && (await askAllow($, 'push', question)) !== true) return { deny: `pr-review ${skill}: ${PUSH_REFUSAL}` }
    const verdict = decide(skill, call, walkthrough.lastPrompt, needsToolList(call) ? await isGhListed($) : false)
    if (verdict?.irreversible) return { deny: verdict.reason }
    if (verdict) await observed($, verdict.code)
    const path = e['file_path']
    const dir = typeof path === 'string' ? scratchDirOf(path) : undefined
    if (dir && dir !== walkthrough.scratchDir) {
      walkthrough.scratchDir = dir
    }
    const result = await next(e)
    if (dir || e['tool'] === 'Bash') redraw($)
    return result
  }).catch(async (_$, e, next) => {
    // The decision is pure: the net judges the call itself, from the event and
    // module memory alone, so a failed or re-entered hook refuses exactly what
    // the hook would have refused and passes the rest.
    if (next.called) return next(e)
    try {
      // Nobody can be asked from the net: a forced push it meets is refused.
      const call = callOf(e)
      if (pushQuestion(walkthrough.skill, call)) return { deny: `pr-review ${String(walkthrough.skill)}: ${PUSH_REFUSAL}` }
      const verdict = decide(walkthrough.skill, call, walkthrough.lastPrompt, false)
      return verdict?.irreversible ? { deny: verdict.reason } : next(e)
    } catch {
      return walkthrough.skill === null ? next(e) : { deny: 'pr-review: its guard failed while a walkthrough holds the session; say "end review" to lift it.' }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (fieldsOf(e['props'])?.['hasSurvey']) return next(e)
    const pieces = await bandPieces($)
    if (pieces === null) return next(e)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (Box === undefined || Text === undefined) return below
    const children: unknown[] = []
    pieces.forEach((piece, i) => {
      if (i > 0) children.push(' · ')
      children.push(Text({ bold: i === 0, color: piece.color, children: [piece.text] }))
    })
    return Box({
      flexDirection: 'column',
      children: [Text({ key: 'pr-review-band', children }), ...(below ? [below] : [])],
    })
  }).catch(async (_$, e, next) => next(e))
}
