// hooks/learn.ts
// /norms:learn is an entry to the learning distiller, answered here with no model turn. Each pull
// request's resolved threads come from the github plugin's tool (mcp__github__gh pr-threads, a read);
// code keeps the threads it can show acted on (resolved, and its lines changed after it: the forge
// marks it outdated) whose first comment's author can write to the repository, and writes one
// `external` finding per kept thread into the module's journal, under core's THREAD_CODE, its path and
// its pull request as pointers. No reviewer's word is read, kept or handed to a model. The distiller
// counts these events like any other (core's `countsInCluster`): a rule comes from a candidate the
// retrospective judges, and it enters CONTRIBUTING.md only once the person says « add ».
// With no PR number the usage answers; a failure passes the command on to its markdown, which says so.
import { answerOf, fieldsOf, type Host, type On } from '../core/host.ts'
import { learningEvent, repoPath, subjectOf, THREAD_CODE, type LearningEvent } from '../core/learning.ts'
import { journal, type JournalHost } from './observe.ts'
import { repositoryOf } from './record.ts'

export const USAGE = [
  'Usage: /norms:learn <PR-number> [PR-number...]',
  'Example: /norms:learn 1383',
  'Example: /norms:learn 1383 1375 1380',
].join('\n')

export const MAX_PRS = 10

// The forge's associations of an author who can write to the repository.
const WRITERS = ['OWNER', 'MEMBER', 'COLLABORATOR']

export type LearnHost = JournalHost & Host<'tool'>

export function parsePrNumbers(args: string): number[] {
  const out: number[] = []
  for (const m of String(args).matchAll(/(?:^|\s)#?(\d+)(?=[\s,;]|$)/g)) {
    const n = Number(m[1])
    if (n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

/** Why a thread does not count, or the repository path it points at when it does. */
export type Thread = { path: string } | { skipped: 'not acted on' | 'author cannot write' | 'no path' }

/**
 * What code shows of one thread of the github plugin's JSON: acted on (resolved, and outdated: its
 * lines changed after it), by an author the forge says can write. An author whose association the
 * forge did not hand counts as one who cannot.
 */
export function threadOf(raw: unknown): Thread {
  const thread = fieldsOf(raw) ?? {}
  if (thread['isResolved'] !== true || thread['isOutdated'] !== true) return { skipped: 'not acted on' }
  const nodes = fieldsOf(thread['comments'])?.['nodes']
  const association = Array.isArray(nodes) ? fieldsOf(nodes[0])?.['authorAssociation'] : undefined
  if (typeof association !== 'string' || !WRITERS.includes(association)) return { skipped: 'author cannot write' }
  const path = typeof thread['path'] === 'string' ? repoPath(thread['path']) : undefined
  return path === undefined ? { skipped: 'no path' } : { path }
}

async function fetchThreads($: Host<'tool'>, pr: number): Promise<unknown[]> {
  const answer = answerOf(await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-threads', args: { pr, format: 'resolved-threads' } }))
  if (answer.deny !== undefined || answer.isError) throw new Error(`pr-threads ${pr}: ${answer.deny ?? answer.text}`)
  const parsed: unknown = JSON.parse(answer.text)
  if (!Array.isArray(parsed)) throw new Error(`pr-threads ${pr}: no list of threads`)
  return parsed
}

/** The answer: what was handed to the distiller, what was not and why, and where a rule comes from. */
export function summary(repo: string, counted: number, skipped: ReadonlyMap<string, number>, prs: readonly number[]): string {
  const left = [...skipped].map(([why, n]) => `${n} ${why}`).join(', ')
  return [
    `norms learn: ${counted} resolved threads of ${repo} ${prs.map(pr => `#${pr}`).join(' ')} handed to the learning distiller as external evidence${left === '' ? '' : `; left out: ${left}`}.`,
    'A rule comes from a candidate the learning retrospective judges, once threads recur across pull requests; it enters CONTRIBUTING.md only after the person says « add ». Nothing was written to CONTRIBUTING.md.',
  ].join('\n')
}

/** Reads the pull requests' threads, writes one event per thread that counts, and answers the summary. */
export async function learn($: LearnHost, args: string): Promise<{ text: string }> {
  const prs = parsePrNumbers(args)
  if (prs.length === 0 || prs.length > MAX_PRS) return { text: USAGE }
  const repo = await repositoryOf($)
  if (repo === undefined) throw new Error('the origin remote names no GitHub repository')
  const kept: Array<{ pr: number; path: string }> = []
  const skipped = new Map<string, number>()
  for (const pr of prs) {
    for (const raw of await fetchThreads($, pr)) {
      const thread = threadOf(raw)
      if ('path' in thread) kept.push({ pr, path: thread.path })
      else skipped.set(thread.skipped, (skipped.get(thread.skipped) ?? 0) + 1)
    }
  }
  await journal($, (known) => kept.map(({ pr, path }): LearningEvent | undefined => {
    const { plugin, subject: _noted, ...rest } = known()
    return learningEvent({ ...rest, kind: 'finding', source: { plugin, code: THREAD_CODE }, trust: 'external', subject: subjectOf({ repo, pr }), context: { ...rest.context, paths: [path] } })
  }))
  return { text: summary(subjectOf({ repo }).repo ?? repo, kept.length, skipped, prs) }
}

// The Skill tool calls that run /norms:learn: the host runs no command.run for them.
const LEARN_SKILL_MATCHER = { tool: 'Skill', skill: /^\/?norms:learn$/ }

export function register(on: On<LearnHost>): void {
  on('command.run', { command: 'norms:learn' }, async ($, e) => learn($, e.args))
    .catch((_$, e, next) => next(e))
  on('tool.call', LEARN_SKILL_MATCHER, async ($, e) => ({ result: (await learn($, String(e['args'] ?? ''))).text }))
    .catch((_$, e, next) => next(e))
}
