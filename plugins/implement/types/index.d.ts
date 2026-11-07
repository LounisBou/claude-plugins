// The values the implement hooks module keeps for the length of a run, as
// the host holds them: what is armed, and what the band above the prompt draws.
export type ImplementGuard = {
  outer: 'feature' | 'prepare' | 'phase' | 'close' | null
  checking: boolean
  typed: string
}

export type ImplementBand = {
  codename: string
  phase: string
  of: number
  status: string
  title: string
  milestone: string
  head: string
}

declare module 'claude-code' {
  interface PluginState {
    implement: { guard: ImplementGuard; band: ImplementBand | null }
  }
}
