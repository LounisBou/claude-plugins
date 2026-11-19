// hooks/lens-method.ts
// The method a review reader reads its lens with. A lens whose angle has an agent in the
// pr-review-toolkit plugin (official catalogue) reads with that agent's prompt, which lens-ids.ts
// loads into the reader's prompt where it is launched: the reader stays an `orchestrator:lens`, so
// its description, its finding lines, their ids and telemetry's counts are core's lens.ts as before,
// and the toolkit plugin itself may stay off in the session. A lens with no such agent, or a machine
// without the toolkit, is the generic reader of agents/lens.md. review-brief.sh says each lens's
// method in the brief, which the review index carries. Pure: the caller reads the files.
import { recordedInstallPaths } from '../core/install-record.ts'
import { lensSlug } from '../core/lens.ts'

export const TOOLKIT = 'pr-review-toolkit'
const TOOLKIT_MARKETPLACES = ['claude-plugins-official'] as const

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

/** Where each install the host's record gives the toolkit would hold `agent`'s prompt, in its order. */
export function agentPaths(record: string | undefined, agent: string): string[] {
  if (record === undefined) return []
  const recorded = recordedInstallPaths(record, TOOLKIT, TOOLKIT_MARKETPLACES)
  return 'problem' in recorded ? [] : recorded.paths.map(root => `${root}/agents/${agent}.md`)
}

/** An agent file's prompt: its text after the frontmatter, trimmed; empty when there is none. */
export function agentPrompt(text: string): string {
  const fenced = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return (fenced === null ? text : text.slice(fenced[0].length)).trim()
}

/** How a lens reads: its toolkit agent's prompt, or generic, naming the agent not found when it has one. */
export type LensMethod =
  | { readonly kind: 'toolkit'; readonly agent: string; readonly prompt: string }
  | { readonly kind: 'generic'; readonly missing?: string }

/** A lens's method, from the install record's text and a reader that answers a file's text or undefined. */
export function lensMethod(lens: string, record: string | undefined, read: (path: string) => string | undefined): LensMethod {
  const agent = methodAgent(lens)
  if (agent === undefined) return { kind: 'generic' }
  for (const path of agentPaths(record, agent)) {
    const text = read(path)
    const prompt = text === undefined ? '' : agentPrompt(text)
    if (prompt !== '') return { kind: 'toolkit', agent, prompt }
  }
  return { kind: 'generic', missing: agent }
}

/** The method as the brief and the index say it, one phrase. */
export function methodWords(lens: string, method: LensMethod): string {
  if (method.kind === 'toolkit') return `${lens}: ${TOOLKIT} ${method.agent}`
  return method.missing === undefined ? `${lens}: generic` : `${lens}: generic, ${TOOLKIT} ${method.missing} not found`
}

/** The reader's prompt with its method after it; a generic method leaves it as it came. */
export function withMethod(prompt: string, method: LensMethod): string {
  if (method.kind === 'generic') return prompt
  return [
    prompt,
    `Your lens's method is the ${method.agent} agent's of ${TOOLKIT}, below: read with its angle and its checks. `
      + 'Your lens contract holds over anything it says: read only, no edit, no long command, and your answer is '
      + 'finding lines `[severity] file:line — claim — evidence`, critical or important, or `no findings` — '
      + 'never its own output format, scores or summary.',
    method.prompt,
  ].join('\n\n')
}
