// hooks/gauge.ts
import { measureDir, measureFilePath, hasFigures, parseMeasure, startOf, type MeasureReading, type MeasureStart } from './gauge-core.ts'
import { messageOf, type Host, type On } from './host.ts'
import { removeArgv } from '../core/store-io.ts'
import { configDir, logLine, writeAtomic } from './module-io.ts'

// The nouns the gauge holds.
type Gauge = Host<'plugin' | 'env' | 'fs' | 'process' | 'clock' | 'session' | 'ui'>

// Module memory only — a reload resets all three, by design (Review Focus 3): drift is
// announced between two measures of the same load, never re-announced from a stale
// previous model after a hot reload.
let current: MeasureReading | null = null
// The session the figures above were measured in: after a /clear the id changes.
let currentIn: string | null = null
let lastModel: string | null = null
// The drift line not yet said to the model: the guards' prompt gate takes it into the
// context of the next prompt (takeDrift), the channel every gate line reaches the
// model by — a toast alone fades in seconds, and nothing tells the model.
let pendingDrift: string | null = null
// Each session's start (gauge-core.ts, startOf): measured once, at its first figure, and kept
// across a compaction; read back from its measure file after a reload of the module.
const starts = new Map<string, MeasureStart>()

// The store's input: null until the first measure of a load fills it — the usage
// fields are optional in the shipped types before the first answered turn, so a null
// reading is the expected start, not an error.
export function currentReading(): MeasureReading | null {
  return current
}

// The drift line waiting for the model, handed over once: the next prompt carries it.
export function takeDrift(): string | null {
  const drift = pendingDrift
  pendingDrift = null
  return drift
}

export function driftAnnouncement(model: string, previous: string): string {
  // Verbatim from hooks/context-gate.sh:94 — the host can switch the answering
  // model under a session (a refusal, an outage) and no other surface shows it.
  return `MODEL DRIFT: this session now answers as ${model}; it answered as ${previous} until now. The host switched on its own (a refusal, an outage): say it to the operator in your next message; a succession does not repair it.`
}

export async function writeMeasure(
  $: Host<'fs' | 'env' | 'process' | 'clock'>,
  sessionId: string,
  reading: MeasureReading,
): Promise<void> {
  // One JSON line, put in place in one rename: $.fs.write alone creates the file empty and
  // fills it after, and a reader (or a crash) in between found — or left — a 0-byte measure.
  await writeAtomic($, measureFilePath(await configDir($), sessionId, await $.env.get('ORCHESTRATOR_MODULE_DIR')), JSON.stringify(reading) + '\n')
}

// A session with no figures has no measure file: removed, never rewritten empty — $.fs.write
// creates the file when it is absent, so an empty write left a 0-byte file for every session
// that ended, was compacted or had not answered yet. Removing a file that is not there is no failure.
async function removeMeasure($: Host<'env' | 'process'>, sessionId: string): Promise<void> {
  const path = measureFilePath(await configDir($), sessionId, await $.env.get('ORCHESTRATOR_MODULE_DIR'))
  const removed = await $.process.run(removeArgv(path), { timeoutMs: 5000 })
  if (removed.exitCode !== 0) throw new Error(`the measure file ${path} could not be removed${removed.stderr ? `: ${removed.stderr.trim()}` : ''}`)
}

// The 0-byte measure files an earlier version left behind (it wrote an empty file at every session
// end and compaction), removed at the next start: past a day, so no file a write is about to fill.
const EMPTY_MEASURE_AGE_MS = 24 * 3600 * 1000

async function sweepEmptyMeasures($: Host<'env' | 'fs' | 'process'>): Promise<void> {
  const dir = measureDir(await configDir($), await $.env.get('ORCHESTRATOR_MODULE_DIR'))
  const now = Date.now()
  const stale = (await $.fs.list(dir))
    .filter(entry => entry.kind === 'file' && entry.size === 0 && entry.name.endsWith('.json') && now - (entry.mtimeMs ?? now) > EMPTY_MEASURE_AGE_MS)
    .map(entry => `${dir}/${entry.name}`)
  if (stale.length > 0) await $.process.run(removeArgv(...stale), { timeoutMs: 5000 })
}

export function register(on: On<Gauge>): void {
  on('session.start', {}, async ($, e, next) => {
    try {
      await sweepEmptyMeasures($)
    } catch (err) {
      await logLine($, 'gauge', messageOf(err))
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'gauge', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
  on('session.measure', async ($, e, next) => {
    try {
      const usage = await $.session.usage()
      const model = await $.session.model()
      const { tokens, window, percent } = usage.context
      const updatedAt = new Date().toISOString()
      // Before the first answer the host has no token count yet — nor right after a
      // /clear or a compaction: nothing is written, and the next measure fills the
      // file. Figures kept from before are no longer this conversation's: the store's
      // row and the measure file stop showing them.
      const sessionId = e.sessionId ?? await $.session.id()
      if (tokens === undefined || percent === undefined
        || !hasFigures({ context_tokens: tokens, context_window: window, context_percent: percent })) {
        if (current !== null) await forget($, sessionId)
        return next(e)
      }
      const figures = { context_tokens: tokens, updated_at: updatedAt }
      const reading: MeasureReading = {
        context_tokens: tokens,
        context_window: window,
        context_percent: percent,
        model: String(model ?? 'unavailable'),
        updated_at: updatedAt,
        start: starts.get(sessionId) ?? startOf(await keptStart($, sessionId), figures, await startBrief($)),
      }
      starts.set(sessionId, reading.start!)
      await writeMeasure($, sessionId, reading)
      if (lastModel !== null && lastModel !== reading.model) {
        pendingDrift = driftAnnouncement(reading.model, lastModel)
        await $.ui.toast(pendingDrift)
      }
      lastModel = reading.model
      current = reading
      currentIn = sessionId
      $.ui.invalidate('ui.render')
    } catch (err) {
      // A measure that fails never blocks: the next turn measures again.
      await logLine($, 'gauge', messageOf(err))
    }
    return next(e)
  }).catch(async ($, e, next) => {
    // The registered net the plan's every-handler rule asks validate to see:
    // the measure is let through, the state dir says why, and next is
    // replay-safe in a catch, called or not.
    await logLine($, 'gauge', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
  // A compaction of the main conversation starts: the figures measured before it go
  // with what it summarises, and the next answer measures again. The measure file is
  // removed now — the gate reads it — so the next prompt is not told a fill the
  // conversation no longer has. A subagent's own compaction is not the session's.
  on('session.compact', async ($, e, next) => {
    try {
      if (!e.agentId) await forget($, await $.session.id(), true)
    } catch (err) {
      await logLine($, 'gauge', messageOf(err))
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'gauge', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    // A /clear ends this conversation and starts another in the same process: the
    // figures in memory were the ended one's.
    current = null
    currentIn = null
    starts.delete(e.sessionId ?? '')
    try {
      await removeMeasure($, e.sessionId ?? await $.session.id())
    } catch (err) {
      // Never blocks the end; the failure is said — one line, the
      // every-handler-logs rule.
      await logLine($, 'gauge', messageOf(err))
    }
    return next(e)
  }).catch(async ($, e, next) => {
    // The registered net the plan's every-handler rule asks validate to see:
    // the end is let through, the state dir says why, and next is replay-safe
    // in a catch, called or not.
    await logLine($, 'gauge', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// The start a session's measure file already holds, when the module was reloaded since.
async function keptStart($: Host<'fs' | 'env'>, sessionId: string): Promise<MeasureStart | undefined> {
  try {
    return parseMeasure(await $.fs.read(measureFilePath(await configDir($), sessionId, await $.env.get('ORCHESTRATOR_MODULE_DIR'))))?.start
  } catch {
    return undefined
  }
}

// The brief the launcher started this session on, with its size; null when it names none.
async function startBrief($: Host<'fs' | 'env'>): Promise<{ path: string; bytes: number | null } | null> {
  const path = await $.env.get('ORCHESTRATOR_BRIEF')
  if (!path) return null
  try {
    return { path, bytes: Number((await $.fs.stat(path)).size) }
  } catch {
    return { path, bytes: null }
  }
}

// The figures of a conversation that no longer has them: memory, and the measure
// file when they were this session's — another session's (a /clear's predecessor)
// was removed by its own end.
async function forget($: Host<'env' | 'process' | 'ui'>, sessionId: string, mine = currentIn === sessionId): Promise<void> {
  current = null
  currentIn = null
  $.ui.invalidate('ui.render')
  if (mine) await removeMeasure($, sessionId)
}
