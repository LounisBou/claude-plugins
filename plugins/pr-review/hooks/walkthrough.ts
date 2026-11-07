// hooks/walkthrough.ts
// The Iron Rules of start-review and process-comments, held by the engine
// rather than by the model's memory. A skill's start opens its rules; the
// user's own prompts are the only source of a grant; a tool call the rules
// refuse is denied with the word that lifts it. The band above the prompt
// shows that a walkthrough holds the session and what it has kept so far.
//
// Never a trap: "end review" typed by the user, an interrupted turn (Esc), a
// /clear, or the skill's own closing line ends the rules at once (session.ts
// holds those lifecycle hooks; this file holds the guard and the band).
import { GH_TOOL, decide, needsToolList, scratchDirOf } from './policy.ts'
import { walkthrough, loop, MAX_PASSES } from './state.ts'

async function isGhListed($: any): Promise<boolean> {
  try {
    return (await $.tool.list()).some((t: any) => t.name === GH_TOOL)
  } catch {
    // Unknown: the resolver route stays open rather than leaving no route at all.
    return false
  }
}

function redraw($: any): void {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // A session that draws nothing has nothing to redraw.
  }
}

// A piece of the band: its words and, when it has one, the theme colour it takes.
type Piece = { text: string; color?: string }

// The band's pieces, or null when nothing holds the session. The first is the head.
async function bandPieces($: any): Promise<Piece[] | null> {
  if (loop.isActive) {
    const fixes = loop.fixes.filter((f) => !f.reverted).length
    return [
      { text: 'pr-review · auto-fix-loop' },
      { text: `pass ${loop.pass}/${MAX_PASSES}` },
      { text: `${fixes} fix${fixes === 1 ? '' : 'es'} committed` },
    ]
  }
  const skill = walkthrough.skill
  if (skill !== 'start-review' && skill !== 'process-comments') return null
  const pieces: Piece[] = [{ text: `pr-review · ${skill}` }]
  if (walkthrough.scratchDir) {
    try {
      const names = (await $.fs.list(walkthrough.scratchDir)).map((entry: any) => String(entry.name))
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

export function register(on: any): void {
  on('tool.call', async ($: any, e: any, next: any) => {
    const skill = walkthrough.skill
    if (skill === null) return next(e)
    const reason = decide(skill, e, walkthrough.lastPrompt, needsToolList(e) ? await isGhListed($) : false)
    if (reason) return { deny: reason }
    const dir = typeof e.file_path === 'string' ? scratchDirOf(e.file_path) : undefined
    if (dir && dir !== walkthrough.scratchDir) {
      walkthrough.scratchDir = dir
    }
    const result = await next(e)
    if (dir || e.tool === 'Bash') redraw($)
    return result
  }).catch(async (_$: any, e: any, next: any) => {
    // The decision is pure: the net judges the call itself, from the event and
    // module memory alone, so a failed or re-entered hook refuses exactly what
    // the hook would have refused and passes the rest.
    if (next.called) return next(e)
    try {
      const reason = decide(walkthrough.skill, e, walkthrough.lastPrompt, false)
      return reason ? { deny: reason } : next(e)
    } catch {
      return walkthrough.skill === null ? next(e) : { deny: 'pr-review: its guard failed while a walkthrough holds the session; say "end review" to lift it.' }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: any) => {
    if (e.props?.hasSurvey) return next(e)
    const pieces = await bandPieces($)
    if (pieces === null) return next(e)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const children: any[] = []
    pieces.forEach((piece, i) => {
      if (i > 0) children.push(' · ')
      children.push(Text({ bold: i === 0, color: piece.color, children: [piece.text] }))
    })
    return Box({
      flexDirection: 'column',
      children: [Text({ key: 'pr-review-band', children }), ...(below ? [below] : [])],
    })
  }).catch(async (_$: any, e: any, next: any) => (next.called ? next(e) : next(e)))
}
