// The machine's pull request file the orchestrator's module keeps under its state directory (its hooks/pr-file.ts,
// which owns the rest of the format): its path and version, and the repositories it read, which github's
// reconciler follows. Pure, with no import: a hooks module imports it.

export const PR_FILE = 'prs.json'
export const PR_FILE_VERSION = 1

export function prFilePath(state: string): string {
  return `${state}/${PR_FILE}`
}

/** The repositories, `owner/name`, a pull request file's text says it read; none when it is not one of this version. */
export function prFileRepos(text: string): string[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== PR_FILE_VERSION) return []
  const repos = (raw as { repos?: unknown }).repos
  return Array.isArray(repos) ? repos.filter((repo): repo is string => typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) : []
}
