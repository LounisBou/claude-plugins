// The values the orchestrator hooks module keeps for the length of a session, as the host
// holds them: they outlive a reload of the module, which starts its own variables over.

// The supervision pane was opened in this session, by /orchestrator-supervision or the tool. No
// reader is left: the module opens the pane on his word alone, never on its own, so a start, a turn
// or a succession reads no flag. Kept declared for the value an earlier release left in a session.
export type PaneOpened = boolean

declare module 'claude-code' {
  interface PluginState {
    orchestrator: { paneOpened: PaneOpened }
  }
}
