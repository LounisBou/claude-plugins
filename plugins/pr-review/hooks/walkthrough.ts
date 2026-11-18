// hooks/walkthrough.ts
// The band above the prompt: it shows that a walkthrough (start-review, process-comments) or the
// auto-fix-loop holds the session and what it has kept so far. It only draws: no call is held
// or refused here. A skill's start opens the band; an interrupted turn (Esc), a /clear, a
// session's end, or the skill's own closing line close it (session.ts holds those lifecycle hooks;
// this file holds the scratch directory the band counts in, and the band).
import { fieldsOf, type Host, type On } from '../core/host.ts'
import { walkthrough, loop } from './state.ts'

type WalkthroughHost = Host<'ui' | 'fs'>

// The PR scratch directory a path lies in, where the walkthroughs keep their own files (comment
// bodies, commit messages, request files), for the band: `/tmp/claude-pr-review-12`. A path that
// climbs out with `..` is not one.
export function scratchDirOf(path: string): string | undefined {
  const m = /^((?:\/private)?\/tmp\/claude-pr-review-\d+)\//.exec(path)
  return m && !/(^|\/)\.\.(\/|$)/.test(path) ? m[1] : undefined
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
  return pieces
}

export function register(on: On<WalkthroughHost>): void {
  // The scratch directory the walkthrough writes to is what the band counts in.
  on('tool.call', async ($, e, next) => {
    if (walkthrough.skill === null) return next(e)
    const path = e['file_path']
    const dir = typeof path === 'string' ? scratchDirOf(path) : undefined
    if (dir && dir !== walkthrough.scratchDir) walkthrough.scratchDir = dir
    const result = await next(e)
    if (dir || e['tool'] === 'Bash') redraw($)
    return result
  }).catch(async (_$, e, next) => next(e))

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
