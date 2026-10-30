// hooks/gauge.ts
import { measureFilePath, tripGate, hasFigures, type MeasureReading } from './gauge-core.ts'
import { logArgv, LOG_TIMEOUT_MS } from './module-log.ts'

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

// The open question this session's own tab keeps in sight above the prompt, set by the round's
// reader (supervision.ts): when it began, what it blocks, its text whole. Null when none is open.
export type TabQuestion = { since: string; blocks: string; text: string }
let tabQuestion: TabQuestion | null = null

// Replaces the question in sight; true when it differs from the one held, so the caller redraws.
export function setTabQuestion(next: TabQuestion | null): boolean {
  const same = JSON.stringify(next) === JSON.stringify(tabQuestion)
  tabQuestion = next
  return !same
}

const PARIS_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

// The question's lines as the band draws them: the head, then the text whole.
export function tabQuestionLines(question: TabQuestion): { head: string; body: string } {
  const at = new Date(question.since)
  const time = Number.isNaN(at.getTime()) ? question.since : PARIS_CLOCK.format(at)
  return { head: `Question for you (since ${time})${question.blocks ? `: ${question.blocks}` : ''}`, body: question.text }
}

// The band's input: null until the first measure of a load fills it — the usage
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

// Exported for the guards: whatever reads the measure file from a handler resolves
// the config dir through this same seam (the sandbox exposes no process global).
export async function configDir($: any): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
}

export async function writeMeasure(
  $: { fs: { write(p: string, c: string): Promise<unknown> }; env: { get(name: string): Promise<string | undefined> } },
  sessionId: string,
  reading: MeasureReading,
): Promise<void> {
  // One JSON line; the trailing newline ends it, and a partial line reads as
  // unmeasured everywhere ($.fs.write is not atomic).
  await $.fs.write(measureFilePath(await configDir($), sessionId, await $.env.get('ORCHESTRATOR_MODULE_DIR')), JSON.stringify(reading) + '\n')
}

// What the band above the prompt says: a plain description, so the rules stay testable
// apart from the surface. The concrete elements come from $.ui.resolve(e) at render
// time; below the gate no rotation line exists, and the quiet band stays one row.
export type BandDescription = {
  label: string
  // The label's pieces: the percentage is the one drawn bold.
  lead: string
  percent: string
  figures: string
  past: boolean
  note: string | null
}

export function bandTree(reading: MeasureReading | null,
  env: { gate?: number; gateTokens?: number } = {}): BandDescription | null {
  if (!reading) return null
  const past = tripGate(reading.context_percent, reading.context_tokens, reading.context_window, env).tripped
  const lead = 'context '
  const percent = `${reading.context_percent}%`
  const figures = ` · ${reading.context_tokens.toLocaleString('en-US')}/${reading.context_window.toLocaleString('en-US')}`
  return { label: `${lead}${percent}${figures}`, lead, percent, figures, past, note: past ? 'rotation gate — succeed at the next quiet boundary' : null }
}

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  on('session.measure', async ($: any, e: any, next: (e: any) => any) => {
    try {
      const usage = await $.session.usage()
      const model = await $.session.model()
      const reading: MeasureReading = {
        context_tokens: usage.context.tokens,
        context_window: usage.context.window,
        context_percent: usage.context.percent,
        model: String(model ?? 'unavailable'),
        updated_at: new Date().toISOString(),
      }
      // Before the first answer the host has no token count yet — nor right after a
      // /clear or a compaction: nothing is written, and the next measure fills the
      // file. Figures kept from before are no longer this conversation's: the band,
      // the store's row and the measure file stop showing them.
      const sessionId = e.sessionId ?? await $.session.id()
      if (!hasFigures(reading)) {
        if (current !== null) await forget($, sessionId)
        return next(e)
      }
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
      await logLine($, (err as Error).message)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    // The registered net the plan's every-handler rule asks validate to see:
    // the measure is let through, the state dir says why, and next is
    // replay-safe in a catch, called or not.
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
  // A compaction of the main conversation starts: the figures measured before it go
  // with what it summarises, and the next answer measures again. The measure file is
  // emptied now — the gate reads it — so the next prompt is not told a fill the
  // conversation no longer has. A subagent's own compaction is not the session's.
  on('session.compact', async ($: any, e: any, next: (e: any) => any) => {
    try {
      if (!e.agentId) await forget($, await $.session.id(), true)
    } catch (err) {
      await logLine($, (err as Error).message)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
  on('session.end', async ($: any, e: any, next: (e: any) => any) => {
    // A /clear ends this conversation and starts another in the same process: the
    // figures in memory were the ended one's.
    current = null
    currentIn = null
    try {
      // $.fs offers no remove: an empty file reads as unmeasured everywhere, and
      // install.sh purges the stale ones.
      await $.fs.write(measureFilePath(await configDir($), e.sessionId ?? await $.session.id(), await $.env.get('ORCHESTRATOR_MODULE_DIR')), '')
    } catch (err) {
      // Never blocks the end; the failure is said — one line, the
      // every-handler-logs rule.
      await logLine($, (err as Error).message)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    // The registered net the plan's every-handler rule asks validate to see:
    // the end is let through, the state dir says why, and next is replay-safe
    // in a catch, called or not.
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: (e: any) => any) => {
    try {
      // Where nothing draws (a chat panel, a headless run) the band is skipped
      // silently: the gauge stays readable through the measure file and the gate.
      const surfaces = await $.session.surfaces()
      if (!surfaces || surfaces.length === 0) return next(e)
      // The component's own contract: a survey holding the band wins, the hook yields.
      if (e.props.hasSurvey) return next(e)
      // The thresholds the session's environment set, the gate line's own: the band
      // and the gate never disagree on whether this session is past it.
      const tree = bandTree(currentReading(), await gateEnv($))
      const asked = tabQuestion
      if (!tree && !asked) return next(e)
      // A read, not a dispatch: the table is the surface's own, and the tree is
      // returned as the band's drawing — the component's props are read-only, so
      // nothing is written back into e.
      const el = $.ui.resolve(e)
      const question = asked ? tabQuestionLines(asked) : null
      return el.Box({
        flexDirection: 'column',
        children: [
          // Below the gate the line is the default text colour with the percentage bold;
          // past it the whole line is warning and bold.
          ...(tree ? [tree.past
            ? el.Text({ color: 'warning', bold: true, children: tree.label })
            : el.Text({ children: [el.Text({ children: tree.lead }), el.Text({ bold: true, children: tree.percent }), el.Text({ children: tree.figures })] })] : []),
          ...(tree?.note ? [el.Text({ color: 'warning', children: tree.note })] : []),
          // The question kept in sight: its head bold, its text whole under it, wrapped by the
          // Text itself at the tab's width.
          ...(question ? [el.Text({ bold: true, color: 'suggestion', children: question.head }), el.Text({ wrap: 'wrap', children: question.body })] : []),
        ],
      })
    } catch (err) {
      // A band that fails to draw never blocks the render: the engine draws its own.
      await logLine($, (err as Error).message)
      return next(e)
    }
  }).catch(async ($: any, e: any, next: any) => {
    // The registered net the plan's every-handler rule asks validate to see:
    // the render is let through (the engine draws its own band), the state dir
    // says why, and next is replay-safe in a catch, called or not.
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// The figures of a conversation that no longer has them: memory, and the measure
// file when they were this session's — another session's (a /clear's predecessor)
// was emptied by its own end.
async function forget($: any, sessionId: string, mine = currentIn === sessionId): Promise<void> {
  current = null
  currentIn = null
  $.ui.invalidate('ui.render')
  if (mine) await $.fs.write(measureFilePath(await configDir($), sessionId, await $.env.get('ORCHESTRATOR_MODULE_DIR')), '')
}

// The gate's thresholds from the environment, guards.ts's own reading spelled again
// here (the $ fence): a value that is no positive number stays undefined, and
// tripGate applies the default itself.
async function gateEnv($: any): Promise<{ gate?: number; gateTokens?: number }> {
  const threshold = (raw: string | undefined) => {
    const n = raw === undefined ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  return {
    gate: threshold(await $.env.get('ORCHESTRATOR_CONTEXT_GATE')),
    gateTokens: threshold(await $.env.get('ORCHESTRATOR_CONTEXT_GATE_TOKENS')),
  }
}

// One line appended to the module's log (module-log.ts): the stamp names the
// half that failed. Never throws, never blocks the handler it serves.
async function logLine($: any, message: string): Promise<void> {
  try {
    const config = await configDir($)
    await $.process.run(logArgv($.plugin.root, config, 'gauge', message, undefined, await $.env.get('ORCHESTRATOR_MODULE_DIR')), { timeoutMs: LOG_TIMEOUT_MS })
  } catch { /* the log itself never blocks the handler that failed */ }
}
