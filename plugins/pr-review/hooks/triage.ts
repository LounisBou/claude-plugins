// hooks/triage.ts
// process-comments' Step 0 and Step 1 as one tool: the PR, its issue comments,
// its reviews and its open threads read through the github plugin's tool (so
// its permission check applies), then triaged by the same script the Bash
// route runs. One call answers the open items, the counts, the tier and the
// line to announce, where the skill used to spend a dozen shell blocks.
import { GH_TOOL } from './policy.ts'

export const OPEN_COMMENTS = 'open_comments'

export const OPEN_COMMENTS_DESCRIPTION =
  'pr-review: the open comments of a pull request, triaged for /pr-review:process-comments. '
  + 'Answers JSON: pr, title, url, description, author, pending, tier (EXIT, FAST or FULL), '
  + 'counts, announce (the line to say first), paths (files with open threads) and items '
  + '(review-thread, issue-comment, review-body; ids, path, line, author, body, images, auto_passed). '
  + 'Omit pr for the current branch\'s pull request.'

// One github tool call, its text parsed as JSON. A deny or an error is thrown
// with the tool's own words.
async function gh($: any, command: string, args: Record<string, unknown>): Promise<unknown> {
  const answer = await $.tool.call({ tool: GH_TOOL, command, args })
  if (answer?.deny) throw new Error(`${GH_TOOL} ${command} was refused: ${answer.deny}`)
  const text = String(answer?.result ?? answer?.text ?? '')
  if (answer?.isError) throw new Error(`${GH_TOOL} ${command} failed: ${text.trim()}`)
  if (!text.trim() || text.trim() === '(no output)') return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${GH_TOOL} ${command} did not answer JSON`)
  }
}

const nodeIds = (rows: unknown): string[] =>
  Array.isArray(rows) ? rows.map((r: any) => r?.node_id).filter((id: unknown): id is string => typeof id === 'string' && id !== '') : []

export const OPEN_COMMENTS_SCHEMA = {
  type: 'object',
  properties: { pr: { type: 'integer', description: 'the pull request number; omitted, the current branch\'s' } },
}

async function fetchAll($: any, pr?: number): Promise<Record<string, unknown>> {
  const raw = pr ? await gh($, 'pr-status', { pr }) : await gh($, 'pr-get', {})
  const record: any = Array.isArray(raw) ? raw[0] : raw
  const number = record?.number
  if (!number) return { pr: raw }
  const [issueComments, reviews, threads] = await Promise.all([
    gh($, 'pr-issue-comments', { pr: number }),
    gh($, 'pr-reviews', { pr: number }),
    gh($, 'pr-threads', { pr: number, format: 'open-threads' }),
  ])
  const batch = async (ids: string[]) => (ids.length ? gh($, 'comments-resolved-batch', { nodes: ids }) : {})
  const [issueResolved, reviewsResolved] = await Promise.all([batch(nodeIds(issueComments)), batch(nodeIds(reviews))])
  return {
    pr: raw,
    issue_comments: issueComments ?? [],
    reviews: reviews ?? [],
    threads: threads ?? [],
    issue_resolved: issueResolved ?? {},
    reviews_resolved: reviewsResolved ?? {},
  }
}

export function register(on: any): void {
  on('tool.call', { tool: 'mcp__pr-review__open_comments' }, async ($: any, e: any) => {
    const listed = (await $.tool.list()).some((t: any) => t.name === GH_TOOL)
    if (!listed) {
      return { result: `${GH_TOOL} is not listed in this session: run the Bash route of process-comments Step 0 instead.`, isError: true }
    }
    try {
      const data = await fetchAll($, typeof e.pr === 'number' ? e.pr : undefined)
      const run = await $.process.run(
        ['python3', $.plugin.root + '/skills/process-comments/scripts/triage.py', '--stdin'],
        { stdin: JSON.stringify(data), timeoutMs: 60_000 },
      )
      if (run.exitCode !== 0) return { result: (run.stderr || 'triage.py exited ' + run.exitCode).trim(), isError: true }
      return { result: run.stdout }
    } catch (err: any) {
      return { result: String(err?.message ?? err), isError: true }
    }
  }).catch(async () => ({
    result: 'pr-review open_comments failed in the module itself: run the Bash route of process-comments Step 0 instead.',
    isError: true,
  }))
}
