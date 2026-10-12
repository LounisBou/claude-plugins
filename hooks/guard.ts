// hooks/guard.ts
// A mechanical floor under two rules that were prose only, where a slip cannot be
// taken back:
//
// - nothing posted in the group names a PR, a commit, a branch, a ticket, a path
//   of the machine or a host but the deployment URL (SKILL.md « Talking to a
//   reporter » rule 5, AGENT.md's never-revealed list). Read on `reply`, `edit`,
//   `post` and `done --reason`, through the shell or the `bugs` tool;
// - the bot token file is never read by a session (SKILL.md « Rules »).
//
// A denial says why, so the model rephrases. It never traps the person: what they
// typed themselves in this session releases it (a token they wrote passes, and
// naming `.env` lets the token file be reached), and it holds no state across
// calls, so an aborted turn leaves nothing behind. A guard that cannot read lets
// the call through: its `.catch` passes, and today's behaviour stands.
import {
  DYNAMIC_DENIAL, PROJECT_FILE, TOKEN_DENIAL, TOOL, bashNamesTokenFile, bugsCalls, leakDenial, leaksOf,
  parentsOf, postedWords, projectFacts, shellWords, tokenFile, typedByPerson, typedNamesTokenFile, unreleased,
  type Word,
} from './core.ts'

// The last prompt the person typed, by session: what releases a finding.
let lastTyped: { sessionId: string; text: string } | null = null

async function typed($: any): Promise<string | null> {
  try {
    return lastTyped && lastTyped.sessionId === (await $.session.id()) ? lastTyped.text : null
  } catch {
    return null
  }
}

// The deployment URL of the project the call works on: the project file of the
// session's directory or a parent. None found: no host is allowed.
async function deployUrl($: any): Promise<string | null> {
  const cwd = await $.session.cwd()
  for (const dir of parentsOf(cwd)) {
    const path = `${dir === '/' ? '' : dir}/${PROJECT_FILE}`
    try {
      if (!(await $.fs.exists(path))) continue
      return projectFacts(String(await $.fs.read(path)))?.deployUrl ?? null
    } catch {
      return null
    }
  }
  return null
}

// The verdict on what a call would post: a denial, or nothing.
async function judgePosted($: any, words: readonly Word[]): Promise<string | null> {
  if (words.length === 0) return null
  if (words.some(w => w.isDynamic)) return DYNAMIC_DENIAL
  const url = await deployUrl($)
  const leaks = unreleased(words.flatMap(w => leaksOf(w.text, url)), await typed($))
  return leaks.length > 0 ? leakDenial(leaks) : null
}

async function tokenPath($: any): Promise<{ file: string; home: string }> {
  const home = String((await $.env.get('HOME')) ?? '')
  return { file: tokenFile(await $.env.get('BUGS_BOT_ENV_FILE'), await $.env.get('BUGS_BOT_HOME'), home), home }
}

// The real path of a file, every link and `..` resolved; the spelling itself when it does not exist.
async function realPath($: any, path: string): Promise<string> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath ?? path
  } catch {
    return path
  }
}

export function register(on: any): void {
  on('prompt.submit', async ($: any, e: any, next: any) => {
    if (typedByPerson(String(e.origin?.kind ?? ''))) {
      try {
        lastTyped = { sessionId: await $.session.id(), text: String(e.text ?? '') }
      } catch { /* no session id: nothing typed is kept, and the guard stays up */ }
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  // The shell form: each bugs-bot call of the line, and the token file.
  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: any) => {
    const command = String(e.command ?? '')
    if (/bugs-bot/.test(command)) {
      const words = shellWords(command)
      if (words === null) {
        // Unbalanced quotes: the line is read whole, as one text.
        if (/bugs-bot\S*\s+(reply|edit|post|done)\b/.test(command)) {
          const denial = await judgePosted($, [{ text: command, isDynamic: false, isOperator: false }])
          if (denial) return { deny: denial }
        }
      } else {
        for (const call of bugsCalls(words)) {
          const denial = await judgePosted($, postedWords(call.command, call.args))
          if (denial) return { deny: denial }
        }
      }
    }
    const { file, home } = await tokenPath($)
    if (bashNamesTokenFile(command, file, home) && !typedNamesTokenFile(await typed($))) return { deny: TOKEN_DENIAL }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  // The tool form: its arguments are the words already.
  on('tool.call', { tool: 'mcp__bugs-bot__bugs' }, async ($: any, e: any, next: any) => {
    const args = Array.isArray(e.args) ? e.args.map((a: unknown) => ({ text: String(a), isDynamic: false, isOperator: false })) : []
    const denial = await judgePosted($, postedWords(String(e.command ?? ''), args))
    if (denial) return { deny: denial }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  // Read and Grep on the token file (Grep on the directory that holds it too).
  on('tool.call', { tool: ['Read', 'Grep'] }, async ($: any, e: any, next: any) => {
    const target = String(e.tool === 'Read' ? e.file_path ?? '' : e.path ?? '')
    if (!target) return next(e)
    const { file } = await tokenPath($)
    const real = await realPath($, target)
    const tokenReal = await realPath($, file)
    const holder = tokenReal.slice(0, tokenReal.lastIndexOf('/'))
    const reaches = real === tokenReal || (e.tool === 'Grep' && real === holder)
    if (reaches && !typedNamesTokenFile(await typed($))) return { deny: TOKEN_DENIAL }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))
}
