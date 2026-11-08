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
