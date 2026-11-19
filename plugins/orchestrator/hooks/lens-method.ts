// hooks/lens-method.ts
// The method a review reader reads its lens with. A lens whose angle has an agent in the
// pr-review-toolkit plugin reads with that agent's prompt, read from the agent's file: the brief
// names the file and says the reader reads it first, and the session's launch prompt carries that.
// No hook changes a reader's launch: the host's auto mode refuses a call a hook rewrote. The reader
// stays an `orchestrator:lens`, so its description, its finding lines, their ids and telemetry's
// counts are core's lens.ts as before, and the toolkit plugin itself may stay off in the session. A
// lens with no such agent, or a machine without the toolkit, is the generic reader of agents/lens.md.
// review-brief.ts says each lens's method in the brief, which the review index carries. Pure: the
// caller reads the files.
import { recordedInstallPaths } from '../core/install-record.ts'
import { lensSlug } from '../core/lens.ts'

export const TOOLKIT = 'pr-review-toolkit'

/** The toolkit agent of each lens angle that has one, by the lens's slug (core's lensSlug). */
export const LENS_METHODS: Readonly<Record<string, string>> = {
  correctness: 'code-reviewer',
  'silent-failures': 'silent-failure-hunter',
  tests: 'pr-test-analyzer',
  types: 'type-design-analyzer',
  comments: 'comment-analyzer',
}

/** The toolkit agent a lens reads with, or undefined for a lens with none. */
export function methodAgent(lens: string): string | undefined {
  const slug = lensSlug(lens)
  return slug === undefined ? undefined : LENS_METHODS[slug]
}

/** The marketplaces the host's record installs the toolkit from, in its order. */
function toolkitMarketplaces(record: string): string[] {
  try {
    const plugins: unknown = (JSON.parse(record) as { plugins?: unknown }).plugins
    if (typeof plugins !== 'object' || plugins === null) return []
    return Object.keys(plugins).filter(key => key.startsWith(`${TOOLKIT}@`)).map(key => key.slice(TOOLKIT.length + 1))
  } catch {
    return []
  }
}

/** Where each install the host's record gives the toolkit would hold `agent`'s prompt, in its order, from any marketplace. */
export function agentPaths(record: string | undefined, agent: string): string[] {
  if (record === undefined) return []
  const recorded = recordedInstallPaths(record, TOOLKIT, toolkitMarketplaces(record))
  return 'problem' in recorded ? [] : recorded.paths.map(root => `${root}/agents/${agent}.md`)
}

/** An agent file's prompt: its text after the frontmatter, trimmed; empty when there is none. */
export function agentPrompt(text: string): string {
  const fenced = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return (fenced === null ? text : text.slice(fenced[0].length)).trim()
}

/** How a lens reads: its toolkit agent's file, or generic, naming the agent not found when it has one. */
export type LensMethod =
  | { readonly kind: 'toolkit'; readonly agent: string; readonly path: string }
  | { readonly kind: 'generic'; readonly missing?: string }

/** A lens's method, from the install record's text and a reader that answers a file's text or undefined. */
export function lensMethod(lens: string, record: string | undefined, read: (path: string) => string | undefined): LensMethod {
  const agent = methodAgent(lens)
  if (agent === undefined) return { kind: 'generic' }
  for (const path of agentPaths(record, agent)) {
    const text = read(path)
    if (text !== undefined && agentPrompt(text) !== '') return { kind: 'toolkit', agent, path }
  }
  return { kind: 'generic', missing: agent }
}

/** The method as the brief and the index say it, one phrase; a toolkit method says where its reader reads it, first. */
export function methodWords(lens: string, method: LensMethod): string {
  if (method.kind === 'toolkit') return `${lens}: ${TOOLKIT} ${method.agent}, its prompt at ${method.path}, read first and answered in finding lines`
  return method.missing === undefined ? `${lens}: generic` : `${lens}: generic, ${TOOLKIT} ${method.missing} not found`
}
