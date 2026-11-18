// The value the norms hooks module keeps in the host's $.state for the length of a session:
// the scope /norms:check computed, its head and the repository it read (hooks/record.ts).
export type NormsScopeMark = { head: string; dir?: string }

declare module 'claude-code' {
  interface PluginState {
    norms: { scopeMark: NormsScopeMark | null }
  }
}
