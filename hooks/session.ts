// hooks/session.ts
// The session's lifecycle, one hook per event for the whole module: the two
// tools registered at the start, a skill's start (its rules, its preflight),
// the user's words, the end of a turn and the end of the session. The feature
// files keep their decisions pure; this file applies them.
import { SKILL_KEYS, releases, endsWalkthrough } from './policy.ts'
import { walkthrough, startWalkthrough, endWalkthrough, preflight } from './state.ts'
import { OPEN_COMMENTS, OPEN_COMMENTS_DESCRIPTION, OPEN_COMMENTS_SCHEMA } from './triage.ts'
import { LOOP_TOOL, LOOP_DESCRIPTION, LOOP_SCHEMA, releaseLoop } from './loop.ts'
import { PASSED_NOTE, failedText } from './commands.ts'

// The prompts that are the user's own words: typed at the terminal or sent
// through the Remote Control bridge.
const USER_ORIGINS = new Set(['composer', 'bridge'])

function redraw($: any): void {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // A session that draws nothing has nothing to redraw.
  }
}

export function register(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    // Each tool on its own: one that fails to register leaves the other listed.
    // In the tool list from the start (isDeferred false): the skills call them
    // first thing, and behind tool search the model would reach for Bash.
    for (const spec of [
      { name: OPEN_COMMENTS, description: OPEN_COMMENTS_DESCRIPTION, inputSchema: OPEN_COMMENTS_SCHEMA },
      { name: LOOP_TOOL, description: LOOP_DESCRIPTION, inputSchema: LOOP_SCHEMA },
    ]) {
      try {
        await $.tool.register({ ...spec, isDeferred: false })
      } catch {
        // Not listed: the skill takes its Bash route.
      }
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  // A skill of this plugin starts: its rules hold from now on, and the
  // preflight runs once per session (the skill reads that it passed, or why
  // it stops). A hook that fails passes the skill's own text through.
  on('skill.prompt', async ($: any, e: any, next: any) => {
    const skill = SKILL_KEYS[String(e.skill)]
    if (!skill) return next(e)
    startWalkthrough(skill)
    if (skill === 'auto-fix-loop') releaseLoop()
    redraw($)
    const computed = await next(e)
    if (!preflight.hasPassed) {
      const run = await $.process.run(['bash', $.plugin.root + '/scripts/preflight.sh'], { timeoutMs: 60_000 })
      if (run.exitCode !== 0) return { text: failedText(run) }
      preflight.hasPassed = true
    }
    return { text: PASSED_NOTE + String(computed?.text ?? '') }
  }).catch(async (_$: any, e: any, next: any) => next(e))

  // Never refuses a prompt: it only reads the user's words.
  on('prompt.submit', async ($: any, e: any, next: any) => {
    const text = String(e.text ?? '')
    if (USER_ORIGINS.has(String(e.origin?.kind))) {
      // The user's own prompt takes the session back from a running loop.
      releaseLoop()
      if (walkthrough.skill !== null) {
        if (releases(text)) endWalkthrough()
        else walkthrough.lastPrompt = text
      }
      redraw($)
    } else if (walkthrough.skill !== null && !e.turnId) {
      // A turn nobody typed (a notification, a peer, a plugin) grants nothing.
      walkthrough.lastPrompt = ''
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('turn.complete', async ($: any, e: any, next: any) => {
    if (!e.agentId) {
      if (e.reason === 'aborted') {
        // An interrupted turn: the user takes the session back from every rule.
        releaseLoop()
        endWalkthrough()
        redraw($)
      } else if (walkthrough.skill !== null && endsWalkthrough(walkthrough.skill, String(e.answer ?? ''))) {
        endWalkthrough()
        redraw($)
      }
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('session.end', async ($: any, e: any, next: any) => {
    releaseLoop()
    endWalkthrough()
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))
}
