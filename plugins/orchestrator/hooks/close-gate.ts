// hooks/close-gate.ts
// The close gate's own side, in the session a close is asked of (core's close-gate.ts says the
// files). His order of 2026-11-28: « Laisser peut-être 3 minutes sans texte envoyé, et sans texte
// dans la zone de saisie, ensuite on prévient succession engagée, on laisse 1 min (temps pour
// l'opérateur de décider s'il parle ou attend), il peut demander de patienter ou d'y aller. Et si
// pas de réponse alors on y va. » While the launcher's ask stands, the module looks every few
// seconds: (a) three minutes since his last prompt and an empty box, read through the host
// (`$.prompt.read`: what he typed, and a dictation's words still being heard, which the screen
// draws faint like a placeholder); then (b) « succession engagée » shown in the session; then
// (c) a minute: « vas-y » goes at once, « patiente » or any other prompt of his goes back to (a),
// his box no longer empty goes back to (a), silence goes. A released gate is taken back the same
// way until the close comes. An observation for the launcher, which decides: a failure is a log line.
import {
  CLOSE_GATE_DIR, CLOSE_GATE_NOTICE_MS, CLOSE_GATE_QUIET_MS, CLOSE_GATE_TICK_MS, CLOSE_GATE_VERSION,
  gateAskPath, gateHerePath, gateStatePath, parseGateAsk, parseGateState, type GateState,
} from '../core/close-gate.ts'
import { typedByOperator } from './models-guard.ts'
import { logLine, moduleDir, writeAtomic } from './module-io.ts'
import { fieldsOf, messageOf, type Events, type Host, type On, type Timer } from './host.ts'

type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'session' | 'clock' | 'prompt' | 'ui'>

/** The notice of (b), shown in the session. */
export const NOTICE_TEXT = 'succession engagée : cette session sera fermée dans 1 min. Répondez « patiente » pour la garder, « vas-y » pour fermer tout de suite ; sans réponse, elle est fermée.'

/** His answers to the notice, as he says them: a word first, its accents and case aside. */
const GO_WORD = /^\s*vas?[\s-]*y\b/i
const HOLD_WORD = /^\s*patiente?\b/i

/** His last prompt in this session: when, and its text. */
export type Spoken = { readonly at: number; readonly text: string }

/** What a look reads: now, the ask's `at`, his last prompt, the box (null: not read). */
export type GateFacts = { readonly now: number; readonly askAt: string; readonly spoken: Spoken; readonly box: string | null }

const iso = (ms: number): string => new Date(ms).toISOString()
const seconds = (ms: number): number => Math.max(0, Math.round(ms / 1000))

/** The box read as holding nothing of his: a draft of spaces alone. A box not read is never taken for empty. */
const boxEmpty = (box: string | null): boolean => box !== null && box.trim() === ''

/**
 * The next state of the gate from the last one and what this look reads, and whether the notice
 * is to be shown now. A state of another ask is no state: the gate starts at (a).
 */
export function stepGate(prev: GateState | null, facts: GateFacts, sid: string): { state: GateState; notice: boolean } {
  const { now, askAt, spoken, box } = facts
  const last = prev !== null && prev.ask_at === askAt ? prev : null
  const make = (phase: GateState['phase'], why: string, noticeAt: number | null = null): GateState => ({
    v: CLOSE_GATE_VERSION, sid, ask_at: askAt, phase, notice_at: noticeAt === null ? null : iso(noticeAt), why, seen_at: iso(now),
  })
  const quiet = now - spoken.at
  const waiting = (): { state: GateState; notice: boolean } => {
    if (!boxEmpty(box)) return { state: make('wait', box === null ? 'its box cannot be read' : 'its box holds text of his (typed or dictated)'), notice: false }
    if (quiet < CLOSE_GATE_QUIET_MS) return { state: make('wait', `his last prompt is ${seconds(quiet)}s old, under ${seconds(CLOSE_GATE_QUIET_MS)}s`), notice: false }
    return { state: make('notice', `« succession engagée » shown, ${seconds(CLOSE_GATE_NOTICE_MS)}s for his answer`, now), notice: true }
  }
  if (last === null || last.phase === 'wait') return waiting()
  const since = Date.parse(last.notice_at ?? last.seen_at)
  if (last.phase === 'notice') {
    if (spoken.at > since) {
      if (GO_WORD.test(spoken.text)) return { state: make('go', 'he said « vas-y »', since), notice: false }
      return waiting()
    }
    if (!boxEmpty(box)) return waiting()
    if (now - since >= CLOSE_GATE_NOTICE_MS) return { state: make('go', `no answer ${seconds(now - since)}s after « succession engagée »`, since), notice: false }
    return { state: make('notice', `« succession engagée » shown ${seconds(now - since)}s ago, waiting for his answer`, since), notice: false }
  }
  // Released: taken back by a prompt of his after the notice, unless it is his « vas-y », or by his box.
  const spokeAfter = spoken.at > since && !GO_WORD.test(spoken.text)
  if (spokeAfter || !boxEmpty(box)) return waiting()
  return { state: { ...last, seen_at: iso(now) }, notice: false }
}

/** The context the session's model reads beside his answer to the notice: one line, the module having taken it. */
export function answerContext(text: string, phase: GateState['phase'] | null): string | null {
  if (phase !== 'notice') return null
  if (GO_WORD.test(text)) return 'The close gate took the operator\'s « vas-y »: the succession closes this session now. Answer him in one short line.'
  if (HOLD_WORD.test(text)) return 'The close gate took the operator\'s « patiente »: the succession of this session waits, three minutes from his last prompt again. Answer him in one short line.'
  return null
}

/** The box's draft as `$.prompt.read` answers it, or null when the answer is none. */
export function draftOf(read: unknown): string | null {
  const text = fieldsOf(read)?.['text']
  return typeof text === 'string' ? text : null
}

async function readText($: Held, path: string): Promise<string | null> {
  try {
    return String(await $.fs.read(path))
  } catch {
    return null
  }
}

/** One look of the module at its own session's gate: nothing without an ask; the state written, the notice shown once. */
export async function look($: Held, sid: string, spoken: Spoken): Promise<GateState | null> {
  const store = `${await moduleDir($)}/store`
  const askText = await readText($, gateAskPath(store, sid))
  const ask = askText === null ? null : parseGateAsk(askText)
  if (ask === null || ask.sid !== sid) return null
  const prevText = await readText($, gateStatePath(store, sid))
  const prev = prevText === null ? null : parseGateState(prevText)
  let box: string | null
  try {
    box = draftOf(await $.prompt.read())
  } catch {
    box = null
  }
  const { state, notice } = stepGate(prev, { now: await $.clock.now(), askAt: ask.at, spoken, box }, sid)
  await writeAtomic($, gateStatePath(store, sid), `${JSON.stringify(state)}\n`)
  if (notice) {
    $.ui.log(NOTICE_TEXT)
    $.ui.toast(NOTICE_TEXT)
    await logLine($, 'close-gate', `notice shown for the close asked by ${ask.by}`)
  }
  return state
}

/** What the module keeps across its hooks: his last prompt, the gate's phase at the last look, the session's timer. */
type Memory = { spoken: Spoken | null; phase: GateState['phase'] | null; armed: { sid: string; timer: Timer } | null; running: boolean; here: string | null }

/** Now on the host's clock, or the wall's where a host gives none. */
async function nowOf($: Held): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

/** One look on the session's timer, never two at once; a failure is a log line. */
async function tick($: Held, memory: Memory, sid: string): Promise<void> {
  if (memory.running) return
  memory.running = true
  try {
    memory.spoken ??= { at: await nowOf($), text: '' }
    await declareHere($, memory, sid)
    memory.phase = (await look($, sid, memory.spoken))?.phase ?? null
  } catch (err) {
    await logLine($, 'close-gate', messageOf(err))
  } finally {
    memory.running = false
  }
}

/**
 * The session's timer, armed once per session id: a /clear's new session arms its own. Until a
 * prompt of his comes, his last one is taken as the module's start, so a module just loaded
 * never takes an older one for none.
 */
async function arm($: Held, memory: Memory): Promise<void> {
  const sid = await $.session.id()
  memory.spoken ??= { at: await nowOf($), text: '' }
  if (memory.armed?.sid === sid) return
  memory.armed?.timer.cancel()
  memory.armed = { sid, timer: $.clock.every(CLOSE_GATE_TICK_MS, () => void tick($, memory, sid)) }
  memory.here = null
}

/** Said to the launcher once per session, at its first look: a close of this session asks its gate here, and waits for its answer. */
async function declareHere($: Held, memory: Memory, sid: string): Promise<void> {
  if (memory.here === sid) return
  const store = `${await moduleDir($)}/store`
  await $.process.run(['mkdir', '-p', `${store}/${CLOSE_GATE_DIR}`], { timeoutMs: 5000 })
  await writeAtomic($, gateHerePath(store, sid), `${JSON.stringify({ v: CLOSE_GATE_VERSION, sid, at: new Date(await nowOf($)).toISOString() })}\n`)
  memory.here = sid
}

/** His prompt counted, and his answer to the notice told to the model beside it. */
async function heard($: Held, memory: Memory, e: Events['prompt.submit']): Promise<Events['prompt.submit']> {
  await arm($, memory)
  if (!typedByOperator(String(e.origin?.kind ?? ''))) return e
  const text = String(e.text ?? '')
  memory.spoken = { at: await nowOf($), text }
  const said = answerContext(text, memory.phase)
  return said === null ? e : { ...e, context: [...(e.context ?? []), said] }
}

export function register(on: On<Held>): void {
  const memory: Memory = { spoken: null, phase: null, armed: null, running: false, here: null }
  on('session.start', {}, async ($, e, next) => {
    try {
      await arm($, memory)
    } catch (err) {
      await logLine($, 'close-gate', messageOf(err))
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'close-gate', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
  on('prompt.submit', {}, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    try {
      return next(await heard($, memory, e))
    } catch (err) {
      await logLine($, 'close-gate', messageOf(err))
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'close-gate', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
  on('turn.complete', {}, async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await arm($, memory)
      } catch (err) {
        await logLine($, 'close-gate', messageOf(err))
      }
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'close-gate', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}
