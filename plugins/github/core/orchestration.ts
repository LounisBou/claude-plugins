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
/** The registry of dispatch records (`<session>`, one record path a line) and the round's entries, beside it. */
export const RECORDS_DIR = 'records'
export const ROUND_DIR = 'round'
/** Under the round directory, the one that keeps the old round files. */
export const ROUND_ARCHIVE_DIR = 'archive'

/**
 * The file of one round entry under the orchestrator's state directory, `<state>/round/<id>.json`:
 * one JSON object, read and rewritten only under the store's lock (store-io.ts `updateOver`,
 * store.ts `update`), replaced whole in one rename.
 */
export function roundEntryPath(state: string, id: string): string {
  return `${state}/${ROUND_DIR}/${id}.json`
}

/** A session's entry in the records registry, its id with any character outside `[A-Za-z0-9._-]` made `_`. */
export function registryNameOf(session: string): string {
  return session.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** The registry of the dispatch records a session wrote or took over, `<state>/records/<session>`: one record path a line. */
export function recordsRegistryPath(state: string, session: string): string {
  return `${state}/${RECORDS_DIR}/${registryNameOf(session)}`
}

/** ci-watch's logs under the orchestrator's state directory, each with its owner file `<log>.session` beside it. */
export const CI_WATCH_DIR = 'ci-watch'

/**
 * The log of a pull request's watch, `<slug>-pr<n>.log`, or `<slug>-pr<n>-base.log` for the watch of
 * the base branch after the merge: the slug is the repository named (`here` when none), any
 * character outside `[A-Za-z0-9._-]` made `_`.
 */
export function ciWatchLogName(repo: string | undefined, pr: string, base = false): string {
  return `${(repo ?? 'here').replace(/[^A-Za-z0-9._-]/g, '_')}-pr${pr}${base ? '-base' : ''}.log`
}

/** The path of that log under the state directory `state`. */
export function ciWatchLogPath(state: string, repo: string | undefined, pr: string, base = false): string {
  return `${state}/${CI_WATCH_DIR}/${ciWatchLogName(repo, pr, base)}`
}

/** The gate readings ci-watch keeps under the orchestrator's state directory, one file a pull request. */
export const CI_GATE_DIR = 'ci-gate'

/**
 * The last answer of github's `pr-gate` ci-watch read for a pull request, `<slug>-pr<n>.json`: the
 * slug is the repository `owner/name` lowercased (as the gate names it), any character outside
 * `[a-z0-9._-]` made `_`. The delivery's facts line reads CI there, never from GitHub itself.
 */
export function ciGatePath(state: string, repo: string, pr: string): string {
  return `${state}/${CI_GATE_DIR}/${repo.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}-pr${pr}.json`
}

/** The pull request number a watch log's name carries, or null: a base watch's log, or no watch log. */
export function watchNumberOf(name: string): string | null {
  if (/-pr\d+-base\.log$/.test(name)) return null
  const m = /-pr(\d+)\.log$/.exec(name)
  return m ? m[1] ?? null : null
}

/** The tool by which a turn declares what will wake it, and the kinds it takes. */
export const WAIT_TOOL = 'declare_wait'
export const WAIT_KINDS = ['operator', 'done', 'deferred'] as const
export type WaitKind = (typeof WAIT_KINDS)[number]

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

/**
 * How long a caller lets one `spawn` run before it kills it. The launcher's worst case is a refused
 * spawn: the host's start (30 s), the transcript's wait (90 s), the screen read (8 s) and the close
 * of the tab (up to 20 s), about 150 s. A caller killing it sooner loses the refusal and leaves the
 * tab open; `scripts/contracts.test.ts` holds this figure above the launcher's own defaults.
 */
export const SPAWN_TIMEOUT_MS = 180_000

/** A spawn: the new session's directory, title and prompt, given as text or as a file, and the tools it keeps from its role's default removal. */
export type Spawn = { dir: string; title: string; rightOf?: string; resident?: boolean; keepTools?: readonly string[] } & ({ prompt: string } | { promptFile: string })

/** The `spawn` command line of the launcher at `launcher` (`launcherOf`), its arguments in the order the launcher documents. */
export function spawnArgv(launcher: string, spawn: Spawn): string[] {
  return [
    launcher, 'spawn', '--dir', spawn.dir, '--title', spawn.title,
    ...('prompt' in spawn ? ['--prompt', spawn.prompt] : ['--prompt-file', spawn.promptFile]),
    ...(spawn.rightOf === undefined ? [] : ['--right-of', spawn.rightOf]),
    ...(spawn.resident === true ? ['--resident'] : []),
    ...(spawn.keepTools ?? []).flatMap(name => ['--keep-tool', name]),
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
