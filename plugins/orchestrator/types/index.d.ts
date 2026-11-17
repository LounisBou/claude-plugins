// The values the orchestrator hooks module keeps for the length of a session, as the host
// holds them: they outlive a reload of the module, which starts its own variables over.

// The supervision pane was opened in this session, by /orchestrator-supervision or the tool. No
// reader is left: whether a role's pane is open is kept in the state directory (`pane-open-<name>`),
// not in the session's state. Kept declared for the value an earlier release left in a session.
export type PaneOpened = boolean

declare module 'claude-code' {
  interface PluginState {
    orchestrator: { paneOpened: PaneOpened }
  }
}
