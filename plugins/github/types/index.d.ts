// The github plugin's values in the session ($.state), read by its PR pane.

export type GithubPaneRow = {
  number: number
  title: string
  url: string
  draft: boolean
  // The PR's comments, on it and on its diff.
  comments: number
  // SUCCESS, FAILURE or PENDING, as the ready guard reads the head's checks; "?" for a
  // rollup state the engine does not know.
  ci: string
  // The failed checks' names, when ci is FAILURE.
  failed: string[]
}

export type GithubPane = {
  rows: GithubPaneRow[]
  // The last read's error, shown under the rows from the last good read.
  error: string | null
  refreshing: boolean
}

declare module 'claude-code' {
  interface PluginState {
    github: { pane: GithubPane }
  }
}
