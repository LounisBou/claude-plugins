// hooks/ready-agent.ts
// What says an agent is done with a Ready pull request, read from the artifact (the label at the pull
// request's head), so any reader that learns of it late, the module's tick of a fresh session or the
// takeover's print, names the same agents to close. Pure: the reading of the files is the caller's.
import { agentsOf, prKey, READY_LABEL, type LedgerLine } from '../core/pr-ledger.ts'
import type { FilePr } from './pr-file-format.ts'

/** The head (sha) each open pull request carries Ready at, by `<repo>#<n>`. */
export function readyHeadsOf(prs: readonly FilePr[]): Map<string, string> {
  const heads = new Map<string, string>()
  for (const pr of prs) {
    if (pr.state === 'OPEN' && pr.labels.some(name => name.trim().toLowerCase() === READY_LABEL.toLowerCase())) heads.set(prKey(pr.repo, pr.pr), pr.sha)
  }
  return heads
}

/** The pull requests an agent still holds besides its Ready ones: its other working lines, put on it last or before, among `kept` (the lines still open). */
export function holdsOf(kept: readonly LedgerLine[], isAgent: (agent: string) => boolean, isReady: (key: string) => boolean): string[] {
  return kept.filter(other => agentsOf(other).some(isAgent) && !isReady(prKey(other.repo, other.pr))).map(other => prKey(other.repo, other.pr))
}

// The line a pull request that is Ready wakes its orchestrator with: its agent is done with it and closes now, its
// session id (`session`, read where the agent is still running) kept on the row to resume it from; when the agent still
// holds another pull request (`holds`), to be told.
export function readyAgentLine(ready: { repo: string; pr: number; agent: string; session?: string | undefined; holds?: readonly string[] }): string {
  const head = `[module] ${prKey(ready.repo, ready.pr)} is Ready: its agent ${ready.agent}`
  const holds = ready.holds ?? []
  if (holds.length > 0) return `${head} still holds ${holds.join(', ')}; tell it, do not close it.`
  return `${head} is done with it${ready.session === undefined ? '' : ` (session ${ready.session})`}, close it.`
}
