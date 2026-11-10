// hooks/check.ts
// N1: /norms:check's Steps 1 to 3 run here, before the command's markdown
// expands, whether the person typed it (command.run) or the model ran it
// through the Skill tool (tool.call), and land as a <norms-scope> block appended to its arguments
// ($ARGUMENTS). The base comes from scripts/resolve_base.sh, the same script
// the markdown runs, so both paths agree on it.
// N2: every norms agent spawned gets the diff of its own files and its own
// CONTRIBUTING.md sections appended to its prompt, written once here rather
// than pasted by the model into each Task call.
// Either hook that fails passes the event on unchanged: the markdown and the
// agents still carry today's instructions for doing the work themselves.
import {
  classifyAll, projectTypes, parseCheckArgs, scopeBlock, filesFor, contextBlock,
  DIFF_INLINE_MAX, type Scope, type ReferencePaths,
} from './scope.ts'
import { isSpawned } from '../core/env.ts'
import { markScope } from './record.ts'

const GIT_TIMEOUT_MS = 30_000
// Agents spawned in one message reuse the scope the command computed.
const SCOPE_TTL_MS = 10 * 60_000

async function run($: any, argv: string[]): Promise<string> {
  const r = await $.process.run(argv, { timeoutMs: GIT_TIMEOUT_MS })
  if (r.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(' ')}: ${String(r.stderr).trim() || 'exit ' + r.exitCode}`)
  return String(r.stdout)
}

const lines = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean)

// The base branch of a pull request, asked of the github plugin (its mcp__github__gh contract), or
// undefined: no pull request, no plugin, an unreadable answer. On a branch it is the current
// branch's pull request. On a detached head, which has no branch to ask about, it is the open
// pull request whose head is `detachedHead`.
export async function pullRequestBase($: any, detachedHead?: string): Promise<string | undefined> {
  try {
    const answer = await $.tool.call(
      detachedHead
        ? { tool: 'mcp__github__gh', command: 'pr-list', args: {} }
        : { tool: 'mcp__github__gh', command: 'pr-get', args: {} },
    )
    if (answer?.deny || answer?.isError) return undefined
    const pulls = JSON.parse(String(answer?.result ?? answer?.text ?? ''))
    if (!Array.isArray(pulls)) return undefined
    const pull = detachedHead ? pulls.find(p => p?.head?.sha === detachedHead) : pulls[0]
    const ref = pull?.base?.ref
    return typeof ref === 'string' && /^[\w./-]+$/.test(ref) ? ref : undefined
  } catch {
    return undefined
  }
}

// The base to resolve when the words name none. A checkout on a branch takes its pull request's;
// a detached head takes the pull request at HEAD, or is refused: the default branch would hand
// the agents every file the pull request does not change. resolve_base.sh refuses the same way
// when the module could not run and the command does the work itself.
async function defaultBase($: any): Promise<string | undefined> {
  const branch = (await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  if (branch !== 'HEAD') return pullRequestBase($)
  const head = (await run($, ['git', 'rev-parse', 'HEAD'])).trim()
  const base = await pullRequestBase($, head)
  if (!base) throw new Error(`detached HEAD (${head.slice(0, 12)}) and no open pull request has it as its head: pass the base, /norms:check base=<branch>`)
  return base
}

export async function computeScope($: any, baseArg?: string): Promise<Scope> {
  const resolver = `${$.plugin.root}/scripts/resolve_base.sh`
  const base = (await run($, ['bash', resolver, ...(baseArg ? [baseArg] : [])])).trim()
  const head = (await run($, ['git', 'rev-parse', 'HEAD'])).trim()
  const branch = (await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const files = classifyAll(lines(await run($, ['git', 'diff', '--name-only', `${base}...HEAD`])))
  const tracked = lines(await run($, ['git', 'ls-files']))
  const hasTestInfra = classifyAll(tracked).test.length > 0
  const root = ((await $.fs.list('.').catch(() => [])) as { name: string }[]).map(e => e.name)
  const hasContributing = await $.fs.exists('CONTRIBUTING.md').catch(() => false)
  return { base, baseArg, head, branch, files, types: projectTypes(root), hasContributing, hasTestInfra }
}

async function checkPaths($: any, paths: string[]): Promise<ReferencePaths> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const found: string[] = []
  const missing: string[] = []
  for (const p of paths) {
    const expanded = p.startsWith('~/') && home ? home + p.slice(1) : p
    const stat = await $.fs.stat(expanded).catch(() => null)
    if (stat && (stat.kind === 'dir' || stat.kind === 'file')) found.push(p)
    else missing.push(p)
  }
  return { found, missing }
}

// The last scope /norms:check computed, for the agents it then spawns. A
// module variable: a reload loses it, and the spawn hook computes afresh.
let cached: { scope: Scope; at: number } | undefined

async function scopeForSpawn($: any): Promise<Scope> {
  const head = (await run($, ['git', 'rev-parse', 'HEAD'])).trim()
  if (cached && cached.scope.head === head && Date.now() - cached.at < SCOPE_TTL_MS) return cached.scope
  const scope = await computeScope($, cached?.scope.baseArg)
  cached = { scope, at: Date.now() }
  return scope
}

export function resetCache(): void {
  cached = undefined
}

// The Skill tool call that runs the check. In the matcher, so the hook sits
// in no other skill's chain.
export const SKILL_MATCHER = { tool: 'Skill', skill: /^\/?norms:check$/ }

// Steps 1 to 3 for one run of /norms:check: the scope is computed, cached for
// the agents and marked for the record, and its block appended to the words.
async function withScope($: any, words: string): Promise<string> {
  const args = parseCheckArgs(words)
  // No base named: the pull request's, through the github plugin (on a detached head, the one at
  // HEAD, or a refusal); the agents reuse it from the cache.
  const scope = await computeScope($, args.base ?? (await defaultBase($)))
  cached = { scope, at: Date.now() }
  const refs = await checkPaths($, args.paths)
  const spawned: unknown = await $.env.get('ORCHESTRATOR_SPAWNED').catch(() => undefined)
  const block = scopeBlock(scope, args, refs, args.auto === true || isSpawned(typeof spawned === 'string' ? spawned : undefined))
  // Last, so the mark means the block is delivered.
  await markScope($, scope.head, Object.values(scope.files).flat())
  const typed = words.trim()
  return (typed ? typed + '\n\n' : '') + block
}

export function register(on: any): void {
  // Typed by the person: the host runs command.run.
  on('command.run', { command: 'norms:check' }, async ($: any, e: any, next: any) => {
    return next({ ...e, args: await withScope($, String(e.args ?? '')) })
  }).catch(($: any, e: any, next: any) => next(e))

  // Run by a session through the Skill tool: the host runs no command.run, so
  // the same steps run at the tool call, its args carrying the block.
  on('tool.call', SKILL_MATCHER, async ($: any, e: any, next: any) => {
    return next({ ...e, args: await withScope($, String(e.args ?? '')) })
  }).catch(($: any, e: any, next: any) => next(e))

  on('agent.spawn', async ($: any, e: any, next: any) => {
    const type = String(e.subagentType ?? '')
    if (!type.startsWith('norms:') || e.fork || String(e.prompt).includes('<norms-context>')) return next(e)
    const agent = type.slice('norms:'.length)
    const scope = await scopeForSpawn($)
    const files = filesFor(agent, scope.files)
    const contributing = scope.hasContributing ? String(await $.fs.read('CONTRIBUTING.md')) : undefined
    let diff: string | undefined
    let diffPath: string | undefined
    let diffStat: string | undefined
    if (files.length) {
      diff = await run($, ['git', 'diff', `${scope.base}...HEAD`, '--', ...files])
      if (diff.length > DIFF_INLINE_MAX) {
        const gitDir = (await run($, ['git', 'rev-parse', '--absolute-git-dir'])).trim()
        diffPath = `${gitDir}/norms/${scope.head.slice(0, 12)}-${agent}.diff`
        await $.fs.write(diffPath, diff)
        diffStat = await run($, ['git', 'diff', '--stat', `${scope.base}...HEAD`, '--', ...files])
        diff = undefined
      }
    }
    const block = contextBlock({ agent, base: scope.base, head: scope.head, files, diff, diffPath, diffStat, contributing })
    return next({ ...e, prompt: `${e.prompt}\n\n${block}` })
  }).catch(($: any, e: any, next: any) => next(e))
}
