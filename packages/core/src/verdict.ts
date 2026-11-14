// The verdict line: what an orchestrator's agent, and a tool answering one, says to the
// orchestrator. The whole report lives in a file the line names; the orchestrator's context
// takes the line alone. Owned by the orchestrator, whose module holds an agent's message to
// this limit; built by the review loop and the norms check where they answer such an agent.

/*
 * The longest message an agent sends its orchestrator. A verdict line with a pull request,
 * a head, a short verdict and an absolute report path runs to about 200 characters, and the
 * method's status line under it to about 150: 400 holds both, and nothing more.
 */
export const VERDICT_LIMIT = 400

export type Verdict = {
  /** owner/name or name: the line names the pull request by the repository's name. */
  repo: string
  pr: number
  head: string
  /** A few words: `review pass (clean)`, `norms fail`, `gate green`. */
  verdict: string
  /** What blocks, as file:line or file; empty for none. */
  blocking: readonly string[]
  /** The absolute path of the full report, or null when none was written. */
  report: string | null
}

/** `<repo>#<pr> <head7> — <verdict> — blocking: <file:line, …|none> — report: <path|none>`. */
export function verdictLine(v: Verdict): string {
  const repo = v.repo.split('/').pop() ?? v.repo
  const blocking = v.blocking.length === 0 ? 'none' : v.blocking.join(', ')
  return `${repo}#${v.pr} ${v.head.slice(0, 7)} — ${v.verdict} — blocking: ${blocking} — report: ${v.report ?? 'none'}`
}

const REPORT_PATH = /\breport:\s*`?(\/[^\s`,;]+)/g

/** The absolute path after the text's last `report:`, its closing punctuation dropped; null for none. */
export function reportPathOf(text: string): string | null {
  const found = [...text.matchAll(REPORT_PATH)].at(-1)?.[1]
  const path = found?.replace(/[.)\]>]+$/, '') ?? ''
  return path.length > 1 ? path : null
}

/** The text cut to `limit` characters, the cut said: where the full report is, or that no file was named. */
export function cutAt(text: string, limit: number, path: string | null): string {
  const said = path ? `cut: full report at ${path}` : `cut at ${limit} of ${text.length} characters: no report file named`
  return `${text.slice(0, limit).trimEnd()} … (${said})`
}

export type Shortened =
  | { kind: 'whole'; text: string }
  | { kind: 'cut'; text: string; path: string }
  | { kind: 'unnamed'; length: number }

/** A message held to the limit: whole, cut with the pointer to the report it names, or unnamed. */
export function shorten(text: string, limit: number = VERDICT_LIMIT): Shortened {
  if (text.length <= limit) return { kind: 'whole', text }
  const path = reportPathOf(text)
  return path ? { kind: 'cut', text: cutAt(text, limit, path), path } : { kind: 'unnamed', length: text.length }
}
