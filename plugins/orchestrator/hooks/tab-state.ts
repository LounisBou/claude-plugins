// hooks/tab-state.ts
// The state a session's window shows in its home session's tab bar. The session writes it
// on its own window, on the events that already write its store row and its wait file, and
// the status line only formats it (skills/iterm-agents/tmux/home.conf): nothing polls.
// Pure on purpose, like module-log.ts: the handler holds the $ and runs the argv built here.
import type { WaitKind } from './relay.ts'

// One word each: a turn started, a turn ended with nothing pending, a wait on the operator
// written, a delivery written, the context past its gate.
export type TabState = 'busy' | 'idle' | 'asks' | 'done' | 'gate'

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

// What a turn's end leaves on the window: the wait its session wrote (the operator is asked
// something, or a delivery is in), else the gate, else nothing pending.
export function stateAfterTurn(waiting: WaitKind | null | undefined, pastGate: boolean): TabState {
  if (waiting === 'done' || waiting === 'delivered') return 'done'
  if (waiting) return 'asks'
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
