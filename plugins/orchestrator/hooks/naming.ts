// hooks/naming.ts
// The session's own name and its own end. The rename: a tool the model calls with the house name, and the
// host's own /rename run for it once the turn ends. A session the operator
// starts by hand is named after its directory stem, which no listing reads as a
// role; the model chooses the subject, so the model asks for the name, and the
// module carries it out. The host refuses a command run from a hook the turn is
// waiting on (measured live: a tool.call's run is refused with « run it from a
// later event (turn.complete) »), so the call only records the name and the
// turn's completion runs the rename — the same transcript entry a typed /rename
// writes, the one every name walk reads.
import { launcherOf } from '../core/orchestration.ts'
import { answerOf, messageOf, reasonOf, type Host, type On } from './host.ts'
import { currentSessionName, parseSessionName } from '../core/names.ts'
import { logLine } from './module-io.ts'
import { sessionNameOf, sessionRole } from './supervision.ts'
import { typedByOperator } from './models-guard.ts'

// The nouns naming holds.
type Held = Host<'plugin' | 'env' | 'process' | 'session' | 'tool' | 'command' | 'prompt' | 'fs' | 'clock' | 'ui'>

// The tool's short name: the model calls it as mcp__orchestrator__rename_session.
export const RENAME_TOOL = 'rename_session'

// The end: the successor closes its predecessor's tab, and where the host
// refuses that close — a tab the plugin did not open — it asks the predecessor
// to end its own session instead, which no refusal reaches: the run is the
// module's. A session the launcher opened is closed by its successor and never sees this tool.
export const END_TOOL = 'end_session'

// The names a session takes for itself: the two roles a session the operator
// starts by hand declares. An agent and an auditor are named by the launcher at
// spawn, never by themselves. The subject is the launcher's own shape: at most
// twenty-five characters, neither starting nor ending with a space. The shape is core's; a name
// asked in the former shape, a blank before the colon, is taken written the current way.
const SELF_ROLES: ReadonlySet<string> = new Set(['orchestrator', 'coordinator'])

// The name as asked, or why it is refused: the refusal names the shape, so the
// model's next call can be the right one.
// The refusal a subagent's call gets: the session's name and its end are the main
// loop's. A review subagent once renamed its own session; the env marker that keeps
// the launcher's sessions out is the parent's, shared by every subagent it starts.
export const MAIN_THREAD_ONLY = "only the session's main thread names or ends it"

// The prompt that resumes a session once its name is taken, so an unattended start never
// waits on the operator for its next turn.
export const resumeText = (name: string) => `Your name "${name}" is taken. Continue where you left off.`

// A successor's takeover (`succession.sh takeover`), run by the main thread: a session the
// launcher opened has no rename, so the end of the turn that took over is the one that moves it
// into its home session, as the naming turn moves an orchestrator the operator started.
const TAKEOVER = /\bsuccession\.(?:sh|ts)["']?[ \t]+takeover(?=\s|$)/
export function runsTakeover(command: string): boolean {
  return TAKEOVER.test(command)
}

// The prompt window 0 resumes a successor with once its takeover's turn moved it.
export const TAKEN_OVER_TEXT = 'Your takeover is done and this session now runs in its home session. Continue where you left off.'

// The prompt that wakes a successor the launcher found already in a home session: its takeover is done
// there, and its turn ended on the announcement with nothing of its own yet to start the next one.
export const TAKEN_OVER_HOME_TEXT = 'Your takeover is done and this session already runs in its home session. Go on to step 4 of your takeover, unless your takeover turn already did it: dispatch every open row with no agent that the phase rules allow, or declare the wait naming what you wait on.'

// The prompt that wakes a successor whose move did not happen (the launcher kept it for another reason, or the move failed):
// its turn ended on the announcement and nothing of its own is there yet to start the next one.
export const TAKEN_OVER_STAYED_TEXT = 'Your takeover is done but this session stays in its tab: the move into a home session did not happen. Go on to step 4 of your takeover, unless your takeover turn already did it: dispatch every open row with no agent that the phase rules allow, or declare the wait naming what you wait on.'

export function checkName(raw: unknown): { name: string } | { refused: string } {
  const name = typeof raw === 'string' ? raw : ''
  const role = parseSessionName(name)?.role
  if (role !== undefined && SELF_ROLES.has(role)) return { name: currentSessionName(name) }
  return { refused: `a session names itself "Orch: <subject>" or "Coord: <subject>", the subject at most 25 characters and neither starting nor ending with a space, got "${name}"` }
}

export function register(on: On<Held>): void {
  // Module memory: the name asked during this turn, run at its completion. A
  // second call in the same turn replaces the first — the last word stands.
  let pending: string | null = null
  let ending = false
  let tookOver = false
  // The move made and not yet over: what a prompt typed now must know of it.
  const hold: HomeHold = { left: null, moving: null, tried: false, exits: 0, stale: 0 }
  // A session the operator started (the launcher's own are moved by their takeover): under this
  // module from its start, so its turn end may find it an orchestrator already, resumed outside its
  // home session, and move it.
  let operatorStarted = false

  // The tool is declared at every start: register.ts owns session.start's
  // no-matcher registration, so this one carries the empty matcher. Listed with
  // its schema, never behind the tool search: a model that must search for it
  // first would hand the operator the /rename line instead.
  // A session the launcher opened — an agent, a review session, a successor —
  // carries the name it was launched with, and never sees the rename tool: a review
  // session's subagent once renamed its agent « Coord: norms check… », a
  // second coordinator every listing then counted. It sees neither tool.
  on('session.start', {}, async ($, e, next) => {
    try {
      const spawned = Boolean(await $.env.get('ORCHESTRATOR_SPAWNED'))
      operatorStarted = !spawned
      if (!spawned) {
        await $.tool.register({
          name: RENAME_TOOL,
          isDeferred: false,
          description: 'Renames this session to its role name, "Orch: <subject>" or "Coord: <subject>" (subject at most 25 characters). The name is taken when the current turn ends.',
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string', description: 'The full name, e.g. "Orch: <subject>"' } },
            required: ['name'],
          },
        })
      }
      if (!spawned) {
        await $.tool.register({
          name: END_TOOL,
          isDeferred: false,
          description: 'Ends this session when the current turn ends. Only for an orchestrator or a coordinator that has handed over and whose successor asks it to end its session.',
          inputSchema: { type: 'object', properties: {} },
        })
      }
    } catch (err) {
      // A start never fails on the tool: the session runs, unnamed by itself.
      await logLine($, 'naming', `rename tool not registered: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'naming', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${RENAME_TOOL}` }, async ($, e) => {
    if (e.agentId) return { result: MAIN_THREAD_ONLY, isError: true }
    if (await $.env.get('ORCHESTRATOR_SPAWNED')) {
      return { result: 'this session was named by the launcher and keeps that name', isError: true }
    }
    const checked = checkName(e['name'])
    if ('refused' in checked) return { result: checked.refused, isError: true }
    pending = checked.name
    return { result: `This session is renamed "${checked.name}" when this turn ends.` }
  }).catch(async ($, e, next) => {
    await logLine($, 'naming', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the rename could not be recorded; hand the operator the /rename line instead', isError: true }
  })

  // A takeover that ran: its turn's end moves the session into its home session. A successor
  // orchestrator's alone: an agent or a reviewer runs the script in its checkout (its tests, a
  // proof) and was told to go on to step 4 of a takeover that was never its own (2026-11-15).
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const out = await next(e)
    if (!e.agentId && runsTakeover(String(e['command'] ?? ''))) {
      const answer = answerOf(out)
      // Read past the command's answer: a failure here is logged and moves nothing, never a second run of it.
      if (!answer.isError && answer.deny === undefined) {
        const role = await $.session.id().then(id => sessionRole($, id)).catch(async (err: unknown) => {
          await logLine($, 'naming', `the takeover's session role could not be read, nothing moves: ${reasonOf(err)}`)
          return undefined
        })
        tookOver = role === 'orchestrator'
        if (role !== undefined && !tookOver) await logLine($, 'naming', `a takeover run by a session that is not an orchestrator (${role ?? 'no role read'}): nothing moves`)
      }
    }
    return out
  }).catch(async ($, e, next) => {
    await logLine($, 'naming', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${END_TOOL}` }, async ($, e) => {
    if (e.agentId) return { result: MAIN_THREAD_ONLY, isError: true }
    if (await $.env.get('ORCHESTRATOR_SPAWNED')) {
      return { result: 'this session was opened by the launcher; its successor closes its tab', isError: true }
    }
    ending = true
    return { result: 'This session ends when this turn ends.' }
  }).catch(async ($, e, next) => {
    await logLine($, 'naming', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the end could not be recorded', isError: true }
  })

  // A prompt the operator types once the session has moved: turned away, with the tab that holds it
  // now named, so the old host ends at once and no prompt runs in a session about to be left. His
  // words stay in the composer as the host hands them back.
  on('prompt.submit', {}, async ($, e, next) => {
    if (!typedByOperator(String(e.origin?.kind ?? ''))) return next(e)
    if (hold.moving !== null) await hold.moving
    if (hold.left !== null) {
      await logLine($, 'naming', 'a prompt typed after the move into the home session was refused: it is typed in the new tab')
      return { drop: movedPromptLine(hold.left.name) }
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'naming', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The exit the move queued, run late: the move was declared failed and the session stays here, so
  // the exit that waited for an idle host must not end it with no home. Only the module's own runs.
  on('command.run', { command: 'exit' }, async ($, e, next) => {
    if (hold.stale > 0 && (e as { origin?: { kind?: string } }).origin?.kind === 'plugin') {
      hold.stale--
      await logLine($, 'naming', 'an exit queued by the failed move into the home session was dropped: this session stays here')
      return { text: 'The exit queued by the failed move into the home session is dropped: this session stays here.' }
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'naming', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn completes inside the main one: what the main loop asked waits
    // for the main loop's own completion, never run while the turn still waits on it.
    if (e.agentId) return next(e)
    // A turn that ends after the move: a prompt typed before the move was known ran in this session.
    // The exit queued by the move is asked again, so this session ends at once and nothing else runs.
    if (hold.left !== null) {
      askMoveExit($, hold, 'exit after a turn that ended past the move failed')
      return next(e)
    }
    const homeAfterTakeover = tookOver && !e.isAborted
    tookOver = false
    if (e.isAborted) {
      // The operator stopped the turn that asked: neither the rename nor the end runs.
      if (pending !== null || ending) await logLine($, 'naming', 'the turn was interrupted: the rename or end it asked is dropped')
      pending = null
      ending = false
      return next(e)
    }
    if (pending !== null) {
      const name = pending
      pending = null
      // Not awaited: the run is queued until the session is idle, which this
      // very completion is still holding. Its failure is said in the log.
      $.command.run({ command: 'rename', args: name })
        .catch((err: unknown) => logLine($, 'naming', `rename to "${name}" failed: ${reasonOf(err)}`))
      // An orchestrator moves into its home session here, where it is resumed anyway:
      // the launcher starts the home server whose window 0 resumes this very session,
      // and the tab that shows it, then this session ends and window 0 takes over with
      // the resume's prompt. Anything but a move leaves the session where it is.
      if (!ending && parseSessionName(name)?.role === 'orchestrator' && await moveHome($, hold, name, resumeText(name)) === 'moved') {
        askMoveExit($, hold, 'exit after the move into the home session failed')
        return next(e)
      }
      // Then the turn that resumes it, queued behind the rename: a session started
      // unattended goes on under its name instead of waiting on the operator. Not for
      // a session that also asked to end — it leaves.
      if (!ending) {
        $.prompt.submit({ text: resumeText(name) })
          .catch((err: unknown) => logLine($, 'naming', `the resume under "${name}" failed: ${reasonOf(err)}`))
      }
    }
    // A successor that took over in a plain tab: the same move, under the name the launcher gave
    // it, which the launcher reads on its tty. Its agents in tabs stay there; its spawns from
    // window 0 are windows. Where the launcher finds it in a home session already, or the move did
    // not happen, the turn that ended on the announcement is not followed by one of its own making,
    // so the module starts it, as it does for a session resumed under its name.
    else if (homeAfterTakeover && !ending) {
      const done = await moveHome($, hold, '', TAKEN_OVER_TEXT)
      if (done === 'moved') {
        askMoveExit($, hold, 'exit after the move into the home session failed')
        return next(e)
      }
      $.prompt.submit({ text: done === 'home' ? TAKEN_OVER_HOME_TEXT : TAKEN_OVER_STAYED_TEXT })
        .catch((err: unknown) => logLine($, 'naming', `the wake of a successor that stays in its tab failed: ${reasonOf(err)}`))
    }
    // An orchestrator the operator resumed outside its home session (its name is already Orch: …)
    // calls no rename: the end of its first turn that was not interrupted moves it, whatever the
    // turn did. An interrupted turn moves nothing, so the next turn end tries; once tried, any
    // answer of the launcher stands.
    else if (operatorStarted && !hold.tried && !ending) {
      const name = await ownOrchestratorName($)
      if (name !== null && await moveHome($, hold, name, resumeText(name)) === 'moved') {
        askMoveExit($, hold, 'exit after the move into the home session failed')
        return next(e)
      }
    }
    if (ending) {
      ending = false
      // Queued after any rename, run once the session is idle.
      $.command.run({ command: 'exit' })
        .catch((err: unknown) => logLine($, 'naming', `exit failed: ${reasonOf(err)}`))
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'naming', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// The bound of the move: the launcher waits for the new tab's client, its spawn timeout.
export const HOME_MOVE_MS = 90_000

// Past window 0's wait for the old session to end, the time its launcher takes to close the home
// server and its tab, before this session says the move failed.
export const HOME_GRACE_MS = 10_000

// What the operator reads when he types in the old tab after the move: where his prompt goes.
export const movedPromptLine = (name: string): string =>
  `This session moved into its home session: type your prompt in the tab right of this one${name === '' ? '' : ` ("${name}")`}; this tab is closing.`

// The launcher's move of this session into a home session of its own, as argv. No name: the
// launcher reads the session's own on its tty.
export function homeArgv(root: string, sessionId: string, name: string, prompt = resumeText(name)): string[] {
  return [launcherOf(root), 'home', '--session', sessionId, ...(name === '' ? [] : ['--name', name]), '--prompt', prompt]
}

// What the launcher did with this session, from its first line: `moved: …` (moved into a home session,
// its second line `wait: <seconds>` how long window 0 waits for this session to end, handed to `onHeld`),
// `home` (`stay: this session already runs in a home session`: it is in one), or null (a session it
// keeps for another reason, or a move that failed; both are logged).
const ALREADY_HOME = 'stay: this session already runs in a home session'

// The session's own name when it is an orchestrator's, else null: read where the move reads it.
async function ownOrchestratorName($: Held): Promise<string | null> {
  try {
    const name = await sessionNameOf($, await $.session.id())
    return name !== null && parseSessionName(name)?.role === 'orchestrator' ? name : null
  } catch (err) {
    await logLine($, 'naming', `the session's name could not be read, nothing moves: ${reasonOf(err)}`)
    return null
  }
}

// The move made and not yet over: the tab it opened, until the old host ends (this process then ends with
// it) or fails to within window 0's wait (the timer). While it stands, a prompt the operator types is
// turned away: run here, it would go ahead of the queued exit and the old host would never end.
// `exits` counts the exits the move queued and the host has not run; the failure turns them into `stale`,
// the ones the command hook drops when they run, so a failed move never ends the session it left in place.
export type HomeHold = { left: { readonly name: string } | null; moving: Promise<unknown> | null; tried: boolean; exits: number; stale: number }

// The exit that ends the old host once the move is made, queued until the host is idle and counted.
function askMoveExit($: Held, hold: HomeHold, failure: string): void {
  hold.exits++
  $.command.run({ command: 'exit' })
    .catch((err: unknown) => {
      // An exit the host refused never runs: it is no longer one to count or to drop.
      if (hold.exits > 0) hold.exits--
      else if (hold.stale > 0) hold.stale--
      return logLine($, 'naming', `${failure}: ${reasonOf(err)}`)
    })
}

// The move, with what it holds: the launcher's `home`, and once it moved, the prompts held until the
// old session ends or the wait for it is over.
async function moveHome($: Held, hold: HomeHold, name: string, prompt: string): Promise<'moved' | 'home' | null> {
  hold.tried = true
  const run = movedHome($, name, prompt, waitS => {
    // Armed first: a timer that cannot be armed must not leave the prompts held with nothing to free them.
    const mine = { name }
    $.clock.after(waitS * 1000 + HOME_GRACE_MS, () => failedMove($, hold, mine, waitS))
    hold.left = mine
  })
  const tracked = run.then(() => undefined, () => undefined)
  hold.moving = tracked
  void tracked.then(() => { if (hold.moving === tracked) hold.moving = null })
  return run
}

// The wait is over and this session still runs: the move failed, window 0's launcher closes the home
// server and its tab, and this session says so where the operator is.
async function failedMove($: Held, hold: HomeHold, mine: { readonly name: string }, waitS: number): Promise<void> {
  if (hold.left !== mine) return
  hold.left = null
  hold.stale += hold.exits
  hold.exits = 0
  await logLine($, 'naming', `the old session did not end within ${waitS}s after the move into its home session: it stays here, and the launcher closes the home server and its tab`)
  try {
    $.ui.toast(`The move into the home session did not end this session within ${waitS}s: the launcher closes the new tab, and this session stays here.`)
  } catch (err) {
    await logLine($, 'naming', `the failed move could not be said in the session: ${reasonOf(err)}`)
  }
}

// The wait the launcher states on its second line, `wait: <seconds>`, or null when it states none.
function waitOf(line: string): number | null {
  const seconds = /^wait: (\d+)$/.exec(line)?.[1]
  return seconds === undefined || Number(seconds) <= 0 ? null : Number(seconds)
}

async function movedHome($: Host<'plugin' | 'env' | 'process' | 'session'>, name: string, prompt: string, onHeld: (waitS: number) => void): Promise<'moved' | 'home' | null> {
  try {
    const sessionId = await $.session.id()
    const done = await $.process.run(homeArgv($.plugin.root, sessionId, name, prompt), { timeoutMs: HOME_MOVE_MS })
    const first = String(done?.stdout ?? '').split('\n')[0] ?? ''
    if (done?.exitCode === 0 && first.startsWith('moved: ')) {
      await logLine($, 'naming', `moved into its home session: ${first.slice('moved: '.length)}`)
      const waitS = waitOf(String(done.stdout ?? '').split('\n')[1] ?? '')
      if (waitS === null) await logLine($, 'naming', 'the launcher gave no wait for the old session: a prompt typed before it ends is not held')
      else onHeld(waitS)
      return 'moved'
    }
    if (done?.exitCode !== 0) {
      await logLine($, 'naming', `the move into a home session failed, the session stays where it is: ${String(done?.stderr ?? '').trim().split('\n').pop() || `exit ${done?.exitCode}`}`)
    } else {
      await logLine($, 'naming', `the launcher kept the session where it is: ${first.startsWith('stay: ') ? first.slice('stay: '.length) : first || 'no answer'}`)
      if (first === ALREADY_HOME) return 'home'
    }
  } catch (err) {
    await logLine($, 'naming', `the move into a home session could not run, the session stays where it is: ${reasonOf(err)}`)
  }
  return null
}
