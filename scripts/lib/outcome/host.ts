// The real single arm, meter and judge: the host's command line run headless in the arm's bench,
// the orchestrator's deck read for what an orchestration's sessions spend, and the host asked
// for the two judgments. The orchestration arm is an interactive session (orchestration.ts).
// What decides is pure and tested here; the processes are a thin layer.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { Agent, AgentRun, Finding, IntentVerdict, Judge, JudgeInput, Judgment, Meter, ReviewVerdict } from './harness.ts'

/** A diff longer than this is cut for a judge, and the cut said. */
export const JUDGE_DIFF_CHARS = 60_000
/** A stopped process gets this long to end before it is killed. */
const GRACE_MS = 10_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------------------------
// The host's answer

export interface HostResult {
  readonly costUsd: number | null
  readonly isError: boolean
  readonly result: string
  readonly sessionId: string | null
}

/** The host's `--output-format json` answer, or an error naming what is wrong with it. */
export function parseHostResult(text: string): HostResult | Error {
  let raw: unknown
  try {
    raw = JSON.parse(text.trim())
  } catch {
    return new Error(`the host printed no JSON answer: ${text.trim().slice(0, 200)}`)
  }
  if (!isRecord(raw)) return new Error('the host answer is not an object')
  const cost = raw['total_cost_usd']
  const result = raw['result']
  const session = raw['session_id']
  return {
    costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    isError: raw['is_error'] === true || (typeof raw['subtype'] === 'string' && raw['subtype'] !== 'success'),
    result: typeof result === 'string' ? result : '',
    sessionId: typeof session === 'string' ? session : null,
  }
}

// ---------------------------------------------------------------------------------------------
// The arms

export interface HostOptions {
  readonly host: string
  readonly model: string
  /** A settings file that turns off every installed orchestrator, so only the arm's own loads. */
  readonly settingsFile: string
}

/** The settings that turn off each installed orchestrator named in the operator's settings. */
export function withoutOrchestrator(operatorSettings: unknown): { enabledPlugins: Record<string, false> } {
  const enabled = isRecord(operatorSettings) ? operatorSettings['enabledPlugins'] : undefined
  const off: Record<string, false> = {}
  if (isRecord(enabled)) for (const key of Object.keys(enabled)) if (key.startsWith('orchestrator@')) off[key] = false
  return { enabledPlugins: off }
}

/** The names of the plugins a manifest (`.claude-plugin/plugin.json`) depends on, or what is wrong with it. */
export function dependencyNames(manifest: unknown): string[] | Error {
  if (!isRecord(manifest)) return new Error('the manifest is not an object')
  const list = manifest['dependencies']
  if (list === undefined) return []
  if (!Array.isArray(list)) return new Error('its dependencies are not a list')
  const names: string[] = []
  for (const entry of list) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) ? entry['name'] : undefined
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return new Error(`a dependency names no plugin: ${JSON.stringify(entry)}`)
    names.push(name)
  }
  return names
}

/** The host's arguments for the single arm: headless, its budget, its model, no question asked. */
export function agentArgs(options: HostOptions, prompt: string, budgetUsd: number): string[] {
  const args = ['-p', prompt, '--output-format', 'json', '--max-budget-usd', budgetUsd.toFixed(2), '--model', options.model, '--settings', options.settingsFile]
  // The bench is a private clone with no remote: nothing an arm does reaches the forge, so its
  // tools run unasked.
  args.push('--dangerously-skip-permissions')
  return args
}

interface Exit {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs the host in its own process group, ended whole when `signal` aborts. */
function host(binary: string, args: readonly string[], cwd: string, signal: AbortSignal): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig)
      } catch {
        // already gone
      }
    }
    let late: NodeJS.Timeout | undefined
    const stop = (): void => {
      kill('SIGTERM')
      late = setTimeout(() => kill('SIGKILL'), GRACE_MS)
    }
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(late)
      signal.removeEventListener('abort', stop)
      resolve({ code, stdout, stderr })
    })
  })
}

/** What an arm's run reports, from the host's exit. */
export function runOf(exit: Exit): AgentRun {
  const answer = parseHostResult(exit.stdout)
  if (answer instanceof Error) return { costUsd: null, error: `${answer.message}${exit.stderr ? `; ${exit.stderr.trim().slice(-300)}` : ''}` }
  if (answer.isError || exit.code !== 0) return { costUsd: answer.costUsd, error: answer.result.slice(0, 300) || `the host exited with ${exit.code}` }
  return { costUsd: answer.costUsd, error: null }
}

/** The single arm as the host runs it. */
export function hostAgent(options: HostOptions): Agent {
  return {
    async run({ dir, prompt, budgetUsd, signal }) {
      return runOf(await host(options.host, agentArgs(options, prompt, budgetUsd), dir, signal))
    },
  }
}

/** Each arm to its own driver. */
export function byArm(single: Agent, orchestration: Agent): Agent {
  return { run: input => (input.arm === 'orchestration' ? orchestration : single).run(input) }
}

// ---------------------------------------------------------------------------------------------
// The meter: the orchestrator's deck

export interface DeckSessionUsage {
  readonly key: string
  /** The session's terminal; null for a remote one. */
  readonly tty: string | null
  /** The session's spend this week, at API list prices; null when unpriced. */
  readonly weekUsd: number | null
}

function sessionOf(raw: unknown): DeckSessionUsage | null {
  if (!isRecord(raw) || typeof raw['key'] !== 'string') return null
  const usage = raw['usage']
  const week = isRecord(usage) ? usage['week'] : undefined
  const cost = isRecord(week) ? week['cost_usd'] : undefined
  return { key: raw['key'], tty: typeof raw['tty'] === 'string' ? raw['tty'] : null, weekUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null }
}

/** Every local session the deck lists: the coordinator, the orchestrators, their agents and the others. */
export function deckSessions(raw: unknown): DeckSessionUsage[] {
  if (!isRecord(raw)) return []
  const found: unknown[] = [raw['coordinator']]
  for (const list of [raw['orchestrators'], raw['unattached_agents']]) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      found.push(entry)
      if (isRecord(entry) && Array.isArray(entry['agents'])) found.push(...entry['agents'])
    }
  }
  return found.map(sessionOf).filter((session): session is DeckSessionUsage => session !== null)
}

/**
 * What the arm's sessions opened since `before` have spent: a session already listed at the start,
 * or one `ours` does not claim, is someone else's work. Each session counts at the highest week
 * figure seen, so one that leaves the deck or crosses the week's start keeps what it spent. An
 * unpriced session counts nothing.
 */
export class DeckLedger {
  readonly #before: ReadonlySet<string>
  readonly #ours: (session: DeckSessionUsage) => boolean
  readonly #seen = new Map<string, DeckSessionUsage>()

  constructor(before: readonly DeckSessionUsage[], ours: (session: DeckSessionUsage) => boolean) {
    this.#before = new Set(before.map(session => session.key))
    this.#ours = ours
  }

  read(now: readonly DeckSessionUsage[]): number {
    for (const session of now) {
      if (this.#before.has(session.key) || !this.#ours(session)) continue
      const earlier = this.#seen.get(session.key)
      if (earlier === undefined || (session.weekUsd ?? 0) >= (earlier.weekUsd ?? 0)) this.#seen.set(session.key, session)
    }
    return [...this.#seen.values()].reduce((sum, session) => sum + (session.weekUsd ?? 0), 0)
  }
}

function readDeck(path: string): DeckSessionUsage[] {
  if (!existsSync(path)) return []
  try {
    return deckSessions(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return [] // a deck caught mid-write reads as empty; the next poll reads it whole
  }
}

/**
 * The meter over the deck at `path`: what the sessions opened since the arm started on the
 * terminals `ttys` names have spent, the panes of the arm's home, and no other session of the machine.
 */
export function deckMeter(path: string, ttys: () => ReadonlySet<string>): Meter {
  return {
    async start() {
      const ledger = new DeckLedger(readDeck(path), session => session.tty !== null && ttys().has(session.tty))
      return { spent: async () => ledger.read(readDeck(path)) }
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The judge

function cut(patch: string): string {
  if (patch.length <= JUDGE_DIFF_CHARS) return patch
  return `${patch.slice(0, JUDGE_DIFF_CHARS)}\n[the diff is cut here: ${patch.length - JUDGE_DIFF_CHARS} more characters]`
}

export function intentPrompt(input: Pick<JudgeInput, 'case' | 'diff' | 'reference'>): string {
  return [
    'You judge whether a code change does what its task asked. Judge the outcome, not the style.',
    '',
    '## The task',
    input.case.task,
    '',
    '## The change that was merged for it (one correct solution; another may differ and be right)',
    '```diff',
    cut(input.reference.patch),
    '```',
    '',
    '## The change to judge',
    '```diff',
    cut(input.diff.patch),
    '```',
    '',
    'Does the change to judge do everything the task asks, as well as the merged one? Answer with one JSON object and nothing else:',
    '{"matches": true or false, "reason": "one sentence"}',
  ].join('\n')
}

export function reviewPrompt(input: Pick<JudgeInput, 'case' | 'diff'>): string {
  return [
    'You review a code change made for the task below, as the reviewer of its pull request.',
    'A finding is blocking when it must be fixed before a merge: a bug, a part of the task not done, a change without the test that proves it, a security hole. Every other finding is minor.',
    '',
    '## The task',
    input.case.task,
    '',
    '## The change',
    '```diff',
    cut(input.diff.patch),
    '```',
    '',
    'Answer with one JSON object and nothing else:',
    '{"findings": [{"severity": "blocking" or "minor", "text": "one sentence"}]}',
  ].join('\n')
}

/** The one JSON object of a judge's answer, fenced or not. */
function objectIn(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export function parseIntent(text: string): IntentVerdict | null {
  const raw = objectIn(text)
  if (!isRecord(raw) || typeof raw['matches'] !== 'boolean' || typeof raw['reason'] !== 'string') return null
  return { matches: raw['matches'], reason: raw['reason'] }
}

export function parseReview(text: string): ReviewVerdict | null {
  const raw = objectIn(text)
  if (!isRecord(raw) || !Array.isArray(raw['findings'])) return null
  const findings: Finding[] = []
  for (const entry of raw['findings']) {
    if (!isRecord(entry) || (entry['severity'] !== 'blocking' && entry['severity'] !== 'minor') || typeof entry['text'] !== 'string') return null
    findings.push({ severity: entry['severity'], text: entry['text'] })
  }
  return { findings }
}

export interface JudgeOptions {
  readonly host: string
  readonly model: string
  readonly settingsFile: string
  /** An empty directory: a judge reads only what its prompt holds. */
  readonly dir: string
}

export function judgeArgs(options: JudgeOptions, prompt: string, budgetUsd: number): string[] {
  return ['-p', prompt, '--output-format', 'json', '--max-budget-usd', budgetUsd.toFixed(2), '--model', options.model, '--settings', options.settingsFile]
}

/** A judgment from the host's exit, its verdict read by `parse`. */
export function judgmentOf<T>(exit: Exit, parse: (text: string) => T | null): Judgment<T> {
  const answer = parseHostResult(exit.stdout)
  if (answer instanceof Error) return { costUsd: null, verdict: null, error: answer.message }
  const verdict = answer.isError ? null : parse(answer.result)
  return { costUsd: answer.costUsd, verdict, error: verdict === null ? `no verdict in: ${answer.result.slice(0, 200)}` : null }
}

export function hostJudge(options: JudgeOptions): Judge {
  const ask = async <T>(prompt: string, budgetUsd: number, signal: AbortSignal, parse: (text: string) => T | null): Promise<Judgment<T>> =>
    judgmentOf(await host(options.host, judgeArgs(options, prompt, budgetUsd), options.dir, signal), parse)
  return {
    intent: input => ask(intentPrompt(input), input.budgetUsd, input.signal, parseIntent),
    review: input => ask(reviewPrompt(input), input.budgetUsd, input.signal, parseReview),
  }
}
