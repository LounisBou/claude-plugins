// hooks/tab-state.ts
// The state a session's window shows in its home session's tab bar. The session writes it
// on its own window, on the events that already write its store row and its wait file, and
// the status line only formats it (skills/iterm-agents/tmux/home.conf): nothing polls.
// Pure on purpose, like module-log.ts: the handler holds the $ and runs the argv built here.
import type { WaitKind } from './relay.ts'

// One word each: a turn started, a turn ended with nothing pending, a wait on the operator
// written, a wait on the orchestrator written (held), a delivery whose pull request is not known
// Ready (under review), a delivery whose pull request carries Ready (done: it waits for the
// merge), the delivered pull request merged or closed (the agent's work is over and the
// module closes it), the context past its gate. `asks` is the operator's alone, and
// shown only while the session has an open round entry: a window that waits on its orchestrator is
// `held`, and an operator wait no entry is open for is at rest.
export type TabState = 'busy' | 'idle' | 'asks' | 'held' | 'review' | 'done' | 'over' | 'gate'

// The session option the home command's conf sets on every session it makes: an agent is a
// window of a session that carries it.
export const HOME_MARK = '@orchestrator-home'

// The window option the status line reads.
export const STATE_OPTION = '@state'

// A tmux call never holds its handler past this: it is one local socket round trip.
export const TMUX_TIMEOUT_MS = 5000

export type TabTarget = { socket: string; pane: string }

// Where this session's window is: the server socket is the first field of $TMUX
// (`<socket>,<server pid>,<session index>`), the window's pane is $TMUX_PANE. Null outside
// tmux, where nothing is written and nothing spawned.
export function targetOf(tmux: string | undefined, pane: string | undefined): TabTarget | null {
  const socket = (tmux ?? '').split(',')[0]
  return socket && pane ? { socket, pane } : null
}

// The mark and the window's address (`<session>:@N.%N`, what the deck hands a reader to focus
// it) read through the pane, which resolves its session and inherits a global value.
export function homeArgv(bin: string, target: TabTarget): string[] {
  return [bin, '-S', target.socket, 'display-message', '-p', '-t', target.pane, `#{${HOME_MARK}}|#{session_name}:#{window_id}.#{pane_id}`]
}

// The answer of homeArgv: the window's address when the session carries the mark, else null.
export function windowOf(stdout: string): string | null {
  const [mark, ...address] = stdout.trim().split('|')
  return mark === '1' && address.length > 0 ? address.join('|') : null
}

export function stateArgv(bin: string, target: TabTarget, state: TabState): string[] {
  return [bin, '-S', target.socket, 'set-option', '-w', '-t', target.pane, STATE_OPTION, state]
}

// The panes of the server, one `<tty> <pane id> <state>` line each: a chain entry names an agent
// by the tty of its pane, a pane id is a window's address for set-option, and the state is the
// one its window shows now (empty when it shows none).
export function panesArgv(bin: string, socket: string): string[] {
  return [bin, '-S', socket, 'list-panes', '-a', '-F', `#{pane_tty} #{pane_id} #{${STATE_OPTION}}`]
}

export type PaneShown = { tty: string; pane: string; shown: string }

// The answer of panesArgv, line by line; a line that is not of that shape is no pane.
export function panesOf(stdout: string): PaneShown[] {
  const panes: PaneShown[] = []
  for (const line of stdout.split('\n')) {
    const [tty, pane, shown] = line.trim().split(' ')
    if (tty && pane) panes.push({ tty, pane, shown: shown ?? '' })
  }
  return panes
}

// The states a window may leave for `over`: at rest, waiting on its orchestrator, delivered, past
// its gate, or none. Never the operator's question (`asks`), which stays until answered, nor a turn
// that began since the read (`busy`), nor `over` itself.
const SETTLED = new Set(['', 'idle', 'held', 'review', 'done', 'gate'])

// What every pull request entrusted to one agent says together, from what was read of each (null:
// a read that failed). Any open one makes it open, and Ready only when each open one carries the
// label: one that does not makes it not Ready, one whose label was not read leaves it unknown. With
// none open it is merged when one merged, else closed, and unknown while any read is missing. A draft
// counts like any open one: leaving draft is the operator's own gesture.
export function pullRequestsRead(reads: readonly ({ state: string; ready?: boolean | undefined } | null)[]): { state: string; ready?: boolean | undefined } | null {
  const open = reads.filter(read => read?.state === 'OPEN')
  if (open.length > 0) {
    if (open.some(read => read?.ready === false)) return { state: 'OPEN', ready: false }
    return !reads.includes(null) && open.every(read => read?.ready === true) ? { state: 'OPEN', ready: true } : { state: 'OPEN' }
  }
  if (reads.length === 0 || reads.some(read => read === null)) return null
  return { state: reads.some(read => read?.state === 'MERGED') ? 'MERGED' : 'CLOSED' }
}

// What the pull request of an idle agent says its window should show, or null to leave it. A
// merged or closed one: the work is over (over), from a window in a settled state. An open one changes only a window that shows a
// delivery: the Ready label turns « under review » into « done », and a pull request that lost it
// (a new head voids it) turns « done » back. An agent at rest on no delivery keeps its own state.
export function stateAfterPr(shown: string, pr: { state: string; ready?: boolean | undefined }): TabState | null {
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') return SETTLED.has(shown) ? 'over' : null
  if (pr.state !== 'OPEN' || pr.ready === undefined) return null
  if (pr.ready && shown === 'review') return 'done'
  if (!pr.ready && shown === 'done') return 'review'
  return null
}

// What a turn's end leaves on the window: the wait its session wrote (a delivery is in, under
// review until the orchestrator's read of its pull request finds it Ready; the operator is asked
// something, shown only when `asked`, that is while the session has an open round entry; or the
// session waits on its orchestrator), else the gate, else nothing pending. An operator wait no entry
// is open for is at rest. An orchestrator's own `done` wait names no pull request: it is at rest like
// any session with nothing pending, and `done` (✓) is only ever written by the read of a pull request
// that carries Ready.
export function stateAfterTurn(waiting: WaitKind | null | undefined, pastGate: boolean, asked = false): TabState {
  if (asked) return 'asks'
  if (waiting === 'delivered') return 'review'
  if (waiting && waiting !== 'done' && waiting !== 'operator') return 'held'
  return pastGate ? 'gate' : 'idle'
}

// What a measure changes: only a window at rest takes the gate on, and leaves it when the
// context is back under. A working window or one that waits keeps its state; the turn's end
// reads the gate from memory.
export function stateAfterMeasure(shown: TabState | null, pastGate: boolean): TabState | null {
  if (shown !== null && shown !== 'idle' && shown !== 'gate') return null
  if (pastGate) return shown === 'gate' ? null : 'gate'
  return shown === 'gate' ? 'idle' : null
}
