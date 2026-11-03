// hooks/record.ts
// The norms record: /norms:check ends by calling mcp__norms__check_done, which
// leaves one record at the pull request's head through the github plugin's
// record tool (mcp__github__record), for its ready guard to read.
// The call is refused unless /norms:check computed its scope in this session
// (hooks/check.ts sets the mark), so the record follows its own scope. A
// failure never throws out of the handler: the answer is one `record:` line,
// the path written or `none` with the reason.

export const CHECK_DONE_TOOL = 'mcp__norms__check_done'
const GH_TOOL = 'mcp__github__gh'
const RECORD_TOOL = 'mcp__github__record'
const GIT_TIMEOUT_MS = 30_000

export const CHECK_DONE_DESCRIPTION =
  '/norms:check\'s last act: record its outcome at the pull request\'s head commit, for the github '
  + 'plugin\'s ready guard. open = findings neither fixed nor passed, fixed = findings fixed, passed = '
  + 'findings passed; auto = true in automatic mode. Answers one line, `record: <path>` or `record: none — <why>`: print it in the report. '
  + 'Refused unless /norms:check computed its scope in this session.'

export const CHECK_DONE_SCHEMA = {
  type: 'object',
  properties: {
    open: { type: 'integer', minimum: 0, description: 'findings left neither fixed nor passed' },
    fixed: { type: 'integer', minimum: 0, description: 'findings fixed' },
    passed: { type: 'integer', minimum: 0, description: 'findings passed' },
    auto: { type: 'boolean', description: 'automatic mode: the passed findings were passed automatically as non-blocking (default false)' },
  },
  required: ['open', 'fixed', 'passed'],
}

// The scope /norms:check computed in this session: its head and the time. A
// module variable, like the scope cache: a reload loses it and asks for a new
// /norms:check.
let mark: { head: string; at: number } | undefined

export function markScope(head: string): void {
  mark = { head, at: Date.now() }
}

export function resetMark(): void {
  mark = undefined
}

// owner/name from a remote url: scp-like, https or ssh://. Undefined for a
// path or a url that names no owner and repository.
export function repoOf(url: string): string | undefined {
  const m = url.trim().match(/^(?:[\w.-]+@[\w.-]+:|(?:https?|ssh|git):\/\/(?:[^/@]+@)?[\w.-]+(?::\d+)?\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : undefined
}

async function git($: any, argv: string[]): Promise<string> {
  const r = await $.process.run(argv, { timeoutMs: GIT_TIMEOUT_MS })
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${String(r.stderr).trim() || 'exit ' + r.exitCode}`)
  return String(r.stdout)
}

const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined)

const none = (why: string) => `record: none — ${why}`

// The answer of a tool called through $.tool.call, as text, or the reason it
// gave none.
function textOf(answer: any): { text: string } | { why: string } {
  if (answer?.deny) return { why: String(answer.deny).trim() }
  const text = String(answer?.result ?? answer?.text ?? '').trim()
  if (answer?.isError) return { why: text || 'the tool failed' }
  return { text }
}

export async function checkDone($: any, input: any): Promise<{ result: string; isError?: boolean }> {
  if (!mark) return { result: 'norms: run /norms:check first: the record follows its own scope', isError: true }
  const open = count(input?.open)
  const fixed = count(input?.fixed)
  const passed = count(input?.passed)
  if (open === undefined || fixed === undefined || passed === undefined) {
    return { result: 'norms: open, fixed and passed are whole numbers, 0 or more', isError: true }
  }
  try {
    // First, so the reason is clear: a record is written on a clean checkout.
    if ((await git($, ['git', 'status', '--porcelain', '-uno'])).trim() !== '') {
      return { result: none('the tracked files have changes') }
    }
    // At the call, not at the scope: the fix commits of check.md 7.4 are in it.
    const head = (await git($, ['git', 'rev-parse', 'HEAD'])).trim()
    if (!head) return { result: none('the checkout has no commit') }
    const repo = repoOf(await git($, ['git', 'remote', 'get-url', 'origin']))
    if (!repo) return { result: none('the origin remote names no GitHub repository') }
    let numberText: string
    try {
      const found = textOf(await $.tool.call({ tool: GH_TOOL, command: 'pr-get', args: { format: 'pr-number' } }))
      if ('why' in found) return { result: none(found.why) }
      numberText = found.text
    } catch {
      return { result: none('the github plugin is absent or older than 0.12.0') }
    }
    const pr = Number(numberText)
    if (!Number.isInteger(pr) || pr < 1) return { result: none('the branch has no pull request') }
    let recorded: { text: string } | { why: string }
    try {
      recorded = textOf(await $.tool.call({
        tool: RECORD_TOOL, pr, repo, kind: 'norms',
        result: open === 0 ? 'pass' : 'fail',
        detail: `${fixed} fixed, ${passed} passed${input?.auto === true ? ' (non-blocking, automatic)' : ''}, ${open} open`,
      }))
    } catch {
      return { result: none('the github plugin is absent or older than 0.12.0') }
    }
    if ('why' in recorded) return { result: none(recorded.why) }
    return { result: `record: ${recorded.text}` }
  } catch (err: any) {
    return { result: none(String(err?.message ?? err).trim()) }
  }
}

export function register(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    // In the tool list from the start (isDeferred false): check.md calls it
    // at its last step, and behind tool search the model would skip it.
    try {
      await $.tool.register({
        name: 'check_done', description: CHECK_DONE_DESCRIPTION, inputSchema: CHECK_DONE_SCHEMA, isDeferred: false,
      })
    } catch {
      // Not listed: the report goes without a record line.
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('tool.call', { tool: CHECK_DONE_TOOL }, async ($: any, e: any) => checkDone($, e))
    .catch(async () => ({ result: none('the norms module failed'), isError: false }))
}
