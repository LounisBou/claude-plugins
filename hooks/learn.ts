// hooks/learn.ts
// N3: /norms:learn's data gathering runs here. With no PR number the usage
// text answers at once, with no turn. Otherwise each PR's resolved threads
// come from the github plugin's tool (mcp__github__gh pr-threads, a read),
// and the existing rule headings of CONTRIBUTING.md are listed, all in a
// <norms-learn> block appended to the arguments. The markdown then skips its
// resolver, its /tmp files and its own parse. A failure, or more than the cap
// allows, passes the command on unchanged: the markdown flow still works.
import { fenceFor } from './scope.ts'

export const USAGE = [
  'Usage: /norms:learn <PR-number> [PR-number...]',
  'Example: /norms:learn 1383',
  'Example: /norms:learn 1383 1375 1380',
].join('\n')

export const MAX_PRS = 10
export const MAX_THREADS_CHARS = 150_000

export function parsePrNumbers(args: string): number[] {
  const out: number[] = []
  for (const m of String(args).matchAll(/(?:^|\s)#?(\d+)(?=[\s,;]|$)/g)) {
    const n = Number(m[1])
    if (n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

// `### Rule` headings under each `## ` section of CONTRIBUTING.md.
export function existingRules(text: string): [string, string[]][] {
  const out: [string, string[]][] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) continue
    const h2 = line.match(/^##\s+(.*?)\s*$/)
    if (h2) out.push([h2[1], []])
    const h3 = line.match(/^###\s+(.*?)\s*$/)
    if (h3 && out.length) out[out.length - 1][1].push(h3[1])
  }
  return out
}

export type PrThreads = { pr: number; text: string; count: number | null }

export function threadCount(text: string): number | null {
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.length : null
  } catch {
    return null
  }
}

export function learnBlock(prs: PrThreads[], contributing: string | undefined): string {
  const counted = prs.every(p => p.count !== null)
  const total = prs.reduce((n, p) => n + (p.count ?? 0), 0)
  const lines = [
    '<norms-learn>',
    'Prefetched by the norms plugin: Steps 1 and 3 are done, and Step 4\'s parse of existing rules is below.',
    counted ? `Found ${total} resolved threads across ${prs.length} PRs.` : `Resolved threads fetched for ${prs.length} PRs; count them from the JSON below.`,
  ]
  for (const p of prs) {
    const fence = fenceFor(p.text)
    lines.push('', `## PR #${p.pr}${p.count === null ? '' : ` (${p.count} resolved threads)`}`, fence + 'json', p.text.trimEnd(), fence)
  }
  lines.push('', '## Existing rules in CONTRIBUTING.md')
  if (contributing === undefined) {
    lines.push('CONTRIBUTING.md is absent: it will be created from scratch.')
  } else {
    const rules = existingRules(contributing)
    if (!rules.length) lines.push('CONTRIBUTING.md has no `## ` section yet.')
    for (const [section, names] of rules) lines.push(`- ${section}: ${names.length ? names.join('; ') : '(no rules)'}`)
  }
  lines.push('</norms-learn>')
  return lines.join('\n')
}

async function fetchThreads($: any, pr: number): Promise<PrThreads> {
  const r = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-threads', args: { pr, format: 'resolved-threads' } })
  if (r.deny !== undefined || r.isError) throw new Error(`pr-threads ${pr}: ${r.deny ?? r.text}`)
  const text = String(r.text ?? r.result ?? '')
  return { pr, text, count: threadCount(text) }
}

export function register(on: any): void {
  on('command.run', { command: 'norms:learn' }, async ($: any, e: any, next: any) => {
    const prs = parsePrNumbers(String(e.args ?? ''))
    if (prs.length === 0) return { text: USAGE }
    if (prs.length > MAX_PRS) return next(e)
    const fetched: PrThreads[] = []
    for (const pr of prs) fetched.push(await fetchThreads($, pr))
    if (fetched.reduce((n, p) => n + p.text.length, 0) > MAX_THREADS_CHARS) return next(e)
    const contributing = (await $.fs.exists('CONTRIBUTING.md').catch(() => false))
      ? String(await $.fs.read('CONTRIBUTING.md'))
      : undefined
    const typed = String(e.args ?? '').trim()
    return next({ ...e, args: `${typed}\n\n${learnBlock(fetched, contributing)}` })
  }).catch(($: any, e: any, next: any) => next(e))
}
