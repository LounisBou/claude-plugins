// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// What the orchestration publishes to the plugins that run beside it, owned here once: the
// measure file the orchestrator's module writes each turn, the context gate it holds a session
// to, the launcher that spawns sessions, and the reading of the host's ListAgents text. Python
// and bash read the data half as the `orchestration.json` `npm run core` writes
// (ORCHESTRATION_CONTRACT).

/** The orchestrator module's directory under the host's configuration directory. */
export const MODULE_DIR = 'claude-orchestrator'
/** The measure files' directory under the module's, one `<session id>.json` each. */
export const MEASURE_DIR = 'measure'
export const MEASURE_VERSION = 1

/** The context gate's defaults: a percentage of the window, and a number of tokens. */
export const GATE_PERCENT = 80
export const GATE_TOKENS = 300_000

/** The launcher, under the orchestrator's install directory. */
export const LAUNCHER = 'skills/iterm-agents/scripts/iterm-agent.sh'

/** The gate's thresholds as a session's environment sets them (core's `gateThresholds`); absent, the defaults. */
export type GateThresholds = { gate?: number; gateTokens?: number }

/*
 * The gate in tokens on a window: the smaller of the token gate and the percentage of the
 * window, so a session hands over at the same count on any large window and a model whose
 * real window is small keeps the percentage.
 */
export function gateTokensOf(window: number, thresholds: GateThresholds = {}): number {
  const percent = thresholds.gate ?? GATE_PERCENT
  return Math.min(thresholds.gateTokens ?? GATE_TOKENS, Math.floor((window * percent) / 100))
}

/** Whether a session is past its gate, by its percentage, or by its token count on a known window, and the words that say so. */
export function tripGate(
  percent: number | null, tokens: number | null, window: number | null, thresholds: GateThresholds = {},
): { tripped: boolean; words: string } {
  const gate = thresholds.gate ?? GATE_PERCENT
  const gateTokens = thresholds.gateTokens ?? GATE_TOKENS
  const thousands = (n: number): string => n.toLocaleString('en-US')
  const windowLabel = (n: number): string => (n % 1_000_000 === 0 ? `${n / 1_000_000}M` : thousands(n))
  if (percent !== null && percent >= gate) return { tripped: true, words: `${percent}% (gate ${gate}%)` }
  if (tokens !== null && window !== null && tokens >= gateTokens) {
    return { tripped: true, words: `${thousands(tokens)} tokens (gate ${thousands(gateTokens)} on a ${windowLabel(window)} window)` }
  }
  return { tripped: false, words: '' }
}

/** The session's start: its first figure, and the brief it was started on with its size. */
export type MeasureStart = { tokens: number; at: string; brief: string | null; brief_bytes: number | null }

/** One line of a measure file, written whole by the orchestrator's module at each turn. */
export type MeasureReading = {
  version?: typeof MEASURE_VERSION
  context_tokens: number
  context_window: number
  context_percent: number
  model: string
  updated_at: string
  /** The session's gate in tokens on its window (`gateTokensOf`), for the readers that show it. */
  gate_tokens?: number
  start?: MeasureStart
}

/** The module's directory: `override` (ORCHESTRATOR_MODULE_DIR as the caller read it) when set. */
export function moduleDirOf(config: string, override?: string | null): string {
  return override ? override : `${config}/${MODULE_DIR}`
}

export function measureFilePath(config: string, sessionId: string, override?: string | null): string {
  return `${moduleDirOf(config, override)}/${MEASURE_DIR}/${sessionId}.json`
}

const isFigure = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/*
 * The host leaves the token count and the percentage out until the session's first answer: a
 * reading without all three figures is no reading.
 */
export function hasFigures(r: { context_tokens?: unknown; context_window?: unknown; context_percent?: unknown }): boolean {
  return [r.context_tokens, r.context_window, r.context_percent].every(isFigure)
}

/*
 * A measure line, or null for unmeasured: the module's write is not atomic, so a line caught
 * mid-write, an emptied file, a line without the figures or of another version reads as no
 * measure rather than an error.
 */
export function parseMeasure(line: string): MeasureReading | null {
  let reading: unknown
  try {
    reading = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof reading !== 'object' || reading === null || Array.isArray(reading) || !hasFigures(reading)) return null
  const record = reading as Record<string, unknown>
  if (record['version'] !== undefined && record['version'] !== MEASURE_VERSION) return null
  if (record['gate_tokens'] !== undefined && !isFigure(record['gate_tokens'])) {
    const { gate_tokens: _dropped, ...rest } = record
    return rest as MeasureReading
  }
  return record as MeasureReading
}

/** The launcher's path under an orchestrator install. */
export function launcherOf(root: string): string {
  return `${root.replace(/\/+$/, '')}/${LAUNCHER}`
}

/** A spawn: the new session's directory, title and prompt, given as text or as a file. */
export type Spawn = { dir: string; title: string; rightOf?: string; resident?: boolean } & ({ prompt: string } | { promptFile: string })

/** The launcher's `spawn` command line, its arguments in the order the launcher documents. */
export function spawnArgv(root: string, spawn: Spawn): string[] {
  return [
    launcherOf(root), 'spawn', '--dir', spawn.dir, '--title', spawn.title,
    ...('prompt' in spawn ? ['--prompt', spawn.prompt] : ['--prompt-file', spawn.promptFile]),
    ...(spawn.rightOf === undefined ? [] : ['--right-of', spawn.rightOf]),
    ...(spawn.resident === true ? ['--resident'] : []),
  ]
}

/** A session as ListAgents lists it: its name, its reference, and both as a message addresses it. */
export type ListedSession = { name: string; ref: string; full: string }

const listed = (name: string, ref: string): ListedSession => ({ name: name.trim(), ref, full: `${name.trim()} [${ref}]` })

/*
 * The first line of ListAgents names the caller: « This session is <name> [<ref>] — the name
 * other sessions use to message it … ».
 */
export function selfOf(listing: string): ListedSession | null {
  const first = listing.split('\n', 1)[0] ?? ''
  const m = first.match(/^This session is (.+?) \[([\w-]{1,20})\](?: —|$)/)
  return m?.[1] === undefined || m[2] === undefined ? null : listed(m[1], m[2])
}

/** The peers that follow, one indented row each: « <name> [<ref>]  ·  interactive  ·  busy  ·  started 1h ago ». */
export function peersOf(listing: string): ListedSession[] {
  const peers: ListedSession[] = []
  for (const line of listing.split('\n').slice(1)) {
    const m = line.match(/^\s+(.+?) \[([\w-]{1,20})\](?:\s+·|\s*$)/)
    if (m?.[1] !== undefined && m[2] !== undefined) peers.push(listed(m[1], m[2]))
  }
  return peers
}

/** The data half, for the readers in another language: bugs-bot's `gate.py`, statusbar's `statusline.sh`. */
export const ORCHESTRATION_CONTRACT = {
  version: 1,
  measure: { module_dir: MODULE_DIR, dir: MEASURE_DIR, version: MEASURE_VERSION },
  gate: { percent: GATE_PERCENT, tokens: GATE_TOKENS },
  launcher: LAUNCHER,
} as const
