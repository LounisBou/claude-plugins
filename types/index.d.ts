// The values the orchestrator hooks module keeps for the length of a session, as the host
// holds them: they outlive a reload of the module, which starts its own variables over.

// The supervision pane was opened in this session, by the module at a coordinator's first
// turn end or by /coordinator-supervision or /orchestrator-supervision: the module never opens
// it again on its own.
export type PaneOpened = boolean

declare module 'claude-code' {
  interface PluginState {
    orchestrator: { paneOpened: PaneOpened }
  }
}
