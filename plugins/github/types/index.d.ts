// The github plugin's values in the session ($.state), read by its PR pane.

export type GithubPaneRow = {
  number: number
  title: string
  url: string
  draft: boolean
  // The PR's comments, on it and on its diff.
  comments: number | null
  // SUCCESS, FAILURE or PENDING from the head's status check rollup, NONE when
  // nothing is reported on it; "?" when the checks could not be read.
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
