// hooks/permission-wait.ts
// An agent parked on a permission dialog, told to its orchestrator as the dialog appears. The host
// raises the classic PermissionRequest as it is about to show the dialog; the ask `tool.check`
// announced for the call gives the call's id and the host's reason; the call's end (`tool.call`) is
// the dialog's answer at the latest. One line per dialog, and one reminder when it is still open past
// the busy bound (stop-gate.ts NOTICE_TTL_MS). The line is a side effect: the hook hands back what the
// chain beneath answered at once, and the relay runs after it, bounded and never awaited, so no read
// or send of it holds the dialog. Only an agent's dialog is told: any other role's is the operator's
// own tab.
import { NOTICE_TTL_MS, isDegradedPass, withDeadline } from './stop-gate.ts'
import { cutLine, orchestratorOn, selfOf } from './supervision.ts'
import { roleOf } from './session-name.ts'
import { logLine } from './module-io.ts'
import { fieldsOf, messageOf, type Events, type Host, type On } from './host.ts'

// The bound on the relay of one line: the session's row, its orchestrator found, the send.
export const PERMISSION_BOUND_MS = 5000
// The room the target and the host's reason get on the line, each cut past it.
export const TARGET_ROOM = 120
export const REASON_ROOM = 200
// The asks the module remembers at once, the oldest dropped: an ask whose call never ends leaves one.
export const ASKS_KEPT = 50

// An ask `tool.check` announced for a call: its id, tool, loop (a subagent's id, '' for the main
// one), target and the host's reason.
export type Ask = { readonly id: string; readonly tool: string; readonly loop: string; readonly target: string; readonly reason: string | null }
// A dialog shown: the ask it matched (`id` null when none did), or its tool, loop and target alone.
export type Dialog = { readonly id: string | null; readonly tool: string; readonly loop: string; readonly target: string; readonly reason: string | null }
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

// The ask a `tool.check` verdict is, kept: an `ask` on a real call (it has an id); anything else, nothing.
export function noteAsk(memory: DialogMemory, e: Events['tool.check'], verdict: unknown): void {
  const answer = fieldsOf(verdict)
  if (answer?.['decision'] !== 'ask' || typeof e.tool_use_id !== 'string') return
  memory.asks = [...memory.asks.filter(ask => ask.id !== e.tool_use_id), {
    id: e.tool_use_id, tool: e.tool, loop: e.agentId ?? '', target: dialogTarget(e.input), reason: textOf(answer['reason']),
  }].slice(-ASKS_KEPT)
}

/*
 * The dialog a request opens, or null when it is one already open (the same tool, loop and target):
 * a second request in the same dialog. It takes the ask of its tool and loop when that is the only
 * one, else the one of its target when one alone is, else none: no guess.
 */
export function openDialog(memory: DialogMemory, tool: string, input: unknown, loop: string): Dialog | null {
  const target = dialogTarget(input)
  if (memory.open.some(d => d.tool === tool && d.loop === loop && d.target === target)) return null
  const same = memory.asks.filter(ask => ask.tool === tool && ask.loop === loop)
  const ofTarget = same.filter(ask => ask.target === target)
  const ask = same.length === 1 ? same[0] : ofTarget.length === 1 ? ofTarget[0] : undefined
  memory.asks = memory.asks.filter(kept => kept !== ask)
  const dialog: Dialog = { id: ask?.id ?? null, tool, loop, target, reason: ask?.reason ?? null }
  memory.open = [...memory.open, dialog].slice(-ASKS_KEPT)
  return dialog
}

// The call ended, so its dialog was answered: its ask and its dialog are forgotten, and so is a dialog
// no ask matched of the same tool and loop.
export function settleCall(memory: DialogMemory, e: Events['tool.call']): void {
  const id = typeof e['tool_use_id'] === 'string' ? e['tool_use_id'] : null
  const tool = String(e['tool'] ?? '')
  const loop = e.agentId ?? ''
  memory.asks = memory.asks.filter(ask => ask.id !== id)
  memory.open = memory.open.filter(d => (d.id === null ? !(d.tool === tool && d.loop === loop) : d.id !== id))
}

// The line the orchestrator is sent; `reminder` for the one past the busy bound.
export function dialogLine(agent: string, dialog: Dialog, tty: string | null, reminder = false): string {
  const hours = Math.floor(NOTICE_TTL_MS / 3_600_000)
  const minutes = Math.floor((NOTICE_TTL_MS % 3_600_000) / 60_000)
  const waits = reminder ? `still waits on a permission dialog after ${hours}h${String(minutes).padStart(2, '0')}` : 'waits on a permission dialog'
  const what = dialog.target === '' ? dialog.tool : `${dialog.tool} ${cutLine(dialog.target, TARGET_ROOM)}`
  const reason = dialog.reason === null ? '' : ` — ${cutLine(dialog.reason.replace(/\s+/g, ' ').trim().replace(/\.$/, ''), REASON_ROOM)}`
  const tab = tty === null ? '' : ` (${tty.replace(/^\/dev\//, '')})`
  return `[module] ${agent} ${waits}: ${what}${reason}; the operator answers it in its tab${tab}`
}

type Relay = Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>

// The line sent to the agent's orchestrator, within the bound, nothing sent or armed once it passed;
// a dialog matched to its call is given its reminder at the busy bound. Any other role sends
// nothing; a failure is one log line.
async function tell($: Relay, memory: DialogMemory, dialog: Dialog, bound: number, reminder: boolean): Promise<void> {
  let who = 'this session'
  const told = await withDeadline(async (signal: AbortSignal) => {
    const self = await selfOf($, await $.session.id())
    if (!self.name || roleOf(self.name) !== 'agent') return
    who = self.name
    const to = await orchestratorOn($, self.tty, self.name, 'permission')
    if (!to) {
      await logLine($, 'supervision', `permission: no orchestrator found for ${self.name} on ${self.tty ?? 'an unknown tty'}`)
      return
    }
    if (signal.aborted) return
    const sent = await $.session.send({ to, text: dialogLine(self.name, dialog, self.tty, reminder) })
    if (!sent?.isDelivered) await logLine($, 'supervision', `permission: not delivered to ${typeof to === 'string' ? to : `session ${to.sessionId}`}: ${sent?.reason ?? 'no answer'}`)
    if (reminder || dialog.id === null || signal.aborted) return
    let due = true
    $.clock.after(NOTICE_TTL_MS, () => {
      if (!due || !memory.open.includes(dialog)) return
      due = false
      void tell($, memory, dialog, bound, true).catch(err => logLine($, 'supervision', `permission: ${messageOf(err)}`))
    })
  }, bound)
  if (isDegradedPass(told)) await logLine($, 'supervision', `permission: the line of ${who} did not go within ${bound} ms`)
}

export function register(on: On<Relay>, bound: number = PERMISSION_BOUND_MS): void {
  const memory = newDialogMemory()
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    try {
      noteAsk(memory, e, verdict)
    } catch { /* an observer: the verdict stands */ }
    return verdict
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
  // A request a settings hook answered (a `decision` on the chain's answer) shows no dialog.
  on('classic.PermissionRequest', async ($, e, next) => {
    const answer = await next(e)
    try {
      if (fieldsOf(answer)?.['decision'] !== undefined) return answer
      const dialog = openDialog(memory, typeof e.tool_name === 'string' ? e.tool_name : '', e.tool_input, typeof e.agent_id === 'string' ? e.agent_id : '')
      if (dialog !== null) {
        void tell($, memory, dialog, bound, false).catch(err => logLine($, 'supervision', `permission: ${messageOf(err)}`))
      }
    } catch { /* an observer: the dialog goes on */ }
    return answer
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
  on('tool.call', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      settleCall(memory, e)
    }
  }).catch(async ($, e, next) => {
    await logLine($, 'supervision', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}
