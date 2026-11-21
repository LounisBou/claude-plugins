// hooks/permission-wait.ts
// An agent parked on a permission dialog, told to its orchestrator as the dialog appears. The host
// raises the classic PermissionRequest as it is about to show the dialog; the ask `tool.check`
// announced for the call, bound to it by core's rule (permission-ask.ts), gives the call's id and the
// host's reason; the call's end (`tool.call`), or its loop's turn end, is the dialog's answer at the
// latest. One line per dialog, and one reminder when its call has not ended past the busy bound
// (stop-gate.ts NOTICE_TTL_MS): the host raises nothing at the operator's answer, and an approved call
// runs inside the same `tool.call`, so the reminder says the dialog may still wait or the call runs on,
// and the dialog is forgotten once reminded. The line is a side effect: the hook hands back what the chain beneath
// answered at once, and the relay runs after it, bounded and never awaited, so no read or send of it
// holds the dialog. Only an agent's dialog is told: any other role's is the operator's own tab.
import { NOTICE_TTL_MS, isDegradedPass, withDeadline } from './stop-gate.ts'
import { orchestratorOn, selfOf } from './supervision.ts'
import { roleOf } from './session-name.ts'
import { logLine } from './module-io.ts'
import { askOfDialog, stableJson } from '../core/permission-ask.ts'
import { fieldsOf, messageOf, type Caught, type Events, type Host, type On } from './host.ts'

// The bound on the relay of one line: the session's row, its orchestrator found, the send.
export const PERMISSION_BOUND_MS = 5000
// The room the target and the host's reason get on the line, each cut between words past it.
export const TARGET_ROOM = 120
export const REASON_ROOM = 200
// The asks and the dialogs the module remembers at once, the oldest dropped: a call that never ends leaves one.
export const ASKS_KEPT = 50

// An ask `tool.check` announced for a call: its id, tool, loop (a subagent's id, undefined for the
// main one), arguments (core's stableJson) and the host's reason.
export type Ask = { readonly id: string; readonly tool: string; readonly agent: string | undefined; readonly input: string; readonly reason: string | null }
// A dialog shown: the ask it matched (`id` null when none did), its tool, loop and arguments, and the target the line names.
export type Dialog = { readonly id: string | null; readonly tool: string; readonly agent: string | undefined; readonly input: string; readonly target: string; readonly reason: string | null }
export type DialogMemory = { asks: Ask[]; open: Dialog[] }

export function newDialogMemory(): DialogMemory {
  return { asks: [], open: [] }
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null)

// What the call's arguments name plainly, on one line: a path, a command line, a URL, a skill, a
// pattern; '' when they name none.
export function dialogTarget(input: unknown): string {
  const args = fieldsOf(input) ?? {}
  const named = ['file_path', 'notebook_path', 'path', 'command', 'url', 'skill', 'pattern'].map(key => textOf(args[key])).find(value => value !== null)
  return named ? named.replace(/\s+/g, ' ').trim() : ''
}

// An http(s) URL's origin, which carries no credentials; null for anything else.
function originOf(text: string): string | null {
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

/*
 * `text` within `room` characters, cut between words and never inside one: a secret in it is kept
 * whole or left out, so the transcripts' redaction, which matches whole values, still finds it. A
 * single word too long for the room is a path kept by its end (the file's name), a URL by its origin,
 * or left out.
 */
export function cutWords(text: string, room: number): string {
  if (text.length <= room) return text
  const space = text.lastIndexOf(' ', room - 2)
  if (space > 0) return `${text.slice(0, space)} …`
  if (/^[/~]\S*$/.test(text)) return `…${text.slice(text.length - room + 1)}`
  const origin = originOf(text)
  return origin !== null && origin.length < room ? `${origin}…` : '…'
}

// The ask a `tool.check` verdict is, kept: an `ask` on a real call (it has an id); anything else, nothing.
export function noteAsk(memory: DialogMemory, e: Events['tool.check'], verdict: unknown): void {
  const answer = fieldsOf(verdict)
  if (answer?.['decision'] !== 'ask' || typeof e.tool_use_id !== 'string') return
  memory.asks = [...memory.asks.filter(ask => ask.id !== e.tool_use_id), {
    id: e.tool_use_id, tool: e.tool, agent: e.agentId, input: stableJson(e.input), reason: textOf(answer['reason']),
  }].slice(-ASKS_KEPT)
}

/*
 * The dialog a request opens, or null for a second request in a dialog already open (the same tool,
 * loop and arguments, and no new ask for them). An ask matched by core's rule is a new call: a dialog
 * of the same arguments still remembered is one whose end the module did not see, and gives way.
 */
export function openDialog(memory: DialogMemory, tool: string, input: unknown, agent: string | undefined): Dialog | null {
  const key = stableJson(input)
  const same = (d: Dialog): boolean => d.tool === tool && d.agent === agent && d.input === key
  const ask = askOfDialog(memory.asks, tool, input, agent)
  if (ask === undefined && memory.open.some(same)) return null
  memory.asks = memory.asks.filter(kept => kept !== ask)
  const dialog: Dialog = { id: ask?.id ?? null, tool, agent, input: key, target: dialogTarget(input), reason: ask?.reason ?? null }
  memory.open = [...memory.open.filter(d => !same(d)), dialog].slice(-ASKS_KEPT)
  return dialog
}

// The call ended, so its dialog was answered: its ask and its dialog are forgotten, and so is a dialog
// no ask matched of the same tool and loop.
export function settleCall(memory: DialogMemory, e: Events['tool.call']): void {
  const id = typeof e['tool_use_id'] === 'string' ? e['tool_use_id'] : null
  const tool = String(e['tool'] ?? '')
  const agent = e.agentId
  memory.asks = memory.asks.filter(ask => ask.id !== id)
  memory.open = memory.open.filter(d => (d.id === null ? !(d.tool === tool && d.agent === agent) : d.id !== id))
}

// A loop's turn ended: none of its dialogs is still on screen, and none of its asks will be shown.
export function settleLoop(memory: DialogMemory, agent: string | undefined): void {
  memory.asks = memory.asks.filter(ask => ask.agent !== agent)
  memory.open = memory.open.filter(d => d.agent !== agent)
}

// The line the orchestrator is sent; `reminder` for the one past the busy bound, which says only what
// is known then: the call has not ended, its dialog still open or the call running once approved.
export function dialogLine(agent: string, dialog: Dialog, tty: string | null, reminder = false): string {
  const hours = Math.floor(NOTICE_TTL_MS / 3_600_000)
  const minutes = Math.floor((NOTICE_TTL_MS % 3_600_000) / 60_000)
  const what = dialog.target === '' ? dialog.tool : `${dialog.tool} ${cutWords(dialog.target, TARGET_ROOM)}`
  const reason = dialog.reason === null ? '' : ` — ${cutWords(dialog.reason.replace(/\s+/g, ' ').trim().replace(/\.$/, ''), REASON_ROOM)}`
  const tab = tty === null ? '' : ` (${tty.replace(/^\/dev\//, '')})`
  if (reminder) {
    return `[module] ${agent}: the call that opened a permission dialog ${hours}h${String(minutes).padStart(2, '0')} ago has not ended: ${what}${reason}; its dialog may still wait in the operator's tab${tab}, or the call runs on`
  }
  return `[module] ${agent} waits on a permission dialog: ${what}${reason}; the operator answers it in its tab${tab}`
}

type Relay = Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>

/*
 * The line sent to the agent's orchestrator within the bound, nothing sent once it passed. An agent's
 * dialog is given its reminder at the busy bound as soon as its session is known to be an agent's,
 * whatever becomes of the first line. Any other role sends and arms nothing; a failure is one log line.
 */
async function tell($: Relay, memory: DialogMemory, dialog: Dialog, bound: number, reminder: boolean): Promise<void> {
  let who = 'this session'
  const told = await withDeadline(async (signal: AbortSignal) => {
    const self = await selfOf($, await $.session.id())
    if (!self.name || roleOf(self.name) !== 'agent') return
    who = self.name
    if (!reminder) {
      let due = true
      $.clock.after(NOTICE_TTL_MS, () => {
        if (!due || !memory.open.includes(dialog)) return
        due = false
        // Reminded, forgotten: a call whose end the module missed holds no later request of the same arguments.
        memory.open = memory.open.filter(d => d !== dialog)
        void tell($, memory, dialog, bound, true).catch(err => logLine($, 'supervision', `permission: ${messageOf(err)}`))
      })
    }
    if (signal.aborted) return
    const to = await orchestratorOn($, self.tty, self.name, 'permission')
    if (!to) {
      await logLine($, 'supervision', `permission: no orchestrator found for ${self.name} on ${self.tty ?? 'an unknown tty'}`)
      return
    }
    if (signal.aborted) return
    const sent = await $.session.send({ to, text: dialogLine(self.name, dialog, self.tty, reminder) })
    if (!sent?.isDelivered) await logLine($, 'supervision', `permission: not delivered to ${typeof to === 'string' ? to : `session ${to.sessionId}`}: ${sent?.reason ?? 'no answer'}`)
  }, bound)
  if (isDegradedPass(told)) await logLine($, 'supervision', `permission: the line of ${who} did not go within ${bound} ms`)
}

const net = async ($: Relay, next: Caught): Promise<void> =>
  logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)

export function register(on: On<Relay>, bound: number = PERMISSION_BOUND_MS): void {
  const memory = newDialogMemory()
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    try {
      noteAsk(memory, e, verdict)
    } catch (err) {
      // An observer: the verdict stands, and the log says why the dialog will go without its reason.
      void logLine($, 'supervision', `permission: an ask was not kept: ${messageOf(err)}`)
    }
    return verdict
  }).catch(async ($, e, next) => {
    await net($, next)
    return next(e)
  })
  // A request a settings hook answered (a `decision` on the chain's answer) shows no dialog.
  on('classic.PermissionRequest', async ($, e, next) => {
    const answer = await next(e)
    try {
      if (fieldsOf(answer)?.['decision'] !== undefined) return answer
      const dialog = openDialog(memory, typeof e.tool_name === 'string' ? e.tool_name : '', e.tool_input, typeof e.agent_id === 'string' ? e.agent_id : undefined)
      if (dialog !== null) {
        void tell($, memory, dialog, bound, false).catch(err => logLine($, 'supervision', `permission: ${messageOf(err)}`))
      }
    } catch (err) {
      // An observer: the dialog goes on, and the log says why it was not told.
      void logLine($, 'supervision', `permission: a dialog was not told: ${messageOf(err)}`)
    }
    return answer
  }).catch(async ($, e, next) => {
    await net($, next)
    return next(e)
  })
  // Every call and every turn end, under the empty matcher: the host takes one hook without a matcher per event.
  on('tool.call', {}, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      settleCall(memory, e)
    }
  }).catch(async ($, e, next) => {
    await net($, next)
    return next(e)
  })
  on('turn.complete', {}, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      settleLoop(memory, e.agentId)
    }
  }).catch(async ($, e, next) => {
    await net($, next)
    return next(e)
  })
}
