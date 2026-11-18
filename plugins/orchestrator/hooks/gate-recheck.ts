// hooks/gate-recheck.ts
// A pull request an open question of an orchestrator's round names (an `<owner/name>#<n>` in its
// subject, context or question), re-checked against the Ready gate while
// the question stays open: once per new install of the plugins and once per hour, through the
// github plugin's own `pr-readiness ready`, which puts Ready only when its gate reads the pull request
// ready at its head. When it does, the session is told in one line, with the hint to settle the
// question withdrawn. An observation: a check that fails is a log line, never a refusal.
import { deployedAt, parseDeployState } from '../core/deploy-state.ts'
import { readAsked, type Asked } from './question.ts'
import { isOrchestratorSession } from './supervision.ts'
import { fieldsOf, messageOf, type Host, type On, type Timer } from './host.ts'
import { logLine } from './module-io.ts'

type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'session' | 'tool' | 'clock' | 'prompt'>

/** A pull request is re-checked at most this often, unless a new install came since its last check. */
export const RECHECK_EVERY_MS = 60 * 60_000
/** How often the module looks whether a check is due. */
export const RECHECK_TICK_MS = 5 * 60_000

const PR_REF = /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)/g

export type PrRef = { readonly repo: string; readonly pr: number }

/** The pull requests an open question's text names, once each. */
export function questionPrs(entry: Pick<Asked, 'subject' | 'context' | 'ask'>): PrRef[] {
  const found = new Map<string, PrRef>()
  for (const text of [entry.subject, entry.context, entry.ask]) {
    for (const match of text.matchAll(PR_REF)) {
      const ref = { repo: match[1]!, pr: Number(match[2]) }
      if (!found.has(`${ref.repo}#${ref.pr}`)) found.set(`${ref.repo}#${ref.pr}`, ref)
    }
  }
  return [...found.values()]
}

/** The last check of a pull request for a question: when, under which install, and whether Ready was told. */
export type Checked = { readonly at: number; readonly install: string | null; readonly told: boolean }

/** Whether a check is due: never told, and an hour passed or another commit is installed since the last one. */
export function isDue(last: Checked, now: number, install: string | null): boolean {
  return !last.told && (now - last.at >= RECHECK_EVERY_MS || install !== last.install)
}

/** Whether github's answer to `pr-readiness ready` says Ready was put (or kept): its last line `ready`, `(unchanged)` or not. */
export function saysReady(answer: unknown): boolean {
  const fields = fieldsOf(answer)
  if (fields === undefined || fields['isError'] === true || fields['deny'] !== undefined) return false
  const last = String(fields['result'] ?? '').trim().split('\n').at(-1)?.trim() ?? ''
  return /^ready(?: \(unchanged\))?$/.test(last)
}

/** The line the session is told. */
export function readyText(entry: Pick<Asked, 'id' | 'subject'>, ref: PrRef): string {
  return `[module] ${ref.repo}#${ref.pr} is Ready now: the Ready gate passes at its head. Your open question ${entry.id} (« ${entry.subject} ») asked about it: settle it withdrawn (mcp__orchestrator__settle {"id": "${entry.id}", "outcome": "withdrawn", "reason": "${ref.repo}#${ref.pr} is Ready"}) and go on.`
}

// The commit the continuous deploy installed last, or null when the plugin runs from no deploy
// directory or the state cannot be read: then only the hour makes a check due.
async function installedCommit($: Held): Promise<string | null> {
  const deployed = deployedAt($.plugin.root)
  if (deployed === null) return null
  try {
    return parseDeployState(String(await $.fs.read(deployed.state))).history[0]!.commit
  } catch {
    return null
  }
}

/** One look over the session's open questions: each pull request named checked when due. Answers the lines told. */
export async function recheck($: Held, sessionId: string, checked: Map<string, Checked>): Promise<string[]> {
  const open = (await readAsked($)).filter(entry => entry.status === 'open' && entry.origin === undefined && entry.sender.session === sessionId)
  const named = open.map(entry => ({ entry, refs: questionPrs(entry) })).filter(({ refs }) => refs.length > 0)
  const keys = new Set<string>()
  const told: string[] = []
  // The clock and the install are read only when a question names a pull request.
  const now = named.length > 0 ? await $.clock.now() : 0
  const install = named.length > 0 ? await installedCommit($) : null
  for (const { entry, refs } of named) {
    for (const ref of refs) {
      const key = `${entry.id}|${ref.repo}#${ref.pr}`
      keys.add(key)
      const last = checked.get(key)
      if (last === undefined) {
        // First seen: the question was asked on the gate's refusal, so the first check waits for its due.
        const asked = Date.parse(entry.at)
        checked.set(key, { at: Number.isFinite(asked) ? Math.min(asked, now) : now, install, told: false })
        continue
      }
      if (!isDue(last, now, install)) continue
      checked.set(key, { at: now, install, told: false })
      const answer = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-readiness', args: { pr: ref.pr, state: 'ready' }, repo: ref.repo })
      if (!saysReady(answer)) continue
      checked.set(key, { at: now, install, told: true })
      const text = readyText(entry, ref)
      await $.prompt.submit({ text })
      told.push(text)
    }
  }
  for (const key of [...checked.keys()]) if (!keys.has(key)) checked.delete(key)
  return told
}

export function register(on: On<Held>): void {
  let armed: { sessionId: string; timer: Timer } | null = null
  const checked = new Map<string, Checked>()
  let running = false
  // Armed at an orchestrator's turn end, once per session id: a /clear's new session arms its own.
  on('turn.complete', {}, async ($, e, next) => {
    if (e.agentId) return next(e)
    try {
      const sessionId = await $.session.id()
      if (armed?.sessionId !== sessionId && await isOrchestratorSession($, sessionId)) {
        armed?.timer.cancel()
        checked.clear()
        const tick = async (): Promise<void> => {
          if (running) return
          running = true
          try {
            await recheck($, sessionId, checked)
          } catch (err) {
            await logLine($, 'gate-recheck', messageOf(err))
          } finally {
            running = false
          }
        }
        armed = { sessionId, timer: $.clock.every(RECHECK_TICK_MS, () => void tick()) }
        await tick()
      }
    } catch (err) {
      await logLine($, 'gate-recheck', messageOf(err))
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'gate-recheck', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}
