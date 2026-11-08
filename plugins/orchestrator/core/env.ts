// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The environment variables more than one plugin reads, named once with what each means. The
// host requires a literal name where a hooks module reads one (`$.env.get('NAME')`), so a module
// writes the name; `npm run deps` refuses a plugin reading another plugin's family
// (ORCHESTRATOR_* is the orchestrator's, CLAUDE_GITHUB_* github's) by a name not listed here.

export const ENV = {
  /** Set by the orchestrator's launcher in every session it spawns. */
  spawned: 'ORCHESTRATOR_SPAWNED',
  /** A checkout of the github plugin that wins over the host's install record. */
  githubRoot: 'CLAUDE_GITHUB_ROOT',
  /** The context gate as a percentage of the window, and as a number of tokens. */
  gatePercent: 'ORCHESTRATOR_CONTEXT_GATE',
  gateTokens: 'ORCHESTRATOR_CONTEXT_GATE_TOKENS',
} as const

/** Whether a session was spawned by the orchestrator, from the value of ENV.spawned. */
export function isSpawned(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

export type Env = Readonly<Record<string, string | undefined>>

/** The value of `name`, or undefined when it is unset or empty. */
export function setting(env: Env, name: string): string | undefined {
  const value = env[name]
  return value === undefined || value === '' ? undefined : value
}

/** The host's configuration directory: CLAUDE_CONFIG_DIR, or `.claude` under `home`. */
export function configDirOf(env: Env, home: string): string {
  return setting(env, 'CLAUDE_CONFIG_DIR') ?? `${home.replace(/\/+$/, '')}/.claude`
}

/**
 * The context gate's thresholds from the values of ENV.gatePercent and ENV.gateTokens: a value
 * that is no positive number is unset, and the reader applies its default.
 */
export function gateThresholds(env: Env): { gate?: number; gateTokens?: number } {
  const threshold = (raw: string | undefined): number | undefined => {
    const n = raw === undefined ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const gate = threshold(env[ENV.gatePercent])
  const gateTokens = threshold(env[ENV.gateTokens])
  return { ...(gate === undefined ? {} : { gate }), ...(gateTokens === undefined ? {} : { gateTokens }) }
}
