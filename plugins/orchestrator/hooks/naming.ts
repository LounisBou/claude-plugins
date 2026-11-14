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
import { endsAfterMove } from './moving.ts'
import { messageOf, reasonOf, type Host, type On } from './host.ts'
import { currentSessionName, parseSessionName } from '../core/names.ts'
import { logLine } from './module-io.ts'

// The nouns naming holds.
type Held = Host<'plugin' | 'env' | 'process' | 'session' | 'tool' | 'command' | 'prompt'>

// The tool's short name: the model calls it as mcp__orchestrator__rename_session.
export const RENAME_TOOL = 'rename_session'

// The end: the successor closes its predecessor's tab, and where the host
// refuses that close — a tab the plugin did not open — it asks the predecessor
// to end its own session instead, which no refusal reaches: the run is the
// module's. A session the launcher opened is closable by its successor, and sees this
// tool only for the one case where it may end itself: its own move to another machine
// was acknowledged (moving.ts).
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

// Whether this session has asked to end (end_session accepted): the stop gate lets
// the turn that asked go — the session is leaving, and its successor holds its work.
let endAsked = false
export function isEnding(): boolean {
  return endAsked
}

// A call that hands an agent this session's address: the launcher's spawn or rotate
// (its script or the python beneath it) — the brief it writes names the orchestrator —
// and a SendMessage, which the peer reads its sender's name off. Made in the turn
// that renamed, it carries the name the session is about to lose. The launcher is
// often named in a variable or wrapped in a function and called on another line,
// after a `;` or a `&&`, or past a line continuation: a spawn or a rotate is held after
// the launcher's path on its line, after a variable given that path, or after a function
// that calls either, its subcommand quoted or not.
const LAUNCHER_PATH = String.raw`iterm[-_]agent\.(?:sh|py)`
const ON_ITS_LINE = new RegExp(String.raw`\b${LAUNCHER_PATH}\b[^\n]*?\s(?:spawn|rotate)(?:\s|$)`, 'm')
const SEPARATOR = String.raw`(?:[ \t]|\\\n)+`
const SUBCOMMAND = String.raw`["']?(?:spawn|rotate)["']?(?=\s|$|[;&|)])`
const AFTER_PATH = new RegExp(String.raw`\b${LAUNCHER_PATH}["']?${SEPARATOR}${SUBCOMMAND}`)
const ASSIGNED = new RegExp(String.raw`(?:^|[\s;&|(])(\w+)=["']?[^\s;&|]*${LAUNCHER_PATH}`, 'gm')
const FUNCTION = /(\w+)\s*\(\)\s*\{([^}]*)\}/g

function launcherCalled(command: string): boolean {
  if (ON_ITS_LINE.test(command) || AFTER_PATH.test(command)) return true
  const variables = [...command.matchAll(ASSIGNED)].map(m => m[1]!)
  const names = (body: string) => new RegExp(LAUNCHER_PATH).test(body)
    || variables.some(v => new RegExp(String.raw`\$\{?${v}\}?(?!\w)`).test(body))
  const functions = [...command.matchAll(FUNCTION)].filter(m => names(m[2]!)).map(m => m[1]!)
  return variables.some(v => new RegExp(String.raw`\$\{?${v}\}?["']?${SEPARATOR}${SUBCOMMAND}`).test(command))
    || functions.some(f => new RegExp(String.raw`(?:^|[\s;&|(])${f}${SEPARATOR}${SUBCOMMAND}`, 'm').test(command))
}

export function addressesAnAgent(tool: string, command: string): boolean {
  if (tool === 'SendMessage') return true
  return tool === 'Bash' && launcherCalled(command)
}

// The refusal while a rename waits for the turn's end: prose told the model to end the
// turn and it kept going; the module holds the turn's end instead, and resumes it.
export const heldForName = (name: string) =>
  `your name "${name}" is taken when this turn ends: end the turn now; the module resumes you under it`

// The prompt that resumes a session once its name is taken, so an unattended start never
// waits on the operator for its next turn.
export const resumeText = (name: string) => `Your name "${name}" is taken. Continue where you left off.`

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

  // The tool is declared at every start: register.ts owns session.start's
  // no-matcher registration, so this one carries the empty matcher. Listed with
  // its schema, never behind the tool search: a model that must search for it
  // first would hand the operator the /rename line instead.
  // A session the launcher opened — an agent, a review session, a successor —
  // carries the name it was launched with, and never sees the rename tool: a review
  // session's subagent once renamed its agent « Coord: norms check… », a
  // second coordinator every listing then counted. It sees the end tool alone, which
  // it may use only once its own move was acknowledged.
  on('session.start', {}, async ($, e, next) => {
    try {
      const spawned = Boolean(await $.env.get('ORCHESTRATOR_SPAWNED'))
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
      await $.tool.register({
        name: END_TOOL,
        isDeferred: false,
        description: spawned
          ? 'Ends this session when the current turn ends. Only for an orchestrator whose move to another machine was acknowledged by the receiving module.'
          : 'Ends this session when the current turn ends. Only for an orchestrator or a coordinator that has handed over and whose successor asks it to end its session.',
        inputSchema: { type: 'object', properties: {} },
      })
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

  // While a rename waits for the turn's end, a call that would hand an agent the old
  // name is refused: the main thread's own, the one the rename was asked from.
  for (const tool of ['Bash', 'SendMessage']) {
    on('tool.call', { tool }, async ($, e, next) => {
      if (pending !== null && !e.agentId && addressesAnAgent(tool, String(e['command'] ?? ''))) {
        return { deny: heldForName(pending) }
      }
      return next(e)
    }).catch(async ($, e, next) => {
      await logLine($, 'naming', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
      return next(e)
    })
  }

  on('tool.call', { tool: `mcp__orchestrator__${END_TOOL}` }, async ($, e) => {
    if (e.agentId) return { result: MAIN_THREAD_ONLY, isError: true }
    if (await $.env.get('ORCHESTRATOR_SPAWNED') && !endsAfterMove()) {
      return { result: 'this session was opened by the launcher; its successor closes its tab', isError: true }
    }
    ending = true
    endAsked = true
    return { result: 'This session ends when this turn ends.' }
  }).catch(async ($, e, next) => {
    await logLine($, 'naming', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the end could not be recorded', isError: true }
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn completes inside the main one: what the main loop asked waits
    // for the main loop's own completion, never run while the turn still waits on it.
    if (e.agentId) return next(e)
    if (e.isAborted) {
      // The operator stopped the turn that asked: neither the rename nor the end runs.
      if (pending !== null || ending) await logLine($, 'naming', 'the turn was interrupted: the rename or end it asked is dropped')
      pending = null
      ending = false
      endAsked = false
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
      if (!ending && name.startsWith('Orch: ') && await movedHome($, name)) {
        $.command.run({ command: 'exit' })
          .catch((err: unknown) => logLine($, 'naming', `exit after the move into the home session failed: ${reasonOf(err)}`))
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

// The launcher's move of this session into a home session of its own, as argv.
export function homeArgv(root: string, sessionId: string, name: string): string[] {
  return [`${root}/skills/iterm-agents/scripts/iterm-agent.sh`, 'home', '--session', sessionId, '--name', name, '--prompt', resumeText(name)]
}

// Whether the launcher moved this session (`moved: …` on its first line). A session it
// keeps (`stay: …`) and a move that failed both stay where they are; a failure is logged.
async function movedHome($: Host<'plugin' | 'env' | 'process' | 'session'>, name: string): Promise<boolean> {
  try {
    const sessionId = await $.session.id()
    const done = await $.process.run(homeArgv($.plugin.root, sessionId, name), { timeoutMs: HOME_MOVE_MS })
    const first = String(done?.stdout ?? '').split('\n')[0] ?? ''
    if (done?.exitCode === 0 && first.startsWith('moved: ')) {
      await logLine($, 'naming', `moved into its home session: ${first.slice('moved: '.length)}`)
      return true
    }
    if (done?.exitCode !== 0) {
      await logLine($, 'naming', `the move into a home session failed, the session stays where it is: ${String(done?.stderr ?? '').trim().split('\n').pop() || `exit ${done?.exitCode}`}`)
    }
  } catch (err) {
    await logLine($, 'naming', `the move into a home session could not run, the session stays where it is: ${reasonOf(err)}`)
  }
  return false
}
