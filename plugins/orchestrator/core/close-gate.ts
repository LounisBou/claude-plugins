// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The close gate: what a close of a session (a succession's takeover, a rotation, an agent's close)
// waits for before it kills that session, so the operator is never cut off while he answers it (his
// order of 2026-11-28). Files per session under the orchestrator module's store, one writer each:
// the session's own hooks module writes `<key>.here` once it runs there (a gate can be asked of
// it) and `<key>.state` (where the gate stands: waiting, the notice shown, or go); the launcher
// writes `<key>.ask` (a close is asked), and only of a session whose module is there. A change of either
// format raises CLOSE_GATE_VERSION. It imports no node module: the hooks module imports it, and the
// launcher reads its data half as `close-gate.json`.

export const CLOSE_GATE_VERSION = 1

/** The gate's directory under the module's store. */
export const CLOSE_GATE_DIR = 'close-gate'

/** No close before this long without a prompt of his sent to the session, its box empty. */
export const CLOSE_GATE_QUIET_MS = 3 * 60_000

/** Once « succession engagée » is shown, this long for his answer: « patiente », « vas-y », or silence. */
export const CLOSE_GATE_NOTICE_MS = 60_000

/** How often the session's module looks at an ask of its own. */
export const CLOSE_GATE_TICK_MS = 5_000

/** A state older than this is no module's answer: none runs in that session, or it is gone. */
export const CLOSE_GATE_FRESH_MS = 20_000

/** An ask older than this is no close in progress: a new close asks again, from the start. */
export const CLOSE_GATE_ASK_STALE_MS = 30 * 60_000

/** The data half, for the launcher (Python). */
export const CLOSE_GATE_CONTRACT = {
  version: 1,
  dir: CLOSE_GATE_DIR,
  file_version: CLOSE_GATE_VERSION,
  ask_suffix: '.ask',
  state_suffix: '.state',
  here_suffix: '.here',
  quiet_ms: CLOSE_GATE_QUIET_MS,
  notice_ms: CLOSE_GATE_NOTICE_MS,
  tick_ms: CLOSE_GATE_TICK_MS,
  fresh_ms: CLOSE_GATE_FRESH_MS,
  ask_stale_ms: CLOSE_GATE_ASK_STALE_MS,
} as const

/** A close asked: of which session, when (ISO UTC), by which command. */
export interface GateAsk {
  readonly v: typeof CLOSE_GATE_VERSION
  readonly sid: string
  readonly at: string
  readonly by: string
}

/** Where the gate stands: `wait` (a), `notice` (b, shown at `notice_at`), `go` (c, released). */
export type GatePhase = 'wait' | 'notice' | 'go'

export interface GateState {
  readonly v: typeof CLOSE_GATE_VERSION
  readonly sid: string
  /** The `at` of the ask this state answers. */
  readonly ask_at: string
  readonly phase: GatePhase
  readonly notice_at: string | null
  /** Why the gate stands where it does, one line for the close's caller to print. */
  readonly why: string
  /** The module's last look, ISO UTC: a state older than CLOSE_GATE_FRESH_MS answers nothing. */
  readonly seen_at: string
}

/** The file stem of a session's gate: its id with each character outside A-Za-z0-9._- an underscore. */
export function gateKey(sid: string): string {
  return sid.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function gateAskPath(store: string, sid: string): string {
  return `${store.replace(/\/+$/, '')}/${CLOSE_GATE_DIR}/${gateKey(sid)}${CLOSE_GATE_CONTRACT.ask_suffix}`
}

export function gateHerePath(store: string, sid: string): string {
  return `${store.replace(/\/+$/, '')}/${CLOSE_GATE_DIR}/${gateKey(sid)}${CLOSE_GATE_CONTRACT.here_suffix}`
}

export function gateStatePath(store: string, sid: string): string {
  return `${store.replace(/\/+$/, '')}/${CLOSE_GATE_DIR}/${gateKey(sid)}${CLOSE_GATE_CONTRACT.state_suffix}`
}

type Fields = Record<string, unknown>
const fields = (value: unknown): Fields | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : undefined)
const stamp = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value))

function parsed(text: string): Fields | undefined {
  try {
    return fields(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** An ask file's text as an ask, or null: of another version, or not one. */
export function parseGateAsk(text: string): GateAsk | null {
  const o = parsed(text)
  if (!o || o['v'] !== CLOSE_GATE_VERSION) return null
  const { sid, at, by } = o
  return typeof sid === 'string' && sid !== '' && stamp(at) && typeof by === 'string' ? { v: CLOSE_GATE_VERSION, sid, at, by } : null
}

const PHASES: readonly GatePhase[] = ['wait', 'notice', 'go']

/** A state file's text as a state, or null: of another version, or not one. */
export function parseGateState(text: string): GateState | null {
  const o = parsed(text)
  if (!o || o['v'] !== CLOSE_GATE_VERSION) return null
  const { sid, ask_at: askAt, phase, notice_at: noticeAt, why, seen_at: seenAt } = o
  if (typeof sid !== 'string' || !stamp(askAt) || !PHASES.includes(phase as GatePhase) || !stamp(seenAt) || typeof why !== 'string') return null
  if (noticeAt !== null && !stamp(noticeAt)) return null
  return { v: CLOSE_GATE_VERSION, sid, ask_at: askAt, phase: phase as GatePhase, notice_at: noticeAt, why, seen_at: seenAt }
}
